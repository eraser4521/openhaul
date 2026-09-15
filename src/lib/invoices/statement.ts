import { agingBucket, balanceCents, type AgingBucket, type Settled } from './compute';
import { daysBetween } from './terms';

/**
 * A customer's account, as at today.
 *
 * Two ledgers, because a customer can owe money and be owed money at the same
 * time and netting them into one figure loses which is which. What they owe
 * is the sum of their open invoices; what the carrier holds for them is the
 * credit balance. A carried-forward overpayment moves between the two, which
 * is why both appear on one document — it is the only place the movement
 * makes sense.
 *
 * Everything here is pure and dated. The value of a statement is that the
 * customer can reconcile it: opening balance, every movement since, closing
 * balance, and the arithmetic has to close. A statement that does not close
 * is worse than none, because it turns a collection call into an argument
 * about the statement — so the generator computes the closing figure twice,
 * once by adding up movements and once from the invoices themselves, and
 * refuses to produce the document if they disagree.
 */

export const ENTRY_KINDS = [
  'invoice',
  'payment',
  'credit_note',
  'credit_note_void',
  'refund',
  'credit_kept',
  'credit_applied',
] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const ENTRY_LABEL: Record<EntryKind, string> = {
  invoice: 'Invoice',
  payment: 'Payment received',
  credit_note: 'Credit note',
  credit_note_void: 'Credit note withdrawn',
  refund: 'Refund sent',
  credit_kept: 'Kept on account',
  credit_applied: 'Applied from account',
};

export interface StatementEntry {
  at: Date;
  kind: EntryKind;
  /** The document this movement belongs to: an invoice or credit note number. */
  reference: string;
  detail: string | null;
  /**
   * Signed. Positive increases what the customer owes.
   *
   * A refund is positive for the same reason it adds back to an invoice
   * balance: the money went out, so the customer's credit position shrinks.
   * Keeping an overpayment is positive too — the invoice it came off settles.
   */
  dueCents: number;
  /** Signed. Positive increases what the carrier is holding for them. */
  heldCents: number;
}

/**
 * The order movements dated the same day are read in.
 *
 * Economic sequence, not alphabetical. A carry-forward can only exist because
 * a payment overpaid something, so printing it first makes the running balance
 * climb above anything the customer was ever billed and then fall back — which
 * reads as an error and gets queried instead of paid. Bill, then forgive, then
 * settle, then move what is left over.
 */
const KIND_ORDER: Record<EntryKind, number> = {
  invoice: 0,
  credit_note: 1,
  credit_note_void: 2,
  payment: 3,
  refund: 4,
  credit_kept: 5,
  credit_applied: 6,
};

/** Oldest first. Ties fall back to sequence then reference, so two runs agree. */
export function inOrder(entries: readonly StatementEntry[]): StatementEntry[] {
  return entries.slice().sort((a, b) => {
    const byDate = a.at.getTime() - b.at.getTime();
    if (byDate !== 0) return byDate;
    return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.reference.localeCompare(b.reference);
  });
}

export function sumDue(entries: readonly StatementEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.dueCents, 0);
}

export function sumHeld(entries: readonly StatementEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.heldCents, 0);
}

/**
 * Everything that happened before the statement period opens.
 *
 * There is deliberately no upper bound on the period. It always runs to now,
 * so every entry is either before the start or inside it, and the opening
 * balance plus the period always equals the closing balance. Bounding the top
 * would let a movement dated tomorrow — a mistyped payment date — fall
 * outside both and silently unbalance the document.
 */
export function before(entries: readonly StatementEntry[], from: Date): StatementEntry[] {
  return entries.filter((entry) => entry.at.getTime() < from.getTime());
}

export function within(entries: readonly StatementEntry[], from: Date): StatementEntry[] {
  return entries.filter((entry) => entry.at.getTime() >= from.getTime());
}

export interface StatementTotals {
  openingDueCents: number;
  openingHeldCents: number;

  invoicedCents: number;
  paidCents: number;
  creditedCents: number;
  refundedCents: number;
  keptCents: number;
  appliedCents: number;

  closingDueCents: number;
  closingHeldCents: number;
}

/** Sums one kind's absolute movement within a set of entries. */
function totalOf(entries: readonly StatementEntry[], kind: EntryKind): number {
  return entries
    .filter((entry) => entry.kind === kind)
    .reduce((sum, entry) => sum + Math.abs(entry.dueCents), 0);
}

export function totalsFor(entries: readonly StatementEntry[], from: Date): StatementTotals {
  const earlier = before(entries, from);
  const period = within(entries, from);

  const openingDueCents = sumDue(earlier);
  const openingHeldCents = sumHeld(earlier);

  return {
    openingDueCents,
    openingHeldCents,

    invoicedCents: totalOf(period, 'invoice'),
    // A withdrawn credit note nets against the one it withdraws, so the
    // figure reads as what was actually forgiven in the period.
    creditedCents: totalOf(period, 'credit_note') - totalOf(period, 'credit_note_void'),
    paidCents: totalOf(period, 'payment'),
    refundedCents: totalOf(period, 'refund'),
    keptCents: totalOf(period, 'credit_kept'),
    appliedCents: totalOf(period, 'credit_applied'),

    closingDueCents: openingDueCents + sumDue(period),
    closingHeldCents: openingHeldCents + sumHeld(period),
  };
}

/** A running balance beside each entry, so a customer can follow the arithmetic. */
export function withRunningBalance(
  entries: readonly StatementEntry[],
  openingCents: number,
): Array<{ entry: StatementEntry; balanceCents: number }> {
  let balance = openingCents;
  return entries.map((entry) => {
    balance += entry.dueCents;
    return { entry, balanceCents: balance };
  });
}

/* -------------------------------------------------------------------------
 * What is still open
 * ---------------------------------------------------------------------- */

export interface OpenItem {
  invoiceNumber: string;
  issuedAt: Date | null;
  dueAt: Date | null;
  totalCents: number;
  balanceCents: number;
  bucket: AgingBucket;
  /** Negative when it is not due yet. */
  daysLate: number;
}

export interface OpenInvoice extends Settled {
  number: string;
  issuedAt: Date | null;
  dueAt: Date | null;
}

/**
 * Unpaid invoices, oldest due date first.
 *
 * Never filtered by the statement period. An open-item list that hides a
 * six-month-old debt because the statement covers ninety days is worse than
 * no list — it is a document saying nothing older is outstanding, which is
 * the one thing a statement must never say by accident.
 */
export function openItems(invoices: readonly OpenInvoice[], now: Date): OpenItem[] {
  return invoices
    .map((invoice) => ({
      invoiceNumber: invoice.number,
      issuedAt: invoice.issuedAt,
      dueAt: invoice.dueAt,
      totalCents: invoice.totalCents,
      balanceCents: balanceCents(invoice),
      bucket: agingBucket(invoice.dueAt, now),
      daysLate: invoice.dueAt ? daysBetween(invoice.dueAt, now) : 0,
    }))
    .filter((item) => item.balanceCents > 0)
    .sort((a, b) => {
      const aDue = a.dueAt?.getTime() ?? 0;
      const bDue = b.dueAt?.getTime() ?? 0;
      return aDue - bDue || a.invoiceNumber.localeCompare(b.invoiceNumber);
    });
}

export function agedTotals(items: readonly OpenItem[]): Record<AgingBucket, number> {
  const totals: Record<AgingBucket, number> = {
    current: 0,
    '1_30': 0,
    '31_60': 0,
    '61_90': 0,
    '90_plus': 0,
  };
  for (const item of items) totals[item.bucket] += item.balanceCents;
  return totals;
}

/* -------------------------------------------------------------------------
 * The check that decides whether it is fit to send
 * ---------------------------------------------------------------------- */

export interface Reconciliation {
  ok: boolean;
  /** Closing balance from the movements. */
  fromEntriesCents: number;
  /** Closing balance from the invoices themselves. */
  fromInvoicesCents: number;
  differenceCents: number;
}

/**
 * Whether the two ways of arriving at the closing balance agree.
 *
 * They are computed from different rows on purpose. The movements are a
 * ledger assembled from payments, credits, refunds and credit movements; the
 * invoice figure is each invoice's own position. A gap means the ledger is
 * missing something, and sending a statement that does not add up invites a
 * customer to dispute every figure on it rather than pay any of them.
 */
export function reconcile(
  totals: StatementTotals,
  fromInvoicesCents: number,
): Reconciliation {
  const difference = totals.closingDueCents - fromInvoicesCents;
  return {
    ok: difference === 0,
    fromEntriesCents: totals.closingDueCents,
    fromInvoicesCents,
    differenceCents: difference,
  };
}

/* -------------------------------------------------------------------------
 * Choosing a period
 * ---------------------------------------------------------------------- */

export const STATEMENT_WINDOWS = [30, 60, 90, 180, 365] as const;
export type StatementWindow = (typeof STATEMENT_WINDOWS)[number];

/** Midnight UTC, `days` before `now`. */
export function windowStart(days: number, now: Date): Date {
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), 0, 0, 0, 0),
  );
}

const WINDOW_LABEL: Record<number, string> = {
  30: 'Last 30 days',
  60: 'Last 2 months',
  90: 'Last 3 months',
  180: 'Last 6 months',
  365: 'Last 12 months',
};

export function describeWindow(days: number): string {
  return WINDOW_LABEL[days] ?? `Last ${days} days`;
}
