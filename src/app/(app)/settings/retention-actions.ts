'use server';

import { revalidatePath } from 'next/cache';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import { purgeClass, setRetentionDays } from '@/lib/retention/engine';
import { ORG_HOLD, placeHold, releaseHolds, type HoldSubject } from '@/lib/retention/holds';
import { POLICY_BY_CLASS, RECORD_CLASSES, type RecordClass } from '@/lib/retention/policy';

/**
 * Retention, from the settings screen.
 *
 * The only destructive action in here is `purgeClassAction`, and it is
 * deliberately the most awkward thing in the application to trigger: its own
 * capability, a count typed by hand, and a re-evaluation inside the engine
 * that ignores whatever the screen thought was due. Nothing calls it on a
 * timer, and nothing in the codebase calls it except this form.
 */

export interface RetentionResult {
  ok: boolean;
  error?: string;
  purged?: number;
  bytes?: number;
  unreachable?: number;
}

function parseClass(value: string): RecordClass | null {
  return (RECORD_CLASSES as readonly string[]).includes(value) ? (value as RecordClass) : null;
}

export async function setRetentionDaysAction(
  recordClassInput: string,
  formData: FormData,
): Promise<RetentionResult> {
  let context;
  try {
    context = await requireCapability('settings.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const recordClass = parseClass(recordClassInput);
  if (!recordClass) return { ok: false, error: 'Unknown record class.' };

  const years = Number.parseFloat(String(formData.get('years') ?? ''));
  if (!Number.isFinite(years) || years < 0) {
    return { ok: false, error: 'Enter a number of years.' };
  }

  const { session, db } = context;
  const result = await setRetentionDays(db, recordClass, Math.round(years * 365), {
    userId: session.userId,
    role: session.role,
  });

  if (!result.ok) return result;

  revalidatePath('/settings');
  return { ok: true };
}

export async function purgeClassAction(
  recordClassInput: string,
  formData: FormData,
): Promise<RetentionResult> {
  let context;
  try {
    context = await requireCapability('retention.purge');
  } catch (error) {
    return authErrorToResult(error);
  }

  const recordClass = parseClass(recordClassInput);
  if (!recordClass) return { ok: false, error: 'Unknown record class.' };

  /*
   * The count is the confirmation. Typing it means the number on the screen
   * was read, which is the only part of this that cannot be undone — and a
   * count that has moved since the screen was drawn is itself a reason to
   * stop and look again.
   */
  const expected = String(formData.get('expected') ?? '').trim();
  const confirmed = String(formData.get('confirm') ?? '').trim();
  if (confirmed !== expected) {
    return { ok: false, error: `Type ${expected} to confirm how many records go.` };
  }

  const { session, db } = context;
  const result = await purgeClass(db, recordClass, {
    userId: session.userId,
    role: session.role,
  });

  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath('/settings');
  return {
    ok: true,
    purged: result.purged,
    bytes: result.bytes,
    unreachable: result.unreachable,
  };
}

export async function placeOrgHoldAction(formData: FormData): Promise<RetentionResult> {
  let context;
  try {
    context = await requireCapability('settings.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const { session, db } = context;
  const result = await placeHold(db, ORG_HOLD, String(formData.get('reason') ?? ''), {
    userId: session.userId,
    role: session.role,
  });

  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath('/settings');
  return { ok: true };
}

export async function releaseHoldAction(subject: string): Promise<RetentionResult> {
  let context;
  try {
    context = await requireCapability('settings.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const { session, db } = context;
  await releaseHolds(db, subject as HoldSubject, {
    userId: session.userId,
    role: session.role,
  });

  revalidatePath('/settings');
  return { ok: true };
}

/** Labels for the screen, so the client component holds no policy data of its own. */
export async function recordClassLabel(recordClass: RecordClass): Promise<string> {
  return POLICY_BY_CLASS[recordClass].label;
}
