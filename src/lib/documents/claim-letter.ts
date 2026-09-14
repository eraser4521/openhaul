import { CONTENT_WIDTH, DocBuilder, MARGIN, MUTED, type DocumentBrand } from './layout';
import type { InvoiceParty } from './invoice';

/**
 * The three letters 49 CFR Part 370 obliges a carrier to send.
 *
 * They are short, and that is the point — each one exists to prove a date. The
 * acknowledgement proves the carrier responded inside 30 days; the status
 * letter proves it kept the claimant informed while the claim stayed open past
 * 120; the disposition proves what was decided and when, which is the date the
 * claimant's two-year window to sue starts running from.
 *
 * Each is frozen and hashed like every other document here, so what was sent
 * can be produced later rather than reconstructed from a template that has
 * since changed.
 */

export type ClaimLetterKind = 'acknowledgement' | 'status' | 'disposition';

export type Disposition = 'paid' | 'declined' | 'offered';

export interface ClaimLetterInput {
  kind: ClaimLetterKind;
  claimNumber: string;
  issuedAt: Date;

  carrier: InvoiceParty;
  claimantName: string;
  claimantEmail?: string | null;

  /** The date the written claim was received — the date every clock runs from. */
  receivedAt: Date;
  loadNumber?: string | null;
  vin?: string | null;
  deliveredAt?: Date | null;

  demandAmountCents?: number | null;

  /** Status letters only: why the claim is still open. */
  delayReason?: string | null;
  /** Disposition letters only. */
  disposition?: Disposition;
  dispositionAmountCents?: number | null;
  declineReason?: string | null;
  /** Set when the claim arrived after the nine-month window closed. */
  lateFiled?: boolean;

  /**
   * Logo and colour only.
   *
   * These letters say what Part 370 requires them to say and nothing else. A
   * carrier's standing terms have no business inside a claim disposition, so
   * the addendum is not printed here and the remittance block is not read.
   */
  brand?: DocumentBrand | null;
}

function moneyText(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  return `${sign}$${Math.floor(absolute / 100).toLocaleString('en-US')}.${String(absolute % 100).padStart(2, '0')}`;
}

function dateText(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

const TITLES: Record<ClaimLetterKind, string> = {
  acknowledgement: 'ACKNOWLEDGEMENT OF CLAIM',
  status: 'CLAIM STATUS UPDATE',
  disposition: 'DISPOSITION OF CLAIM',
};

export function claimLetterTitle(kind: ClaimLetterKind, claimNumber: string): string {
  const noun =
    kind === 'acknowledgement'
      ? 'Claim acknowledgement'
      : kind === 'status'
        ? 'Claim status letter'
        : 'Claim disposition';
  return `${noun} ${claimNumber}`;
}

function bodyFor(input: ClaimLetterInput): string[] {
  const subject = [
    input.loadNumber ? `load ${input.loadNumber}` : null,
    input.vin ? `VIN ${input.vin}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const shipment = subject ? ` concerning ${subject}` : '';

  if (input.kind === 'acknowledgement') {
    const paragraphs = [
      `We acknowledge receipt of your claim${shipment}, received on ${dateText(input.receivedAt)}. ` +
        `It has been assigned claim number ${input.claimNumber}. Please quote that number on any further correspondence.`,
      'This acknowledgement is given under 49 CFR 370.5, which requires a carrier to acknowledge a ' +
        'cargo claim in writing within thirty days of receiving it.',
      // "the date above" would be ambiguous: the letter carries both its own
      // date and the date of receipt, and the 120 days runs from receipt.
      'Your claim is now under investigation. Under 49 CFR 370.9 we will pay it, decline it, or ' +
        'make you a firm compromise settlement offer in writing within one hundred and twenty days ' +
        `of ${dateText(input.receivedAt)}, the date we received it. If the claim is still open at ` +
        'that point we will write to you with the status and the reason for the delay, and again ' +
        'every sixty days until it is resolved.',
    ];

    if (input.lateFiled && input.deliveredAt) {
      paragraphs.push(
        `Please note that this shipment was delivered on ${dateText(input.deliveredAt)}. The bill of ` +
          'lading requires a claim to be filed in writing within nine months of delivery. ' +
          'Acknowledging your claim is not a waiver of that requirement or of any other defence, ' +
          'all of which are expressly reserved.',
      );
    }

    return paragraphs;
  }

  if (input.kind === 'status') {
    return [
      `This letter concerns claim ${input.claimNumber}${shipment}, received on ${dateText(input.receivedAt)}.`,
      'Your claim remains under investigation and has not yet been resolved.',
      input.delayReason?.trim()
        ? `Reason for the delay: ${input.delayReason.trim()}`
        : 'Reason for the delay: the investigation is not yet complete.',
      'This letter is sent under 49 CFR 370.9, which requires us to advise you of the status of an ' +
        'unresolved claim and the reason for the delay at the end of each sixty-day period while it ' +
        'remains pending. We will write again within sixty days if it is still open.',
    ];
  }

  const opening = `This letter sets out our decision on claim ${input.claimNumber}${shipment}, received on ${dateText(input.receivedAt)}.`;

  if (input.disposition === 'paid') {
    return [
      opening,
      `Your claim is allowed in the amount of ${moneyText(input.dispositionAmountCents ?? 0)}. ` +
        'Payment will be issued to you at the address we hold on file.',
      'This disposition is made under 49 CFR 370.9.',
    ];
  }

  if (input.disposition === 'offered') {
    return [
      opening,
      `We are making a firm compromise settlement offer of ${moneyText(input.dispositionAmountCents ?? 0)} ` +
        `in full and final settlement of this claim${
          input.demandAmountCents ? `, which was presented in the amount of ${moneyText(input.demandAmountCents)}` : ''
        }.`,
      input.declineReason?.trim()
        ? `Basis for the offer: ${input.declineReason.trim()}`
        : 'This offer is made on the basis of our investigation of the shipment record.',
      'This is a firm compromise settlement offer within the meaning of 49 CFR 370.9. It remains ' +
        'open for thirty days from the date of this letter.',
    ];
  }

  return [
    opening,
    'Your claim is declined.',
    input.declineReason?.trim()
      ? `Reason: ${input.declineReason.trim()}`
      : 'Reason: our investigation does not support carrier liability for the loss claimed.',
    /*
     * Naming the two-year window is not a courtesy. Carmack runs it from the
     * date the carrier gives written notice of disallowance, so this letter is
     * the thing that starts it — and a declination that never says so invites
     * an argument later about when, or whether, it was given.
     */
    'This is written notice that your claim is disallowed, given under 49 CFR 370.9. Under 49 ' +
      'U.S.C. 14706 any civil action on this claim must be commenced within two years of the date ' +
      'of this letter.',
  ];
}

export async function renderClaimLetter(input: ClaimLetterInput): Promise<Uint8Array> {
  const doc = await DocBuilder.create({
    footerNote: `${input.claimNumber} · ${input.carrier.name}`,
    title: claimLetterTitle(input.kind, input.claimNumber),
    issuedAt: input.issuedAt,
    brand: input.brand,
  });

  /* --- Letterhead ------------------------------------------------------ */

  // The name and address below are the letter's own, so the template
  // contributes the logo and stops there.
  await doc.letterhead({ text: false, rule: false });

  doc.text(input.carrier.name, { size: 12, font: doc.fonts.bold, color: doc.accentText });

  const address = [
    input.carrier.addressLine1,
    [input.carrier.city, input.carrier.state, input.carrier.postalCode].filter(Boolean).join(' '),
    input.carrier.phone,
    input.carrier.email,
  ]
    .filter(Boolean)
    .join('\n');
  if (address) doc.text(address, { size: 8, color: MUTED });

  const authority = [
    input.carrier.usdotNumber ? `USDOT ${input.carrier.usdotNumber}` : null,
    input.carrier.mcNumber,
  ]
    .filter(Boolean)
    .join('  ');
  if (authority) doc.text(authority, { size: 8, color: MUTED });

  doc.move(10);
  doc.rule(doc.accent, 1);
  doc.move(12);

  /* --- Date and addressee ---------------------------------------------- */

  doc.text(dateText(input.issuedAt), { size: 9 });
  doc.move(10);

  doc.text(input.claimantName, { size: 9, font: doc.fonts.bold });
  if (input.claimantEmail) doc.text(input.claimantEmail, { size: 8, color: MUTED });
  doc.move(14);

  /* --- Subject --------------------------------------------------------- */

  doc.text(TITLES[input.kind], { size: 11, font: doc.fonts.bold });
  doc.move(4);

  doc.columns(
    (column) => doc.field('Claim no.', input.claimNumber, { ...column, mono: true }),
    (column) => doc.field('Claim received', dateText(input.receivedAt), column),
  );

  if (input.loadNumber || input.vin) {
    doc.columns(
      (column) => doc.field('Load', input.loadNumber ?? '—', { ...column, mono: true }),
      (column) => doc.field('VIN', input.vin ?? '—', { ...column, mono: true }),
    );
  }

  if (input.demandAmountCents) {
    doc.field('Amount claimed', moneyText(input.demandAmountCents));
  }

  doc.move(12);
  doc.rule();
  doc.move(12);

  /* --- Body ------------------------------------------------------------- */

  for (const paragraph of bodyFor(input)) {
    doc.text(paragraph, { size: 9, lineHeight: 13 });
    doc.move(9);
  }

  doc.move(10);
  doc.text('Sincerely,', { size: 9 });
  doc.move(24);
  doc.text(input.carrier.name, { size: 9, font: doc.fonts.bold });
  doc.text('Claims', { size: 8, color: MUTED });

  doc.move(16);
  doc.text(
    'This letter is part of the claim file for the shipment named above and is retained with it.',
    { size: 7, color: MUTED, width: CONTENT_WIDTH, x: MARGIN },
  );

  return doc.finish();
}
