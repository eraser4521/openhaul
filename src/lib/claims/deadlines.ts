/**
 * The clocks a cargo claim runs on.
 *
 * Three separate regimes, which is why they are computed rather than typed
 * into a diary:
 *
 * - 49 CFR 370.5 — the carrier acknowledges receipt in writing within 30 days.
 * - 49 CFR 370.9 — the carrier pays, declines, or makes a firm compromise
 *   settlement offer in writing within 120 days. If the claim is still open at
 *   that point, the claimant must be told the status and the reason for the
 *   delay, and again at the end of every 60-day period after.
 * - 49 U.S.C. 14706 (Carmack) — a bill of lading may not allow less than nine
 *   months to file a claim, nor less than two years to sue after a claim is
 *   declined in writing. Those are the windows OpenHaul's bill of lading
 *   states, so those are the ones enforced here.
 *
 * Missing the 30-day acknowledgement is the most common failure at a small
 * carrier, and it is the cheapest to avoid: it costs one letter.
 */

export const ACKNOWLEDGE_DAYS = 30;
export const DISPOSITION_DAYS = 120;
export const STATUS_LETTER_INTERVAL_DAYS = 60;
export const CLAIM_FILING_MONTHS = 9;
export const SUIT_YEARS = 2;

function addDays(from: Date, days: number): Date {
  const result = new Date(from.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/**
 * Adds calendar months, clamped to the end of the target month.
 *
 * Naive month arithmetic rolls over: 31 May plus nine months lands on 31
 * February, which JavaScript silently turns into 3 March. A deadline that
 * quietly moves two days later than the month it belongs in is the kind of
 * error nobody notices until it is argued about.
 */
export function addMonths(from: Date, months: number): Date {
  const day = from.getUTCDate();
  const result = new Date(from.getTime());

  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);

  const lastDayOfMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();

  result.setUTCDate(Math.min(day, lastDayOfMonth));
  return result;
}

export interface ClaimClock {
  /** 49 CFR 370.5 — written acknowledgement. */
  acknowledgeDueAt: Date;
  /** 49 CFR 370.9 — pay, decline, or offer. */
  resolveDueAt: Date;
}

/** The two fixed deadlines that start when the claim is received. */
export function claimClock(filedAt: Date): ClaimClock {
  return {
    acknowledgeDueAt: addDays(filedAt, ACKNOWLEDGE_DAYS),
    resolveDueAt: addDays(filedAt, DISPOSITION_DAYS),
  };
}

/**
 * When the next written status update is owed.
 *
 * The schedule is day 120, then every 60 days: 180, 240, 300. A letter sent
 * late does not reset the schedule — it satisfies every deadline it has
 * passed, and the next one owed is the next scheduled date after it.
 *
 * Returns null once the claim has been disposed of, because the obligation
 * only runs "while the claim remains pending".
 */
export function nextStatusLetterDue(
  filedAt: Date,
  lastSentAt: Date | null,
  options: { disposed?: boolean; horizon?: number } = {},
): Date | null {
  if (options.disposed) return null;

  const after = lastSentAt ?? filedAt;
  const horizon = options.horizon ?? 40; // ~6.5 years of 60-day periods

  for (let period = 0; period < horizon; period += 1) {
    const due = addDays(filedAt, DISPOSITION_DAYS + period * STATUS_LETTER_INTERVAL_DAYS);
    if (due.getTime() > after.getTime()) return due;
  }

  return null;
}

/* -------------------------------------------------------------------------
 * Carmack windows
 * ---------------------------------------------------------------------- */

/**
 * The last day a claim can be filed, counted from delivery.
 *
 * Nine months is the floor Carmack allows a carrier to impose, and the floor
 * is what OpenHaul's bill of lading states — so for these shipments it is also
 * the ceiling.
 */
export function claimFilingDeadline(deliveredAt: Date): Date {
  return addMonths(deliveredAt, CLAIM_FILING_MONTHS);
}

/** The last day suit can be brought, counted from a written declination. */
export function suitDeadline(declinedAt: Date): Date {
  return addMonths(declinedAt, SUIT_YEARS * 12);
}

/**
 * Whether a claim arrived after the window closed.
 *
 * Reported, never acted on automatically. A late claim is a defence the
 * carrier may raise, not a reason for software to throw the paperwork away —
 * delivery dates get corrected, and a carrier can choose to consider a claim
 * it could have refused.
 */
export function isLateFiled(filedAt: Date, deliveredAt: Date | null): boolean {
  if (!deliveredAt) return false;
  return filedAt.getTime() > claimFilingDeadline(deliveredAt).getTime();
}

/* -------------------------------------------------------------------------
 * Pressure
 * ---------------------------------------------------------------------- */

export const DEADLINE_STATES = ['met', 'overdue', 'due_soon', 'pending', 'not_applicable'] as const;
export type DeadlineState = (typeof DEADLINE_STATES)[number];

export interface Deadline {
  label: string;
  citation: string;
  dueAt: Date | null;
  metAt: Date | null;
  state: DeadlineState;
  /** Negative once the date has passed. */
  daysRemaining: number | null;
}

function wholeDaysBetween(from: Date, to: Date): number {
  const startOfDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((startOfDay(to) - startOfDay(from)) / 86_400_000);
}

export function deadlineState(
  dueAt: Date | null,
  metAt: Date | null,
  now: Date,
  soonDays = 7,
): DeadlineState {
  if (metAt) return 'met';
  if (!dueAt) return 'not_applicable';

  const remaining = wholeDaysBetween(now, dueAt);
  if (remaining < 0) return 'overdue';
  if (remaining <= soonDays) return 'due_soon';
  return 'pending';
}

export function describeDeadline(
  label: string,
  citation: string,
  dueAt: Date | null,
  metAt: Date | null,
  now: Date,
): Deadline {
  return {
    label,
    citation,
    dueAt,
    metAt,
    state: deadlineState(dueAt, metAt, now),
    daysRemaining: dueAt && !metAt ? wholeDaysBetween(now, dueAt) : null,
  };
}

export interface ClaimDeadlineInput {
  filedAt: Date;
  acknowledgedAt: Date | null;
  resolveDueAt: Date;
  acknowledgeDueAt: Date;
  lastStatusLetterAt: Date | null;
  disposedAt: Date | null;
  declinedAt: Date | null;
}

/** Every deadline on a claim, in the order they fall due. */
export function claimDeadlines(claim: ClaimDeadlineInput, now: Date): Deadline[] {
  const disposed = claim.disposedAt !== null;

  const deadlines: Deadline[] = [
    describeDeadline(
      'Written acknowledgement',
      '49 CFR 370.5',
      claim.acknowledgeDueAt,
      claim.acknowledgedAt,
      now,
    ),
    describeDeadline(
      'Pay, decline or offer',
      '49 CFR 370.9',
      claim.resolveDueAt,
      claim.disposedAt,
      now,
    ),
  ];

  /*
   * The 60-day letter is a contingent duty: it arises only "if the claim
   * cannot be processed and disposed of within 120 days". Before that date the
   * carrier's obligation is to dispose of the claim, and listing a status
   * letter falling due the same day as the disposition just prints the same
   * deadline twice under two names. So it appears once the disposition
   * deadline has actually passed, or once a letter has already gone out and
   * there is a real next one to track.
   */
  const statusDutyLive =
    now.getTime() >= claim.resolveDueAt.getTime() || claim.lastStatusLetterAt !== null;

  if (statusDutyLive) {
    const statusDue = nextStatusLetterDue(claim.filedAt, claim.lastStatusLetterAt, { disposed });
    if (statusDue) {
      deadlines.push(
        describeDeadline('Next status letter', '49 CFR 370.9', statusDue, null, now),
      );
    }
  }

  if (claim.declinedAt) {
    // Not the carrier's deadline — the claimant's. Shown because it is the
    // date the file can finally be closed with confidence.
    deadlines.push(
      describeDeadline(
        'Claimant’s deadline to sue',
        '49 U.S.C. 14706',
        suitDeadline(claim.declinedAt),
        null,
        now,
      ),
    );
  }

  return deadlines;
}

/** The worst state across a claim's deadlines, for a list row. */
export function worstState(deadlines: readonly Deadline[]): DeadlineState {
  const order: DeadlineState[] = ['overdue', 'due_soon', 'pending', 'met', 'not_applicable'];
  for (const state of order) {
    if (deadlines.some((deadline) => deadline.state === state)) return state;
  }
  return 'not_applicable';
}
