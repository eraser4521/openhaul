import 'server-only';
import { describeDamageCode, CONCEALED_DAMAGE_WINDOW_DAYS } from '../aiag/codes';
import { money, vinDisplay } from '../utils/format';
import {
  CONTENT_WIDTH,
  DocBuilder,
  HAIRLINE,
  INK,
  MARGIN,
  MUTED,
  WARNING,
  type TableColumn,
} from './layout';

/**
 * Bill of lading and delivery receipt.
 *
 * Issued as a NON-NEGOTIABLE STRAIGHT bill. That is a deliberate choice: a
 * negotiable document of title would bring UCC 7-106 "authoritative copy"
 * obligations — a single unique, unalterable copy with tracked control — which
 * is a registry-grade problem. Auto transport releases vehicles to a named
 * consignee, never to whoever holds the paper, so the straight form is both
 * correct and far simpler to do properly.
 */

export interface BolParty {
  name: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  gateCode?: string | null;
  requiresTwic?: boolean;
}

export interface BolVehicle {
  vin: string;
  year: number | null;
  make: string | null;
  model: string | null;
  color: string | null;
  vehicleType: string;
  plate?: string | null;
  plateState?: string | null;
  lotNumber?: string | null;
  odometer: number | null;
  curbWeightLbs: number | null;
  declaredValueCents: number | null;
  isInoperable: boolean;
  inoperableReason?: string | null;
  damages: Array<{
    code: string;
    description: string | null;
    preExisting: boolean;
    nonTransportation: boolean;
  }>;
  photos: Array<{ bytes: Uint8Array; contentType: string; slot: string | null }>;
}

export interface BolSignature {
  role: string;
  printedName: string;
  signedAt: Date;
  image?: { bytes: Uint8Array; contentType: string } | null;
  customerUnavailable: boolean;
  authMethod: string;
  latitude?: string | null;
  longitude?: string | null;
}

export interface BolInput {
  kind: 'bol' | 'pod';
  documentNumber: string;
  loadNumber: string;
  issuedAt: Date;

  carrier: {
    legalName: string;
    dbaName?: string | null;
    addressLine1?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    phone?: string | null;
    usdotNumber?: string | null;
    mcNumber?: string | null;
  };

  driverName?: string | null;
  equipmentLabel?: string | null;

  consignor: BolParty;
  consignee: BolParty;

  vehicles: BolVehicle[];

  charges: {
    lineHaulCents: number | null;
    fuelSurchargeCents: number | null;
    accessorialCents: number | null;
    codAmountCents: number | null;
    codMethod?: string | null;
    codLocation?: string | null;
    depositCents: number | null;
    totalCents: number | null;
    paymentTerms?: string | null;
  };

  distanceMiles: number | null;
  instructions?: string | null;

  signatures: BolSignature[];
  /** Rendered at delivery only: damage found that was not on the pickup report. */
  exceptions?: string | null;

  /**
   * Hash of the inspection this document reports.
   *
   * The document cannot print its own hash without being circular, so it
   * commits to the inspection record instead. The document's own hash is
   * computed from the finished bytes and stored against the row.
   */
  inspectionContentHash?: string | null;
}

/* -------------------------------------------------------------------------
 * Regulatory completeness
 * ---------------------------------------------------------------------- */

export interface BolRequirement {
  field: string;
  citation: string;
  message: string;
}

/**
 * Checks the five things 49 CFR 373.101 actually requires.
 *
 * The federal floor is thin — everything that wins a cargo claim is industry
 * practice rather than regulation — but a document missing one of these is not
 * a bill of lading at all, so it is checked before anything is rendered.
 */
export function checkBolRequirements(input: BolInput): BolRequirement[] {
  const missing: BolRequirement[] = [];
  const cite = '49 CFR 373.101';

  if (!input.consignor.name?.trim()) {
    missing.push({
      field: 'consignor',
      citation: cite,
      message: 'The consignor (shipper) must be named.',
    });
  }
  if (!input.consignee.name?.trim()) {
    missing.push({
      field: 'consignee',
      citation: cite,
      message: 'The consignee (receiver) must be named.',
    });
  }

  const hasOrigin = Boolean(input.consignor.city && input.consignor.state);
  const hasDestination = Boolean(input.consignee.city && input.consignee.state);
  if (!hasOrigin) {
    missing.push({ field: 'origin', citation: cite, message: 'The origin point must be recorded.' });
  }
  if (!hasDestination) {
    missing.push({
      field: 'destination',
      citation: cite,
      message: 'The destination point must be recorded.',
    });
  }

  if (input.vehicles.length === 0) {
    missing.push({
      field: 'packages',
      citation: cite,
      message: 'At least one vehicle must be on the load.',
    });
  }

  // Requirement four: a description of the freight. A VIN alone identifies the
  // unit; year, make and model are what a receiving clerk actually matches.
  const undescribed = input.vehicles.filter((v) => !v.vin?.trim());
  if (undescribed.length > 0) {
    missing.push({
      field: 'description',
      citation: cite,
      message: `${undescribed.length} vehicle${undescribed.length === 1 ? '' : 's'} have no VIN.`,
    });
  }

  return missing;
}

/* -------------------------------------------------------------------------
 * Rendering
 * ---------------------------------------------------------------------- */

function addressLines(party: BolParty): string {
  const parts = [
    party.addressLine1,
    party.addressLine2,
    [party.city, party.state].filter(Boolean).join(', ') + (party.postalCode ? ` ${party.postalCode}` : ''),
  ]
    .map((line) => line?.trim())
    .filter((line): line is string => Boolean(line && line !== ','));

  return parts.join('\n') || '—';
}

function vehicleDescription(vehicle: BolVehicle): string {
  const label = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ');
  const colour = vehicle.color ? ` · ${vehicle.color}` : '';
  return `${label || 'Vehicle'}${colour}`;
}

function formatDateTime(date: Date): string {
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/**
 * The terms printed on the face of the document.
 *
 * These are not decoration. The Carmack Amendment lets a carrier impose a
 * claim window no shorter than nine months and a suit window no shorter than
 * two years — but if the bill is silent, longer state periods can apply
 * instead. Printing them is what fixes the shorter federal minimums.
 */
function termsText(kind: 'bol' | 'pod'): string {
  const common = [
    kind === 'pod'
      ? 'This receipt evidences delivery of the property described, under the non-negotiable straight bill of lading issued for this shipment. It is not itself a bill of lading and is not negotiable.'
      : 'This is a NON-NEGOTIABLE STRAIGHT bill of lading. The property described below is released to the named consignee only, and not to the bearer of this document.',
    'Carrier liability is governed by 49 U.S.C. 14706 (the Carmack Amendment). A claim for loss or damage must be filed in writing within nine (9) months of delivery, and any civil action must be commenced within two (2) years of the date the carrier gives written notice that the claim is disallowed.',
    'A written claim must identify the shipment, assert carrier liability, and demand a specific or determinable amount. A damage notation on this document is not itself a claim.',
    `Concealed damage must be reported within ${CONCEALED_DAMAGE_WINDOW_DAYS} business days of delivery. Cracked glass, bumper damage, and damage that went undetected because the vehicle was dirty or snow-covered are not concealed damage.`,
    'The condition recorded here reflects inspection from a normal standing distance in the conditions noted. Personal property left in a vehicle is carried at the owner’s risk and is not covered.',
  ];

  if (kind === 'pod') {
    common.splice(
      1,
      0,
      'By signing below the consignee acknowledges receipt of the vehicles described. Damage not noted on this receipt at the time of delivery may not be recoverable.',
    );
  }

  return common.map((line, index) => `${index + 1}. ${line}`).join('\n');
}

export async function renderBol(input: BolInput): Promise<Uint8Array> {
  const isPod = input.kind === 'pod';

  const doc = await DocBuilder.create({
    footerNote: `${input.documentNumber} · ${input.carrier.legalName}`,
    title: `${isPod ? 'Delivery receipt' : 'Bill of lading'} ${input.documentNumber}`,
    issuedAt: input.issuedAt,
  });

  /* --- Masthead ------------------------------------------------------- */

  doc.text(isPod ? 'DELIVERY RECEIPT — PROOF OF DELIVERY' : 'BILL OF LADING', {
    size: 15,
    font: doc.fonts.bold,
  });

  /*
   * Prominent, and non-configurable. A document that does not say this on its
   * face invites being treated as negotiable.
   *
   * A delivery receipt says something different, because it is a different
   * instrument: it records delivery of goods that moved under the bill, and
   * printing the bill's own declaration on it would claim a status it does
   * not have.
   */
  doc.text(
    isPod
      ? 'DELIVERED UNDER NON-NEGOTIABLE — STRAIGHT BILL OF LADING'
      : 'NON-NEGOTIABLE — STRAIGHT BILL OF LADING',
    {
      size: 8,
      font: doc.fonts.bold,
      color: WARNING,
    },
  );

  doc.move(6);

  doc.columns(
    (column) => {
      doc.field('Carrier', input.carrier.legalName, column);
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

      const authority = [
        input.carrier.usdotNumber ? `USDOT ${input.carrier.usdotNumber}` : null,
        input.carrier.mcNumber ? input.carrier.mcNumber : null,
      ]
        .filter(Boolean)
        .join('   ');
      if (authority) doc.text(authority, { ...column, size: 8, font: doc.fonts.bold });
    },
    (column) => {
      doc.field(isPod ? 'Delivery receipt no.' : 'Bill of lading no.', input.documentNumber, {
        ...column,
        mono: true,
      });
      doc.field('Load', input.loadNumber, { ...column, mono: true });
      doc.field('Issued', formatDateTime(input.issuedAt), column);
    },
  );

  doc.move(4);
  doc.rule(INK, 1);
  doc.move(8);

  /* --- Parties: 49 CFR 373.101(1) and (2) ------------------------------ */

  doc.columns(
    (column) => {
      doc.field('Consignor — shipper / origin', input.consignor.name, column);
      doc.text(addressLines(input.consignor), { ...column, size: 8.5 });
      const contact = [input.consignor.contactName, input.consignor.phone]
        .filter(Boolean)
        .join(' · ');
      if (contact) doc.text(contact, { ...column, size: 8, color: MUTED });
      if (input.consignor.gateCode) {
        doc.text(`Gate code ${input.consignor.gateCode}`, { ...column, size: 8, color: MUTED });
      }
      if (input.consignor.requiresTwic) {
        doc.text('TWIC card required', { ...column, size: 8, font: doc.fonts.bold });
      }
    },
    (column) => {
      doc.field('Consignee — receiver / destination', input.consignee.name, column);
      doc.text(addressLines(input.consignee), { ...column, size: 8.5 });
      const contact = [input.consignee.contactName, input.consignee.phone]
        .filter(Boolean)
        .join(' · ');
      if (contact) doc.text(contact, { ...column, size: 8, color: MUTED });
      if (input.consignee.gateCode) {
        doc.text(`Gate code ${input.consignee.gateCode}`, { ...column, size: 8, color: MUTED });
      }
      if (input.consignee.requiresTwic) {
        doc.text('TWIC card required', { ...column, size: 8, font: doc.fonts.bold });
      }
    },
  );

  doc.move(8);

  /* --- Freight summary: 373.101(3), (4) and (5) ------------------------ */

  const totalWeight = input.vehicles.reduce((sum, v) => sum + (v.curbWeightLbs ?? 0), 0);
  const third = CONTENT_WIDTH / 3 - 8;

  doc.columns(
    (column) => {
      doc.field('Units', String(input.vehicles.length), { x: column.x, width: third });
    },
    (column) => {
      doc.field('Description of freight', 'Motor vehicles — see schedule below', {
        x: column.x - third - 8,
        width: third * 2,
      });
    },
  );

  doc.field(
    'Weight',
    // The regulation only requires weight where it affects the rating, which
    // for per-unit auto transport it usually does not.
    totalWeight > 0
      ? `${totalWeight.toLocaleString('en-US')} lb (sum of curb weights)`
      : 'Not applicable to rating — vehicles rated per unit',
  );

  if (input.driverName || input.equipmentLabel) {
    doc.columns(
      (column) => doc.field('Driver', input.driverName ?? '—', column),
      (column) => doc.field('Equipment', input.equipmentLabel ?? '—', column),
    );
  }

  /* --- Vehicle schedule ------------------------------------------------ */

  doc.heading('Vehicle schedule');

  const columns: TableColumn[] = [
    { header: 'VIN', weight: 2.4, mono: true },
    { header: 'Year / Make / Model', weight: 2.6 },
    { header: 'Color', weight: 1 },
    { header: 'Odometer', weight: 1, align: 'right' },
    { header: 'Status', weight: 1.1 },
    { header: 'Declared value', weight: 1.3, align: 'right' },
  ];

  doc.table(
    columns,
    input.vehicles.map((vehicle) => [
      vehicle.vin,
      [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || '—',
      vehicle.color ?? '—',
      vehicle.odometer === null ? '—' : vehicle.odometer.toLocaleString('en-US'),
      vehicle.isInoperable ? 'INOPERABLE' : 'Operable',
      vehicle.declaredValueCents === null ? '—' : money(vehicle.declaredValueCents),
    ]),
  );

  const inoperable = input.vehicles.filter((v) => v.isInoperable);
  if (inoperable.length > 0) {
    doc.move(4);
    doc.text(
      `Inoperable units require winch loading: ${inoperable
        .map((v) => `${vinDisplay(v.vin)}${v.inoperableReason ? ` (${v.inoperableReason})` : ''}`)
        .join('; ')}`,
      { size: 8, color: WARNING },
    );
  }

  /* --- Condition ------------------------------------------------------- */

  doc.heading(isPod ? 'Condition at delivery' : 'Condition at pickup');

  for (const vehicle of input.vehicles) {
    doc.ensure(48);
    doc.move(2);

    doc.text(`${vinDisplay(vehicle.vin)} — ${vehicleDescription(vehicle)}`, {
      size: 9,
      font: doc.fonts.bold,
    });

    const reportable = vehicle.damages.filter((d) => !d.nonTransportation);
    const excluded = vehicle.damages.filter((d) => d.nonTransportation);

    if (reportable.length === 0) {
      doc.text('No damage noted.', { size: 8.5, color: MUTED });
    } else {
      for (const damage of reportable) {
        const described = describeDamageCode(damage.code) ?? damage.code;
        const prefix = damage.preExisting ? 'Pre-existing' : 'Noted';
        doc.text(`• ${damage.code}  ${described} — ${prefix}`, { size: 8.5 });
        if (damage.description) {
          doc.text(damage.description, { size: 8, color: MUTED, x: MARGIN + 12, width: CONTENT_WIDTH - 12 });
        }
      }
    }

    if (excluded.length > 0) {
      doc.text(
        `${excluded.length} condition${excluded.length === 1 ? '' : 's'} recorded as non-transportation damage under AIAG guidance and excluded from carrier liability.`,
        { size: 7.5, color: MUTED },
      );
    }

    await renderPhotoStrip(doc, vehicle);
    doc.move(6);
  }

  if (isPod && input.exceptions) {
    doc.heading('Exceptions at delivery');
    doc.text(input.exceptions, { size: 9 });
  }

  /* --- Charges --------------------------------------------------------- */

  const { charges } = input;
  const hasCharges =
    charges.lineHaulCents !== null ||
    charges.totalCents !== null ||
    charges.codAmountCents !== null;

  if (hasCharges) {
    doc.heading('Charges');

    const rows: Array<[string, number | null]> = [
      ['Line haul', charges.lineHaulCents],
      // Always its own line. Folding it into the line haul is what gets an
      // invoice held.
      ['Fuel surcharge', charges.fuelSurchargeCents],
      ['Accessorials', charges.accessorialCents],
      ['Deposit received', charges.depositCents === null ? null : -charges.depositCents],
    ];

    for (const [label, amount] of rows) {
      if (amount === null) continue;
      doc.ensure(12);
      doc.text(label, { size: 8.5, width: CONTENT_WIDTH - 100 });
      doc.move(-11.5);
      doc.text(money(amount), { size: 8.5, x: MARGIN, width: CONTENT_WIDTH, align: 'right' });
    }

    doc.move(2);
    doc.rule();
    doc.move(3);

    doc.text('Total', { size: 9, font: doc.fonts.bold, width: CONTENT_WIDTH - 100 });
    doc.move(-12.15);
    doc.text(money(charges.totalCents), {
      size: 9,
      font: doc.fonts.bold,
      x: MARGIN,
      width: CONTENT_WIDTH,
      align: 'right',
    });

    if (charges.codAmountCents) {
      doc.move(4);
      doc.text(
        `COLLECT ON ${charges.codLocation === 'pickup' ? 'PICKUP' : 'DELIVERY'}: ` +
          `${money(charges.codAmountCents)} by ${charges.codMethod ?? 'cash or check'}`,
        { size: 9, font: doc.fonts.bold, color: WARNING },
      );
    }

    if (charges.paymentTerms) {
      doc.text(`Payment terms: ${charges.paymentTerms.replace(/_/g, ' ')}`, {
        size: 8,
        color: MUTED,
      });
    }
  }

  if (input.instructions) {
    doc.heading('Instructions');
    doc.text(input.instructions, { size: 8.5 });
  }

  /* --- Terms ----------------------------------------------------------- */

  doc.heading('Terms and conditions');
  doc.text(termsText(input.kind), { size: 7, color: INK, lineHeight: 9.5 });

  /* --- Signatures ------------------------------------------------------ */

  doc.heading('Signatures');
  await renderSignatures(doc, input.signatures);

  /* --- Evidence ------------------------------------------------------- */

  if (input.inspectionContentHash) {
    doc.move(6);
    doc.heading('Record integrity');

    const photoCount = input.vehicles.reduce((sum, v) => sum + v.photos.length, 0);

    doc.text(`Inspection content hash (SHA-256)`, { size: 6.5, color: MUTED });
    doc.text(input.inspectionContentHash, { size: 7, font: doc.fonts.mono });
    doc.move(3);
    doc.text(
      `${photoCount} photograph${photoCount === 1 ? '' : 's'} and ` +
        `${input.signatures.length} signature${input.signatures.length === 1 ? '' : 's'} are ` +
        'incorporated by reference and retained with this record. Altering any photograph or ' +
        'recorded field changes this hash, so a copy of this document can be checked against ' +
        'the retained record.',
      { size: 7, color: MUTED, lineHeight: 9 },
    );
  }

  return doc.finish();
}

/** Contact sheet of the walk-around, three across. */
async function renderPhotoStrip(doc: DocBuilder, vehicle: BolVehicle): Promise<void> {
  if (vehicle.photos.length === 0) return;

  const perRow = 4;
  const gap = 6;
  const cellWidth = (CONTENT_WIDTH - gap * (perRow - 1)) / perRow;
  const cellHeight = cellWidth * 0.75;

  doc.move(4);

  for (let index = 0; index < vehicle.photos.length; index += perRow) {
    const row = vehicle.photos.slice(index, index + perRow);
    doc.ensure(cellHeight + 12);

    const top = doc.y;

    for (const [position, photo] of row.entries()) {
      const x = MARGIN + position * (cellWidth + gap);
      const box = { x, y: top - cellHeight, width: cellWidth, height: cellHeight };

      try {
        await doc.image(photo.bytes, photo.contentType, box);
      } catch {
        // A single unreadable photo must not prevent the bill of lading from
        // being issued; the caption still records that it existed.
        doc.drawBox(box);
      }

      doc.drawBox(box, HAIRLINE);

      if (photo.slot) {
        doc.currentPage.drawText(photo.slot.replace(/_/g, ' '), {
          x: x + 2,
          y: top - cellHeight - 8,
          size: 6,
          font: doc.fonts.regular,
          color: MUTED,
        });
      }
    }

    doc.move(cellHeight + 12);
  }
}

async function renderSignatures(doc: DocBuilder, signatures: BolSignature[]): Promise<void> {
  if (signatures.length === 0) {
    doc.text('No signature captured.', { size: 8.5, color: WARNING });
    return;
  }

  const gap = 18;
  const columnWidth = (CONTENT_WIDTH - gap) / 2;
  const blockHeight = 92;

  for (let index = 0; index < signatures.length; index += 2) {
    const pair = signatures.slice(index, index + 2);
    doc.ensure(blockHeight);
    const top = doc.y;

    for (const [position, signature] of pair.entries()) {
      const x = MARGIN + position * (columnWidth + gap);
      const imageBox = { x, y: top - 40, width: columnWidth, height: 38 };

      if (signature.image && !signature.customerUnavailable) {
        try {
          await doc.image(signature.image.bytes, signature.image.contentType, imageBox);
        } catch {
          // Fall through to the ruled line below.
        }
      }

      doc.currentPage.drawLine({
        start: { x, y: top - 42 },
        end: { x: x + columnWidth, y: top - 42 },
        thickness: 0.6,
        color: INK,
      });

      const label = signature.customerUnavailable
        ? `${signature.role} — CUSTOMER NOT AVAILABLE`
        : signature.role;

      doc.currentPage.drawText(label.toUpperCase(), {
        x,
        y: top - 52,
        size: 6,
        font: doc.fonts.bold,
        color: MUTED,
      });

      doc.currentPage.drawText(signature.printedName || '—', {
        x,
        y: top - 64,
        size: 9,
        font: doc.fonts.regular,
        color: INK,
      });

      doc.currentPage.drawText(formatDateTime(signature.signedAt), {
        x,
        y: top - 75,
        size: 7,
        font: doc.fonts.regular,
        color: MUTED,
      });

      // The attribution method is printed, not hidden in an audit log. A
      // signature taken on the driver's phone from someone with no account is
      // weaker evidence than an authenticated one, and the document says so.
      const attribution =
        signature.authMethod === 'in_person_driver_attested'
          ? 'Signed in person on the driver’s device'
          : 'Signed by an authenticated user';

      doc.currentPage.drawText(attribution, {
        x,
        y: top - 85,
        size: 6.5,
        font: doc.fonts.regular,
        color: MUTED,
      });
    }

    doc.move(blockHeight);
  }
}

