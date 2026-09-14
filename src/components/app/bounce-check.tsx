'use client';

import { useState } from 'react';
import { AlertCircle, Check, Info, MailWarning } from 'lucide-react';
import { checkBouncesAction } from '@/app/(app)/documents/actions';
import type { BounceCheckResult } from '@/lib/documents/bounces';
import { Button } from '@/components/ui/button';

/**
 * Looking for returned mail.
 *
 * A button rather than a background job, because this application has no
 * daemon and a one-person carrier should be able to run it with `npm start`.
 * A cron line can hit the same check at /api/bounces/check for anyone who
 * wants it unattended.
 */
export function BounceCheck({ configured }: { configured: boolean }) {
  const [result, setResult] = useState<BounceCheckResult | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await checkBouncesAction());
    } catch {
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  if (!configured) {
    return (
      <p className="flex items-start gap-2 rounded-lg border border-dashed border-line px-3 py-2.5 text-xs leading-relaxed text-ink-muted">
        <Info className="mt-px size-3.5 shrink-0" aria-hidden />
        Bounce checking is off. Set <code className="font-mono">IMAP_HOST</code> to let OpenHaul
        read returned mail back out of your mailbox — without it, a document that failed downstream
        goes on reading as accepted.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void check()}
          loading={busy}
          disabled={busy}
        >
          <MailWarning aria-hidden />
          Check for bounces
        </Button>

        {result?.ok && (
          <p
            className={
              'flex items-center gap-1.5 text-xs ' +
              (result.permanent > 0 ? 'text-danger' : 'text-ink-muted')
            }
          >
            {result.permanent > 0 ? (
              <AlertCircle className="size-3.5 shrink-0" aria-hidden />
            ) : (
              <Check className="size-3.5 shrink-0" aria-hidden />
            )}
            {result.examined === 0
              ? 'Nothing new in the mailbox.'
              : `${result.examined} message${result.examined === 1 ? '' : 's'} read · ` +
                `${result.permanent} bounced · ${result.transient} delayed` +
                (result.unmatched > 0 ? ` · ${result.unmatched} not ours` : '')}
          </p>
        )}
      </div>

      {result && !result.ok && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-xs leading-relaxed text-danger"
        >
          <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden />
          {result.error}
        </p>
      )}

      <p className="text-xs leading-relaxed text-ink-muted">
        This finds the failures that come back as a delivery notice. A message quietly dropped, or
        filed as spam, produces nothing to find — so a send with no bounce against it is not proof
        it was read.
      </p>
    </div>
  );
}
