import type { ExpenseCategory } from '../db/schema';

/**
 * What a driver spends on the road, and who ends up paying for it.
 *
 * The categories are not decoration. Which of these a carrier reimburses is
 * the single most argued-about part of a lease, and a settlement that lumps
 * them together as "expenses" is one a driver cannot check. Naming them means
 * the statement can say "tolls $84.50" and the driver can agree or not.
 *
 * No `server-only`: the capture form and the review screen both render these.
 */

export const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  fuel: 'Fuel',
  tolls: 'Tolls',
  car_pulling: 'Car pulling',
  lumper: 'Lumper',
  scale: 'Scale',
  parking: 'Parking',
  maintenance: 'Maintenance',
  lodging: 'Lodging',
  permit: 'Permit',
  other: 'Other',
};

/** What each one usually means in auto transport, where it is not obvious. */
export const CATEGORY_NOTE: Partial<Record<ExpenseCategory, string>> = {
  car_pulling: 'Paying someone at an auction or yard to move a vehicle onto the deck.',
  lumper: 'A third party loading or unloading, most often at a terminal.',
  scale: 'Weighing at a CAT scale or a state facility.',
  permit: 'Oversize, overweight, or a trip permit for a state you are not plated in.',
};

/**
 * Whether the carrier has decided about this expense.
 *
 * Three states, not two. "Nobody has looked at it yet" and "we looked and said
 * no" produce the same `reimbursable: false`, and a driver watching a receipt
 * sit unacknowledged for a fortnight needs to be able to tell which it is.
 */
export type ExpenseReview = 'pending' | 'approved' | 'declined';

export function reviewState(expense: {
  reimbursable: boolean;
  reviewedAt: Date | null;
}): ExpenseReview {
  if (!expense.reviewedAt) return 'pending';
  return expense.reimbursable ? 'approved' : 'declined';
}

export const REVIEW_LABEL: Record<ExpenseReview, string> = {
  pending: 'Awaiting review',
  approved: 'To be reimbursed',
  declined: 'Not reimbursed',
};

export const REVIEW_TONE: Record<ExpenseReview, 'neutral' | 'ok' | 'warn'> = {
  pending: 'warn',
  approved: 'ok',
  declined: 'neutral',
};

/**
 * Whether an expense can still be changed.
 *
 * Once a settlement has paid it back, the driver is holding a statement that
 * says so. Editing the amount afterwards would leave two figures for one
 * reimbursement, which is the same reason an issued invoice cannot be edited.
 */
export function isSettled(expense: { reimbursedAt: Date | null }): boolean {
  return expense.reimbursedAt !== null;
}
