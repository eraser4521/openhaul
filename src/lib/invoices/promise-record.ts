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
  type PromiseState,
} from './promise';
import {
  WORK_BUCKETS,
  bucketOf,
  compareWithin,
  tally,
  totalsFor,
  type BucketTotals,
  type PromiseTally,
  type WorkBucket,
} from './promise-worklist';

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

/* -------------------------------------------------------------------------
 * The worklist
 * ---------------------------------------------------------------------- */

export interface WorklistRow {
  promise: PromiseRecord;
  outcome: PromiseOutcome;
  bucket: WorkBucket;
  invoiceId: string;
  invoiceNumber: string;
  /** What the invoice still owes today, which may be less than was promised. */
  invoiceBalanceCents: number;
  customerId: string | null;
  customerName: string;
  /**
   * How this customer's promises have gone, this one included.
   *
   * Counting the row itself is deliberate. Excluding it is arguably purer —
   * a promise is not context for itself — but it means one customer shows a
   * different record on every row of the same page, which reads as a bug and
   * is the opposite of what somebody about to telephone them needs.
   */
  record: PromiseTally;
}

export interface Worklist {
  rows: WorklistRow[];
  byBucket: Record<WorkBucket, WorklistRow[]>;
  totals: Record<WorkBucket, BucketTotals>;
}

/**
 * Every promise worth looking at, across every invoice.
 *
 * Assembled in one pass rather than per invoice, because the screen this
 * feeds is read down the page in one go and a query per promise would be a
 * query per row. The outcomes come from the same pure function the invoice
 * screen and the dunning sweep use, so no two of the three can disagree about
 * whether somebody kept their word.
 */
export async function worklist(scoped: ScopedDb, now = new Date()): Promise<Worklist> {
  const [promiseRows, invoices, customers, payments, refunds, rule] = await Promise.all([
    scoped.select('promisesToPay'),
    scoped.select('invoices'),
    scoped.select('customers'),
    scoped.select('payments'),
    scoped.select('refunds'),
    ruleFor(scoped),
  ]);

  const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]));
  const customerById = new Map(customers.map((customer) => [customer.id, customer]));

  const paymentsByInvoice = new Map<string, typeof payments>();
  for (const payment of payments) {
    const list = paymentsByInvoice.get(payment.invoiceId) ?? [];
    list.push(payment);
    paymentsByInvoice.set(payment.invoiceId, list);
  }

  const refundedBy = new Map<string, number>();
  for (const refund of refunds) {
    refundedBy.set(refund.invoiceId, (refundedBy.get(refund.invoiceId) ?? 0) + refund.amountCents);
  }

  const byInvoice = new Map<string, PromiseRecord[]>();
  for (const promise of promiseRows) {
    const list = byInvoice.get(promise.invoiceId) ?? [];
    list.push(promise);
    byInvoice.set(promise.invoiceId, list);
  }

  /*
   * Every promise gets an outcome first, including the ones that will not
   * reach the list. A customer's record is counted from all of them — leaving
   * out the superseded and withdrawn ones is the point, and that can only be
   * done once they have been worked out.
   */
  const resolved = promiseRows.map((promise) => ({
    promise,
    outcome: outcomeOf(promise, paymentsByInvoice.get(promise.invoiceId) ?? [], {
      graceDays: rule.promiseGraceDays,
      supersededBy: supersederOf(promise, byInvoice.get(promise.invoiceId) ?? []),
      now,
    }),
  }));

  const historyByCustomer = new Map<
    string,
    Array<{ id: string; state: PromiseState; promisedFor: Date }>
  >();
  for (const { promise, outcome } of resolved) {
    const customerId = invoiceById.get(promise.invoiceId)?.customerId;
    if (!customerId) continue;

    const list = historyByCustomer.get(customerId) ?? [];
    list.push({ id: promise.id, state: outcome.state, promisedFor: promise.promisedFor });
    historyByCustomer.set(customerId, list);
  }

  const rows: WorklistRow[] = [];

  for (const { promise, outcome } of resolved) {
    const bucket = bucketOf(promise, outcome, now);
    if (!bucket) continue;

    const invoice = invoiceById.get(promise.invoiceId);
    if (!invoice) continue;

    const customerId = invoice.customerId;
    const history = historyByCustomer.get(customerId ?? '') ?? [];

    rows.push({
      promise,
      outcome,
      bucket,
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      invoiceBalanceCents: balanceCents({
        ...invoice,
        refundedCents: refundedBy.get(invoice.id) ?? 0,
      }),
      customerId,
      customerName: customerId
        ? (customerById.get(customerId)?.name ?? 'Unknown customer')
        : 'No customer',
      record: tally(history),
    });
  }

  const byBucket = {
    not_kept: [] as WorklistRow[],
    in_the_post: [] as WorklistRow[],
    expected: [] as WorklistRow[],
    kept: [] as WorklistRow[],
  };

  for (const row of rows) byBucket[row.bucket].push(row);

  for (const bucket of WORK_BUCKETS) {
    byBucket[bucket].sort((a, b) => compareWithin(bucket, a.promise, b.promise));
  }

  const totals = {
    not_kept: totalsFor(byBucket.not_kept.map(toTotal)),
    in_the_post: totalsFor(byBucket.in_the_post.map(toTotal)),
    expected: totalsFor(byBucket.expected.map(toTotal)),
    kept: totalsFor(byBucket.kept.map(toTotal)),
  };

  return { rows, byBucket, totals };
}

function toTotal(row: WorklistRow) {
  return { amountCents: row.promise.amountCents, outcome: row.outcome };
}
