import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { CATEGORY_LABEL, isSettled, reviewState } from '@/lib/expenses/categories';
import { EXPENSE_CATEGORIES } from '@/lib/db/schema';
import { applyMigrations } from './helpers/temp-db';

/**
 * Expenses recorded from the cab.
 *
 * The two things worth the most here are both refusals. A driver may not
 * decide what they get paid back for, because the settlement sweeps that flag
 * up automatically and it is therefore an instruction to pay. And a driver may
 * not see another driver's expenses: the scoped client confines queries to an
 * organisation, not to a person, so that narrowing is application code and
 * application code is what gets it wrong.
 */

describe('the three states of a claim', () => {
  const at = new Date('2026-09-01T12:00:00Z');

  it('distinguishes "nobody has looked" from "we said no"', () => {
    /*
     * Both are `reimbursable: false`. A driver watching a receipt sit
     * unacknowledged for a fortnight needs to know which one they are looking
     * at, and a single boolean cannot say.
     */
    expect(reviewState({ reimbursable: false, reviewedAt: null })).toBe('pending');
    expect(reviewState({ reimbursable: false, reviewedAt: at })).toBe('declined');
    expect(reviewState({ reimbursable: true, reviewedAt: at })).toBe('approved');
  });

  it('treats a reimbursed expense as settled', () => {
    expect(isSettled({ reimbursedAt: null })).toBe(false);
    expect(isSettled({ reimbursedAt: at })).toBe(true);
  });

  it('names every category a driver can pick', () => {
    for (const category of EXPENSE_CATEGORIES) {
      expect(CATEGORY_LABEL[category]).toBeTruthy();
    }
  });
});

/* -------------------------------------------------------------------------
 * Against a real database
 * ---------------------------------------------------------------------- */

let workspace: string;
let scoped: Awaited<ReturnType<typeof import('@/lib/db/scope')['forOrg']>>;
let dbModule: typeof import('@/lib/db/client');
let schema: typeof import('@/lib/db/schema');
let expenses: typeof import('@/lib/expenses/record');

let marcus: { userId: string; driverId: string };
let priya: { userId: string; driverId: string };
let dispatcher: { userId: string };

const INCURRED = new Date('2026-09-10T12:00:00Z');

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'openhaul-expenses-'));
  process.env.DATABASE_URL = `file:${path.join(workspace, 'test.db')}`;
  delete process.env.DATABASE_ENCRYPTION_KEY;
  process.env.BLOB_STORAGE_PATH = path.join(workspace, 'uploads');

  dbModule = await import('@/lib/db/client');
  schema = await import('@/lib/db/schema');
  await dbModule.ready();
  await applyMigrations(dbModule.rawClient);

  const { asOrgId, forOrg } = await import('@/lib/db/scope');
  expenses = await import('@/lib/expenses/record');

  const [org] = await dbModule.db
    .insert(schema.organizations)
    .values({ legalName: 'Ridgeline Auto Transport LLC' })
    .returning();
  scoped = forOrg(asOrgId(org!.id));

  async function makeDriver(email: string, name: string) {
    const [user] = await dbModule.db
      .insert(schema.users)
      .values({ email, displayName: name })
      .returning();
    const [driver] = await scoped.insert('drivers', {
      displayName: name,
      userId: user!.id,
      // A settlement refuses to build without one, and the last test needs it.
      payRateBps: 6_800,
    });
    return { userId: user!.id, driverId: driver!.id };
  }

  marcus = await makeDriver('marcus@ridgeline.test', 'Marcus Webb');
  priya = await makeDriver('priya@ridgeline.test', 'Priya Raman');

  const [user] = await dbModule.db
    .insert(schema.users)
    .values({ email: 'dispatch@ridgeline.test', displayName: 'Dispatch' })
    .returning();
  dispatcher = { userId: user!.id };
});

afterAll(async () => {
  dbModule.rawClient.close();
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  for (const row of await scoped.select('expenses')) {
    await scoped.remove('expenses', eq(schema.expenses.id, row.id));
  }
});

function fuel(overrides: Partial<import('@/lib/expenses/record').ExpenseInput> = {}) {
  return {
    loadId: null,
    category: 'fuel' as const,
    amountCents: 8_450,
    incurredAt: INCURRED,
    vendor: 'Pilot #412',
    notes: null,
    ...overrides,
  };
}

describe('recording one', () => {
  it('lands awaiting review, not approved', async () => {
    /*
     * The whole point. A driver who could mark their own fuel reimbursable on
     * a percentage lease would be authorising their own repayment, and the
     * settlement pays it without asking anybody.
     */
    const result = await expenses.recordExpense(scoped, marcus.driverId, fuel());
    expect(result.ok).toBe(true);

    const row = await scoped.selectOne('expenses', eq(schema.expenses.id, result.expenseId!));
    expect(row?.reimbursable).toBe(false);
    expect(row?.reviewedAt).toBeNull();
    expect(reviewState(row!)).toBe('pending');
  });

  it('is idempotent on the id the device minted', async () => {
    // A response lost in a tunnel must not turn one tank of fuel into two
    // reimbursements.
    const id = '01a0a300-0000-7000-8000-00000000abcd';

    const first = await expenses.recordExpense(scoped, marcus.driverId, fuel({ id }));
    const second = await expenses.recordExpense(scoped, marcus.driverId, fuel({ id }));

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.expenseId).toBe(first.expenseId);
    expect(await scoped.select('expenses')).toHaveLength(1);
  });

  it('refuses nothing and refuses a date that has not happened', async () => {
    expect((await expenses.recordExpense(scoped, marcus.driverId, fuel({ amountCents: 0 }))).ok).toBe(
      false,
    );

    const future = new Date(Date.now() + 10 * 86_400_000);
    const result = await expenses.recordExpense(scoped, marcus.driverId, fuel({ incurredAt: future }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('future');
  });
});

describe('who can see what', () => {
  beforeEach(async () => {
    await expenses.recordExpense(scoped, marcus.driverId, fuel({ vendor: 'Marcus stop' }));
    await expenses.recordExpense(scoped, priya.driverId, fuel({ vendor: 'Priya stop' }));
  });

  it('shows a driver their own and nobody else’s', async () => {
    const mine = await expenses.visibleTo(scoped, { userId: marcus.userId, seesEveryone: false });

    expect(mine).toHaveLength(1);
    expect(mine[0]?.vendor).toBe('Marcus stop');
  });

  it('shows everyone to whoever approves', async () => {
    const all = await expenses.visibleTo(scoped, { userId: dispatcher.userId, seesEveryone: true });
    expect(all).toHaveLength(2);
  });

  it('shows nothing to an account with no driver record', async () => {
    /*
     * The safe direction. A user who is not linked to a driver yet seeing
     * every expense in the company would be the wrong way to fail.
     */
    const none = await expenses.visibleTo(scoped, {
      userId: dispatcher.userId,
      seesEveryone: false,
    });
    expect(none).toHaveLength(0);
  });
});

describe('deciding what comes back', () => {
  it('records who approved it and when', async () => {
    const created = await expenses.recordExpense(scoped, marcus.driverId, fuel());

    const result = await expenses.reviewExpense(scoped, created.expenseId!, true, {
      userId: dispatcher.userId,
      role: 'dispatcher',
    });
    expect(result.ok).toBe(true);

    const row = await scoped.selectOne('expenses', eq(schema.expenses.id, created.expenseId!));
    expect(reviewState(row!)).toBe('approved');
    expect(row?.reviewedByUserId).toBe(dispatcher.userId);

    const entries = await dbModule.db.select().from(schema.auditLog);
    expect(entries.some((entry) => entry.action === 'expense.reviewed')).toBe(true);
  });

  it('records a decline as a decision rather than as silence', async () => {
    const created = await expenses.recordExpense(scoped, marcus.driverId, fuel());
    await expenses.reviewExpense(scoped, created.expenseId!, false, {
      userId: dispatcher.userId,
      role: 'dispatcher',
    });

    const row = await scoped.selectOne('expenses', eq(schema.expenses.id, created.expenseId!));
    expect(reviewState(row!)).toBe('declined');
    expect(row?.reviewedAt).toBeTruthy();
  });

  it('refuses to change one a settlement has already paid', async () => {
    // The driver is holding a statement that says it was reimbursed. Flipping
    // the flag now either pays it twice or contradicts that document.
    const created = await expenses.recordExpense(scoped, marcus.driverId, fuel());
    await scoped.update('expenses', eq(schema.expenses.id, created.expenseId!), {
      reimbursable: true,
      reviewedAt: new Date(),
      reimbursedAt: new Date(),
    });

    const result = await expenses.reviewExpense(scoped, created.expenseId!, false, {
      userId: dispatcher.userId,
      role: 'dispatcher',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('already reimbursed');
  });
});

describe('removing one', () => {
  it('lets a driver withdraw their own while nobody has looked', async () => {
    const created = await expenses.recordExpense(scoped, marcus.driverId, fuel());

    const result = await expenses.removeExpense(scoped, created.expenseId!, {
      userId: marcus.userId,
      seesEveryone: false,
    });

    expect(result.ok).toBe(true);
    expect(await scoped.select('expenses')).toHaveLength(0);
  });

  it('stops a driver removing one that has been reviewed', async () => {
    const created = await expenses.recordExpense(scoped, marcus.driverId, fuel());
    await expenses.reviewExpense(scoped, created.expenseId!, true, {
      userId: dispatcher.userId,
      role: 'dispatcher',
    });

    const result = await expenses.removeExpense(scoped, created.expenseId!, {
      userId: marcus.userId,
      seesEveryone: false,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('already been reviewed');
  });

  it('stops a driver removing somebody else’s', async () => {
    const created = await expenses.recordExpense(scoped, priya.driverId, fuel());

    const result = await expenses.removeExpense(scoped, created.expenseId!, {
      userId: marcus.userId,
      seesEveryone: false,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not your expense');
    expect(await scoped.select('expenses')).toHaveLength(1);
  });

  it('refuses to remove one already reimbursed, whoever asks', async () => {
    const created = await expenses.recordExpense(scoped, marcus.driverId, fuel());
    await scoped.update('expenses', eq(schema.expenses.id, created.expenseId!), {
      reimbursedAt: new Date(),
    });

    const result = await expenses.removeExpense(scoped, created.expenseId!, {
      userId: dispatcher.userId,
      seesEveryone: true,
    });

    expect(result.ok).toBe(false);
  });
});

describe('reaching a settlement', () => {
  it('is picked up once approved, and not before', async () => {
    /*
     * End to end against the real settlement builder, because the approval
     * flag existing is only useful if the thing that pays attention to it
     * actually does.
     */
    const { buildSettlement } = await import('@/lib/settlements/lifecycle');

    const created = await expenses.recordExpense(scoped, marcus.driverId, fuel());

    const periodStart = new Date('2026-09-01T00:00:00Z');
    const periodEnd = new Date('2026-09-15T00:00:00Z');

    const before = await buildSettlement(scoped, marcus.driverId, periodStart, periodEnd);
    const beforeLines = await scoped.select('settlementLines');
    expect(beforeLines.some((line) => line.kind === 'reimbursement')).toBe(false);

    // Clear it down and approve, then build again.
    for (const line of beforeLines) {
      await scoped.remove('settlementLines', eq(schema.settlementLines.id, line.id));
    }
    if (before.settlementId) {
      await scoped.remove('settlements', eq(schema.settlements.id, before.settlementId));
    }

    await expenses.reviewExpense(scoped, created.expenseId!, true, {
      userId: dispatcher.userId,
      role: 'dispatcher',
    });

    await buildSettlement(scoped, marcus.driverId, periodStart, periodEnd);
    const afterLines = await scoped.select('settlementLines');
    const reimbursement = afterLines.find((line) => line.kind === 'reimbursement');

    expect(reimbursement?.amountCents).toBe(8_450);
    expect(reimbursement?.basisNote).toBe('No receipt on file');
  });
});
