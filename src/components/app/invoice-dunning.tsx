'use client';

import { useState } from 'react';
import { AlertCircle, BellOff, FileText, Info, Send } from 'lucide-react';
import {
  pauseDunningAction,
  resumeDunningAction,
  sendNextNoticeAction,
} from '@/app/(app)/invoices/dunning-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { money, relativeTime } from '@/lib/utils/format';
import { HOLD_LABEL, describeLateness, type HoldReason } from '@/lib/invoices/dunning';

/**
 * Where this invoice sits on the ladder.
 *
 * Here rather than only in Settings because the person who knows the thing
 * the ladder does not — that they rang, that the cheque goes out Friday, that
 * the purchase order was wrong — is looking at the invoice when they learn
 * it. Without somewhere to put that, the only way to stop a notice going out
 * is to turn chasing off for everybody.
 */

export interface NoticeView {
  id: string;
  stageLabel: string;
  stageSequence: number;
  outcome: string;
  detail: string | null;
  sentAt: string;
  documentId: string | null;
  balanceCents: number;
  daysPastDue: number;
}

export function InvoiceDunning({
  invoiceId,
  enabled,
  notices,
  daysPastDue,
  chase,
  reason,
  nextStageLabel,
  nextStageSequence,
  pausedUntil,
  pauseReason,
  canWrite,
  today,
}: {
  invoiceId: string;
  /** Whether the organisation chases anything at all. */
  enabled: boolean;
  notices: NoticeView[];
  daysPastDue: number;
  /** Whether a notice would go today. */
  chase: boolean;
  reason: HoldReason | null;
  nextStageLabel: string | null;
  nextStageSequence: number | null;
  pausedUntil: string | null;
  pauseReason: string | null;
  canWrite: boolean;
  today: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Nothing to say about an invoice nobody would ever chase.
  if (!enabled && notices.length === 0) return null;

  const pause = async (formData: FormData) => {
    setBusy(true);
    setError(null);
    try {
      const result = await pauseDunningAction(invoiceId, formData);
      if (result.ok) setOpen(false);
      else setError(result.error ?? 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const act = async (run: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await run();
      if (!result.ok) setError(result.error ?? 'That did not go through.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <BellOff className="size-4 text-ink-muted" aria-hidden />
            Chasing
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
            {pausedUntil
              ? `Left alone until ${pausedUntil}${pauseReason ? ` — ${pauseReason}` : ''}.`
              : chase && nextStageLabel
                ? `${describeLateness(daysPastDue)}. "${nextStageLabel}" would go out on the next sweep.`
                : reason
                  ? HOLD_LABEL[reason]
                  : describeLateness(daysPastDue)}
          </p>
        </div>

        {canWrite && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {pausedUntil ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void act(() => resumeDunningAction(invoiceId))}
              >
                Start chasing again
              </Button>
            ) : (
              !open && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setOpen(true)}
                >
                  Leave it alone
                </Button>
              )
            )}

            {chase && nextStageSequence !== null && !pausedUntil && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={busy}
                onClick={() =>
                  void act(() => sendNextNoticeAction(invoiceId, nextStageSequence))
                }
              >
                <Send aria-hidden />
                Send it now
              </Button>
            )}
          </div>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 border-b border-line bg-danger-soft px-5 py-3 text-sm text-danger"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}

      {open && (
        <form action={pause} className="border-b border-line bg-surface px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-6">
            <div className="sm:col-span-2">
              <Input name="until" label="Until" type="date" required defaultValue={today} />
            </div>
            <div className="sm:col-span-4">
              <Input
                name="reason"
                label="Why"
                required
                placeholder="They rang — cheque goes out Friday"
              />
            </div>
          </div>

          <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-ink-muted">
            <Info className="mt-px size-3.5 shrink-0" aria-hidden />
            The reason stays on the record. &ldquo;Why did nobody chase this for a month&rdquo;
            deserves an answer better than that somebody clicked something.
          </p>

          <div className="mt-4 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={busy}>
              Leave it alone
            </Button>
          </div>
        </form>
      )}

      {notices.length > 0 && (
        <ul className="divide-y divide-line">
          {notices.map((notice) => (
            <li key={notice.id} className="flex flex-wrap items-start gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
                  {notice.stageLabel}
                  <Badge tone={notice.outcome === 'sent' ? 'ok' : 'danger'} size="sm">
                    {notice.outcome === 'sent' ? 'Sent' : 'Failed'}
                  </Badge>
                </p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {relativeTime(new Date(notice.sentAt))} · {money(notice.balanceCents)} owing ·{' '}
                  {describeLateness(notice.daysPastDue)}
                </p>
                {notice.detail && (
                  <p className="mt-0.5 text-xs text-danger">{notice.detail}</p>
                )}
              </div>

              {notice.documentId && (
                <a
                  href={`/api/documents/${notice.documentId}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs text-ink-secondary transition-colors hover:border-line-strong hover:text-ink"
                >
                  <FileText className="size-3.5" aria-hidden />
                  View
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
