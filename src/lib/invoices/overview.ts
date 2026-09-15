import { balanceCents, type AgingBucket, type Settled } from './compute';
import type { HoldReason } from './dunning';

/**
 * The money, on one page.
 *
 * Every figure here is answered well somewhere else already — receivables on
 * the invoice list, promises on their worklist, credit on the customer cards,
 * chasing in settings. What none of those can do is put them beside each
 * other, and a carrier deciding on a Monday morning whether they are going to
 * get paid needs exactly that.
 *
 * Assembling it is easy. Choosing what to leave off is the work, so the rules
 * this file keeps to are worth stating:
 *
 *  - Four figures for the position, not twelve. A screen with twelve numbers
 *    is read as decoration.
 *  - Nothing that needs a control. A page somebody opens for ten seconds
 *    before the phone starts should not first ask them for a date range.
 *  - Money the carrier is holding for customers is named as theirs. It is a
 *    liability sitting in the same bank account as the rest, and the figure
 *    most easily mistaken for income.
 *  - Anything actionable says what to do and links to where it is done. The
 *    difference between a report and a working screen is whether it ends in
 *    a verb.
 */

export interface Position {
  /** Outstanding across every issued invoice, net of everything. */
  owedCents: number;
  /** The part of that which is past its due date. */
  overdueCents: number;
  /**
   * Promised and not yet resolved. Broken promises are deliberately absent:
   * a commitment somebody did not keep is a problem, not money coming.
   */
  promisedCents: number;
  /** Customer money the carrier is holding. Theirs, not the carrier's. */
  heldCents: number;
}

/** What was billed and what came in over a window, as a sense of movement. */
export interface Flow {
  days: number;
  invoicedCents: number;
  receivedCents: number;
}

export const FLOW_DAYS = 7;

export interface InvoiceLike extends Settled {
  status: string;
  issuedAt: Date | null;
  dueAt: Date | null;
}

/** Issued invoices only: a draft has been shown to nobody and a void is not owed. */
export function live<T extends { status: string }>(invoices: readonly T[]): T[] {
  return invoices.filter((invoice) => invoice.status !== 'draft' && invoice.status !== 'void');
}

export function owedCents(invoices: readonly InvoiceLike[]): number {
  return live(invoices).reduce((sum, invoice) => sum + Math.max(0, balanceCents(invoice)), 0);
}

export function overdueCents(invoices: readonly InvoiceLike[], now: Date): number {
  return live(invoices)
    .filter((invoice) => invoice.dueAt !== null && invoice.dueAt.getTime() < now.getTime())
    .reduce((sum, invoice) => sum + Math.max(0, balanceCents(invoice)), 0);
}

/**
 * Billed and collected over the last few days.
 *
 * Flow beside the standing figures, because "we are owed ninety thousand" and
 * "we are owed ninety thousand and collected four of it last week" are
 * different situations and only the second one tells anybody anything.
 *
 * Counted from when each invoice was issued and each payment received, not
 * from when the rows were written, so a backdated entry lands in the week it
 * belongs to.
 */
export function flowSince(
  invoices: readonly InvoiceLike[],
  payments: ReadonlyArray<{ amountCents: number; receivedAt: Date }>,
  now: Date,
  days = FLOW_DAYS,
): Flow {
  const since = now.getTime() - days * 24 * 60 * 60 * 1000;

  return {
    days,
    invoicedCents: live(invoices)
      .filter((invoice) => invoice.issuedAt !== null && invoice.issuedAt.getTime() >= since)
      .reduce((sum, invoice) => sum + invoice.totalCents, 0),
    receivedCents: payments
      .filter((payment) => payment.receivedAt.getTime() >= since)
      .reduce((sum, payment) => sum + payment.amountCents, 0),
  };
}

/* -------------------------------------------------------------------------
 * The one thing only this screen can see
 * ---------------------------------------------------------------------- */

export interface CreditStandoff {
  customerId: string;
  customerName: string;
  /** What they owe across their open invoices. */
  owedCents: number;
  /** What the carrier is holding for them. */
  heldCents: number;
  /** The lesser of the two: what applying the credit would actually settle. */
  applicableCents: number;
}

/**
 * Customers who owe money while the carrier holds money of theirs.
 *
 * The invoice screen knows the balance and the customer screen knows the
 * credit; neither is in a position to notice that both are true at once. It
 * is the most useful thing on this page and the most embarrassing to leave
 * unnoticed — an invoice chased, a statement sent, a reminder posted, all to
 * somebody whose money is already in the carrier's account.
 *
 * Sorted by what applying the credit would settle, because that is the size
 * of the mistake being avoided.
 */
export function creditStandoffs(
  owedByCustomer: ReadonlyMap<string, number>,
  heldByCustomer: ReadonlyMap<string, number>,
  names: ReadonlyMap<string, string>,
): CreditStandoff[] {
  const rows: CreditStandoff[] = [];

  for (const [customerId, held] of heldByCustomer) {
    if (held <= 0) continue;

    const owed = owedByCustomer.get(customerId) ?? 0;
    if (owed <= 0) continue;

    rows.push({
      customerId,
      customerName: names.get(customerId) ?? 'Unknown customer',
      owedCents: owed,
      heldCents: held,
      applicableCents: Math.min(owed, held),
    });
  }

  return rows.sort((a, b) => b.applicableCents - a.applicableCents);
}

/* -------------------------------------------------------------------------
 * What needs somebody today
 * ---------------------------------------------------------------------- */

export interface Attention {
  key: string;
  /** What it is, as a sentence somebody could act on. */
  label: string;
  count: number;
  href: string;
  tone: 'danger' | 'warn' | 'info';
}

export interface AttentionInput {
  promisesNotKept: number;
  noticesDue: number;
  standoffs: number;
  /** Overdue invoices the ladder is deliberately leaving alone, by reason. */
  heldBack: ReadonlyMap<HoldReason, number>;
  /** Notices from the last sweep that could not be sent. */
  failedNotices: number;
}

/**
 * Plural noun and the verb that has to agree with it.
 *
 * Written together rather than pluralised separately, because "1 customer owe
 * you" is the shape that gets past a review — the noun looks handled, and the
 * verb is three words away.
 */
function agree(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

/**
 * The short list, worst first, with the empty entries left out.
 *
 * A row per thing that is actually true today rather than a fixed set of
 * counters showing zero. Zeroes teach a reader to stop looking, and the
 * whole value of this section is that a glance at it means something.
 *
 * Deliberately excludes the reasons an invoice is *rightly* not being chased
 * — a disputed one, a customer who asked not to be — because those are
 * decisions somebody already made and a list that nags about them is a list
 * that gets ignored.
 */
export function attention(input: AttentionInput): Attention[] {
  const rows: Attention[] = [];

  if (input.promisesNotKept > 0) {
    rows.push({
      key: 'promises',
      label: agree(input.promisesNotKept, 'promise not kept', 'promises not kept'),
      count: input.promisesNotKept,
      href: '/invoices/promises',
      tone: 'danger',
    });
  }

  if (input.standoffs > 0) {
    rows.push({
      key: 'standoffs',
      label: agree(
        input.standoffs,
        'customer owes you while you hold their money',
        'customers owe you while you hold their money',
      ),
      count: input.standoffs,
      href: '/customers',
      tone: 'warn',
    });
  }

  if (input.failedNotices > 0) {
    rows.push({
      key: 'failed',
      label: agree(
        input.failedNotices,
        'notice could not be sent',
        'notices could not be sent',
      ),
      count: input.failedNotices,
      href: '/settings',
      tone: 'warn',
    });
  }

  const stuck =
    (input.heldBack.get('no_email') ?? 0) + (input.heldBack.get('customer_opted_out') ?? 0);
  if (stuck > 0) {
    rows.push({
      key: 'unchaseable',
      label: agree(
        stuck,
        'overdue invoice cannot be chased automatically',
        'overdue invoices cannot be chased automatically',
      ),
      count: stuck,
      href: '/settings',
      tone: 'warn',
    });
  }

  if (input.noticesDue > 0) {
    rows.push({
      key: 'notices',
      label: agree(
        input.noticesDue,
        'notice goes out on the next sweep',
        'notices go out on the next sweep',
      ),
      count: input.noticesDue,
      href: '/settings',
      tone: 'info',
    });
  }

  return rows;
}

/** The worst bucket carrying money, for the one-line summary of the aging. */
export function worstBucket(
  aged: Record<AgingBucket, number>,
): { bucket: AgingBucket; cents: number } | null {
  const order: AgingBucket[] = ['90_plus', '61_90', '31_60', '1_30'];

  for (const bucket of order) {
    if (aged[bucket] > 0) return { bucket, cents: aged[bucket] };
  }

  return null;
}
