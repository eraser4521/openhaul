'use server';

import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  damages as damagesTable,
  inspections as inspectionsTable,
  inspectionPhotos as photosTable,
  loads as loadsTable,
  vehicles as vehiclesTable,
  FROZEN_STATUSES,
} from '@/lib/db/schema';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import { clientAddress, clientUserAgent } from '@/lib/auth/session';
import { appendAudit, AUDIT } from '@/lib/audit/chain';
import { blobStore } from '@/lib/storage/blob-store';
import {
  AIAG_CODE_VERSION,
  composeDamageCode,
  parseDamageCode,
} from '@/lib/aiag/codes';
import {
  checkCompleteness,
  computeContentHash,
  intentTextFor,
  recordSignature,
  signaturesFor,
} from '@/lib/inspections/finalize';

export interface InspectResult {
  ok: boolean;
  error?: string;
  inspectionId?: string;
  problems?: string[];
}

/** Rejects a change to an inspection that has already been signed. */
function frozen(inspection: { finalizedAt: Date | null; status: string }): boolean {
  return (
    inspection.finalizedAt !== null ||
    FROZEN_STATUSES.includes(inspection.status as (typeof FROZEN_STATUSES)[number])
  );
}

const startSchema = z.object({
  loadId: z.string().min(1),
  vehicleId: z.string().min(1),
  stage: z.enum(['pickup', 'delivery']),
  latitude: z.string().nullable().optional(),
  longitude: z.string().nullable().optional(),
  locationAccuracyM: z.coerce.number().int().nullable().optional(),
});

/**
 * Opens an inspection, or resumes the one already in progress.
 *
 * Resuming rather than creating a second row matters: a driver whose phone
 * died halfway through a walk-around should come back to the photos they
 * already took, not start again.
 */
export async function startInspectionAction(input: unknown): Promise<InspectResult> {
  let context;
  try {
    context = await requireCapability('inspection.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const parsed = startSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Missing load or vehicle.' };

  const { session, db } = context;
  const { loadId, vehicleId, stage } = parsed.data;

  const vehicle = await db.selectOne('vehicles', eq(vehiclesTable.id, vehicleId));
  if (!vehicle || vehicle.loadId !== loadId) {
    return { ok: false, error: 'That vehicle is not on this load.' };
  }

  const [existing] = await db.select(
    'inspections',
    and(eq(inspectionsTable.vehicleId, vehicleId), eq(inspectionsTable.stage, stage)),
  );

  if (existing) {
    if (frozen(existing)) {
      return {
        ok: false,
        error: 'This vehicle has already been inspected and signed for at this stage.',
      };
    }
    return { ok: true, inspectionId: existing.id };
  }

  const load = await db.selectOne('loads', eq(loadsTable.id, loadId));

  const [created] = await db.insert('inspections', {
    loadId,
    vehicleId,
    stage,
    tier: load?.inspectionTier ?? 'advanced',
    status: 'in_progress',
    startedAt: new Date(),
    latitude: parsed.data.latitude ?? null,
    longitude: parsed.data.longitude ?? null,
    locationAccuracyM: parsed.data.locationAccuracyM ?? null,
    locationSource: parsed.data.latitude ? 'gps' : null,
  });

  if (!created) return { ok: false, error: 'The inspection could not be started.' };

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.inspectionStarted,
    subject: `inspection:${created.id}`,
    detail: { loadId, vehicleId, stage, vin: vehicle.vin },
  });

  return { ok: true, inspectionId: created.id };
}

const detailsSchema = z.object({
  inspectionId: z.string().min(1),
  odometer: z.coerce.number().int().min(0).max(2_000_000).nullable().optional(),
  fuelLevelEighths: z.coerce.number().int().min(0).max(8).nullable().optional(),
  keysPresent: z.boolean().nullable().optional(),
  personalItemsPresent: z.boolean().nullable().optional(),
  personalItemsNote: z.string().trim().max(1000).nullable().optional(),
  limitationNote: z.string().trim().max(1000).nullable().optional(),
});

export async function saveInspectionDetailsAction(input: unknown): Promise<InspectResult> {
  let context;
  try {
    context = await requireCapability('inspection.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const parsed = detailsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Those values are not valid.' };

  const { db } = context;
  const { inspectionId, ...fields } = parsed.data;

  const inspection = await db.selectOne('inspections', eq(inspectionsTable.id, inspectionId));
  if (!inspection) return { ok: false, error: 'No such inspection.' };
  if (frozen(inspection)) {
    return { ok: false, error: 'This inspection is signed and cannot be changed.' };
  }

  await db.update('inspections', eq(inspectionsTable.id, inspectionId), {
    ...fields,
    version: inspection.version + 1,
  });

  return { ok: true, inspectionId };
}

const damageSchema = z.object({
  inspectionId: z.string().min(1),
  areaCode: z.string().regex(/^\d{2}$/),
  typeCode: z.string().regex(/^\d{2}$/),
  severityCode: z.string().regex(/^[1-6]$/),
  gridCode: z.string().regex(/^[1-9]$/).nullable().optional(),
  description: z.string().trim().max(1000).optional(),
  diagramView: z.enum(['front', 'rear', 'left', 'right', 'top', 'interior']).nullable().optional(),
  diagramX: z.string().nullable().optional(),
  diagramY: z.string().nullable().optional(),
  preExisting: z.boolean().optional(),
  nonTransportation: z.boolean().optional(),
});

export async function addDamageAction(
  input: unknown,
): Promise<InspectResult & { damageId?: string }> {
  let context;
  try {
    context = await requireCapability('inspection.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const parsed = damageSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'That damage code is not valid.' };

  const { session, db } = context;
  const data = parsed.data;

  const inspection = await db.selectOne('inspections', eq(inspectionsTable.id, data.inspectionId));
  if (!inspection) return { ok: false, error: 'No such inspection.' };
  if (frozen(inspection)) {
    return { ok: false, error: 'This inspection is signed and cannot be changed.' };
  }

  const code = composeDamageCode(
    data.areaCode,
    data.typeCode,
    data.severityCode,
    data.gridCode ?? null,
  );
  if (!code) return { ok: false, error: 'That combination is not a recognised AIAG code.' };

  const [created] = await db.insert('damages', {
    inspectionId: data.inspectionId,
    code,
    areaCode: data.areaCode,
    typeCode: data.typeCode,
    severityCode: data.severityCode,
    gridCode: data.gridCode ?? null,
    codeVersion: AIAG_CODE_VERSION,
    description: data.description || null,
    diagramView: data.diagramView ?? null,
    diagramX: data.diagramX ?? null,
    diagramY: data.diagramY ?? null,
    // At pickup, anything found was already there — which is exactly what
    // clears the carrier of it later.
    preExisting: data.preExisting ?? inspection.stage === 'pickup',
    nonTransportation: data.nonTransportation ?? false,
  });

  if (!created) return { ok: false, error: 'The damage could not be recorded.' };

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.damageAdded,
    subject: `inspection:${data.inspectionId}`,
    detail: { damageId: created.id, code, describe: parseDamageCode(code)?.area.label },
  });

  return { ok: true, damageId: created.id, inspectionId: data.inspectionId };
}

export async function removeDamageAction(
  inspectionId: string,
  damageId: string,
): Promise<InspectResult> {
  let context;
  try {
    context = await requireCapability('inspection.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const { db } = context;
  const inspection = await db.selectOne('inspections', eq(inspectionsTable.id, inspectionId));
  if (!inspection) return { ok: false, error: 'No such inspection.' };
  if (frozen(inspection)) {
    return { ok: false, error: 'This inspection is signed and cannot be changed.' };
  }

  await db.remove('damages', eq(damagesTable.id, damageId));
  return { ok: true, inspectionId };
}

/**
 * Damages captured on the device.
 *
 * Sent with the finalize call rather than one request each, so the whole
 * walk-around works with no signal and needs the network exactly once — at
 * the moment of sealing, which requires it anyway.
 */
const capturedDamageSchema = z.object({
  areaCode: z.string().regex(/^\d{2}$/),
  typeCode: z.string().regex(/^\d{2}$/),
  severityCode: z.string().regex(/^[1-6]$/),
  gridCode: z.string().regex(/^[1-9]$/).nullable().optional(),
  description: z.string().trim().max(1000).optional(),
  nonTransportation: z.boolean().optional(),
});

const finalizeSchema = z.object({
  inspectionId: z.string().min(1),
  details: z
    .object({
      odometer: z.coerce.number().int().min(0).max(2_000_000).nullable().optional(),
      fuelLevelEighths: z.coerce.number().int().min(0).max(8).nullable().optional(),
      keysPresent: z.boolean().nullable().optional(),
      personalItemsPresent: z.boolean().nullable().optional(),
      personalItemsNote: z.string().trim().max(1000).nullable().optional(),
      limitationNote: z.string().trim().max(1000).nullable().optional(),
    })
    .optional(),
  damages: z.array(capturedDamageSchema).max(60).optional(),
  signerName: z.string().trim().min(2, 'Enter the signer’s name.').max(120),
  signerRole: z.enum(['driver', 'shipper', 'consignee', 'broker_agent']),
  signatureMethod: z.enum(['drawn', 'typed']),
  /** PNG data URL from the signature pad. */
  signatureImage: z.string().max(2_000_000).nullable().optional(),
  signatureStrokes: z.unknown().optional(),
  customerUnavailable: z.boolean().optional(),
  clientClaimedAt: z.coerce.number().int().nullable().optional(),
  latitude: z.string().nullable().optional(),
  longitude: z.string().nullable().optional(),
  locationAccuracyM: z.coerce.number().int().nullable().optional(),
  geoConsent: z.boolean().optional(),
});

/**
 * Seals the inspection.
 *
 * Hashes the record including every photo, records the signature ceremony
 * against that hash, and freezes the row. From here a correction is an
 * amendment, never an edit.
 */
export async function finalizeInspectionAction(input: unknown): Promise<InspectResult> {
  let context;
  try {
    context = await requireCapability('inspection.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const parsed = finalizeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Those details are not valid.' };
  }

  const { session, db } = context;
  const data = parsed.data;

  const inspection = await db.selectOne('inspections', eq(inspectionsTable.id, data.inspectionId));
  if (!inspection) return { ok: false, error: 'No such inspection.' };
  if (frozen(inspection)) {
    return { ok: false, error: 'This inspection has already been signed.' };
  }

  const vehicle = await db.selectOne('vehicles', eq(vehiclesTable.id, inspection.vehicleId));
  if (!vehicle) return { ok: false, error: 'The vehicle record is missing.' };

  // Everything captured on the device lands before anything is hashed, so the
  // content hash covers the complete record rather than a partial one.
  if (data.details) {
    await db.update('inspections', eq(inspectionsTable.id, inspection.id), data.details);
  }

  if (data.damages && data.damages.length > 0) {
    // Replace rather than append: a retried finalize after a lost response
    // must not double every defect on the report.
    await db.remove('damages', eq(damagesTable.inspectionId, inspection.id));

    const rows = data.damages.flatMap((damage) => {
      const composed = composeDamageCode(
        damage.areaCode,
        damage.typeCode,
        damage.severityCode,
        damage.gridCode ?? null,
      );
      if (!composed) return [];
      return [{
        inspectionId: inspection.id,
        code: composed,
        areaCode: damage.areaCode,
        typeCode: damage.typeCode,
        severityCode: damage.severityCode,
        gridCode: damage.gridCode ?? null,
        codeVersion: AIAG_CODE_VERSION,
        description: damage.description || null,
        preExisting: inspection.stage === 'pickup',
        nonTransportation: damage.nonTransportation ?? false,
      }];
    });

    await db.insertMany('damages', rows);
  }

  const refreshed = await db.selectOne('inspections', eq(inspectionsTable.id, inspection.id));
  const current = refreshed ?? inspection;

  const [photos, damageRows, existingSignatures] = await Promise.all([
    db.select('inspectionPhotos', eq(photosTable.inspectionId, inspection.id)),
    db.select('damages', eq(damagesTable.inspectionId, inspection.id)),
    signaturesFor(`inspection:${inspection.id}`),
  ]);

  const problems = checkCompleteness(current, photos, damageRows, existingSignatures.length > 0);
  // The signature being collected now satisfies its own requirement.
  const blocking = problems.filter((p) => p.kind !== 'missing-signature');
  if (blocking.length > 0) {
    return { ok: false, error: 'This inspection is not complete yet.', problems: blocking.map((p) => p.message) };
  }

  // Hashed before the signature is taken, so what was signed is exactly what
  // was on screen — not a document reassembled afterwards.
  const contentHash = computeContentHash(
    { ...current, completedAt: new Date() },
    photos,
    damageRows,
  );

  let signatureStorageKey: string | null = null;
  let signatureImageSha256: string | null = null;

  if (data.signatureImage) {
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(data.signatureImage);
    if (!match?.[1]) return { ok: false, error: 'The signature image is not readable.' };

    const bytes = Buffer.from(match[1], 'base64');
    const stored = await blobStore().put(bytes, 'image/png', 'signatures');
    signatureStorageKey = stored.key;
    signatureImageSha256 = stored.sha256;
  }

  const intentText = intentTextFor(inspection.stage, vehicle.vin, damageRows.length);

  const signatureId = await recordSignature({
    orgId: session.orgId,
    subject: `inspection:${inspection.id}`,
    documentSha256: contentHash,
    signerRole: data.signerRole,
    signerNamePrinted: data.signerName,
    signerUserId: data.signerRole === 'driver' ? session.userId : null,
    // A walk-up consignee has no account, so the driver attests to having
    // handed them the device. That is weaker than an authenticated signature
    // and is recorded as exactly that rather than dressed up.
    authMethod: data.signerRole === 'driver' ? 'session' : 'in_person_driver_attested',
    attestingUserId: data.signerRole === 'driver' ? null : session.userId,
    intentText,
    signatureMethod: data.signatureMethod,
    signatureImageSha256,
    signatureStorageKey,
    signatureStrokes: data.signatureStrokes ?? null,
    clientClaimedAt: data.clientClaimedAt ? new Date(data.clientClaimedAt) : null,
    ipAddress: await clientAddress(),
    userAgent: await clientUserAgent(),
    latitude: data.latitude ?? inspection.latitude,
    longitude: data.longitude ?? inspection.longitude,
    locationAccuracyM: data.locationAccuracyM ?? inspection.locationAccuracyM,
    geoConsent: data.geoConsent ?? false,
    customerUnavailable: data.customerUnavailable ?? false,
  });

  await db.update('inspections', eq(inspectionsTable.id, inspection.id), {
    status: 'finalized',
    completedAt: new Date(),
    finalizedAt: new Date(),
    contentHash,
    version: current.version + 1,
  });

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.inspectionFinalized,
    subject: `inspection:${inspection.id}`,
    detail: {
      contentHash,
      signatureId,
      photoCount: photos.length,
      damageCount: damageRows.length,
      intentSha256: createHash('sha256').update(intentText).digest('hex'),
    },
  });

  revalidatePath(`/loads/${inspection.loadId}`);
  revalidatePath('/inspections');

  return { ok: true, inspectionId: inspection.id };
}
