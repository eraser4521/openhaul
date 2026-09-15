import 'server-only';
import { eq } from 'drizzle-orm';
import {
  invoices as invoicesTable,
  payments as paymentsTable,
  promisesToPay as promisesTable,
  refunds as refundsTable,
  type PromiseChannel,
} from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { appendAudit, AUDIT } from '../audit/chain';
import { balanceCents, sumRefunds } from './compute';
import { ruleFor } from './dunning-run';
import {
  currentPromise,
  outcomeOf,
  promiseProblems,
  supersederOf,
  type PromiseOutcome,
  type PromiseRecord,
} from './promise';

/**
 * Recording what a customer said, and working out whether it happened.
 *
 * The state is never written down. It is computed every time from the date,
 * the amount and the payments that arrived after the promise was made —
 * because a stored state goes stale the moment a payment is corrected, and a
 * stale one has the carrier telling somebody they broke their word when a
 * mistyped payment date was the only thing that broke.
 */

export interface PromiseInput {
  amountCents: number;
  promisedFor: Date;
  contactName: string | null;
  channel: PromiseChannel;
  notes: string | null;
  madeAt?: Date;
}

export interface PromiseResult {
  ok: boolean;
  error?: string;
  problems?: string[];
  promiseId?: string;
}

export interface PromiseView extends PromiseRecord {
  outcome: PromiseOutcome;
  /** Whether this is the one the ladder is looking at. */
  current: boolean;
}

/* -------------------------------------------------------------------------
 * Reading
 * ---------------------------------------------------------------------- */

/** Every promise on an invoice, newest first, each with how it turned out. */
export async function promisesFor(
  scoped: ScopedDb,
  invoiceId: string,
  now = new Date(),
): Promise<PromiseView[]> {
  const [rows, payments, rule] = await Promise.all([
    scoped.select('promisesToPay', eq(promisesTable.invoiceId, invoiceId)),
    scoped.select('payments', eq(paymentsTable.invoiceId, invoiceId)),
    ruleFor(scoped),
  ]);

  const current = currentPromise(rows);

  return rows
    .slice()
    .sort((a, b) => b.madeAt.getTime() - a.madeAt.getTime())
    .map((promise) => ({
      ...promise,
      current: promise.id === current?.id,
      outcome: outcomeOf(promise, payments, {
        graceDays: rule.promiseGraceDays,
        supersededBy: supersederOf(promise, rows),
        now,
      }),
    }));
}

/* -------------------------------------------------------------------------
 * Writing
 * ---------------------------------------------------------------------- */

/**
 * Records what a customer said they would do.
 *
 * Refused rather than clamped when it does not make sense. A promise for more
 * than the invoice owes is somebody typing the wrong figure or promising
 * against the wrong invoice, and either way recording it would have the
 * ladder waiting on a commitment nobody made.
 */
export async function recordPromise(
  scoped: ScopedDb,
  invoiceId: string,
  input: PromiseInput,
): Promise<PromiseResult> {
  const invoice = await scoped.selectOne('invoices', eq(invoicesTable.id, invoiceId));
  if (!invoice) return { ok: false, error: 'No such invoice.' };

  if (invoice.status === 'draft' || invoice.status === 'void') {
    return { ok: false, error: 'Nothing is owed on this invoice, so there is nothing to promise.' };
  }

  const madeAt = input.madeAt ?? new Date();
  const refunded = sumRefunds(
    await scoped.select('refunds', eq(refundsTable.invoiceId, invoiceId)),
  );
  const balance = balanceCents({ ...invoice, refundedCents: refunded });

  const problems = promiseProblems(
    { amountCents: input.amountCents, promisedFor: input.promisedFor, madeAt },
    balance,
  );
  if (problems.length > 0) {
    return { ok: false, error: 'That promise does not make sense.', problems };
  }

  const [row] = await scoped.insert('promisesToPay', {
    invoiceId,
    amountCents: input.amountCents,
    promisedFor: input.promisedFor,
    madeAt,
    contactName: input.contactName,
    channel: input.channel,
    notes: input.notes,
  });

  if (!row) return { ok: false, error: 'That could not be recorded.' };

  await appendAudit({
    orgId: scoped.orgId,
    action: AUDIT.promiseRecorded,
    subject: `invoice:${invoiceId}`,
    detail: {
      promiseId: row.id,
      amountCents: input.amountCents,
      promisedFor: input.promisedFor.toISOString(),
      madeAt: madeAt.toISOString(),
      contactName: input.contactName,
      channel: input.channel,
    },
  });

  return { ok: true, promiseId: row.id };
}

/**
 * Withdraws a promise.
 *
 * Kept on the record rather than deleted, and marked withdrawn rather than
 * broken. Somebody ringing to say the payment cannot be made after all has
 * not broken their word in the way that silence does, and the difference is
 * exactly what the next letter should not get wrong.
 */
export async function cancelPromise(
  scoped: ScopedDb,
  promiseId: string,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  const promise = await scoped.selectOne('promisesToPay', eq(promisesTable.id, promiseId));
  if (!promise) return { ok: false, error: 'No such promise.' };
  if (promise.cancelledAt) return { ok: false, error: 'That promise was already withdrawn.' };

  if (!reason.trim()) {
    return { ok: false, error: 'Say why it is being withdrawn — it stays on the record.' };
  }

  await scoped.update('promisesToPay', eq(promisesTable.id, promiseId), {
    cancelledAt: new Date(),
    cancelReason: reason.trim(),
  });

  await appendAudit({
    orgId: scoped.orgId,
    action: AUDIT.promiseCancelled,
    subject: `invoice:${promise.invoiceId}`,
    detail: { promiseId, reason: reason.trim() },
  });

  return { ok: true };
}
