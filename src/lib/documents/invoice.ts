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
import {
  basisText,
  extendedCents,
  sumAccessorials,
  type AccessorialLine,
} from '../branding/accessorial-math';
import { grossCents, type Charges } from '../invoices/compute';
import { termsDefinition } from '../invoices/terms';
import type { PaymentTerms } from '../db/schema';

/**
 * The invoice a carrier sends to get paid.
 *
 * Two things on this page decide whether it gets paid without a phone call.
 *
 * The first is the paperwork it points at. A broker's accounts department
 * holds an invoice it cannot tie to a signed delivery. Naming the bill of
 * lading and the delivery receipt, with the hash each was sealed under, means
 * the attachments can be checked against the record rather than trusted.
 *
 * The second is the Notice of Assignment. A factored invoice that does not
 * carry one gets paid to the carrier, and the factor then comes after the
 * carrier for money it has already advanced. It is printed in full, in a box,
 * because a factor will reject an invoice that buries it.
 */

export interface InvoiceParty {
  name: string;
  contactName?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  phone?: string | null;
  email?: string | null;
  usdotNumber?: string | null;
  mcNumber?: string | null;
}

export interface InvoiceVehicleLine {
  vin: string;
  description: string;
}

export interface InvoicePaymentLine {
  receivedAt: Date;
  method: string;
  reference: string | null;
  amountCents: number;
}

/** A document already issued for this load, cited so it can be verified. */
export interface AttachedDocument {
  kind: string;
  number: string;
  sha256: string;
}

export interface InvoiceInput {
  invoiceNumber: string;
  loadNumber: string;
  issuedAt: Date;
  dueAt: Date | null;
  terms: PaymentTerms | null;

  carrier: InvoiceParty;
  billTo: InvoiceParty;

  charges: Charges;
  /**
   * The itemised accessorials behind `charges.accessorialCents`.
   *
   * Empty on an invoice raised before the carrier had a catalogue, or on one
   * where the accessorial was typed as a single figure. Either way the total
   * is what governs: anything the lines do not account for still prints, as a
   * remainder, so the charges block always adds up to the figure claimed.
   */
  accessorials: AccessorialLine[];
  paidCents: number;
  currency: string;

  vehicles: InvoiceVehicleLine[];
  payments: InvoicePaymentLine[];
  attachments: AttachedDocument[];

  originLine?: string | null;
  destinationLine?: string | null;
  distanceMiles?: number | null;
  deliveredAt?: Date | null;

  factoringCompanyName?: string | null;
  factoringNoticeText?: string | null;
  notes?: string | null;
  purchaseOrderNumber?: string | null;

  /** The carrier's letterhead, colour, remittance block and standing notes. */
  brand?: DocumentBrand | null;
}

/**
 * The standard Notice of Assignment, used when the carrier has not supplied
 * the wording its factor requires. Factors issue their own text and it must be
 * reproduced exactly, so this is only a fallback that names the assignee and
 * states the redirection — the two things that make the notice operative.
 */
export function defaultFactoringNotice(factor: string): string {
  return (
    `NOTICE OF ASSIGNMENT — This invoice has been assigned to ${factor}. ` +
    'Payment of this invoice must be made payable and remitted directly to ' +
    `${factor} at the remittance address on file. Payment to any other party ` +
    'does not discharge this obligation. This notice remains in effect until ' +
    `revoked in writing by ${factor}.`
  );
}

export async function renderInvoice(input: InvoiceInput): Promise<Uint8Array> {
  const doc = await DocBuilder.create({
    footerNote: `${input.invoiceNumber} · ${input.carrier.name}`,
    title: `Invoice ${input.invoiceNumber}`,
    issuedAt: input.issuedAt,
    brand: input.brand,
  });

  const currency = input.currency || 'USD';
  const money = (cents: number) => moneyText(cents, currency);

  /* --- Masthead ------------------------------------------------------- */

  await doc.letterhead();

  doc.text('INVOICE', { size: 15, font: doc.fonts.bold, color: doc.accentText });
  doc.move(4);

  doc.columns(
    (column) => {
      doc.field('Remit to', input.carrier.name, column);

      /*
       * A remittance block set on the template replaces the office address,
       * because a lockbox is frequently not where the carrier sits and a
       * cheque sent to the wrong one takes a fortnight to come back. The name
       * and the authority numbers are not replaceable: they are what identify
       * the motor carrier claiming the money.
       */
      const address = input.brand?.remitToText?.trim() || addressBlock(input.carrier);
      if (address) doc.text(address, { ...column, size: 8, color: MUTED });

      const authority = [
        input.carrier.usdotNumber ? `USDOT ${input.carrier.usdotNumber}` : null,
        input.carrier.mcNumber ? input.carrier.mcNumber : null,
      ]
        .filter(Boolean)
        .join('  ');
      if (authority) doc.text(authority, { ...column, size: 8, color: MUTED });
    },
    (column) => {
      doc.field('Invoice no.', input.invoiceNumber, { ...column, mono: true });
      doc.field('Invoice date', dateText(input.issuedAt), column);
      doc.field(
        'Payment due',
        input.dueAt ? dateText(input.dueAt) : 'Per agreement',
        column,
      );

      const terms = termsDefinition(input.terms);
      doc.text(terms.label, { ...column, size: 8, color: MUTED });
      if (terms.note) doc.text(terms.note, { ...column, size: 7, color: MUTED });
    },
  );

  doc.move(10);

  /* --- Bill to and the load ------------------------------------------- */

  doc.columns(
    (column) => {
      doc.field('Bill to', input.billTo.name, column);
      const address = addressBlock(input.billTo);
      if (address) doc.text(address, { ...column, size: 8, color: MUTED });
      if (input.billTo.mcNumber) {
        doc.text(input.billTo.mcNumber, { ...column, size: 8, color: MUTED });
      }
    },
    (column) => {
      doc.field('Load', input.loadNumber, { ...column, mono: true });
      if (input.purchaseOrderNumber) {
        doc.field('Purchase order', input.purchaseOrderNumber, { ...column, mono: true });
      }
      if (input.deliveredAt) doc.field('Delivered', dateText(input.deliveredAt), column);
    },
  );

  doc.move(10);

  if (input.originLine || input.destinationLine) {
    doc.columns(
      (column) => doc.field('From', input.originLine ?? '—', column),
      (column) => doc.field('To', input.destinationLine ?? '—', column),
    );
    if (input.distanceMiles) {
      doc.text(`${input.distanceMiles.toLocaleString('en-US')} miles`, {
        size: 8,
        color: MUTED,
      });
    }
    doc.move(8);
  }

  /* --- What was moved -------------------------------------------------- */

  if (input.vehicles.length > 0) {
    doc.heading(`Vehicles transported (${input.vehicles.length})`);
    doc.table(
      [
        { header: 'VIN', weight: 2, mono: true },
        { header: 'Year / Make / Model', weight: 3 },
      ],
      input.vehicles.map((vehicle) => [vehicle.vin, vehicle.description]),
    );
    doc.move(10);
  }

  /* --- Charges --------------------------------------------------------- */

  doc.heading('Charges');

  const lines: Array<[string, number]> = [['Transportation — line haul', input.charges.lineHaulCents]];
  if (input.charges.fuelSurchargeCents !== 0) {
    // Its own line, always. Brokers audit it separately and a combined figure
    // invites a short payment while somebody works out the split.
    lines.push(['Fuel surcharge', input.charges.fuelSurchargeCents]);
  }
  /*
   * Itemised accessorials, each showing its own working. A broker's accounts
   * department disputes "Accessorials $262.50" and pays "Detention - 3.5 hrs
   * at $75.00", so the arithmetic goes on the face of the invoice rather than
   * in the email that follows the query.
   */
  for (const accessorial of input.accessorials) {
    const basis = basisText(accessorial);
    const heading = [
      accessorial.code ? `${accessorial.code} · ${accessorial.label}` : accessorial.label,
      basis,
    ]
      .filter(Boolean)
      .join(' — ');

    lines.push([
      accessorial.note ? `${heading}\n${accessorial.note}` : heading,
      extendedCents(accessorial),
    ]);
  }

  /*
   * Whatever the lines do not account for. Zero once an invoice is fully
   * itemised; the whole accessorial figure on one raised before the carrier
   * had a catalogue.
   */
  const unitemised = input.charges.accessorialCents - sumAccessorials(input.accessorials);
  if (unitemised !== 0) lines.push(['Accessorial charges', unitemised]);

  if (input.charges.taxCents !== 0) lines.push(['Tax', input.charges.taxCents]);

  doc.table(
    [
      { header: 'Description', weight: 4 },
      { header: 'Amount', weight: 1, align: 'right' },
    ],
    lines.map(([label, cents]) => [label, money(cents)]),
  );

  doc.move(4);

  const credits: Array<[string, number]> = [];
  if (input.charges.codCollectedCents !== 0) {
    credits.push(['Collected on delivery', input.charges.codCollectedCents]);
  }
  if (input.charges.depositCents !== 0) credits.push(['Deposit held', input.charges.depositCents]);

  const summary: Array<[string, string, boolean]> = [];
  if (credits.length > 0) {
    summary.push(['Subtotal', money(grossCents(input.charges)), false]);
    for (const [label, cents] of credits) summary.push([label, `(${money(cents)})`, false]);
  }

  const total =
    grossCents(input.charges) - input.charges.codCollectedCents - input.charges.depositCents;
  const balance = total - input.paidCents;

  summary.push(['Total invoiced', money(total), input.paidCents === 0]);
  if (input.paidCents !== 0) {
    summary.push(['Payments received', `(${money(input.paidCents)})`, false]);
    summary.push([balance > 0 ? 'Balance due' : 'Balance', money(balance), true]);
  }

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

  doc.move(10);

  /* --- Payments already recorded --------------------------------------- */

  if (input.payments.length > 0) {
    doc.heading('Payments received');
    doc.table(
      [
        { header: 'Date', weight: 2 },
        { header: 'Method', weight: 2 },
        { header: 'Reference', weight: 3, mono: true },
        { header: 'Amount', weight: 2, align: 'right' },
      ],
      input.payments.map((payment) => [
        dateText(payment.receivedAt),
        payment.method.replace(/_/g, ' '),
        payment.reference ?? '—',
        money(payment.amountCents),
      ]),
    );
    doc.move(10);
  }

  /* --- Notice of Assignment -------------------------------------------- */

  if (input.factoringCompanyName) {
    const notice =
      input.factoringNoticeText?.trim() || defaultFactoringNotice(input.factoringCompanyName);

    const lineCount = doc.wrap(notice, 8, CONTENT_WIDTH - 16, doc.fonts.bold).length;
    const height = lineCount * 11 + 16;

    doc.ensure(height + 8);
    doc.drawBox({ x: MARGIN, y: doc.y - height, width: CONTENT_WIDTH, height }, WARNING);
    doc.move(8);
    doc.text(notice, {
      x: MARGIN + 8,
      width: CONTENT_WIDTH - 16,
      size: 8,
      font: doc.fonts.bold,
      color: WARNING,
      lineHeight: 11,
    });
    doc.move(14);
  }

  /* --- Supporting documents -------------------------------------------- */

  if (input.attachments.length > 0) {
    doc.heading('Supporting documents');
    doc.text(
      'The documents below were sealed when they were issued. Each hash covers the exact file; ' +
        'a copy that hashes differently is not the document this invoice was raised against.',
      { size: 8, color: MUTED },
    );
    doc.move(4);
    doc.table(
      [
        { header: 'Document', weight: 2 },
        { header: 'Number', weight: 2, mono: true },
        { header: 'SHA-256', weight: 5, mono: true },
      ],
      input.attachments.map((attachment) => [
        attachment.kind,
        attachment.number,
        attachment.sha256,
      ]),
      { fontSize: 7 },
    );
    doc.move(10);
  }

  /* --- Notes ------------------------------------------------------------ */

  if (input.notes) {
    doc.heading('Notes');
    doc.text(input.notes, { size: 9 });
    doc.move(10);
  }

  doc.addendum(input.carrier.name);

  doc.text(
    balance > 0
      ? `Please remit ${money(balance)} to ${input.factoringCompanyName ?? input.carrier.name}. ` +
          `Reference invoice ${input.invoiceNumber} with payment.`
      : `This invoice is settled in full. No payment is due.`,
    { size: 8, color: MUTED },
  );

  return doc.finish();
}
