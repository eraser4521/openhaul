import type { PaymentTerms } from '../db/schema';

/**
 * Payment terms, and what they mean for a due date.
 *
 * The list mixes two things the industry also mixes: when payment is due
 * ("net 30") and how it arrives ("ACH", "check on delivery"). Both appear on
 * rate confirmations as the "terms", so both are here, and each one is mapped
 * to the number of days after issue that payment becomes late.
 */

export interface TermsDefinition {
  /** Days after the invoice is issued before payment is late. */
  netDays: number | null;
  label: string;
  /** Printed on the invoice under the due date. */
  note?: string;
}

const TERMS: Record<PaymentTerms, TermsDefinition> = {
  on_pickup: { netDays: 0, label: 'Due on pickup', note: 'Payment was due when the vehicles were collected.' },
  cash_on_pickup: { netDays: 0, label: 'Cash on pickup' },
  check_on_pickup: { netDays: 0, label: 'Check on pickup' },

  on_delivery: { netDays: 0, label: 'Due on delivery' },
  cash_on_delivery: { netDays: 0, label: 'Cash on delivery' },
  check_on_delivery: { netDays: 0, label: 'Check on delivery' },

  // Quick pay is a broker paying early in exchange for a percentage. Two days
  // is the common commitment; the fee itself is a deduction, not a term.
  quickpay: { netDays: 2, label: 'Quick pay', note: 'Any quick pay fee is deducted by agreement.' },
  ach: { netDays: 0, label: 'ACH on receipt' },

  '2_days': { netDays: 2, label: 'Net 2' },
  '5_days': { netDays: 5, label: 'Net 5' },
  '7_days': { netDays: 7, label: 'Net 7' },
  '10_days': { netDays: 10, label: 'Net 10' },
  '15_days': { netDays: 15, label: 'Net 15' },
  '20_days': { netDays: 20, label: 'Net 20' },
  '30_days': { netDays: 30, label: 'Net 30' },
  '45_days': { netDays: 45, label: 'Net 45' },
  '60_days': { netDays: 60, label: 'Net 60' },

  // No due date is invented for terms nobody wrote down. An invoice that
  // claims a deadline it was never given is worse than one that says so.
  other: { netDays: null, label: 'Per agreement' },
};

export function termsDefinition(terms: PaymentTerms | null): TermsDefinition {
  if (!terms) return { netDays: null, label: 'Per agreement' };
  return TERMS[terms];
}

export function termsLabel(terms: PaymentTerms | null): string {
  return termsDefinition(terms).label;
}

/**
 * The date payment becomes late.
 *
 * Whole days from the issue date, in UTC. Deliberately not a timezone-aware
 * calculation: an invoice is due on a date, not at an instant, and a carrier
 * chasing a broker three states away does not care about the hour.
 */
export function dueDateFor(issuedAt: Date, terms: PaymentTerms | null): Date | null {
  const { netDays } = termsDefinition(terms);
  if (netDays === null) return null;

  const due = new Date(issuedAt.getTime());
  due.setUTCDate(due.getUTCDate() + netDays);
  return due;
}

/** Whole days between two dates, ignoring the time of day. */
export function daysBetween(from: Date, to: Date): number {
  const startOfDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((startOfDay(to) - startOfDay(from)) / 86_400_000);
}
