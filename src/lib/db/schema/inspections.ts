import { sqliteTable, text, integer, index, uniqueIndex, foreignKey } from 'drizzle-orm/sqlite-core';
import { bool, json, orgId, pk, timestamps, ts } from '../columns';
import { loads, vehicles, drivers, STOP_KINDS } from './operations';

export const INSPECTION_STATUSES = ['draft', 'in_progress', 'signed', 'finalized', 'void'] as const;
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];

/** Statuses after which the record is legally frozen. */
export const FROZEN_STATUSES: InspectionStatus[] = ['signed', 'finalized'];

/**
 * A vehicle condition report: one per vehicle, per leg.
 *
 * This is the evidentiary heart of the app. Under the Carmack Amendment a
 * shipper makes a prima facie case by showing the vehicle went onto the truck
 * in good condition; the pickup inspection is the only record that answers
 * that. A missing or sloppy pickup inspection means the carrier eats whatever
 * is found at delivery.
 */
export const inspections = sqliteTable(
  'inspections',
  {
    id: pk(),
    orgId: orgId(),
    loadId: text('load_id').notNull(),
    vehicleId: text('vehicle_id').notNull(),

    stage: text('stage', { enum: STOP_KINDS }).notNull(),
    tier: text('tier', { enum: ['standard', 'advanced', 'aiag'] }).notNull().default('advanced'),
    status: text('status', { enum: INSPECTION_STATUSES }).notNull().default('draft'),

    driverId: text('driver_id'),

    odometer: integer('odometer'),
    fuelLevelEighths: integer('fuel_level_eighths'),
    keysPresent: bool('keys_present'),
    personalItemsPresent: bool('personal_items_present'),
    personalItemsNote: text('personal_items_note'),

    /**
     * Recorded when conditions prevented a complete inspection — darkness,
     * snow, dirt, restricted access. The standard is explicit that damage
     * missed because a vehicle was dirty is NOT concealed damage, so writing
     * the limitation down at pickup is what preserves the carrier's position.
     */
    limitationNote: text('limitation_note'),

    /** Location fix at the moment of inspection, for evidentiary weight. */
    latitude: text('latitude'),
    longitude: text('longitude'),
    locationAccuracyM: integer('location_accuracy_m'),
    locationSource: text('location_source', { enum: ['gps', 'network', 'manual'] }),

    /** Server clock. Authoritative. */
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
    /** Device clock as reported. Kept to record the skew, never trusted. */
    clientClaimedAt: ts('client_claimed_at'),

    /** Set once signed; the record is immutable from this point. */
    finalizedAt: ts('finalized_at'),
    /** SHA-256 over the canonical serialisation, including every photo hash. */
    contentHash: text('content_hash'),

    /** Set when this report corrects an already-finalized one. */
    amendsInspectionId: text('amends_inspection_id'),
    amendmentReason: text('amendment_reason'),

    /** Client-generated so an offline device can create without a round trip. */
    createdOffline: bool('created_offline').notNull().default(false),
    /** Optimistic concurrency guard for the sync path. */
    version: integer('version').notNull().default(1),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('inspections_org_id_uq').on(t.orgId, t.id),
    index('inspections_load_idx').on(t.loadId),
    index('inspections_vehicle_stage_idx').on(t.vehicleId, t.stage),
    foreignKey({
      columns: [t.orgId, t.loadId],
      foreignColumns: [loads.orgId, loads.id],
      name: 'inspections_load_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.vehicleId],
      foreignColumns: [vehicles.orgId, vehicles.id],
      name: 'inspections_vehicle_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.driverId],
      foreignColumns: [drivers.orgId, drivers.id],
      name: 'inspections_driver_fk',
    }),
  ],
);

/**
 * A photo attached to an inspection.
 *
 * The original bytes are stored immutably and never served. EXIF is extracted
 * into columns at ingest and the served derivative is re-encoded and stripped
 * — which resolves the conflict between "strip EXIF for privacy and safety"
 * and "the EXIF timestamp and GPS are the evidence".
 */
export const inspectionPhotos = sqliteTable(
  'inspection_photos',
  {
    id: pk(),
    orgId: orgId(),
    inspectionId: text('inspection_id').notNull(),

    /** Which shot in the guided walk-around this satisfies. */
    slot: text('slot'),
    /** Set when the photo documents a specific damage rather than a slot. */
    damageId: text('damage_id'),

    /** Content-addressed storage key; the SHA is the identity. */
    storageKey: text('storage_key').notNull(),
    sha256: text('sha256').notNull(),
    byteSize: integer('byte_size').notNull(),
    contentType: text('content_type').notNull(),
    width: integer('width'),
    height: integer('height'),

    /** Extracted from the original before re-encoding. */
    exifCapturedAt: ts('exif_captured_at'),
    exifLatitude: text('exif_latitude'),
    exifLongitude: text('exif_longitude'),
    exifDevice: text('exif_device'),

    /** Position fix at capture, from the browser rather than the file. */
    capturedLatitude: text('captured_latitude'),
    capturedLongitude: text('captured_longitude'),

    /**
     * True when the capture happened within a mile of the stop. Carrier
     * scorecards on the paid platforms grade exactly this.
     */
    withinGeofence: bool('within_geofence'),

    uploadedAt: ts('uploaded_at'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('inspection_photos_org_id_uq').on(t.orgId, t.id),
    index('inspection_photos_inspection_idx').on(t.inspectionId),
    // Same bytes uploaded twice within a tenant resolve to one row.
    uniqueIndex('inspection_photos_org_sha_uq').on(t.orgId, t.inspectionId, t.sha256),
    foreignKey({
      columns: [t.orgId, t.inspectionId],
      foreignColumns: [inspections.orgId, inspections.id],
      name: 'inspection_photos_inspection_fk',
    }).onDelete('cascade'),
  ],
);

/** A single marked defect, coded to AIAG M-22. */
export const damages = sqliteTable(
  'damages',
  {
    id: pk(),
    orgId: orgId(),
    inspectionId: text('inspection_id').notNull(),

    /** Five or six digits: area, type, severity, optional grid. */
    code: text('code').notNull(),
    areaCode: text('area_code').notNull(),
    typeCode: text('type_code').notNull(),
    severityCode: text('severity_code').notNull(),
    gridCode: text('grid_code'),
    /** Version of the AIAG table this was coded against. */
    codeVersion: text('code_version').notNull(),

    /**
     * Free text. An abbreviation alone is weak evidence; "six-inch scratch on
     * the driver's door below the handle" is what holds up.
     */
    description: text('description'),

    /** Normalised 0-1 position on the vehicle diagram, for the marker pin. */
    diagramX: text('diagram_x'),
    diagramY: text('diagram_y'),
    diagramView: text('diagram_view', {
      enum: ['front', 'rear', 'left', 'right', 'top', 'interior'],
    }),

    /** Recorded at pickup means it was already there; the carrier is clear. */
    preExisting: bool('pre_existing').notNull().default(false),
    /** Flagged as one of the standard's non-transportation conditions. */
    nonTransportation: bool('non_transportation').notNull().default(false),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('damages_org_id_uq').on(t.orgId, t.id),
    index('damages_inspection_idx').on(t.inspectionId),
    foreignKey({
      columns: [t.orgId, t.inspectionId],
      foreignColumns: [inspections.orgId, inspections.id],
      name: 'damages_inspection_fk',
    }).onDelete('cascade'),
  ],
);

export const SIGNER_ROLES = ['driver', 'shipper', 'consignee', 'broker_agent'] as const;
export type SignerRole = (typeof SIGNER_ROLES)[number];

export const AUTH_METHODS = [
  'session',
  'otp_sms',
  'otp_email',
  'magic_link',
  'in_person_driver_attested',
] as const;

/**
 * A signature ceremony.
 *
 * A rendered signature image plus a timestamp is not enough — courts have
 * rejected exactly that, because nobody could explain the security procedure
 * linking the signature to the person. Every field here exists so that chain
 * can be narrated end to end.
 */
export const signatureEvents = sqliteTable(
  'signature_events',
  {
    id: pk(),
    orgId: orgId(),

    /** What was signed: 'inspection:<id>' or 'bol:<id>'. */
    subject: text('subject').notNull(),
    documentVersion: integer('document_version').notNull().default(1),
    /**
     * SHA-256 of the exact bytes presented on screen for signing, computed
     * before the signature was taken. Without this you can only prove that
     * someone signed something.
     */
    documentSha256: text('document_sha256').notNull(),

    signerRole: text('signer_role', { enum: SIGNER_ROLES }).notNull(),
    signerNamePrinted: text('signer_name_printed').notNull(),
    /** Null for a walk-up consignee with no account. */
    signerUserId: text('signer_user_id'),
    signerEmail: text('signer_email'),
    signerPhone: text('signer_phone'),

    /** How the signer's identity was established. */
    authMethod: text('auth_method', { enum: AUTH_METHODS }).notNull(),
    /** The OTP or link challenge that was satisfied, when applicable. */
    authEvidenceId: text('auth_evidence_id'),
    /** Who handed over the device, for an in-person signature. */
    attestingUserId: text('attesting_user_id'),

    /** The exact on-screen wording the signer agreed to. */
    intentText: text('intent_text').notNull(),
    intentSha256: text('intent_sha256').notNull(),

    signatureMethod: text('signature_method', { enum: ['drawn', 'typed'] }).notNull(),
    signatureImageSha256: text('signature_image_sha256'),
    signatureStorageKey: text('signature_storage_key'),
    /**
     * Stroke points with timing and pressure. Far harder to forge than a
     * flattened image, and it is what distinguishes a real signature from a
     * pasted one.
     */
    signatureStrokes: json<unknown>('signature_strokes'),

    /** Server clock. Authoritative. */
    signedAt: ts('signed_at').notNull(),
    /** Device clock as reported; the skew is itself evidence. */
    clientClaimedAt: ts('client_claimed_at'),

    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    deviceFingerprint: text('device_fingerprint'),

    latitude: text('latitude'),
    longitude: text('longitude'),
    locationAccuracyM: integer('location_accuracy_m'),
    geoConsent: bool('geo_consent').notNull().default(false),

    /** Links into the tamper-evident chain. */
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),

    /** Customer refused or was unavailable; driver attested instead. */
    customerUnavailable: bool('customer_unavailable').notNull().default(false),

    createdAt: ts('created_at')
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('signature_events_org_id_uq').on(t.orgId, t.id),
    index('signature_events_subject_idx').on(t.subject),
  ],
);

export type Inspection = typeof inspections.$inferSelect;
export type InspectionPhoto = typeof inspectionPhotos.$inferSelect;
export type Damage = typeof damages.$inferSelect;
export type SignatureEvent = typeof signatureEvents.$inferSelect;
