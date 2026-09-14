import { sqliteTable, text, integer, index, uniqueIndex, foreignKey } from 'drizzle-orm/sqlite-core';
import { bool, json, money, orgId, pk, timestamps, ts } from '../columns';
import { organizations, users } from './auth';
import { customers, loads } from './operations';

export const DOCUMENT_KINDS = [
  'bol',
  'pod',
  'rate_confirmation',
  'dispatch_sheet',
  'invoice',
  'gate_pass',
  'auction_release',
  'w9',
  'insurance_certificate',
  'inspection_report',
  // The letters 49 CFR Part 370 obliges a carrier to send on a cargo claim.
  // Each one exists to prove a date, so each is frozen like any other record.
  'claim_acknowledgement',
  'claim_status',
  'claim_disposition',
  'settlement',
  'credit_note',
  'other',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/**
 * A generated document, stored as the exact bytes that were rendered.
 *
 * Regenerating a 2026 bill of lading from a 2033 template does not reproduce
 * the 2026 record, and ESIGN requires records remain "capable of being
 * accurately reproduced". So the PDF is frozen at finalisation, hashed, and
 * treated as the record; regeneration is only a fallback.
 */
export const documents = sqliteTable(
  'documents',
  {
    id: pk(),
    orgId: orgId(),
    kind: text('kind', { enum: DOCUMENT_KINDS }).notNull(),

    loadId: text('load_id'),
    /** e.g. 'invoice:0192f...' when not attached to a load. */
    subject: text('subject'),

    title: text('title').notNull(),
    storageKey: text('storage_key').notNull(),
    sha256: text('sha256').notNull(),
    byteSize: integer('byte_size').notNull(),
    contentType: text('content_type').notNull().default('application/pdf'),

    /** Bumped when a new revision supersedes this one. */
    version: integer('version').notNull().default(1),
    supersedesDocumentId: text('supersedes_document_id'),

    /** Frozen documents can never be modified, only superseded. */
    finalizedAt: ts('finalized_at'),

    /**
     * Unlocks only when the driver is near the pickup. Gate passes and auction
     * releases are theft vectors if they are readable from anywhere.
     */
    locationProtected: bool('location_protected').notNull().default(false),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('documents_org_id_uq').on(t.orgId, t.id),
    index('documents_org_load_idx').on(t.orgId, t.loadId),
    index('documents_subject_idx').on(t.subject),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'documents_org_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Tamper-evident audit log.
 *
 * Each entry hashes the one before it. Altering or removing a row breaks the
 * chain at a detectable point. Append-only is additionally enforced by SQLite
 * triggers — see the hand-written migration in drizzle/.
 *
 * A trigger stops the application and a careless operator; it does not stop
 * someone with write access to the database file, who can drop the trigger.
 * The chain is what detects that, and only if the head hash is anchored
 * somewhere they do not control.
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    /** Chain order. Autoincrement guarantees monotonicity. */
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull(),

    orgId: text('org_id').notNull(),
    /** Null for system-initiated actions. */
    actorId: text('actor_id'),
    actorRole: text('actor_role'),

    /** e.g. 'bol.sign', 'load.void', 'pii.decrypt'. */
    action: text('action').notNull(),
    /** e.g. 'load:0192f...'. */
    subject: text('subject').notNull(),
    outcome: text('outcome', { enum: ['success', 'failure', 'denied'] }).notNull(),

    /**
     * Redacted, structured detail. Never decrypted PII: the audit log is the
     * one table that cannot be purged, so PII here defeats erasure entirely.
     */
    detail: json<Record<string, unknown>>('detail'),

    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),

    at: ts('at').notNull(),

    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [
    index('audit_log_org_at_idx').on(t.orgId, t.at),
    index('audit_log_subject_idx').on(t.subject),
    index('audit_log_action_idx').on(t.action),
  ],
);

/**
 * Periodic anchor of the audit chain head.
 *
 * A chain that only exists inside the database it protects proves very little.
 * These rows are exported nightly to separate storage.
 */
export const auditAnchors = sqliteTable('audit_anchors', {
  id: pk(),
  headSeq: integer('head_seq').notNull(),
  headHash: text('head_hash').notNull(),
  entryCount: integer('entry_count').notNull(),
  anchoredAt: ts('anchored_at').notNull(),
  exportedTo: text('exported_to'),
});

export const CLAIM_STATUSES = [
  'filed',
  'acknowledged',
  'investigating',
  'offered',
  'paid',
  'declined',
  'withdrawn',
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/**
 * A cargo damage claim.
 *
 * Two sections, not one: 49 CFR 370.5 requires written acknowledgement within
 * 30 days, and 370.9 requires the carrier to pay, decline, or make a firm
 * compromise settlement offer within 120 days, with status letters every 60
 * days after while the claim stays open. Most small carriers miss the 30-day
 * acknowledgement, so the deadlines are stored as real dates and surfaced.
 */
export const claims = sqliteTable(
  'claims',
  {
    id: pk(),
    orgId: orgId(),
    number: text('number').notNull(),

    loadId: text('load_id'),
    vehicleId: text('vehicle_id'),
    customerId: text('customer_id'),

    status: text('status', { enum: CLAIM_STATUSES }).notNull().default('filed'),

    /**
     * A damage notation or inspection report is NOT a claim under 49 CFR
     * 370.3(c). A valid claim is written, identifies the shipment, asserts
     * carrier liability, and demands a specific or determinable amount.
     */
    claimantName: text('claimant_name').notNull(),
    claimantEmail: text('claimant_email'),
    demandAmountCents: money('demand_amount_cents'),
    description: text('description').notNull(),

    filedAt: ts('filed_at').notNull(),
    /** filedAt + 30 days. */
    acknowledgeDueAt: ts('acknowledge_due_at').notNull(),
    acknowledgedAt: ts('acknowledged_at'),
    /** filedAt + 120 days. */
    resolveDueAt: ts('resolve_due_at').notNull(),
    /** Next 60-day status letter. */
    nextStatusDueAt: ts('next_status_due_at'),

    offerAmountCents: money('offer_amount_cents'),
    offeredAt: ts('offered_at'),
    settledAmountCents: money('settled_amount_cents'),
    settledAt: ts('settled_at'),
    declinedAt: ts('declined_at'),
    declineReason: text('decline_reason'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('claims_org_id_uq').on(t.orgId, t.id),
    uniqueIndex('claims_org_number_uq').on(t.orgId, t.number),
    index('claims_org_status_idx').on(t.orgId, t.status),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'claims_org_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.loadId],
      foreignColumns: [loads.orgId, loads.id],
      name: 'claims_load_fk',
    }),
    foreignKey({
      columns: [t.orgId, t.customerId],
      foreignColumns: [customers.orgId, customers.id],
      name: 'claims_customer_fk',
    }),
  ],
);

/**
 * Certificate of insurance tracking.
 *
 * Cargo insurance for general freight is NOT filed with FMCSA — the filing
 * requirement was suspended, and auto transport is general freight. So the
 * coverage that actually matters when a Porsche gets scratched is contractual
 * and can only be verified from an uploaded certificate.
 */
export const insuranceCertificates = sqliteTable(
  'insurance_certificates',
  {
    id: pk(),
    orgId: orgId(),
    /** Null when this is the organisation's own certificate. */
    customerId: text('customer_id'),

    kind: text('kind', { enum: ['cargo', 'liability', 'physical_damage', 'workers_comp'] }).notNull(),
    insurerName: text('insurer_name').notNull(),
    policyNumber: text('policy_number').notNull(),
    coverageLimitCents: money('coverage_limit_cents'),
    deductibleCents: money('deductible_cents'),

    effectiveAt: ts('effective_at').notNull(),
    expiresAt: ts('expires_at').notNull(),

    documentId: text('document_id'),
    verifiedAt: ts('verified_at'),
    verifiedByUserId: text('verified_by_user_id').references(() => users.id),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('insurance_certificates_org_id_uq').on(t.orgId, t.id),
    // Drives the 30/14/7/0-day expiry alerts.
    index('insurance_certificates_expiry_idx').on(t.orgId, t.expiresAt),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'insurance_certificates_org_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Cached FMCSA authority lookups.
 *
 * The QCMobile service has had extended outages, so results are cached and
 * signup or dispatch never hard-fails on its availability.
 */
/**
 * One attempt at sending a document to somebody.
 *
 * Separate from the document because the same bill of lading goes to a
 * shipper, a consignee and a broker, on different days, with different
 * outcomes — and because what is worth keeping is the attempt, not a flag
 * saying "sent" that cannot say to whom or when.
 *
 * Failures are recorded as well as successes. "We tried on the ninth and the
 * server rejected the address" is a fact somebody needs later; silently
 * dropping it leaves a gap that reads like nobody bothered.
 *
 * `documentSha256` is copied here deliberately. It is the evidence that the
 * bytes attached to that email are the bytes still on disk under that id.
 */
export const SEND_STATUSES = ['sent', 'failed'] as const;
export type SendStatus = (typeof SEND_STATUSES)[number];

export const documentSends = sqliteTable(
  'document_sends',
  {
    id: pk(),
    orgId: orgId(),
    documentId: text('document_id').notNull(),

    toAddresses: json<string[]>('to_addresses').notNull(),
    ccAddresses: json<string[]>('cc_addresses'),
    subject: text('subject').notNull(),
    body: text('body').notNull(),

    status: text('status', { enum: SEND_STATUSES }).notNull(),
    /** What the receiving server called it. Null on failure. */
    messageId: text('message_id'),
    error: text('error'),

    /** The document's hash at the moment it was attached. */
    documentSha256: text('document_sha256').notNull(),

    actorId: text('actor_id'),
    attemptedAt: ts('attempted_at').notNull(),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('document_sends_org_id_uq').on(t.orgId, t.id),
    index('document_sends_document_idx').on(t.documentId),
    foreignKey({
      columns: [t.orgId, t.documentId],
      foreignColumns: [documents.orgId, documents.id],
      name: 'document_sends_document_fk',
    }).onDelete('cascade'),
  ],
);

export const carrierChecks = sqliteTable(
  'carrier_checks',
  {
    id: pk(),
    orgId: orgId(),
    customerId: text('customer_id'),

    usdotNumber: text('usdot_number').notNull(),
    mcNumber: text('mc_number'),

    legalName: text('legal_name'),
    dbaName: text('dba_name'),
    allowedToOperate: bool('allowed_to_operate'),
    outOfService: bool('out_of_service'),
    outOfServiceAt: ts('out_of_service_at'),
    safetyRating: text('safety_rating'),

    source: text('source', { enum: ['qcmobile', 'socrata', 'manual'] }).notNull(),
    raw: json<Record<string, unknown>>('raw'),
    checkedAt: ts('checked_at').notNull(),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('carrier_checks_org_id_uq').on(t.orgId, t.id),
    index('carrier_checks_usdot_idx').on(t.usdotNumber),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'carrier_checks_org_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Retention policy per record class.
 *
 * Retention is not one clock. A driver's data spans regimes that run from
 * different anchor events — date of execution, date of receipt, date the
 * vehicle left the carrier's control — so anything keyed off a single
 * created_at is wrong. Each row records its own anchor and its citation.
 */
export const retentionPolicies = sqliteTable(
  'retention_policies',
  {
    id: pk(),
    orgId: orgId(),
    recordClass: text('record_class').notNull(),
    anchorType: text('anchor_type').notNull(),
    retentionDays: integer('retention_days').notNull(),
    /** e.g. '49 CFR 379 App. A'. Shown to the operator and to auditors. */
    citation: text('citation').notNull(),
    /** Regulatory floor the tenant cannot configure below. */
    floorDays: integer('floor_days').notNull(),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [uniqueIndex('retention_policies_org_class_uq').on(t.orgId, t.recordClass)],
);

/** A legal hold suspends every retention and purge job for its target. */
export const legalHolds = sqliteTable(
  'legal_holds',
  {
    id: pk(),
    orgId: orgId(),
    /** 'load:<id>', 'driver:<id>', or 'org' for everything. */
    subject: text('subject').notNull(),
    reason: text('reason').notNull(),
    placedByUserId: text('placed_by_user_id').references(() => users.id),
    placedAt: ts('placed_at').notNull(),
    releasedAt: ts('released_at'),
    releasedByUserId: text('released_by_user_id').references(() => users.id),
    ...timestamps,
  },
  (t) => [index('legal_holds_org_subject_idx').on(t.orgId, t.subject)],
);

export type Document = typeof documents.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
export type Claim = typeof claims.$inferSelect;
export type InsuranceCertificate = typeof insuranceCertificates.$inferSelect;
export type CarrierCheck = typeof carrierChecks.$inferSelect;
export type DocumentSend = typeof documentSends.$inferSelect;
