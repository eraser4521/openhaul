import type { DriverEmploymentType } from '../db/schema';
import { paymentDueBy } from './compute';

/**
 * Saying so before the fifteen days run out.
 *
 * The settlement screen already shows the deadline, and the driver list
 * already marks a settlement that has passed it. Both answer the question
 * once somebody has gone looking at that driver, which is the wrong moment:
 * by then the only useful version of the information — that there is still
 * time — has expired. Nothing in the application looks across every driver at
 * once and says "this one runs out on Thursday".
 *
 * That is all this does. It is deliberately not a fourth thing that sends
 * email. The cash warning earns its keep by carrying exactly one kind of news
 * — the account going under — and a second kind arriving in the same channel
 * would turn it into the digest it was built not to be. Nor does this justify
 * a channel of its own: a solvency warning has to reach somebody who is
 * driving, because the thing they might do about it is not commit to a load,
 * whereas the answer to a settlement deadline is to draw the statement and
 * pay it, which happens at a screen anyway. It also has a fortnight of
 * runway, not an afternoon. So it belongs where somebody already looks before
 * starting work, beside the insurance that is about to lapse.
 *
 * The regulation binds narrowly and so does this. 49 CFR Part 376 governs a
 * lease between an authorised carrier and an owner-operator; a company driver
 * on payroll is covered by state wage law, which this application does not
 * model and must not pretend to. Every function here returns nothing at all
 * for a company driver rather than quietly applying the wrong rule with the
 * wrong citation attached.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
}

/**
 * How much notice is worth giving.
 *
 * Five days of a fifteen-day window. Early enough to draw a statement and get
 * a payment out, late enough that a carrier settling on any ordinary schedule
 * never sees it: paying within a week of the period end leaves eight days on
 * the clock and this never fires. Only a settlement nobody has touched gets
 * this far, which is exactly the one worth naming.
 */
export const NOTICE_DAYS = 5;

export type DeadlineState = 'fine' | 'due_soon' | 'late';

export interface PayableSettlement {
  id: string;
  driverId: string;
  driverName: string;
  employmentType: DriverEmploymentType;
  periodEnd: Date;
  netPayCents: number;
  finalizedAt: Date | null;
  paidAt: Date | null;
}

export interface Deadline {
  settlementId: string;
  driverId: string;
  driverName: string;
  dueBy: Date;
  /** Whole days remaining. Negative once the window has closed. */
  daysLeft: number;
  state: 'due_soon' | 'late';
  netPayCents: number;
  /**
   * Still a draft, which means two things have to happen rather than one.
   *
   * The clock in 376.12(f) runs from the driver's paperwork, not from the day
   * somebody gets round to drawing the statement — so a draft three days from
   * the deadline is in more trouble than a finalised one, not less, and sorts
   * ahead of it.
   */
  draft: boolean;
}

/**
 * When this settlement has to be paid, or null when no statutory date exists.
 *
 * Null for a company driver, and null for a settlement with nothing to pay:
 * 376.12(f) is a deadline for payment, and a period whose deductions swallowed
 * the earnings has no payment to be late with. The statement still has to be
 * furnished, which is a different obligation and not one a date subtraction
 * can police.
 */
export function deadlineFor(
  settlement: Pick<PayableSettlement, 'periodEnd' | 'netPayCents' | 'employmentType'>,
): Date | null {
  if (settlement.employmentType !== 'owner_operator') return null;
  if (settlement.netPayCents <= 0) return null;

  return paymentDueBy(settlement.periodEnd);
}

/** Whole days from today to the deadline, by the calendar rather than the clock. */
export function daysUntil(dueBy: Date, now: Date): number {
  return Math.round((startOfDay(dueBy).getTime() - startOfDay(now).getTime()) / DAY_MS);
}

export function deadlineState(
  settlement: PayableSettlement,
  now: Date,
  noticeDays = NOTICE_DAYS,
): DeadlineState {
  if (settlement.paidAt !== null) return 'fine';

  const dueBy = deadlineFor(settlement);
  if (!dueBy) return 'fine';

  const left = daysUntil(dueBy, now);
  if (left < 0) return 'late';

  return left <= noticeDays ? 'due_soon' : 'fine';
}

/**
 * Every settlement worth mentioning, worst first.
 *
 * Already-paid settlements are absent even when they were paid late. That is a
 * fact about the past and `isPaymentLate` answers it on the settlement itself;
 * a list of things to do about today has no use for it, and padding the list
 * with history is how a list stops being read.
 */
export function approaching(
  settlements: readonly PayableSettlement[],
  now: Date,
  noticeDays = NOTICE_DAYS,
): Deadline[] {
  const rows: Deadline[] = [];

  for (const settlement of settlements) {
    const state = deadlineState(settlement, now, noticeDays);
    if (state === 'fine') continue;

    const dueBy = deadlineFor(settlement);
    if (!dueBy) continue;

    rows.push({
      settlementId: settlement.id,
      driverId: settlement.driverId,
      driverName: settlement.driverName,
      dueBy,
      daysLeft: daysUntil(dueBy, now),
      state,
      netPayCents: settlement.netPayCents,
      draft: settlement.finalizedAt === null,
    });
  }

  return rows.sort(
    (a, b) =>
      a.daysLeft - b.daysLeft ||
      Number(b.draft) - Number(a.draft) ||
      b.netPayCents - a.netPayCents,
  );
}

/** How many have already run out, for wording the heading. */
export function lateCount(rows: readonly Deadline[]): number {
  return rows.filter((row) => row.state === 'late').length;
}

/**
 * "3 days left", "due today", "8 days over" — the clock in plain words.
 *
 * Takes the number rather than the row, because the escrow return in
 * `escrow.ts` is a different obligation counted the same way, and two
 * implementations of this would drift into saying "1 days over" in one place
 * and not the other.
 */
export function describeDeadline(daysLeft: number): string {
  if (daysLeft < 0) {
    const over = Math.abs(daysLeft);
    return over === 1 ? '1 day over' : `${over} days over`;
  }

  if (daysLeft === 0) return 'due today';
  return daysLeft === 1 ? '1 day left' : `${daysLeft} days left`;
}

/**
 * What a carrier actually has to do, which is not the same for every row.
 *
 * A finalised settlement needs paying. A draft needs drawing first, and saying
 * only "pay this" would understate the work left in the days remaining.
 */
export function describeAction(row: Deadline): string {
  return row.draft ? 'still a draft — finalise it, then pay' : 'ready to pay';
}

/**
 * The note under the list, which cites the rule rather than asserting it.
 *
 * Two sentences and no more. The first is where the deadline comes from; the
 * second is who it leaves out, which has to be said or a carrier reading a
 * list with no company drivers on it would reasonably assume there was
 * nothing to know. Any longer and it becomes the block of grey text people
 * learn to skip, taking the list above it with them.
 *
 * "fifteen" spelled out rather than the constant interpolated, matching the
 * prose everywhere else. The number is only 15 because the regulation says
 * fifteen; if that changed, the sentence would need rewriting anyway.
 */
export const CITATION =
  '49 CFR 376.12(f) requires a leased owner-operator to be paid within fifteen days of the ' +
  'paperwork, counted here from the period end. Company drivers are on payroll under wage law, ' +
  'which this application does not model and does not warn about.';
