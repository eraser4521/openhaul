import 'server-only';
import { eq } from 'drizzle-orm';
import {
  cashBalances as balancesTable,
  recurringOutgoings as outgoingsTable,
  type OutgoingCadence,
  type OutgoingCategory,
} from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { appendAudit, AUDIT } from '../audit/chain';
import { movedAfter, type Movements, type Reading } from './balance';
import { annualCents, occurrencesBetween, outgoingProblems, type Outgoing } from './recurring';

/**
 * Reading and writing the two things a carrier has to tell this application.
 *
 * Everything else in the cash screens is derived from records the app already
 * holds. These two are not derivable from anything, so they are typed in — and
 * both are written with the same care as a payment, because a projection is
 * only ever as good as the figures nobody could check.
 */

export interface BalanceView extends Reading {
  id: string;
  note: string | null;
  recordedByUserId: string | null;
  recordedAt: Date;
}

export interface SaveResult {
  ok: boolean;
  error?: string;
  problems?: string[];
  id?: string;
}

/* -------------------------------------------------------------------------
 * The balance
 * ---------------------------------------------------------------------- */

/**
 * The most recent reading.
 *
 * Ordered by the day it was true rather than the day it was typed, so somebody
 * catching up on Monday by entering Thursday's and then Friday's balance ends
 * up with Friday's — which is what they meant, and the opposite of what
 * insertion order would have given them.
 */
export async function latestBalance(scoped: ScopedDb): Promise<BalanceView | null> {
  const rows = await scoped.select('cashBalances', undefined, {
    orderBy: { column: balancesTable.asOf, direction: 'desc' },
    limit: 1,
  });

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    amountCents: row.amountCents,
    asOf: row.asOf,
    note: row.note,
    recordedByUserId: row.recordedByUserId,
    recordedAt: row.createdAt,
  };
}

/** Every reading, newest first, so a figure that looks wrong can be traced. */
export async function balanceHistory(scoped: ScopedDb, limit = 12): Promise<BalanceView[]> {
  const rows = await scoped.select('cashBalances', undefined, {
    orderBy: { column: balancesTable.asOf, direction: 'desc' },
    limit,
  });

  return rows.map((row) => ({
    id: row.id,
    amountCents: row.amountCents,
    asOf: row.asOf,
    note: row.note,
    recordedByUserId: row.recordedByUserId,
    recordedAt: row.createdAt,
  }));
}

/**
 * Records what somebody read off their bank.
 *
 * A future date is refused rather than accepted and ignored. A balance "as at"
 * next Tuesday is either a typo or a guess, and a guess entered here would
 * become the foundation of every figure on the timeline without ever looking
 * like one.
 */
export async function recordBalance(
  scoped: ScopedDb,
  input: { amountCents: number; asOf: Date; note: string | null; userId: string | null },
  now = new Date(),
): Promise<SaveResult> {
  if (Number.isNaN(input.asOf.getTime())) {
    return { ok: false, error: 'That is not a date.' };
  }

  if (input.asOf.getTime() > now.getTime()) {
    return {
      ok: false,
      error: 'A balance has to be one you have already seen. Pick today or a day before it.',
    };
  }

  const [row] = await scoped.insert('cashBalances', {
    amountCents: input.amountCents,
    asOf: input.asOf,
    note: input.note,
    recordedByUserId: input.userId,
  });

  if (!row) return { ok: false, error: 'That could not be saved.' };

  await appendAudit({
    orgId: scoped.orgId,
    actorId: input.userId,
    action: AUDIT.cashBalanceRecorded,
    subject: `organization:${scoped.orgId}`,
    detail: { amountCents: input.amountCents, asOf: input.asOf.toISOString() },
  });

  return { ok: true, id: row.id };
}

/* -------------------------------------------------------------------------
 * What has moved since a reading was taken
 * ---------------------------------------------------------------------- */

/**
 * The recorded cash events between a reading and now.
 *
 * Three of the four are things that actually happened and are on file: money
 * banked, settlements paid, refunds sent. The fourth is the standing costs
 * that fell due in the gap, which are expected rather than confirmed — a
 * direct debit is not proof it cleared. The screen labels them apart for that
 * reason.
 *
 * Driver expenses are deliberately absent. They leave the carrier's account
 * through a settlement, and that settlement is already counted here; adding
 * the expense as well would take the same money out twice.
 */
export async function movementsSince(
  scoped: ScopedDb,
  reading: Reading,
  now = new Date(),
): Promise<Movements> {
  const [payments, refunds, settlements, outgoings] = await Promise.all([
    scoped.select('payments'),
    scoped.select('refunds'),
    scoped.select('settlements'),
    outgoingsFor(scoped),
  ]);

  /*
   * The gap runs from the day after the reading to the end of today, matching
   * `movedAfter`: a balance is read at the end of a day, so that day's own
   * movements are already inside it.
   */
  const DAY = 24 * 60 * 60 * 1000;
  const gapStart = new Date(reading.asOf.getTime() + DAY);
  const gapEnd = new Date(now.getTime() + DAY);

  return {
    receivedCents: payments
      .filter((row) => movedAfter(reading, row.receivedAt, now))
      .reduce((total, row) => total + row.amountCents, 0),

    settlementsPaidCents: settlements
      .filter((row) => row.paidAt !== null && movedAfter(reading, row.paidAt, now))
      .reduce((total, row) => total + row.netPayCents, 0),

    refundsPaidCents: refunds
      .filter((row) => movedAfter(reading, row.issuedAt, now))
      .reduce((total, row) => total + row.amountCents, 0),

    recurringCents: outgoings.reduce(
      (total, outgoing) =>
        total + occurrencesBetween(outgoing, gapStart, gapEnd).length * outgoing.amountCents,
      0,
    ),
  };
}

/* -------------------------------------------------------------------------
 * Standing costs
 * ---------------------------------------------------------------------- */

export interface OutgoingView extends Outgoing {
  note: string | null;
}

/**
 * Every standing cost, dearest first by what it costs in a year.
 *
 * By the year rather than by the payment, which is not the same order and is
 * the one that tells the truth: rent at $450 a week costs more than a $1,850
 * truck note, and sorting on the payment would bury it four rows down. The
 * sort happens here rather than in the query because the annual figure is
 * derived from the cadence and SQL has no idea what a fortnight is.
 */
export async function outgoingsFor(scoped: ScopedDb): Promise<OutgoingView[]> {
  const rows = await scoped.select('recurringOutgoings', undefined, {
    orderBy: { column: outgoingsTable.name, direction: 'asc' },
  });

  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      amountCents: row.amountCents,
      cadence: row.cadence,
      anchorOn: row.anchorOn,
      endsOn: row.endsOn,
      note: row.note,
    }))
    .sort((a, b) => annualCents(b) - annualCents(a));
}

export interface OutgoingInput {
  name: string;
  category: OutgoingCategory;
  amountCents: number;
  cadence: OutgoingCadence;
  anchorOn: Date | null;
  endsOn: Date | null;
  note: string | null;
}

/**
 * Creates or replaces a standing cost.
 *
 * Refused rather than corrected when it does not make sense, in keeping with
 * the rest of this application: a commitment of zero or one whose last payment
 * precedes its first is somebody mistyping, and quietly fixing it would put a
 * figure on the timeline that nobody entered.
 */
export async function saveOutgoing(
  scoped: ScopedDb,
  id: string | null,
  input: OutgoingInput,
  actorId: string | null,
): Promise<SaveResult> {
  const problems = outgoingProblems(input);
  if (problems.length > 0) return { ok: false, problems };
  if (!input.anchorOn) return { ok: false, problems: ['Say when the first payment is, or was.'] };

  const values = {
    name: input.name.trim(),
    category: input.category,
    amountCents: input.amountCents,
    cadence: input.cadence,
    anchorOn: input.anchorOn,
    endsOn: input.endsOn,
    note: input.note,
  };

  if (id) {
    const existing = await scoped.selectOne('recurringOutgoings', eq(outgoingsTable.id, id));
    if (!existing) return { ok: false, error: 'That standing cost is no longer there.' };

    await scoped.update('recurringOutgoings', eq(outgoingsTable.id, id), values);
  } else {
    const [row] = await scoped.insert('recurringOutgoings', values);
    if (!row) return { ok: false, error: 'That could not be saved.' };
    id = row.id;
  }

  await appendAudit({
    orgId: scoped.orgId,
    actorId,
    action: AUDIT.outgoingSaved,
    subject: `organization:${scoped.orgId}`,
    detail: {
      outgoingId: id,
      name: values.name,
      amountCents: values.amountCents,
      cadence: values.cadence,
    },
  });

  return { ok: true, id };
}

/**
 * Removes one outright.
 *
 * A hard delete, unlike almost everything else here. Nothing references a
 * standing cost and nothing was ever claimed from anybody on the strength of
 * one — it is an input to a forecast, not a record of a transaction — so
 * keeping a retired row would only clutter the list somebody has to read. The
 * audit entry keeps what it said.
 */
export async function removeOutgoing(
  scoped: ScopedDb,
  id: string,
  actorId: string | null,
): Promise<SaveResult> {
  const existing = await scoped.selectOne('recurringOutgoings', eq(outgoingsTable.id, id));
  if (!existing) return { ok: false, error: 'That standing cost is no longer there.' };

  await scoped.remove('recurringOutgoings', eq(outgoingsTable.id, id));

  await appendAudit({
    orgId: scoped.orgId,
    actorId,
    action: AUDIT.outgoingRemoved,
    subject: `organization:${scoped.orgId}`,
    detail: {
      outgoingId: id,
      name: existing.name,
      amountCents: existing.amountCents,
      cadence: existing.cadence,
    },
  });

  return { ok: true, id };
}
