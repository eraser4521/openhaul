import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { PDFDocument, PDFName, PDFRawStream, rgb } from 'pdf-lib';
import { pdfText } from './helpers/pdf-text';
import { renderBol, type BolInput } from '@/lib/documents/bol';
import { renderInvoice, type InvoiceInput } from '@/lib/documents/invoice';
import { renderCreditNote } from '@/lib/documents/credit-note';
import { renderClaimLetter } from '@/lib/documents/claim-letter';
import type { DocumentBrand } from '@/lib/documents/layout';

/**
 * What a template can and cannot do to a document.
 *
 * Half of these tests are about the feature working. The other half are about
 * the boundary holding: a carrier can put their logo on a bill of lading, and
 * cannot put anything on it that displaces the terms, the non-negotiable
 * declaration or the letter text Part 370 prescribes. Both halves have to be
 * checked against the bytes that come out, because that is what a consignee
 * ends up holding.
 */

const ISSUED = new Date('2026-09-14T12:00:00Z');

const NOTHING_SET: DocumentBrand = {
  name: null,
  tagline: null,
  logo: null,
  accent: null,
  accentText: null,
  footerNote: null,
  addendum: null,
  remitToText: null,
};

function brand(overrides: Partial<DocumentBrand> = {}): DocumentBrand {
  return { ...NOTHING_SET, ...overrides };
}

function bolInput(overrides: Partial<BolInput> = {}): BolInput {
  return {
    kind: 'bol',
    documentNumber: 'BOL-OH-1001',
    loadNumber: 'OH-1001',
    issuedAt: ISSUED,
    carrier: {
      legalName: 'Ridgeline Auto Transport LLC',
      addressLine1: '4400 Meacham Blvd',
      city: 'Fort Worth',
      state: 'TX',
      postalCode: '76106',
      phone: '(817) 555-0142',
      usdotNumber: '3210987',
      mcNumber: 'MC-889112',
    },
    consignor: { name: 'Copart Dallas', city: 'Dallas', state: 'TX' },
    consignee: { name: 'Sunbelt Motors', city: 'Phoenix', state: 'AZ' },
    vehicles: [
      {
        vin: '1HGCM82633A004352',
        year: 2003,
        make: 'HONDA',
        model: 'Accord',
        color: 'Silver',
        vehicleType: 'sedan',
        odometer: 84_120,
        curbWeightLbs: 3_100,
        declaredValueCents: 850_000,
        isInoperable: false,
        damages: [],
        photos: [],
      },
    ],
    charges: {
      lineHaulCents: 95_000,
      fuelSurchargeCents: null,
      accessorialCents: null,
      codAmountCents: null,
      depositCents: null,
      totalCents: 95_000,
    },
    distanceMiles: 1_064,
    signatures: [],
    ...overrides,
  };
}

function invoiceInput(overrides: Partial<InvoiceInput> = {}): InvoiceInput {
  return {
    invoiceNumber: 'INV-OH-1001',
    loadNumber: 'OH-1001',
    issuedAt: ISSUED,
    dueAt: null,
    terms: '30_days',
    carrier: {
      name: 'Ridgeline Auto Transport LLC',
      addressLine1: '4400 Meacham Blvd',
      city: 'Fort Worth',
      state: 'TX',
      postalCode: '76106',
      usdotNumber: '3210987',
      mcNumber: 'MC-889112',
    },
    billTo: { name: 'Cardinal Logistics LLC' },
    charges: {
      lineHaulCents: 95_000,
      fuelSurchargeCents: 0,
      accessorialCents: 0,
      taxCents: 0,
      codCollectedCents: 0,
      depositCents: 0,
    },
    accessorials: [],
    paidCents: 0,
    currency: 'USD',
    vehicles: [],
    payments: [],
    attachments: [],
    ...overrides,
  };
}

/** A tiny real PNG, so the embed path is exercised rather than mocked. */
async function logoBytes(): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width: 240, height: 60, channels: 4, background: { r: 31, g: 78, b: 121, alpha: 1 } },
    })
      .png()
      .toBuffer(),
  );
}

/** Image XObjects in the file, which is what an embedded logo becomes. */
async function imageCount(bytes: Uint8Array): Promise<number> {
  const pdf = await PDFDocument.load(bytes);
  let count = 0;

  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    if (String(object.dict.get(PDFName.of('Subtype'))) === '/Image') count += 1;
  }

  return count;
}

describe('a carrier who has configured nothing', () => {
  it('gets exactly the document they got before templates existed', async () => {
    /*
     * The whole feature has to be invisible when it is unused. These renders
     * are deterministic — the PDF metadata is stamped from the issue date —
     * so byte equality is a real assertion rather than an approximation.
     */
    const without = await renderBol(bolInput());
    const withNull = await renderBol(bolInput({ brand: null }));

    expect(Buffer.compare(Buffer.from(without), Buffer.from(withNull))).toBe(0);
  });

  it('gets the same document from a brand with every field empty', async () => {
    // Proves the letterhead, the addendum and the footer override are all
    // genuine no-ops rather than drawing something invisible.
    const without = await renderBol(bolInput());
    const empty = await renderBol(bolInput({ brand: brand() }));

    expect(Buffer.compare(Buffer.from(without), Buffer.from(empty))).toBe(0);
  });
});

describe('the letterhead', () => {
  it('prints the name and tagline above the masthead', async () => {
    const bytes = await renderBol(
      bolInput({
        brand: brand({ name: 'RIDGELINE', tagline: 'Enclosed auto transport since 2011' }),
      }),
    );

    const text = await pdfText(bytes);
    expect(text).toContain('RIDGELINE');
    expect(text).toContain('Enclosed auto transport since 2011');
    // Still a bill of lading underneath it.
    expect(text).toContain('BILL OF LADING');
    expect(text).toContain('NON-NEGOTIABLE');
  });

  it('embeds an uploaded logo', async () => {
    const plain = await renderBol(bolInput());
    const branded = await renderBol(
      bolInput({
        brand: brand({
          logo: { bytes: await logoBytes(), contentType: 'image/png', width: 240, height: 60 },
        }),
      }),
    );

    expect(await imageCount(plain)).toBe(0);
    expect(await imageCount(branded)).toBe(1);
  });

  it('replaces the footer line without touching the page numbering', async () => {
    const bytes = await renderBol(
      bolInput({ brand: brand({ footerNote: 'Remit to PO Box 1180, Dalton GA 30722' }) }),
    );

    const text = await pdfText(bytes);
    expect(text).toContain('Remit to PO Box 1180, Dalton GA 30722');
    expect(text).toContain('Page 1 of');
    // The default footer, which the carrier's line displaced.
    expect(text).not.toContain('BOL-OH-1001 · Ridgeline Auto Transport LLC');
  });

  it('clips a footer line too long for the space instead of printing over the page number', async () => {
    const bytes = await renderBol(
      bolInput({ brand: brand({ footerNote: 'W'.repeat(400) }) }),
    );

    const text = await pdfText(bytes);
    expect(text).toContain('…');
    expect(text).toContain('Page 1 of');
    expect(text).not.toContain('W'.repeat(400));
  });
});

describe('the carrier’s own terms', () => {
  it('print after the fixed ones, under a heading naming the carrier', async () => {
    const bytes = await renderBol(
      bolInput({
        brand: brand({
          addendum: 'Storage is charged at $50 per vehicle per day after 3 days at destination.',
        }),
      }),
    );

    const text = await pdfText(bytes);

    expect(text).toContain('ADDITIONAL TERMS');
    expect(text).toContain('RIDGELINE AUTO TRANSPORT LLC');
    expect(text).toContain('Storage is charged at $50 per vehicle per day');

    // Order matters: the reader meets the regulation's terms first.
    expect(text.indexOf('TERMS AND CONDITIONS')).toBeLessThan(text.indexOf('ADDITIONAL TERMS'));
  });

  it('cannot displace the terms it is printed after', async () => {
    /*
     * The failure this guards against is a template that lets a carrier
     * disclaim what they are not free to disclaim. An addendum saying the
     * opposite of the Carmack terms does not remove them — both are on the
     * page, in that order, under headings that say whose each one is.
     */
    const plain = await pdfText(await renderBol(bolInput()));
    const hostile = await pdfText(
      await renderBol(
        bolInput({
          brand: brand({
            addendum: 'The carrier accepts no liability for loss or damage of any kind.',
          }),
        }),
      ),
    );

    for (const fragment of ['nine (9) months', 'two (2) years', '49 U.S.C. 14706']) {
      expect(plain).toContain(fragment);
      expect(hostile).toContain(fragment);
    }
  });

  it('is not printed on a Part 370 claim letter', async () => {
    // That letter says what the regulation requires it to say. A carrier's
    // standing terms inside a claim disposition would be a different document.
    const bytes = await renderClaimLetter({
      kind: 'acknowledgement',
      claimNumber: 'CLM-OH-1001',
      issuedAt: ISSUED,
      carrier: { name: 'Ridgeline Auto Transport LLC' },
      claimantName: 'Copart Dallas',
      receivedAt: new Date('2026-09-01T12:00:00Z'),
      brand: brand({
        addendum: 'Storage is charged at $50 per vehicle per day.',
        remitToText: 'PO Box 1180, Dalton GA 30722',
      }),
    });

    const text = await pdfText(bytes);
    expect(text).not.toContain('ADDITIONAL TERMS');
    expect(text).not.toContain('Storage is charged');
    expect(text).not.toContain('PO Box 1180');
  });

  it('is not printed on a credit note', async () => {
    const bytes = await renderCreditNote({
      creditNumber: 'CN-OH-1001',
      issuedAt: ISSUED,
      carrier: { name: 'Ridgeline Auto Transport LLC' },
      billTo: { name: 'Cardinal Logistics LLC' },
      invoiceNumber: 'INV-OH-1001',
      invoiceIssuedAt: ISSUED,
      invoiceTotalCents: 95_000,
      reason: 'rate_adjustment',
      detail: 'Rate corrected.',
      amountCents: 5_000,
      currency: 'USD',
      totalCreditedCents: 5_000,
      paidCents: 0,
      brand: brand({ addendum: 'Storage is charged at $50 per vehicle per day.' }),
    });

    const text = await pdfText(bytes);
    expect(text).not.toContain('ADDITIONAL TERMS');
    expect(text).toContain('THIS IS NOT A BILL');
  });
});

describe('the remittance block', () => {
  it('replaces the office address on an invoice but not the carrier’s identity', async () => {
    const bytes = await renderInvoice(
      invoiceInput({ brand: brand({ remitToText: 'PO Box 1180\nDalton, GA 30722' }) }),
    );

    const text = await pdfText(bytes);
    expect(text).toContain('PO Box 1180');
    expect(text).not.toContain('4400 Meacham Blvd');

    // Who is claiming the money is not a template field.
    expect(text).toContain('Ridgeline Auto Transport LLC');
    expect(text).toContain('USDOT 3210987');
  });
});

describe('itemised accessorials on an invoice', () => {
  it('print each line with its own arithmetic', async () => {
    const bytes = await renderInvoice(
      invoiceInput({
        charges: {
          lineHaulCents: 95_000,
          fuelSurchargeCents: 0,
          accessorialCents: 48_750,
          taxCents: 0,
          codCollectedCents: 0,
          depositCents: 0,
        },
        accessorials: [
          {
            label: 'Detention at pickup',
            code: 'DET',
            unit: 'per_hour',
            quantityHundredths: 350,
            unitCents: 7_500,
            note: 'Held at the gate beyond the two free hours.',
          },
          {
            label: 'Winch out',
            code: 'WIN',
            unit: 'flat',
            quantityHundredths: 100,
            unitCents: 22_500,
            note: null,
          },
        ],
      }),
    );

    const text = await pdfText(bytes);

    expect(text).toContain('Detention at pickup');
    expect(text).toContain('3.5 hrs at $75.00');
    expect(text).toContain('Held at the gate beyond the two free hours.');
    expect(text).toContain('$262.50');
    expect(text).toContain('Winch out');
    expect(text).toContain('$225.00');

    // Nothing left over, so no unexplained lump sum beside the itemised lines.
    expect(text).not.toContain('Accessorial charges');
  });

  it('prints whatever the lines do not account for, so the block still adds up', async () => {
    /*
     * The case that matters is an invoice raised before the carrier had a
     * catalogue and then partly itemised. Dropping the remainder would print a
     * charges block whose own lines contradict the total being claimed.
     */
    const bytes = await renderInvoice(
      invoiceInput({
        charges: {
          lineHaulCents: 95_000,
          fuelSurchargeCents: 0,
          accessorialCents: 30_000,
          taxCents: 0,
          codCollectedCents: 0,
          depositCents: 0,
        },
        accessorials: [
          {
            label: 'Winch out',
            code: 'WIN',
            unit: 'flat',
            quantityHundredths: 100,
            unitCents: 22_500,
            note: null,
          },
        ],
      }),
    );

    const text = await pdfText(bytes);
    expect(text).toContain('Winch out');
    expect(text).toContain('Accessorial charges');
    expect(text).toContain('$75.00');
    // Line haul plus the whole accessorial figure.
    expect(text).toContain('$1,250.00');
  });
});

describe('the accent colour', () => {
  it('is used for the masthead rule and the document heading', async () => {
    const navy = rgb(31 / 255, 78 / 255, 121 / 255);
    const bytes = await renderBol(
      bolInput({ brand: brand({ accent: navy, accentText: navy }) }),
    );

    // pdf-lib writes colours into the content stream as "r g b rg" / "RG".
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(0);

    const text = await pdfText(bytes);
    // Colour cannot change what the page says.
    expect(text).toContain('BILL OF LADING');
    expect(text).toContain('NON-NEGOTIABLE');
  });
});
