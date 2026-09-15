'use client';

import { useState } from 'react';
import { AlertCircle, AlertTriangle, BellRing, Check, Send } from 'lucide-react';
import { saveAlertSettingsAction, sweepAlertsAction } from '@/app/(app)/money/cash-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { money } from '@/lib/utils/format';
import { REASON_LABEL, SILENCE_LABEL, type AlertSilence } from '@/lib/cash/alert';
import type { AlertKind, AlertReason } from '@/lib/db/schema';

/**
 * The one thing this application will interrupt somebody about.
 *
 * Everything else it produces waits to be looked at. This does not, which is
 * why the screen leads with exactly what would be sent if the sweep ran now —
 * including, most of the time, nothing. A carrier deciding whether to switch
 * this on is really deciding whether to trust it in their pocket, and the
 * honest way to earn that is to show how rarely it speaks.
 */

export interface AlertPreview {
  send: boolean;
  /** Why it would stay quiet, when it would. */
  why: AlertSilence | null;
  kind: AlertKind | null;
  reason: AlertReason | null;
  shortfallCents: number | null;
  week: string | null;
}

export interface SentAlert {
  id: string;
  kind: AlertKind;
  reason: AlertReason;
  outcome: 'sent' | 'failed';
  detail: string | null;
  sentAt: string;
  recipients: string;
  shortfallCents: number | null;
}

/**
 * When a message went out, to the minute, in UTC.
 *
 * Not a relative time. `relativeTime` counts in seconds for anything under a
 * minute, so a row rendered on the server as "4s ago" and hydrated a moment
 * later as "6s ago" is a hydration mismatch — and these rows are read most
 * often in the seconds right after somebody presses the button. A fixed stamp
 * is also the more useful thing here: it is what a reader matches against the
 * message sitting in their inbox.
 */
function sentText(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });
}

export function CashAlerts({
  enabled,
  recipients,
  fallbackTo,
  minimumGapDays,
  preview,
  history,
  mailReady,
  triggerReady,
  canEdit,
}: {
  enabled: boolean;
  recipients: string | null;
  /** The organisation address used when nothing is typed. */
  fallbackTo: string | null;
  minimumGapDays: number;
  preview: AlertPreview;
  history: SentAlert[];
  mailReady: boolean;
  triggerReady: boolean;
  canEdit: boolean;
}) {
  const [on, setOn] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const save = async (formData: FormData) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await saveAlertSettingsAction(formData);
      if (result.ok) setNote('Saved');
      else setError(result.error ?? 'That could not be saved.');
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const sweep = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await sweepAlertsAction();
      if (result.ok) setNote(result.detail ?? 'Done.');
      else setError(result.error ?? 'That could not be run.');
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="border-b border-line px-5 py-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <BellRing className="size-4 text-ink-muted" aria-hidden />
          Cash warnings
        </h2>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-secondary">
          The cash timeline can name the week the account goes under, which is worth nothing to
          somebody who is driving. This sends that one fact and nothing else — not a weekly summary,
          not the ordinary case where only the promised money falls short, and never the same
          warning twice unless something about it has changed.
        </p>
      </div>

      {!mailReady && (
        <p className="flex items-start gap-2 border-b border-line bg-warn-soft px-5 py-3 text-xs leading-relaxed text-warn">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          No mail server is configured, so nothing can be sent.
        </p>
      )}

      {on && !triggerReady && (
        <p className="flex items-start gap-2 border-b border-line bg-warn-soft px-5 py-3 text-xs leading-relaxed text-warn">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          Nothing outside is able to start a sweep, so this will only run when somebody presses the
          button below. Set <code className="font-mono">CASH_ALERT_TOKEN</code> and add the cron
          line from SELF_HOSTING.md.
        </p>
      )}

      {/* --- What would happen right now ------------------------------- */}

      <div className="border-b border-line px-5 py-4">
        <p className="text-xs text-ink-muted">If the sweep ran now</p>

        {preview.send ? (
          <>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink">
              <Badge tone={preview.kind === 'all_clear' ? 'ok' : 'danger'} size="sm">
                {preview.kind === 'all_clear' ? 'All clear' : 'Warning'}
              </Badge>
              {preview.kind === 'all_clear'
                ? 'The account is no longer projected to go under.'
                : `Short ${preview.shortfallCents !== null ? money(preview.shortfallCents) : ''} in the week of ${preview.week}.`}
            </p>
            {preview.reason && (
              <p className="mt-0.5 text-xs text-ink-muted">{REASON_LABEL[preview.reason]}</p>
            )}
          </>
        ) : (
          <p className="mt-1 text-sm text-ink-secondary">
            {preview.why ? SILENCE_LABEL[preview.why] : 'Nothing would be sent.'}
          </p>
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

      <form action={save} className="px-5 py-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            name="enabled"
            checked={on}
            disabled={!canEdit}
            onChange={(event) => setOn(event.target.checked)}
            className="mt-0.5 size-4 rounded border-line accent-[var(--brand)]"
          />
          <span className="text-sm text-ink">
            Send a warning when the account is projected to go under
            <span className="block text-xs leading-relaxed text-ink-muted">
              Counting every promise kept and every invoice paid exactly on its terms. Going under
              on promises alone is ordinary and stays on the page.
            </span>
          </span>
        </label>

        <div className="mt-4 grid gap-4 sm:grid-cols-6">
          <div className="sm:col-span-4">
            <Input
              name="recipients"
              label="Send to"
              maxLength={500}
              disabled={!canEdit}
              defaultValue={recipients ?? ''}
              placeholder={fallbackTo ?? 'you@carrier.com'}
              hint={
                fallbackTo
                  ? `Leave empty and it goes to ${fallbackTo}, the address on the organisation.`
                  : 'Separate several with commas. There is no address on the organisation to fall back to.'
              }
            />
          </div>
          <div className="sm:col-span-2">
            <Input
              name="minimumGapDays"
              type="number"
              min={0}
              max={30}
              label="Days between"
              disabled={!canEdit}
              defaultValue={minimumGapDays}
              hint="A guard against a projection flapping over the line, not a limit on bad news."
            />
          </div>
        </div>

        {canEdit && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || !mailReady || !on}
              onClick={() => void sweep()}
            >
              <Send aria-hidden />
              Run the sweep now
            </Button>
          </div>
        )}
      </form>

      {note && (
        <p className="flex items-start gap-1.5 border-t border-line px-5 py-3 text-xs text-ok">
          <Check className="mt-px size-3.5 shrink-0" aria-hidden />
          {note}
        </p>
      )}

      {history.length > 0 && (
        <div className="border-t border-line">
          <p className="px-5 pt-4 text-xs text-ink-muted">What has gone out</p>
          <ul className="divide-y divide-line">
            {history.map((row) => (
              <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-x-3 px-5 py-3">
                <span className="flex min-w-0 items-center gap-2 text-sm text-ink">
                  <Badge
                    tone={row.outcome === 'failed' ? 'warn' : row.kind === 'all_clear' ? 'ok' : 'danger'}
                    size="sm"
                  >
                    {row.outcome === 'failed'
                      ? 'Failed'
                      : row.kind === 'all_clear'
                        ? 'All clear'
                        : 'Warning'}
                  </Badge>
                  <span className="truncate">{REASON_LABEL[row.reason]}</span>
                </span>
                <span className="text-xs text-ink-secondary tabular-nums">
                  {row.shortfallCents !== null && `${money(row.shortfallCents)} · `}
                  {sentText(row.sentAt)} UTC
                </span>
                {row.detail && <span className="w-full text-xs text-warn">{row.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
