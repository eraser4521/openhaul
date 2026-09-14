import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  ageReceivables,
  balanceCents,
  creditBalance,
  effectiveStatus,
  refundableCents,
  settledInCents,
  settledStatus,
} from '@/lib/invoices/compute';
import { applyMigrations } from './helpers/temp-db';

/**
 * Money the carrier is holding for a customer.
 *
 * The credit note already told the customer an overpayment could be "applied
 * against your next invoice, or refunded". Only one of those was true. This
 * covers the other, and the two places it can go wrong are both about money
 * existing twice or not at all: an overpayment both refunded and carried, or
 * a carry-forward removed after the money was already spent.
 */

/* -------------------------------------------------------------------------
 * The arithmetic
 * ---------------------------------------------------------------------- */

describe('the balance', () => {
  it('is the movements, in less out', () => {
    expect(
      creditBalance([
        { direction: 'in', amountCents: 50_000 },
        { direction: 'in', amountCents: 12_500 },
        { direction: 'out', amountCents: 30_000 },
      ]),
    ).toBe(32_500);

    expect(creditBalance([])).toBe(0);
  });

  it('settles the invoice it was carried off, the way a refund does', () => {
    const overpaid = { totalCents: 347_500, paidCents: 347_500, creditedCents: 50_000 };

    expect(balanceCents(overpaid)).toBe(-50_000);
    expect(balanceCents({ ...overpaid, carriedForwardCents: 50_000 })).toBe(0);
    // Same position as a refund, different story: nothing left the bank.
    expect(balanceCents({ ...overpaid, refundedCents: 50_000 })).toBe(0);
  });

  it('cannot be both sent back and kept', () => {
    const overpaid = { totalCents: 347_500, paidCents: 347_500, creditedCents: 50_000 };

    expect(refundableCents({ ...overpaid, carriedForwardCents: 20_000 })).toBe(30_000);
    expect(
      refundableCents({ ...overpaid, carriedForwardCents: 20_000, refundedCents: 30_000 }),
    ).toBe(0);
  });

  it('reduces the invoice it is spent on, the way a payment does', () => {
    const invoice = { totalCents: 294_000, paidCents: 0 };

    expect(balanceCents({ ...invoice, appliedCreditCents: 100_000 })).toBe(194_000);
    expect(balanceCents({ ...invoice, appliedCreditCents: 294_000 })).toBe(0);
  });

  it('counts as something having landed, without being a payment', () => {
    const invoice = { totalCents: 294_000, paidCents: 0, appliedCreditCents: 100_000 };

    expect(settledInCents(invoice)).toBe(100_000);
    expect(settledStatus(invoice)).toBe('partially_paid');
    // The distinction that matters: no money arrived this period.
    expect(invoice.paidCents).toBe(0);
  });

  it('takes a settled invoice off the aging report', () => {
    const now = new Date('2026-10-20T00:00:00Z');
    const overdue = {
      status: 'sent' as const,
      totalCents: 294_000,
      paidCents: 0,
      dueAt: new Date('2026-09-01T00:00:00Z'),
    };

    expect(ageReceivables([overdue], now)['31_60']).toBe(294_000);
    expect(effectiveStatus(overdue, now)).toBe('overdue');

    const settled = { ...overdue, appliedCreditCents: 294_000 };
    expect(ageReceivables([settled], now)['31_60']).toBe(0);
    expect(effectiveStatus(settled, now)).toBe('paid');
  });
});

/* -------------------------------------------------------------------------
 * Against a real database
 * ---------------------------------------------------------------------- */

let workspace: string;
let scoped: Awaited<ReturnType<(typeof import('@/lib/db/scope'))['forOrg']>>;
let dbModule: typeof import('@/lib/db/client');
let schema: typeof import('@/lib/db/schema');
let credit: typeof import('@/lib/invoices/customer-credit');
let refunds: typeof import('@/lib/invoices/refunds');
let lifecycle: typeof import('@/lib/invoices/lifecycle');
let chain: typeof import('@/lib/audit/chain');

let customerId: string;
let otherCustomerId: string;

const DAY = new Date('2026-09-14T12:00:00Z');

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'openhaul-credit-'));
  process.env.DATABASE_URL = `file:${path.join(workspace, 'test.db')}`;
  delete process.env.DATABASE_ENCRYPTION_KEY;
  process.env.BLOB_STORAGE_PATH = path.join(workspace, 'uploads');

  dbModule = await import('@/lib/db/client');
  schema = await import('@/lib/db/schema');
  await dbModule.ready();
  await applyMigrations(dbModule.rawClient);

  const { asOrgId, forOrg } = await import('@/lib/db/scope');
  credit = await import('@/lib/invoices/customer-credit');
  refunds = await import('@/lib/invoices/refunds');
  lifecycle = await import('@/lib/invoices/lifecycle');
  chain = await import('@/lib/audit/chain');

  const [org] = await dbModule.db
    .insert(schema.organizations)
    .values({ legalName: 'Ridgeline Auto Transport LLC' })
    .returning();
  scoped = forOrg(asOrgId(org!.id));

  const [customer] = await scoped.insert('customers', {
    name: 'Cardinal Logistics Brokerage',
    kind: 'broker',
  });
  customerId = customer!.id;

  const [other] = await scoped.insert('customers', { name: 'Hollis Motors', kind: 'dealer' });
  otherCustomerId = other!.id;
});

afterAll(async () => {
  dbModule.rawClient.close();
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  for (const table of ['customerCredits', 'refunds', 'payments', 'invoices', 'loads'] as const) {
    for (const row of await scoped.select(table)) {
      const column = (schema[table] as unknown as { id: Parameters<typeof eq>[0] }).id;
      await scoped.remove(table, eq(column, row.id));
    }
  }
});

/** An issued invoice, optionally overpaid. */
async function invoice(
  number: string,
  {
    totalCents = 294_000,
    paidCents = 0,
    customer = customerId as string | null,
    status = 'sent',
  }: {
    totalCents?: number;
    paidCents?: number;
    customer?: string | null;
    status?: 'draft' | 'sent' | 'void';
  } = {},
) {
  const [row] = await scoped.insert('invoices', {
    number,
    customerId: customer,
    status: paidCents >= totalCents && paidCents > 0 ? 'paid' : status,
    lineHaulCents: totalCents,
    totalCents,
    paidCents,
    issuedAt: DAY,
  });
  return row!;
}

describe('carrying an overpayment forward', () => {
  it('settles the invoice and puts the money in the customer account', async () => {
    const over = await invoice('INV-1', { totalCents: 294_000, paidCents: 344_000 });

    const gate = await credit.checkCarryForward(scoped, over.id);
    expect(gate).toMatchObject({ ok: true, carryableCents: 50_000, customerId });

    const result = await credit.carryForward(scoped, over.id, {
      amountCents: 50_000,
      occurredAt: DAY,
      note: 'Broker asked us to hold it against the next one.',
      creditNoteId: null,
    });

    expect(result).toMatchObject({ ok: true, balanceCents: 50_000 });

    const after = await scoped.selectOne('invoices', eq(schema.invoices.id, over.id));
    expect(after?.carriedForwardCents).toBe(50_000);
    expect(after?.status).toBe('paid');
    // The payment is untouched: money did arrive, and it stays recorded.
    expect(after?.paidCents).toBe(344_000);
    expect(balanceCents({ ...after!, refundedCents: 0 })).toBe(0);
  });

  it('will not carry more than is owed back', async () => {
    const over = await invoice('INV-2', { totalCents: 294_000, paidCents: 344_000 });

    const result = await credit.carryForward(scoped, over.id, {
      amountCents: 60_000,
      occurredAt: DAY,
      note: null,
      creditNoteId: null,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('500.00');
    expect(await credit.balanceFor(scoped, customerId)).toBe(0);
  });

  it('will not let the same overpayment be both refunded and kept', async () => {
    const over = await invoice('INV-3', { totalCents: 294_000, paidCents: 344_000 });

    const sent = await refunds.recordRefund(scoped, over.id, {
      amountCents: 30_000,
      method: 'check',
      reference: '4471',
      issuedAt: DAY,
      notes: null,
      creditNoteId: null,
    });
    expect(sent.ok).toBe(true);

    // $200 of the $500 is left, and only that.
    expect(await credit.checkCarryForward(scoped, over.id)).toMatchObject({
      ok: true,
      carryableCents: 20_000,
    });

    const greedy = await credit.carryForward(scoped, over.id, {
      amountCents: 50_000,
      occurredAt: DAY,
      note: null,
      creditNoteId: null,
    });
    expect(greedy.ok).toBe(false);

    await credit.carryForward(scoped, over.id, {
      amountCents: 20_000,
      occurredAt: DAY,
      note: null,
      creditNoteId: null,
    });

    // And now nothing is left to refund either.
    expect((await refunds.checkRefundable(scoped, over.id)).refundableCents).toBe(0);
    expect(await credit.balanceFor(scoped, customerId)).toBe(20_000);
  });

  it('refuses an invoice with nobody to hold the money for', async () => {
    const orphan = await invoice('INV-4', {
      totalCents: 294_000,
      paidCents: 344_000,
      customer: null,
    });

    const gate = await credit.checkCarryForward(scoped, orphan.id);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('no customer on this invoice');
  });

  it('refuses a draft, where nothing has been collected', async () => {
    const draft = await invoice('INV-5', { status: 'draft' });

    const gate = await credit.checkCarryForward(scoped, draft.id);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('not been issued');
  });
});

describe('spending it', () => {
  /** $500 in the customer's account, carried off an overpaid invoice. */
  async function withBalance(cents = 50_000) {
    const source = await invoice('INV-SRC', {
      totalCents: 294_000,
      paidCents: 294_000 + cents,
    });
    await credit.carryForward(scoped, source.id, {
      amountCents: cents,
      occurredAt: DAY,
      note: null,
      creditNoteId: null,
    });
    return source;
  }

  it('reduces the next invoice and the balance together', async () => {
    await withBalance();
    const next = await invoice('INV-10', { totalCents: 120_000 });

    const gate = await credit.checkApplicable(scoped, next.id);
    expect(gate).toMatchObject({ ok: true, applicableCents: 50_000, balanceCents: 50_000 });

    const result = await credit.applyCredit(scoped, next.id, {
      amountCents: 50_000,
      occurredAt: DAY,
      note: null,
    });
    expect(result).toMatchObject({ ok: true, balanceCents: 0 });

    const after = await scoped.selectOne('invoices', eq(schema.invoices.id, next.id));
    expect(after?.appliedCreditCents).toBe(50_000);
    expect(after?.status).toBe('partially_paid');
    // Nothing arrived at the bank, and the invoice does not claim it did.
    expect(after?.paidCents).toBe(0);
    expect(balanceCents({ ...after!, refundedCents: 0 })).toBe(70_000);
  });

  it('never offers more than the invoice owes', async () => {
    await withBalance(50_000);
    const small = await invoice('INV-11', { totalCents: 20_000 });

    // Applying all $500 to a $200 invoice would overpay it from itself and
    // start the whole cycle again.
    expect(await credit.checkApplicable(scoped, small.id)).toMatchObject({
      ok: true,
      applicableCents: 20_000,
      balanceCents: 50_000,
    });

    const greedy = await credit.applyCredit(scoped, small.id, {
      amountCents: 50_000,
      occurredAt: DAY,
      note: null,
    });
    expect(greedy.ok).toBe(false);
    expect(greedy.error).toContain('200.00');
  });

  it('never offers more than the customer holds', async () => {
    await withBalance(10_000);
    const big = await invoice('INV-12', { totalCents: 294_000 });

    expect(await credit.checkApplicable(scoped, big.id)).toMatchObject({
      ok: true,
      applicableCents: 10_000,
    });

    const invented = await credit.applyCredit(scoped, big.id, {
      amountCents: 40_000,
      occurredAt: DAY,
      note: null,
    });
    expect(invented.ok).toBe(false);
  });

  it('says so when there is nothing to spend', async () => {
    const next = await invoice('INV-13', { totalCents: 120_000 });

    const gate = await credit.checkApplicable(scoped, next.id);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('no credit balance');
  });

  it('keeps one customer out of another customer account', async () => {
    await withBalance(50_000);
    const theirs = await invoice('INV-14', { totalCents: 120_000, customer: otherCustomerId });

    const gate = await credit.checkApplicable(scoped, theirs.id);
    expect(gate.ok).toBe(false);
    expect(gate.balanceCents).toBe(0);
  });

  it('settles the load when the credit clears the invoice', async () => {
    await withBalance(50_000);

    const [load] = await scoped.insert('loads', { number: 'OH-7001', status: 'invoiced' });
    const [billed] = await scoped.insert('invoices', {
      number: 'INV-15',
      customerId,
      loadId: load!.id,
      status: 'sent',
      lineHaulCents: 50_000,
      totalCents: 50_000,
      issuedAt: DAY,
    });

    await credit.applyCredit(scoped, billed!.id, {
      amountCents: 50_000,
      occurredAt: DAY,
      note: null,
    });

    const after = await scoped.selectOne('invoices', eq(schema.invoices.id, billed!.id));
    expect(after?.status).toBe('paid');
    // Money exists for this one — it arrived earlier, on another invoice —
    // so the load really is settled.
    expect((await scoped.selectOne('loads', eq(schema.loads.id, load!.id)))?.status).toBe('paid');
  });

  it('refuses a voided invoice', async () => {
    await withBalance(50_000);
    const dead = await invoice('INV-16', { totalCents: 120_000, status: 'void' });

    const gate = await credit.checkApplicable(scoped, dead.id);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('voided');
  });
});

describe('undoing a movement', () => {
  it('returns applied credit to the balance and re-opens the invoice', async () => {
    const source = await invoice('INV-20', { totalCents: 294_000, paidCents: 344_000 });
    await credit.carryForward(scoped, source.id, {
      amountCents: 50_000,
      occurredAt: DAY,
      note: null,
      creditNoteId: null,
    });

    const next = await invoice('INV-21', { totalCents: 120_000 });
    const applied = await credit.applyCredit(scoped, next.id, {
      amountCents: 50_000,
      occurredAt: DAY,
      note: null,
    });

    const removed = await credit.removeMovement(scoped, applied.movementId!);
    expect(removed.ok).toBe(true);

    expect(await credit.balanceFor(scoped, customerId)).toBe(50_000);
    const after = await scoped.selectOne('invoices', eq(schema.invoices.id, next.id));
    expect(after?.appliedCreditCents).toBe(0);
    expect(after?.status).toBe('sent');
  });

  it('will not remove a carry-forward whose money has been spent', async () => {
    const source = await invoice('INV-22', { totalCents: 294_000, paidCents: 344_000 });
    const carried = await credit.carryForward(scoped, source.id, {
      amountCents: 50_000,
      occurredAt: DAY,
      note: null,
      creditNoteId: null,
    });

    const next = await invoice('INV-23', { totalCents: 120_000 });
    await credit.applyCredit(scoped, next.id, {
      amountCents: 50_000,
      occurredAt: DAY,
      note: null,
    });

    /*
     * Allowing it would leave the account at minus $500 — the customer owing
     * the carrier money that nothing on any invoice accounts for.
     */
    const removed = await credit.removeMovement(scoped, carried.movementId!);
    expect(removed.ok).toBe(false);
    expect(removed.error).toContain('INV-23');
    expect(await credit.balanceFor(scoped, customerId)).toBe(0);
  });

  it('removes a carry-forward that is still sitting there', async () => {
    const source = await invoice('INV-24', { totalCents: 294_000, paidCents: 344_000 });
    const carried = await credit.carryForward(scoped, source.id, {
      amountCents: 50_000,
      occurredAt: DAY,
      note: null,
      creditNoteId: null,
    });

    expect((await credit.removeMovement(scoped, carried.movementId!)).ok).toBe(true);
    expect(await credit.balanceFor(scoped, customerId)).toBe(0);

    // The invoice is overpaid again, which it is — and refundable again.
    const after = await scoped.selectOne('invoices', eq(schema.invoices.id, source.id));
    expect(after?.carriedForwardCents).toBe(0);
    expect((await refunds.checkRefundable(scoped, source.id)).refundableCents).toBe(50_000);
  });
});

describe('voiding', () => {
  it('refuses an invoice whose overpayment is in the customer account', async () => {
    const source = await invoice('INV-30', { totalCents: 294_000, paidCents: 344_000 });
    await credit.carryForward(scoped, source.id, {
      amountCents: 50_000,
      occurredAt: DAY,
      note: null,
      creditNoteId: null,
    });

    const result = await lifecycle.voidInvoice(scoped, source.id, 'Raised in error');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('carried into');
  });

  it('refuses an invoice settled from the customer account', async () => {
    const source = await invoice('INV-31', { totalCents: 294_000, paidCents: 344_000 });
    await credit.carryForward(scoped, source.id, {
      amountCents: 50_000,
      occurredAt: DAY,
      note: null,
      creditNoteId: null,
    });

    const next = await invoice('INV-32', { totalCents: 120_000 });
    await credit.applyCredit(scoped, next.id, {
      amountCents: 50_000,
      occurredAt: DAY,
      note: null,
    });

    const result = await lifecycle.voidInvoice(scoped, next.id, 'Wrong customer');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('applied to this invoice');
  });
});

describe('the record', () => {
  it('logs both movements and leaves the chain sound', async () => {
    const source = await invoice('INV-40', { totalCents: 294_000, paidCents: 344_000 });
    await credit.carryForward(scoped, source.id, {
      amountCents: 50_000,
      occurredAt: DAY,
      note: null,
      creditNoteId: null,
    });

    const next = await invoice('INV-41', { totalCents: 120_000 });
    await credit.applyCredit(scoped, next.id, { amountCents: 50_000, occurredAt: DAY, note: null });

    const entries = await dbModule.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.subject, `customer:${customerId}`));

    const actions = entries.map((entry) => entry.action);
    expect(actions).toContain(chain.AUDIT.creditCarriedForward);
    expect(actions).toContain(chain.AUDIT.creditApplied);

    expect((await chain.verifyChain()).ok).toBe(true);
  });

  it('keeps the invoice each movement belongs to', async () => {
    const source = await invoice('INV-42', { totalCents: 294_000, paidCents: 344_000 });
    await credit.carryForward(scoped, source.id, {
      amountCents: 50_000,
      occurredAt: DAY,
      note: 'Held at their request',
      creditNoteId: null,
    });

    const [movement] = await credit.movementsFor(scoped, customerId);
    expect(movement).toMatchObject({
      direction: 'in',
      amountCents: 50_000,
      invoiceId: source.id,
      note: 'Held at their request',
    });

    expect(await credit.movementsForInvoice(scoped, source.id)).toHaveLength(1);
    expect(await credit.balancesByCustomer(scoped)).toEqual(new Map([[customerId, 50_000]]));
  });
});
