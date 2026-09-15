'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import { parseMoney } from '@/lib/invoices/compute';
import { runStatements, saveSchedule } from '@/lib/invoices/statement-run';
import { MAX_DAY_OF_MONTH } from '@/lib/invoices/statement-schedule';
import { STATEMENT_CADENCES } from '@/lib/db/schema';
import { STATEMENT_WINDOWS } from '@/lib/invoices/statement';

/**
 * Setting the schedule, and running it by hand.
 *
 * Both are `settings.write`. Deciding that every customer with a balance gets
 * an email on the first of the month is an organisation-wide commitment, and
 * pressing the button sends that email to all of them now — neither is a
 * thing a dispatcher should be able to do on their own.
 */

export interface ScheduleActionResult {
  ok: boolean;
  error?: string;
}

export interface RunActionResult {
  ok: boolean;
  error?: string;
  sent?: number;
  failed?: number;
  skipped?: number;
}

const schema = z.object({
  cadence: z.enum(STATEMENT_CADENCES),
  dayOfMonth: z.coerce.number().int().min(1).max(MAX_DAY_OF_MONTH),
  dayOfWeek: z.coerce.number().int().min(0).max(6),
  windowDays: z.coerce
    .number()
    .int()
    .refine(
      (days) => (STATEMENT_WINDOWS as readonly number[]).includes(days),
      'Choose one of the offered periods.',
    ),
  includeCreditHolders: z.coerce.boolean(),
});

export async function saveScheduleAction(formData: FormData): Promise<ScheduleActionResult> {
  let context;
  try {
    context = await requireCapability('settings.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const parsed = schema.safeParse({
    cadence: formData.get('cadence') ?? 'off',
    dayOfMonth: formData.get('dayOfMonth') ?? 1,
    dayOfWeek: formData.get('dayOfWeek') ?? 1,
    windowDays: formData.get('windowDays') ?? 90,
    includeCreditHolders: formData.get('includeCreditHolders') === 'on',
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the schedule.' };
  }

  const minimumBalanceCents = parseMoney(String(formData.get('minimumBalance') ?? '0')) ?? 0;
  if (minimumBalanceCents < 0) {
    return { ok: false, error: 'A minimum balance cannot be negative.' };
  }

  await saveSchedule(context.db, { ...parsed.data, minimumBalanceCents });

  revalidatePath('/settings');
  return { ok: true };
}

/**
 * Sends now rather than waiting for the scheduled day.
 *
 * Still an occurrence like any other, so pressing it twice in a day does
 * nothing the second time and pressing it on the scheduled day takes that
 * occurrence — a carrier cannot double-send by being impatient.
 */
export async function runNowAction(): Promise<RunActionResult> {
  let context;
  try {
    context = await requireCapability('settings.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const result = await runStatements(context.db, { trigger: 'manual', force: true });

  revalidatePath('/settings');
  revalidatePath('/customers');
  revalidatePath('/documents');

  if (!result.ok) return { ok: false, error: result.reason };

  return { ok: true, sent: result.sent, failed: result.failed, skipped: result.skipped };
}
