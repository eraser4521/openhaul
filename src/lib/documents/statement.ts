import {
  CONTENT_WIDTH,
  DocBuilder,
  HAIRLINE,
  INK,
  MARGIN,
  MUTED,
  PANEL,
  WARNING,
  addressBlock,
  dateText,
  moneyText,
  type DocumentBrand,
} from './layout';
import type { InvoiceParty } from './invoice';
import { AGING_LABEL, AGING_BUCKETS, type AgingBucket } from '../invoices/compute';
import {
  ENTRY_LABEL,
  type OpenItem,
  type StatementEntry,
  type StatementTotals,
} from '../invoices/statement';

/**
 * The statement of account a customer is sent.
 *
 * Three questions, in the order somebody actually asks them: what do I owe,
 * which invoices is it, and how did we get here. The credit balance sits
 * between the second and third because it is the one figure on the page the
 * customer cannot work out from their own records — the carrier is holding
 * their money and this document is the only place that has ever said so.
 *
 * Not a bill, and it says so at the top. An accounts payable department that
 * processes a statement as a payable pays everything on it twice; the amounts
 * here are all already on invoices the customer holds.
 */

export interface StatementInput {
  issuedAt: Date;
  /** Movements are listed from here; balances are as at `issuedAt`. */
  periodFrom: Date;
  periodLabel: string;

  carrier: InvoiceParty;
  billTo: InvoiceParty;
  currency: string;

  totals: StatementTotals;
  openItems: OpenItem[];
  aged: Record<AgingBucket, number>;
  /** Oldest first, each with the balance it left behind. */
  activity: Array<{ entry: StatementEntry; balanceCents: number }>;

  brand?: DocumentBrand | null;
}

/** A label/value pair drawn in the right-hand half, panelled when emphasised. */
function summaryRow(
  doc: DocBuilder,
  label: string,
  value: string,
  options: { emphasis?: boolean; color?: typeof INK } = {},
): void {
  const x = MARGIN + CONTENT_WIDTH / 2;
  const width = CONTENT_WIDTH / 2;

  doc.ensure(18);
  const top = doc.y;

  if (options.emphasis) doc.fill({ x, y: top - 16, width, height: 16 }, PANEL);

  const font = options.emphasis ? doc.fonts.bold : doc.fonts.regular;
  const half = width / 2;

  doc.moveTo(top - 3);
  doc.text(label, { x: x + 6, width: half, size: 9, font, color: options.color ?? INK });

  doc.moveTo(top - 3);
  doc.text(value, {
    x: x + half - 6,
    width: half,
    size: 9,
    font,
    color: options.color ?? INK,
    align: 'right',
  });

  doc.moveTo(top - 18);
}

/** How late, in the words a collections call uses. */
function ageText(item: OpenItem): string {
  if (!item.dueAt) return 'No terms';
  if (item.daysLate <= 0) return `Due in ${Math.abs(item.daysLate)}d`;
  return `${item.daysLate}d late`;
}

export async function renderStatement(input: StatementInput): Promise<Uint8Array> {
  const doc = await DocBuilder.create({
    footerNote: `Statement of account · ${input.billTo.name}`,
    title: `Statement of account — ${input.billTo.name}`,
    issuedAt: input.issuedAt,
    brand: input.brand,
  });

  const currency = input.currency || 'USD';
  const money = (cents: number) => moneyText(cents, currency);
  const { totals } = input;

  /* --- Masthead --------------------------------------------------------- */

  await doc.letterhead();

  doc.text('STATEMENT OF ACCOUNT', { size: 15, font: doc.fonts.bold, color: doc.accentText });

  /*
   * Said before anything else. A statement processed as a payable pays every
   * invoice on it a second time, and the customer then spends a month
   * chasing the refund of money they should never have sent.
   */
  doc.text(
    'THIS IS NOT AN INVOICE. EVERY AMOUNT BELOW IS ALREADY ON AN INVOICE YOU HOLD.',
    { size: 8, font: doc.fonts.bold, color: MUTED },
  );

  doc.move(6);

  doc.columns(
    (column) => {
      doc.field('From', input.carrier.name, column);
      const address = input.brand?.remitToText?.trim() || addressBlock(input.carrier);
      if (address) doc.text(address, { ...column, size: 8, color: MUTED });
    },
    (column) => {
      doc.field('Statement date', dateText(input.issuedAt), column);
      doc.field('Activity from', dateText(input.periodFrom), column);
      doc.field('Period', input.periodLabel, column);
    },
  );

  doc.move(10);

  doc.columns(
    (column) => {
      doc.field('To', input.billTo.name, column);
      const address = addressBlock(input.billTo);
      if (address) doc.text(address, { ...column, size: 8, color: MUTED });
    },
    () => {},
  );

  doc.move(12);

  /* --- Where the account stands ----------------------------------------- */

  doc.heading('Account summary');

  summaryRow(doc, `Balance on ${dateText(input.periodFrom)}`, money(totals.openingDueCents));
  if (totals.invoicedCents !== 0) summaryRow(doc, 'Invoiced', money(totals.invoicedCents));
  if (totals.paidCents !== 0) summaryRow(doc, 'Payments received', `(${money(totals.paidCents)})`);
  if (totals.creditedCents !== 0) {
    summaryRow(doc, 'Credited', `(${money(totals.creditedCents)})`);
  }
  if (totals.appliedCents !== 0) {
    summaryRow(doc, 'Applied from your account', `(${money(totals.appliedCents)})`);
  }
  if (totals.refundedCents !== 0) summaryRow(doc, 'Refunded to you', money(totals.refundedCents));
  if (totals.keptCents !== 0) {
    summaryRow(doc, 'Moved to your account', money(totals.keptCents));
  }

  summaryRow(
    doc,
    totals.closingDueCents < 0 ? 'Owing to you' : 'Balance due',
    money(Math.abs(totals.closingDueCents)),
    { emphasis: true },
  );

  if (totals.closingHeldCents > 0) {
    summaryRow(doc, 'Less credit on account', `(${money(totals.closingHeldCents)})`);
    summaryRow(
      doc,
      'Payable after credit',
      money(Math.max(0, totals.closingDueCents - totals.closingHeldCents)),
      { emphasis: true },
    );
  }

  doc.move(14);

  /* --- What is still open ----------------------------------------------- */

  doc.heading('Invoices outstanding');

  if (input.openItems.length === 0) {
    doc.text('Nothing is outstanding. Thank you.', { size: 9, color: MUTED });
    doc.move(6);
  } else {
    doc.table(
      [
        { header: 'Invoice', weight: 2, mono: true },
        { header: 'Issued', weight: 2 },
        { header: 'Due', weight: 2 },
        { header: 'Age', weight: 2 },
        { header: 'Invoiced', weight: 2, align: 'right' },
        { header: 'Outstanding', weight: 2, align: 'right' },
      ],
      input.openItems.map((item) => [
        item.invoiceNumber,
        item.issuedAt ? dateText(item.issuedAt) : '—',
        item.dueAt ? dateText(item.dueAt) : '—',
        ageText(item),
        money(item.totalCents),
        money(item.balanceCents),
      ]),
    );

    doc.move(10);

    /* --- Aging strip ---------------------------------------------------- */

    const width = CONTENT_WIDTH / AGING_BUCKETS.length;
    doc.ensure(34);
    const { top } = doc.panel(34);

    AGING_BUCKETS.forEach((bucket, index) => {
      const x = MARGIN + width * index;
      const late = bucket !== 'current' && input.aged[bucket] > 0;

      doc.moveTo(top - 10);
      doc.text(AGING_LABEL[bucket].toUpperCase(), {
        x: x + 6,
        width: width - 12,
        size: 6,
        font: doc.fonts.bold,
        color: MUTED,
      });

      doc.moveTo(top - 20);
      doc.text(money(input.aged[bucket]), {
        x: x + 6,
        width: width - 12,
        size: 9,
        font: doc.fonts.bold,
        color: late ? WARNING : INK,
      });

      // A hairline-wide fill rather than a new primitive: the only vertical
      // rule in any document here, and not worth an API for.
      if (index > 0) {
        doc.fill({ x, y: top - 28, width: 0.6, height: 22 }, HAIRLINE);
      }
    });

    doc.moveTo(top - 34);
    doc.move(12);
  }

  /* --- The money we are holding ----------------------------------------- */

  const creditMovements = input.activity.filter(
    ({ entry }) => entry.kind === 'credit_kept' || entry.kind === 'credit_applied',
  );

  if (totals.closingHeldCents !== 0 || creditMovements.length > 0) {
    doc.heading('Credit on account');

    doc.text(
      totals.closingHeldCents > 0
        ? `We are holding ${money(totals.closingHeldCents)} of yours. It came from an overpayment ` +
            'you asked us to carry rather than refund. Tell us which invoice to put it against and ' +
            'it comes off that one; ask for it back at any time and we will send it.'
        : 'Nothing is being held on your account. The movements below are its history.',
      { size: 9, lineHeight: 13 },
    );

    doc.move(8);

    if (creditMovements.length > 0) {
      doc.table(
        [
          { header: 'Date', weight: 2 },
          { header: 'Invoice', weight: 2, mono: true },
          { header: 'Movement', weight: 4 },
          { header: 'Amount', weight: 2, align: 'right' },
        ],
        creditMovements.map(({ entry }) => [
          dateText(entry.at),
          entry.reference,
          entry.kind === 'credit_kept'
            ? 'Overpayment kept on your account'
            : 'Applied to this invoice',
          money(entry.heldCents),
        ]),
      );
      doc.move(12);
    }
  }

  /* --- How it got here --------------------------------------------------- */

  doc.heading(`Activity since ${dateText(input.periodFrom)}`);

  if (input.activity.length === 0) {
    doc.text('No movement on the account in this period.', { size: 9, color: MUTED });
  } else {
    doc.table(
      [
        { header: 'Date', weight: 2 },
        { header: 'Reference', weight: 2, mono: true },
        { header: 'Movement', weight: 4 },
        { header: 'Amount', weight: 2, align: 'right' },
        { header: 'Balance', weight: 2, align: 'right' },
      ],
      input.activity.map(({ entry, balanceCents }) => [
        dateText(entry.at),
        entry.reference,
        entry.detail ? `${ENTRY_LABEL[entry.kind]} — ${entry.detail}` : ENTRY_LABEL[entry.kind],
        money(entry.dueCents),
        money(balanceCents),
      ]),
    );
  }

  doc.move(12);

  doc.text(
    `Balances are as at ${dateText(input.issuedAt)}. Anything settled after that date is not ` +
      'reflected here — if a payment crossed with this statement, please disregard it and accept ' +
      'our thanks.',
    { size: 7, color: MUTED, lineHeight: 10 },
  );

  return doc.finish();
}
