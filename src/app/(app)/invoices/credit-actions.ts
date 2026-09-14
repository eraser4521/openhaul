'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import { parseMoney } from '@/lib/invoices/compute';
import { applyCredit, carryForward, removeMovement } from '@/lib/invoices/customer-credit';

/**
 * Moving money between an invoice and a customer's balance.
 *
 * `payment.write`, the same as a refund: this decides where money that has
 * already arrived ends up, which belongs to whoever handles the bank rather
 * than whoever raises the bills.
 */

export interface CreditActionResult {
  ok: boolean;
  error?: string;
  movementId?: string;
  balanceCents?: number;
}

const schema = z.object({
  note: z.string().trim().max(400).optional(),
  occurredAt: z.string().trim().optional(),
  creditNoteId: z.string().trim().optional(),
});

/** Dates are calendar dates; pinned to noon UTC so no offset moves the day. */
function atNoon(value: string): Date | null {
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function read(formData: FormData) {
  const parsed = schema.safeParse({
    note: formData.get('note') ?? undefined,
    occurredAt: formData.get('occurredAt') ?? undefined,
    creditNoteId: formData.get('creditNoteId') ?? undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the details.' } as const;
  }

  const amountCents = parseMoney(String(formData.get('amount') ?? ''));
  if (amountCents === null) return { error: 'Enter an amount, like 500.00.' } as const;

  const occurredAt = parsed.data.occurredAt ? atNoon(parsed.data.occurredAt) : new Date();
  if (!occurredAt) return { error: 'That is not a date.' } as const;

  return {
    amountCents,
    occurredAt,
    note: parsed.data.note || null,
    creditNoteId: parsed.data.creditNoteId || null,
  } as const;
}

export async function carryForwardAction(
  invoiceId: string,
  formData: FormData,
): Promise<CreditActionResult> {
  let context;
  try {
    context = await requireCapability('payment.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const input = read(formData);
  if ('error' in input) return { ok: false, error: input.error };

  const result = await carryForward(context.db, invoiceId, input);
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/invoices');
  revalidatePath('/customers');
  return { ok: true, movementId: result.movementId, balanceCents: result.balanceCents };
}

export async function applyCreditAction(
  invoiceId: string,
  formData: FormData,
): Promise<CreditActionResult> {
  let context;
  try {
    context = await requireCapability('payment.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const input = read(formData);
  if ('error' in input) return { ok: false, error: input.error };

  const result = await applyCredit(context.db, invoiceId, input);
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/invoices');
  revalidatePath('/customers');
  return { ok: true, movementId: result.movementId, balanceCents: result.balanceCents };
}

/**
 * Undoes a movement.
 *
 * Takes the invoice only to revalidate the page the click came from — the
 * movement itself names the invoice whose figures get rebuilt, and passing
 * one that disagreed would not change which.
 */
export async function removeMovementAction(
  invoiceId: string | null,
  movementId: string,
): Promise<CreditActionResult> {
  let context;
  try {
    context = await requireCapability('payment.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const result = await removeMovement(context.db, movementId);
  if (!result.ok) return { ok: false, error: result.error };

  if (invoiceId) revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/invoices');
  revalidatePath('/customers');
  return { ok: true };
}
