import 'server-only';
import { eq } from 'drizzle-orm';
import {
  drivers as driversTable,
  loads as loadsTable,
  settlementLines as linesTable,
  settlements as settlementsTable,
} from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { getOrganization } from '../organization/profile';
import { storeDocument } from '../documents/store';
import { renderSettlement, type SettlementLineOut } from '../documents/settlement';
import { describeBasis, payBasisFor, paymentDueBy } from './compute';
import { driverEscrowBalance } from './lifecycle';

/**
 * Producing the statement a driver is handed.
 *
 * Rendered after the settlement is finalised, never before: the whole point of
 * the document is that the figures on it can no longer move. It is stored and
 * hashed like every other record here, so the copy a driver queries in six
 * months can be checked against the one that was issued.
 */

export interface StatementResult {
  ok: boolean;
  documentId?: string;
  sha256?: string;
  error?: string;
}

/**
 * A human reference for the statement.
 *
 * Derived from the period end rather than a counter, because a driver asking
 * about "the one for the week ending the fourteenth" should be able to find it
 * without anybody looking up a sequence number.
 */
export function statementNumber(driverName: string, periodEnd: Date): string {
  const initials = driverName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  const iso = periodEnd.toISOString().slice(0, 10).replace(/-/g, '');
  return `STL-${initials || 'XX'}-${iso}`;
}

export async function buildStatement(
  scoped: ScopedDb,
  settlementId: string,
): Promise<StatementResult> {
  const settlement = await scoped.selectOne('settlements', eq(settlementsTable.id, settlementId));
  if (!settlement) return { ok: false, error: 'No such settlement.' };

  if (!settlement.finalizedAt) {
    return { ok: false, error: 'A statement is only produced once the settlement is finalised.' };
  }

  const [org, driver, lines] = await Promise.all([
    getOrganization(scoped.orgId),
    scoped.selectOne('drivers', eq(driversTable.id, settlement.driverId)),
    scoped.select('settlementLines', eq(linesTable.settlementId, settlementId)),
  ]);

  if (!org) return { ok: false, error: 'The organisation record is missing.' };
  if (!driver) return { ok: false, error: 'The driver record is missing.' };

  // Load numbers are resolved once rather than per line, since a settlement
  // routinely carries several lines against the same load.
  const loadIds = new Set(lines.map((line) => line.loadId).filter((id): id is string => id !== null));
  const loadNumbers = new Map<string, string>();

  for (const loadId of loadIds) {
    const load = await scoped.selectOne('loads', eq(loadsTable.id, loadId));
    if (load) loadNumbers.set(loadId, load.number);
  }

  const out: SettlementLineOut[] = lines
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((line) => ({
      kind: line.kind,
      description: line.description,
      amountCents: line.amountCents,
      basisNote: line.basisNote,
      loadNumber: line.loadId ? (loadNumbers.get(line.loadId) ?? null) : null,
    }));

  const leased = driver.employmentType === 'owner_operator';
  const number = statementNumber(driver.displayName, settlement.periodEnd);

  const bytes = await renderSettlement({
    settlementNumber: number,
    issuedAt: settlement.finalizedAt,
    periodStart: settlement.periodStart,
    periodEnd: settlement.periodEnd,
    // The fifteen-day window is a lease term, so it is only stated for a lease.
    paymentDueBy: leased ? paymentDueBy(settlement.periodEnd) : null,

    carrier: {
      name: org.legalName,
      addressLine1: org.addressLine1,
      city: org.city,
      state: org.state,
      postalCode: org.postalCode,
      phone: org.phone,
      email: org.email,
    },

    driverName: driver.displayName,
    employmentType: driver.employmentType,
    payBasis: describeBasis(payBasisFor(driver)),

    lines: out,
    escrowBalanceCents: await driverEscrowBalance(scoped, driver.id),
    notes: settlement.notes,
  });

  const stored = await storeDocument({
    scoped,
    kind: 'settlement',
    loadId: null,
    subject: `settlement:${settlementId}`,
    title: `Settlement statement ${number}`,
    bytes,
    supersedesDocumentId: settlement.documentId,
  });

  if ('error' in stored) return { ok: false, error: stored.error };

  await scoped.update('settlements', eq(settlementsTable.id, settlementId), {
    documentId: stored.documentId,
  });

  return { ok: true, documentId: stored.documentId, sha256: stored.sha256 };
}
