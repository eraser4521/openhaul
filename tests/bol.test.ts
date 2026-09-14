import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { isPdf, pageCount, pdfText } from './helpers/pdf-text';
import sharp from 'sharp';
import { checkBolRequirements, renderBol, type BolInput, type BolVehicle } from '@/lib/documents/bol';

/**
 * The bill of lading is the artefact a cargo claim turns on years later, so
 * these tests care about two things: that the regulation's required fields are
 * actually enforced, and that rendering cannot fall over on real-world input.
 */

function vehicle(overrides: Partial<BolVehicle> = {}): BolVehicle {
  return {
    vin: '1HGCM82633A004352',
    year: 2003,
    make: 'HONDA',
    model: 'Accord',
    color: 'Silver',
    vehicleType: '2_door_coupe',
    odometer: 84_120,
    curbWeightLbs: 3_100,
    declaredValueCents: 850_000,
    isInoperable: false,
    damages: [],
    photos: [],
    ...overrides,
  };
}

function input(overrides: Partial<BolInput> = {}): BolInput {
  return {
    kind: 'bol',
    documentNumber: 'BOL-OH-1001',
    loadNumber: 'OH-1001',
    issuedAt: new Date('2026-09-14T12:00:00Z'),
    carrier: {
      legalName: 'Ridgeline Auto Transport LLC',
      addressLine1: '4400 Meacham Blvd',
      city: 'Fort Worth',
      state: 'TX',
      postalCode: '76106',
      phone: '(214) 555-0118',
      usdotNumber: '3312907',
      mcNumber: 'MC-1084422',
    },
    consignor: {
      name: 'Cardinal Auction Dallas',
      addressLine1: '1200 Auction Way',
      city: 'Dallas',
      state: 'TX',
      postalCode: '75201',
      contactName: 'Priya Raman',
      phone: '2145550118',
    },
    consignee: {
      name: 'Desert Motors Phoenix',
      addressLine1: '88 Camelback Rd',
      city: 'Phoenix',
      state: 'AZ',
      postalCode: '85012',
    },
    vehicles: [vehicle()],
    charges: {
      lineHaulCents: 294_000,
      fuelSurchargeCents: 18_000,
      accessorialCents: null,
      codAmountCents: null,
      depositCents: null,
      totalCents: 312_000,
      paymentTerms: '30_days',
    },
    distanceMiles: 1074,
    signatures: [],
    ...overrides,
  };
}

/* -------------------------------------------------------------------------
 * 49 CFR 373.101
 * ---------------------------------------------------------------------- */

describe('checkBolRequirements', () => {
  it('accepts a complete bill', () => {
    expect(checkBolRequirements(input())).toEqual([]);
  });

  it('requires the consignor to be named', () => {
    const missing = checkBolRequirements(
      input({ consignor: { ...input().consignor, name: '  ' } }),
    );
    expect(missing.map((m) => m.field)).toContain('consignor');
  });

  it('requires the consignee to be named', () => {
    const missing = checkBolRequirements(
      input({ consignee: { ...input().consignee, name: '' } }),
    );
    expect(missing.map((m) => m.field)).toContain('consignee');
  });

  it('requires an origin point', () => {
    const missing = checkBolRequirements(
      input({ consignor: { name: 'Cardinal Auction Dallas' } }),
    );
    expect(missing.map((m) => m.field)).toContain('origin');
  });

  it('requires a destination point', () => {
    const missing = checkBolRequirements(input({ consignee: { name: 'Desert Motors' } }));
    expect(missing.map((m) => m.field)).toContain('destination');
  });

  it('requires at least one unit', () => {
    const missing = checkBolRequirements(input({ vehicles: [] }));
    expect(missing.map((m) => m.field)).toContain('packages');
  });

  it('requires every unit to be described by a VIN', () => {
    const missing = checkBolRequirements(input({ vehicles: [vehicle({ vin: '' })] }));
    expect(missing.map((m) => m.field)).toContain('description');
  });

  it('cites the regulation on every finding, so it can be checked', () => {
    for (const finding of checkBolRequirements(input({ vehicles: [], consignee: { name: '' } }))) {
      expect(finding.citation).toBe('49 CFR 373.101');
      expect(finding.message.length).toBeGreaterThan(10);
    }
  });

  it('does not require weight, which auto transport rates per unit', () => {
    const missing = checkBolRequirements(
      input({ vehicles: [vehicle({ curbWeightLbs: null })] }),
    );
    expect(missing.map((m) => m.field)).not.toContain('weight');
  });
});

/* -------------------------------------------------------------------------
 * Rendering
 * ---------------------------------------------------------------------- */


describe('renderBol', () => {
  it('produces a valid PDF', async () => {
    const bytes = await renderBol(input());
    expect(isPdf(bytes)).toBe(true);
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(await pageCount(bytes)).toBeGreaterThanOrEqual(1);
  });

  it('renders a delivery receipt as well as a bill of lading', async () => {
    const bytes = await renderBol(input({ kind: 'pod', documentNumber: 'POD-OH-1001' }));
    expect(isPdf(bytes)).toBe(true);
  });

  it('declares the bill of lading non-negotiable on its face', async () => {
    const text = await pdfText(await renderBol(input()));
    expect(text).toContain('NON-NEGOTIABLE');
    expect(text).toContain('STRAIGHT BILL OF LADING');
  });

  it('does not let a delivery receipt call itself a bill of lading', async () => {
    /*
     * A delivery receipt evidences delivery of goods that moved under a bill;
     * it is a different instrument. Printing the bill's own declaration on it
     * claims a status it does not have, so the masthead and the first term
     * both have to say what this document actually is.
     */
    const text = await pdfText(await renderBol(input({ kind: 'pod', documentNumber: 'POD-OH-1001' })));

    expect(text).toContain('DELIVERY RECEIPT');
    expect(text).toContain('It is not itself a bill of lading');
    expect(text).not.toContain('This is a NON-NEGOTIABLE STRAIGHT bill of lading');
  });

  it('tells the consignee that unnoted damage may not be recoverable', async () => {
    const text = await pdfText(await renderBol(input({ kind: 'pod', documentNumber: 'POD-OH-1001' })));
    expect(text).toContain('acknowledges receipt of the vehicles');
    expect(text).toContain('may not be recoverable');
  });

  it('prints the five fields the regulation requires where they can be read', async () => {
    const text = await pdfText(await renderBol(input()));

    expect(text).toContain('Cardinal Auction Dallas'); // consignor
    expect(text).toContain('Desert Motors Phoenix'); // consignee
    expect(text).toContain('Dallas'); // origin
    expect(text).toContain('Phoenix'); // destination
    expect(text).toContain('1HGCM82633A004352'); // the unit described
  });

  it('states the claim and suit windows the Carmack Amendment sets', async () => {
    const text = await pdfText(await renderBol(input()));
    expect(text).toContain('nine (9) months');
    expect(text).toContain('two (2) years');
    expect(text).toContain('49 U.S.C. 14706');
  });

  it('grows onto more pages as vehicles are added rather than overflowing', async () => {
    const one = await renderBol(input());
    const full = await renderBol(
      input({
        // A full open deck, each with damage, which is the realistic worst case.
        vehicles: Array.from({ length: 10 }, (_, i) =>
          vehicle({
            vin: `1HGCM82633A00435${i}`,
            damages: [
              {
                code: '10123',
                description: 'Six-inch scratch on the driver door below the handle',
                preExisting: true,
                nonTransportation: false,
              },
              {
                code: '14045',
                description: 'Dent to the left front fender, paint broken',
                preExisting: true,
                nonTransportation: false,
              },
            ],
          }),
        ),
      }),
    );

    expect(await pageCount(full)).toBeGreaterThan(await pageCount(one));
  });

  it('handles a vehicle with no decoded details', async () => {
    const bytes = await renderBol(
      input({
        vehicles: [
          vehicle({ year: null, make: null, model: null, color: null, odometer: null }),
        ],
      }),
    );
    expect(isPdf(bytes)).toBe(true);
  });

  it('handles an inoperable unit', async () => {
    const bytes = await renderBol(
      input({
        vehicles: [
          vehicle({ isInoperable: true, inoperableReason: 'Will not start; rolls and steers' }),
        ],
      }),
    );
    expect(isPdf(bytes)).toBe(true);
  });

  it('renders collect-on-delivery terms', async () => {
    const bytes = await renderBol(
      input({
        charges: {
          ...input().charges,
          codAmountCents: 95_000,
          codMethod: 'check',
          codLocation: 'delivery',
        },
      }),
    );
    expect(isPdf(bytes)).toBe(true);
  });

  it('embeds photographs onto the contact sheet', async () => {
    const photo = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 90, g: 70, b: 50 } },
    })
      .jpeg()
      .toBuffer();

    const withPhotos = await renderBol(
      input({
        vehicles: [
          vehicle({
            photos: Array.from({ length: 6 }, (_, i) => ({
              bytes: new Uint8Array(photo),
              contentType: 'image/jpeg',
              slot: ['rear', 'left', 'front', 'right', 'odometer', 'interior'][i] ?? null,
            })),
          }),
        ],
      }),
    );

    const without = await renderBol(input());
    // Embedded images make the file substantially larger.
    expect(withPhotos.byteLength).toBeGreaterThan(without.byteLength * 1.5);
  });

  it('does not abort the whole document when one photo is unreadable', async () => {
    // A corrupt photo must not stop a carrier issuing a bill of lading.
    const bytes = await renderBol(
      input({
        vehicles: [
          vehicle({
            photos: [
              { bytes: new Uint8Array([1, 2, 3, 4]), contentType: 'image/jpeg', slot: 'rear' },
            ],
          }),
        ],
      }),
    );
    expect(isPdf(bytes)).toBe(true);
  });

  it('renders a drawn signature', async () => {
    const png = await sharp({
      create: { width: 400, height: 120, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    })
      .png()
      .toBuffer();

    const bytes = await renderBol(
      input({
        signatures: [
          {
            role: 'shipper',
            printedName: 'Marcus Webb',
            signedAt: new Date('2026-09-14T12:30:00Z'),
            image: { bytes: new Uint8Array(png), contentType: 'image/png' },
            customerUnavailable: false,
            authMethod: 'in_person_driver_attested',
          },
        ],
      }),
    );
    expect(isPdf(bytes)).toBe(true);
  });

  it('renders when nobody was available to sign', async () => {
    const bytes = await renderBol(
      input({
        signatures: [
          {
            role: 'consignee',
            printedName: 'Not available',
            signedAt: new Date('2026-09-14T12:30:00Z'),
            image: null,
            customerUnavailable: true,
            authMethod: 'in_person_driver_attested',
          },
        ],
      }),
    );
    expect(isPdf(bytes)).toBe(true);
  });

  it('commits to the inspection hash when one is supplied', async () => {
    const hash = 'a'.repeat(64);
    const withHash = await renderBol(input({ inspectionContentHash: hash }));
    const withoutHash = await renderBol(input());
    expect(withHash.byteLength).toBeGreaterThan(withoutHash.byteLength);
  });

  it('survives text long enough to need wrapping', async () => {
    const bytes = await renderBol(
      input({
        instructions: 'Gate code 4471. '.repeat(60),
        vehicles: [
          vehicle({
            damages: [
              {
                code: '10123',
                description: 'Scratch running the length of the door. '.repeat(20),
                preExisting: true,
                nonTransportation: false,
              },
            ],
          }),
        ],
      }),
    );
    expect(isPdf(bytes)).toBe(true);
  });

  it('renders deterministically across a change of wall-clock second', async () => {
    /*
     * Byte-identical output for identical input, so a re-render can be
     * compared against the stored hash to detect tampering. The delay is
     * deliberate: pdf-lib stamps the current time by default, and without
     * pinning the metadata this passes only when two renders happen to land
     * in the same second.
     */
    const fixed = input();
    const a = await renderBol(fixed);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const b = await renderBol(fixed);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('records the issue date in the metadata, not the render time', async () => {
    /*
     * Only the creation date is asserted. pdf-lib overwrites Producer during
     * save, and getModificationDate() on a freshly loaded document reports the
     * load time rather than what was written — asserting either would be
     * testing the library, not this code. Determinism is covered above, and
     * that is the property the stored hash actually depends on.
     */
    const bytes = await renderBol(input({ issuedAt: new Date('2026-09-14T12:00:00Z') }));
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getCreationDate()?.toISOString()).toBe('2026-09-14T12:00:00.000Z');
    expect(pdf.getTitle()).toContain('BOL-OH-1001');
  });
});
