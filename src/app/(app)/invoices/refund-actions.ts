'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { PAYMENT_METHODS } from '@/lib/db/schema';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import { parseMoney } from '@/lib/invoices/compute';
import { recordRefund, removeRefund } from '@/lib/invoices/refunds';

/**
 * Sending money back, from the invoice screen.
 *
 * `payment.write` rather than `invoice.write`: recording that money left is
 * the same kind of act as recording that it arrived, and belongs to whoever
 * handles the bank rather than whoever raises the bills.
 */

export interface RefundActionResult {
  ok: boolean;
  error?: string;
  refundId?: string;
}

const schema = z.object({
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(400).optional(),
  issuedAt: z.string().trim().optional(),
  creditNoteId: z.string().trim().optional(),
});

/** Dates are calendar dates; pinned to noon UTC so no offset moves the day. */
function atNoon(value: string): Date | null {
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function recordRefundAction(
  invoiceId: string,
  formData: FormData,
): Promise<RefundActionResult> {
  let context;
  try {
    context = await requireCapability('payment.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const parsed = schema.safeParse({
    method: formData.get('method') ?? 'check',
    reference: formData.get('reference') ?? undefined,
    notes: formData.get('notes') ?? undefined,
    issuedAt: formData.get('issuedAt') ?? undefined,
    creditNoteId: formData.get('creditNoteId') ?? undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the details.' };
  }

  const amountCents = parseMoney(String(formData.get('amount') ?? ''));
  if (amountCents === null) {
    return { ok: false, error: 'Enter the amount sent back, like 500.00.' };
  }

  const issuedAt = parsed.data.issuedAt ? atNoon(parsed.data.issuedAt) : new Date();
  if (!issuedAt) return { ok: false, error: 'That is not a date.' };

  const result = await recordRefund(context.db, invoiceId, {
    amountCents,
    method: parsed.data.method,
    reference: parsed.data.reference || null,
    notes: parsed.data.notes || null,
    issuedAt,
    creditNoteId: parsed.data.creditNoteId || null,
  });

  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/invoices');
  return { ok: true, refundId: result.refundId };
}

export async function removeRefundAction(
  invoiceId: string,
  refundId: string,
): Promise<RefundActionResult> {
  let context;
  try {
    context = await requireCapability('payment.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const result = await removeRefund(context.db, invoiceId, refundId);
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/invoices');
  return { ok: true };
}
