import 'server-only';
import { and, eq } from 'drizzle-orm';
import {
  drivers as driversTable,
  expenses as expensesTable,
  type ExpenseCategory,
} from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { appendAudit, AUDIT } from '../audit/chain';
import { isSettled } from './categories';

/**
 * Expenses a driver records from the cab.
 *
 * Two rules shape everything here.
 *
 * A driver sees their own and nobody else's. The scoped client confines
 * queries to an organisation, not to a person, so that narrowing is done here
 * — every read a driver makes goes through `visibleTo`, which resolves their
 * session to a driver row and filters on it. A dispatcher or owner sees all of
 * them, which is the point of the review queue.
 *
 * And a driver does not decide what they get paid back for. Recording an
 * expense leaves it awaiting review; somebody with `expense.approve` decides.
 * The settlement sweeps up anything marked reimbursable automatically, so the
 * flag is effectively an instruction to pay — not something the person being
 * paid should be able to set.
 */

export interface ExpenseInput {
  /** Client-generated, so a phone with no signal needs no round trip. */
  id?: string;
  loadId: string | null;
  category: ExpenseCategory;
  amountCents: number;
  incurredAt: Date;
  vendor: string | null;
  notes: string | null;
}

export interface ExpenseResult {
  ok: boolean;
  error?: string;
  expenseId?: string;
  /** True when an idempotent retry resolved to the row already stored. */
  deduplicated?: boolean;
}

/**
 * The driver record behind a session, if there is one.
 *
 * An owner who also drives has both; a dispatcher has neither and sees
 * everything. Null means "not a driver", which is not an error.
 */
export async function driverForUser(
  scoped: ScopedDb,
  userId: string,
): Promise<{ id: string; displayName: string } | null> {
  const driver = await scoped.selectOne('drivers', eq(driversTable.userId, userId));
  return driver ? { id: driver.id, displayName: driver.displayName } : null;
}

export interface Viewer {
  userId: string;
  /** False for a driver, who is confined to their own expenses. */
  seesEveryone: boolean;
}

/**
 * Expenses this person may see, newest first.
 *
 * A driver with no driver record sees nothing rather than everything, which is
 * the safe direction for a mapping that has not been set up yet.
 */
export async function visibleTo(scoped: ScopedDb, viewer: Viewer) {
  if (viewer.seesEveryone) {
    const rows = await scoped.select('expenses');
    return rows.slice().sort((a, b) => b.incurredAt.getTime() - a.incurredAt.getTime());
  }

  const driver = await driverForUser(scoped, viewer.userId);
  if (!driver) return [];

  const rows = await scoped.select('expenses', eq(expensesTable.driverId, driver.id));
  return rows.slice().sort((a, b) => b.incurredAt.getTime() - a.incurredAt.getTime());
}

export async function recordExpense(
  scoped: ScopedDb,
  driverId: string | null,
  input: ExpenseInput,
): Promise<ExpenseResult> {
  if (input.amountCents <= 0) {
    return { ok: false, error: 'Enter what it cost.' };
  }

  if (input.incurredAt.getTime() > Date.now() + 86_400_000) {
    return { ok: false, error: 'That date is in the future.' };
  }

  /*
   * Idempotency. The client mints the id before it queues anything, so a retry
   * after a lost response resolves to the row that already exists rather than
   * paying the driver back twice for one tank of fuel.
   */
  if (input.id) {
    const existing = await scoped.selectOne('expenses', eq(expensesTable.id, input.id));
    if (existing) return { ok: true, expenseId: existing.id, deduplicated: true };
  }

  const [row] = await scoped.insert('expenses', {
    ...(input.id ? { id: input.id } : {}),
    driverId,
    loadId: input.loadId,
    category: input.category,
    amountCents: input.amountCents,
    incurredAt: input.incurredAt,
    vendor: input.vendor,
    notes: input.notes,
    // Recorded, not approved. Somebody else decides.
    reimbursable: false,
    reviewedAt: null,
  });

  if (!row) return { ok: false, error: 'That could not be saved.' };

  await appendAudit({
    orgId: scoped.orgId,
    action: AUDIT.expenseRecorded,
    subject: `expense:${row.id}`,
    detail: {
      category: input.category,
      amountCents: input.amountCents,
      loadId: input.loadId,
      driverId,
    },
  });

  return { ok: true, expenseId: row.id, deduplicated: false };
}

export async function attachReceipt(
  scoped: ScopedDb,
  expenseId: string,
  receipt: { storageKey: string; sha256: string },
): Promise<void> {
  await scoped.update('expenses', eq(expensesTable.id, expenseId), {
    receiptStorageKey: receipt.storageKey,
    receiptSha256: receipt.sha256,
  });
}

/**
 * Decides whether the carrier pays an expense back.
 *
 * Refused once a settlement has reimbursed it: the driver is holding a
 * statement that says it was paid, and flipping the flag afterwards would
 * either pay it twice or contradict a document already issued.
 */
export async function reviewExpense(
  scoped: ScopedDb,
  expenseId: string,
  reimbursable: boolean,
  actor: { userId: string; role: string },
): Promise<{ ok: boolean; error?: string }> {
  const expense = await scoped.selectOne('expenses', eq(expensesTable.id, expenseId));
  if (!expense) return { ok: false, error: 'No such expense.' };

  if (isSettled(expense)) {
    return {
      ok: false,
      error:
        'This was already reimbursed on a settlement. Correct it with a line on the next one ' +
        'rather than by changing what the driver was told.',
    };
  }

  await scoped.update('expenses', eq(expensesTable.id, expenseId), {
    reimbursable,
    reviewedAt: new Date(),
    reviewedByUserId: actor.userId,
  });

  await appendAudit({
    orgId: scoped.orgId,
    actorId: actor.userId,
    actorRole: actor.role,
    action: AUDIT.expenseReviewed,
    subject: `expense:${expenseId}`,
    detail: { reimbursable, amountCents: expense.amountCents, category: expense.category },
  });

  return { ok: true };
}

/**
 * Removes one recorded in error.
 *
 * A driver may delete their own while it is still awaiting review; once
 * somebody has decided, or it has been paid, it is the carrier's record too.
 */
export async function removeExpense(
  scoped: ScopedDb,
  expenseId: string,
  viewer: Viewer,
): Promise<{ ok: boolean; error?: string }> {
  const expense = await scoped.selectOne('expenses', eq(expensesTable.id, expenseId));
  if (!expense) return { ok: false, error: 'No such expense.' };

  if (isSettled(expense)) {
    return { ok: false, error: 'This was already reimbursed and cannot be removed.' };
  }

  if (!viewer.seesEveryone) {
    const driver = await driverForUser(scoped, viewer.userId);
    if (!driver || expense.driverId !== driver.id) {
      return { ok: false, error: 'That is not your expense.' };
    }
    if (expense.reviewedAt) {
      return {
        ok: false,
        error: 'This has already been reviewed. Ask your dispatcher to remove it.',
      };
    }
  }

  await scoped.remove('expenses', eq(expensesTable.id, expenseId));
  return { ok: true };
}

/** Awaiting a decision, for the review queue and the dashboard count. */
export async function pendingReview(scoped: ScopedDb) {
  const rows = await scoped.select('expenses');
  return rows
    .filter((row) => row.reviewedAt === null)
    .sort((a, b) => a.incurredAt.getTime() - b.incurredAt.getTime());
}

/** Everything on a load, for the load screen. */
export async function expensesForLoad(scoped: ScopedDb, loadId: string) {
  const rows = await scoped.select(
    'expenses',
    and(eq(expensesTable.loadId, loadId)),
  );
  return rows.slice().sort((a, b) => b.incurredAt.getTime() - a.incurredAt.getTime());
}
