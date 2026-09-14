import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  balanceCents,
  effectiveStatus,
  refundableCents,
  settledStatus,
  sumRefunds,
} from '@/lib/invoices/compute';
import { applyMigrations } from './helpers/temp-db';

/**
 * Money going back out.
 *
 * The arithmetic first, because every screen depends on it: a refund adds back
 * to the balance rather than subtracting from what was paid. Subtracting would
 * say the payment never arrived, which is a different and untrue claim, and
 * would quietly move revenue.
 *
 * Then the gate, which is the part that matters operationally. Over-refunding
 * turns one mistake into two and hides the second, because the invoice then
 * reads as underpaid and looks like a collection problem.
 */

describe('the arithmetic', () => {
  it('returns an overpaid invoice to zero when the money goes back', () => {
    // $3,475 invoiced, paid in full, then a $500 credit: $500 is owed back.
    const invoiced = { totalCents: 347_500, paidCents: 347_500, creditedCents: 50_000 };
    expect(balanceCents(invoiced)).toBe(-50_000);
    expect(balanceCents({ ...invoiced, refundedCents: 50_000 })).toBe(0);
  });

  it('adds back rather than reducing what was paid', () => {
    /*
     * The customer did pay that money. A refund is a second movement, not a
     * retraction of the first — modelling it as a negative payment would drop
     * recorded revenue and move the aging report.
     */
    const paid = 400_000;
    const refunded = 52_500;

    expect(balanceCents({ totalCents: 347_500, paidCents: paid, refundedCents: refunded })).toBe(0);
    expect(balanceCents({ totalCents: 347_500, paidCents: paid - refunded })).toBe(0);
    // Same balance, different story. `paidCents` must stay what arrived.
    expect(paid).toBe(400_000);
  });

  it('reports what is still owed back, never a negative', () => {
    const overpaid = { totalCents: 347_500, paidCents: 347_500, creditedCents: 50_000 };
    expect(refundableCents(overpaid)).toBe(50_000);
    expect(refundableCents({ ...overpaid, refundedCents: 20_000 })).toBe(30_000);
    expect(refundableCents({ ...overpaid, refundedCents: 50_000 })).toBe(0);
    // Over-refunded already: still zero, not a negative to offer back.
    expect(refundableCents({ ...overpaid, refundedCents: 90_000 })).toBe(0);
    expect(refundableCents({ totalCents: 347_500, paidCents: 100_000 })).toBe(0);

    // A carry-forward draws on the same figure, which is what stops $500
    // being both sent back and kept.
    expect(refundableCents({ ...overpaid, carriedForwardCents: 50_000 })).toBe(0);
    expect(refundableCents({ ...overpaid, refundedCents: 20_000, carriedForwardCents: 30_000 })).toBe(0);
  });

  it('sums refunds the way payments are summed', () => {
    expect(sumRefunds([{ amountCents: 25_000 }, { amountCents: 25_000 }])).toBe(50_000);
    expect(sumRefunds([])).toBe(0);
  });

  it('keeps an overpaid invoice settled once it is refunded', () => {
    const overpaid = { totalCents: 347_500, paidCents: 347_500, creditedCents: 50_000 };
    expect(settledStatus(overpaid)).toBe('paid');
    expect(settledStatus({ ...overpaid, refundedCents: 50_000 })).toBe('paid');
  });

  it('does not call an invoice paid when a refund leaves it short', () => {
    // Refunding more than was over means real money is now outstanding.
    expect(
      settledStatus({ totalCents: 347_500, paidCents: 347_500, refundedCents: 50_000 }),
    ).toBe('partially_paid');
  });

  it('shows the refund in the derived status', () => {
    const invoice = {
      status: 'sent' as const,
      totalCents: 347_500,
      paidCents: 347_500,
      creditedCents: 50_000,
      dueAt: new Date('2020-01-01T00:00:00Z'),
    };
    const now = new Date('2026-09-14T12:00:00Z');

    expect(effectiveStatus(invoice, now)).toBe('paid');
    expect(effectiveStatus({ ...invoice, refundedCents: 50_000 }, now)).toBe('paid');
    // Refunded past the overpayment: overdue again, because it is.
    expect(effectiveStatus({ ...invoice, refundedCents: 120_000 }, now)).toBe('overdue');
  });
});

/* -------------------------------------------------------------------------
 * Against a real database
 * ---------------------------------------------------------------------- */

let workspace: string;
let scoped: Awaited<ReturnType<typeof import('@/lib/db/scope')['forOrg']>>;
let dbModule: typeof import('@/lib/db/client');
let schema: typeof import('@/lib/db/schema');
let refunds: typeof import('@/lib/invoices/refunds');
let chain: typeof import('@/lib/audit/chain');

let invoiceId: string;

const ISSUED = new Date('2026-09-01T12:00:00Z');

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'openhaul-refund-'));
  process.env.DATABASE_URL = `file:${path.join(workspace, 'test.db')}`;
  delete process.env.DATABASE_ENCRYPTION_KEY;
  process.env.BLOB_STORAGE_PATH = path.join(workspace, 'uploads');

  dbModule = await import('@/lib/db/client');
  schema = await import('@/lib/db/schema');
  await dbModule.ready();
  await applyMigrations(dbModule.rawClient);

  const { asOrgId, forOrg } = await import('@/lib/db/scope');
  refunds = await import('@/lib/invoices/refunds');
  chain = await import('@/lib/audit/chain');

  const [org] = await dbModule.db
    .insert(schema.organizations)
    .values({ legalName: 'Ridgeline Auto Transport LLC' })
    .returning();
  scoped = forOrg(asOrgId(org!.id));
});

afterAll(async () => {
  dbModule.rawClient.close();
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
});

/** An invoice paid in full, then credited $500 — so $500 is owed back. */
beforeEach(async () => {
  for (const table of ['refunds', 'creditNotes', 'invoices'] as const) {
    for (const row of await scoped.select(table)) {
      const column = (schema[table] as unknown as { id: Parameters<typeof eq>[0] }).id;
      await scoped.remove(table, eq(column, row.id));
    }
  }

  const [invoice] = await scoped.insert('invoices', {
    number: `INV-OH-${Math.floor(Math.random() * 100_000)}`,
    status: 'paid',
    lineHaulCents: 347_500,
    totalCents: 347_500,
    paidCents: 347_500,
    creditedCents: 50_000,
    issuedAt: ISSUED,
  });
  invoiceId = invoice!.id;
});

function refund(overrides: Partial<import('@/lib/invoices/refunds').RefundInput> = {}) {
  return {
    amountCents: 50_000,
    method: 'check' as const,
    reference: '10442',
    issuedAt: new Date('2026-09-14T12:00:00Z'),
    notes: null,
    creditNoteId: null,
    ...overrides,
  };
}

describe('what is refundable', () => {
  it('offers exactly the overpayment', async () => {
    const gate = await refunds.checkRefundable(scoped, invoiceId);
    expect(gate.ok).toBe(true);
    expect(gate.refundableCents).toBe(50_000);
  });

  it('says nothing is owed back when nothing is', async () => {
    await scoped.update('invoices', eq(schema.invoices.id, invoiceId), { creditedCents: 0 });

    const gate = await refunds.checkRefundable(scoped, invoiceId);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('Nothing is owed back');
  });

  it('refuses a draft, where nothing was ever collected', async () => {
    await scoped.update('invoices', eq(schema.invoices.id, invoiceId), {
      status: 'draft',
      paidCents: 0,
    });

    const gate = await refunds.checkRefundable(scoped, invoiceId);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('not been issued');
  });

  it('shrinks as refunds are sent, and closes at zero', async () => {
    await refunds.recordRefund(scoped, invoiceId, refund({ amountCents: 20_000 }));
    expect((await refunds.checkRefundable(scoped, invoiceId)).refundableCents).toBe(30_000);

    await refunds.recordRefund(scoped, invoiceId, refund({ amountCents: 30_000 }));

    const gate = await refunds.checkRefundable(scoped, invoiceId);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('already been sent');
  });
});

describe('recording one', () => {
  it('returns the invoice to a settled balance', async () => {
    const result = await refunds.recordRefund(scoped, invoiceId, refund());

    expect(result.ok).toBe(true);
    expect(result.balanceCents).toBe(0);

    const invoice = await scoped.selectOne('invoices', eq(schema.invoices.id, invoiceId));
    expect(invoice?.status).toBe('paid');
    // The payment stays what arrived. Only the position moved.
    expect(invoice?.paidCents).toBe(347_500);
  });

  it('refuses more than is owed back', async () => {
    const result = await refunds.recordRefund(scoped, invoiceId, refund({ amountCents: 90_000 }));

    expect(result.ok).toBe(false);
    expect(result.error).toContain('500.00');
    expect(await scoped.select('refunds')).toHaveLength(0);
  });

  it('refuses nothing and refuses a negative', async () => {
    expect((await refunds.recordRefund(scoped, invoiceId, refund({ amountCents: 0 }))).ok).toBe(false);
    expect((await refunds.recordRefund(scoped, invoiceId, refund({ amountCents: -5_000 }))).ok).toBe(
      false,
    );
  });

  it('will not cite a credit note belonging to another invoice', async () => {
    const [other] = await scoped.insert('invoices', {
      number: 'INV-OH-OTHER',
      status: 'sent',
      totalCents: 100_000,
    });
    const [note] = await scoped.insert('creditNotes', {
      number: 'CN-OH-9',
      invoiceId: other!.id,
      reason: 'billing_error',
      detail: 'Wrong invoice.',
      amountCents: 10_000,
    });

    const result = await refunds.recordRefund(
      scoped,
      invoiceId,
      refund({ creditNoteId: note!.id }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not against this invoice');
  });

  it('records what went, how and when', async () => {
    await refunds.recordRefund(
      scoped,
      invoiceId,
      refund({ method: 'ach', reference: 'TRACE-9912', notes: 'Agreed with Renata.' }),
    );

    const [row] = await refunds.refundsFor(scoped, invoiceId);
    expect(row?.method).toBe('ach');
    expect(row?.reference).toBe('TRACE-9912');
    expect(row?.notes).toBe('Agreed with Renata.');
    expect(row?.issuedAt.toISOString()).toBe('2026-09-14T12:00:00.000Z');
  });

  it('puts it on the audit chain without breaking it', async () => {
    const before = (await chain.chainHead()).seq;
    await refunds.recordRefund(scoped, invoiceId, refund());

    expect((await chain.chainHead()).seq).toBeGreaterThan(before);

    // The chain is append-only and spans the whole run, so earlier tests have
    // left their own refund entries in it.
    const entries = await dbModule.db.select().from(schema.auditLog);
    const entry = entries.find(
      (row) => row.action === 'refund.issued' && row.subject === `invoice:${invoiceId}`,
    );
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry?.detail)).toContain('"amountCents":50000');

    expect((await chain.verifyChain()).ok).toBe(true);
  });

  it('does not un-void a voided invoice', async () => {
    await scoped.update('invoices', eq(schema.invoices.id, invoiceId), { status: 'void' });

    const result = await refunds.recordRefund(scoped, invoiceId, refund());
    expect(result.ok).toBe(true);

    const invoice = await scoped.selectOne('invoices', eq(schema.invoices.id, invoiceId));
    expect(invoice?.status).toBe('void');
  });
});

describe('removing one recorded in error', () => {
  it('puts the invoice back where it was', async () => {
    const created = await refunds.recordRefund(scoped, invoiceId, refund());
    expect((await refunds.checkRefundable(scoped, invoiceId)).refundableCents).toBe(0);

    await refunds.removeRefund(scoped, invoiceId, created.refundId!);

    expect((await refunds.checkRefundable(scoped, invoiceId)).refundableCents).toBe(50_000);
    expect(await scoped.select('refunds')).toHaveLength(0);
  });

  it('will not remove a refund by quoting the wrong invoice', async () => {
    const created = await refunds.recordRefund(scoped, invoiceId, refund());
    const [other] = await scoped.insert('invoices', {
      number: 'INV-OH-ELSE',
      status: 'sent',
      totalCents: 100_000,
    });

    const result = await refunds.removeRefund(scoped, other!.id, created.refundId!);

    expect(result.ok).toBe(false);
    expect(await scoped.select('refunds')).toHaveLength(1);
  });
});
