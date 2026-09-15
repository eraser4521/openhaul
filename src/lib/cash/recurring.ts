import type { OutgoingCadence, OutgoingCategory } from '../db/schema';

/**
 * The money that leaves whether or not a wheel turns.
 *
 * A truck note, an insurance premium, yard rent, the quarterly fuel tax. None
 * of it is recorded anywhere else in this application and all of it comes out
 * of the same account the driver settlements do, so a cash projection built
 * without it is a projection of the pleasant half.
 *
 * Occurrences are computed, never stored. The alternative — writing a row per
 * future payment — goes wrong the first time an amount changes, because the
 * rows already generated keep the old figure and nobody remembers that a
 * schedule has a tail of stale copies behind it.
 *
 * Every cadence counts from one anchor date, which is the first payment. That
 * removes the separate "which day of the month" and "which weekday" settings a
 * schedule usually carries, and with them the class of bug where the anchor
 * and the day disagree and one of them silently wins.
 */

export const CADENCE_LABEL: Record<OutgoingCadence, string> = {
  weekly: 'Weekly',
  every_two_weeks: 'Every two weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annually: 'Annually',
};

export const CATEGORY_LABEL: Record<OutgoingCategory, string> = {
  loan: 'Loan or note',
  lease: 'Lease',
  insurance: 'Insurance',
  permit: 'Permits and filings',
  payroll: 'Payroll',
  premises: 'Yard or premises',
  software: 'Software',
  tax: 'Tax',
  other: 'Other',
};

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
}

/**
 * The same day in a later month, or that month's last day if it is shorter.
 *
 * A note anchored on the 31st comes out on the 28th in February, because that
 * is what the lender's bank does. `statement-schedule.ts` solves the same
 * problem by refusing any day above the 28th, and is right to: a statement run
 * is the carrier's own choice and can be moved to a safe day. A truck payment
 * is somebody else's date and has to be recorded as it stands, so this one
 * clamps instead of refusing.
 */
function monthsOn(anchor: Date, months: number): Date {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + months;
  const lastOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  return new Date(Date.UTC(year, month, Math.min(anchor.getUTCDate(), lastOfMonth), 0, 0, 0, 0));
}

export interface Outgoing {
  id: string;
  name: string;
  category: OutgoingCategory;
  amountCents: number;
  cadence: OutgoingCadence;
  anchorOn: Date;
  endsOn: Date | null;
}

/**
 * Whole months between two dates, rounded down.
 *
 * Used to jump straight to the right month rather than stepping one at a time,
 * which matters for an annual commitment anchored years back.
 */
function monthsBetween(from: Date, to: Date): number {
  return (
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth())
  );
}

const MONTH_STEP: Partial<Record<OutgoingCadence, number>> = {
  monthly: 1,
  quarterly: 3,
  annually: 12,
};

const DAY_STEP: Partial<Record<OutgoingCadence, number>> = {
  weekly: 7,
  every_two_weeks: 14,
};

/**
 * Every payment falling in `[from, to)`.
 *
 * Half-open so consecutive windows tile without a day belonging to both — the
 * same convention the timeline windows use, and the reason a payment on a
 * boundary is not counted twice.
 *
 * Nothing before the anchor and nothing after the end date, so a loan with a
 * final instalment stops on it rather than running forever. A commitment whose
 * first payment is still in the future is handled by the same rule and needs
 * no special case.
 */
export function occurrencesBetween(outgoing: Outgoing, from: Date, to: Date): Date[] {
  const anchor = startOfDay(outgoing.anchorOn);
  const start = startOfDay(from);
  const end = startOfDay(to);
  const last = outgoing.endsOn ? startOfDay(outgoing.endsOn) : null;

  if (end.getTime() <= start.getTime()) return [];
  if (last && last.getTime() < start.getTime()) return [];

  const dates: Date[] = [];
  const stopAt = last && last.getTime() < end.getTime() ? last.getTime() + 1 : end.getTime();

  const days = DAY_STEP[outgoing.cadence];
  if (days !== undefined) {
    const step = days * DAY_MS;
    /*
     * Jump to the first occurrence at or after the window rather than walking
     * from the anchor, so a weekly commitment set up three years ago does not
     * cost a hundred and fifty iterations every time the page is opened.
     */
    const behind = start.getTime() - anchor.getTime();
    const skip = behind > 0 ? Math.ceil(behind / step) : 0;

    for (let at = anchor.getTime() + skip * step; at < stopAt; at += step) {
      if (at >= start.getTime()) dates.push(new Date(at));
    }

    return dates;
  }

  const months = MONTH_STEP[outgoing.cadence] ?? 1;
  const behind = monthsBetween(anchor, start);
  /*
   * One step back before stepping forward. The month arithmetic can land
   * before the window when the anchor day is later in the month than the
   * start day, and starting one early costs a single discarded iteration.
   */
  let index = Math.max(0, Math.floor(behind / months) - 1) * months;

  for (;;) {
    const at = monthsOn(anchor, index);
    if (at.getTime() >= stopAt) break;
    if (at.getTime() >= start.getTime()) dates.push(at);
    index += months;
  }

  return dates;
}

/** The next payment at or after `now`, for saying when a commitment next bites. */
export function nextOccurrence(outgoing: Outgoing, now: Date, withinDays = 400): Date | null {
  const from = startOfDay(now);
  const to = new Date(from.getTime() + withinDays * DAY_MS);

  return occurrencesBetween(outgoing, from, to)[0] ?? null;
}

/**
 * What one commitment costs in a year.
 *
 * For comparing a weekly charge against an annual premium, which is the only
 * way to see which of a list of commitments is actually the expensive one.
 * Approximate for the two day-based cadences by construction — a year holds
 * 52.18 weeks — so it is stated as "about" wherever it is shown.
 */
export function annualCents(outgoing: Pick<Outgoing, 'cadence' | 'amountCents'>): number {
  switch (outgoing.cadence) {
    case 'weekly':
      return outgoing.amountCents * 52;
    case 'every_two_weeks':
      return outgoing.amountCents * 26;
    case 'monthly':
      return outgoing.amountCents * 12;
    case 'quarterly':
      return outgoing.amountCents * 4;
    case 'annually':
      return outgoing.amountCents;
  }
}

/** True once the final payment is behind us, for listing it separately. */
export function hasEnded(outgoing: Pick<Outgoing, 'endsOn'>, now: Date): boolean {
  return outgoing.endsOn !== null && startOfDay(outgoing.endsOn).getTime() < startOfDay(now).getTime();
}

/**
 * Everything wrong with a commitment somebody has typed, in plain words.
 *
 * Returned as a list rather than thrown one at a time, because a form that
 * reveals its objections one per submission is a form people abandon.
 */
export function outgoingProblems(input: {
  name: string;
  amountCents: number;
  anchorOn: Date | null;
  endsOn: Date | null;
}): string[] {
  const problems: string[] = [];

  if (!input.name.trim()) {
    problems.push('Give it a name you would recognise on a bank statement.');
  }

  if (input.amountCents <= 0) {
    problems.push('An amount of nothing is not a commitment. Enter what actually leaves.');
  }

  if (!input.anchorOn) {
    problems.push('Say when the first payment is, or was.');
  }

  if (input.anchorOn && input.endsOn && input.endsOn.getTime() < input.anchorOn.getTime()) {
    problems.push('The last payment cannot come before the first one.');
  }

  return problems;
}

/** "Monthly from Sep 1, until Mar 1 2029" — the rule as one readable line. */
export function describeOutgoing(outgoing: Outgoing): string {
  const date = (value: Date) =>
    value.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });

  const ends = outgoing.endsOn ? `, last one ${date(outgoing.endsOn)}` : '';
  return `${CADENCE_LABEL[outgoing.cadence]} from ${date(outgoing.anchorOn)}${ends}`;
}
