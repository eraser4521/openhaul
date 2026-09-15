import type { StatementCadence } from '../db/schema';

/**
 * When statements go out, and to whom.
 *
 * Pure, because the two things worth being sure of here are both arithmetic:
 * which day an occurrence falls on, and whether a given customer has anything
 * worth sending. Everything that touches the database or a mail server is in
 * `statement-run.ts`.
 *
 * The scheduling model is deliberately small. There is no daemon in this
 * application — a one-person carrier runs it with `npm start` and nothing
 * else — so the schedule is a rule, not a timer. Something outside pokes the
 * app, the app works out which occurrence that poke belongs to, and the
 * occurrence runs at most once. A cron line firing twice, a retry after a
 * timeout and somebody pressing the button all land on the same run.
 */

export interface ScheduleRule {
  cadence: StatementCadence;
  /** 1-28. Above 28 a month would be skipped entirely; validation caps it. */
  dayOfMonth: number;
  /** 0 is Sunday, matching `Date.getUTCDay`. */
  dayOfWeek: number;
  windowDays: number;
  minimumBalanceCents: number;
  includeCreditHolders: boolean;
}

export const DEFAULT_SCHEDULE: ScheduleRule = {
  cadence: 'off',
  dayOfMonth: 1,
  dayOfWeek: 1,
  windowDays: 90,
  minimumBalanceCents: 0,
  includeCreditHolders: true,
};

/** The highest day of the month a schedule may use. */
export const MAX_DAY_OF_MONTH = 28;

export const WEEKDAY_LABEL = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

function midnightUtc(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
}

/**
 * The most recent occurrence at or before `now`, or null when the schedule is off.
 *
 * Looks backwards rather than forwards on purpose. Nothing in this system
 * knows what time it is until something calls in, so the only question worth
 * answering is "which scheduled day does this moment belong to" — and the
 * answer has to be stable for the whole of that day, or a poke at 00:05 and
 * another at 23:55 would be two different runs.
 */
export function occurrenceOn(rule: ScheduleRule, now: Date): Date | null {
  if (rule.cadence === 'off') return null;

  if (rule.cadence === 'monthly') {
    const day = Math.min(Math.max(1, Math.trunc(rule.dayOfMonth)), MAX_DAY_OF_MONTH);
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();

    return now.getUTCDate() >= day
      ? midnightUtc(year, month, day)
      : midnightUtc(year, month - 1, day);
  }

  const want = ((Math.trunc(rule.dayOfWeek) % 7) + 7) % 7;
  const back = (now.getUTCDay() - want + 7) % 7;
  return midnightUtc(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back);
}

/** The occurrence after the one `now` falls in, for telling somebody when it next goes. */
export function nextOccurrenceAfter(rule: ScheduleRule, now: Date): Date | null {
  const current = occurrenceOn(rule, now);
  if (!current) return null;

  if (rule.cadence === 'monthly') {
    return midnightUtc(current.getUTCFullYear(), current.getUTCMonth() + 1, current.getUTCDate());
  }
  return midnightUtc(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate() + 7,
  );
}

export interface AccountPosition {
  /** Outstanding across the customer's open invoices. */
  balanceCents: number;
  /** What the carrier is holding for them. */
  heldCents: number;
  /** False when somebody has turned statements off for this customer. */
  enabled: boolean;
}

export type SendDecision =
  | { send: true; reason: 'owes' | 'holds_credit' }
  | { send: false; reason: 'disabled' | 'nothing_to_say' | 'under_minimum' };

/**
 * Whether this customer gets one.
 *
 * The rule is "send when there is something to say". A monthly statement to
 * somebody who owes nothing and holds nothing is a mailshot, and the fastest
 * way to teach an accounts department to filter the sender is to send them
 * one every month saying zero.
 *
 * A credit holder counts as something to say even at a zero balance. Telling
 * them the carrier is holding their money is the entire reason the balance is
 * visible anywhere.
 */
export function decide(position: AccountPosition, rule: ScheduleRule): SendDecision {
  if (!position.enabled) return { send: false, reason: 'disabled' };

  if (position.balanceCents > 0) {
    return position.balanceCents >= rule.minimumBalanceCents
      ? { send: true, reason: 'owes' }
      : { send: false, reason: 'under_minimum' };
  }

  if (rule.includeCreditHolders && position.heldCents > 0) {
    return { send: true, reason: 'holds_credit' };
  }

  return { send: false, reason: 'nothing_to_say' };
}

export const DECISION_LABEL: Record<
  SendDecision['reason'],
  string
> = {
  owes: 'Has a balance outstanding',
  holds_credit: 'Holding credit with you',
  disabled: 'Statements turned off for this customer',
  nothing_to_say: 'Nothing outstanding and nothing on account',
  under_minimum: 'Below the minimum balance',
};

/** One line describing the rule, for the screen that sets it. */
export function describeSchedule(rule: ScheduleRule): string {
  if (rule.cadence === 'off') return 'Statements are not sent on a schedule.';

  const when =
    rule.cadence === 'monthly'
      ? `on the ${ordinal(rule.dayOfMonth)} of each month`
      : `every ${WEEKDAY_LABEL[((rule.dayOfWeek % 7) + 7) % 7]}`;

  const floor =
    rule.minimumBalanceCents > 0
      ? ` owing at least $${(rule.minimumBalanceCents / 100).toFixed(2)}`
      : '';

  const credit = rule.includeCreditHolders ? ', and anyone holding credit with you' : '';

  return `Sent ${when} to every customer${floor}${credit}.`;
}

export function ordinal(value: number): string {
  const n = Math.trunc(value);
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
