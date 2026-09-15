import 'server-only';
import type { Organization, TemplateScope } from '../db/schema';
import type { DocumentBrand } from '../documents/layout';
import { renderBol } from '../documents/bol';
import { renderInvoice } from '../documents/invoice';
import { renderCreditNote } from '../documents/credit-note';
import { renderSettlement } from '../documents/settlement';
import { renderClaimLetter } from '../documents/claim-letter';
import { renderStatement } from '../documents/statement';
import {
  agedTotals,
  openItems,
  totalsFor,
  withRunningBalance,
  type StatementEntry,
} from '../invoices/statement';

/**
 * A specimen of each document, rendered through the real renderers.
 *
 * Not a mock-up. A carrier choosing a colour needs to know what it does to the
 * document they will actually sign, and the only honest way to show that is to
 * put the same brand through the same code path a real bill of lading takes.
 * A picture of a bill of lading drawn separately would drift from the real one
 * the first time either changed.
 *
 * Everything the specimen invents is named so it cannot be mistaken for a
 * record: SPECIMEN document numbers, an obviously fictional counterparty, a
 * VIN that is not a VIN. The carrier's own details are real, because those are
 * the part they are checking.
 */

const ISSUED = new Date('2026-03-17T15:00:00Z');

function carrierParty(org: Organization) {
  return {
    name: org.legalName,
    addressLine1: org.addressLine1,
    addressLine2: org.addressLine2,
    city: org.city,
    state: org.state,
    postalCode: org.postalCode,
    phone: org.phone,
    email: org.email,
    usdotNumber: org.usdotNumber,
    mcNumber: org.mcNumber,
  };
}

async function specimenBol(
  org: Organization,
  brand: DocumentBrand,
  kind: 'bol' | 'pod',
): Promise<Uint8Array> {
  return renderBol({
    kind,
    documentNumber: 'SPECIMEN',
    loadNumber: 'SPECIMEN',
    issuedAt: ISSUED,
    brand,

    carrier: {
      legalName: org.legalName,
      dbaName: org.dbaName,
      addressLine1: org.addressLine1,
      city: org.city,
      state: org.state,
      postalCode: org.postalCode,
      phone: org.phone,
      usdotNumber: org.usdotNumber,
      mcNumber: org.mcNumber,
    },

    consignor: {
      name: 'Specimen Motors of Dallas',
      addressLine1: '1 Example Way',
      city: 'Dallas',
      state: 'TX',
      postalCode: '75201',
      contactName: 'A. Sample',
      phone: '(214) 555-0100',
    },
    consignee: {
      name: 'Specimen Auto Group',
      addressLine1: '2 Example Street',
      city: 'Phoenix',
      state: 'AZ',
      postalCode: '85004',
      contactName: 'B. Sample',
      phone: '(602) 555-0100',
    },

    vehicles: [
      {
        vin: 'SPECIMENNOTAVIN1',
        year: 2024,
        make: 'Example',
        model: 'Sedan',
        color: 'Silver',
        vehicleType: 'sedan',
        odometer: 12_480,
        curbWeightLbs: 3_300,
        declaredValueCents: 2_800_000,
        isInoperable: false,
        damages: [
          {
            code: 'DS01',
            description: 'Right front door',
            preExisting: true,
            nonTransportation: false,
          },
        ],
        photos: [],
      },
    ],

    charges: {
      lineHaulCents: 95_000,
      fuelSurchargeCents: 12_000,
      accessorialCents: null,
      codAmountCents: null,
      depositCents: null,
      totalCents: 107_000,
      paymentTerms: '30_days',
    },

    distanceMiles: 1_064,
    signatures:
      kind === 'pod'
        ? [
            {
              role: 'consignee',
              printedName: 'B. Sample',
              signedAt: ISSUED,
              customerUnavailable: false,
              authMethod: 'in_person',
            },
          ]
        : [],
  });
}

async function specimenInvoice(org: Organization, brand: DocumentBrand): Promise<Uint8Array> {
  return renderInvoice({
    invoiceNumber: 'SPECIMEN',
    loadNumber: 'SPECIMEN',
    issuedAt: ISSUED,
    dueAt: new Date('2026-04-16T15:00:00Z'),
    terms: '30_days',
    brand,

    carrier: carrierParty(org),
    billTo: {
      name: 'Specimen Logistics LLC',
      contactName: 'Accounts Payable',
      addressLine1: '3 Example Plaza',
      city: 'Atlanta',
      state: 'GA',
      postalCode: '30303',
      email: 'ap@specimen.example',
      mcNumber: 'MC 000000',
    },

    charges: {
      lineHaulCents: 95_000,
      fuelSurchargeCents: 12_000,
      // Matches the specimen lines below, so the block adds up the way a real
      // one does.
      accessorialCents: 26_250,
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
    ],

    paidCents: 0,
    currency: 'USD',
    vehicles: [{ vin: 'SPECIMENNOTAVIN1', description: '2024 Example Sedan · Silver' }],
    payments: [],
    attachments: [],
    originLine: 'Specimen Motors of Dallas\nDallas, TX',
    destinationLine: 'Specimen Auto Group\nPhoenix, AZ',
    distanceMiles: 1_064,
    deliveredAt: ISSUED,
  });
}

async function specimenCreditNote(org: Organization, brand: DocumentBrand): Promise<Uint8Array> {
  return renderCreditNote({
    creditNumber: 'SPECIMEN',
    issuedAt: ISSUED,
    brand,
    carrier: carrierParty(org),
    billTo: {
      name: 'Specimen Logistics LLC',
      addressLine1: '3 Example Plaza',
      city: 'Atlanta',
      state: 'GA',
      postalCode: '30303',
    },
    invoiceNumber: 'SPECIMEN',
    invoiceIssuedAt: ISSUED,
    invoiceTotalCents: 133_250,
    loadNumber: 'SPECIMEN',
    reason: 'rate_adjustment',
    detail: 'Rate corrected to the figure on the rate confirmation.',
    amountCents: 12_000,
    currency: 'USD',
    totalCreditedCents: 12_000,
    paidCents: 0,
  });
}

async function specimenSettlement(org: Organization, brand: DocumentBrand): Promise<Uint8Array> {
  return renderSettlement({
    settlementNumber: 'SPECIMEN',
    issuedAt: ISSUED,
    periodStart: new Date('2026-03-02T00:00:00Z'),
    periodEnd: new Date('2026-03-15T00:00:00Z'),
    paymentDueBy: new Date('2026-03-30T00:00:00Z'),
    brand,
    carrier: carrierParty(org),
    driverName: 'Specimen Driver',
    employmentType: 'owner_operator',
    payBasis: '72% of rated revenue',
    lines: [
      {
        kind: 'load_pay',
        description: 'Load SPECIMEN — Dallas TX to Phoenix AZ',
        amountCents: 77_040,
        basisNote: '72% of $1,070.00 rated revenue',
        loadNumber: 'SPECIMEN',
      },
      {
        kind: 'advance',
        description: 'Fuel advance',
        amountCents: 20_000,
        basisNote: null,
        loadNumber: null,
      },
    ],
    escrowBalanceCents: 150_000,
    notes: null,
  });
}

async function specimenClaimLetter(org: Organization, brand: DocumentBrand): Promise<Uint8Array> {
  return renderClaimLetter({
    kind: 'acknowledgement',
    claimNumber: 'SPECIMEN',
    issuedAt: ISSUED,
    brand,
    carrier: carrierParty(org),
    claimantName: 'Specimen Motors of Dallas',
    claimantEmail: 'claims@specimen.example',
    receivedAt: new Date('2026-03-10T00:00:00Z'),
    loadNumber: 'SPECIMEN',
    vin: 'SPECIMENNOTAVIN1',
    deliveredAt: new Date('2026-03-05T00:00:00Z'),
    demandAmountCents: 185_000,
  });
}

async function specimenStatement(org: Organization, brand: DocumentBrand): Promise<Uint8Array> {
  const from = new Date('2026-01-01T00:00:00Z');

  /*
   * Built through the same pure helpers the real statement uses, so the
   * specimen cannot show a total the arithmetic would never produce. The
   * figures are chosen to exercise every row: something overdue, something
   * not due yet, a credit, and money held on account.
   */
  const entries: StatementEntry[] = [
    {
      at: new Date('2026-01-14T00:00:00Z'),
      kind: 'invoice',
      reference: 'SPECIMEN-1',
      detail: null,
      dueCents: 294_000,
      heldCents: 0,
    },
    {
      at: new Date('2026-02-02T00:00:00Z'),
      kind: 'payment',
      reference: 'SPECIMEN-1',
      detail: 'ACH SPECIMEN',
      dueCents: -344_000,
      heldCents: 0,
    },
    {
      at: new Date('2026-02-04T00:00:00Z'),
      kind: 'credit_kept',
      reference: 'SPECIMEN-1',
      detail: 'Overpayment held at your request',
      dueCents: 50_000,
      heldCents: 50_000,
    },
    {
      at: new Date('2026-02-20T00:00:00Z'),
      kind: 'invoice',
      reference: 'SPECIMEN-2',
      detail: null,
      dueCents: 187_500,
      heldCents: 0,
    },
  ];

  const totals = totalsFor(entries, from);

  const items = openItems(
    [
      {
        number: 'SPECIMEN-2',
        issuedAt: new Date('2026-02-20T00:00:00Z'),
        dueAt: new Date('2026-03-22T00:00:00Z'),
        totalCents: 187_500,
        paidCents: 0,
      },
    ],
    ISSUED,
  );

  return renderStatement({
    issuedAt: ISSUED,
    periodFrom: from,
    periodLabel: 'Last 3 months',
    brand,
    carrier: carrierParty(org),
    billTo: {
      name: 'Specimen Logistics Brokerage',
      contactName: 'Accounts Payable',
      addressLine1: '1 Specimen Plaza',
      city: 'Dallas',
      state: 'TX',
      postalCode: '75201',
      email: 'ap@specimen.example',
    },
    currency: 'USD',
    totals,
    openItems: items,
    aged: agedTotals(items),
    activity: withRunningBalance(entries, totals.openingDueCents),
  });
}

export async function renderSpecimen(
  scope: TemplateScope,
  org: Organization,
  brand: DocumentBrand,
): Promise<Uint8Array> {
  switch (scope) {
    case 'pod':
      return specimenBol(org, brand, 'pod');
    case 'invoice':
      return specimenInvoice(org, brand);
    case 'credit_note':
      return specimenCreditNote(org, brand);
    case 'statement':
      return specimenStatement(org, brand);
    case 'settlement':
      return specimenSettlement(org, brand);
    case 'claim':
      return specimenClaimLetter(org, brand);
    case 'bol':
    case 'all':
      // The house style previews as a bill of lading. It is the document a
      // carrier looks at hardest and the one every other layout borrows from.
      return specimenBol(org, brand, 'bol');
  }
}
