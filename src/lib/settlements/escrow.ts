import type { DriverEmploymentType } from '../db/schema';
import { ESCROW_RETURN_DAYS } from './compute';
import { daysUntil } from './deadline';

/**
 * Money held for somebody who has left.
 *
 * Every settlement statement handed to a leased owner-operator already prints
 * a sentence saying their escrow comes back within forty-five days of the
 * lease ending, because 49 CFR 376.12(h) requires it. The application computed
 * the balance, printed the promise, and then had no idea whether it was kept.
 *
 * This is the one deadline in the application where the carrier's interest
 * runs the other way. A late invoice costs them money and a late settlement
 * embarrasses them with somebody they still need; escrow that quietly stays
 * put costs them nothing and the person it belongs to has already gone. That
 * is the whole reason it is worth building — a reminder is only load-bearing
 * where nobody has an incentive to go looking.
 *
 * Two things follow from it.
 *
 * The balance reaching zero is what counts as discharged, rather than a flag
 * somebody ticks. Escrow moves through settlement lines, so returning it means
 * writing a line the driver can see on a statement; a "returned" checkbox
 * would let the obligation be marked done without anything actually moving.
 * 376.12(h)(6) also lets a carrier deduct what the lease permits, and that
 * lands as lines too, so both ways of discharging the fund land in the same
 * arithmetic and neither needs to be trusted separately.
 *
 * And it is anchored on the carrier's own record that the driver has gone.
 * Nothing else in the data says a lease ended. That does mean a carrier who
 * never marks anybody as having left never sees this, which is worth saying
 * out loud rather than papering over: the warning rests on an act of
 * record-keeping, and the screen says what it is counting from.
 */

/**
 * How much notice is worth giving on a forty-five day clock.
 *
 * Returning escrow usually means drawing a final settlement and clearing
 * whatever the lease lets the carrier deduct, which is a week or two of work
 * at worst. A carrier doing it at any ordinary pace is finished inside a
 * month and never sees this. Ten days is enough to do it from a standing
 * start, and late enough that only a fund nobody has touched gets here.
 */
export const NOTICE_DAYS = 10;

export type EscrowState =
  /** Nothing is held, so there is nothing to return. */
  | 'nothing_held'
  /** A company driver. Part 376 governs a lease, and this is not one. */
  | 'not_leased'
  /** Still driving. The clock starts when the lease ends, not before. */
  | 'under_lease'
  /** The lease has ended and there is time in hand. */
  | 'in_hand'
  | 'due_soon'
  | 'late';

export interface Holding {
  driverId: string;
  driverName: string;
  employmentType: DriverEmploymentType;
  /** The carrier's own record that this driver has gone. Null while they have not. */
  deactivatedAt: Date | null;
  /** Deposits less returns across every settlement. */
  balanceCents: number;
}

export interface EscrowReturn {
  driverId: string;
  driverName: string;
  balanceCents: number;
  endedOn: Date;
  dueBy: Date;
  /** Whole days remaining. Negative once the window has closed. */
  daysLeft: number;
  state: 'due_soon' | 'late';
}

/**
 * When the fund has to be back with the driver, or null when no clock runs.
 *
 * Null for a company driver, for a driver still on the books, and for a fund
 * with nothing in it. A negative balance counts as nothing held: it means more
 * has been returned than was ever deposited, which is a correction rather than
 * a debt the driver owes back.
 */
export function returnDueBy(holding: Holding): Date | null {
  if (holding.employmentType !== 'owner_operator') return null;
  if (holding.balanceCents <= 0) return null;
  if (!holding.deactivatedAt) return null;

  const due = new Date(holding.deactivatedAt.getTime());
  due.setUTCDate(due.getUTCDate() + ESCROW_RETURN_DAYS);
  return due;
}

export function escrowState(holding: Holding, now: Date, noticeDays = NOTICE_DAYS): EscrowState {
  if (holding.balanceCents <= 0) return 'nothing_held';
  if (holding.employmentType !== 'owner_operator') return 'not_leased';
  if (!holding.deactivatedAt) return 'under_lease';

  const dueBy = returnDueBy(holding);
  if (!dueBy) return 'nothing_held';

  const left = daysUntil(dueBy, now);
  if (left < 0) return 'late';

  return left <= noticeDays ? 'due_soon' : 'in_hand';
}

/**
 * Every fund running out of time, worst first.
 *
 * Sorted by what is left on the clock and then by size, because where two
 * funds fall on the same day the larger one is the bigger thing to have
 * quietly kept.
 */
export function outstandingReturns(
  holdings: readonly Holding[],
  now: Date,
  noticeDays = NOTICE_DAYS,
): EscrowReturn[] {
  const rows: EscrowReturn[] = [];

  for (const holding of holdings) {
    const state = escrowState(holding, now, noticeDays);
    if (state !== 'due_soon' && state !== 'late') continue;

    const dueBy = returnDueBy(holding);
    if (!dueBy || !holding.deactivatedAt) continue;

    rows.push({
      driverId: holding.driverId,
      driverName: holding.driverName,
      balanceCents: holding.balanceCents,
      endedOn: holding.deactivatedAt,
      dueBy,
      daysLeft: daysUntil(dueBy, now),
      state,
    });
  }

  return rows.sort((a, b) => a.daysLeft - b.daysLeft || b.balanceCents - a.balanceCents);
}

/** How many funds are already past the forty-five days, for wording the heading. */
export function lateCount(rows: readonly EscrowReturn[]): number {
  return rows.filter((row) => row.state === 'late').length;
}

/**
 * The note under the list.
 *
 * Says what the clock is counted from as well as what it requires. A deadline
 * derived from a date somebody typed should say so, or the first response to a
 * warning that looks wrong is to distrust the whole screen rather than to go
 * and correct the date.
 *
 * Three clauses and no more. How the driver comes to see the money — that
 * returning it lands on a statement they receive — belongs on the driver's own
 * card, where somebody is about to act, rather than on a dashboard note that
 * is only a pointer. Any longer here and it becomes the block of grey text
 * people learn to skip, taking the list above it with them.
 */
export const ESCROW_CITATION =
  '49 CFR 376.12(h) requires escrow back within forty-five days of the lease ending, less only ' +
  'what the lease permits deducting. Counted from the day the driver was marked as having left, ' +
  'and cleared when the balance reaches zero.';
