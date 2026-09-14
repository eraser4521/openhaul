import 'server-only';
import { eq } from 'drizzle-orm';
import {
  claims as claimsTable,
  creditNotes as creditNotesTable,
  invoices as invoicesTable,
} from '../db/schema';
import type { CreditReason } from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { balanceCents, statusAfterPayment } from './compute';
import { sumRefundsFor } from './refunds';

/**
 * Crediting an issued invoice.
 *
 * Not an edit, and not a void. Once an invoice has gone out the customer holds
 * a document stating a figure, and that figure is what was claimed from them.
 * Reducing it is therefore a second document that says so and references the
 * first — which is also why voiding stops being available the moment a payment
 * lands: voiding would erase money actually received.
 *
 * The credited total is rebuilt from the notes on every change, the same
 * discipline the paid total follows, so a voided credit cannot leave a stale
 * figure quietly forgiving a debt.
 */

/**
 * The next free credit note number for an invoice.
 *
 * Derived from the invoice it credits so the pair can be matched by eye on a
 * remittance advice, and never reused — a voided credit note keeps its number,
 * because it may already be in the customer's ledger.
 */
export function nextCreditNumber(invoiceNumber: string, taken: ReadonlySet<string>): string {
  const base = `CN-${invoiceNumber}`;
  if (!taken.has(base)) return base;

  for (let attempt = 2; attempt < 1000; attempt += 1) {
    const candidate = `${base}-${attempt}`;
    if (!taken.has(candidate)) return candidate;
  }

  throw new Error(`No free credit note number under ${base} after 999 attempts.`);
}

/** Credits that still count: a voided note forgives nothing. */
export function liveCredits<T extends { voidedAt: Date | null }>(notes: readonly T[]): T[] {
  return notes.filter((note) => note.voidedAt === null);
}

export function sumCredits(notes: readonly { amountCents: number; voidedAt: Date | null }[]): number {
  return liveCredits(notes).reduce((sum, note) => sum + note.amountCents, 0);
}

/* -------------------------------------------------------------------------
 * Gate
 * ---------------------------------------------------------------------- */

export interface CreditGate {
  ok: boolean;
  reason?: string;
  /** What is left before the credits would exceed the invoice. */
  creditableCents?: number;
}

export async function checkCreditable(
  scoped: ScopedDb,
  invoiceId: string,
): Promise<CreditGate> {
  const invoice = await scoped.selectOne('invoices', eq(invoicesTable.id, invoiceId));
  if (!invoice) return { ok: false, reason: 'No such invoice.' };

  if (invoice.status === 'draft') {
    return {
      ok: false,
      reason:
        'This invoice has not been issued. Correct the figures on it directly — nobody has been ' +
        'asked for this money yet.',
    };
  }

  if (invoice.status === 'void') {
    return { ok: false, reason: 'This invoice was voided, so there is nothing to credit.' };
  }

  const notes = await scoped.select('creditNotes', eq(creditNotesTable.invoiceId, invoiceId));
  const credited = sumCredits(notes);

  if (credited >= invoice.totalCents) {
    return {
      ok: false,
      reason: 'This invoice has already been credited in full.',
      creditableCents: 0,
    };
  }

  return { ok: true, creditableCents: invoice.totalCents - credited };
}

/* -------------------------------------------------------------------------
 * Raising
 * ---------------------------------------------------------------------- */

export interface RaiseCreditInput {
  invoiceId: string;
  reason: CreditReason;
  detail: string;
  amountCents: number;
  /** The claim this settles, when a cargo claim is taken off the freight bill. */
  claimId?: string | null;
}

export interface RaiseCreditResult {
  ok: boolean;
  creditNoteId?: string;
  number?: string;
  balanceCents?: number;
  error?: string;
}

export async function raiseCreditNote(
  scoped: ScopedDb,
  input: RaiseCreditInput,
): Promise<RaiseCreditResult> {
  const gate = await checkCreditable(scoped, input.invoiceId);
  if (!gate.ok) return { ok: false, error: gate.reason };

  if (input.amountCents <= 0) {
    return { ok: false, error: 'A credit has to be for a positive amount.' };
  }
  if (!input.detail.trim()) {
    return {
      ok: false,
      error: 'Say what is being credited and why. It goes on the face of the credit note.',
    };
  }

  /*
   * Credits cannot exceed what was invoiced. Going further would mean handing
   * back more than was ever charged, which is not a credit — it is a payment
   * out, and it belongs somewhere that records why money left.
   */
  if (input.amountCents > (gate.creditableCents ?? 0)) {
    return {
      ok: false,
      error:
        `Only ${((gate.creditableCents ?? 0) / 100).toFixed(2)} of this invoice is left to ` +
        'credit. Crediting more than was invoiced would be paying the customer, not crediting them.',
    };
  }

  const invoice = await scoped.selectOne('invoices', eq(invoicesTable.id, input.invoiceId));
  if (!invoice) return { ok: false, error: 'No such invoice.' };

  if (input.claimId) {
    const claim = await scoped.selectOne('claims', eq(claimsTable.id, input.claimId));
    if (!claim) return { ok: false, error: 'No such claim.' };
    if (claim.loadId !== invoice.loadId) {
      return { ok: false, error: 'That claim is against a different load.' };
    }
  }

  const existing = await scoped.select('creditNotes');
  const number = nextCreditNumber(invoice.number, new Set(existing.map((note) => note.number)));

  const [created] = await scoped.insert('creditNotes', {
    number,
    invoiceId: input.invoiceId,
    customerId: invoice.customerId,
    claimId: input.claimId ?? null,
    reason: input.reason,
    detail: input.detail.trim(),
    amountCents: input.amountCents,
    // Issued on creation. A credit note is one figure and one reason typed by
    // a person; a draft stage would add a step that checks nothing.
    issuedAt: new Date(),
  });

  if (!created) return { ok: false, error: 'The credit note could not be raised.' };

  const balance = await recomputeCredits(scoped, input.invoiceId);

  return { ok: true, creditNoteId: created.id, number, balanceCents: balance };
}

/* -------------------------------------------------------------------------
 * Voiding
 * ---------------------------------------------------------------------- */

export async function voidCreditNote(
  scoped: ScopedDb,
  creditNoteId: string,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  const note = await scoped.selectOne('creditNotes', eq(creditNotesTable.id, creditNoteId));
  if (!note) return { ok: false, error: 'No such credit note.' };
  if (note.voidedAt) return { ok: false, error: 'This credit note is already void.' };

  if (!reason.trim()) {
    return {
      ok: false,
      error:
        'Say why this credit is being withdrawn — it puts money back onto the customer’s balance ' +
        'and stays on the record.',
    };
  }

  await scoped.update('creditNotes', eq(creditNotesTable.id, creditNoteId), {
    voidedAt: new Date(),
    voidReason: reason.trim(),
  });

  await recomputeCredits(scoped, note.invoiceId);
  return { ok: true };
}

/* -------------------------------------------------------------------------
 * Keeping the invoice in step
 * ---------------------------------------------------------------------- */

/**
 * Rewrites the invoice's credited total from its notes and restates its status.
 *
 * Returns the resulting balance. Rebuilt rather than adjusted, so a voided
 * credit cannot leave a stale figure behind still forgiving the debt.
 */
export async function recomputeCredits(scoped: ScopedDb, invoiceId: string): Promise<number> {
  const invoice = await scoped.selectOne('invoices', eq(invoicesTable.id, invoiceId));
  if (!invoice) return 0;

  const notes = await scoped.select('creditNotes', eq(creditNotesTable.invoiceId, invoiceId));
  const credited = sumCredits(notes);

  /*
   * Money already sent back is part of the position, so voiding a credit after
   * a refund cannot leave the invoice claiming it still holds the customer's
   * money.
   */
  const refunded = await sumRefundsFor(scoped, invoiceId);

  const status =
    invoice.status === 'void'
      ? invoice.status
      : statusAfterPayment(invoice.totalCents, invoice.paidCents, credited, refunded);

  const balance = balanceCents(invoice.totalCents, invoice.paidCents, credited, refunded);

  await scoped.update('invoices', eq(invoicesTable.id, invoiceId), {
    creditedCents: credited,
    status,
    /*
     * Settled by credit is not the same as paid, so `paidAt` only moves when
     * money actually arrived. An invoice credited to zero has a settled
     * balance and no payment date, which is exactly what happened.
     */
    paidAt: invoice.paidCents > 0 && balance <= 0 ? (invoice.paidAt ?? new Date()) : invoice.paidAt,
  });

  return balance;
}

/** Every credit note against an invoice, newest first. */
export async function creditsFor(scoped: ScopedDb, invoiceId: string) {
  const notes = await scoped.select('creditNotes', eq(creditNotesTable.invoiceId, invoiceId));
  return notes.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
