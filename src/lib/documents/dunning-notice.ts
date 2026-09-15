import {
  CONTENT_WIDTH,
  DocBuilder,
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
import { describeLateness } from '../invoices/dunning';

/**
 * A notice about an unpaid invoice.
 *
 * The carrier writes the sentence and this supplies the figures. There is no
 * template language on purpose: a reminder that arrives saying "Invoice
 * {{number}}" is worse than one that was never sent, and the facts belong in
 * their own panel where an edit to the prose cannot break them.
 *
 * What it deliberately does not do is threaten. The default wording names no
 * consequence, and if a carrier writes one in it is theirs — the document
 * will not invent a step nobody has decided to take. A threat not followed
 * through costs more than the debt, because the next one is ignored.
 */

export interface DunningNoticeInput {
  stageLabel: string;
  /** 1 of 3, so the reader can see where this sits. */
  stageSequence: number;
  stageCount: number;
  issuedAt: Date;

  carrier: InvoiceParty;
  billTo: InvoiceParty;

  /** The carrier's own words for this rung. */
  message: string;

  invoiceNumber: string;
  invoiceIssuedAt: Date | null;
  dueAt: Date | null;
  daysPastDue: number;
  loadNumber?: string | null;

  totalCents: number;
  paidCents: number;
  creditedCents: number;
  balanceCents: number;
  currency: string;

  /** What the carrier is holding for them, when it is not enough to cover it. */
  creditOnAccountCents?: number;

  brand?: DocumentBrand | null;
}

export async function renderDunningNotice(input: DunningNoticeInput): Promise<Uint8Array> {
  const doc = await DocBuilder.create({
    footerNote: `${input.stageLabel} · invoice ${input.invoiceNumber}`,
    title: `${input.stageLabel} — invoice ${input.invoiceNumber}`,
    issuedAt: input.issuedAt,
    brand: input.brand,
  });

  const currency = input.currency || 'USD';
  const money = (cents: number) => moneyText(cents, currency);

  /* --- Masthead --------------------------------------------------------- */

  await doc.letterhead();

  doc.text(input.stageLabel.toUpperCase(), {
    size: 15,
    font: doc.fonts.bold,
    color: doc.accentText,
  });

  doc.text(
    `Notice ${input.stageSequence} of ${input.stageCount} about invoice ${input.invoiceNumber}`,
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
      doc.field('Date', dateText(input.issuedAt), column);
      doc.field('Invoice', input.invoiceNumber, { ...column, mono: true });
      if (input.loadNumber) doc.field('Load', input.loadNumber, { ...column, mono: true });
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

  doc.move(14);

  /* --- What the carrier wanted to say ----------------------------------- */

  doc.text(input.message.trim(), { size: 9.5, lineHeight: 14 });

  doc.move(14);

  /* --- The facts, in their own panel ------------------------------------ */

  doc.heading('The invoice');

  const rows: Array<[string, string, boolean]> = [
    ['Invoiced', money(input.totalCents), false],
  ];
  if (input.paidCents !== 0) rows.push(['Paid', `(${money(input.paidCents)})`, false]);
  if (input.creditedCents !== 0) {
    rows.push(['Credited', `(${money(input.creditedCents)})`, false]);
  }
  rows.push(['Outstanding', money(input.balanceCents), true]);

  const x = MARGIN + CONTENT_WIDTH / 2;
  const width = CONTENT_WIDTH / 2;

  // Dates on the left, money on the right, both starting from the same line.
  const top = doc.y;

  doc.field('Issued', input.invoiceIssuedAt ? dateText(input.invoiceIssuedAt) : '—', {
    x: MARGIN,
    width,
  });
  doc.field('Due', input.dueAt ? dateText(input.dueAt) : '—', { x: MARGIN, width });
  doc.field('Now', describeLateness(input.daysPastDue), { x: MARGIN, width });

  const leftEnd = doc.y;
  doc.moveTo(top);

  for (const [label, value, emphasis] of rows) {
    doc.ensure(18);
    const rowTop = doc.y;

    if (emphasis) doc.fill({ x, y: rowTop - 16, width, height: 16 }, PANEL);

    const font = emphasis ? doc.fonts.bold : doc.fonts.regular;
    const half = width / 2;

    doc.moveTo(rowTop - 3);
    doc.text(label, { x: x + 6, width: half, size: 9, font, color: INK });

    doc.moveTo(rowTop - 3);
    doc.text(value, {
      x: x + half - 6,
      width: half,
      size: 9,
      font,
      color: emphasis && input.daysPastDue > 30 ? WARNING : INK,
      align: 'right',
    });

    doc.moveTo(rowTop - 18);
  }

  doc.moveTo(Math.min(leftEnd, doc.y));
  doc.move(14);

  /*
   * Said on the face when it is true. A customer who has money sitting with
   * the carrier and is being chased for a larger sum should be told both
   * figures in the same letter, not find out afterwards.
   */
  if (input.creditOnAccountCents && input.creditOnAccountCents > 0) {
    doc.text(
      `We are holding ${money(input.creditOnAccountCents)} of yours on account. Tell us to put ` +
        'it against this invoice and it comes off the figure above.',
      { size: 9, lineHeight: 13 },
    );
    doc.move(10);
  }

  doc.text(
    'If this has crossed with your payment, please accept our thanks and ignore it. If any part ' +
      'of the invoice is wrong, tell us which line and we will look at it.',
    { size: 8, color: MUTED, lineHeight: 11 },
  );

  return doc.finish();
}
