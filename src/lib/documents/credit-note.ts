import {
  CONTENT_WIDTH,
  DocBuilder,
  INK,
  MARGIN,
  MUTED,
  PANEL,
  type DocumentBrand,
} from './layout';
import type { InvoiceParty } from './invoice';
import type { CreditReason } from '../db/schema';
import { CREDIT_REASON_LABEL } from '../invoices/display';

/**
 * The credit note a customer is sent.
 *
 * Its whole job is to be unmistakably a *reduction of a named invoice* rather
 * than a second bill. Accounts payable departments process by document type,
 * and a credit that reads like an invoice gets paid instead of applied — so
 * the word CREDIT sits at the top, the amount is labelled as credited rather
 * than due, and the invoice it belongs to is on the face with the balance that
 * results from it.
 */

export interface CreditNoteInput {
  creditNumber: string;
  issuedAt: Date;

  carrier: InvoiceParty;
  billTo: InvoiceParty;

  invoiceNumber: string;
  invoiceIssuedAt: Date | null;
  invoiceTotalCents: number;
  loadNumber?: string | null;

  reason: CreditReason;
  detail: string;
  amountCents: number;
  currency: string;

  /** Every live credit against the invoice, this one included. */
  totalCreditedCents: number;
  paidCents: number;

  /** The cargo claim this settles, when it came off the freight bill. */
  claimNumber?: string | null;

  /**
   * Letterhead and remittance only.
   *
   * No addendum: a credit note corrects an invoice that already carried the
   * carrier's terms, and restating them on the correction invites an argument
   * about which document they attach to.
   */
  brand?: DocumentBrand | null;
}

function moneyText(cents: number, currency = 'USD'): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  const body = `${Math.floor(absolute / 100).toLocaleString('en-US')}.${String(absolute % 100).padStart(2, '0')}`;
  return currency === 'USD' ? `${sign}$${body}` : `${sign}${body} ${currency}`;
}

function dateText(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function addressBlock(party: InvoiceParty): string {
  return [
    party.contactName,
    party.addressLine1,
    [party.city, party.state, party.postalCode].filter(Boolean).join(' ').trim() || null,
    party.phone,
    party.email,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function renderCreditNote(input: CreditNoteInput): Promise<Uint8Array> {
  const doc = await DocBuilder.create({
    footerNote: `${input.creditNumber} · credit against ${input.invoiceNumber}`,
    title: `Credit note ${input.creditNumber}`,
    issuedAt: input.issuedAt,
    brand: input.brand,
  });

  const currency = input.currency || 'USD';
  const money = (cents: number) => moneyText(cents, currency);

  const balance = input.invoiceTotalCents - input.paidCents - input.totalCreditedCents;

  /* --- Masthead ------------------------------------------------------- */

  await doc.letterhead();

  doc.text('CREDIT NOTE', { size: 15, font: doc.fonts.bold, color: doc.accentText });

  /*
   * Said plainly and immediately. A credit note mistaken for an invoice gets
   * paid rather than applied, and the customer then chases a payment nobody
   * owed — which is a worse outcome than the dispute that produced the credit.
   */
  doc.text('THIS IS NOT A BILL. NO PAYMENT IS DUE ON THIS DOCUMENT.', {
    size: 8,
    font: doc.fonts.bold,
    color: MUTED,
  });

  doc.move(6);

  doc.columns(
    (column) => {
      doc.field('From', input.carrier.name, column);
      const address = input.brand?.remitToText?.trim() || addressBlock(input.carrier);
      if (address) doc.text(address, { ...column, size: 8, color: MUTED });
    },
    (column) => {
      doc.field('Credit note no.', input.creditNumber, { ...column, mono: true });
      doc.field('Date', dateText(input.issuedAt), column);
      doc.field('Credits invoice', input.invoiceNumber, { ...column, mono: true });
    },
  );

  doc.move(10);

  doc.columns(
    (column) => {
      doc.field('To', input.billTo.name, column);
      const address = addressBlock(input.billTo);
      if (address) doc.text(address, { ...column, size: 8, color: MUTED });
    },
    (column) => {
      if (input.loadNumber) doc.field('Load', input.loadNumber, { ...column, mono: true });
      if (input.invoiceIssuedAt) {
        doc.field('Invoice dated', dateText(input.invoiceIssuedAt), column);
      }
      if (input.claimNumber) {
        doc.field('Settles claim', input.claimNumber, { ...column, mono: true });
      }
    },
  );

  doc.move(12);

  /* --- What is being credited ------------------------------------------- */

  doc.heading('Credit');

  doc.table(
    [
      { header: 'Reason', weight: 2 },
      { header: 'Detail', weight: 4 },
      { header: 'Amount credited', weight: 2, align: 'right' },
    ],
    [[CREDIT_REASON_LABEL[input.reason], input.detail, money(input.amountCents)]],
  );

  doc.move(10);

  /* --- Where it leaves the invoice --------------------------------------- */

  const summary: Array<[string, string, boolean]> = [
    [`Invoice ${input.invoiceNumber}`, money(input.invoiceTotalCents), false],
  ];
  if (input.paidCents !== 0) {
    summary.push(['Already paid', `(${money(input.paidCents)})`, false]);
  }
  summary.push(['Credited to date', `(${money(input.totalCreditedCents)})`, false]);
  summary.push([
    balance < 0 ? 'Refund due to you' : 'Balance now due',
    money(Math.abs(balance)),
    true,
  ]);

  const summaryX = MARGIN + CONTENT_WIDTH / 2;
  const summaryWidth = CONTENT_WIDTH / 2;

  for (const [label, value, emphasis] of summary) {
    doc.ensure(18);
    const top = doc.y;

    if (emphasis) {
      doc.fill({ x: summaryX, y: top - 16, width: summaryWidth, height: 16 }, PANEL);
    }

    const font = emphasis ? doc.fonts.bold : doc.fonts.regular;
    const half = summaryWidth / 2;

    doc.moveTo(top - 3);
    doc.text(label, { x: summaryX + 6, width: half, size: 9, font, color: INK });

    doc.moveTo(top - 3);
    doc.text(value, {
      x: summaryX + half - 6,
      width: half,
      size: 9,
      font,
      color: INK,
      align: 'right',
    });

    doc.moveTo(top - 18);
  }

  doc.move(14);

  /* --- What to do with it ------------------------------------------------ */

  doc.text(
    balance < 0
      ? `This credit leaves ${money(Math.abs(balance))} owing to you. Tell us how you would like it ` +
          'settled: applied against your next invoice, or refunded.'
      : balance === 0
        ? `Invoice ${input.invoiceNumber} is now settled in full. No payment is due.`
        : `Apply this credit against invoice ${input.invoiceNumber}. The balance now due on that ` +
          `invoice is ${money(balance)}.`,
    { size: 9, lineHeight: 13 },
  );

  doc.move(10);
  doc.text(
    `Invoice ${input.invoiceNumber} is unchanged and still states ${money(input.invoiceTotalCents)}. ` +
      'This note reduces what is owed against it; it does not replace it.',
    { size: 7, color: MUTED },
  );

  return doc.finish();
}
