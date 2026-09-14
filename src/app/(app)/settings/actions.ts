'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import { appendAudit, AUDIT, verifyChain } from '@/lib/audit/chain';
import { updateOrganizationProfile } from '@/lib/organization/profile';

export interface ChainCheckResult {
  ok: boolean;
  message: string;
}

/**
 * Recomputes the audit chain end to end.
 *
 * Owner-only: the result tells you whether anyone has tampered with the
 * record, which is not information a driver account needs.
 */
export async function verifyChainAction(): Promise<ChainCheckResult> {
  try {
    await requireCapability('audit.read');
  } catch {
    return { ok: false, message: 'Only an owner can verify the audit log.' };
  }

  const verdict = await verifyChain();

  if (verdict.ok) {
    return {
      ok: true,
      message:
        verdict.entries === 0
          ? 'The audit log is empty, so there is nothing to verify yet.'
          : `Verified ${verdict.entries} entries. Every one links correctly to the one before it.`,
    };
  }

  return {
    ok: false,
    message:
      `The chain breaks at entry ${verdict.brokenAtSeq}: ${verdict.detail}. ` +
      'Entries before that point are still trustworthy; everything after should be treated as suspect.',
  };
}

export interface CompanyResult {
  ok: boolean;
  error?: string;
}

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => value || null);

const companySchema = z.object({
  legalName: z.string().trim().min(1, 'Your legal name is what appears on the paperwork.').max(160),
  dbaName: optional(160),
  addressLine1: optional(160),
  addressLine2: optional(160),
  city: optional(80),
  state: optional(2).transform((value) => value?.toUpperCase() ?? null),
  postalCode: optional(12),
  phone: optional(32),
  email: optional(160),
  usdotNumber: optional(24),
  mcNumber: optional(24),
});

/**
 * Saves the company as it appears on documents.
 *
 * Owner-only, and audited: the carrier name and authority numbers on a bill of
 * lading are the things a shipper relies on to know who moved their vehicle,
 * so a change to them belongs on the record.
 *
 * The organisation id comes from the session, never from the form.
 */
export async function saveCompanyAction(formData: FormData): Promise<CompanyResult> {
  let context;
  try {
    context = await requireCapability('settings.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const parsed = companySchema.safeParse({
    legalName: formData.get('legalName') ?? '',
    dbaName: formData.get('dbaName') ?? undefined,
    addressLine1: formData.get('addressLine1') ?? undefined,
    addressLine2: formData.get('addressLine2') ?? undefined,
    city: formData.get('city') ?? undefined,
    state: formData.get('state') ?? undefined,
    postalCode: formData.get('postalCode') ?? undefined,
    phone: formData.get('phone') ?? undefined,
    email: formData.get('email') ?? undefined,
    usdotNumber: formData.get('usdotNumber') ?? undefined,
    mcNumber: formData.get('mcNumber') ?? undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the details.' };
  }

  const { session } = context;

  await updateOrganizationProfile(session.orgId, parsed.data);

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.settingsChanged,
    subject: `organization:${session.orgId}`,
    detail: { legalName: parsed.data.legalName, usdotNumber: parsed.data.usdotNumber },
  });

  revalidatePath('/settings');
  return { ok: true };
}
