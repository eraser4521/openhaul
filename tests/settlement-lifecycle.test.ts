import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { applyMigrations } from './helpers/temp-db';
import { pdfText } from './helpers/pdf-text';

/**
 * Settlements against a real database.
 *
 * The arithmetic is unit tested. What needs a database is what spans rows: that
 * a load is picked up by exactly one settlement, that finalising freezes both
 * the lines and the statement, and that a reimbursed expense is not paid back
 * twice on the next period.
 */

let workspace: string;
let scoped: Awaited<ReturnType<typeof import('@/lib/db/scope')['forOrg']>>;
let settlements: typeof import('@/lib/settlements/lifecycle');
let statementModule: typeof import('@/lib/settlements/statement');
let dbModule: typeof import('@/lib/db/client');
let schema: typeof import('@/lib/db/schema');

let leasedDriverId: string;
let companyDriverId: string;

const PERIOD_START = new Date('2026-09-01T12:00:00Z');
const PERIOD_END = new Date('2026-09-14T12:00:00Z');

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'openhaul-settlement-'));

  process.env.DATABASE_URL = `file:${path.join(workspace, 'test.db')}`;
  delete process.env.DATABASE_ENCRYPTION_KEY;
  delete process.env.DATABASE_AUTH_TOKEN;
  process.env.BLOB_STORAGE_PATH = path.join(workspace, 'uploads');

  dbModule = await import('@/lib/db/client');
  schema = await import('@/lib/db/schema');
  await dbModule.ready();
  await applyMigrations(dbModule.rawClient);

  const { asOrgId, forOrg } = await import('@/lib/db/scope');
  settlements = await import('@/lib/settlements/lifecycle');
  statementModule = await import('@/lib/settlements/statement');

  const [org] = await dbModule.db
    .insert(schema.organizations)
    .values({
      legalName: 'Ridgeline Auto Transport LLC',
      addressLine1: '4400 Meacham Blvd',
      city: 'Fort Worth',
      state: 'TX',
      postalCode: '76106',
    })
    .returning();

  scoped = forOrg(asOrgId(org!.id));

  const [leased] = await scoped.insert('drivers', {
    displayName: 'Marcus Webb',
    employmentType: 'owner_operator',
    payRateBps: 6_800,
    activeAt: new Date(),
  });
  leasedDriverId = leased!.id;

  const [company] = await scoped.insert('drivers', {
    displayName: 'Dana Whitfield',
    employmentType: 'company',
    payPerMileCents: 55,
    activeAt: new Date(),
  });
  companyDriverId = company!.id;
});

afterAll(async () => {
  dbModule.rawClient.close();
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
});

async function deliveredLoad(
  number: string,
  driverId: string,
  deliveredAt: Date,
  values: { rateCents?: number; distanceMiles?: number } = {},
) {
  const [load] = await scoped.insert('loads', {
    number,
    status: 'delivered',
    driverId,
    rateCents: values.rateCents ?? 294_000,
    distanceMiles: values.distanceMiles ?? 1_074,
    deliveredAt,
    retainUntil: new Date(),
  });
  return load!.id;
}

describe('building a settlement', () => {
  let settlementId: string;

  it('refuses a driver with no pay rate, rather than paying them nothing', async () => {
    const [unpaid] = await scoped.insert('drivers', {
      displayName: 'No Rate',
      employmentType: 'company',
      activeAt: new Date(),
    });

    const result = await settlements.buildSettlement(
      scoped,
      unpaid!.id,
      PERIOD_START,
      PERIOD_END,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('no pay rate');
  });

  it('refuses a period that ends before it starts', async () => {
    const result = await settlements.buildSettlement(
      scoped,
      leasedDriverId,
      PERIOD_END,
      PERIOD_START,
    );
    expect(result.ok).toBe(false);
  });

  it('pays the loads delivered in the period at the driver’s share', async () => {
    await deliveredLoad('OH-7001', leasedDriverId, new Date('2026-09-03T00:00:00Z'));
    await deliveredLoad('OH-7002', leasedDriverId, new Date('2026-09-11T00:00:00Z'), {
      rateCents: 180_000,
    });

    const result = await settlements.buildSettlement(
      scoped,
      leasedDriverId,
      PERIOD_START,
      PERIOD_END,
    );

    expect(result.ok).toBe(true);
    expect(result.loadsIncluded).toBe(2);
    settlementId = result.settlementId!;

    const lines = await scoped.select(
      'settlementLines',
      eq(schema.settlementLines.settlementId, settlementId),
    );

    // 68% of 294,000 and of 180,000.
    expect(lines.map((line) => line.amountCents).sort((a, b) => a - b)).toEqual([122_400, 199_920]);
    // 376.12(d): the revenue the percentage was taken from, on the line.
    expect(lines.find((l) => l.amountCents === 199_920)?.basisNote).toBe('68.00% of $2,940.00');
  });

  it('leaves out a load delivered outside the period', async () => {
    /*
     * Dated by delivery, not dispatch: a load picked up in one period and
     * delivered in the next is earned in the second.
     */
    await deliveredLoad('OH-7003', leasedDriverId, new Date('2026-09-20T00:00:00Z'));

    const result = await settlements.buildSettlement(
      scoped,
      leasedDriverId,
      new Date('2026-09-15T12:00:00Z'),
      new Date('2026-09-28T12:00:00Z'),
    );

    expect(result.loadsIncluded).toBe(1);
  });

  it('never pays the same load on two settlements', async () => {
    // The error a driver notices immediately and a carrier never does.
    const again = await settlements.buildSettlement(
      scoped,
      leasedDriverId,
      PERIOD_START,
      PERIOD_END,
    );

    expect(again.ok).toBe(true);
    expect(again.loadsIncluded).toBe(0);
  });

  it('leaves a cancelled load out entirely', async () => {
    const id = await deliveredLoad('OH-7004', companyDriverId, new Date('2026-09-05T00:00:00Z'));
    await scoped.update('loads', eq(schema.loads.id, id), { status: 'cancelled' });

    const result = await settlements.buildSettlement(
      scoped,
      companyDriverId,
      PERIOD_START,
      PERIOD_END,
    );

    expect(result.loadsIncluded).toBe(0);
  });

  it('pays a per-mile driver by the mile', async () => {
    await deliveredLoad('OH-7005', companyDriverId, new Date('2026-09-06T00:00:00Z'), {
      distanceMiles: 1_074,
    });

    const result = await settlements.buildSettlement(
      scoped,
      companyDriverId,
      PERIOD_START,
      PERIOD_END,
    );

    const lines = await scoped.select(
      'settlementLines',
      eq(schema.settlementLines.settlementId, result.settlementId!),
    );

    expect(lines[0]?.amountCents).toBe(59_070);
    expect(lines[0]?.basisNote).toBe('1,074 mi at $0.55 per mile');
  });
});

describe('reimbursements', () => {
  it('picks up a reimbursable expense and marks it paid once finalised', async () => {
    const loadId = await deliveredLoad('OH-7100', leasedDriverId, new Date('2026-10-02T00:00:00Z'));

    const [expense] = await scoped.insert('expenses', {
      loadId,
      driverId: leasedDriverId,
      category: 'tolls',
      amountCents: 4_150,
      incurredAt: new Date('2026-10-02T00:00:00Z'),
      vendor: 'Oklahoma Turnpike',
      reimbursable: true,
      receiptStorageKey: 'fixture/receipt',
    });

    const built = await settlements.buildSettlement(
      scoped,
      leasedDriverId,
      new Date('2026-10-01T12:00:00Z'),
      new Date('2026-10-14T12:00:00Z'),
    );

    const lines = await scoped.select(
      'settlementLines',
      eq(schema.settlementLines.settlementId, built.settlementId!),
    );

    const reimbursement = lines.find((line) => line.kind === 'reimbursement');
    expect(reimbursement?.amountCents).toBe(4_150);
    expect(reimbursement?.basisNote).toBe('Receipt on file');

    await settlements.finalizeSettlement(scoped, built.settlementId!);

    const after = await scoped.selectOne('expenses', eq(schema.expenses.id, expense!.id));
    expect(after?.reimbursedAt).not.toBeNull();

    // And the next period does not pay it back a second time.
    const next = await settlements.buildSettlement(
      scoped,
      leasedDriverId,
      new Date('2026-10-01T12:00:00Z'),
      new Date('2026-10-14T12:00:00Z'),
    );
    const nextLines = await scoped.select(
      'settlementLines',
      eq(schema.settlementLines.settlementId, next.settlementId!),
    );
    expect(nextLines.filter((line) => line.kind === 'reimbursement')).toHaveLength(0);
  });

  it('ignores an expense the driver bears themselves', async () => {
    /*
     * A percentage-lease driver's own fuel is their cost. Sweeping it in would
     * hand back money nobody agreed to.
     */
    await scoped.insert('expenses', {
      driverId: companyDriverId,
      category: 'fuel',
      amountCents: 22_000,
      incurredAt: new Date('2026-11-03T00:00:00Z'),
      reimbursable: false,
    });

    const built = await settlements.buildSettlement(
      scoped,
      companyDriverId,
      new Date('2026-11-01T12:00:00Z'),
      new Date('2026-11-14T12:00:00Z'),
    );

    const lines = await scoped.select(
      'settlementLines',
      eq(schema.settlementLines.settlementId, built.settlementId!),
    );
    expect(lines.filter((line) => line.kind === 'reimbursement')).toHaveLength(0);
  });
});

describe('editing and finalising', () => {
  let settlementId: string;

  beforeAll(async () => {
    await deliveredLoad('OH-7200', leasedDriverId, new Date('2026-12-03T00:00:00Z'));
    const built = await settlements.buildSettlement(
      scoped,
      leasedDriverId,
      new Date('2026-12-01T12:00:00Z'),
      new Date('2026-12-14T12:00:00Z'),
    );
    settlementId = built.settlementId!;
  });

  it('adds a chargeback and rewrites the totals from the lines', async () => {
    const added = await settlements.addLine(scoped, settlementId, {
      kind: 'deduction',
      description: 'Occupational accident insurance',
      amountCents: 12_500,
      basisNote: 'Weekly premium per lease schedule B',
    });
    expect(added.ok).toBe(true);

    await settlements.addLine(scoped, settlementId, {
      kind: 'escrow_deposit',
      description: 'Escrow contribution',
      amountCents: 10_000,
    });

    const settlement = await scoped.selectOne(
      'settlements',
      eq(schema.settlements.id, settlementId),
    );

    // 199,920 earned, less 12,500 and 10,000.
    expect(settlement?.netPayCents).toBe(177_420);
    expect(settlement?.driverPayCents).toBe(199_920);
  });

  it('refuses a line with no description, which a driver cannot query', async () => {
    const result = await settlements.addLine(scoped, settlementId, {
      kind: 'deduction',
      description: '   ',
      amountCents: 5_000,
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a line of zero', async () => {
    const result = await settlements.addLine(scoped, settlementId, {
      kind: 'bonus',
      description: 'Nothing',
      amountCents: 0,
    });
    expect(result.ok).toBe(false);
  });

  it('removes a line and recomputes', async () => {
    const [bonus] = await scoped.insert('settlementLines', {
      settlementId,
      kind: 'bonus',
      sequence: 99,
      description: 'Added by mistake',
      amountCents: 50_000,
    });
    await settlements.recomputeTotals(scoped, settlementId);

    const removed = await settlements.removeLine(scoped, settlementId, bonus!.id);
    expect(removed.ok).toBe(true);

    const settlement = await scoped.selectOne(
      'settlements',
      eq(schema.settlements.id, settlementId),
    );
    expect(settlement?.netPayCents).toBe(177_420);
  });

  it('refuses to finalise when the deductions exceed the earnings', async () => {
    /*
     * Allowed in principle and almost never intended — a driver handed a
     * statement saying they owe money is a conversation nobody wants to have
     * by accident.
     */
    const [empty] = await scoped.insert('settlements', {
      driverId: leasedDriverId,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    await scoped.insert('settlementLines', {
      settlementId: empty!.id,
      kind: 'deduction',
      sequence: 0,
      description: 'Damage chargeback',
      amountCents: 40_000,
    });

    const result = await settlements.finalizeSettlement(scoped, empty!.id);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('exceed the earnings');
  });

  it('refuses to finalise an empty settlement', async () => {
    const [empty] = await scoped.insert('settlements', {
      driverId: leasedDriverId,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    const result = await settlements.finalizeSettlement(scoped, empty!.id);
    expect(result.ok).toBe(false);
  });

  it('freezes the lines once finalised', async () => {
    const finalized = await settlements.finalizeSettlement(scoped, settlementId);
    expect(finalized.ok).toBe(true);

    const blocked = await settlements.addLine(scoped, settlementId, {
      kind: 'deduction',
      description: 'Too late',
      amountCents: 1_000,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain('finalised');
  });

  it('produces a statement whose bytes match the hash recorded against it', async () => {
    const statement = await statementModule.buildStatement(scoped, settlementId);
    expect(statement.ok).toBe(true);

    const document = await scoped.selectOne(
      'documents',
      eq(schema.documents.id, statement.documentId!),
    );
    expect(document?.kind).toBe('settlement');

    const { createHash } = await import('node:crypto');
    const bytes = await readFile(path.join(workspace, 'uploads', document!.storageKey));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(document!.sha256);

    const text = await pdfText(bytes);
    expect(text).toContain('Marcus Webb');
    expect(text).toContain('Leased owner-operator');
    expect(text).toContain('Occupational accident insurance');
    // The lease disclosures a leased driver is owed.
    expect(text).toContain('376.12(f)');
    expect(text).toContain('376.12(g)');
    expect(text).toContain('376.12(h)');
  });

  it('will not produce a statement for a settlement still in draft', async () => {
    const [draft] = await scoped.insert('settlements', {
      driverId: leasedDriverId,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });

    const result = await statementModule.buildStatement(scoped, draft!.id);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('finalised');
  });

  it('records payment, but only after finalising', async () => {
    const [draft] = await scoped.insert('settlements', {
      driverId: leasedDriverId,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });

    const tooEarly = await settlements.recordSettlementPayment(
      scoped,
      draft!.id,
      'ACH-1',
      new Date(),
    );
    expect(tooEarly.ok).toBe(false);

    const paid = await settlements.recordSettlementPayment(
      scoped,
      settlementId,
      'ACH-99231',
      new Date('2026-12-18T12:00:00Z'),
    );
    expect(paid.ok).toBe(true);

    const settlement = await scoped.selectOne(
      'settlements',
      eq(schema.settlements.id, settlementId),
    );
    expect(settlement?.paidAt).not.toBeNull();
    expect(settlement?.paymentReference).toBe('ACH-99231');

    const twice = await settlements.recordSettlementPayment(scoped, settlementId, 'ACH-2', new Date());
    expect(twice.ok).toBe(false);
  });
});

describe('escrow across settlements', () => {
  it('accumulates and can be returned', async () => {
    const balanceAfterDeposit = await settlements.driverEscrowBalance(scoped, leasedDriverId);
    expect(balanceAfterDeposit).toBe(10_000);

    const [settlement] = await scoped.insert('settlements', {
      driverId: leasedDriverId,
      periodStart: new Date('2027-01-01T12:00:00Z'),
      periodEnd: new Date('2027-01-14T12:00:00Z'),
    });

    await scoped.insert('settlementLines', {
      settlementId: settlement!.id,
      kind: 'escrow_return',
      sequence: 0,
      description: 'Escrow returned on termination',
      amountCents: 4_000,
    });

    expect(await settlements.driverEscrowBalance(scoped, leasedDriverId)).toBe(6_000);
  });

  it('is counted per driver, not across the fleet', async () => {
    expect(await settlements.driverEscrowBalance(scoped, companyDriverId)).toBe(0);
  });
});
