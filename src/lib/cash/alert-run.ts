import 'server-only';
import { eq } from 'drizzle-orm';
import { cashAlerts as alertsTable, cashAlertSettings as settingsTable } from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { appendAudit, AUDIT } from '../audit/chain';
import { getOrganization } from '../organization/profile';
import { looksLikeEmail, parseAddresses } from '../email/compose';
import { mailConfigured, send } from '../email/transport';
import { cashflowReport } from './cashflow-report';
import { STANDING_DIRECTION } from './cashflow';
import {
  composeAlert,
  decideAlert,
  type AlertDecision,
  type AlertRule,
  type Previous,
} from './alert';

/**
 * Deciding, sending and remembering a cash warning.
 *
 * Every judgement about whether a message is worth sending lives in
 * `alert.ts`, which knows nothing about mail or databases. This file fetches
 * what that decision needs, acts on it, and writes down what was said — the
 * last part being what makes the next decision possible, since a channel with
 * no memory repeats itself until nobody opens it.
 */

export interface AlertSettings extends AlertRule {
  /** What was typed, before falling back to the organisation's own address. */
  typed: string | null;
  /** True when the recipients came from the organisation record. */
  fallback: boolean;
}

export const DEFAULT_ALERT: AlertRule = {
  enabled: false,
  recipients: [],
  minimumGapDays: 2,
};

/**
 * The rule, with recipients resolved.
 *
 * Falling back to the organisation's own address rather than refusing to send:
 * a carrier who switched this on and did not fill in a second field meant
 * "tell me", and the address they registered with is the best answer available.
 */
export async function alertSettings(scoped: ScopedDb): Promise<AlertSettings> {
  const [rows, org] = await Promise.all([
    scoped.select('cashAlertSettings'),
    getOrganization(scoped.orgId),
  ]);

  const row = rows[0];

  const typed = row?.recipients?.trim() || null;
  const listed = typed ? parseAddresses(typed).filter(looksLikeEmail) : [];
  const fallback = listed.length === 0;

  const resolved =
    listed.length > 0
      ? listed
      : org?.email && looksLikeEmail(org.email)
        ? [org.email]
        : [];

  return {
    enabled: row?.enabled ?? DEFAULT_ALERT.enabled,
    minimumGapDays: row?.minimumGapDays ?? DEFAULT_ALERT.minimumGapDays,
    recipients: resolved,
    typed,
    fallback,
  };
}

export interface SaveAlertInput {
  enabled: boolean;
  recipients: string | null;
  minimumGapDays: number;
}

export async function saveAlertSettings(
  scoped: ScopedDb,
  input: SaveAlertInput,
  actorId: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const bad = input.recipients
    ? parseAddresses(input.recipients).filter((address) => !looksLikeEmail(address))
    : [];

  if (bad.length > 0) {
    return { ok: false, error: `That does not look like an address: ${bad[0]}` };
  }

  const gap = Math.min(Math.max(0, Math.trunc(input.minimumGapDays)), 30);

  const [existing] = await scoped.select('cashAlertSettings');
  const values = { enabled: input.enabled, recipients: input.recipients, minimumGapDays: gap };

  if (existing) {
    await scoped.update('cashAlertSettings', eq(settingsTable.id, existing.id), values);
  } else {
    await scoped.insert('cashAlertSettings', values);
  }

  await appendAudit({
    orgId: scoped.orgId,
    actorId,
    action: AUDIT.cashAlertSettingsChanged,
    subject: `organization:${scoped.orgId}`,
    detail: { enabled: input.enabled, minimumGapDays: gap },
  });

  return { ok: true };
}

/* -------------------------------------------------------------------------
 * Remembering
 * ---------------------------------------------------------------------- */

/**
 * The last thing actually delivered.
 *
 * Failures are excluded on purpose. A message the mail server refused was
 * never read by anybody, so treating it as "already said" would let one
 * evening of SMTP trouble silence the channel for the whole of the week it
 * most needed to speak.
 */
export async function lastAlert(scoped: ScopedDb): Promise<Previous | null> {
  const rows = await scoped.select('cashAlerts', eq(alertsTable.outcome, 'sent'), {
    orderBy: { column: alertsTable.sentAt, direction: 'desc' },
    limit: 1,
  });

  const row = rows[0];
  if (!row) return null;

  return {
    kind: row.kind,
    reason: row.reason,
    sentAt: row.sentAt,
    windowFrom: row.windowFrom,
    shortfallCents: row.shortfallCents,
  };
}

export async function recentAlerts(scoped: ScopedDb, limit = 8) {
  return scoped.select('cashAlerts', undefined, {
    orderBy: { column: alertsTable.sentAt, direction: 'desc' },
    limit,
  });
}

/* -------------------------------------------------------------------------
 * The sweep
 * ---------------------------------------------------------------------- */

export interface AlertRun {
  decision: AlertDecision;
  sent: boolean;
  error?: string;
  subject?: string;
  recipients?: string[];
}

/**
 * One organisation, one sweep.
 *
 * Safe to call as often as a scheduler likes. Nothing here is keyed to a date
 * the way the statement run is — the guard is the decision itself, which
 * declines to repeat news that has not changed, so a cron line that fires
 * hourly sends no more than one that fires daily.
 *
 * `dryRun` works out what would be said without saying it, which is what the
 * settings screen shows. Being the same code path is the point: a preview
 * computed a second way is a preview that will eventually disagree with the
 * thing it is previewing.
 */
export async function runCashAlerts(
  scoped: ScopedDb,
  options: { now?: Date; dryRun?: boolean } = {},
): Promise<AlertRun> {
  const now = options.now ?? new Date();

  const [rule, previous, report] = await Promise.all([
    alertSettings(scoped),
    lastAlert(scoped),
    cashflowReport(scoped, { now, withBalance: true }),
  ]);

  const decision = decideAlert(
    rule,
    {
      projection: report.projection,
      balance: report.balance
        ? {
            amountCents: report.balance.reading.amountCents,
            asOf: report.balance.reading.asOf,
            days: report.balance.age.days,
            state: report.balance.age.state,
          }
        : null,
    },
    previous,
    now,
  );

  if (!decision.send || options.dryRun) return { decision, sent: false };

  const org = await getOrganization(scoped.orgId);

  /*
   * Overdue money is pulled from the same grouping the page shows rather than
   * recomputed, so the lever the message points at is the figure somebody sees
   * when they follow the link.
   */
  const overdueInCents = report.standing
    .filter((group) => STANDING_DIRECTION[group.reason] === 'in')
    .reduce((total, group) => total + group.amountCents, 0);

  const balance = report.balance!;

  const message = composeAlert({
    kind: decision.kind,
    carrierName: org?.legalName ?? 'your carrier',
    shortfall: decision.kind === 'shortfall' ? decision.shortfall : null,
    balance: {
      amountCents: balance.reading.amountCents,
      asOf: balance.reading.asOf,
      days: balance.age.days,
      state: balance.age.state,
    },
    positionCents: balance.positionCents,
    horizonWeeks: report.horizonWeeks,
    totals: report.timeline.totals,
    overdueInCents,
    url: timelineUrl(),
  });

  const shortfall = decision.kind === 'shortfall' ? decision.shortfall : null;

  const record = async (outcome: 'sent' | 'failed', detail: string | null) => {
    await scoped.insert('cashAlerts', {
      kind: decision.kind,
      reason: decision.reason,
      outcome,
      detail,
      sentAt: now,
      recipients: rule.recipients.join(', '),
      windowFrom: shortfall?.from ?? null,
      windowIndex: shortfall?.index ?? null,
      shortfallCents: shortfall?.cents ?? null,
      positionCents: balance.positionCents,
      balanceAsOf: balance.reading.asOf,
      balanceDays: balance.age.days,
    });
  };

  if (!mailConfigured()) {
    const error = 'No mail server is configured.';
    await record('failed', error);
    return { decision, sent: false, error };
  }

  const outcome = await send({
    to: rule.recipients,
    subject: message.subject,
    text: message.text,
  });

  if (!outcome.ok) {
    await record('failed', outcome.error);
    return { decision, sent: false, error: outcome.error };
  }

  await record('sent', null);

  await appendAudit({
    orgId: scoped.orgId,
    action: AUDIT.cashAlertSent,
    subject: `organization:${scoped.orgId}`,
    detail: {
      kind: decision.kind,
      reason: decision.reason,
      recipients: rule.recipients.length,
      shortfallCents: shortfall?.cents ?? null,
    },
  });

  return {
    decision,
    sent: true,
    subject: message.subject,
    recipients: rule.recipients,
  };
}

/**
 * Where to send somebody who wants the detail.
 *
 * Omitted rather than guessed when `NEXT_PUBLIC_APP_URL` is unset. A message
 * carrying a link to localhost is worse than one carrying no link at all.
 */
function timelineUrl(): string | null {
  const base = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!base || base.startsWith('http://localhost')) return null;

  return `${base.replace(/\/+$/, '')}/money/timeline`;
}
