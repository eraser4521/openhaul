'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import { parseMoney } from '@/lib/invoices/compute';
import {
  removeCertificate,
  saveCertificate,
  verifyCertificate,
} from '@/lib/insurance/certificates';
import { CERTIFICATE_KINDS } from '@/lib/insurance/status';

/**
 * Recording certificates, from wherever they are shown.
 *
 * Shared by the settings screen, which holds the carrier's own cover, and the
 * customers screen, which holds a customer's. The only difference between the
 * two is whether `customerId` is null, and the capability needed: editing your
 * own insurance is a settings change, recording someone else's is customer
 * work.
 */

export interface InsuranceResult {
  ok: boolean;
  error?: string;
  certificateId?: string;
}

const schema = z.object({
  kind: z.enum(CERTIFICATE_KINDS),
  insurerName: z.string().trim().min(1, 'Name the insurer.').max(160),
  policyNumber: z.string().trim().min(1, 'Record the policy number.').max(80),
  effectiveAt: z.string().trim().min(1, 'Set the effective date.'),
  expiresAt: z.string().trim().min(1, 'Set the expiry date.'),
});

/** Calendar dates, pinned to noon UTC so no offset moves the day. */
function atNoon(value: string): Date | null {
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function saveCertificateAction(
  customerId: string | null,
  certificateId: string | null,
  formData: FormData,
): Promise<InsuranceResult> {
  let context;
  try {
    context = await requireCapability(customerId ? 'customer.write' : 'settings.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const parsed = schema.safeParse({
    kind: formData.get('kind') ?? 'cargo',
    insurerName: formData.get('insurerName') ?? '',
    policyNumber: formData.get('policyNumber') ?? '',
    effectiveAt: formData.get('effectiveAt') ?? '',
    expiresAt: formData.get('expiresAt') ?? '',
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the details.' };
  }

  const effectiveAt = atNoon(parsed.data.effectiveAt);
  const expiresAt = atNoon(parsed.data.expiresAt);
  if (!effectiveAt || !expiresAt) return { ok: false, error: 'Those are not dates.' };

  /*
   * A blank limit is left null rather than zeroed. "Nobody has recorded the
   * limit" and "the policy pays nothing" are different statements, and the
   * coverage check treats them differently.
   */
  const limitRaw = String(formData.get('coverageLimit') ?? '').trim();
  const deductibleRaw = String(formData.get('deductible') ?? '').trim();

  const coverageLimitCents = limitRaw ? parseMoney(limitRaw) : null;
  if (limitRaw && coverageLimitCents === null) {
    return { ok: false, error: `“${limitRaw}” is not an amount.` };
  }

  const deductibleCents = deductibleRaw ? parseMoney(deductibleRaw) : null;
  if (deductibleRaw && deductibleCents === null) {
    return { ok: false, error: `“${deductibleRaw}” is not an amount.` };
  }

  const { session, db } = context;

  const result = await saveCertificate(
    db,
    {
      customerId,
      kind: parsed.data.kind,
      insurerName: parsed.data.insurerName,
      policyNumber: parsed.data.policyNumber,
      coverageLimitCents,
      deductibleCents,
      effectiveAt,
      expiresAt,
    },
    { userId: session.userId, role: session.role },
    certificateId,
  );

  if (!result.ok) return result;

  revalidatePath('/settings');
  revalidatePath('/customers');
  revalidatePath('/dashboard');

  return { ok: true, certificateId: result.certificateId };
}

export async function verifyCertificateAction(
  certificateId: string,
): Promise<InsuranceResult> {
  let context;
  try {
    context = await requireCapability('customer.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const { session, db } = context;
  const result = await verifyCertificate(db, certificateId, {
    userId: session.userId,
    role: session.role,
  });

  if (!result.ok) return result;

  revalidatePath('/settings');
  revalidatePath('/customers');
  return { ok: true };
}

export async function removeCertificateAction(
  certificateId: string,
): Promise<InsuranceResult> {
  let context;
  try {
    context = await requireCapability('settings.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  await removeCertificate(context.db, certificateId);

  revalidatePath('/settings');
  revalidatePath('/customers');
  revalidatePath('/dashboard');
  return { ok: true };
}
