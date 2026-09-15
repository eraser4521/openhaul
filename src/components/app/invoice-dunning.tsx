'use client';

import { useState } from 'react';
import { AlertCircle, BellOff, CalendarCheck, FileText, Info, Send } from 'lucide-react';
import {
  cancelPromiseAction,
  pauseDunningAction,
  recordPromiseAction,
  resumeDunningAction,
  sendNextNoticeAction,
} from '@/app/(app)/invoices/dunning-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { money, relativeTime } from '@/lib/utils/format';
import { HOLD_LABEL, describeLateness, type HoldReason } from '@/lib/invoices/dunning';
import {
  CHANNEL_LABEL,
  PROMISE_CHANNELS,
  STATE_LABEL,
  STATE_TONE,
  type PromiseState,
} from '@/lib/invoices/promise';

/**
 * Where this invoice sits on the ladder.
 *
 * Here rather than only in Settings because the person who knows the thing
 * the ladder does not — that they rang, that the cheque goes out Friday, that
 * the purchase order was wrong — is looking at the invoice when they learn
 * it. Without somewhere to put that, the only way to stop a notice going out
 * is to turn chasing off for everybody.
 */

export interface PromiseView {
  id: string;
  amountCents: number;
  promisedFor: string;
  madeAt: string;
  contactName: string | null;
  channel: string;
  notes: string | null;
  cancelReason: string | null;
  state: PromiseState;
  receivedCents: number;
  current: boolean;
}

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
  promises,
  balanceCents,
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
  promises: PromiseView[];
  /** What the invoice still owes, so a promise cannot exceed it. */
  balanceCents: number;
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
  const [promising, setPromising] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  // Nothing to say about an invoice nobody would ever chase.
  if (!enabled && notices.length === 0 && promises.length === 0) return null;

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

  const promiseIt = async (formData: FormData) => {
    setBusy(true);
    setError(null);
    setProblems([]);
    try {
      const result = await recordPromiseAction(invoiceId, formData);
      if (result.ok) setPromising(false);
      else {
        setError(result.error ?? 'That could not be recorded.');
        setProblems(result.problems ?? []);
      }
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (promiseId: string) => {
    const reason = window.prompt('Why is it being withdrawn? It stays on the record.');
    if (!reason?.trim()) return;

    setBusy(true);
    setError(null);
    try {
      const result = await cancelPromiseAction(invoiceId, promiseId, reason);
      if (!result.ok) setError(result.error ?? 'That could not be withdrawn.');
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

            {!promising && balanceCents > 0 && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setPromising(true)}
              >
                <CalendarCheck aria-hidden />
                They promised to pay
              </Button>
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
        <div
          role="alert"
          className="border-b border-line bg-danger-soft px-5 py-3 text-sm text-danger"
        >
          <p className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {error}
          </p>
          {problems.length > 0 && (
            <ul className="mt-1.5 ml-6 list-disc space-y-0.5 text-xs leading-relaxed">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {promising && (
        <form action={promiseIt} className="border-b border-line bg-surface px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-6">
            <div className="sm:col-span-2">
              <Input
                name="amount"
                label="How much"
                required
                inputMode="decimal"
                leading={<span className="text-sm">$</span>}
                defaultValue={(balanceCents / 100).toFixed(2)}
                hint={`${money(balanceCents)} is outstanding.`}
              />
            </div>

            <div className="sm:col-span-2">
              <Input
                name="promisedFor"
                label="By when"
                type="date"
                required
                defaultValue={today}
              />
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="channel" className="text-sm font-medium text-ink">
                How they said it
              </label>
              <select
                id="channel"
                name="channel"
                defaultValue="phone"
                className="mt-1.5 h-10 w-full rounded-lg border border-line bg-raised px-2 text-sm text-ink focus:border-brand focus:outline-none"
              >
                {PROMISE_CHANNELS.map((channel) => (
                  <option key={channel} value={channel}>
                    {CHANNEL_LABEL[channel]}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-3">
              <Input name="contactName" label="Who said it" placeholder="Renata Dowd" />
            </div>

            <div className="sm:col-span-3">
              <Input name="notes" label="Note" placeholder="Optional" />
            </div>
          </div>

          <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-ink-muted">
            <Info className="mt-px size-3.5 shrink-0" aria-hidden />
            Chasing stops until the day they named, and a few days after it for the post. If the
            money does not arrive, the next notice says what they told you and when — a fact,
            not a reproach. If it does, the promise closes itself and nothing more is sent.
          </p>

          <div className="mt-4 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPromising(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={busy}>
              Record it
            </Button>
          </div>
        </form>
      )}

      {promises.length > 0 && (
        <ul className="divide-y divide-line">
          {promises.map((promise) => (
            <li key={promise.id} className="flex flex-wrap items-start gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
                  {money(promise.amountCents)} by{' '}
                  {new Date(promise.promisedFor).toLocaleDateString('en-US', { timeZone: 'UTC' })}
                  <Badge tone={STATE_TONE[promise.state]} size="sm">
                    {STATE_LABEL[promise.state]}
                  </Badge>
                </p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {promise.contactName ? `${promise.contactName} · ` : ''}
                  {CHANNEL_LABEL[promise.channel as keyof typeof CHANNEL_LABEL] ??
                    promise.channel}{' '}
                  · said {relativeTime(new Date(promise.madeAt))}
                  {promise.receivedCents > 0 &&
                    ` · ${money(promise.receivedCents)} arrived since`}
                </p>
                {promise.notes && (
                  <p className="mt-0.5 text-xs text-ink-secondary">{promise.notes}</p>
                )}
                {promise.cancelReason && (
                  <p className="mt-0.5 text-xs text-ink-muted">
                    Withdrawn: {promise.cancelReason}
                  </p>
                )}
              </div>

              {canWrite && promise.current && promise.state === 'open' && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void withdraw(promise.id)}
                >
                  Withdraw
                </Button>
              )}
            </li>
          ))}
        </ul>
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
