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
import {
  ESCROW_RETURN_DAYS,
  LEASED_PAYMENT_DAYS,
  LINE_LABEL,
  signedCents,
  totalsFrom,
} from '../settlements/compute';
import type { DriverEmploymentType, SettlementLineKind } from '../db/schema';

/**
 * The settlement statement a driver is handed.
 *
 * For a leased owner-operator this document is not a courtesy. 49 CFR 376.12
 * requires the carrier to show the rated revenue a percentage was computed
 * from (d), to identify every item charged back and let the driver examine the
 * documents behind it (g), to account for the escrow fund (h), and to pay
 * within fifteen days of the delivery paperwork (f). A statement showing only
 * totals meets none of those, so every line stands on its own with the
 * arithmetic that produced it.
 *
 * A company driver gets the same breakdown without the lease disclosures,
 * because Part 376 governs a lease and there is no lease.
 */

export interface SettlementLineOut {
  kind: SettlementLineKind;
  description: string;
  amountCents: number;
  basisNote: string | null;
  loadNumber: string | null;
}

export interface SettlementInput {
  settlementNumber: string;
  issuedAt: Date;
  periodStart: Date;
  periodEnd: Date;
  paymentDueBy: Date | null;

  carrier: InvoiceParty;
  driverName: string;
  employmentType: DriverEmploymentType;
  payBasis: string;

  lines: SettlementLineOut[];

  /** The carrier's letterhead, colour and standing notes. */
  brand?: DocumentBrand | null;

  /** Running balance across every settlement, not just this one. */
  escrowBalanceCents: number;
  notes?: string | null;
}

function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  return `${sign}$${Math.floor(absolute / 100).toLocaleString('en-US')}.${String(absolute % 100).padStart(2, '0')}`;
}

function dateText(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** The order lines read best in, regardless of the order they were added. */
const KIND_ORDER: SettlementLineKind[] = [
  'load_pay',
  'bonus',
  'reimbursement',
  'deduction',
  'advance',
  'escrow_deposit',
  'escrow_return',
];

export async function renderSettlement(input: SettlementInput): Promise<Uint8Array> {
  const doc = await DocBuilder.create({
    footerNote: `${input.settlementNumber} · ${input.driverName}`,
    title: `Settlement ${input.settlementNumber}`,
    issuedAt: input.issuedAt,
    brand: input.brand,
  });

  const leased = input.employmentType === 'owner_operator';
  const totals = totalsFrom(input.lines);

  /* --- Masthead ------------------------------------------------------- */

  await doc.letterhead();

  doc.text('SETTLEMENT STATEMENT', { size: 15, font: doc.fonts.bold, color: doc.accentText });
  doc.move(4);

  doc.columns(
    (column) => {
      doc.field('From', input.carrier.name, column);
      const address = [
        input.carrier.addressLine1,
        [input.carrier.city, input.carrier.state, input.carrier.postalCode]
          .filter(Boolean)
          .join(' '),
        input.carrier.phone,
      ]
        .filter(Boolean)
        .join('\n');
      if (address) doc.text(address, { ...column, size: 8, color: MUTED });
    },
    (column) => {
      doc.field('Statement no.', input.settlementNumber, { ...column, mono: true });
      doc.field(
        'Pay period',
        `${dateText(input.periodStart)} — ${dateText(input.periodEnd)}`,
        column,
      );
      if (input.paymentDueBy) {
        doc.field('Payment due by', dateText(input.paymentDueBy), column);
      }
    },
  );

  doc.move(10);

  doc.columns(
    (column) => {
      doc.field('Driver', input.driverName, column);
      doc.text(leased ? 'Leased owner-operator' : 'Company driver', {
        ...column,
        size: 8,
        color: MUTED,
      });
    },
    (column) => doc.field('Pay basis', input.payBasis, column),
  );

  doc.move(12);

  /* --- The lines -------------------------------------------------------- */

  const ordered = [...input.lines].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );

  for (const kind of KIND_ORDER) {
    const group = ordered.filter((line) => line.kind === kind);
    if (group.length === 0) continue;

    doc.heading(LINE_LABEL[kind]);

    doc.table(
      [
        { header: 'Load', weight: 1, mono: true },
        { header: 'Description', weight: 3 },
        { header: 'How it was worked out', weight: 3 },
        { header: 'Amount', weight: 1, align: 'right' },
      ],
      group.map((line) => [
        line.loadNumber ?? '—',
        line.description,
        line.basisNote ?? '—',
        money(signedCents(line)),
      ]),
    );

    doc.move(8);
  }

  /* --- Totals ----------------------------------------------------------- */

  const summary: Array<[string, number, boolean]> = [
    ['Earnings', totals.earningsCents, false],
  ];
  if (totals.reimbursementsCents !== 0) {
    summary.push(['Reimbursements', totals.reimbursementsCents, false]);
  }
  if (totals.deductionsCents !== 0) summary.push(['Deductions', -totals.deductionsCents, false]);
  if (totals.advancesCents !== 0) summary.push(['Advances recovered', -totals.advancesCents, false]);
  if (totals.escrowHeldCents !== 0) summary.push(['Escrow held', -totals.escrowHeldCents, false]);
  if (totals.escrowReturnedCents !== 0) {
    summary.push(['Escrow returned', totals.escrowReturnedCents, false]);
  }
  summary.push(['Net pay', totals.netPayCents, true]);

  const summaryX = MARGIN + CONTENT_WIDTH / 2;
  const summaryWidth = CONTENT_WIDTH / 2;

  for (const [label, cents, emphasis] of summary) {
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
    doc.text(money(cents), {
      x: summaryX + half - 6,
      width: half,
      size: 9,
      font,
      color: INK,
      align: 'right',
    });

    doc.moveTo(top - 18);
  }

  doc.move(12);

  /* --- Escrow ----------------------------------------------------------- */

  if (leased || input.escrowBalanceCents !== 0) {
    doc.heading('Escrow fund');
    doc.field('Balance held after this settlement', money(input.escrowBalanceCents));

    if (leased) {
      doc.move(2);
      doc.text(
        'This is the running balance of the escrow fund across every settlement, not only this ' +
          'one. Under 49 CFR 376.12(h) you may demand an accounting of this fund at any time, ' +
          `and it is returned to you within ${ESCROW_RETURN_DAYS} days of the lease ending, less ` +
          'only the items the lease permits to be deducted from it.',
        { size: 8, color: MUTED, lineHeight: 11 },
      );
    }
    doc.move(10);
  }

  /* --- Lease disclosures ------------------------------------------------- */

  if (leased) {
    doc.heading('Your rights under the lease');
    doc.text(
      [
        `1. Payment is due within ${LEASED_PAYMENT_DAYS} days of you submitting the documents needed to bill these loads (49 CFR 376.12(f)).`,
        '2. Where your pay is a percentage of revenue, the rated revenue each percentage was taken from is shown against the line (49 CFR 376.12(d)).',
        '3. Every item deducted from your pay is listed above by name and amount. You may examine the documents behind any of them, on request and during normal business hours (49 CFR 376.12(g)).',
        '4. If anything on this statement is wrong, say so before it is paid. A correction after payment is made on the next settlement and both remain on the record.',
      ].join('\n'),
      { size: 8, lineHeight: 12 },
    );
    doc.move(10);
  }

  if (input.notes) {
    doc.heading('Notes');
    doc.text(input.notes, { size: 9 });
    doc.move(8);
  }

  /*
   * After the lease disclosures, never among them. Those four numbered
   * paragraphs are what 49 CFR 376.12 requires the carrier to say, and a
   * carrier's own standing notes printed inside that list would read as
   * carrying the same weight.
   */
  doc.addendum(input.carrier.name);

  doc.text(
    `Statement produced ${dateText(input.issuedAt)}. Keep it with your records.`,
    { size: 7, color: MUTED },
  );

  return doc.finish();
}
