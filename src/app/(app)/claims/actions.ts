'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import { appendAudit, AUDIT } from '@/lib/audit/chain';
import { parseMoney } from '@/lib/invoices/compute';
import {
  acknowledgeClaim,
  disposeClaim,
  fileClaim,
  releaseHold,
  sendStatusLetter,
  withdrawClaim,
} from '@/lib/claims/lifecycle';

export interface ClaimActionResult {
  ok: boolean;
  error?: string;
  claimId?: string;
  number?: string;
  /** Set when the claim arrived after the nine-month window closed. */
  lateFiled?: boolean;
}

/* -------------------------------------------------------------------------
 * Filing
 * ---------------------------------------------------------------------- */

const fileSchema = z.object({
  loadId: z.string().trim().min(1).nullable(),
  vehicleId: z.string().trim().min(1).nullable(),
  claimantName: z.string().trim().min(1, 'Name who is making the claim.').max(160),
  claimantEmail: z.string().trim().max(160).optional(),
  demand: z.string().trim().optional(),
  description: z.string().trim().min(1, 'Record what is being claimed.').max(4000),
  receivedAt: z.string().trim().optional(),
});

export async function fileClaimAction(formData: FormData): Promise<ClaimActionResult> {
  let context;
  try {
    context = await requireCapability('claim.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const loadId = formData.get('loadId');
  const vehicleId = formData.get('vehicleId');

  const parsed = fileSchema.safeParse({
    loadId: typeof loadId === 'string' && loadId !== '' ? loadId : null,
    vehicleId: typeof vehicleId === 'string' && vehicleId !== '' ? vehicleId : null,
    claimantName: formData.get('claimantName') ?? '',
    claimantEmail: formData.get('claimantEmail') ?? undefined,
    demand: formData.get('demand') ?? undefined,
    description: formData.get('description') ?? '',
    receivedAt: formData.get('receivedAt') ?? undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the claim details.' };
  }

  let demandAmountCents: number | null = null;
  if (parsed.data.demand && parsed.data.demand.trim() !== '') {
    demandAmountCents = parseMoney(parsed.data.demand);
    if (demandAmountCents === null) {
      return { ok: false, error: `“${parsed.data.demand}” is not an amount.` };
    }
  }

  /*
   * Noon UTC, not midnight. The date entered is a calendar date, and pinning
   * it to the middle of the day keeps every deadline derived from it on the
   * intended day regardless of the reader's offset.
   */
  const filedAt = parsed.data.receivedAt
    ? new Date(`${parsed.data.receivedAt}T12:00:00Z`)
    : new Date();

  if (Number.isNaN(filedAt.getTime())) {
    return { ok: false, error: 'That is not a date.' };
  }
  if (filedAt.getTime() > Date.now() + 86_400_000) {
    return { ok: false, error: 'A claim cannot have been received in the future.' };
  }

  const { session, db } = context;

  const result = await fileClaim(db, {
    loadId: parsed.data.loadId,
    vehicleId: parsed.data.vehicleId,
    claimantName: parsed.data.claimantName,
    claimantEmail: parsed.data.claimantEmail || null,
    demandAmountCents,
    description: parsed.data.description,
    filedAt,
    actorUserId: session.userId,
    actorRole: session.role,
  });

  if (!result.ok) return { ok: false, error: result.error };

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.claimFiled,
    subject: `claim:${result.claimId}`,
    detail: {
      number: result.number,
      loadId: parsed.data.loadId,
      demandAmountCents,
      filedAt: filedAt.toISOString(),
      lateFiled: result.lateFiled ?? false,
    },
  });

  if (parsed.data.loadId) revalidatePath(`/loads/${parsed.data.loadId}`);
  revalidatePath('/claims');

  return { ok: true, claimId: result.claimId, number: result.number, lateFiled: result.lateFiled };
}

/* -------------------------------------------------------------------------
 * Letters
 * ---------------------------------------------------------------------- */

function revalidateClaim(claimId: string): void {
  revalidatePath(`/claims/${claimId}`);
  revalidatePath('/claims');
  revalidatePath('/documents');
}

export async function acknowledgeClaimAction(claimId: string): Promise<ClaimActionResult> {
  let context;
  try {
    context = await requireCapability('claim.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const { session, db } = context;
  const result = await acknowledgeClaim(db, claimId);
  if (!result.ok) return { ok: false, error: result.error };

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.claimStatusChanged,
    subject: `claim:${claimId}`,
    detail: { to: 'acknowledged', documentId: result.documentId, sha256: result.sha256 },
  });

  revalidateClaim(claimId);
  return { ok: true, claimId };
}

export async function sendStatusLetterAction(
  claimId: string,
  formData: FormData,
): Promise<ClaimActionResult> {
  let context;
  try {
    context = await requireCapability('claim.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const reason = String(formData.get('delayReason') ?? '').slice(0, 1000);

  const { session, db } = context;
  const result = await sendStatusLetter(db, claimId, reason);
  if (!result.ok) return { ok: false, error: result.error };

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.claimStatusChanged,
    subject: `claim:${claimId}`,
    detail: { letter: 'status', documentId: result.documentId, reason: reason.trim() },
  });

  revalidateClaim(claimId);
  return { ok: true, claimId };
}

/* -------------------------------------------------------------------------
 * Disposition
 * ---------------------------------------------------------------------- */

const disposeSchema = z.object({
  disposition: z.enum(['paid', 'declined', 'offered']),
  amount: z.string().trim().optional(),
  reason: z.string().trim().max(2000).optional(),
});

export async function disposeClaimAction(
  claimId: string,
  formData: FormData,
): Promise<ClaimActionResult> {
  let context;
  try {
    context = await requireCapability('claim.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const parsed = disposeSchema.safeParse({
    disposition: formData.get('disposition') ?? 'declined',
    amount: formData.get('amount') ?? undefined,
    reason: formData.get('reason') ?? undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: 'Choose what is being done with the claim.' };
  }

  let amountCents: number | null = null;
  if (parsed.data.amount && parsed.data.amount.trim() !== '') {
    amountCents = parseMoney(parsed.data.amount);
    if (amountCents === null) {
      return { ok: false, error: `“${parsed.data.amount}” is not an amount.` };
    }
  }

  const { session, db } = context;

  const result = await disposeClaim(db, claimId, {
    disposition: parsed.data.disposition,
    amountCents,
    reason: parsed.data.reason || null,
  });

  if (!result.ok) return { ok: false, error: result.error };

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.claimStatusChanged,
    subject: `claim:${claimId}`,
    detail: {
      to: parsed.data.disposition,
      amountCents,
      reason: parsed.data.reason ?? null,
      documentId: result.documentId,
      sha256: result.sha256,
    },
  });

  revalidateClaim(claimId);
  return { ok: true, claimId };
}

export async function withdrawClaimAction(
  claimId: string,
  formData: FormData,
): Promise<ClaimActionResult> {
  let context;
  try {
    context = await requireCapability('claim.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const reason = String(formData.get('reason') ?? '').slice(0, 1000);

  const { session, db } = context;
  const result = await withdrawClaim(db, claimId, reason);
  if (!result.ok) return { ok: false, error: result.error };

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.claimStatusChanged,
    subject: `claim:${claimId}`,
    detail: { to: 'withdrawn', reason: reason.trim() },
  });

  revalidateClaim(claimId);
  return { ok: true, claimId };
}

/* -------------------------------------------------------------------------
 * Legal hold
 * ---------------------------------------------------------------------- */

export async function releaseHoldAction(claimId: string): Promise<ClaimActionResult> {
  let context;
  try {
    context = await requireCapability('claim.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const { session, db } = context;
  const result = await releaseHold(db, claimId, {
    userId: session.userId,
    role: session.role,
  });
  if (!result.ok) return { ok: false, error: result.error };

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.legalHoldReleased,
    subject: `claim:${claimId}`,
  });

  revalidateClaim(claimId);
  return { ok: true, claimId };
}
