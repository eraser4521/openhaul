'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import { appendAudit, AUDIT } from '@/lib/audit/chain';
import { draftFor, sendDocument, type SendDraft } from '@/lib/documents/send';
import { looksLikeEmail, parseAddresses } from '@/lib/email/compose';
import { verifyConnection } from '@/lib/email/transport';
import { verifyInbox, inboxConfigured } from '@/lib/email/inbox';
import { checkBounces, type BounceCheckResult } from '@/lib/documents/bounces';

export interface SendActionResult {
  ok: boolean;
  error?: string;
  /** Addresses the mail server took. Not addresses that received anything. */
  accepted?: string[];
  /** Taken by the server for the message but refused for these recipients. */
  rejected?: string[];
}

const sendSchema = z.object({
  to: z.string().trim().min(1, 'Enter at least one recipient.'),
  cc: z.string().trim().optional(),
  subject: z.string().trim().min(1, 'The email needs a subject.').max(200),
  body: z.string().trim().min(1, 'The email needs a message.').max(10_000),
});

/**
 * Emails a stored document.
 *
 * Audited because the fact that a document went out, to whom, and when is
 * frequently the thing somebody needs to establish later — particularly for a
 * claim acknowledgement, where the date decides whether a statutory deadline
 * was met.
 */
export async function sendDocumentAction(
  documentId: string,
  formData: FormData,
): Promise<SendActionResult> {
  let context;
  try {
    // Sending a document is disclosing it outside the organisation, so it
    // takes the capability that governs the records themselves.
    context = await requireCapability('load.read');
  } catch (error) {
    return authErrorToResult(error);
  }

  const parsed = sendSchema.safeParse({
    to: formData.get('to') ?? '',
    cc: formData.get('cc') ?? undefined,
    subject: formData.get('subject') ?? '',
    body: formData.get('body') ?? '',
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the email.' };
  }

  const to = parseAddresses(parsed.data.to);
  const cc = parseAddresses(parsed.data.cc ?? '');

  const bad = [...to, ...cc].filter((address) => !looksLikeEmail(address));
  if (bad.length > 0) {
    return {
      ok: false,
      error: `${bad.join(', ')} ${bad.length === 1 ? 'does' : 'do'} not look like an email address.`,
    };
  }

  const { session, db } = context;

  const result = await sendDocument(db, {
    documentId,
    to,
    cc,
    subject: parsed.data.subject,
    body: parsed.data.body,
    actorId: session.userId,
  });

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.documentSent,
    subject: `document:${documentId}`,
    outcome: result.ok ? 'success' : 'failure',
    detail: {
      to,
      cc: cc.length > 0 ? cc : undefined,
      subject: parsed.data.subject,
      messageId: result.messageId,
      error: result.error,
    },
  });

  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath('/documents');

  return { ok: true, accepted: result.accepted, rejected: result.rejected };
}

/** The prefilled email for a document, fetched when the panel opens. */
export async function draftForAction(documentId: string): Promise<SendDraft | null> {
  try {
    const { db } = await requireCapability('load.read');
    return await draftFor(db, documentId);
  } catch {
    return null;
  }
}

export interface MailCheckResult {
  ok: boolean;
  message: string;
}

/**
 * Tests the mail settings without sending anything.
 *
 * Worth its own button: SMTP misconfiguration otherwise surfaces on the day
 * somebody is trying to get a delivery receipt to a broker, which is the worst
 * possible moment to discover the port is wrong.
 */
export async function verifyMailAction(): Promise<MailCheckResult> {
  try {
    await requireCapability('settings.write');
  } catch {
    return { ok: false, message: 'Only an owner can test the mail settings.' };
  }

  const result = await verifyConnection();

  return result.ok
    ? { ok: true, message: 'The mail server accepted the connection and the credentials.' }
    : { ok: false, message: result.error ?? 'The mail server could not be reached.' };
}

/* -------------------------------------------------------------------------
 * Bounces
 * ---------------------------------------------------------------------- */

/**
 * Reads the bounce mailbox and updates whatever it can identify.
 *
 * A poll, because plain SMTP has no webhook to subscribe to. Safe to run as
 * often as you like — matching is idempotent, so a message examined twice
 * produces the same result.
 */
export async function checkBouncesAction(): Promise<BounceCheckResult> {
  let context;
  try {
    context = await requireCapability('load.read');
  } catch {
    return {
      ok: false,
      error: 'Your role cannot check for bounces.',
      examined: 0,
      reports: 0,
      matched: 0,
      permanent: 0,
      transient: 0,
      unmatched: 0,
    };
  }

  const { session, db } = context;
  const result = await checkBounces(db);

  // Only worth an audit entry when something actually came back; a check that
  // found nothing is noise in a record somebody has to read.
  if (result.ok && result.matched > 0) {
    await appendAudit({
      orgId: session.orgId,
      actorId: session.userId,
      actorRole: session.role,
      action: AUDIT.bouncesChecked,
      subject: `organization:${session.orgId}`,
      detail: {
        examined: result.examined,
        matched: result.matched,
        permanent: result.permanent,
        transient: result.transient,
      },
    });
  }

  if (result.ok) revalidatePath('/documents');
  return result;
}

export async function verifyInboxAction(): Promise<MailCheckResult> {
  try {
    await requireCapability('settings.write');
  } catch {
    return { ok: false, message: 'Only an owner can test the bounce mailbox.' };
  }

  if (!inboxConfigured()) {
    return {
      ok: false,
      message: 'No bounce mailbox is configured. Set IMAP_HOST to check for bounces.',
    };
  }

  const result = await verifyInbox();

  return result.ok
    ? { ok: true, message: 'The mailbox opened and the credentials were accepted.' }
    : { ok: false, message: result.error ?? 'The mailbox could not be reached.' };
}
