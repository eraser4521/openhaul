'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import { buildStatement } from '@/lib/invoices/statement-document';
import { STATEMENT_WINDOWS } from '@/lib/invoices/statement';

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
