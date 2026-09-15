import type { PromiseOutcome, PromiseRecord, PromiseState } from './promise';

/**
 * Every promise across every customer, arranged for somebody working a phone.
 *
 * The invoice screen answers "what did this customer say about this invoice".
 * A bookkeeper needs the other direction: what fell due yesterday and did not
 * arrive, what is landing today, what to expect this week. The records
 * already exist — this is the arrangement of them, which is the part that
 * turns a ladder into a process somebody actually works.
 *
 * The buckets are deliberately about what to *do*, not about what state a row
 * is in. `in_the_post` is the one that earns its place: a promise whose day
 * has passed but whose grace has not is the single case where the right
 * action is to do nothing, and a list that lumped it in with the broken ones
 * would have somebody ringing a customer whose cheque is on the way.
 */

export const WORK_BUCKETS = ['not_kept', 'in_the_post', 'expected', 'kept'] as const;
export type WorkBucket = (typeof WORK_BUCKETS)[number];

export const BUCKET_LABEL: Record<WorkBucket, string> = {
  not_kept: 'Did not arrive',
  in_the_post: 'Due, still within grace',
  expected: 'Expected',
  kept: 'Arrived',
};

export const BUCKET_NOTE: Record<WorkBucket, string> = {
  not_kept: 'The day has passed and the grace with it. These are the calls to make.',
  in_the_post:
    'The day they named has come but the grace has not run out. A cheque posted on the day ' +
    'takes most of a week — leave these alone.',
  expected: 'Still to come. Worth a quiet word the day before on the large ones.',
  kept: 'Settled by money arriving. Nothing to do.',
};

export const BUCKET_TONE: Record<WorkBucket, 'danger' | 'warn' | 'info' | 'ok'> = {
  not_kept: 'danger',
  in_the_post: 'warn',
  expected: 'info',
  kept: 'ok',
};

/** How long a kept promise stays on the list before it stops being news. */
export const SETTLED_WINDOW_DAYS = 14;

function startOfDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Which pile this promise belongs in, or nothing when it belongs in none.
 *
 * Superseded and withdrawn promises are left off entirely. Neither is
 * something to act on, and putting them in front of somebody working a list
 * invites the call that should not be made — a customer who rang back with a
 * new date does not want to be chased about the old one.
 */
export function bucketOf(
  promise: PromiseRecord,
  outcome: PromiseOutcome,
  now: Date,
  settledWindowDays = SETTLED_WINDOW_DAYS,
): WorkBucket | null {
  switch (outcome.state) {
    case 'broken':
    case 'partly_kept':
      return 'not_kept';

    case 'kept': {
      const age = (startOfDay(now) - startOfDay(promise.promisedFor)) / 86_400_000;
      return age <= settledWindowDays ? 'kept' : null;
    }

    case 'open':
      // Compared by calendar day rather than by the clock: a promise for
      // today is due today whether it is nine in the morning or five at night.
      return startOfDay(promise.promisedFor) <= startOfDay(now) ? 'in_the_post' : 'expected';

    default:
      return null;
  }
}

/**
 * Within a bucket, whatever wants attention first.
 *
 * Oldest first for everything there is something to do about: the promise
 * broken longest ago is the one that has been ignored longest, and the next
 * one expected is the next to think about. Only the arrived pile runs the
 * other way, because that is a list somebody reads for reassurance and the
 * useful end of it is the most recent.
 */
export function compareWithin(
  bucket: WorkBucket,
  a: { promisedFor: Date },
  b: { promisedFor: Date },
): number {
  const ascending = a.promisedFor.getTime() - b.promisedFor.getTime();
  return bucket === 'kept' ? -ascending : ascending;
}

/* -------------------------------------------------------------------------
 * Whether somebody's word has been good
 * ---------------------------------------------------------------------- */

export interface PromiseTally {
  kept: number;
  partlyKept: number;
  notKept: number;
  /** Resolved promises: the base the others are out of. */
  resolved: number;
  /** Consecutive kept promises, counting back from the most recent. */
  streak: number;
}

const RESOLVED: PromiseState[] = ['kept', 'partly_kept', 'broken'];

/**
 * A customer's record with promises, as counts rather than a score.
 *
 * Deliberately not a percentage and not a grade. Three kept out of four is a
 * fact; "75%" is the same fact dressed as a measurement, and a star rating on
 * a base of two promises is noise that would still change how somebody is
 * spoken to on the telephone. The reader can judge four numbers.
 *
 * Withdrawn promises are left out entirely. Ringing to say the payment cannot
 * be made after all is the honest thing to do, and counting it against
 * somebody would be scoring them down for candour.
 */
export function tally(
  promises: ReadonlyArray<{ state: PromiseState; promisedFor: Date }>,
): PromiseTally {
  const resolved = promises
    .filter((promise) => RESOLVED.includes(promise.state))
    .slice()
    .sort((a, b) => b.promisedFor.getTime() - a.promisedFor.getTime());

  let streak = 0;
  for (const promise of resolved) {
    if (promise.state !== 'kept') break;
    streak += 1;
  }

  return {
    kept: resolved.filter((promise) => promise.state === 'kept').length,
    partlyKept: resolved.filter((promise) => promise.state === 'partly_kept').length,
    notKept: resolved.filter((promise) => promise.state === 'broken').length,
    resolved: resolved.length,
    streak,
  };
}

/** The tally as a sentence, or nothing when there is not enough to say. */
export function describeTally(count: PromiseTally): string | null {
  if (count.resolved === 0) return null;

  const base = `Kept ${count.kept} of ${count.resolved}`;
  if (count.streak >= 3) return `${base} — last ${count.streak} in a row`;
  if (count.resolved >= 2 && count.kept === 0) return `${base} — none yet`;
  return base;
}

/* -------------------------------------------------------------------------
 * Totals
 * ---------------------------------------------------------------------- */

export interface BucketTotals {
  count: number;
  promisedCents: number;
  /** Promised less what has arrived toward it. Zero for anything kept. */
  outstandingCents: number;
}

export function totalsFor(
  entries: ReadonlyArray<{ amountCents: number; outcome: PromiseOutcome }>,
): BucketTotals {
  return {
    count: entries.length,
    promisedCents: entries.reduce((sum, entry) => sum + entry.amountCents, 0),
    outstandingCents: entries.reduce((sum, entry) => sum + entry.outcome.shortfallCents, 0),
  };
}
