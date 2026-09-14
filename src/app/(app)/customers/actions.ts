'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import { appendAudit, AUDIT } from '@/lib/audit/chain';
import {
  attachCheckToCustomer,
  lookupByDocket,
  lookupByDot,
  type CandidateSummary,
  type CarrierLookup,
} from '@/lib/fmcsa/lookup';

export interface LookupResult {
  ok: boolean;
  error?: string;
  lookup?: CarrierLookup;
  /** Returned when a docket number matches more than one record. */
  candidates?: CandidateSummary[];
}

const lookupSchema = z.object({
  number: z.string().trim().min(1, 'Enter a USDOT or MC number.').max(24),
  kind: z.enum(['usdot', 'docket']),
  role: z.enum(['carrier', 'broker']),
  customerId: z.string().trim().min(1).nullable(),
  force: z.boolean(),
});

/**
 * Checks a number against FMCSA and records what came back.
 *
 * Audited, because the value of the check is being able to say later that it
 * was made before the load moved — not that somebody remembers looking.
 */
export async function lookupCarrierAction(formData: FormData): Promise<LookupResult> {
  let context;
  try {
    context = await requireCapability('customer.read');
  } catch (error) {
    return authErrorToResult(error);
  }

  const customerId = formData.get('customerId');

  const parsed = lookupSchema.safeParse({
    number: formData.get('number') ?? '',
    kind: formData.get('kind') ?? 'usdot',
    role: formData.get('role') ?? 'carrier',
    customerId: typeof customerId === 'string' && customerId !== '' ? customerId : null,
    force: formData.get('force') === '1',
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the number.' };
  }

  const { session, db } = context;
  const { number, kind, role, customerId: linkTo, force } = parsed.data;

  const outcome =
    kind === 'docket'
      ? await lookupByDocket(db, number, role, { customerId: linkTo })
      : await lookupByDot(db, number, role, { customerId: linkTo, force });

  if (!outcome.ok) {
    return { ok: false, error: outcome.message, candidates: outcome.candidates };
  }

  if (linkTo && outcome.lookup.checkId) {
    await attachCheckToCustomer(db, outcome.lookup.checkId, linkTo);
  }

  // A cached answer is not a new check, so logging it would fill the record
  // with events nobody caused.
  if (!outcome.lookup.cached) {
    await appendAudit({
      orgId: session.orgId,
      actorId: session.userId,
      actorRole: session.role,
      action: AUDIT.carrierChecked,
      subject: `carrier:${outcome.lookup.profile.dotNumber ?? number}`,
      detail: {
        role,
        verdict: outcome.lookup.verdict,
        legalName: outcome.lookup.profile.legalName,
        allowedToOperate: outcome.lookup.profile.allowedToOperate,
        customerId: linkTo,
      },
    });
  }

  if (linkTo) revalidatePath('/customers');

  return { ok: true, lookup: outcome.lookup };
}
