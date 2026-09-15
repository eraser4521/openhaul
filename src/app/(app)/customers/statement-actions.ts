'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import { buildStatement } from '@/lib/invoices/statement-document';
import { STATEMENT_WINDOWS } from '@/lib/invoices/statement';
import { setStatementsEnabled } from '@/lib/invoices/statement-run';
import { eq } from 'drizzle-orm';
import { customers as customersTable } from '@/lib/db/schema';

/**
 * Producing a statement of account.
 *
 * `invoice.read` rather than `invoice.write`: the statement changes nothing.
 * It reports an account that already exists, and a bookkeeper who can see the
 * invoices should be able to put them on a page for the customer.
 */

export interface StatementActionResult {
  ok: boolean;
  error?: string;
  documentId?: string;
  balanceCents?: number;
  heldCents?: number;
}

const schema = z.object({
  windowDays: z.coerce
    .number()
    .int()
    .refine(
      (days) => (STATEMENT_WINDOWS as readonly number[]).includes(days),
      'Choose one of the offered periods.',
    ),
});

export async function buildStatementAction(
  customerId: string,
  formData: FormData,
): Promise<StatementActionResult> {
  let context;
  try {
    context = await requireCapability('invoice.read');
  } catch (error) {
    return authErrorToResult(error);
  }

  const parsed = schema.safeParse({ windowDays: formData.get('windowDays') ?? 90 });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the period.' };
  }

  const result = await buildStatement(context.db, customerId, {
    windowDays: parsed.data.windowDays,
  });

  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath('/customers');
  revalidatePath('/documents');

  return {
    ok: true,
    documentId: result.documentId,
    balanceCents: result.balanceCents,
    heldCents: result.heldCents,
  };
}

/**
 * Turning scheduled statements off for one customer.
 *
 * `invoice.read`, matching who can produce one by hand. Deciding that a
 * particular broker does not want a monthly statement is a bookkeeping
 * preference, not a change to what the organisation does.
 */
export async function setStatementsEnabledAction(
  customerId: string,
  enabled: boolean,
): Promise<StatementActionResult> {
  let context;
  try {
    context = await requireCapability('invoice.read');
  } catch (error) {
    return authErrorToResult(error);
  }

  await setStatementsEnabled(context.db, customerId, enabled);

  revalidatePath('/customers');
  revalidatePath('/settings');
  return { ok: true };
}

/**
 * Turning automatic chasing off for one customer.
 *
 * Separate from statements deliberately. "Do not send me a monthly summary"
 * and "never chase me for money" are different requests, and one switch for
 * both means honouring one of them by accident.
 */
export async function setDunningEnabledAction(
  customerId: string,
  enabled: boolean,
): Promise<StatementActionResult> {
  let context;
  try {
    context = await requireCapability('invoice.read');
  } catch (error) {
    return authErrorToResult(error);
  }

  await context.db.update('customers', eq(customersTable.id, customerId), {
    dunningEnabled: enabled,
  });

  revalidatePath('/customers');
  revalidatePath('/settings');
  return { ok: true };
}
