'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import {
  documents as documentsTable,
  inspections as inspectionsTable,
  loads as loadsTable,
  vehicles as vehiclesTable,
} from '@/lib/db/schema';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import { appendAudit, AUDIT } from '@/lib/audit/chain';
import { generateDocument, type DocumentKind } from '@/lib/documents/generate';
import type { BolRequirement } from '@/lib/documents/bol';
import { missingStopFields, readStopParty, saveStop } from '@/lib/loads/route';
import { isBlankCustomer, readCustomer, upsertCustomer } from '@/lib/customers/upsert';

export interface DocumentResult {
  ok: boolean;
  error?: string;
  documentId?: string;
  missing?: BolRequirement[];
}

/**
 * Issues a bill of lading or delivery receipt for a load.
 *
 * Gated on the relevant inspection being sealed. Issuing a bill of lading that
 * claims to record condition at pickup, before anyone has recorded it, would
 * produce a document that looks authoritative and proves nothing — which is
 * worse than having none.
 */
export async function issueDocumentAction(
  loadId: string,
  kind: DocumentKind,
): Promise<DocumentResult> {
  let context;
  try {
    context = await requireCapability('load.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const { session, db } = context;

  const load = await db.selectOne('loads', eq(loadsTable.id, loadId));
  if (!load) return { ok: false, error: 'No such load.' };

  const stage = kind === 'bol' ? 'pickup' : 'delivery';
  const vehicles = await db.select('vehicles', eq(vehiclesTable.loadId, loadId));

  if (vehicles.length === 0) {
    return { ok: false, error: 'This load has no vehicles on it.' };
  }

  const inspections = await db.select(
    'inspections',
    and(eq(inspectionsTable.loadId, loadId), eq(inspectionsTable.stage, stage)),
  );
  const sealed = inspections.filter((i) => i.finalizedAt !== null);

  if (sealed.length < vehicles.length) {
    const outstanding = vehicles.length - sealed.length;
    return {
      ok: false,
      error:
        `${outstanding} vehicle${outstanding === 1 ? '' : 's'} still ${outstanding === 1 ? 'needs' : 'need'} a sealed ` +
        `${stage} inspection. The document records condition, so it cannot be issued before that exists.`,
    };
  }

  // Reissues supersede rather than replace, so the copy someone signed stays
  // retrievable even after a correction.
  const existing = await db.select(
    'documents',
    and(eq(documentsTable.loadId, loadId), eq(documentsTable.kind, kind)),
  );
  const latest = existing.sort((a, b) => b.version - a.version)[0] ?? null;
  const nextVersion = (latest?.version ?? 0) + 1;

  const prefix = kind === 'bol' ? 'BOL' : 'POD';
  const documentNumber =
    nextVersion === 1 ? `${prefix}-${load.number}` : `${prefix}-${load.number}-R${nextVersion - 1}`;

  const result = await generateDocument({
    scoped: db,
    loadId,
    kind,
    documentNumber,
    supersedesDocumentId: latest?.id ?? null,
  });

  if (!result.ok) {
    return { ok: false, error: result.error, missing: result.missing };
  }

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.documentFinalized,
    subject: `load:${loadId}`,
    detail: {
      kind,
      documentNumber,
      documentId: result.documentId,
      sha256: result.sha256,
      version: nextVersion,
      supersedes: latest?.id ?? null,
    },
  });

  revalidatePath(`/loads/${loadId}`);
  revalidatePath('/documents');

  return { ok: true, documentId: result.documentId };
}

export interface RouteResult {
  ok: boolean;
  error?: string;
}

/**
 * Sets or corrects the origin and destination.
 *
 * Separate from load creation because the addresses frequently arrive after
 * the vehicles do, and because a bill of lading cannot be issued without them
 * — a load stuck at that gate needs somewhere to fix it.
 */
export async function saveRouteAction(loadId: string, formData: FormData): Promise<RouteResult> {
  let context;
  try {
    context = await requireCapability('load.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const { db } = context;

  const load = await db.selectOne('loads', eq(loadsTable.id, loadId));
  if (!load) return { ok: false, error: 'No such load.' };

  const pickup = readStopParty(formData, 'pickup');
  const delivery = readStopParty(formData, 'delivery');

  for (const [label, party] of [['pickup', pickup], ['delivery', delivery]] as const) {
    const missing = missingStopFields(party);
    if (missing.length > 0) {
      return { ok: false, error: `The ${label} address still needs ${missing.join(', ')}.` };
    }
  }

  await saveStop(db, loadId, 'pickup', pickup);
  await saveStop(db, loadId, 'delivery', delivery);

  revalidatePath(`/loads/${loadId}`);
  return { ok: true };
}

/**
 * Sets or corrects the party that pays.
 *
 * Separate from load creation for the same reason the route is: the broker's
 * billing details often arrive with the rate confirmation, after the vehicles
 * are already booked.
 */
export async function saveBillToAction(loadId: string, formData: FormData): Promise<RouteResult> {
  let context;
  try {
    context = await requireCapability('customer.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const { db } = context;

  const load = await db.selectOne('loads', eq(loadsTable.id, loadId));
  if (!load) return { ok: false, error: 'No such load.' };

  const input = readCustomer(formData);
  if (isBlankCustomer(input)) {
    return { ok: false, error: 'Give the customer a name — it is what the invoice is addressed to.' };
  }

  const customerId = await upsertCustomer(db, input);
  if (!customerId) return { ok: false, error: 'The customer could not be saved.' };

  await db.update('loads', eq(loadsTable.id, loadId), {
    customerId,
    // Terms follow the customer unless the load already carries its own.
    paymentTerms: load.paymentTerms ?? input.defaultPaymentTerms ?? null,
  });

  revalidatePath(`/loads/${loadId}`);
  return { ok: true };
}
