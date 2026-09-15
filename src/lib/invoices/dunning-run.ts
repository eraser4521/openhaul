import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import {
  claims as claimsTable,
  customers as customersTable,
  dunningNotices as noticesTable,
  dunningRuns as runsTable,
  dunningSettings as settingsTable,
  dunningStages as stagesTable,
  invoices as invoicesTable,
  loads as loadsTable,
  payments as paymentsTable,
  refunds as refundsTable,
  type Customer,
  type Invoice,
  type RunTrigger,
} from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { appendAudit, AUDIT } from '../audit/chain';
import { mailConfigured } from '../email/transport';
import { compose } from '../email/compose';
import { sendDocument } from '../documents/send';
import { storeDocument } from '../documents/store';
import { renderDunningNotice } from '../documents/dunning-notice';
import { brandFor } from '../branding/template';
import { getOrganization } from '../organization/profile';
import { balanceCents, sumRefunds } from './compute';
import { balancesByCustomer } from './customer-credit';
import {
  DEFAULT_LADDER,
  DEFAULT_RULE,
  decideChase,
  normalizeLadder,
  type ChaseDecision,
  type DunningRule,
  type LadderStage,
} from './dunning';

/**
 * Climbing the ladder, once a day.
 *
 * The same shape as the statement sweep — an occurrence date unique per
 * organisation is the lock, one customer's failure does not stop the others,
 * nothing is retried inside a run — with one difference that matters: at most
 * one rung per invoice per run.
 *
 * That last rule is what stops a sweep that has not happened for a month
 * finding an invoice fifty days overdue and sending the reminder, the second
 * reminder and the final notice in the same minute. A customer whose first
 * contact about a debt is a final notice has been ambushed, however late they
 * are, and no amount of "but the thresholds were met" makes that a defensible
 * letter.
 */

export interface NoticeResult {
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  outcome: 'sent' | 'failed' | 'held';
  stageLabel?: string;
  detail: string | null;
  balanceCents: number;
  daysPastDue: number;
}

export interface DunningRunResult {
  ok: boolean;
  reason?: string;
  runId?: string;
  dueOn?: Date;
  considered?: number;
  sent?: number;
  failed?: number;
  held?: number;
  notices?: NoticeResult[];
}

/* -------------------------------------------------------------------------
 * The rule and the ladder
 * ---------------------------------------------------------------------- */

export async function ruleFor(scoped: ScopedDb): Promise<DunningRule> {
  const [row] = await scoped.select('dunningSettings');
  if (!row) return { ...DEFAULT_RULE };

  return {
    enabled: row.enabled,
    minimumBalanceCents: row.minimumBalanceCents,
    minimumGapDays: row.minimumGapDays,
    pauseAfterPaymentDays: row.pauseAfterPaymentDays,
  };
}

/** The carrier's ladder, or the defaults until they save one. */
export async function ladderFor(scoped: ScopedDb): Promise<LadderStage[]> {
  const rows = await scoped.select('dunningStages');
  if (rows.length === 0) return DEFAULT_LADDER.map((stage) => ({ ...stage }));

  return normalizeLadder(
    rows.map((row) => ({
      sequence: row.sequence,
      label: row.label,
      daysPastDue: row.daysPastDue,
      message: row.message,
      enabled: row.enabled,
    })),
  );
}

export async function saveDunning(
  scoped: ScopedDb,
  rule: DunningRule,
  ladder: readonly LadderStage[],
): Promise<void> {
  const [existing] = await scoped.select('dunningSettings');
  if (existing) {
    await scoped.update('dunningSettings', eq(settingsTable.id, existing.id), rule);
  } else {
    await scoped.insert('dunningSettings', rule);
  }

  /*
   * Rewritten rather than merged. The ladder is an ordered list and a stage
   * removed from the middle has to actually go — leaving a stale row behind
   * would keep sending a rung the carrier had deleted.
   */
  for (const row of await scoped.select('dunningStages')) {
    await scoped.remove('dunningStages', eq(stagesTable.id, row.id));
  }
  for (const stage of normalizeLadder(ladder)) {
    await scoped.insert('dunningStages', stage);
  }

  await appendAudit({
    orgId: scoped.orgId,
    action: AUDIT.dunningSettingsChanged,
    subject: `org:${scoped.orgId}`,
    detail: { ...rule, stages: ladder.length },
  });
}

/* -------------------------------------------------------------------------
 * Working out who is due a notice
 * ---------------------------------------------------------------------- */

export interface Chaseable {
  invoice: Invoice;
  customer: Customer | null;
  decision: ChaseDecision;
}

/**
 * Every issued invoice with the decision about it.
 *
 * Returns the ones being left alone as well. "That invoice is ninety days
 * late, why has nobody chased it" is the question asked of a collections
 * process, and a list that shows only what was sent cannot answer it.
 */
export async function chaseable(
  scoped: ScopedDb,
  rule: DunningRule,
  ladder: readonly LadderStage[],
  now = new Date(),
): Promise<Chaseable[]> {
  const invoices = (await scoped.select('invoices')).filter(
    (invoice) => invoice.status !== 'draft' && invoice.status !== 'void',
  );
  if (invoices.length === 0) return [];

  const ids = invoices.map((invoice) => invoice.id);

  const [customers, refunds, payments, notices, credit] = await Promise.all([
    scoped.select('customers'),
    scoped.select('refunds', inArray(refundsTable.invoiceId, ids)),
    scoped.select('payments', inArray(paymentsTable.invoiceId, ids)),
    scoped.select('dunningNotices', inArray(noticesTable.invoiceId, ids)),
    balancesByCustomer(scoped),
  ]);

  const customerById = new Map(customers.map((customer) => [customer.id, customer]));

  const refundedBy = new Map<string, number>();
  for (const refund of refunds) {
    refundedBy.set(refund.invoiceId, (refundedBy.get(refund.invoiceId) ?? 0) + refund.amountCents);
  }

  const lastPaymentBy = new Map<string, Date>();
  for (const payment of payments) {
    const current = lastPaymentBy.get(payment.invoiceId);
    if (!current || payment.receivedAt > current) {
      lastPaymentBy.set(payment.invoiceId, payment.receivedAt);
    }
  }

  // Only a notice that actually went counts as a rung climbed.
  const lastStageBy = new Map<string, number>();
  const lastNoticeBy = new Map<string, Date>();
  for (const notice of notices) {
    if (notice.outcome !== 'sent') continue;
    lastStageBy.set(
      notice.invoiceId,
      Math.max(lastStageBy.get(notice.invoiceId) ?? 0, notice.stageSequence),
    );
    const current = lastNoticeBy.get(notice.invoiceId);
    if (!current || notice.sentAt > current) lastNoticeBy.set(notice.invoiceId, notice.sentAt);
  }

  /*
   * Open claims and legal holds are read per load rather than per invoice,
   * because both hang off the load and most invoices have neither.
   */
  const loadIds = invoices
    .map((invoice) => invoice.loadId)
    .filter((id): id is string => Boolean(id));

  const [claims, loads] =
    loadIds.length > 0
      ? await Promise.all([
          scoped.select('claims', inArray(claimsTable.loadId, loadIds)),
          scoped.select('loads', inArray(loadsTable.id, loadIds)),
        ])
      : [[], []];

  const OPEN_CLAIM_STATUSES = ['filed', 'acknowledged', 'investigating', 'offered'];
  const disputedLoads = new Set(
    claims
      .filter((claim) => claim.loadId && OPEN_CLAIM_STATUSES.includes(claim.status))
      .map((claim) => claim.loadId as string),
  );
  const heldLoads = new Set(loads.filter((load) => load.legalHold).map((load) => load.id));

  return invoices
    .map((invoice) => {
      const customer = invoice.customerId
        ? (customerById.get(invoice.customerId) ?? null)
        : null;

      const decision = decideChase(
        {
          invoice: {
            ...invoice,
            refundedCents: refundedBy.get(invoice.id) ?? 0,
            dunningPausedUntil: invoice.dunningPausedUntil,
          },
          customerCreditCents: invoice.customerId
            ? (credit.get(invoice.customerId) ?? 0)
            : 0,
          customerDunningEnabled: customer?.dunningEnabled ?? false,
          customerHasEmail: Boolean(customer?.email),
          hasOpenClaim: Boolean(invoice.loadId && disputedLoads.has(invoice.loadId)),
          loadOnLegalHold: Boolean(invoice.loadId && heldLoads.has(invoice.loadId)),
          lastPaymentAt: lastPaymentBy.get(invoice.id) ?? null,
          lastNoticeAt: lastNoticeBy.get(invoice.id) ?? null,
          lastStageSent: lastStageBy.get(invoice.id) ?? 0,
        },
        rule,
        ladder,
        now,
      );

      return { invoice, customer, decision };
    })
    .sort((a, b) => b.decision.daysPastDue - a.decision.daysPastDue);
}

/* -------------------------------------------------------------------------
 * Sending one
 * ---------------------------------------------------------------------- */

export interface NoticeOutcome {
  ok: boolean;
  error?: string;
  noticeId?: string;
  documentId?: string;
}

/**
 * Produces and sends one rung, and records it either way.
 *
 * Exported because the invoice screen offers the same thing by hand — a
 * dispatcher who has just spoken to somebody wants to send the next reminder
 * now, and it should be the same letter the sweep would have sent.
 */
export async function sendNotice(
  scoped: ScopedDb,
  invoiceId: string,
  stage: LadderStage,
  options: { runId?: string | null; now?: Date } = {},
): Promise<NoticeOutcome> {
  const now = options.now ?? new Date();

  const invoice = await scoped.selectOne('invoices', eq(invoicesTable.id, invoiceId));
  if (!invoice) return { ok: false, error: 'No such invoice.' };

  const [org, customer, load, ladder] = await Promise.all([
    getOrganization(scoped.orgId),
    invoice.customerId
      ? scoped.selectOne('customers', eq(customersTable.id, invoice.customerId))
      : Promise.resolve(null),
    invoice.loadId
      ? scoped.selectOne('loads', eq(loadsTable.id, invoice.loadId))
      : Promise.resolve(null),
    ladderFor(scoped),
  ]);

  if (!org) return { ok: false, error: 'The organisation record is missing.' };
  if (!customer?.email) return { ok: false, error: 'No email address on file.' };

  const refunded = sumRefunds(
    await scoped.select('refunds', eq(refundsTable.invoiceId, invoiceId)),
  );
  const position = { ...invoice, refundedCents: refunded };
  const balance = balanceCents(position);
  const daysPastDue = invoice.dueAt
    ? Math.floor((now.getTime() - invoice.dueAt.getTime()) / 86_400_000)
    : 0;

  const credit = invoice.customerId
    ? ((await balancesByCustomer(scoped)).get(invoice.customerId) ?? 0)
    : 0;

  const record = async (
    outcome: 'sent' | 'failed',
    detail: string | null,
    documentId: string | null,
  ) => {
    const [row] = await scoped.insert('dunningNotices', {
      invoiceId,
      runId: options.runId ?? null,
      stageSequence: stage.sequence,
      stageLabel: stage.label,
      outcome,
      detail,
      sentAt: now,
      documentId,
      balanceCents: balance,
      daysPastDue,
    });
    return row;
  };

  try {
    const bytes = await renderDunningNotice({
      stageLabel: stage.label,
      stageSequence: stage.sequence,
      stageCount: ladder.filter((row) => row.enabled).length,
      issuedAt: now,
      brand: await brandFor(scoped, 'dunning_notice'),

      carrier: {
        name: org.legalName,
        addressLine1: org.addressLine1,
        city: org.city,
        state: org.state,
        postalCode: org.postalCode,
        phone: org.phone,
        email: org.email,
      },
      billTo: {
        name: customer.name,
        contactName: customer.contactName,
        addressLine1: customer.addressLine1,
        city: customer.city,
        state: customer.state,
        postalCode: customer.postalCode,
        email: customer.email,
      },

      message: stage.message,
      invoiceNumber: invoice.number,
      invoiceIssuedAt: invoice.issuedAt,
      dueAt: invoice.dueAt,
      daysPastDue,
      loadNumber: load?.number ?? null,

      totalCents: invoice.totalCents,
      paidCents: invoice.paidCents,
      creditedCents: invoice.creditedCents + invoice.appliedCreditCents,
      balanceCents: balance,
      currency: invoice.currency,
      creditOnAccountCents: credit,
    });

    const stored = await storeDocument({
      scoped,
      kind: 'dunning_notice',
      loadId: invoice.loadId,
      subject: `invoice:${invoiceId}`,
      title: `${stage.label} — invoice ${invoice.number}`,
      bytes,
    });

    if ('error' in stored) {
      await record('failed', stored.error, null);
      return { ok: false, error: stored.error };
    }

    const message = compose('dunning_notice', {
      carrierName: org.legalName,
      reference: invoice.number,
      recipientName: customer.contactName ?? customer.name,
      loadNumber: load?.number ?? null,
      balanceCents: balance,
      daysPastDue,
      stageLabel: stage.label,
    });

    const sent = await sendDocument(scoped, {
      documentId: stored.documentId,
      to: [customer.email],
      subject: message.subject,
      body: message.body,
    });

    if (!sent.ok) {
      await record('failed', sent.error ?? 'The send failed.', stored.documentId);
      return { ok: false, error: sent.error, documentId: stored.documentId };
    }

    const row = await record('sent', null, stored.documentId);

    await appendAudit({
      orgId: scoped.orgId,
      action: AUDIT.dunningNoticeSent,
      subject: `invoice:${invoiceId}`,
      detail: {
        noticeId: row?.id,
        stage: stage.sequence,
        stageLabel: stage.label,
        balanceCents: balance,
        daysPastDue,
        documentId: stored.documentId,
      },
    });

    return { ok: true, noticeId: row?.id, documentId: stored.documentId };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Something went wrong.';
    await record('failed', detail, null);
    return { ok: false, error: detail };
  }
}

/* -------------------------------------------------------------------------
 * The sweep
 * ---------------------------------------------------------------------- */

export interface DunningRunOptions {
  trigger: RunTrigger;
  now?: Date;
}

function midnightUtc(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
}

export async function runDunning(
  scoped: ScopedDb,
  options: DunningRunOptions,
): Promise<DunningRunResult> {
  const now = options.now ?? new Date();
  const rule = await ruleFor(scoped);

  if (!rule.enabled) {
    return { ok: false, reason: 'Overdue invoices are not chased automatically.' };
  }

  if (!mailConfigured()) {
    return {
      ok: false,
      reason: 'No mail server is configured, so nothing can be sent. No notices were produced.',
    };
  }

  const dueOn = midnightUtc(now);
  const [already] = await scoped.select('dunningRuns', eq(runsTable.dueOn, dueOn));
  if (already) {
    return {
      ok: false,
      reason: `Overdue invoices have already been swept today.`,
      runId: already.id,
      dueOn,
    };
  }

  let run;
  try {
    [run] = await scoped.insert('dunningRuns', {
      dueOn,
      trigger: options.trigger,
      startedAt: now,
    });
  } catch {
    return { ok: false, reason: 'Another sweep started first.', dueOn };
  }

  if (!run) return { ok: false, reason: 'The sweep could not be started.', dueOn };

  const ladder = await ladderFor(scoped);
  const rows = await chaseable(scoped, rule, ladder, now);

  const notices: NoticeResult[] = [];

  for (const row of rows) {
    const base = {
      invoiceId: row.invoice.id,
      invoiceNumber: row.invoice.number,
      customerName: row.customer?.name ?? 'No customer',
      balanceCents: row.decision.balanceCents,
      daysPastDue: row.decision.daysPastDue,
    };

    if (!row.decision.chase) {
      // Only an invoice that is actually late is worth reporting as held
      // back; everything current would drown the list.
      if (row.decision.daysPastDue > 0 && row.decision.balanceCents > 0) {
        notices.push({ ...base, outcome: 'held', detail: row.decision.reason });
      }
      continue;
    }

    const result = await sendNotice(scoped, row.invoice.id, row.decision.stage, {
      runId: run.id,
      now,
    });

    notices.push({
      ...base,
      outcome: result.ok ? 'sent' : 'failed',
      stageLabel: row.decision.stage.label,
      detail: result.ok ? null : (result.error ?? 'The send failed.'),
    });
  }

  const sent = notices.filter((notice) => notice.outcome === 'sent').length;
  const failed = notices.filter((notice) => notice.outcome === 'failed').length;
  const held = notices.filter((notice) => notice.outcome === 'held').length;

  await scoped.update('dunningRuns', eq(runsTable.id, run.id), {
    finishedAt: new Date(),
    consideredCount: rows.length,
    sentCount: sent,
    failedCount: failed,
    heldCount: held,
  });

  await appendAudit({
    orgId: scoped.orgId,
    action: AUDIT.dunningRunFinished,
    subject: `org:${scoped.orgId}`,
    detail: {
      runId: run.id,
      dueOn: dueOn.toISOString(),
      trigger: options.trigger,
      considered: rows.length,
      sent,
      failed,
      held,
    },
  });

  return {
    ok: true,
    runId: run.id,
    dueOn,
    considered: rows.length,
    sent,
    failed,
    held,
    notices,
  };
}

/* -------------------------------------------------------------------------
 * Stopping one by hand
 * ---------------------------------------------------------------------- */

/**
 * Leaves an invoice alone until a date.
 *
 * A reason is required. "Why did nobody chase this for a month" needs an
 * answer that is not "somebody clicked something", and the person who knows
 * is the one pausing it.
 */
export async function pauseDunning(
  scoped: ScopedDb,
  invoiceId: string,
  until: Date | null,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  const invoice = await scoped.selectOne('invoices', eq(invoicesTable.id, invoiceId));
  if (!invoice) return { ok: false, error: 'No such invoice.' };

  if (until && !reason.trim()) {
    return { ok: false, error: 'Say why it is being left alone — it stays on the record.' };
  }

  await scoped.update('invoices', eq(invoicesTable.id, invoiceId), {
    dunningPausedUntil: until,
    dunningPauseReason: until ? reason.trim() : null,
  });

  await appendAudit({
    orgId: scoped.orgId,
    action: AUDIT.dunningPaused,
    subject: `invoice:${invoiceId}`,
    detail: { until: until?.toISOString() ?? null, reason: until ? reason.trim() : null },
  });

  return { ok: true };
}

/* -------------------------------------------------------------------------
 * Reading it back
 * ---------------------------------------------------------------------- */

export async function noticesFor(scoped: ScopedDb, invoiceId: string) {
  const rows = await scoped.select('dunningNotices', eq(noticesTable.invoiceId, invoiceId));
  return rows.slice().sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
}

export async function recentDunningRuns(scoped: ScopedDb, limit = 5) {
  const rows = await scoped.select('dunningRuns');
  return rows
    .slice()
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
    .slice(0, limit);
}

/** The notices that did not go, so somebody can act on them. */
export async function failedNotices(scoped: ScopedDb, runId: string) {
  const rows = await scoped.select(
    'dunningNotices',
    and(eq(noticesTable.runId, runId), eq(noticesTable.outcome, 'failed')),
  );

  const numbers = new Map(
    (await scoped.select('invoices')).map((invoice) => [invoice.id, invoice.number]),
  );

  return rows.map((row) => ({ ...row, invoiceNumber: numbers.get(row.invoiceId) ?? '—' }));
}
