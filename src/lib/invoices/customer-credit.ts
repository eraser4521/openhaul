import 'server-only';
import { and, eq } from 'drizzle-orm';
import {
  creditNotes as creditNotesTable,
  customerCredits as creditsTable,
  customers as customersTable,
  invoices as invoicesTable,
  loads as loadsTable,
} from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { appendAudit, AUDIT } from '../audit/chain';
import { balanceCents, creditBalance, refundableCents, settledStatus } from './compute';
import { sumRefundsFor } from './refunds';

/**
 * Money the carrier is holding for a customer.
 *
 * An overpaid invoice can be settled two ways, and the credit note the
 * customer receives says so in as many words: refunded, or carried against
 * their next invoice. Only the first was ever modelled. This is the second.
 *
 * It is a ledger, not a column. The balance is the sum of its movements, for
 * the same reason `paid_cents` is rebuilt from payments every time: a running
 * total on the customer record drifts the first time a movement is corrected,
 * and a customer's balance drifting is the carrier quietly keeping or giving
 * away money that nobody can account for afterwards.
 *
 * Every movement names an invoice. That is what makes the ledger answer the
 * question actually asked a year later — "you kept $500 of ours in March,
 * where did it go?" — rather than showing a figure with no history.
 *
 * The balance is fungible, deliberately. No attempt is made to match a
 * particular application back to the particular overpayment that funded it:
 * the customer has an amount with the carrier, the same way a bank balance
 * works, and pretending otherwise would invent a matching rule nobody agreed.
 */

export interface CreditMovementInput {
  amountCents: number;
  occurredAt: Date;
  note: string | null;
}

export interface CarryForwardInput extends CreditMovementInput {
  /** The credit note that put the invoice into overpayment, where one did. */
  creditNoteId: string | null;
}

export interface CreditResult {
  ok: boolean;
  error?: string;
  movementId?: string;
  /** The customer's balance after the movement. */
  balanceCents?: number;
}

/* -------------------------------------------------------------------------
 * Reading
 * ---------------------------------------------------------------------- */

/** Every movement for a customer, newest first. */
export async function movementsFor(scoped: ScopedDb, customerId: string) {
  const rows = await scoped.select('customerCredits', eq(creditsTable.customerId, customerId));
  return rows.slice().sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
}

/** Movements touching one invoice, in either direction. */
export async function movementsForInvoice(scoped: ScopedDb, invoiceId: string) {
  const rows = await scoped.select('customerCredits', eq(creditsTable.invoiceId, invoiceId));
  return rows.slice().sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
}

export async function balanceFor(scoped: ScopedDb, customerId: string): Promise<number> {
  return creditBalance(await movementsFor(scoped, customerId));
}

/**
 * Every customer's balance in one query.
 *
 * The customers screen shows all of them at once, and a query per customer
 * there is a query per customer on every page load.
 */
export async function balancesByCustomer(scoped: ScopedDb): Promise<Map<string, number>> {
  const rows = await scoped.select('customerCredits');
  const balances = new Map<string, number>();

  for (const row of rows) {
    const delta = row.direction === 'in' ? row.amountCents : -row.amountCents;
    balances.set(row.customerId, (balances.get(row.customerId) ?? 0) + delta);
  }

  return balances;
}

/* -------------------------------------------------------------------------
 * Rebuilding the invoice's derived figures
 * ---------------------------------------------------------------------- */

/**
 * Rewrites an invoice's two credit columns from the movements that exist.
 *
 * The same discipline the paid and credited totals follow. A removed movement
 * that left a stale figure behind would leave an invoice claiming it was
 * settled with money that is no longer recorded anywhere.
 */
export async function recomputeInvoiceCredit(
  scoped: ScopedDb,
  invoiceId: string,
): Promise<{ appliedCents: number; carriedCents: number; balanceCents: number } | null> {
  const invoice = await scoped.selectOne('invoices', eq(invoicesTable.id, invoiceId));
  if (!invoice) return null;

  const rows = await scoped.select('customerCredits', eq(creditsTable.invoiceId, invoiceId));

  const applied = rows
    .filter((row) => row.direction === 'out')
    .reduce((sum, row) => sum + row.amountCents, 0);
  const carried = rows
    .filter((row) => row.direction === 'in')
    .reduce((sum, row) => sum + row.amountCents, 0);

  const refunded = await sumRefundsFor(scoped, invoiceId);
  const position = {
    ...invoice,
    appliedCreditCents: applied,
    carriedForwardCents: carried,
    refundedCents: refunded,
  };

  const status = invoice.status === 'void' ? invoice.status : settledStatus(position);
  const balance = balanceCents(position);

  await scoped.update('invoices', eq(invoicesTable.id, invoiceId), {
    appliedCreditCents: applied,
    carriedForwardCents: carried,
    status,
    /*
     * `paidAt` only moves when money actually arrived, the same rule credit
     * notes follow. Credit applied from a balance is money that arrived once,
     * on a different invoice, and stamping this one with a payment date it
     * never had would misdate the receipt.
     */
    paidAt: invoice.paidCents > 0 && balance <= 0 ? (invoice.paidAt ?? new Date()) : invoice.paidAt,
  });

  /*
   * The load does follow, which is a deliberate difference from a credit
   * note. A credit to zero forgives the charge and no money exists; credit
   * applied is money the carrier is already holding, so the load really is
   * settled and leaving it at "invoiced" would misreport the book.
   */
  if (invoice.loadId && status === 'paid' && applied > 0) {
    await scoped.update('loads', eq(loadsTable.id, invoice.loadId), { status: 'paid' });
  }

  return { appliedCents: applied, carriedCents: carried, balanceCents: balance };
}

/* -------------------------------------------------------------------------
 * Carrying an overpayment forward
 * ---------------------------------------------------------------------- */

export interface CarryGate {
  ok: boolean;
  reason?: string;
  /** Owed back and not yet refunded or carried. Zero when nothing is. */
  carryableCents: number;
  customerId?: string;
  customerName?: string;
}

/**
 * Whether an overpayment can be moved into the customer's balance.
 *
 * Draws on the same figure a refund does, which is the point: $500 overpaid
 * cannot be both sent back and kept.
 */
export async function checkCarryForward(
  scoped: ScopedDb,
  invoiceId: string,
): Promise<CarryGate> {
  const invoice = await scoped.selectOne('invoices', eq(invoicesTable.id, invoiceId));
  if (!invoice) return { ok: false, reason: 'No such invoice.', carryableCents: 0 };

  if (invoice.status === 'draft') {
    return {
      ok: false,
      reason: 'This invoice has not been issued, so nothing has been collected against it.',
      carryableCents: 0,
    };
  }

  if (!invoice.customerId) {
    return {
      ok: false,
      reason:
        'There is no customer on this invoice, so there is no account to hold the money. ' +
        'Add one, or refund it instead.',
      carryableCents: 0,
    };
  }

  const refunded = await sumRefundsFor(scoped, invoiceId);
  const carryable = refundableCents({ ...invoice, refundedCents: refunded });

  if (carryable === 0) {
    return {
      ok: false,
      reason:
        invoice.carriedForwardCents > 0 || refunded > 0
          ? 'Everything owed back on this invoice has already been dealt with.'
          : 'Nothing is owed back on this invoice.',
      carryableCents: 0,
      customerId: invoice.customerId,
    };
  }

  const customer = await scoped.selectOne('customers', eq(customersTable.id, invoice.customerId));

  return {
    ok: true,
    carryableCents: carryable,
    customerId: invoice.customerId,
    customerName: customer?.name,
  };
}

/**
 * Moves an overpayment off the invoice and into the customer's balance.
 *
 * The invoice settles exactly as it would on a refund — the money is no
 * longer held against it — but nothing left the bank, which is why this is a
 * movement rather than a refund with a made-up payment method. A refunds
 * report that counted these would claim money went out that did not.
 */
export async function carryForward(
  scoped: ScopedDb,
  invoiceId: string,
  input: CarryForwardInput,
): Promise<CreditResult> {
  if (input.amountCents <= 0) return { ok: false, error: 'Enter the amount to carry forward.' };

  const gate = await checkCarryForward(scoped, invoiceId);
  if (!gate.ok || !gate.customerId) return { ok: false, error: gate.reason };

  if (input.amountCents > gate.carryableCents) {
    return {
      ok: false,
      error:
        `Only ${(gate.carryableCents / 100).toFixed(2)} is owed back on this invoice. ` +
        'Carrying more than that would leave it looking unpaid.',
    };
  }

  if (input.creditNoteId) {
    const note = await scoped.selectOne('creditNotes', eq(creditNotesTable.id, input.creditNoteId));
    if (!note || note.invoiceId !== invoiceId) {
      return { ok: false, error: 'That credit note is not against this invoice.' };
    }
  }

  const [row] = await scoped.insert('customerCredits', {
    customerId: gate.customerId,
    direction: 'in',
    amountCents: input.amountCents,
    invoiceId,
    creditNoteId: input.creditNoteId,
    occurredAt: input.occurredAt,
    note: input.note,
  });

  if (!row) return { ok: false, error: 'That could not be recorded.' };

  await recomputeInvoiceCredit(scoped, invoiceId);
  const balance = await balanceFor(scoped, gate.customerId);

  await appendAudit({
    orgId: scoped.orgId,
    action: AUDIT.creditCarriedForward,
    subject: `customer:${gate.customerId}`,
    detail: {
      movementId: row.id,
      invoiceId,
      amountCents: input.amountCents,
      creditNoteId: input.creditNoteId,
      balanceCents: balance,
      occurredAt: input.occurredAt.toISOString(),
    },
  });

  return { ok: true, movementId: row.id, balanceCents: balance };
}

/* -------------------------------------------------------------------------
 * Spending it
 * ---------------------------------------------------------------------- */

export interface ApplyGate {
  ok: boolean;
  reason?: string;
  /** The most that can go on this invoice: the lesser of balance and owed. */
  applicableCents: number;
  /** What the customer holds in total. */
  balanceCents: number;
  customerId?: string;
  customerName?: string;
}

/**
 * Whether the customer's balance can be spent against this invoice.
 *
 * Bounded twice. Never more than the customer holds, which would be inventing
 * money; and never more than the invoice owes, which would push it into
 * overpayment against itself and start the whole cycle again.
 */
export async function checkApplicable(scoped: ScopedDb, invoiceId: string): Promise<ApplyGate> {
  const empty = { applicableCents: 0, balanceCents: 0 };

  const invoice = await scoped.selectOne('invoices', eq(invoicesTable.id, invoiceId));
  if (!invoice) return { ok: false, reason: 'No such invoice.', ...empty };

  if (invoice.status === 'draft') {
    return {
      ok: false,
      reason: 'This invoice has not been issued yet, so nothing is owed against it.',
      ...empty,
    };
  }
  if (invoice.status === 'void') {
    return { ok: false, reason: 'This invoice was voided, so nothing is owed against it.', ...empty };
  }
  if (!invoice.customerId) {
    return { ok: false, reason: 'There is no customer on this invoice.', ...empty };
  }

  const [balance, refunded, customer] = await Promise.all([
    balanceFor(scoped, invoice.customerId),
    sumRefundsFor(scoped, invoiceId),
    scoped.selectOne('customers', eq(customersTable.id, invoice.customerId)),
  ]);

  const owed = Math.max(0, balanceCents({ ...invoice, refundedCents: refunded }));
  const shared = { balanceCents: balance, customerId: invoice.customerId, customerName: customer?.name };

  if (balance <= 0) {
    return {
      ok: false,
      reason: `${customer?.name ?? 'This customer'} has no credit balance to apply.`,
      applicableCents: 0,
      ...shared,
    };
  }
  if (owed === 0) {
    return {
      ok: false,
      reason: 'Nothing is owed on this invoice.',
      applicableCents: 0,
      ...shared,
    };
  }

  return { ok: true, applicableCents: Math.min(balance, owed), ...shared };
}

export async function applyCredit(
  scoped: ScopedDb,
  invoiceId: string,
  input: CreditMovementInput,
): Promise<CreditResult> {
  if (input.amountCents <= 0) return { ok: false, error: 'Enter the amount to apply.' };

  const gate = await checkApplicable(scoped, invoiceId);
  if (!gate.ok || !gate.customerId) return { ok: false, error: gate.reason };

  if (input.amountCents > gate.applicableCents) {
    return {
      ok: false,
      error:
        `Only ${(gate.applicableCents / 100).toFixed(2)} can go on this invoice — ` +
        'the lesser of what the customer holds and what the invoice still owes.',
    };
  }

  const [row] = await scoped.insert('customerCredits', {
    customerId: gate.customerId,
    direction: 'out',
    amountCents: input.amountCents,
    invoiceId,
    creditNoteId: null,
    occurredAt: input.occurredAt,
    note: input.note,
  });

  if (!row) return { ok: false, error: 'That could not be recorded.' };

  await recomputeInvoiceCredit(scoped, invoiceId);
  const balance = await balanceFor(scoped, gate.customerId);

  await appendAudit({
    orgId: scoped.orgId,
    action: AUDIT.creditApplied,
    subject: `customer:${gate.customerId}`,
    detail: {
      movementId: row.id,
      invoiceId,
      amountCents: input.amountCents,
      balanceCents: balance,
      occurredAt: input.occurredAt.toISOString(),
    },
  });

  return { ok: true, movementId: row.id, balanceCents: balance };
}

/* -------------------------------------------------------------------------
 * Undoing one
 * ---------------------------------------------------------------------- */

/**
 * Removes a movement recorded in error, or changed its mind about.
 *
 * Deleted rather than reversed, matching how a payment and a refund are
 * corrected: a movement is the carrier's own ledger entry, not a document
 * anybody outside is holding. The audit chain keeps that it existed.
 *
 * Removing a carry-forward is refused once the money has been spent. The
 * alternative is a negative balance, which is not a thing a customer account
 * can be — it would say the customer owes the carrier money that nothing on
 * any invoice accounts for. Undo the application first, which the message
 * says.
 */
export async function removeMovement(
  scoped: ScopedDb,
  movementId: string,
): Promise<{ ok: boolean; error?: string }> {
  const movement = await scoped.selectOne('customerCredits', eq(creditsTable.id, movementId));
  if (!movement) return { ok: false, error: 'No such credit movement.' };

  if (movement.direction === 'in') {
    const balance = await balanceFor(scoped, movement.customerId);
    if (balance - movement.amountCents < 0) {
      const spent = await spentSince(scoped, movement.customerId);
      return {
        ok: false,
        error:
          'That credit has already been applied to ' +
          (spent.length > 0 ? spent.join(', ') : 'another invoice') +
          '. Remove the application first.',
      };
    }
  }

  await scoped.remove('customerCredits', eq(creditsTable.id, movementId));
  await recomputeInvoiceCredit(scoped, movement.invoiceId);

  await appendAudit({
    orgId: scoped.orgId,
    action: AUDIT.creditMovementRemoved,
    subject: `customer:${movement.customerId}`,
    detail: {
      movementId,
      invoiceId: movement.invoiceId,
      direction: movement.direction,
      amountCents: movement.amountCents,
    },
  });

  return { ok: true };
}

/** Invoice numbers this customer's balance has been spent on, for the refusal. */
async function spentSince(scoped: ScopedDb, customerId: string): Promise<string[]> {
  const rows = await scoped.select(
    'customerCredits',
    and(eq(creditsTable.customerId, customerId), eq(creditsTable.direction, 'out')),
  );

  const numbers: string[] = [];
  for (const row of rows.slice(0, 5)) {
    const invoice = await scoped.selectOne('invoices', eq(invoicesTable.id, row.invoiceId));
    if (invoice) numbers.push(invoice.number);
  }

  return numbers;
}
