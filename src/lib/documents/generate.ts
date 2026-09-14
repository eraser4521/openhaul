import 'server-only';
import { and, eq } from 'drizzle-orm';
import {
  damages as damagesTable,
  inspections as inspectionsTable,
  inspectionPhotos as photosTable,
  loads as loadsTable,
  stops as stopsTable,
  customers as customersTable,
  vehicles as vehiclesTable,
  venues as venuesTable,
} from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { getOrganization } from '../organization/profile';
import { brandFor } from '../branding/template';
import { blobStore } from '../storage/blob-store';
import { signaturesFor } from '../inspections/finalize';
import { storeDocument } from './store';
import {
  checkBolRequirements,
  renderBol,
  type BolInput,
  type BolParty,
  type BolRequirement,
  type BolVehicle,
} from './bol';

/**
 * Builds, freezes and stores a bill of lading or delivery receipt.
 *
 * The rendered bytes are the record, not the database rows they came from.
 * Regenerating a 2026 bill from a 2033 template does not reproduce what was
 * actually agreed, and the electronic-records standard requires a retained
 * record remain capable of accurate reproduction. So the PDF is hashed and
 * stored once, and the `documents` table carries append-only protection
 * against edits to a finalized row.
 */

export type DocumentKind = 'bol' | 'pod';

export interface GenerateResult {
  ok: boolean;
  documentId?: string;
  sha256?: string;
  error?: string;
  missing?: BolRequirement[];
}

/** How many photos of each vehicle are printed on the contact sheet. */
const PHOTOS_PER_VEHICLE = 8;

function partyFromVenue(
  venue: { name: string; addressLine1: string; addressLine2: string | null; city: string; state: string; postalCode: string; contactName: string | null; contactPhone: string | null; contactEmail: string | null; gateCode: string | null; requiresTwic: boolean } | null,
  fallbackName: string,
): BolParty {
  if (!venue) return { name: fallbackName };
  return {
    name: venue.name,
    addressLine1: venue.addressLine1,
    addressLine2: venue.addressLine2,
    city: venue.city,
    state: venue.state,
    postalCode: venue.postalCode,
    contactName: venue.contactName,
    phone: venue.contactPhone,
    email: venue.contactEmail,
    gateCode: venue.gateCode,
    requiresTwic: venue.requiresTwic,
  };
}

/**
 * Assembles everything the document needs.
 *
 * Reads through the scoped client, so a load id from another organisation
 * simply does not resolve and there is no separate ownership check to forget.
 */
export async function buildDocumentInput(
  scoped: ScopedDb,
  loadId: string,
  kind: DocumentKind,
  documentNumber: string,
): Promise<{ input: BolInput; inspectionIds: string[] } | { error: string }> {
  const load = await scoped.selectOne('loads', eq(loadsTable.id, loadId));
  if (!load) return { error: 'No such load.' };

  const org = await getOrganization(scoped.orgId);
  if (!org) return { error: 'The organisation record is missing.' };

  const [vehicles, stops, customer] = await Promise.all([
    scoped.select('vehicles', eq(vehiclesTable.loadId, loadId)),
    scoped.select('stops', eq(stopsTable.loadId, loadId)),
    load.customerId
      ? scoped.selectOne('customers', eq(customersTable.id, load.customerId))
      : Promise.resolve(null),
  ]);

  const pickupStop = stops.find((s) => s.kind === 'pickup') ?? null;
  const deliveryStop = stops.find((s) => s.kind === 'delivery') ?? null;

  const [pickupVenue, deliveryVenue] = await Promise.all([
    pickupStop?.venueId
      ? scoped.selectOne('venues', eq(venuesTable.id, pickupStop.venueId))
      : Promise.resolve(null),
    deliveryStop?.venueId
      ? scoped.selectOne('venues', eq(venuesTable.id, deliveryStop.venueId))
      : Promise.resolve(null),
  ]);

  const stage = kind === 'bol' ? 'pickup' : 'delivery';
  const store = blobStore();

  const builtVehicles: BolVehicle[] = [];
  const inspectionIds: string[] = [];
  let inspectionContentHash: string | null = null;
  const signatures: BolInput['signatures'] = [];

  for (const vehicle of vehicles) {
    const [inspection] = await scoped.select(
      'inspections',
      and(eq(inspectionsTable.vehicleId, vehicle.id), eq(inspectionsTable.stage, stage)),
    );

    let vehicleDamages: BolVehicle['damages'] = [];
    const vehiclePhotos: BolVehicle['photos'] = [];
    let odometer = vehicle.odometer;

    if (inspection) {
      inspectionIds.push(inspection.id);
      inspectionContentHash ??= inspection.contentHash;
      odometer = inspection.odometer ?? odometer;

      const [damageRows, photoRows] = await Promise.all([
        scoped.select('damages', eq(damagesTable.inspectionId, inspection.id)),
        scoped.select('inspectionPhotos', eq(photosTable.inspectionId, inspection.id)),
      ]);

      vehicleDamages = damageRows.map((damage) => ({
        code: damage.code,
        description: damage.description,
        preExisting: damage.preExisting,
        nonTransportation: damage.nonTransportation,
      }));

      // Walk-around shots first, then damage close-ups, capped so a twenty-photo
      // inspection does not produce a twelve-page contact sheet.
      const ordered = [...photoRows].sort((a, b) => {
        if (a.slot && !b.slot) return -1;
        if (!a.slot && b.slot) return 1;
        return a.id.localeCompare(b.id);
      });

      for (const photo of ordered.slice(0, PHOTOS_PER_VEHICLE)) {
        const bytes = await store.get(photo.storageKey);
        if (bytes) {
          vehiclePhotos.push({
            bytes: new Uint8Array(bytes),
            contentType: photo.contentType,
            slot: photo.slot,
          });
        }
      }

      for (const event of await signaturesFor(`inspection:${inspection.id}`)) {
        // One signature block per ceremony, not per vehicle — the same person
        // signs once for the whole load.
        if (signatures.some((s) => s.printedName === event.signerNamePrinted && s.role === event.signerRole)) {
          continue;
        }

        let image: { bytes: Uint8Array; contentType: string } | null = null;
        if (event.signatureStorageKey) {
          const bytes = await store.get(event.signatureStorageKey);
          if (bytes) image = { bytes: new Uint8Array(bytes), contentType: 'image/png' };
        }

        signatures.push({
          role: event.signerRole.replace(/_/g, ' '),
          printedName: event.signerNamePrinted,
          signedAt: event.signedAt,
          image,
          customerUnavailable: event.customerUnavailable,
          authMethod: event.authMethod,
          latitude: event.latitude,
          longitude: event.longitude,
        });
      }
    }

    builtVehicles.push({
      vin: vehicle.vin,
      year: vehicle.year,
      make: vehicle.make,
      model: vehicle.model,
      color: vehicle.color,
      vehicleType: vehicle.vehicleType,
      plate: vehicle.plate,
      plateState: vehicle.plateState,
      lotNumber: vehicle.lotNumber,
      odometer,
      curbWeightLbs: vehicle.curbWeightLbs,
      declaredValueCents: vehicle.declaredValueCents,
      isInoperable: vehicle.isInoperable,
      inoperableReason: vehicle.inoperableReason,
      damages: vehicleDamages,
      photos: vehiclePhotos,
    });
  }

  const lineHaul = load.rateCents;
  const fuel = load.fuelSurchargeCents;
  const total =
    lineHaul === null && fuel === null
      ? null
      : (lineHaul ?? 0) + (fuel ?? 0) - (load.depositCents ?? 0);

  const input: BolInput = {
    kind,
    documentNumber,
    loadNumber: load.number,
    issuedAt: new Date(),

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

    consignor: partyFromVenue(pickupVenue, customer?.name ?? 'Shipper not recorded'),
    consignee: partyFromVenue(deliveryVenue, 'Consignee not recorded'),

    vehicles: builtVehicles,

    charges: {
      lineHaulCents: lineHaul,
      fuelSurchargeCents: fuel,
      accessorialCents: null,
      codAmountCents: load.codAmountCents,
      codMethod: load.codMethod,
      codLocation: load.codLocation,
      depositCents: load.depositCents,
      totalCents: total,
      paymentTerms: load.paymentTerms,
    },

    distanceMiles: load.distanceMiles,
    instructions: load.instructions,
    signatures,
    inspectionContentHash,
    brand: await brandFor(scoped, kind),
  };

  return { input, inspectionIds };
}

/**
 * Renders, hashes and stores the document.
 *
 * Every issue produces a new row rather than replacing one. A reissued bill
 * supersedes its predecessor and both are retained, because the copy someone
 * signed is the one that matters in a dispute even after it is corrected.
 */
export async function generateDocument(options: {
  scoped: ScopedDb;
  loadId: string;
  kind: DocumentKind;
  documentNumber: string;
  supersedesDocumentId?: string | null;
}): Promise<GenerateResult> {
  const assembled = await buildDocumentInput(
    options.scoped,
    options.loadId,
    options.kind,
    options.documentNumber,
  );

  if ('error' in assembled) return { ok: false, error: assembled.error };

  const missing = checkBolRequirements(assembled.input);
  if (missing.length > 0) {
    return {
      ok: false,
      error: 'This load is missing information the regulation requires on a bill of lading.',
      missing,
    };
  }

  const stored = await storeDocument({
    scoped: options.scoped,
    kind: options.kind,
    loadId: options.loadId,
    subject: `load:${options.loadId}`,
    title:
      options.kind === 'bol'
        ? `Bill of lading ${options.documentNumber}`
        : `Delivery receipt ${options.documentNumber}`,
    bytes: await renderBol(assembled.input),
    supersedesDocumentId: options.supersedesDocumentId ?? null,
  });

  if ('error' in stored) return { ok: false, error: stored.error };

  return { ok: true, documentId: stored.documentId, sha256: stored.sha256 };
}
