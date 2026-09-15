'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import { parseMoney } from '@/lib/invoices/compute';
import { runDunning, saveDunning } from '@/lib/invoices/dunning-run';
import { ladderProblems, normalizeLadder, type LadderStage } from '@/lib/invoices/dunning';

/**
 * Setting the ladder, and sweeping by hand.
 *
 * `settings.write`. Deciding how firmly the organisation chases its customers
 * is not a thing one dispatcher should be able to change on their own, and
 * the button sends real letters to real people.
 */

export interface DunningActionResult {
  ok: boolean;
  error?: string;
  problems?: string[];
  sent?: number;
  failed?: number;
  held?: number;
}

const ruleSchema = z.object({
  enabled: z.coerce.boolean(),
  minimumGapDays: z.coerce.number().int().min(1).max(90),
  pauseAfterPaymentDays: z.coerce.number().int().min(0).max(90),
  promiseGraceDays: z.coerce.number().int().min(0).max(30),
});

const stageSchema = z.object({
  label: z.string().trim().min(1, 'Every rung needs a name.').max(60),
  daysPastDue: z.coerce.number().int().min(0).max(365),
  message: z.string().trim().max(2000),
  enabled: z.coerce.boolean(),
});

/** Stages arrive as indexed fields so the form works without JavaScript. */
function readLadder(formData: FormData): LadderStage[] | { error: string } {
  const count = Number(formData.get('stageCount') ?? 0);
  if (!Number.isInteger(count) || count < 0 || count > 8) {
    return { error: 'That is not a ladder.' };
  }

  const stages: LadderStage[] = [];

  for (let index = 0; index < count; index += 1) {
    if (formData.get(`stage${index}Removed`) === 'on') continue;

    const parsed = stageSchema.safeParse({
      label: formData.get(`stage${index}Label`) ?? '',
      daysPastDue: formData.get(`stage${index}Days`) ?? 0,
      message: formData.get(`stage${index}Message`) ?? '',
      enabled: formData.get(`stage${index}Enabled`) === 'on',
    });

    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? 'Check the ladder.' };
    }

    stages.push({ ...parsed.data, sequence: stages.length + 1 });
  }

  return normalizeLadder(stages);
}

export async function saveDunningAction(formData: FormData): Promise<DunningActionResult> {
  let context;
  try {
    context = await requireCapability('settings.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const parsed = ruleSchema.safeParse({
    enabled: formData.get('enabled') === 'on',
    minimumGapDays: formData.get('minimumGapDays') ?? 10,
    pauseAfterPaymentDays: formData.get('pauseAfterPaymentDays') ?? 14,
    promiseGraceDays: formData.get('promiseGraceDays') ?? 3,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the settings.' };
  }

  const ladder = readLadder(formData);
  if ('error' in ladder) return { ok: false, error: ladder.error };

  const minimumBalanceCents = parseMoney(String(formData.get('minimumBalance') ?? '0')) ?? 0;
  if (minimumBalanceCents < 0) {
    return { ok: false, error: 'A minimum balance cannot be negative.' };
  }

  const rule = { ...parsed.data, minimumBalanceCents };

  /*
   * Refused rather than saved with a warning. A ladder whose second rung is
   * earlier than its first, or whose rungs are a day apart, sends letters a
   * carrier did not mean to send — and the moment it is saved it is live.
   */
  const problems = ladderProblems(ladder, rule);
  if (problems.length > 0) {
    return { ok: false, error: 'The ladder would not work as written.', problems };
  }

  await saveDunning(context.db, rule, ladder);

  revalidatePath('/settings');
  revalidatePath('/invoices');
  return { ok: true };
}

/** Sweeps now rather than waiting for the cron line. Still once a day. */
export async function runDunningAction(): Promise<DunningActionResult> {
  let context;
  try {
    context = await requireCapability('settings.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const result = await runDunning(context.db, { trigger: 'manual' });

  revalidatePath('/settings');
  revalidatePath('/invoices');
  revalidatePath('/documents');

  if (!result.ok) return { ok: false, error: result.reason };

  return { ok: true, sent: result.sent, failed: result.failed, held: result.held };
}
