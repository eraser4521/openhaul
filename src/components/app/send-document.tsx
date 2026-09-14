'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import { AlertCircle, Check, Info, Mail, Send } from 'lucide-react';
import {
  draftForAction,
  sendDocumentAction,
  type SendActionResult,
} from '@/app/(app)/documents/actions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { relativeTime } from '@/lib/utils/format';
import { explainStatus } from '@/lib/email/dsn';

/**
 * Emailing a document.
 *
 * The panel is deliberately blunt about what pressing send establishes. A
 * carrier who reads "Sent" as proof the broker received their invoice, or that
 * a claimant got an acknowledgement inside thirty days, will rely on it in an
 * argument and be wrong. What this can honestly report is that the mail server
 * took the message.
 */

export interface SendRecord {
  id: string;
  to: string[];
  cc: string[] | null;
  subject: string;
  status: string;
  error: string | null;
  attemptedAt: Date;
  bouncedAt: Date | null;
  bounceType: string | null;
  bounceCode: string | null;
  bounceRecipient: string | null;
  bounceDiagnostic: string | null;
}

export interface SendDocumentProps {
  documentId: string;
  documentTitle: string;
  sends: SendRecord[];
  /** False when SMTP_HOST and SMTP_FROM are unset. */
  configured: boolean;
  canSend: boolean;
}

export function SendDocument({
  documentId,
  documentTitle,
  sends,
  configured,
  canSend,
}: SendDocumentProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SendActionResult | null>(null);
  const [draft, setDraft] = useState<{
    to: string;
    subject: string;
    body: string;
    recipientLabel: string | null;
  } | null>(null);

  const openPanel = async () => {
    setOpen(true);
    setResult(null);
    setLoading(true);
    try {
      const prepared = await draftForAction(documentId);
      setDraft({
        to: prepared?.to.join(', ') ?? '',
        subject: prepared?.subject ?? documentTitle,
        body: prepared?.body ?? '',
        recipientLabel: prepared?.recipientLabel ?? null,
      });
    } catch {
      setDraft({ to: '', subject: documentTitle, body: '', recipientLabel: null });
    } finally {
      setLoading(false);
    }
  };

  const submit = async (formData: FormData) => {
    setBusy(true);
    setResult(null);
    try {
      const outcome = await sendDocumentAction(documentId, formData);
      setResult(outcome);
      if (outcome.ok) setOpen(false);
    } catch {
      setResult({ ok: false, error: 'That did not go through. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  const lastSent = sends.find((send) => send.status === 'sent');
  const bounced = sends.find((send) => send.status === 'bounced');
  // A delay notice is worth showing but is not a failure: the receiving server
  // is still trying, and calling it one would have somebody re-sending.
  const delayed = sends.find((send) => send.bounceType === 'transient' && send.status !== 'bounced');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {canSend && !open && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void openPanel()}
            disabled={!configured}
          >
            <Mail aria-hidden />
            {lastSent ? 'Send again' : 'Send'}
          </Button>
        )}

        {lastSent && !bounced && (
          <p className="text-xs text-ink-muted">
            Last handed to the mail server {relativeTime(lastSent.attemptedAt)} for{' '}
            {lastSent.to.join(', ')}
          </p>
        )}
      </div>

      {bounced && (
        <div className="rounded-lg bg-danger-soft px-3 py-2.5">
          <p className="flex items-start gap-2 text-sm text-danger">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            This came back undelivered
            {bounced.bounceRecipient ? ` from ${bounced.bounceRecipient}` : ''}
            {bounced.bouncedAt ? `, ${relativeTime(bounced.bouncedAt)}` : ''}.
          </p>
          <p className="mt-1 pl-6 text-xs leading-relaxed text-ink-secondary">
            {explainStatus(bounced.bounceCode, 'permanent')}
            {bounced.bounceCode ? ` (${bounced.bounceCode})` : ''}
          </p>
          {bounced.bounceDiagnostic && (
            <p className="mt-1 pl-6 font-mono text-[0.6875rem] break-words text-ink-muted">
              {bounced.bounceDiagnostic}
            </p>
          )}
        </div>
      )}

      {!bounced && delayed && (
        <p className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2.5 text-xs leading-relaxed text-warn">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden />
          Delivery is delayed{delayed.bounceCode ? ` (${delayed.bounceCode})` : ''}. The receiving
          server is still trying — nothing to do yet.
        </p>
      )}

      {!configured && canSend && (
        <p className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2.5 text-xs leading-relaxed text-warn">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden />
          No mail server is configured, so sending is off. Set <code className="font-mono">SMTP_HOST</code>{' '}
          and <code className="font-mono">SMTP_FROM</code> — any mailbox you already have will do.
          Documents can still be downloaded and sent by hand.
        </p>
      )}

      {result && !result.ok && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm leading-relaxed text-danger"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {result.error}
        </p>
      )}

      {result?.ok && (
        <div className="rounded-lg bg-ok-soft px-3 py-2.5">
          <p className="flex items-start gap-2 text-sm text-ok">
            <Check className="mt-0.5 size-4 shrink-0" aria-hidden />
            Handed to the mail server for {result.accepted?.join(', ')}.
          </p>
          <p className="mt-1 pl-6 text-xs leading-relaxed text-ink-secondary">
            That means it was accepted for delivery, not that it arrived or was read. If the date
            matters, keep your own proof of sending.
          </p>
          {result.rejected && result.rejected.length > 0 && (
            <p className="mt-1 pl-6 text-xs text-warn">
              Refused for {result.rejected.join(', ')}.
            </p>
          )}
        </div>
      )}

      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <Card>
            <div className="border-b border-line px-5 py-4">
              <h3 className="text-sm font-semibold text-ink">Send {documentTitle}</h3>
              <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
                The PDF is attached and checked against its hash before it goes. Plain text, no
                tracking.
              </p>
            </div>

            {loading ? (
              <p className="px-5 py-8 text-center text-xs text-ink-muted">Preparing the email…</p>
            ) : (
              <form action={submit}>
                <div className="grid gap-4 p-5">
                  <Input
                    name="to"
                    label="To"
                    required
                    defaultValue={draft?.to ?? ''}
                    placeholder="ap@example.com"
                    hint={
                      draft?.recipientLabel
                        ? `From ${draft.recipientLabel}'s record. Separate several with commas.`
                        : 'Separate several with commas.'
                    }
                  />

                  <Input name="cc" label="Cc" placeholder="Optional" />

                  <Input name="subject" label="Subject" required defaultValue={draft?.subject ?? ''} />

                  <div>
                    <label htmlFor="body" className="text-sm font-medium text-ink">
                      Message
                    </label>
                    <textarea
                      id="body"
                      name="body"
                      rows={10}
                      required
                      defaultValue={draft?.body ?? ''}
                      className="mt-2 w-full rounded-lg border border-line bg-raised px-3 py-2.5 font-mono text-xs leading-relaxed text-ink focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
                    />
                    <p className="mt-1.5 text-xs text-ink-muted">
                      Edit anything. The draft is a starting point, not a template.
                    </p>
                  </div>
                </div>

                <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
                  <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                    Cancel
                  </Button>
                  <Button type="submit" loading={busy}>
                    <Send aria-hidden />
                    Send it
                  </Button>
                </div>
              </form>
            )}
          </Card>
        </motion.div>
      )}

      {sends.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-ink-muted hover:text-ink">
            {sends.length} send attempt{sends.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-2 space-y-1.5 border-l border-line pl-3">
            {sends.map((send) => (
              <li key={send.id}>
                <p
                  className={
                    send.status === 'sent'
                      ? 'text-ink-secondary'
                      : send.status === 'bounced'
                        ? 'text-danger'
                        : 'text-warn'
                  }
                >
                  {send.status === 'sent'
                    ? 'Accepted'
                    : send.status === 'bounced'
                      ? 'Bounced'
                      : 'Failed'}{' '}
                  {relativeTime(send.attemptedAt)} · {send.to.join(', ')}
                  {send.cc?.length ? ` (cc ${send.cc.join(', ')})` : ''}
                </p>
                {send.error && <p className="text-ink-muted">{send.error}</p>}
                {send.bounceDiagnostic && (
                  <p className="text-ink-muted">{send.bounceDiagnostic}</p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
