'use client';

import { useState } from 'react';
import { AlertCircle, Check, Mail } from 'lucide-react';
import { verifyMailAction } from '@/app/(app)/documents/actions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/**
 * Testing the mail settings without sending anything.
 *
 * On its own button because SMTP misconfiguration otherwise surfaces on the
 * day somebody is trying to get a delivery receipt to a broker, which is the
 * worst possible moment to find out the port is wrong.
 */
export function MailCheck({ configured }: { configured: boolean }) {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await verifyMailAction());
    } catch {
      setResult({ ok: false, message: 'The check did not run. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="border-b border-line px-5 py-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Mail className="size-4 text-ink-muted" aria-hidden />
          Sending documents
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
          Documents are emailed through your own mail server over SMTP — any mailbox you already
          have works, and there is nothing to subscribe to.
        </p>
      </div>

      <div className="space-y-3 p-5">
        {configured ? (
          <p className="flex items-start gap-2 text-sm text-ink-secondary">
            <Check className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
            A mail server is configured.
          </p>
        ) : (
          <p className="flex items-start gap-2 text-sm leading-relaxed text-warn">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            No mail server configured. Set <code className="font-mono">SMTP_HOST</code> and{' '}
            <code className="font-mono">SMTP_FROM</code> to turn sending on. Until then documents
            can be downloaded and sent by hand.
          </p>
        )}

        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void check()}
          loading={busy}
          disabled={!configured || busy}
        >
          Test the connection
        </Button>

        {result && (
          <p
            className={
              'flex items-start gap-2 text-xs leading-relaxed ' +
              (result.ok ? 'text-ok' : 'text-danger')
            }
          >
            {result.ok ? (
              <Check className="mt-px size-3.5 shrink-0" aria-hidden />
            ) : (
              <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden />
            )}
            {result.message}
          </p>
        )}

        <p className="border-t border-line pt-3 text-xs leading-relaxed text-ink-muted">
          Sending records that your mail server accepted a message. It cannot record that anyone
          received or read it, and nothing here tracks opens. Where a date matters — a claim
          acknowledgement inside thirty days, say — keep your own proof of sending.
        </p>
      </div>
    </Card>
  );
}
