import 'server-only';
import { eq } from 'drizzle-orm';
import {
  claims as claimsTable,
  creditNotes as creditNotesTable,
  customers as customersTable,
  invoices as invoicesTable,
  loads as loadsTable,
} from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { getOrganization } from '../organization/profile';
import { storeDocument } from '../documents/store';
import { renderCreditNote } from '../documents/credit-note';
import { sumCredits } from './credits';

/**
 * Freezing the credit note that was sent.
 *
 * Rendered immediately on raising, because a credit note has no draft stage —
 * it is one figure and one reason, and the document is what the customer's
 * accounts payable department applies against the invoice.
 */

export interface CreditDocumentResult {
  ok: boolean;
  documentId?: string;
  sha256?: string;
  error?: string;
}

export async function buildCreditDocument(
  scoped: ScopedDb,
  creditNoteId: string,
): Promise<CreditDocumentResult> {
  const note = await scoped.selectOne('creditNotes', eq(creditNotesTable.id, creditNoteId));
  if (!note) return { ok: false, error: 'No such credit note.' };

  const [org, invoice] = await Promise.all([
    getOrganization(scoped.orgId),
    scoped.selectOne('invoices', eq(invoicesTable.id, note.invoiceId)),
  ]);

  if (!org) return { ok: false, error: 'The organisation record is missing.' };
  if (!invoice) return { ok: false, error: 'The invoice this credits is missing.' };

  const [customer, load, claim, siblings] = await Promise.all([
    note.customerId
      ? scoped.selectOne('customers', eq(customersTable.id, note.customerId))
      : Promise.resolve(null),
    invoice.loadId ? scoped.selectOne('loads', eq(loadsTable.id, invoice.loadId)) : Promise.resolve(null),
    note.claimId ? scoped.selectOne('claims', eq(claimsTable.id, note.claimId)) : Promise.resolve(null),
    scoped.select('creditNotes', eq(creditNotesTable.invoiceId, note.invoiceId)),
  ]);

  const bytes = await renderCreditNote({
    creditNumber: note.number,
    issuedAt: note.issuedAt ?? note.createdAt,

    carrier: {
      name: org.legalName,
      addressLine1: org.addressLine1,
      city: org.city,
      state: org.state,
      postalCode: org.postalCode,
      phone: org.phone,
      email: org.email,
    },

    billTo: {
      name: customer?.name ?? 'Customer not recorded',
      contactName: customer?.contactName,
      addressLine1: customer?.addressLine1,
      city: customer?.city,
      state: customer?.state,
      postalCode: customer?.postalCode,
      email: customer?.email,
    },

    invoiceNumber: invoice.number,
    invoiceIssuedAt: invoice.issuedAt,
    invoiceTotalCents: invoice.totalCents,
    loadNumber: load?.number ?? null,

    reason: note.reason,
    detail: note.detail,
    amountCents: note.amountCents,
    currency: note.currency,

    // Every live credit against the invoice, so the balance on the face is the
    // real one rather than what this note alone would leave.
    totalCreditedCents: sumCredits(siblings),
    paidCents: invoice.paidCents,

    claimNumber: claim?.number ?? null,
  });

  const stored = await storeDocument({
    scoped,
    kind: 'credit_note',
    loadId: invoice.loadId,
    subject: `credit_note:${creditNoteId}`,
    title: `Credit note ${note.number}`,
    bytes,
    supersedesDocumentId: note.documentId,
  });

  if ('error' in stored) return { ok: false, error: stored.error };

  await scoped.update('creditNotes', eq(creditNotesTable.id, creditNoteId), {
    documentId: stored.documentId,
  });

  return { ok: true, documentId: stored.documentId, sha256: stored.sha256 };
}
