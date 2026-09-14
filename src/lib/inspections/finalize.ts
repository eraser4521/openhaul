import 'server-only';
import { createHash } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { signatureEvents } from '../db/schema';
import type { Damage, Inspection, InspectionPhoto, InspectionTier } from '../db/schema';
import { PHOTO_REQUIREMENTS } from '../aiag/codes';

/**
 * Sealing an inspection.
 *
 * The output of this is what a carrier relies on years later when a cargo
 * claim lands, so everything here is about making the record reproducible and
 * hard to alter after the fact.
 */

const GENESIS = '0'.repeat(64);

export interface CompletenessProblem {
  kind: 'missing-photos' | 'missing-damage-photos' | 'missing-signature' | 'missing-odometer';
  message: string;
}

/**
 * Checks an inspection against its tier's requirements.
 *
 * The advanced tier's photo floor is what brokers require for
 * payment-guaranteed loads, and it is also the evidentiary bar a Carmack
 * defence actually needs — a sloppy pickup inspection means the carrier eats
 * whatever is found at delivery.
 */
export function checkCompleteness(
  inspection: Inspection,
  photos: InspectionPhoto[],
  damages: Damage[],
  hasSignature: boolean,
): CompletenessProblem[] {
  const rules = PHOTO_REQUIREMENTS[inspection.tier as InspectionTier];
  const problems: CompletenessProblem[] = [];

  const slotPhotos = photos.filter((p) => p.slot !== null);
  if (slotPhotos.length < rules.perStage) {
    problems.push({
      kind: 'missing-photos',
      message: `${rules.perStage} photos are required for a ${inspection.tier} inspection; ${slotPhotos.length} captured.`,
    });
  }

  if (rules.perDamage > 0) {
    const short = damages.filter(
      (damage) => photos.filter((p) => p.damageId === damage.id).length < rules.perDamage,
    );
    if (short.length > 0) {
      problems.push({
        kind: 'missing-damage-photos',
        message: `${short.length} marked defect${short.length === 1 ? '' : 's'} need${
          short.length === 1 ? 's' : ''
        } ${rules.perDamage} photo${rules.perDamage === 1 ? '' : 's'} each.`,
      });
    }
  }

  if (rules.requiresSignature && !hasSignature) {
    problems.push({
      kind: 'missing-signature',
      message: 'A signature is required before this inspection can be sealed.',
    });
  }

  if (inspection.odometer === null) {
    problems.push({
      kind: 'missing-odometer',
      message: 'Record the odometer reading.',
    });
  }

  return problems;
}

/**
 * Hashes the inspection.
 *
 * Covers every photo hash, so adding, removing or swapping a photo changes the
 * result. Field order is fixed rather than taken from object iteration, which
 * keeps the hash stable across engines and across future refactors.
 */
export function computeContentHash(
  inspection: Inspection,
  photos: InspectionPhoto[],
  damages: Damage[],
): string {
  const canonical = {
    id: inspection.id,
    loadId: inspection.loadId,
    vehicleId: inspection.vehicleId,
    stage: inspection.stage,
    tier: inspection.tier,
    odometer: inspection.odometer,
    fuelLevelEighths: inspection.fuelLevelEighths,
    keysPresent: inspection.keysPresent,
    personalItemsPresent: inspection.personalItemsPresent,
    limitationNote: inspection.limitationNote,
    latitude: inspection.latitude,
    longitude: inspection.longitude,
    startedAt: inspection.startedAt?.getTime() ?? null,
    completedAt: inspection.completedAt?.getTime() ?? null,
    // Sorted so capture order cannot change the hash.
    photos: [...photos]
      .map((p) => ({ id: p.id, slot: p.slot, damageId: p.damageId, sha256: p.sha256 }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    damages: [...damages]
      .map((d) => ({
        id: d.id,
        code: d.code,
        codeVersion: d.codeVersion,
        description: d.description,
        preExisting: d.preExisting,
        nonTransportation: d.nonTransportation,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export interface SignatureInput {
  orgId: string;
  subject: string;
  documentSha256: string;
  signerRole: 'driver' | 'shipper' | 'consignee' | 'broker_agent';
  signerNamePrinted: string;
  signerUserId?: string | null;
  authMethod: 'session' | 'otp_sms' | 'otp_email' | 'magic_link' | 'in_person_driver_attested';
  attestingUserId?: string | null;
  intentText: string;
  signatureMethod: 'drawn' | 'typed';
  signatureImageSha256?: string | null;
  signatureStorageKey?: string | null;
  signatureStrokes?: unknown;
  clientClaimedAt?: Date | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  locationAccuracyM?: number | null;
  geoConsent?: boolean;
  customerUnavailable?: boolean;
}

/**
 * Records a signature ceremony.
 *
 * Deliberately verbose, because a rendered signature plus a timestamp has been
 * held insufficient: what matters is being able to narrate the security
 * procedure that links this signature to this person at this moment. Every
 * field here answers part of that.
 *
 * Chained like the audit log, and the table carries append-only triggers.
 */
export async function recordSignature(input: SignatureInput): Promise<string> {
  const signedAt = new Date();

  const intentSha256 = createHash('sha256').update(input.intentText).digest('hex');

  return db.transaction(async (tx) => {
    const [last] = await tx
      .select({ hash: signatureEvents.hash })
      .from(signatureEvents)
      .orderBy(desc(signatureEvents.createdAt))
      .limit(1);

    const prevHash = last?.hash ?? GENESIS;

    const payload = {
      subject: input.subject,
      documentSha256: input.documentSha256,
      signerRole: input.signerRole,
      signerNamePrinted: input.signerNamePrinted,
      authMethod: input.authMethod,
      intentSha256,
      signatureMethod: input.signatureMethod,
      signatureImageSha256: input.signatureImageSha256 ?? null,
      signedAt: signedAt.getTime(),
      clientClaimedAt: input.clientClaimedAt?.getTime() ?? null,
      ipAddress: input.ipAddress ?? null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      customerUnavailable: input.customerUnavailable ?? false,
    };

    const hash = createHash('sha256')
      .update(prevHash)
      .update(JSON.stringify(payload, Object.keys(payload).sort()))
      .digest('hex');

    const [row] = await tx
      .insert(signatureEvents)
      .values({
        orgId: input.orgId,
        subject: input.subject,
        documentSha256: input.documentSha256,
        signerRole: input.signerRole,
        signerNamePrinted: input.signerNamePrinted,
        signerUserId: input.signerUserId ?? null,
        authMethod: input.authMethod,
        attestingUserId: input.attestingUserId ?? null,
        intentText: input.intentText,
        intentSha256,
        signatureMethod: input.signatureMethod,
        signatureImageSha256: input.signatureImageSha256 ?? null,
        signatureStorageKey: input.signatureStorageKey ?? null,
        signatureStrokes: input.signatureStrokes ?? null,
        signedAt,
        // Recorded, never trusted. The skew between device and server clock is
        // itself evidence.
        clientClaimedAt: input.clientClaimedAt ?? null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        locationAccuracyM: input.locationAccuracyM ?? null,
        geoConsent: input.geoConsent ?? false,
        customerUnavailable: input.customerUnavailable ?? false,
        prevHash,
        hash,
      })
      .returning({ id: signatureEvents.id });

    if (!row) throw new Error('failed to record the signature');
    return row.id;
  });
}

/** Signatures already recorded against an inspection. */
export async function signaturesFor(subject: string) {
  return db.select().from(signatureEvents).where(eq(signatureEvents.subject, subject));
}

/**
 * The exact wording a signer agrees to.
 *
 * Stored by hash with every signature so it can be reproduced years later —
 * a consent whose text you cannot produce is a consent you cannot rely on.
 */
export function intentTextFor(
  stage: 'pickup' | 'delivery',
  vin: string,
  damageCount: number,
): string {
  const condition =
    damageCount === 0
      ? 'no damage was noted'
      : `${damageCount} item${damageCount === 1 ? '' : 's'} of damage ${
          damageCount === 1 ? 'was' : 'were'
        } noted`;

  return stage === 'pickup'
    ? `I confirm I have inspected vehicle ${vin} and that the photographs and damage markings in ` +
        `this report accurately reflect its condition at the time of pickup, where ${condition}. ` +
        `I intend this electronic signature to have the same effect as a handwritten one.`
    : `I confirm I have received vehicle ${vin} and inspected it on delivery, and that the ` +
        `photographs and damage markings in this report accurately reflect its condition, where ` +
        `${condition}. I understand that damage not noted now may not be claimable later. ` +
        `I intend this electronic signature to have the same effect as a handwritten one.`;
}
