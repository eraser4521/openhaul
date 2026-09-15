import 'server-only';
import { eq, inArray } from 'drizzle-orm';
import {
  carrierChecks as carrierChecksTable,
  creditNotes as creditNotesTable,
  documents as documentsTable,
  documentSends as sendsTable,
  insuranceCertificates as certificatesTable,
  inspectionPhotos as photosTable,
  inspections as inspectionsTable,
  invoices as invoicesTable,
  loads as loadsTable,
  retentionPolicies as policiesTable,
  settlementLines as settlementLinesTable,
  settlements as settlementsTable,
} from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { appendAudit, AUDIT } from '../audit/chain';
import { blobStore } from '../storage/blob-store';
import { heldSubjects, isHeld } from './holds';
import {
  dueAt,
  effectivePolicy,
  isDue,
  RECORD_CLASSES,
  type EffectivePolicy,
  type RecordClass,
} from './policy';

/**
 * Deciding what may be destroyed, and destroying it.
 *
 * The engine is split in two on purpose. `retentionReport` only reads, and is
 * what the settings screen shows; `purge` is the only thing that deletes, runs
 * one class at a time, and is never called on a timer. A carrier who finds
 * their bills of lading gone because a scheduled job fired at 3am has lost
 * something no apology recovers, so the destructive half is something a person
 * starts after reading what it will do.
 *
 * Three rules decide whether a record is due, and the order matters:
 *
 *   1. No anchor date, no clock. An undelivered load, an open claim and a
 *      driver who still works here are not due and cannot become due.
 *   2. A legal hold on the load, the driver, or the organisation wins over
 *      any period.
 *   3. Only then is the anchor plus the retention period compared to today.
 */

/** One record the engine is deciding about. */
interface Candidate {
  id: string;
  anchor: Date | null;
  loadId: string | null;
  driverId: string | null;
  /** Storage that goes when this record goes. */
  bytes: number;
  blobKeys: string[];
  /** Objects this record wrote that were never recorded anywhere findable. */
  unreachable: number;
}

export interface ClassReport {
  recordClass: RecordClass;
  policy: EffectivePolicy;
  /** Records of this class that exist at all. */
  total: number;
  /** Past their period, not held: what a purge would take. */
  due: number;
  /** Past their period but suspended by a hold. */
  held: number;
  /** No anchor yet, so the clock has not started. */
  pending: number;
  /** Within their period. */
  keeping: number;
  /** Bytes a purge would reclaim. */
  bytes: number;
  /** Photos whose original object predates the column that records it. */
  unreachable: number;
  oldestDueAt: Date | null;
}

/* -------------------------------------------------------------------------
 * Finding the records of a class
 * ---------------------------------------------------------------------- */

/**
 * Delivery dates for every load, fetched once.
 *
 * Inspection evidence is anchored on delivery rather than on the inspection's
 * own date, because the clock that matters is the one a claimant's nine months
 * runs from. That means a lookup per inspection, which is one query here
 * instead of thousands.
 */
async function deliveryDates(scoped: ScopedDb): Promise<Map<string, Date | null>> {
  const loads = await scoped.select('loads');
  return new Map(loads.map((load) => [load.id, load.deliveredAt]));
}

/**
 * When a claim stopped being live.
 *
 * A declined claim anchors on the declination, because that is the notice the
 * two-year suit window runs from. A paid one anchors on payment. A withdrawn
 * one has no date of its own, so the last time it changed is the best
 * available — and a claim in any other state has no anchor at all.
 */
function claimAnchor(claim: {
  status: string;
  declinedAt: Date | null;
  settledAt: Date | null;
  updatedAt: Date;
}): Date | null {
  if (claim.declinedAt) return claim.declinedAt;
  if (claim.settledAt) return claim.settledAt;
  return claim.status === 'withdrawn' ? claim.updatedAt : null;
}

async function candidatesFor(
  scoped: ScopedDb,
  recordClass: RecordClass,
): Promise<Candidate[]> {
  const blank = { loadId: null, driverId: null, bytes: 0, blobKeys: [] as string[], unreachable: 0 };

  switch (recordClass) {
    case 'bill_of_lading':
    case 'delivery_receipt': {
      const kind = recordClass === 'bill_of_lading' ? 'bol' : 'pod';
      const rows = await scoped.select('documents', eq(documentsTable.kind, kind));
      return rows.map((row) => ({
        ...blank,
        id: row.id,
        anchor: row.finalizedAt ?? row.createdAt,
        loadId: row.loadId,
        bytes: row.byteSize,
        blobKeys: [row.storageKey],
      }));
    }

    case 'freight_bill': {
      // Both halves of the same artefact: the invoice row and the PDF that was
      // issued from it. Nothing is deleted for this class, so counting them
      // together is a report of one obligation rather than two.
      const [invoices, docs] = await Promise.all([
        scoped.select('invoices'),
        scoped.select('documents'),
      ]);

      return [
        ...invoices.map((row) => ({
          ...blank,
          id: row.id,
          anchor: row.issuedAt,
          loadId: row.loadId,
        })),
        ...docs
          .filter(
            (row) =>
              row.kind === 'invoice' || row.kind === 'credit_note' || row.kind === 'statement',
          )
          .map((row) => ({
            ...blank,
            id: row.id,
            anchor: row.finalizedAt ?? row.createdAt,
            loadId: row.loadId,
            bytes: row.byteSize,
            blobKeys: [row.storageKey],
          })),
      ];
    }

    case 'inspection_evidence': {
      const [inspections, photos, delivered] = await Promise.all([
        scoped.select('inspections'),
        scoped.select('inspectionPhotos'),
        deliveryDates(scoped),
      ]);

      const byInspection = new Map<string, typeof photos>();
      for (const photo of photos) {
        const list = byInspection.get(photo.inspectionId);
        if (list) list.push(photo);
        else byInspection.set(photo.inspectionId, [photo]);
      }

      return inspections.map((inspection) => {
        const own = byInspection.get(inspection.id) ?? [];
        const blobKeys: string[] = [];
        let unreachable = 0;

        for (const photo of own) {
          blobKeys.push(photo.storageKey);
          if (photo.originalStorageKey) blobKeys.push(photo.originalStorageKey);
          else unreachable += 1;
          if (photo.thumbnailStorageKey) blobKeys.push(photo.thumbnailStorageKey);
        }

        return {
          ...blank,
          id: inspection.id,
          anchor: delivered.get(inspection.loadId) ?? null,
          loadId: inspection.loadId,
          // The derivative byte size is what the row records; the original is
          // larger and the thumbnail smaller, so this understates a little.
          bytes: own.reduce((sum, photo) => sum + photo.byteSize, 0),
          blobKeys,
          unreachable,
        };
      });
    }

    case 'cargo_claim': {
      const rows = await scoped.select('claims');
      return rows.map((row) => ({
        ...blank,
        id: row.id,
        anchor: claimAnchor(row),
        loadId: row.loadId,
      }));
    }

    case 'settlement_record': {
      const rows = await scoped.select('settlements');
      return rows.map((row) => ({
        ...blank,
        id: row.id,
        anchor: row.paidAt,
        driverId: row.driverId,
      }));
    }

    case 'driver_record': {
      const rows = await scoped.select('drivers');
      return rows.map((row) => ({
        ...blank,
        id: row.id,
        // A driver who still works here has no anchor, so never comes due.
        anchor: row.deactivatedAt,
        driverId: row.id,
      }));
    }

    case 'carrier_check': {
      const rows = await scoped.select('carrierChecks');
      // `checkedAt`, not `createdAt`: a cached lookup can be written to the
      // row long after the answer it holds was true.
      return rows.map((row) => ({ ...blank, id: row.id, anchor: row.checkedAt }));
    }

    case 'document_send': {
      const [sends, docs] = await Promise.all([
        scoped.select('documentSends'),
        scoped.select('documents'),
      ]);
      const loadOf = new Map(docs.map((doc) => [doc.id, doc.loadId]));

      return sends.map((row) => ({
        ...blank,
        id: row.id,
        anchor: row.attemptedAt,
        // A send belongs to the load its document belongs to, so a hold on
        // that load covers the proof it was sent.
        loadId: loadOf.get(row.documentId) ?? null,
      }));
    }
  }
}

/* -------------------------------------------------------------------------
 * Reporting
 * ---------------------------------------------------------------------- */

async function policiesInForce(scoped: ScopedDb): Promise<Map<RecordClass, EffectivePolicy>> {
  const saved = await scoped.select('retentionPolicies');
  const byClass = new Map(saved.map((row) => [row.recordClass, row.retentionDays]));

  return new Map(
    RECORD_CLASSES.map((recordClass) => [
      recordClass,
      effectivePolicy(recordClass, { savedDays: byClass.get(recordClass) ?? null }),
    ]),
  );
}

export async function retentionReport(
  scoped: ScopedDb,
  now = new Date(),
): Promise<ClassReport[]> {
  const [policies, held] = await Promise.all([policiesInForce(scoped), heldSubjects(scoped)]);
  const reports: ClassReport[] = [];

  for (const recordClass of RECORD_CLASSES) {
    const policy = policies.get(recordClass)!;
    const candidates = await candidatesFor(scoped, recordClass);

    let due = 0;
    let onHold = 0;
    let pending = 0;
    let bytes = 0;
    let unreachable = 0;
    let oldestDueAt: Date | null = null;

    for (const candidate of candidates) {
      if (!candidate.anchor) {
        pending += 1;
        continue;
      }

      if (!isDue(candidate.anchor, policy.retentionDays, now)) continue;

      if (isHeld(held, candidate)) {
        onHold += 1;
        continue;
      }

      due += 1;
      bytes += candidate.bytes;
      unreachable += candidate.unreachable;
      if (!oldestDueAt || candidate.anchor < oldestDueAt) oldestDueAt = candidate.anchor;
    }

    reports.push({
      recordClass,
      policy,
      total: candidates.length,
      due,
      held: onHold,
      pending,
      keeping: candidates.length - due - onHold - pending,
      bytes,
      unreachable,
      oldestDueAt,
    });
  }

  return reports;
}

/* -------------------------------------------------------------------------
 * Purging
 * ---------------------------------------------------------------------- */

export interface PurgeResult {
  ok: boolean;
  error?: string;
  purged: number;
  bytes: number;
  /** Photo originals that could not be located, so still on disk. */
  unreachable: number;
}

/**
 * Deletes a blob only when nothing else points at it.
 *
 * Storage is content-addressed, so two identical photographs — the same stock
 * image of an undamaged bumper, uploaded on two loads — share one object.
 * Deleting it because one of them aged out would blank the other.
 */
async function deleteUnreferenced(scoped: ScopedDb, keys: string[]): Promise<void> {
  if (keys.length === 0) return;

  const unique = [...new Set(keys)];
  const [documents, photos] = await Promise.all([
    scoped.select('documents', inArray(documentsTable.storageKey, unique)),
    scoped.select('inspectionPhotos', inArray(photosTable.storageKey, unique)),
  ]);

  const stillReferenced = new Set<string>();
  for (const row of documents) stillReferenced.add(row.storageKey);
  for (const row of photos) {
    stillReferenced.add(row.storageKey);
    if (row.originalStorageKey) stillReferenced.add(row.originalStorageKey);
    if (row.thumbnailStorageKey) stillReferenced.add(row.thumbnailStorageKey);
  }

  const store = blobStore();
  for (const key of unique) {
    if (stillReferenced.has(key)) continue;
    // A blob that has already gone is not an error: the row is what the app
    // reads from, and a half-finished earlier purge should not block this one.
    await store.delete(key).catch(() => {});
  }
}

/**
 * Clears pointers to a document that is about to stop existing.
 *
 * These columns carry no foreign key, so nothing would stop them dangling —
 * and a dangling one shows up as a "View PDF" button that 404s, which reads
 * like a bug rather than like a document that reached the end of its life.
 */
async function forgetDocuments(scoped: ScopedDb, documentIds: string[]): Promise<void> {
  if (documentIds.length === 0) return;

  await Promise.all([
    scoped.update('invoices', inArray(invoicesTable.documentId, documentIds), {
      documentId: null,
    }),
    scoped.update('creditNotes', inArray(creditNotesTable.documentId, documentIds), {
      documentId: null,
    }),
    scoped.update('settlements', inArray(settlementsTable.documentId, documentIds), {
      documentId: null,
    }),
    scoped.update('settlementLines', inArray(settlementLinesTable.documentId, documentIds), {
      documentId: null,
    }),
    scoped.update(
      'insuranceCertificates',
      inArray(certificatesTable.documentId, documentIds),
      { documentId: null },
    ),
  ]);
}

/**
 * Destroys every record of one class that is past its period.
 *
 * Re-evaluates rather than trusting a list from a previous report: a hold
 * placed between the operator reading the screen and pressing the button has
 * to be honoured, and that gap is exactly when a hold gets placed.
 */
export async function purgeClass(
  scoped: ScopedDb,
  recordClass: RecordClass,
  actor: { userId: string | null; role: string | null },
  now = new Date(),
): Promise<PurgeResult> {
  const policies = await policiesInForce(scoped);
  const policy = policies.get(recordClass)!;

  if (policy.disposition !== 'purge') {
    return {
      ok: false,
      error:
        policy.disposition === 'erase'
          ? 'These records are not deleted. Erase the personal data on them instead.'
          : 'This class is reported only. Deleting it is a decision to make deliberately, not on a schedule.',
      purged: 0,
      bytes: 0,
      unreachable: 0,
    };
  }

  const held = await heldSubjects(scoped);
  const candidates = await candidatesFor(scoped, recordClass);

  const doomed = candidates.filter(
    (candidate) =>
      candidate.anchor &&
      isDue(candidate.anchor, policy.retentionDays, now) &&
      !isHeld(held, candidate),
  );

  if (doomed.length === 0) {
    return { ok: true, purged: 0, bytes: 0, unreachable: 0 };
  }

  const ids = doomed.map((candidate) => candidate.id);
  const blobKeys = doomed.flatMap((candidate) => candidate.blobKeys);
  const bytes = doomed.reduce((sum, candidate) => sum + candidate.bytes, 0);
  const unreachable = doomed.reduce((sum, candidate) => sum + candidate.unreachable, 0);

  switch (recordClass) {
    case 'bill_of_lading':
    case 'delivery_receipt': {
      await forgetDocuments(scoped, ids);
      // Rows first, then blobs: `deleteUnreferenced` asks the database what is
      // still pointed at, so it has to run after the pointers are gone.
      // Deleting the document also takes its send records, by foreign key.
      await scoped.remove('documents', inArray(documentsTable.id, ids));
      await deleteUnreferenced(scoped, blobKeys);
      break;
    }

    case 'inspection_evidence': {
      // Photos and damages go by cascade; the objects behind them do not.
      await scoped.remove('inspections', inArray(inspectionsTable.id, ids));
      await deleteUnreferenced(scoped, blobKeys);
      break;
    }

    case 'carrier_check':
      await scoped.remove('carrierChecks', inArray(carrierChecksTable.id, ids));
      break;

    case 'document_send':
      await scoped.remove('documentSends', inArray(sendsTable.id, ids));
      break;

    default:
      // Unreachable: the disposition check above has already returned for
      // every class that is not purgeable.
      return { ok: false, error: 'That class cannot be purged.', purged: 0, bytes: 0, unreachable: 0 };
  }

  await appendAudit({
    orgId: scoped.orgId,
    actorId: actor.userId,
    actorRole: actor.role,
    action: AUDIT.recordsPurged,
    subject: `retention:${recordClass}`,
    detail: {
      recordClass,
      purged: doomed.length,
      bytes,
      retentionDays: policy.retentionDays,
      // The span destroyed, so the entry answers "what went" without listing
      // thousands of ids into a hash chain.
      oldestAnchor: doomed
        .map((candidate) => candidate.anchor!)
        .reduce((a, b) => (a < b ? a : b))
        .toISOString(),
      newestAnchor: doomed
        .map((candidate) => candidate.anchor!)
        .reduce((a, b) => (a > b ? a : b))
        .toISOString(),
    },
  });

  return { ok: true, purged: doomed.length, bytes, unreachable };
}

/* -------------------------------------------------------------------------
 * One load
 * ---------------------------------------------------------------------- */

export interface LoadRetention {
  /** The latest date any record for this load may be destroyed. */
  until: Date | null;
  /** True while a legal hold overrides the date entirely. */
  held: boolean;
  /** What the date was worked out from, for the screen to say. */
  basis: string;
}

/**
 * How long this load's records are kept.
 *
 * Computed rather than stored. `loads.retainUntil` used to be stamped at
 * creation as "today plus seven years", which is the mistake the whole policy
 * table exists to avoid: a bill of lading runs from the day it was sealed and
 * the inspection photos run from delivery, neither of which is the day the
 * load was booked. A stored guess also goes stale the moment a period is
 * changed, and would then disagree with the retention screen.
 */
export async function loadRetention(
  scoped: ScopedDb,
  loadId: string,
): Promise<LoadRetention> {
  const [policies, held, load, docs, inspections] = await Promise.all([
    policiesInForce(scoped),
    heldSubjects(scoped),
    scoped.selectOne('loads', eq(loadsTable.id, loadId)),
    scoped.select('documents', eq(documentsTable.loadId, loadId)),
    scoped.select('inspections', eq(inspectionsTable.loadId, loadId)),
  ]);

  if (!load) return { until: null, held: false, basis: 'No such load.' };

  if (isHeld(held, { loadId })) {
    return {
      until: null,
      held: true,
      basis: 'A legal hold is in force, so nothing for this load is destroyed whatever the periods say.',
    };
  }

  const dates: Array<{ at: Date; from: string }> = [];

  for (const doc of docs) {
    const recordClass: RecordClass | null =
      doc.kind === 'bol' ? 'bill_of_lading' : doc.kind === 'pod' ? 'delivery_receipt' : null;
    if (!recordClass) continue;

    const anchor = doc.finalizedAt ?? doc.createdAt;
    dates.push({
      at: dueAt(anchor, policies.get(recordClass)!.retentionDays),
      from: policies.get(recordClass)!.label.toLowerCase(),
    });
  }

  if (inspections.length > 0 && load.deliveredAt) {
    dates.push({
      at: dueAt(load.deliveredAt, policies.get('inspection_evidence')!.retentionDays),
      from: 'inspection photos',
    });
  }

  if (dates.length === 0) {
    return {
      until: null,
      held: false,
      basis:
        'Nothing is being kept for this load yet. The clock starts when a document is issued, ' +
        'and the photographs run from delivery.',
    };
  }

  const latest = dates.reduce((a, b) => (a.at > b.at ? a : b));
  return {
    until: latest.at,
    held: false,
    basis: `The longest period covering this load is its ${latest.from}.`,
  };
}

/* -------------------------------------------------------------------------
 * Policy overrides
 * ---------------------------------------------------------------------- */

export async function setRetentionDays(
  scoped: ScopedDb,
  recordClass: RecordClass,
  days: number,
  actor: { userId: string | null; role: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const definition = effectivePolicy(recordClass);

  if (!Number.isInteger(days) || days < 0) {
    return { ok: false, error: 'A retention period is a whole number of days.' };
  }

  /*
   * The floor is the point of the feature. A carrier may keep records longer
   * than the regulation requires and may not keep them for less, so this is
   * refused rather than silently raised — being told why is more use than
   * discovering later that the number did not take.
   */
  if (days < definition.floorDays) {
    return {
      ok: false,
      error:
        `${definition.label} must be kept at least ${definition.floorDays} days` +
        `${definition.citation ? ` under ${definition.citation}` : ''}.`,
    };
  }

  const existing = await scoped.selectOne(
    'retentionPolicies',
    eq(policiesTable.recordClass, recordClass),
  );

  const values = {
    recordClass,
    anchorType: definition.anchorType,
    retentionDays: days,
    citation: definition.citation || 'No federal minimum',
    floorDays: definition.floorDays,
  };

  if (existing) {
    await scoped.update('retentionPolicies', eq(policiesTable.id, existing.id), values);
  } else {
    await scoped.insert('retentionPolicies', values);
  }

  await appendAudit({
    orgId: scoped.orgId,
    actorId: actor.userId,
    actorRole: actor.role,
    action: AUDIT.retentionPolicyChanged,
    subject: `retention:${recordClass}`,
    detail: { recordClass, retentionDays: days, previous: existing?.retentionDays ?? null },
  });

  return { ok: true };
}
