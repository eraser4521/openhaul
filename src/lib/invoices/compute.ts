import type { InvoiceStatus, PaymentTerms } from '../db/schema';
import { daysBetween } from './terms';

/**
 * Invoice arithmetic.
 *
 * Every figure is integer cents and every total is derived, never accumulated.
 * A broker will hold a whole invoice over a cent, and an incrementally
 * maintained `paid` column drifts the first time a payment is edited or
 * deleted — so the balance is recomputed from the payments that exist rather
 * than adjusted in place.
 */

export interface Charges {
  /** The transport charge itself. */
  lineHaulCents: number;
  fuelSurchargeCents: number;
  /** Detention, storage, extra stops, winching — added after the fact. */
  accessorialCents: number;
  taxCents: number;
  /** Collected by the driver at delivery, so already in the carrier's hands. */
  codCollectedCents: number;
  /** Taken up front when the load was booked. */
  depositCents: number;
}

export const ZERO_CHARGES: Charges = {
  lineHaulCents: 0,
  fuelSurchargeCents: 0,
  accessorialCents: 0,
  taxCents: 0,
  codCollectedCents: 0,
  depositCents: 0,
};

/** What was charged, before anything already collected is credited. */
export function grossCents(charges: Charges): number {
  return (
    charges.lineHaulCents +
    charges.fuelSurchargeCents +
    charges.accessorialCents +
    charges.taxCents
  );
}

/** What the customer is being asked for: charges less what they already paid. */
export function totalCents(charges: Charges): number {
  return grossCents(charges) - charges.codCollectedCents - charges.depositCents;
}

/**
 * Everything that has settled an invoice, or unsettled it.
 *
 * Passed as one object rather than as positional arguments because there are
 * six of them now and four are optional. `balance(total, paid, 0, 0, applied)`
 * is a transposition waiting to happen, and transposing a refund for a credit
 * moves real money. An `invoices` row satisfies this shape apart from
 * `refundedCents`, which has no column — so most callers spread the row and
 * add that one figure, and a term added later reaches them all.
 */
export interface Settled {
  totalCents: number;
  /** Money that actually arrived. */
  paidCents: number;
  /** Forgiven by credit note, without altering what the invoice says. */
  creditedCents?: number;
  /** Sent back to the customer. */
  refundedCents?: number;
  /** Settled from a balance the customer already had with the carrier. */
  appliedCreditCents?: number;
  /** Overpayment moved off this invoice into the customer's balance. */
  carriedForwardCents?: number;
}

/**
 * Outstanding, after everything that has settled it in either direction.
 *
 * Credits reduce what is owed without touching `total`. The customer is
 * holding an invoice stating that figure and that figure is what was claimed
 * from them; a credit note is a second document saying part of it is no longer
 * due. Rewriting the invoice's total instead would leave two different numbers
 * in circulation under one identity.
 *
 * Goes negative when payments and credits together exceed the charge, which is
 * money the carrier is holding on the customer's behalf rather than a figure
 * to clamp away. Two things return it to zero and both add back: a refund,
 * where the money leaves, and a carry-forward, where it moves to the
 * customer's balance and the carrier keeps holding it. Neither pretends the
 * payment never arrived.
 */
export function balanceCents(settled: Settled): number {
  return (
    settled.totalCents -
    settled.paidCents -
    (settled.creditedCents ?? 0) -
    (settled.appliedCreditCents ?? 0) +
    (settled.refundedCents ?? 0) +
    (settled.carriedForwardCents ?? 0)
  );
}

/**
 * What is owed back to the customer and has not been dealt with yet.
 *
 * Never negative. A refund larger than the overpayment would be a second
 * mistake on top of the first, so the figure the screen offers is clamped and
 * the gates refuse anything above it. Refunds and carry-forwards draw on the
 * same figure, which is what stops $500 being both sent back and kept.
 */
export function refundableCents(settled: Settled): number {
  return Math.max(0, -balanceCents(settled));
}

/**
 * What has landed against the invoice, however it landed.
 *
 * Used for the "has anything been received" test behind partial-payment
 * status. Credit applied from a balance the customer already had counts: an
 * invoice half settled that way is not untouched, and showing it as merely
 * sent would put it back on the chase list.
 */
export function settledInCents(settled: Settled): number {
  return settled.paidCents + (settled.appliedCreditCents ?? 0);
}

/** Sums refunds already sent, the same way payments are summed. */
export function sumRefunds(refunds: ReadonlyArray<{ amountCents: number }>): number {
  return refunds.reduce((sum, refund) => sum + refund.amountCents, 0);
}

/**
 * A customer's credit balance: everything carried in, less everything spent.
 *
 * Derived from the movements every time rather than kept on the customer
 * record. A stored balance drifts the first time a movement is corrected, and
 * a drifting balance is the carrier quietly keeping or giving away money.
 */
export function creditBalance(
  movements: ReadonlyArray<{ direction: 'in' | 'out'; amountCents: number }>,
): number {
  return movements.reduce(
    (sum, movement) => sum + (movement.direction === 'in' ? movement.amountCents : -movement.amountCents),
    0,
  );
}

/**
 * Sums recorded payments.
 *
 * Kept separate so the stored `paid_cents` can be rewritten from the payment
 * rows on every change, which makes a lost or corrected payment impossible to
 * hide in a stale total.
 */
export function sumPayments(payments: ReadonlyArray<{ amountCents: number }>): number {
  return payments.reduce((sum, payment) => sum + payment.amountCents, 0);
}

/* -------------------------------------------------------------------------
 * Deriving an invoice from a load
 * ---------------------------------------------------------------------- */

export interface LoadFigures {
  rateCents: number | null;
  tariffCents: number | null;
  fuelSurchargeCents: number | null;
  codAmountCents: number | null;
  depositCents: number | null;
}

/**
 * Which figure the customer is billed.
 *
 * A carrier hauling for a broker invoices what that broker agreed to pay —
 * the rate. An operation that also brokers the load invoices its own customer
 * the tariff, and the difference is the brokerage. Both are on the load, so
 * the tariff wins when it is set and the basis is reported rather than
 * silently chosen, because billing the wrong one is a five-figure mistake.
 */
export type BillingBasis = 'tariff' | 'rate';

export function deriveCharges(load: LoadFigures): { charges: Charges; basis: BillingBasis } {
  const basis: BillingBasis = load.tariffCents !== null ? 'tariff' : 'rate';

  return {
    basis,
    charges: {
      lineHaulCents: (basis === 'tariff' ? load.tariffCents : load.rateCents) ?? 0,
      fuelSurchargeCents: load.fuelSurchargeCents ?? 0,
      accessorialCents: 0,
      taxCents: 0,
      // A COD load is collected by the driver on delivery, and an invoice only
      // exists once delivery happened — so it starts credited. It is editable,
      // because the driver sometimes comes back without it.
      codCollectedCents: load.codAmountCents ?? 0,
      depositCents: load.depositCents ?? 0,
    },
  };
}

export const BILLING_BASIS_LABEL: Record<BillingBasis, string> = {
  tariff: 'Billing the customer tariff',
  rate: 'Billing the agreed carrier rate',
};

/* -------------------------------------------------------------------------
 * Status
 * ---------------------------------------------------------------------- */

export interface StatusInput extends Settled {
  status: InvoiceStatus;
  dueAt: Date | null;
}

/**
 * The status to show, which is not always the status stored.
 *
 * Overdue is a function of the clock, not an event anybody records. Storing it
 * would need a nightly job to be correct, and would be wrong between runs — so
 * it is derived at read time and the stored column keeps the workflow state
 * that someone actually caused.
 */
export function effectiveStatus(invoice: StatusInput, now: Date): InvoiceStatus {
  if (invoice.status === 'void' || invoice.status === 'draft') return invoice.status;

  // Nothing owed is nothing owed, however it stopped being owed.
  if (balanceCents(invoice) <= 0) return 'paid';

  if (invoice.dueAt && invoice.dueAt.getTime() < now.getTime()) return 'overdue';

  return settledInCents(invoice) > 0 ? 'partially_paid' : invoice.status;
}

/** The status to store after anything that settles an invoice changes. */
export function settledStatus(settled: Settled): InvoiceStatus {
  if (balanceCents(settled) <= 0) return 'paid';
  return settledInCents(settled) > 0 ? 'partially_paid' : 'sent';
}

/* -------------------------------------------------------------------------
 * Aging
 * ---------------------------------------------------------------------- */

export const AGING_BUCKETS = ['current', '1_30', '31_60', '61_90', '90_plus'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export const AGING_LABEL: Record<AgingBucket, string> = {
  current: 'Current',
  '1_30': '1–30 days',
  '31_60': '31–60 days',
  '61_90': '61–90 days',
  '90_plus': 'Over 90 days',
};

/**
 * Where an unpaid invoice sits in an aging report.
 *
 * Bucketed by days past due rather than days since issue. Two invoices raised
 * the same morning on net 10 and net 60 terms are not equally late, and it is
 * lateness a carrier chases.
 */
export function agingBucket(dueAt: Date | null, now: Date): AgingBucket {
  if (!dueAt) return 'current';

  const daysLate = daysBetween(dueAt, now);
  if (daysLate <= 0) return 'current';
  if (daysLate <= 30) return '1_30';
  if (daysLate <= 60) return '31_60';
  if (daysLate <= 90) return '61_90';
  return '90_plus';
}

export interface AgingRow extends Settled {
  status: InvoiceStatus;
  dueAt: Date | null;
}

/** Outstanding money per bucket, for the receivables summary. */
export function ageReceivables(
  invoices: readonly AgingRow[],
  now: Date,
): Record<AgingBucket, number> {
  const totals: Record<AgingBucket, number> = {
    current: 0,
    '1_30': 0,
    '31_60': 0,
    '61_90': 0,
    '90_plus': 0,
  };

  for (const invoice of invoices) {
    // A draft has not been sent to anybody and a void invoice is not owed.
    if (invoice.status === 'draft' || invoice.status === 'void') continue;

    const outstanding = balanceCents(invoice);
    if (outstanding <= 0) continue;

    totals[agingBucket(invoice.dueAt, now)] += outstanding;
  }

  return totals;
}

export function totalOutstanding(invoices: readonly AgingRow[]): number {
  return invoices
    .filter((invoice) => invoice.status !== 'draft' && invoice.status !== 'void')
    .reduce((sum, invoice) => sum + Math.max(0, balanceCents(invoice)), 0);
}

/* -------------------------------------------------------------------------
 * Numbering
 * ---------------------------------------------------------------------- */

/**
 * The next free invoice number for a load.
 *
 * Derived from the load reference so the two can be matched by eye on a
 * remittance advice. A load whose first invoice was voided gets a suffix
 * rather than the number again: reusing it would put two different documents
 * into the customer's accounts payable system under one identity, and the
 * voided one still exists.
 */
export function nextNumberFrom(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;

  for (let attempt = 2; attempt < 1000; attempt += 1) {
    const candidate = `${base}-${attempt}`;
    if (!taken.has(candidate)) return candidate;
  }

  throw new Error(`No free invoice number under ${base} after 999 attempts.`);
}

/* -------------------------------------------------------------------------
 * Parsing money typed by a person
 * ---------------------------------------------------------------------- */

/**
 * Reads a typed amount into integer cents.
 *
 * Accepts what people actually type — `$1,250`, `1250.00`, `1250.5` — and
 * rejects what cannot be money. Parsing through a float then rounding is
 * deliberate and safe at these magnitudes: a freight invoice is thousands of
 * dollars, nowhere near the range where a double loses a cent.
 */
export function parseMoney(input: string | null | undefined): number | null {
  if (input === null || input === undefined) return null;

  const cleaned = input.trim().replace(/[$,\s]/g, '');
  if (cleaned === '') return null;
  if (!/^-?\d*\.?\d*$/.test(cleaned) || cleaned === '.' || cleaned === '-') return null;

  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed)) return null;

  return Math.round(parsed * 100);
}

export type { PaymentTerms };
