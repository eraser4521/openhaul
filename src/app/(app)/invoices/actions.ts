'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { CREDIT_REASONS, PAYMENT_METHODS, PAYMENT_TERMS } from '@/lib/db/schema';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import { appendAudit, AUDIT } from '@/lib/audit/chain';
import { parseMoney, type Charges } from '@/lib/invoices/compute';
import {
  createInvoiceForLoad,
  issueInvoice,
  recordPayment,
  updateDraft,
  voidInvoice,
} from '@/lib/invoices/lifecycle';
import { raiseCreditNote, voidCreditNote } from '@/lib/invoices/credits';
import { buildCreditDocument } from '@/lib/invoices/credit-document';

export interface InvoiceActionResult {
  ok: boolean;
  error?: string;
  invoiceId?: string;
  /** Which figure the line haul was taken from, so nothing is billed silently. */
  basis?: 'tariff' | 'rate';
}

/* -------------------------------------------------------------------------
 * Raising
 * ---------------------------------------------------------------------- */

export async function createInvoiceAction(loadId: string): Promise<InvoiceActionResult> {
  let context;
  try {
    context = await requireCapability('invoice.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const { session, db } = context;
  const result = await createInvoiceForLoad(db, loadId);

  if (!result.ok) return { ok: false, error: result.error };

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.invoiceCreated,
    subject: `invoice:${result.invoiceId}`,
    detail: { number: result.number, loadId, basis: result.basis },
  });

  revalidatePath(`/loads/${loadId}`);
  revalidatePath('/invoices');

  return { ok: true, invoiceId: result.invoiceId, basis: result.basis };
}

/* -------------------------------------------------------------------------
 * Editing a draft
 * ---------------------------------------------------------------------- */

const draftSchema = z.object({
  lineHaul: z.string().optional(),
  fuelSurcharge: z.string().optional(),
  accessorial: z.string().optional(),
  tax: z.string().optional(),
  codCollected: z.string().optional(),
  deposit: z.string().optional(),
  terms: z.enum(PAYMENT_TERMS).nullable(),
  factoringCompanyName: z.string().trim().max(160).optional(),
  factoringNoticeText: z.string().trim().max(2000).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export async function saveDraftAction(
  invoiceId: string,
  formData: FormData,
): Promise<InvoiceActionResult> {
  let context;
  try {
    context = await requireCapability('invoice.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const termsValue = formData.get('terms');
  const parsed = draftSchema.safeParse({
    lineHaul: formData.get('lineHaul') ?? undefined,
    fuelSurcharge: formData.get('fuelSurcharge') ?? undefined,
    accessorial: formData.get('accessorial') ?? undefined,
    tax: formData.get('tax') ?? undefined,
    codCollected: formData.get('codCollected') ?? undefined,
    deposit: formData.get('deposit') ?? undefined,
    terms: typeof termsValue === 'string' && termsValue !== '' ? termsValue : null,
    factoringCompanyName: formData.get('factoringCompanyName') ?? undefined,
    factoringNoticeText: formData.get('factoringNoticeText') ?? undefined,
    notes: formData.get('notes') ?? undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the figures.' };
  }

  // An amount that will not parse is rejected rather than silently zeroed: a
  // fat-fingered line haul quietly becoming $0.00 is how a load gets invoiced
  // for nothing.
  const amounts: Array<[keyof Charges, string | undefined]> = [
    ['lineHaulCents', parsed.data.lineHaul],
    ['fuelSurchargeCents', parsed.data.fuelSurcharge],
    ['accessorialCents', parsed.data.accessorial],
    ['taxCents', parsed.data.tax],
    ['codCollectedCents', parsed.data.codCollected],
    ['depositCents', parsed.data.deposit],
  ];

  const charges: Charges = {
    lineHaulCents: 0,
    fuelSurchargeCents: 0,
    accessorialCents: 0,
    taxCents: 0,
    codCollectedCents: 0,
    depositCents: 0,
  };

  for (const [field, raw] of amounts) {
    if (raw === undefined || raw.trim() === '') continue;
    const cents = parseMoney(raw);
    if (cents === null) {
      return { ok: false, error: `“${raw}” is not an amount. Enter a figure like 2940.00.` };
    }
    charges[field] = cents;
  }

  const result = await updateDraft(context.db, invoiceId, {
    charges,
    terms: parsed.data.terms,
    factoringCompanyName: parsed.data.factoringCompanyName || null,
    factoringNoticeText: parsed.data.factoringNoticeText || null,
    notes: parsed.data.notes || null,
  });

  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/invoices');

  return { ok: true, invoiceId };
}

/* -------------------------------------------------------------------------
 * Issuing
 * ---------------------------------------------------------------------- */

export async function issueInvoiceAction(invoiceId: string): Promise<InvoiceActionResult> {
  let context;
  try {
    context = await requireCapability('invoice.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const { session, db } = context;
  const result = await issueInvoice(db, invoiceId);

  if (!result.ok) return { ok: false, error: result.error };

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    // Logged as an invoice event rather than a document one: freezing the PDF
    // is part of issuing, and somebody asking when a customer was billed
    // should find it under the invoice's own history.
    action: AUDIT.invoiceIssued,
    subject: `invoice:${invoiceId}`,
    detail: { number: result.number, documentId: result.documentId, sha256: result.sha256 },
  });

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/invoices');
  revalidatePath('/documents');
  revalidatePath('/dashboard');

  return { ok: true, invoiceId };
}

/* -------------------------------------------------------------------------
 * Payments
 * ---------------------------------------------------------------------- */

const paymentSchema = z.object({
  amount: z.string().trim().min(1, 'Enter the amount received.'),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().max(80).optional(),
  receivedAt: z.string().trim().optional(),
  notes: z.string().trim().max(500).optional(),
});

export async function recordPaymentAction(
  invoiceId: string,
  formData: FormData,
): Promise<InvoiceActionResult> {
  let context;
  try {
    context = await requireCapability('payment.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const parsed = paymentSchema.safeParse({
    amount: formData.get('amount') ?? '',
    method: formData.get('method') ?? 'ach',
    reference: formData.get('reference') ?? undefined,
    receivedAt: formData.get('receivedAt') ?? undefined,
    notes: formData.get('notes') ?? undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the payment details.' };
  }

  const amountCents = parseMoney(parsed.data.amount);
  if (amountCents === null) {
    return { ok: false, error: `“${parsed.data.amount}” is not an amount.` };
  }

  const received = parsed.data.receivedAt ? new Date(`${parsed.data.receivedAt}T12:00:00Z`) : new Date();
  if (Number.isNaN(received.getTime())) {
    return { ok: false, error: 'That is not a date.' };
  }

  const { session, db } = context;
  const result = await recordPayment(db, invoiceId, {
    amountCents,
    method: parsed.data.method,
    reference: parsed.data.reference || null,
    receivedAt: received,
    notes: parsed.data.notes || null,
  });

  if (!result.ok) return { ok: false, error: result.error };

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.paymentRecorded,
    subject: `invoice:${invoiceId}`,
    detail: {
      amountCents,
      method: parsed.data.method,
      reference: parsed.data.reference ?? null,
      paidCents: result.paidCents,
      balanceCents: result.balanceCents,
    },
  });

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/invoices');
  revalidatePath('/dashboard');

  return { ok: true, invoiceId };
}

/* -------------------------------------------------------------------------
 * Voiding
 * ---------------------------------------------------------------------- */

export async function voidInvoiceAction(
  invoiceId: string,
  formData: FormData,
): Promise<InvoiceActionResult> {
  let context;
  try {
    context = await requireCapability('invoice.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const reason = String(formData.get('reason') ?? '').slice(0, 500);
  const { session, db } = context;

  const result = await voidInvoice(db, invoiceId, reason);
  if (!result.ok) return { ok: false, error: result.error };

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.invoiceVoided,
    subject: `invoice:${invoiceId}`,
    detail: { reason: reason.trim() },
  });

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/invoices');

  return { ok: true, invoiceId };
}

/* -------------------------------------------------------------------------
 * Credit notes
 * ---------------------------------------------------------------------- */

const creditSchema = z.object({
  reason: z.enum(CREDIT_REASONS),
  detail: z.string().trim().min(1, 'Say what is being credited and why.').max(1000),
  amount: z.string().trim().min(1, 'Enter the amount to credit.'),
  claimId: z.string().trim().min(1).nullable(),
});

/**
 * Raises a credit against an issued invoice.
 *
 * Audited as its own action rather than folded into the invoice's history: a
 * credit is somebody deciding not to collect money that was claimed, which is
 * exactly the decision an audit asks about later.
 */
export async function raiseCreditAction(
  invoiceId: string,
  formData: FormData,
): Promise<InvoiceActionResult> {
  let context;
  try {
    context = await requireCapability('invoice.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const claimId = formData.get('claimId');

  const parsed = creditSchema.safeParse({
    reason: formData.get('reason') ?? 'other',
    detail: formData.get('detail') ?? '',
    amount: formData.get('amount') ?? '',
    claimId: typeof claimId === 'string' && claimId !== '' ? claimId : null,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the credit.' };
  }

  const amountCents = parseMoney(parsed.data.amount);
  if (amountCents === null) {
    return { ok: false, error: `“${parsed.data.amount}” is not an amount.` };
  }

  const { session, db } = context;

  const result = await raiseCreditNote(db, {
    invoiceId,
    reason: parsed.data.reason,
    detail: parsed.data.detail,
    amountCents,
    claimId: parsed.data.claimId,
  });

  if (!result.ok) return { ok: false, error: result.error };

  const document = await buildCreditDocument(db, result.creditNoteId!);
  if (!document.ok) return { ok: false, error: document.error };

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.creditNoteRaised,
    subject: `credit_note:${result.creditNoteId}`,
    detail: {
      number: result.number,
      invoiceId,
      amountCents,
      reason: parsed.data.reason,
      claimId: parsed.data.claimId,
      balanceCents: result.balanceCents,
      documentId: document.documentId,
      sha256: document.sha256,
    },
  });

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/invoices');
  revalidatePath('/documents');

  return { ok: true, invoiceId };
}

export async function voidCreditAction(
  invoiceId: string,
  creditNoteId: string,
  formData: FormData,
): Promise<InvoiceActionResult> {
  let context;
  try {
    context = await requireCapability('invoice.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const reason = String(formData.get('reason') ?? '').slice(0, 500);
  const { session, db } = context;

  const result = await voidCreditNote(db, creditNoteId, reason);
  if (!result.ok) return { ok: false, error: result.error };

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.creditNoteVoided,
    subject: `credit_note:${creditNoteId}`,
    detail: { invoiceId, reason: reason.trim() },
  });

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath('/invoices');

  return { ok: true, invoiceId };
}
