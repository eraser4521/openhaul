import { daysBetween } from './terms';

/**
 * What a customer said they would do about an invoice.
 *
 * "The cheque goes out Friday" is the most common thing anybody says in
 * response to a reminder, and until now the only place to put it was a pause
 * with a note. A pause forgets. It does not know what was promised, when, or
 * whether it happened — so the ladder resumes a fortnight later saying
 * exactly what it said before, as though the conversation never occurred.
 *
 * A promise is a record with a date and an amount that resolves itself. The
 * state is derived from what was said and what arrived, never stored, for the
 * same reason every other total here is derived: a stored state goes stale the
 * moment a payment is corrected, and a stale one would have the carrier
 * telling a customer they broke their word when they did not.
 *
 * Accusing somebody of that wrongly is worse than any reminder, which is why
 * the grace period exists and why "partly kept" is a state of its own rather
 * than being rounded down to broken.
 */

export const PROMISE_CHANNELS = ['phone', 'email', 'portal', 'in_person', 'other'] as const;
export type PromiseChannel = (typeof PROMISE_CHANNELS)[number];

export const CHANNEL_LABEL: Record<PromiseChannel, string> = {
  phone: 'On the telephone',
  email: 'By email',
  portal: 'Through their portal',
  in_person: 'In person',
  other: 'Some other way',
};

export const PROMISE_STATES = [
  'open',
  'kept',
  'partly_kept',
  'broken',
  'superseded',
  'cancelled',
] as const;
export type PromiseState = (typeof PROMISE_STATES)[number];

export const STATE_LABEL: Record<PromiseState, string> = {
  open: 'Promised',
  kept: 'Kept',
  partly_kept: 'Partly kept',
  broken: 'Not kept',
  superseded: 'Replaced by a later promise',
  cancelled: 'Withdrawn',
};

export const STATE_TONE: Record<PromiseState, 'neutral' | 'ok' | 'warn' | 'danger' | 'info'> = {
  open: 'info',
  kept: 'ok',
  partly_kept: 'warn',
  broken: 'danger',
  superseded: 'neutral',
  cancelled: 'neutral',
};

export interface PromiseRecord {
  id: string;
  invoiceId: string;
  amountCents: number;
  /** The day they said the money would be there. */
  promisedFor: Date;
  /** When they said it. Payments before this cannot count toward it. */
  madeAt: Date;
  contactName: string | null;
  channel: PromiseChannel;
  notes: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
}

export interface PromiseOutcome {
  state: PromiseState;
  /** Money that arrived after it was made, toward what was promised. */
  receivedCents: number;
  /** Promised less received, never negative. */
  shortfallCents: number;
  /** Days past the promised date, after grace. Negative while it is still open. */
  daysLate: number;
}

/**
 * How a promise turned out.
 *
 * Only money that arrived *after* the promise was made counts toward it. A
 * payment already on the invoice when they rang was not what they were
 * promising, and counting it would mark a promise kept that nobody kept.
 *
 * Grace is not generosity, it is arithmetic. A cheque posted on the day it
 * was promised takes most of a week, and an ACH raised on a Friday lands on a
 * Tuesday. Chasing on the morning after is both petty and usually wrong.
 */
export function outcomeOf(
  promise: PromiseRecord,
  payments: ReadonlyArray<{ amountCents: number; receivedAt: Date }>,
  options: { graceDays: number; supersededBy?: PromiseRecord | null; now: Date },
): PromiseOutcome {
  const received = payments
    .filter((payment) => payment.receivedAt.getTime() >= promise.madeAt.getTime())
    .reduce((sum, payment) => sum + payment.amountCents, 0);

  const shortfall = Math.max(0, promise.amountCents - received);
  const deadline = new Date(
    promise.promisedFor.getTime() + options.graceDays * 24 * 60 * 60 * 1000,
  );
  const daysLate = daysBetween(deadline, options.now);

  const base = { receivedCents: received, shortfallCents: shortfall, daysLate };

  if (promise.cancelledAt) return { state: 'cancelled', ...base };

  /*
   * Kept wins over superseded and over the clock. Somebody who rang twice and
   * then paid has kept their word, and a promise resolved by money should
   * never read as anything else.
   */
  if (shortfall === 0) return { state: 'kept', ...base };

  if (options.supersededBy) return { state: 'superseded', ...base };

  if (daysLate <= 0) return { state: 'open', ...base };

  return { state: received > 0 ? 'partly_kept' : 'broken', ...base };
}

/** True while the promise is a reason to leave the invoice alone. */
export function holdsChasing(outcome: PromiseOutcome): boolean {
  return outcome.state === 'open' || outcome.state === 'kept';
}

/**
 * The promise that matters for an invoice today.
 *
 * The most recent one that has not been withdrawn. Everything before it is
 * superseded — somebody who rings a second time with a new date has replaced
 * what they said, not broken it, and recording it as broken would put an
 * accusation on the file that nobody made.
 */
export function currentPromise(promises: readonly PromiseRecord[]): PromiseRecord | null {
  const live = promises
    .filter((promise) => !promise.cancelledAt)
    .sort((a, b) => b.madeAt.getTime() - a.madeAt.getTime());

  return live[0] ?? null;
}

/** Which promise, if any, replaced this one. */
export function supersederOf(
  promise: PromiseRecord,
  promises: readonly PromiseRecord[],
): PromiseRecord | null {
  const later = promises
    .filter(
      (other) =>
        !other.cancelledAt &&
        other.id !== promise.id &&
        other.madeAt.getTime() > promise.madeAt.getTime(),
    )
    .sort((a, b) => a.madeAt.getTime() - b.madeAt.getTime());

  return later[0] ?? null;
}

/* -------------------------------------------------------------------------
 * Saying it in a letter
 * ---------------------------------------------------------------------- */

export interface PromiseCitation {
  madeAt: Date;
  promisedFor: Date;
  amountCents: number;
  receivedCents: number;
}

/**
 * The promise worth citing in the next notice, or nothing.
 *
 * Only one that was not kept, and only the most recent such. This is the
 * whole point of recording promises: "you told us on the 3rd that this would
 * be paid on the 10th" is a materially stronger and more truthful sentence
 * than a second reminder that repeats the first.
 *
 * It is a fact rather than a reproach, and the document prints it as one. A
 * carrier who wants to be sharper about it can write that themselves.
 */
export function citableBreach(
  promises: readonly PromiseRecord[],
  payments: ReadonlyArray<{ amountCents: number; receivedAt: Date }>,
  options: { graceDays: number; now: Date },
): PromiseCitation | null {
  const candidates = promises
    .filter((promise) => !promise.cancelledAt)
    .sort((a, b) => b.madeAt.getTime() - a.madeAt.getTime());

  for (const promise of candidates) {
    const outcome = outcomeOf(promise, payments, {
      graceDays: options.graceDays,
      supersededBy: supersederOf(promise, promises),
      now: options.now,
    });

    if (outcome.state === 'broken' || outcome.state === 'partly_kept') {
      return {
        madeAt: promise.madeAt,
        promisedFor: promise.promisedFor,
        amountCents: promise.amountCents,
        receivedCents: outcome.receivedCents,
      };
    }
  }

  return null;
}

/** What is wrong with a promise somebody is about to record. */
export function promiseProblems(
  input: { amountCents: number; promisedFor: Date; madeAt: Date },
  balanceCents: number,
): string[] {
  const problems: string[] = [];

  if (input.amountCents <= 0) problems.push('A promise needs an amount.');
  if (input.amountCents > balanceCents) {
    problems.push(
      'That is more than the invoice owes. Record what they said they would pay against this one.',
    );
  }

  // A promise for a date already gone is either a typo or a record of
  // something that has already happened, and neither belongs here.
  if (input.promisedFor.getTime() < input.madeAt.getTime() - 24 * 60 * 60 * 1000) {
    problems.push('That date has already passed.');
  }

  return problems;
}
