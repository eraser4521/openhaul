'use server';

import { revalidatePath } from 'next/cache';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import { can } from '@/lib/auth/capabilities';
import { removeExpense, reviewExpense } from '@/lib/expenses/record';

/**
 * Reviewing and removing expenses.
 *
 * Recording one does not live here: it goes through `/api/expenses` so the
 * offline outbox can post it from a device with no signal, which a server
 * action cannot do.
 */

export interface ExpenseActionResult {
  ok: boolean;
  error?: string;
}

export async function reviewExpenseAction(
  expenseId: string,
  reimbursable: boolean,
): Promise<ExpenseActionResult> {
  let context;
  try {
    context = await requireCapability('expense.approve');
  } catch (error) {
    return authErrorToResult(error);
  }

  const { session, db } = context;
  const result = await reviewExpense(db, expenseId, reimbursable, {
    userId: session.userId,
    role: session.role,
  });

  if (!result.ok) return result;

  revalidatePath('/expenses');
  revalidatePath('/drivers');
  return { ok: true };
}

export async function removeExpenseAction(expenseId: string): Promise<ExpenseActionResult> {
  let context;
  try {
    context = await requireCapability('expense.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const { session, db } = context;
  const result = await removeExpense(db, expenseId, {
    userId: session.userId,
    seesEveryone: can(session.role, 'expense.approve'),
  });

  if (!result.ok) return result;

  revalidatePath('/expenses');
  return { ok: true };
}
