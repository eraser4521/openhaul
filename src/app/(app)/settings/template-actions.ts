'use server';

import { revalidatePath } from 'next/cache';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import { appendAudit, AUDIT } from '@/lib/audit/chain';
import { saveTemplate } from '@/lib/branding/template';
import { createRate, setRateActive, updateRate } from '@/lib/branding/accessorials';
import {
  accessorialRateSchema,
  templateFieldsSchema,
  templateScopeSchema,
} from '@/lib/branding/validate';
import { parseMoney } from '@/lib/invoices/compute';

/**
 * Saving the carrier-owned layer of their documents.
 *
 * Owner-only and audited. What goes on the face of a bill of lading is the
 * kind of change somebody should be able to account for later — not because
 * letterhead is dangerous, but because "this is not the document we issued"
 * is an argument that gets made, and the audit chain is what answers it.
 *
 * Note what these actions cannot do. There is no field here that reaches the
 * terms, the non-negotiable declaration, the Part 370 letter text or the
 * Notice of Assignment. The template is deliberately incapable of expressing
 * those edits rather than merely forbidden from making them.
 */

export interface TemplateResult {
  ok: boolean;
  error?: string;
}

function checkbox(formData: FormData, name: string): boolean | null {
  const raw = formData.get(name);
  if (raw === null) return null;
  return raw === 'on' || raw === 'true';
}

export async function saveTemplateAction(
  scopeInput: string,
  formData: FormData,
): Promise<TemplateResult> {
  let context;
  try {
    context = await requireCapability('settings.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const scope = templateScopeSchema.safeParse(scopeInput);
  if (!scope.success) return { ok: false, error: 'Unknown document.' };

  const parsed = templateFieldsSchema.safeParse({
    letterheadName: formData.get('letterheadName'),
    tagline: formData.get('tagline'),
    accentHex: formData.get('accentHex'),
    showLogo: checkbox(formData, 'showLogo'),
    footerNote: formData.get('footerNote'),
    addendum: formData.get('addendum'),
    remitToText: formData.get('remitToText'),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the values.' };
  }

  const { session, db } = context;
  await saveTemplate(db, scope.data, parsed.data);

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.templateChanged,
    subject: `organization:${session.orgId}`,
    detail: {
      scope: scope.data,
      // The values themselves are not recorded. An addendum can run to
      // paragraphs and the audit log is a hash chain, not a document store;
      // what matters on the record is who changed which document's template
      // and when.
      fields: Object.entries(parsed.data)
        .filter(([, value]) => value !== null)
        .map(([key]) => key),
    },
  });

  revalidatePath('/settings');
  return { ok: true };
}

/* -------------------------------------------------------------------------
 * The accessorial catalogue
 * ---------------------------------------------------------------------- */

export async function saveAccessorialAction(
  id: string | null,
  formData: FormData,
): Promise<TemplateResult> {
  let context;
  try {
    context = await requireCapability('settings.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const cents = parseMoney(String(formData.get('defaultRate') ?? ''));
  if (cents === null) {
    return { ok: false, error: 'Give the charge a rate, even if it is zero.' };
  }

  const parsed = accessorialRateSchema.safeParse({
    code: formData.get('code') ?? '',
    label: formData.get('label') ?? '',
    unit: formData.get('unit') ?? 'flat',
    defaultCents: cents,
    note: formData.get('note'),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the charge.' };
  }

  const { session, db } = context;
  const result = id ? await updateRate(db, id, parsed.data) : await createRate(db, parsed.data);
  if (!result.ok) return result;

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.templateChanged,
    subject: `organization:${session.orgId}`,
    detail: { accessorial: parsed.data.code, created: !id },
  });

  revalidatePath('/settings');
  return { ok: true };
}

export async function retireAccessorialAction(
  id: string,
  active: boolean,
): Promise<TemplateResult> {
  let context;
  try {
    context = await requireCapability('settings.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const result = await setRateActive(context.db, id, active);
  if (!result.ok) return result;

  revalidatePath('/settings');
  return { ok: true };
}
