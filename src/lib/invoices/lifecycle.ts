import 'server-only';
import { and, eq } from 'drizzle-orm';
import {
  customers as customersTable,
  documents as documentsTable,
  invoices as invoicesTable,
  loads as loadsTable,
  payments as paymentsTable,
  stops as stopsTable,
  vehicles as vehiclesTable,
  venues as venuesTable,
  type PaymentMethod,
  type PaymentTerms,
} from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { getOrganization } from '../organization/profile';
import { accessorialsFor } from '../branding/accessorials';
import { sumAccessorials } from '../branding/accessorial-math';
import { brandFor } from '../branding/template';
import { storeDocument } from '../documents/store';
import { renderInvoice, type AttachedDocument, type InvoiceInput } from '../documents/invoice';
import {
  balanceCents,
  deriveCharges,
  nextNumberFrom,
  statusAfterPayment,
  sumPayments,
  totalCents,
  type BillingBasis,
  type Charges,
} from './compute';
import { dueDateFor } from './terms';

/**
 * The invoice workflow.
 *
 * An invoice is raised against a delivered load, edited while it is a draft,
 * issued once — which freezes a PDF the same way a bill of lading is frozen —
 * and then only receives payments. Nothing after issue rewrites the figures,
 * because the customer is holding a document that states them.
 */

export interface InvoiceGate {
  ok: boolean;
  reason?: string;
}

/**
 * Whether a load can be invoiced yet.
 *
 * The bar is a delivery receipt, not a status flag. A carrier gets paid by
 * sending an invoice with the signed delivery attached, and the receipt only
 * exists once every vehicle has a sealed delivery inspection — so requiring it
 * enforces the whole chain without asking anyone to remember a status.
 */
export async function checkInvoiceable(scoped: ScopedDb, loadId: string): Promise<InvoiceGate> {
  const load = await scoped.selectOne('loads', eq(loadsTable.id, loadId));
  if (!load) return { ok: false, reason: 'No such load.' };

  if (load.status === 'cancelled' || load.status === 'declined') {
    return { ok: false, reason: 'This load was cancelled, so there is nothing to bill.' };
  }

  if (!load.customerId) {
    return {
      ok: false,
      reason: 'This load has no customer on it, so there is nobody to address the invoice to.',
    };
  }

  const issued = await scoped.select(
    'documents',
    and(eq(documentsTable.loadId, loadId), eq(documentsTable.kind, 'pod')),
  );

  if (issued.length === 0) {
    return {
      ok: false,
      reason:
        'No delivery receipt has been issued for this load. A broker holds an invoice it cannot ' +
        'tie to a signed delivery, so the receipt comes first.',
    };
  }

  const open = await scoped.select('invoices', eq(invoicesTable.loadId, loadId));
  const live = open.filter((invoice) => invoice.status !== 'void');

  if (live.length > 0) {
    return { ok: false, reason: `This load is already on invoice ${live[0]?.number}.` };
  }

  return { ok: true };
}

/** Next free invoice number, checked against every number this org has used. */
export async function nextInvoiceNumber(scoped: ScopedDb, loadNumber: string): Promise<string> {
  const existing = await scoped.select('invoices');
  return nextNumberFrom(`INV-${loadNumber}`, new Set(existing.map((invoice) => invoice.number)));
}

export interface CreateResult {
  ok: boolean;
  invoiceId?: string;
  number?: string;
  basis?: BillingBasis;
  error?: string;
}

/** Raises a draft invoice from what the load already records. */
export async function createInvoiceForLoad(
  scoped: ScopedDb,
  loadId: string,
): Promise<CreateResult> {
  const gate = await checkInvoiceable(scoped, loadId);
  if (!gate.ok) return { ok: false, error: gate.reason };

  const load = await scoped.selectOne('loads', eq(loadsTable.id, loadId));
  if (!load) return { ok: false, error: 'No such load.' };

  const customer = load.customerId
    ? await scoped.selectOne('customers', eq(customersTable.id, load.customerId))
    : null;

  const { charges, basis } = deriveCharges(load);
  const number = await nextInvoiceNumber(scoped, load.number);

  const terms = load.paymentTerms ?? customer?.defaultPaymentTerms ?? null;

  const [created] = await scoped.insert('invoices', {
    number,
    loadId,
    customerId: load.customerId,
    status: 'draft',
    lineHaulCents: charges.lineHaulCents,
    fuelSurchargeCents: charges.fuelSurchargeCents,
    accessorialCents: charges.accessorialCents,
    codCollectedCents: charges.codCollectedCents,
    depositCents: charges.depositCents,
    taxCents: charges.taxCents,
    totalCents: totalCents(charges),
    paidCents: 0,
    terms,
  });

  if (!created) return { ok: false, error: 'The invoice could not be created.' };

  return { ok: true, invoiceId: created.id, number, basis };
}

/** The figures a draft can still be corrected on. */
export interface DraftEdits {
  charges: Charges;
  terms: PaymentTerms | null;
  factoringCompanyName: string | null;
  factoringNoticeText: string | null;
  notes: string | null;
}

export async function updateDraft(
  scoped: ScopedDb,
  invoiceId: string,
  edits: DraftEdits,
): Promise<{ ok: boolean; error?: string }> {
  const invoice = await scoped.selectOne('invoices', eq(invoicesTable.id, invoiceId));
  if (!invoice) return { ok: false, error: 'No such invoice.' };

  if (invoice.status !== 'draft') {
    return {
      ok: false,
      error:
        'This invoice has already been issued. The customer is holding a document that states ' +
        'these figures, so it has to be voided and raised again rather than edited.',
    };
  }

  /*
   * Itemised lines win over the typed figure. Once a carrier has broken the
   * accessorials out, the sum of those lines is the only number that can be
   * right — the form keeps the field read-only for the same reason, and this
   * is the check that holds if a request arrives without going through it.
   */
  const lines = await accessorialsFor(scoped, invoiceId);
  const accessorialCents =
    lines.length > 0 ? sumAccessorials(lines) : edits.charges.accessorialCents;
  const charges: Charges = { ...edits.charges, accessorialCents };

  await scoped.update('invoices', eq(invoicesTable.id, invoiceId), {
    lineHaulCents: charges.lineHaulCents,
    fuelSurchargeCents: charges.fuelSurchargeCents,
    accessorialCents: charges.accessorialCents,
    codCollectedCents: charges.codCollectedCents,
    depositCents: charges.depositCents,
    taxCents: charges.taxCents,
    totalCents: totalCents(charges),
    terms: edits.terms,
    factoringCompanyName: edits.factoringCompanyName,
    factoringNoticeText: edits.factoringNoticeText,
    notes: edits.notes,
  });

  return { ok: true };
}

/* -------------------------------------------------------------------------
 * Assembling the printable invoice
 * ---------------------------------------------------------------------- */

function venueLine(
  venue: { name: string; city: string; state: string } | null,
  fallback: string,
): string {
  if (!venue) return fallback;
  return `${venue.name}\n${venue.city}, ${venue.state}`;
}

export async function buildInvoiceInput(
  scoped: ScopedDb,
  invoiceId: string,
): Promise<InvoiceInput | { error: string }> {
  const invoice = await scoped.selectOne('invoices', eq(invoicesTable.id, invoiceId));
  if (!invoice) return { error: 'No such invoice.' };

  const org = await getOrganization(scoped.orgId);
  if (!org) return { error: 'The organisation record is missing.' };

  const customer = invoice.customerId
    ? await scoped.selectOne('customers', eq(customersTable.id, invoice.customerId))
    : null;

  const load = invoice.loadId
    ? await scoped.selectOne('loads', eq(loadsTable.id, invoice.loadId))
    : null;

  const [vehicles, stops, issuedDocuments, paymentRows] = await Promise.all([
    load ? scoped.select('vehicles', eq(vehiclesTable.loadId, load.id)) : Promise.resolve([]),
    load ? scoped.select('stops', eq(stopsTable.loadId, load.id)) : Promise.resolve([]),
    load ? scoped.select('documents', eq(documentsTable.loadId, load.id)) : Promise.resolve([]),
    scoped.select('payments', eq(paymentsTable.invoiceId, invoiceId)),
  ]);

  const venueFor = async (kind: 'pickup' | 'delivery') => {
    const stop = stops.find((s) => s.kind === kind);
    if (!stop?.venueId) return null;
    return (await scoped.selectOne('venues', eq(venuesTable.id, stop.venueId))) ?? null;
  };

  const [pickupVenue, deliveryVenue] = await Promise.all([venueFor('pickup'), venueFor('delivery')]);

  // Only the current version of each document is cited. A superseded bill of
  // lading is retained, but pointing an accounts department at it would have
  // them checking a hash against a file nobody sent them.
  const superseded = new Set(
    issuedDocuments.map((d) => d.supersedesDocumentId).filter((id): id is string => id !== null),
  );

  const attachments: AttachedDocument[] = issuedDocuments
    .filter((document) => !superseded.has(document.id))
    .filter((document) => document.kind === 'bol' || document.kind === 'pod')
    .map((document) => ({
      kind: document.kind === 'bol' ? 'Bill of lading' : 'Delivery receipt',
      number: document.title.replace(/^(Bill of lading|Delivery receipt)\s+/, ''),
      sha256: document.sha256,
    }));

  const charges: Charges = {
    lineHaulCents: invoice.lineHaulCents,
    fuelSurchargeCents: invoice.fuelSurchargeCents,
    accessorialCents: invoice.accessorialCents,
    taxCents: invoice.taxCents,
    codCollectedCents: invoice.codCollectedCents,
    depositCents: invoice.depositCents,
  };

  const issuedAt = invoice.issuedAt ?? new Date();

  return {
    invoiceNumber: invoice.number,
    loadNumber: load?.number ?? '—',
    issuedAt,
    dueAt: invoice.dueAt ?? dueDateFor(issuedAt, invoice.terms),
    terms: invoice.terms,

    carrier: {
      name: org.legalName,
      addressLine1: org.addressLine1,
      addressLine2: org.addressLine2,
      city: org.city,
      state: org.state,
      postalCode: org.postalCode,
      phone: org.phone,
      email: org.email,
      usdotNumber: org.usdotNumber,
      mcNumber: org.mcNumber,
    },

    billTo: {
      name: customer?.name ?? 'Customer not recorded',
      contactName: customer?.contactName,
      addressLine1: customer?.addressLine1,
      city: customer?.city,
      state: customer?.state,
      postalCode: customer?.postalCode,
      phone: customer?.phone,
      email: customer?.email,
      mcNumber: customer?.mcNumber ? `MC ${customer.mcNumber}` : null,
    },

    charges,
    accessorials: await accessorialsFor(scoped, invoiceId),
    brand: await brandFor(scoped, 'invoice'),
    paidCents: invoice.paidCents,
    currency: invoice.currency,

    vehicles: vehicles.map((vehicle) => ({
      vin: vehicle.vin,
      description:
        [vehicle.year, vehicle.make, vehicle.model, vehicle.color].filter(Boolean).join(' ') ||
        'Not decoded',
    })),

    payments: paymentRows
      .slice()
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
      .map((payment) => ({
        receivedAt: payment.receivedAt,
        method: payment.method,
        reference: payment.reference,
        amountCents: payment.amountCents,
      })),

    attachments,

    originLine: venueLine(pickupVenue, 'Origin not recorded'),
    destinationLine: venueLine(deliveryVenue, 'Destination not recorded'),
    distanceMiles: load?.distanceMiles ?? null,
    deliveredAt: load?.deliveredAt ?? null,

    factoringCompanyName: invoice.factoringCompanyName,
    factoringNoticeText: invoice.factoringNoticeText,
    notes: invoice.notes,
    purchaseOrderNumber: load?.purchaseOrderNumber ?? null,
  };
}

/* -------------------------------------------------------------------------
 * Issuing
 * ---------------------------------------------------------------------- */

export interface IssueResult {
  ok: boolean;
  documentId?: string;
  sha256?: string;
  number?: string;
  error?: string;
}

/**
 * Freezes the invoice and sets its clock running.
 *
 * The issue date is stamped here rather than at creation: a draft raised on
 * Friday and corrected on Monday is due thirty days from Monday, because
 * Monday is the day the customer was asked for money.
 */
export async function issueInvoice(scoped: ScopedDb, invoiceId: string): Promise<IssueResult> {
  const invoice = await scoped.selectOne('invoices', eq(invoicesTable.id, invoiceId));
  if (!invoice) return { ok: false, error: 'No such invoice.' };

  if (invoice.status === 'void') {
    return { ok: false, error: 'This invoice was voided and cannot be issued.' };
  }
  if (invoice.status !== 'draft') {
    return { ok: false, error: 'This invoice has already been issued.' };
  }
  if (!invoice.customerId) {
    return { ok: false, error: 'There is no customer to address this invoice to.' };
  }

  const issuedAt = new Date();
  const dueAt = dueDateFor(issuedAt, invoice.terms);

  await scoped.update('invoices', eq(invoicesTable.id, invoiceId), {
    status: 'sent',
    issuedAt,
    sentAt: issuedAt,
    dueAt,
  });

  const assembled = await buildInvoiceInput(scoped, invoiceId);
  if ('error' in assembled) return { ok: false, error: assembled.error };

  const stored = await storeDocument({
    scoped,
    kind: 'invoice',
    loadId: invoice.loadId,
    subject: `invoice:${invoiceId}`,
    title: `Invoice ${invoice.number}`,
    bytes: await renderInvoice(assembled),
    supersedesDocumentId: invoice.documentId,
  });

  if ('error' in stored) return { ok: false, error: stored.error };

  await scoped.update('invoices', eq(invoicesTable.id, invoiceId), {
    documentId: stored.documentId,
  });

  // The load now reflects where the money is, which is what the status column
  // is for — there is no separate screen anybody has to remember to update.
  if (invoice.loadId) {
    await scoped.update('loads', eq(loadsTable.id, invoice.loadId), { status: 'invoiced' });
  }

  return { ok: true, documentId: stored.documentId, sha256: stored.sha256, number: invoice.number };
}

/* -------------------------------------------------------------------------
 * Payments
 * ---------------------------------------------------------------------- */

export interface RecordPaymentInput {
  amountCents: number;
  method: PaymentMethod;
  reference: string | null;
  receivedAt: Date;
  notes: string | null;
}

export interface PaymentResult {
  ok: boolean;
  paidCents?: number;
  balanceCents?: number;
  error?: string;
}

/**
 * Records money received and recomputes the invoice from its payments.
 *
 * The paid total is rewritten from the payment rows rather than incremented,
 * so a corrected or removed payment cannot leave a stale figure behind that
 * quietly says an invoice is settled when it is not.
 */
export async function recordPayment(
  scoped: ScopedDb,
  invoiceId: string,
  input: RecordPaymentInput,
): Promise<PaymentResult> {
  const invoice = await scoped.selectOne('invoices', eq(invoicesTable.id, invoiceId));
  if (!invoice) return { ok: false, error: 'No such invoice.' };

  if (invoice.status === 'void') {
    return { ok: false, error: 'This invoice was voided. Money received against it needs a credit, not a payment.' };
  }
  if (invoice.status === 'draft') {
    return { ok: false, error: 'This invoice has not been issued yet, so nothing is owed against it.' };
  }
  if (input.amountCents === 0) {
    return { ok: false, error: 'Enter the amount received.' };
  }

  await scoped.insert('payments', {
    invoiceId,
    amountCents: input.amountCents,
    method: input.method,
    reference: input.reference,
    receivedAt: input.receivedAt,
    notes: input.notes,
  });

  const rows = await scoped.select('payments', eq(paymentsTable.invoiceId, invoiceId));
  const paid = sumPayments(rows);

  /*
   * Credits count toward settling the balance just as payments do, so they are
   * part of the status. Leaving them out strands an invoice at "partially
   * paid" when a credit and a payment together clear it, and the carrier then
   * chases a balance that is not owed.
   */
  const credited = invoice.creditedCents;
  const status = statusAfterPayment(invoice.totalCents, paid, credited);

  await scoped.update('invoices', eq(invoicesTable.id, invoiceId), {
    paidCents: paid,
    status,
    paidAt: status === 'paid' ? input.receivedAt : null,
  });

  if (status === 'paid' && invoice.loadId) {
    await scoped.update('loads', eq(loadsTable.id, invoice.loadId), { status: 'paid' });
  }

  return {
    ok: true,
    paidCents: paid,
    balanceCents: balanceCents(invoice.totalCents, paid, credited),
  };
}

/* -------------------------------------------------------------------------
 * Voiding
 * ---------------------------------------------------------------------- */

export async function voidInvoice(
  scoped: ScopedDb,
  invoiceId: string,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  const invoice = await scoped.selectOne('invoices', eq(invoicesTable.id, invoiceId));
  if (!invoice) return { ok: false, error: 'No such invoice.' };

  if (invoice.status === 'void') return { ok: false, error: 'This invoice is already void.' };

  const paid = await scoped.select('payments', eq(paymentsTable.invoiceId, invoiceId));
  if (paid.length > 0) {
    return {
      ok: false,
      error:
        'Payments have been recorded against this invoice, so voiding it would erase money that ' +
        'was actually received. Raise a credit against it instead.',
    };
  }

  if (!reason.trim()) {
    return { ok: false, error: 'Say why this invoice is being voided — it stays on the record.' };
  }

  await scoped.update('invoices', eq(invoicesTable.id, invoiceId), {
    status: 'void',
    voidedAt: new Date(),
    voidReason: reason.trim(),
  });

  // The load becomes billable again, which it is: nothing was collected.
  if (invoice.loadId) {
    const load = await scoped.selectOne('loads', eq(loadsTable.id, invoice.loadId));
    if (load?.status === 'invoiced') {
      await scoped.update('loads', eq(loadsTable.id, invoice.loadId), { status: 'delivered' });
    }
  }

  return { ok: true };
}
