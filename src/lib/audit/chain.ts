import 'server-only';
import { createHash } from 'node:crypto';
import { asc, desc, gt } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { db } from '../db/client';
import { auditLog } from '../db/schema';

/**
 * Hash-chained audit log.
 *
 * Each entry commits to the hash of the entry before it, so removing or
 * editing a row breaks the chain at a point verification can name.
 */

const GENESIS = '0'.repeat(64);

export interface AuditInput {
  orgId: string;
  actorId?: string | null;
  actorRole?: string | null;
  action: string;
  subject: string;
  outcome?: 'success' | 'failure' | 'denied';
  detail?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  at?: Date;
}

/** The fields the hash covers. Key order must be stable. */
interface HashedPayload {
  id: string;
  orgId: string;
  actorId: string | null;
  actorRole: string | null;
  action: string;
  subject: string;
  outcome: string;
  detail: string;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  at: number;
}

/**
 * Canonical serialisation. Keys are sorted so two runs over the same data
 * always produce identical bytes — otherwise verification fails spuriously
 * whenever a JS engine changes property ordering.
 */
function canonical(payload: HashedPayload): string {
  const keys = Object.keys(payload).sort();
  return JSON.stringify(payload, keys);
}

function computeHash(payload: HashedPayload, prevHash: string): string {
  return createHash('sha256').update(prevHash).update(canonical(payload)).digest('hex');
}

function toPayload(id: string, input: AuditInput, at: Date): HashedPayload {
  return {
    id,
    orgId: input.orgId,
    actorId: input.actorId ?? null,
    actorRole: input.actorRole ?? null,
    action: input.action,
    subject: input.subject,
    outcome: input.outcome ?? 'success',
    // Detail is hashed as its canonical JSON so a later edit is detectable.
    detail: input.detail ? JSON.stringify(input.detail, Object.keys(input.detail).sort()) : '',
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    requestId: input.requestId ?? null,
    at: at.getTime(),
  };
}

/**
 * Appends an entry.
 *
 * Runs inside a transaction so the read of the previous head and the insert
 * cannot interleave. SQLite's single-writer model — usually a limitation —
 * makes this race-free without advisory locks.
 */
export async function appendAudit(input: AuditInput): Promise<string> {
  const at = input.at ?? new Date();
  const id = uuidv7();

  return db.transaction(async (tx) => {
    const [last] = await tx
      .select({ hash: auditLog.hash })
      .from(auditLog)
      .orderBy(desc(auditLog.seq))
      .limit(1);

    const prevHash = last?.hash ?? GENESIS;
    const payload = toPayload(id, input, at);
    const hash = computeHash(payload, prevHash);

    await tx.insert(auditLog).values({
      id,
      orgId: input.orgId,
      actorId: input.actorId ?? null,
      actorRole: input.actorRole ?? null,
      action: input.action,
      subject: input.subject,
      outcome: input.outcome ?? 'success',
      detail: input.detail ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
      at,
      prevHash,
      hash,
    });

    return hash;
  });
}

export type ChainVerdict =
  | { ok: true; entries: number; headSeq: number; headHash: string }
  | {
      ok: false;
      brokenAtSeq: number;
      reason: 'gap' | 'prev-mismatch' | 'hash-mismatch';
      detail: string;
    };

/**
 * Recomputes the whole chain from a starting point.
 *
 * Intended to run nightly and on demand from the settings screen. A break
 * means either a bug or tampering; either way the operator needs to know.
 */
export async function verifyChain(fromSeq = 0): Promise<ChainVerdict> {
  const rows = await db.select().from(auditLog).where(gt(auditLog.seq, fromSeq)).orderBy(asc(auditLog.seq));

  if (rows.length === 0) {
    return { ok: true, entries: 0, headSeq: fromSeq, headHash: GENESIS };
  }

  let prevHash = GENESIS;
  if (fromSeq > 0) {
    const [anchor] = await db
      .select({ hash: auditLog.hash })
      .from(auditLog)
      .where(gt(auditLog.seq, fromSeq - 1))
      .orderBy(asc(auditLog.seq))
      .limit(1);
    prevHash = anchor?.hash ?? GENESIS;
  }

  let expectedSeq = fromSeq + 1;
  let headHash = prevHash;
  let headSeq = fromSeq;

  for (const row of rows) {
    if (row.seq !== expectedSeq) {
      return {
        ok: false,
        brokenAtSeq: row.seq,
        reason: 'gap',
        detail: `expected sequence ${expectedSeq}, found ${row.seq} — an entry was deleted`,
      };
    }
    expectedSeq += 1;

    if (row.prevHash !== prevHash) {
      return {
        ok: false,
        brokenAtSeq: row.seq,
        reason: 'prev-mismatch',
        detail: 'entry does not link to the preceding entry',
      };
    }

    const payload = toPayload(row.id, {
      orgId: row.orgId,
      actorId: row.actorId,
      actorRole: row.actorRole,
      action: row.action,
      subject: row.subject,
      outcome: row.outcome,
      detail: row.detail,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      requestId: row.requestId,
    }, row.at);

    if (computeHash(payload, row.prevHash) !== row.hash) {
      return {
        ok: false,
        brokenAtSeq: row.seq,
        reason: 'hash-mismatch',
        detail: 'entry contents do not match its recorded hash — the row was edited',
      };
    }

    prevHash = row.hash;
    headHash = row.hash;
    headSeq = row.seq;
  }

  return { ok: true, entries: rows.length, headSeq, headHash };
}

/** Current head, for anchoring to storage the operator does not control. */
export async function chainHead(): Promise<{ seq: number; hash: string; count: number }> {
  const [last] = await db
    .select({ seq: auditLog.seq, hash: auditLog.hash })
    .from(auditLog)
    .orderBy(desc(auditLog.seq))
    .limit(1);

  return { seq: last?.seq ?? 0, hash: last?.hash ?? GENESIS, count: last?.seq ?? 0 };
}

/**
 * Actions worth logging, as constants so a typo cannot silently create a
 * parallel action name that no report ever surfaces.
 */
export const AUDIT = {
  loginSucceeded: 'auth.login.succeeded',
  loginFailed: 'auth.login.failed',
  logout: 'auth.logout',
  mfaEnrolled: 'auth.mfa.enrolled',
  mfaVerified: 'auth.mfa.verified',
  recoveryCodeUsed: 'auth.recovery_code.used',
  passwordChanged: 'auth.password.changed',
  roleChanged: 'auth.role.changed',
  permissionDenied: 'auth.permission.denied',
  tenantViolation: 'security.tenant_isolation.violation',

  loadCreated: 'load.created',
  loadStatusChanged: 'load.status.changed',
  loadVoided: 'load.voided',
  loadDispatched: 'load.dispatched',
  loadsImported: 'load.imported',

  inspectionStarted: 'inspection.started',
  inspectionFinalized: 'inspection.finalized',
  photoAdded: 'inspection.photo.added',
  damageAdded: 'inspection.damage.added',
  photoRemoved: 'inspection.photo.removed',

  documentFinalized: 'document.finalized',
  documentIntegrityFailed: 'document.integrity.failed',
  documentSent: 'document.sent',
  bouncesChecked: 'document.bounces.checked',
  signatureCaptured: 'signature.captured',

  invoiceCreated: 'invoice.created',
  invoiceIssued: 'invoice.issued',
  invoiceVoided: 'invoice.voided',
  creditNoteRaised: 'credit_note.raised',
  creditNoteVoided: 'credit_note.voided',
  paymentRecorded: 'payment.recorded',
  refundIssued: 'refund.issued',
  refundRemoved: 'refund.removed',

  driverCreated: 'driver.created',
  expenseRecorded: 'expense.recorded',
  expenseReviewed: 'expense.reviewed',
  settlementFinalized: 'settlement.finalized',
  settlementPaid: 'settlement.paid',

  claimFiled: 'claim.filed',
  claimStatusChanged: 'claim.status.changed',

  carrierChecked: 'carrier.checked',
  insuranceRecorded: 'insurance.recorded',
  insuranceVerified: 'insurance.verified',

  settingsChanged: 'settings.changed',
  templateChanged: 'document_template.changed',

  piiDecrypted: 'pii.decrypted',
  piiErased: 'pii.erased',
  dataExported: 'data.exported',
  legalHoldPlaced: 'legal_hold.placed',
  legalHoldReleased: 'legal_hold.released',
  retentionPolicyChanged: 'retention.policy.changed',
  recordsPurged: 'retention.purged',
} as const;
