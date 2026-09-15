import 'server-only';
import { eq, inArray } from 'drizzle-orm';
import {
  creditNotes as creditNotesTable,
  customerCredits as creditsTable,
  customers as customersTable,
  invoices as invoicesTable,
  payments as paymentsTable,
  refunds as refundsTable,
  statements as statementsTable,
  type Invoice,
} from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { getOrganization } from '../organization/profile';
import { storeDocument } from '../documents/store';
import { renderStatement } from '../documents/statement';
import { brandFor } from '../branding/template';
import { appendAudit, AUDIT } from '../audit/chain';
import { balanceCents } from './compute';
import {
  agedTotals,
  describeWindow,
  inOrder,
  openItems,
  reconcile,
  totalsFor,
  windowStart,
  withRunningBalance,
  within,
  type StatementEntry,
} from './statement';

/**
 * Assembling a customer's statement and freezing it.
 *
 * The gathering is separated from the arithmetic so the arithmetic can be
 * tested without a database, and from the rendering so a statement that does
 * not add up never reaches a page. That last part is the whole reason this
 * function can fail: a statement whose movements do not sum to its closing
 * balance turns a collections call into an argument about the statement, and
 * refusing to produce one is strictly better than sending it.
 *
 * Drafts and voided invoices are excluded outright. A draft has never been
 * shown to the customer and a void invoice was never validly owed — either
 * one appearing on a statement is the carrier claiming money it has not
 * asked for.
 */

export interface StatementResult {
  ok: boolean;
  error?: string;
  statementId?: string;
  documentId?: string;
  /** What the statement says is owed, for the screen that asked for it. */
  balanceCents?: number;
  heldCents?: number;
  entryCount?: number;
}

export interface StatementRequest {
  /** How far back the movements are listed. Balances are always as at now. */
  windowDays: number;
  now?: Date;
}

/**
 * Every dated movement on a customer's account.
 *
 * Exported for the screen, which shows the same figures before anybody
 * commits them to a document — a carrier should be able to see what a
 * statement would say without producing one.
 */
export async function gatherEntries(
  scoped: ScopedDb,
  customerId: string,
): Promise<{ entries: StatementEntry[]; invoices: Invoice[] }> {
  const all = await scoped.select('invoices', eq(invoicesTable.customerId, customerId));
  const live = all.filter(
    (invoice) => invoice.status !== 'draft' && invoice.status !== 'void',
  );

  const ids = live.map((invoice) => invoice.id);
  const [payments, notes, refunds, movements] =
    ids.length > 0
      ? await Promise.all([
          scoped.select('payments', inArray(paymentsTable.invoiceId, ids)),
          scoped.select('creditNotes', inArray(creditNotesTable.invoiceId, ids)),
          scoped.select('refunds', inArray(refundsTable.invoiceId, ids)),
          scoped.select('customerCredits', eq(creditsTable.customerId, customerId)),
        ])
      : [[], [], [], await scoped.select('customerCredits', eq(creditsTable.customerId, customerId))];

  const numbers = new Map(live.map((invoice) => [invoice.id, invoice.number]));
  const entries: StatementEntry[] = [];

  for (const invoice of live) {
    entries.push({
      at: invoice.issuedAt ?? invoice.createdAt,
      kind: 'invoice',
      reference: invoice.number,
      detail: null,
      dueCents: invoice.totalCents,
      heldCents: 0,
    });
  }

  for (const payment of payments) {
    entries.push({
      at: payment.receivedAt,
      kind: 'payment',
      reference: numbers.get(payment.invoiceId) ?? '—',
      detail: payment.reference,
      dueCents: -payment.amountCents,
      heldCents: 0,
    });
  }

  for (const note of notes) {
    entries.push({
      at: note.issuedAt ?? note.createdAt,
      kind: 'credit_note',
      reference: note.number,
      detail: note.detail,
      dueCents: -note.amountCents,
      heldCents: 0,
    });

    /*
     * A withdrawn credit note is still a document the customer holds. Leaving
     * it off entirely means they find it in their file and cannot see it on
     * the statement, so both movements are shown and they net to nothing.
     */
    if (note.voidedAt) {
      entries.push({
        at: note.voidedAt,
        kind: 'credit_note_void',
        reference: note.number,
        detail: note.voidReason,
        dueCents: note.amountCents,
        heldCents: 0,
      });
    }
  }

  for (const refund of refunds) {
    entries.push({
      at: refund.issuedAt,
      kind: 'refund',
      reference: numbers.get(refund.invoiceId) ?? '—',
      detail: refund.reference,
      dueCents: refund.amountCents,
      heldCents: 0,
    });
  }

  for (const movement of movements) {
    const kept = movement.direction === 'in';
    entries.push({
      at: movement.occurredAt,
      kind: kept ? 'credit_kept' : 'credit_applied',
      reference: numbers.get(movement.invoiceId) ?? '—',
      detail: movement.note,
      dueCents: kept ? movement.amountCents : -movement.amountCents,
      heldCents: kept ? movement.amountCents : -movement.amountCents,
    });
  }

  return { entries: inOrder(entries), invoices: live };
}

export interface StatementView {
  from: Date;
  periodLabel: string;
  totals: ReturnType<typeof totalsFor>;
  items: ReturnType<typeof openItems>;
  aged: ReturnType<typeof agedTotals>;
  activity: ReturnType<typeof withRunningBalance>;
  reconciliation: ReturnType<typeof reconcile>;
}

/** Everything the document would say, without producing one. */
export async function statementView(
  scoped: ScopedDb,
  customerId: string,
  request: StatementRequest,
): Promise<StatementView> {
  const now = request.now ?? new Date();
  const from = windowStart(request.windowDays, now);

  const { entries, invoices } = await gatherEntries(scoped, customerId);

  const refunds = await scoped.select('refunds');
  const refundedBy = new Map<string, number>();
  for (const refund of refunds) {
    refundedBy.set(refund.invoiceId, (refundedBy.get(refund.invoiceId) ?? 0) + refund.amountCents);
  }

  const positions = invoices.map((invoice) => ({
    ...invoice,
    refundedCents: refundedBy.get(invoice.id) ?? 0,
  }));

  const totals = totalsFor(entries, from);
  const items = openItems(positions, now);

  return {
    from,
    periodLabel: describeWindow(request.windowDays),
    totals,
    items,
    aged: agedTotals(items),
    activity: withRunningBalance(within(entries, from), totals.openingDueCents),
    reconciliation: reconcile(
      totals,
      positions.reduce((sum, invoice) => sum + balanceCents(invoice), 0),
    ),
  };
}

export async function buildStatement(
  scoped: ScopedDb,
  customerId: string,
  request: StatementRequest,
): Promise<StatementResult> {
  const now = request.now ?? new Date();

  const [org, customer] = await Promise.all([
    getOrganization(scoped.orgId),
    scoped.selectOne('customers', eq(customersTable.id, customerId)),
  ]);

  if (!org) return { ok: false, error: 'The organisation record is missing.' };
  if (!customer) return { ok: false, error: 'No such customer.' };

  const view = await statementView(scoped, customerId, { ...request, now });

  if (!view.reconciliation.ok) {
    /*
     * Never sent. The two figures come from different rows — one from adding
     * up movements, one from each invoice's own position — and a gap means
     * something is missing from the ledger. A statement that does not add up
     * gets every figure on it disputed instead of any of them paid.
     */
    return {
      ok: false,
      error:
        'This statement does not reconcile, so it has not been produced. The movements add to ' +
        `${(view.reconciliation.fromEntriesCents / 100).toFixed(2)} and the invoices to ` +
        `${(view.reconciliation.fromInvoicesCents / 100).toFixed(2)}. Please report it.`,
    };
  }

  const bytes = await renderStatement({
    issuedAt: now,
    periodFrom: view.from,
    periodLabel: view.periodLabel,
    brand: await brandFor(scoped, 'statement'),

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
      name: customer.name,
      contactName: customer.contactName,
      addressLine1: customer.addressLine1,
      city: customer.city,
      state: customer.state,
      postalCode: customer.postalCode,
      email: customer.email,
    },
    currency: 'USD',

    totals: view.totals,
    openItems: view.items,
    aged: view.aged,
    activity: view.activity,
  });

  const [row] = await scoped.insert('statements', {
    customerId,
    issuedAt: now,
    periodFrom: view.from,
    windowDays: request.windowDays,
    balanceCents: view.totals.closingDueCents,
    heldCents: view.totals.closingHeldCents,
    openItemCount: view.items.length,
    entryCount: view.activity.length,
  });

  if (!row) return { ok: false, error: 'The statement could not be recorded.' };

  const stored = await storeDocument({
    scoped,
    kind: 'statement',
    loadId: null,
    subject: `statement:${row.id}`,
    title: `Statement — ${customer.name} — ${now.toISOString().slice(0, 10)}`,
    bytes,
  });

  if ('error' in stored) return { ok: false, error: stored.error };

  await scoped.update('statements', eq(statementsTable.id, row.id), {
    documentId: stored.documentId,
  });

  await appendAudit({
    orgId: scoped.orgId,
    action: AUDIT.statementIssued,
    subject: `customer:${customerId}`,
    detail: {
      statementId: row.id,
      documentId: stored.documentId,
      windowDays: request.windowDays,
      from: view.from.toISOString(),
      balanceCents: view.totals.closingDueCents,
      heldCents: view.totals.closingHeldCents,
      openItems: view.items.length,
      entries: view.activity.length,
    },
  });

  return {
    ok: true,
    statementId: row.id,
    documentId: stored.documentId,
    balanceCents: view.totals.closingDueCents,
    heldCents: view.totals.closingHeldCents,
    entryCount: view.activity.length,
  };
}

/** Statements already produced for a customer, newest first. */
export async function statementsFor(scoped: ScopedDb, customerId: string) {
  const rows = await scoped.select('statements', eq(statementsTable.customerId, customerId));
  return rows.slice().sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime());
}

/** The statement a document belongs to, for the covering email. */
export async function statementForDocument(scoped: ScopedDb, documentId: string) {
  return scoped.selectOne('statements', eq(statementsTable.documentId, documentId));
}
