import 'server-only';
import { and, eq } from 'drizzle-orm';
import {
  customers as customersTable,
  statementRunItems as itemsTable,
  statementRuns as runsTable,
  statementSchedules as schedulesTable,
  type Customer,
  type RunTrigger,
} from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { appendAudit, AUDIT } from '../audit/chain';
import { mailConfigured } from '../email/transport';
import { draftFor, sendDocument } from '../documents/send';
import { buildStatement, statementView } from './statement-document';
import {
  DEFAULT_SCHEDULE,
  decide,
  occurrenceOn,
  type ScheduleRule,
  type SendDecision,
} from './statement-schedule';

/**
 * Running the schedule.
 *
 * Three things this has to get right, and they are the three that make batch
 * sending either trustworthy or a liability.
 *
 * It must not send twice. The occurrence date is unique per organisation, so
 * whoever writes the run row owns it; a cron line that fires twice, a retry
 * after a timeout and somebody pressing the button by hand all converge on
 * one run. The check-then-insert is belt and braces — SQLite serialises
 * writers, so the unique index is what actually decides it.
 *
 * One customer's failure must not stop the other forty-nine. Every customer
 * is produced and sent inside its own try, and what went wrong is written
 * against that customer rather than thrown. A run that half-finished because
 * the third address bounced would be worse than no schedule at all.
 *
 * And nothing is retried inside a run. An SMTP outage during a fifty-customer
 * sweep would otherwise become fifty failures times however many attempts,
 * against a server that is already refusing. The failures are recorded, the
 * documents still exist, and a person decides — which is what the send screen
 * is for.
 */

export interface RunItemResult {
  customerId: string;
  customerName: string;
  outcome: 'sent' | 'failed' | 'skipped';
  detail: string | null;
  statementId?: string;
  balanceCents: number;
  heldCents: number;
}

export interface RunResult {
  ok: boolean;
  /** Why nothing ran. Set when the schedule is off, not due, or already done. */
  reason?: string;
  runId?: string;
  dueOn?: Date;
  considered?: number;
  sent?: number;
  failed?: number;
  skipped?: number;
  items?: RunItemResult[];
}

/* -------------------------------------------------------------------------
 * The rule
 * ---------------------------------------------------------------------- */

/** The organisation's schedule, or the defaults when none has been saved. */
export async function scheduleFor(scoped: ScopedDb): Promise<ScheduleRule> {
  const [row] = await scoped.select('statementSchedules');
  if (!row) return { ...DEFAULT_SCHEDULE };

  return {
    cadence: row.cadence,
    dayOfMonth: row.dayOfMonth,
    dayOfWeek: row.dayOfWeek,
    windowDays: row.windowDays,
    minimumBalanceCents: row.minimumBalanceCents,
    includeCreditHolders: row.includeCreditHolders,
  };
}

export async function saveSchedule(scoped: ScopedDb, rule: ScheduleRule): Promise<void> {
  const [existing] = await scoped.select('statementSchedules');

  if (existing) {
    await scoped.update('statementSchedules', eq(schedulesTable.id, existing.id), rule);
  } else {
    await scoped.insert('statementSchedules', rule);
  }

  await appendAudit({
    orgId: scoped.orgId,
    action: AUDIT.statementScheduleChanged,
    subject: `org:${scoped.orgId}`,
    detail: { ...rule },
  });
}

/* -------------------------------------------------------------------------
 * Who would get one
 * ---------------------------------------------------------------------- */

export interface Candidate {
  customer: Customer;
  decision: SendDecision;
  balanceCents: number;
  heldCents: number;
}

/**
 * Every customer with their position and the decision about them.
 *
 * Returns the ones that would not be sent to as well, because "why did
 * Cardinal not get one" is the question asked about a batch job, and a
 * preview that only lists the recipients cannot answer it.
 */
export async function candidates(
  scoped: ScopedDb,
  rule: ScheduleRule,
  now = new Date(),
): Promise<Candidate[]> {
  const customers = await scoped.select('customers');
  const rows: Candidate[] = [];

  for (const customer of customers) {
    const view = await statementView(scoped, customer.id, {
      windowDays: rule.windowDays,
      now,
    });

    const balanceCents = view.totals.closingDueCents;
    const heldCents = view.totals.closingHeldCents;

    rows.push({
      customer,
      balanceCents,
      heldCents,
      decision: decide(
        { balanceCents, heldCents, enabled: customer.statementsEnabled },
        rule,
      ),
    });
  }

  return rows.sort((a, b) => b.balanceCents - a.balanceCents);
}

/* -------------------------------------------------------------------------
 * The run
 * ---------------------------------------------------------------------- */

export interface RunOptions {
  trigger: RunTrigger;
  now?: Date;
  /**
   * Run against today rather than the scheduled occurrence.
   *
   * For the button in settings. Still idempotent: today is an occurrence date
   * like any other, so pressing it twice in one day does nothing the second
   * time, and pressing it on a scheduled day takes that occurrence.
   */
  force?: boolean;
}

function midnightUtc(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
}

export async function runStatements(
  scoped: ScopedDb,
  options: RunOptions,
): Promise<RunResult> {
  const now = options.now ?? new Date();
  const rule = await scheduleFor(scoped);

  const dueOn = options.force ? midnightUtc(now) : occurrenceOn(rule, now);
  if (!dueOn) {
    return { ok: false, reason: 'Statements are not sent on a schedule.' };
  }

  /*
   * Refused rather than half-done. Producing fifty statements that cannot be
   * sent leaves fifty documents nobody asked for and a carrier who believes
   * their customers have been told.
   */
  if (!mailConfigured()) {
    return {
      ok: false,
      reason: 'No mail server is configured, so nothing can be sent. Statements were not produced.',
    };
  }

  const [already] = await scoped.select('statementRuns', eq(runsTable.dueOn, dueOn));
  if (already) {
    return {
      ok: false,
      reason: `The run for ${dueOn.toISOString().slice(0, 10)} has already been done.`,
      runId: already.id,
      dueOn,
    };
  }

  let run;
  try {
    [run] = await scoped.insert('statementRuns', {
      dueOn,
      trigger: options.trigger,
      startedAt: now,
    });
  } catch {
    // Lost the race to another trigger. The unique index on (org, due_on) is
    // what makes that safe rather than a double send.
    return { ok: false, reason: 'Another run for this occurrence started first.', dueOn };
  }

  if (!run) return { ok: false, reason: 'The run could not be started.', dueOn };

  const eligible = (await candidates(scoped, rule, now)).filter((row) => row.decision.send);
  const considered = (await scoped.select('customers')).length;

  const items: RunItemResult[] = [];

  for (const candidate of eligible) {
    const item = await sendOne(scoped, run.id, candidate, rule, now);
    items.push(item);
  }

  const sent = items.filter((item) => item.outcome === 'sent').length;
  const failed = items.filter((item) => item.outcome === 'failed').length;
  const skipped = items.filter((item) => item.outcome === 'skipped').length;

  await scoped.update('statementRuns', eq(runsTable.id, run.id), {
    finishedAt: new Date(),
    consideredCount: considered,
    sentCount: sent,
    failedCount: failed,
    skippedCount: skipped,
  });

  await appendAudit({
    orgId: scoped.orgId,
    action: AUDIT.statementRunFinished,
    subject: `org:${scoped.orgId}`,
    detail: {
      runId: run.id,
      dueOn: dueOn.toISOString(),
      trigger: options.trigger,
      considered,
      sent,
      failed,
      skipped,
    },
  });

  return { ok: true, runId: run.id, dueOn, considered, sent, failed, skipped, items };
}

/**
 * One customer, start to finish, and never throwing.
 *
 * Anything that goes wrong becomes a row against that customer with the
 * reason on it. The alternative — letting it propagate — stops the sweep at
 * whichever customer happens to be broken, and the carrier finds out when the
 * other forty-nine do not arrive.
 */
async function sendOne(
  scoped: ScopedDb,
  runId: string,
  candidate: Candidate,
  rule: ScheduleRule,
  now: Date,
): Promise<RunItemResult> {
  const base = {
    customerId: candidate.customer.id,
    customerName: candidate.customer.name,
    balanceCents: candidate.balanceCents,
    heldCents: candidate.heldCents,
  };

  const record = async (
    outcome: 'sent' | 'failed' | 'skipped',
    detail: string | null,
    statementId?: string,
  ): Promise<RunItemResult> => {
    await scoped.insert('statementRunItems', {
      runId,
      customerId: candidate.customer.id,
      statementId: statementId ?? null,
      outcome,
      detail,
      balanceCents: candidate.balanceCents,
      heldCents: candidate.heldCents,
    });
    return { ...base, outcome, detail, statementId };
  };

  if (!candidate.customer.email) {
    return record('skipped', 'No email address on file.');
  }

  try {
    const built = await buildStatement(scoped, candidate.customer.id, {
      windowDays: rule.windowDays,
      now,
    });

    if (!built.ok || !built.documentId) {
      return record('skipped', built.error ?? 'The statement could not be produced.');
    }

    const draft = await draftFor(scoped, built.documentId);
    if (!draft || draft.to.length === 0) {
      return record('failed', 'Produced, but there was nobody to send it to.', built.statementId);
    }

    const result = await sendDocument(scoped, {
      documentId: built.documentId,
      to: draft.to,
      subject: draft.subject,
      body: draft.body,
    });

    if (!result.ok) {
      return record('failed', result.error ?? 'The send failed.', built.statementId);
    }

    return record('sent', null, built.statementId);
  } catch (error) {
    return record('failed', error instanceof Error ? error.message : 'Something went wrong.');
  }
}

/* -------------------------------------------------------------------------
 * Reading the history
 * ---------------------------------------------------------------------- */

export async function recentRuns(scoped: ScopedDb, limit = 6) {
  const rows = await scoped.select('statementRuns');
  return rows
    .slice()
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
    .slice(0, limit);
}

/** The rows a person has to act on: anything that did not go. */
export async function unresolvedItems(scoped: ScopedDb, runId: string) {
  return scoped.select(
    'statementRunItems',
    and(eq(itemsTable.runId, runId), eq(itemsTable.outcome, 'failed')),
  );
}

export async function itemsFor(scoped: ScopedDb, runId: string) {
  const rows = await scoped.select('statementRunItems', eq(itemsTable.runId, runId));
  const names = new Map(
    (await scoped.select('customers')).map((customer) => [customer.id, customer.name]),
  );

  // Failures first: a list somebody scans for what went wrong should not bury
  // it under forty successes.
  const rank = { failed: 0, skipped: 1, sent: 2 } as const;
  return rows
    .slice()
    .sort((a, b) => rank[a.outcome] - rank[b.outcome])
    .map((row) => ({ ...row, customerName: names.get(row.customerId) ?? 'Unknown customer' }));
}

/** Named export kept narrow so the customers screen can flip one flag. */
export async function setStatementsEnabled(
  scoped: ScopedDb,
  customerId: string,
  enabled: boolean,
): Promise<void> {
  await scoped.update('customers', eq(customersTable.id, customerId), {
    statementsEnabled: enabled,
  });
}
