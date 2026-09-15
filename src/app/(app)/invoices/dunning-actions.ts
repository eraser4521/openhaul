'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import { ladderFor, pauseDunning, sendNotice } from '@/lib/invoices/dunning-run';
import { cancelPromise, recordPromise } from '@/lib/invoices/promise-record';
import { PROMISE_CHANNELS } from '@/lib/db/schema';
import { parseMoney } from '@/lib/invoices/compute';

/**
 * Stopping or nudging the ladder on one invoice.
 *
 * `payment.write`, the same as recording money. Both are the bookkeeper
 * deciding what happens about a debt, and the person who has just spoken to
 * the customer is exactly who should be able to say "leave this one alone
 * until Friday" without asking an owner.
 */

export interface InvoiceDunningResult {
  ok: boolean;
  error?: string;
}

const pauseSchema = z.object({
  until: z.string().trim().min(1, 'Say until when.'),
  reason: z.string().trim().min(1, 'Say why — it stays on the record.').max(400),
});

/** Dates are calendar dates; pinned to noon UTC so no offset moves the day. */
function atNoon(value: string): Date | null {
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function pauseDunningAction(
  invoiceId: string,
  formData: FormData,
): Promise<InvoiceDunningResult> {
  let context;
  try {
    context = await requireCapability('payment.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const parsed = pauseSchema.safeParse({
    until: formData.get('until') ?? '',
    reason: formData.get('reason') ?? '',
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the details.' };
  }

  const until = atNoon(parsed.data.until);
  if (!until) return { ok: false, error: 'That is not a date.' };

  const result = await pauseDunning(context.db, invoiceId, until, parsed.data.reason);
  if (!result.ok) return result;

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/settings');
  return { ok: true };
}

export async function resumeDunningAction(invoiceId: string): Promise<InvoiceDunningResult> {
  let context;
  try {
    context = await requireCapability('payment.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const result = await pauseDunning(context.db, invoiceId, null, '');
  if (!result.ok) return result;

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/settings');
  return { ok: true };
}

/**
 * Sends the next rung now.
 *
 * The same letter the sweep would have sent, so a dispatcher who has just had
 * the conversation does not have to wait for tomorrow's cron line — and does
 * not have to write their own.
 */
export async function sendNextNoticeAction(
  invoiceId: string,
  sequence: number,
): Promise<InvoiceDunningResult> {
  let context;
  try {
    context = await requireCapability('payment.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const ladder = await ladderFor(context.db);
  const stage = ladder.find((row) => row.sequence === sequence && row.enabled);
  if (!stage) return { ok: false, error: 'That rung is not on the ladder any more.' };

  const result = await sendNotice(context.db, invoiceId, stage);
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/documents');
  return { ok: true };
}

/* -------------------------------------------------------------------------
 * Promises to pay
 * ---------------------------------------------------------------------- */

export interface PromiseActionResult {
  ok: boolean;
  error?: string;
  problems?: string[];
}

const promiseSchema = z.object({
  promisedFor: z.string().trim().min(1, 'Say when they said it would be paid.'),
  contactName: z.string().trim().max(120).optional(),
  channel: z.enum(PROMISE_CHANNELS),
  notes: z.string().trim().max(400).optional(),
});

export async function recordPromiseAction(
  invoiceId: string,
  formData: FormData,
): Promise<PromiseActionResult> {
  let context;
  try {
    context = await requireCapability('payment.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const parsed = promiseSchema.safeParse({
    promisedFor: formData.get('promisedFor') ?? '',
    contactName: formData.get('contactName') ?? undefined,
    channel: formData.get('channel') ?? 'phone',
    notes: formData.get('notes') ?? undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the details.' };
  }

  const amountCents = parseMoney(String(formData.get('amount') ?? ''));
  if (amountCents === null) {
    return { ok: false, error: 'Enter what they said they would pay, like 1875.00.' };
  }

  const promisedFor = atNoon(parsed.data.promisedFor);
  if (!promisedFor) return { ok: false, error: 'That is not a date.' };

  const result = await recordPromise(context.db, invoiceId, {
    amountCents,
    promisedFor,
    contactName: parsed.data.contactName || null,
    channel: parsed.data.channel,
    notes: parsed.data.notes || null,
  });

  if (!result.ok) return { ok: false, error: result.error, problems: result.problems };

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/settings');
  return { ok: true };
}

export async function cancelPromiseAction(
  invoiceId: string,
  promiseId: string,
  reason: string,
): Promise<PromiseActionResult> {
  let context;
  try {
    context = await requireCapability('payment.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const result = await cancelPromise(context.db, promiseId, reason);
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/settings');
  return { ok: true };
}
