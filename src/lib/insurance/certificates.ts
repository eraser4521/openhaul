import 'server-only';
import { and, eq, isNull } from 'drizzle-orm';
import {
  insuranceCertificates as certificatesTable,
  loads as loadsTable,
  vehicles as vehiclesTable,
} from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { appendAudit, AUDIT } from '../audit/chain';
import {
  coverageCheck,
  currentCertificate,
  expiryState,
  type CertificateKind,
  type CoverageCheck,
} from './status';

/**
 * Storing and reading certificates of insurance.
 *
 * A certificate belongs either to the carrier running this instance — their
 * own cover, which a broker will ask to see before tendering — or to a
 * customer, when the carrier is the one doing the asking. `customerId` is null
 * for the first case, which is why nearly every function here takes it.
 */

export interface CertificateInput {
  customerId: string | null;
  kind: CertificateKind;
  insurerName: string;
  policyNumber: string;
  coverageLimitCents: number | null;
  deductibleCents: number | null;
  effectiveAt: Date;
  expiresAt: Date;
}

export interface SaveResult {
  ok: boolean;
  error?: string;
  certificateId?: string;
}

export async function listCertificates(
  scoped: ScopedDb,
  customerId: string | null,
): Promise<Array<typeof certificatesTable.$inferSelect>> {
  const rows = await scoped.select(
    'insuranceCertificates',
    customerId === null
      ? isNull(certificatesTable.customerId)
      : eq(certificatesTable.customerId, customerId),
  );

  // Soonest to expire first: the one about to lapse is the one being looked
  // for, and an expired row is still worth seeing rather than hiding.
  return rows.slice().sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
}

export async function saveCertificate(
  scoped: ScopedDb,
  input: CertificateInput,
  actor: { userId: string | null; role: string | null },
  certificateId?: string | null,
): Promise<SaveResult> {
  if (!input.insurerName.trim()) return { ok: false, error: 'Name the insurer.' };
  if (!input.policyNumber.trim()) return { ok: false, error: 'Record the policy number.' };

  /*
   * A certificate that expires before it starts is a typo, and an expiry in
   * the past is usually one too — but not always, because a carrier
   * reconstructing a file may need to record what was in force last year. Only
   * the impossible one is refused.
   */
  if (input.expiresAt.getTime() <= input.effectiveAt.getTime()) {
    return { ok: false, error: 'The expiry has to come after the effective date.' };
  }

  const values = {
    customerId: input.customerId,
    kind: input.kind,
    insurerName: input.insurerName.trim(),
    policyNumber: input.policyNumber.trim(),
    coverageLimitCents: input.coverageLimitCents,
    deductibleCents: input.deductibleCents,
    effectiveAt: input.effectiveAt,
    expiresAt: input.expiresAt,
  };

  if (certificateId) {
    const existing = await scoped.selectOne(
      'insuranceCertificates',
      eq(certificatesTable.id, certificateId),
    );
    if (!existing) return { ok: false, error: 'No such certificate.' };

    /*
     * Editing the figures invalidates any earlier verification. Somebody
     * checked the certificate against the numbers that were there then, and
     * leaving the tick in place would let a changed limit inherit a check
     * nobody performed on it.
     */
    await scoped.update('insuranceCertificates', eq(certificatesTable.id, certificateId), {
      ...values,
      verifiedAt: null,
      verifiedByUserId: null,
    });

    return { ok: true, certificateId };
  }

  const [row] = await scoped.insert('insuranceCertificates', values);
  if (!row) return { ok: false, error: 'The certificate could not be saved.' };

  await appendAudit({
    orgId: scoped.orgId,
    actorId: actor.userId,
    actorRole: actor.role,
    action: AUDIT.insuranceRecorded,
    subject: input.customerId ? `customer:${input.customerId}` : `organization:${scoped.orgId}`,
    detail: {
      kind: input.kind,
      insurer: values.insurerName,
      expiresAt: input.expiresAt.toISOString(),
      limitCents: input.coverageLimitCents,
    },
  });

  return { ok: true, certificateId: row.id };
}

/**
 * Records that a person checked the certificate itself.
 *
 * Typed figures are a claim about a document; this is the record that somebody
 * opened the document and agreed. It is the difference between "our file says
 * they carry $100,000" and "we looked", and only the second is a defence.
 */
export async function verifyCertificate(
  scoped: ScopedDb,
  certificateId: string,
  actor: { userId: string | null; role: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const existing = await scoped.selectOne(
    'insuranceCertificates',
    eq(certificatesTable.id, certificateId),
  );
  if (!existing) return { ok: false, error: 'No such certificate.' };

  await scoped.update('insuranceCertificates', eq(certificatesTable.id, certificateId), {
    verifiedAt: new Date(),
    verifiedByUserId: actor.userId,
  });

  await appendAudit({
    orgId: scoped.orgId,
    actorId: actor.userId,
    actorRole: actor.role,
    action: AUDIT.insuranceVerified,
    subject: `insurance:${certificateId}`,
    detail: { kind: existing.kind, policyNumber: existing.policyNumber },
  });

  return { ok: true };
}

export async function attachDocument(
  scoped: ScopedDb,
  certificateId: string,
  documentId: string,
): Promise<void> {
  await scoped.update('insuranceCertificates', eq(certificatesTable.id, certificateId), {
    documentId,
  });
}

export async function removeCertificate(
  scoped: ScopedDb,
  certificateId: string,
): Promise<{ ok: boolean }> {
  await scoped.remove('insuranceCertificates', eq(certificatesTable.id, certificateId));
  return { ok: true };
}

/* -------------------------------------------------------------------------
 * Reading across the whole file
 * ---------------------------------------------------------------------- */

export interface ExpiringCertificate {
  id: string;
  kind: CertificateKind;
  insurerName: string;
  expiresAt: Date;
  customerId: string | null;
  state: 'expired' | 'expiring';
}

/**
 * Everything lapsed or about to, for the dashboard.
 *
 * Includes certificates that have already expired rather than only the ones
 * approaching it: a lapse nobody noticed is worse than one about to happen,
 * and dropping it off the list the day it happens is how it stays unnoticed.
 */
export async function expiringCertificates(
  scoped: ScopedDb,
  now = new Date(),
): Promise<ExpiringCertificate[]> {
  const rows = await scoped.select('insuranceCertificates');

  return rows
    .map((row) => ({ row, state: expiryState(row, now) }))
    .filter(
      (entry): entry is { row: (typeof rows)[number]; state: 'expired' | 'expiring' } =>
        entry.state === 'expired' || entry.state === 'expiring',
    )
    .sort((a, b) => a.row.expiresAt.getTime() - b.row.expiresAt.getTime())
    .map(({ row, state }) => ({
      id: row.id,
      kind: row.kind,
      insurerName: row.insurerName,
      expiresAt: row.expiresAt,
      customerId: row.customerId,
      state,
    }));
}

/** The cargo policy in force for the carrier, if there is one. */
export async function cargoCover(
  scoped: ScopedDb,
  now = new Date(),
): Promise<(typeof certificatesTable.$inferSelect) | null> {
  const rows = await scoped.select(
    'insuranceCertificates',
    and(isNull(certificatesTable.customerId), eq(certificatesTable.kind, 'cargo')),
  );

  return currentCertificate(rows, now);
}

export interface LoadCoverage extends CoverageCheck {
  /** Null when no cargo certificate is on file at all. */
  policyNumber: string | null;
  insurerName: string | null;
  expiresAt: Date | null;
}

/**
 * What is on the deck against what the cargo policy covers.
 *
 * Read on the load screen, because the moment to find out that a load is worth
 * more than the cover is before it moves.
 */
export async function loadCoverage(
  scoped: ScopedDb,
  loadId: string,
  now = new Date(),
): Promise<LoadCoverage> {
  const [load, onboard, cover] = await Promise.all([
    scoped.selectOne('loads', eq(loadsTable.id, loadId)),
    scoped.select('vehicles', eq(vehiclesTable.loadId, loadId)),
    cargoCover(scoped, now),
  ]);

  const check = coverageCheck(cover?.coverageLimitCents ?? null, load ? onboard : []);

  return {
    ...check,
    policyNumber: cover?.policyNumber ?? null,
    insurerName: cover?.insurerName ?? null,
    expiresAt: cover?.expiresAt ?? null,
  };
}
