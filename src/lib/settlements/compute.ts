import type { DriverEmploymentType, SettlementLineKind } from '../db/schema';

/**
 * Settlement arithmetic.
 *
 * A driver checks their own settlement more carefully than anybody checks an
 * invoice, and a settlement that does not reconcile is the fastest way to lose
 * one. So every total is derived from the lines rather than stored alongside
 * them, and the lines say how each figure was reached.
 */

/** Which direction each kind of line moves the net. */
const DIRECTION: Record<SettlementLineKind, 1 | -1> = {
  load_pay: 1,
  bonus: 1,
  reimbursement: 1,
  escrow_return: 1,

  deduction: -1,
  escrow_deposit: -1,
  advance: -1,
};

export const LINE_LABEL: Record<SettlementLineKind, string> = {
  load_pay: 'Load pay',
  bonus: 'Bonus',
  reimbursement: 'Reimbursement',
  deduction: 'Deduction',
  escrow_deposit: 'Escrow held',
  escrow_return: 'Escrow returned',
  advance: 'Advance recovered',
};

export interface SettlementLineInput {
  kind: SettlementLineKind;
  amountCents: number;
}

/**
 * What a line contributes to the net.
 *
 * Amounts are magnitudes and the kind supplies the sign, so a deduction of
 * 5000 subtracts $50.00. A negative amount is therefore a reversal of its own
 * kind — how a chargeback raised in error is undone without deleting a line
 * the driver has already seen.
 */
export function signedCents(line: SettlementLineInput): number {
  return DIRECTION[line.kind] * line.amountCents;
}

export function sumKind(
  lines: readonly SettlementLineInput[],
  ...kinds: SettlementLineKind[]
): number {
  const wanted = new Set(kinds);
  return lines
    .filter((line) => wanted.has(line.kind))
    .reduce((sum, line) => sum + line.amountCents, 0);
}

export interface SettlementTotals {
  /** Gross pay earned: loads plus bonuses. */
  earningsCents: number;
  reimbursementsCents: number;
  deductionsCents: number;
  advancesCents: number;
  escrowHeldCents: number;
  escrowReturnedCents: number;
  /** What actually gets paid. */
  netPayCents: number;
}

export function totalsFrom(lines: readonly SettlementLineInput[]): SettlementTotals {
  return {
    earningsCents: sumKind(lines, 'load_pay', 'bonus'),
    reimbursementsCents: sumKind(lines, 'reimbursement'),
    deductionsCents: sumKind(lines, 'deduction'),
    advancesCents: sumKind(lines, 'advance'),
    escrowHeldCents: sumKind(lines, 'escrow_deposit'),
    escrowReturnedCents: sumKind(lines, 'escrow_return'),
    netPayCents: lines.reduce((sum, line) => sum + signedCents(line), 0),
  };
}

/* -------------------------------------------------------------------------
 * Pay basis
 * ---------------------------------------------------------------------- */

export type PayBasis =
  | { kind: 'percentage'; rateBps: number }
  | { kind: 'per_mile'; centsPerMile: number }
  | { kind: 'none' };

export interface DriverPay {
  employmentType: DriverEmploymentType;
  payRateBps: number | null;
  payPerMileCents: number | null;
}

/**
 * How this driver is paid.
 *
 * A percentage wins when both are set, because a driver on a share who also
 * has a per-mile figure recorded is almost always a share driver with a stale
 * field — and paying the lower of two plausible bases by accident is the error
 * that costs trust.
 */
export function payBasisFor(driver: DriverPay): PayBasis {
  if (driver.payRateBps !== null && driver.payRateBps > 0) {
    return { kind: 'percentage', rateBps: driver.payRateBps };
  }
  if (driver.payPerMileCents !== null && driver.payPerMileCents > 0) {
    return { kind: 'per_mile', centsPerMile: driver.payPerMileCents };
  }
  return { kind: 'none' };
}

export interface LoadForPay {
  rateCents: number | null;
  distanceMiles: number | null;
}

export interface LoadPay {
  amountCents: number;
  basisNote: string;
}

function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  return `${sign}$${Math.floor(absolute / 100).toLocaleString('en-US')}.${String(absolute % 100).padStart(2, '0')}`;
}

/**
 * What one load earns this driver, and the sentence explaining it.
 *
 * The note is not decoration. Where pay is a percentage of revenue, 49 CFR
 * 376.12(d) entitles a leased owner-operator to see the rated figure the
 * percentage was taken from — so the arithmetic goes on the statement rather
 * than being something they have to ask for.
 *
 * Rounding is half-up on a single multiplication, so the cent always lands in
 * the same place and a hundred loads cannot drift against the driver.
 */
export function payForLoad(load: LoadForPay, basis: PayBasis): LoadPay {
  if (basis.kind === 'percentage') {
    const revenue = load.rateCents ?? 0;
    const amount = Math.round((revenue * basis.rateBps) / 10_000);
    return {
      amountCents: amount,
      basisNote: `${(basis.rateBps / 100).toFixed(2)}% of ${money(revenue)}`,
    };
  }

  if (basis.kind === 'per_mile') {
    const miles = load.distanceMiles ?? 0;
    return {
      amountCents: Math.round(miles * basis.centsPerMile),
      basisNote: `${miles.toLocaleString('en-US')} mi at ${money(basis.centsPerMile)} per mile`,
    };
  }

  return { amountCents: 0, basisNote: 'No pay rate is set for this driver' };
}

export function describeBasis(basis: PayBasis): string {
  switch (basis.kind) {
    case 'percentage':
      return `${(basis.rateBps / 100).toFixed(2)}% of load revenue`;
    case 'per_mile':
      return `${money(basis.centsPerMile)} per mile`;
    default:
      return 'No pay rate set';
  }
}

/* -------------------------------------------------------------------------
 * Escrow — 49 CFR 376.12(h)
 * ---------------------------------------------------------------------- */

/**
 * The running escrow balance across every settlement.
 *
 * 376.12(h) gives a leased owner-operator the right to demand an accounting of
 * the escrow fund at any time, and requires it returned within 45 days of the
 * lease ending. A balance that only exists as the sum of historic deductions
 * nobody totalled is not an accounting, so it is computed and shown on every
 * statement.
 */
export function escrowBalance(lines: readonly SettlementLineInput[]): number {
  return sumKind(lines, 'escrow_deposit') - sumKind(lines, 'escrow_return');
}

/** Days after a lease ends within which escrow must be returned. */
export const ESCROW_RETURN_DAYS = 45;

/** Days after delivery paperwork is submitted within which payment is due. */
export const LEASED_PAYMENT_DAYS = 15;

/**
 * When an owner-operator's settlement becomes late.
 *
 * 376.12(f) requires payment within fifteen days of the driver submitting the
 * documents needed to bill the load. Counted from the end of the pay period,
 * which is the latest those documents can have arrived.
 */
export function paymentDueBy(periodEnd: Date): Date {
  const due = new Date(periodEnd.getTime());
  due.setUTCDate(due.getUTCDate() + LEASED_PAYMENT_DAYS);
  return due;
}

/* -------------------------------------------------------------------------
 * Status
 * ---------------------------------------------------------------------- */

export type SettlementStatus = 'draft' | 'finalized' | 'paid';

export function settlementStatus(settlement: {
  finalizedAt: Date | null;
  paidAt: Date | null;
}): SettlementStatus {
  if (settlement.paidAt) return 'paid';
  if (settlement.finalizedAt) return 'finalized';
  return 'draft';
}

export const STATUS_LABEL: Record<SettlementStatus, string> = {
  draft: 'Draft',
  finalized: 'Ready to pay',
  paid: 'Paid',
};

/**
 * Whether a leased driver's settlement is past the statutory payment window.
 *
 * Only ever true for an owner-operator: Part 376 governs a lease, and a
 * company driver on payroll is covered by wage law instead, which this does
 * not attempt to model.
 */
export function isPaymentLate(
  settlement: { periodEnd: Date; paidAt: Date | null },
  employmentType: DriverEmploymentType,
  now: Date,
): boolean {
  if (employmentType !== 'owner_operator') return false;
  if (settlement.paidAt) return settlement.paidAt.getTime() > paymentDueBy(settlement.periodEnd).getTime();
  return now.getTime() > paymentDueBy(settlement.periodEnd).getTime();
}
