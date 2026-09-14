import 'server-only';
import { eq } from 'drizzle-orm';
import {
  creditNotes as creditNotesTable,
  invoices as invoicesTable,
  refunds as refundsTable,
  type PaymentMethod,
} from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { appendAudit, AUDIT } from '../audit/chain';
import { balanceCents, refundableCents, settledStatus, sumRefunds } from './compute';

/**
 * Sending money back.
 *
 * An invoice goes into overpayment two ways: the customer paid too much, or a
 * credit note was raised after they had already paid. Either leaves the
 * carrier holding money that is not theirs, and until it is sent back the
 * invoice sits at a negative balance that nothing closes.
 *
 * A refund is recorded rather than computed. The row says which invoice, how
 * much, by what method and when the money actually left — because the question
 * asked six months later is "we sent them $500, against what?", and a derived
 * figure cannot answer it.
 *
 * The other way to settle an overpayment is to carry it against the customer's
 * next invoice, which the credit note offers. That is not modelled here: it
 * needs a customer-level credit balance, and half of one would be worse than
 * none. A carrier taking that route reduces the next invoice by hand.
 */

export interface RefundInput {
  amountCents: number;
  method: PaymentMethod;
  reference: string | null;
  issuedAt: Date;
  notes: string | null;
  /** The credit that caused the overpayment, where one did. */
  creditNoteId: string | null;
}

export interface RefundResult {
  ok: boolean;
  error?: string;
  refundId?: string;
  refundedCents?: number;
  balanceCents?: number;
}

/** Refunds against an invoice, newest first. */
export async function refundsFor(scoped: ScopedDb, invoiceId: string) {
  const rows = await scoped.select('refunds', eq(refundsTable.invoiceId, invoiceId));
  return rows.slice().sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime());
}

/**
 * What has already gone back.
 *
 * Exported because the invoice status depends on it, and every place that
 * recomputes that status has to read the same figure — a refund missing from
 * one of them would leave an invoice reading as overpaid after the money had
 * been returned.
 */
export async function sumRefundsFor(scoped: ScopedDb, invoiceId: string): Promise<number> {
  return sumRefunds(await scoped.select('refunds', eq(refundsTable.invoiceId, invoiceId)));
}

export interface RefundableCheck {
  ok: boolean;
  reason?: string;
  /** Owed back and not yet sent. Zero when nothing is. */
  refundableCents: number;
}

/**
 * Whether anything is owed back, and how much.
 *
 * A draft invoice cannot be refunded because nothing was ever collected
 * against it, and saying so is more use than offering a form that will refuse.
 */
export async function checkRefundable(
  scoped: ScopedDb,
  invoiceId: string,
): Promise<RefundableCheck> {
  const invoice = await scoped.selectOne('invoices', eq(invoicesTable.id, invoiceId));
  if (!invoice) return { ok: false, reason: 'No such invoice.', refundableCents: 0 };

  if (invoice.status === 'draft') {
    return {
      ok: false,
      reason: 'This invoice has not been issued, so nothing has been collected against it.',
      refundableCents: 0,
    };
  }

  const refunded = await sumRefundsFor(scoped, invoiceId);
  const refundable = refundableCents({ ...invoice, refundedCents: refunded });

  if (refundable === 0) {
    return {
      ok: false,
      reason:
        refunded > 0
          ? 'Everything owed back on this invoice has already been sent.'
          : 'Nothing is owed back on this invoice.',
      refundableCents: 0,
    };
  }

  return { ok: true, refundableCents: refundable };
}

export async function recordRefund(
  scoped: ScopedDb,
  invoiceId: string,
  input: RefundInput,
): Promise<RefundResult> {
  const invoice = await scoped.selectOne('invoices', eq(invoicesTable.id, invoiceId));
  if (!invoice) return { ok: false, error: 'No such invoice.' };

  if (input.amountCents <= 0) {
    return { ok: false, error: 'Enter the amount sent back.' };
  }

  const gate = await checkRefundable(scoped, invoiceId);
  if (!gate.ok) return { ok: false, error: gate.reason };

  /*
   * Refusing to over-refund is the point of the gate. Sending back more than
   * was overpaid turns one mistake into two, and the second one is harder to
   * notice because the invoice then reads as underpaid and looks like a
   * collection problem rather than an error.
   */
  if (input.amountCents > gate.refundableCents) {
    return {
      ok: false,
      error:
        `Only ${(gate.refundableCents / 100).toFixed(2)} is owed back on this invoice. ` +
        'Refunding more than that would leave it looking unpaid.',
    };
  }

  if (input.creditNoteId) {
    const note = await scoped.selectOne(
      'creditNotes',
      eq(creditNotesTable.id, input.creditNoteId),
    );
    if (!note || note.invoiceId !== invoiceId) {
      return { ok: false, error: 'That credit note is not against this invoice.' };
    }
  }

  const [row] = await scoped.insert('refunds', {
    invoiceId,
    creditNoteId: input.creditNoteId,
    amountCents: input.amountCents,
    method: input.method,
    reference: input.reference,
    issuedAt: input.issuedAt,
    notes: input.notes,
  });

  if (!row) return { ok: false, error: 'The refund could not be recorded.' };

  const refunded = await sumRefundsFor(scoped, invoiceId);
  const position = { ...invoice, refundedCents: refunded };

  // A voided invoice keeps its status: money going back does not un-void it.
  const status = invoice.status === 'void' ? invoice.status : settledStatus(position);

  await scoped.update('invoices', eq(invoicesTable.id, invoiceId), { status });

  await appendAudit({
    orgId: scoped.orgId,
    action: AUDIT.refundIssued,
    subject: `invoice:${invoiceId}`,
    detail: {
      refundId: row.id,
      amountCents: input.amountCents,
      method: input.method,
      reference: input.reference,
      creditNoteId: input.creditNoteId,
      issuedAt: input.issuedAt.toISOString(),
    },
  });

  return {
    ok: true,
    refundId: row.id,
    refundedCents: refunded,
    balanceCents: balanceCents(position),
  };
}

/**
 * Removes a refund that was recorded in error.
 *
 * Deleted rather than reversed, matching how a mistaken payment is handled: a
 * refund is the carrier's own ledger entry, not a document anybody outside is
 * holding, so there is no second copy to keep consistent. The audit chain
 * keeps the record that it existed and was removed.
 */
export async function removeRefund(
  scoped: ScopedDb,
  invoiceId: string,
  refundId: string,
): Promise<{ ok: boolean; error?: string }> {
  const refund = await scoped.selectOne('refunds', eq(refundsTable.id, refundId));
  if (!refund || refund.invoiceId !== invoiceId) {
    return { ok: false, error: 'No such refund on this invoice.' };
  }

  await scoped.remove('refunds', eq(refundsTable.id, refundId));

  const invoice = await scoped.selectOne('invoices', eq(invoicesTable.id, invoiceId));
  if (invoice) {
    const refunded = await sumRefundsFor(scoped, invoiceId);
    const status =
      invoice.status === 'void'
        ? invoice.status
        : settledStatus({ ...invoice, refundedCents: refunded });

    await scoped.update('invoices', eq(invoicesTable.id, invoiceId), { status });
  }

  await appendAudit({
    orgId: scoped.orgId,
    action: AUDIT.refundRemoved,
    subject: `invoice:${invoiceId}`,
    detail: { refundId, amountCents: refund.amountCents },
  });

  return { ok: true };
}
