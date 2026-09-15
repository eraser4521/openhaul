'use client';

import { useState } from 'react';
import { AlertCircle, Check, FileText, Receipt } from 'lucide-react';
import {
  buildStatementAction,
  setStatementsEnabledAction,
} from '@/app/(app)/customers/statement-actions';
import { Button } from '@/components/ui/button';
import { money, relativeTime } from '@/lib/utils/format';
import { STATEMENT_WINDOWS, describeWindow } from '@/lib/invoices/statement';

/**
 * Producing a statement of account for a customer.
 *
 * The figures are shown before anything is produced, because a statement is a
 * document that goes to somebody else and a carrier should know what it will
 * say first. What it says is always as at today; the period only decides how
 * far back the movements are listed.
 *
 * Statements already produced stay listed. A customer ringing about "the
 * statement you sent in March" needs the March one, not a fresh rendering of
 * the same account three months later.
 */

export interface StatementView {
  id: string;
  issuedAt: string;
  windowDays: number;
  balanceCents: number;
  heldCents: number;
  openItemCount: number;
  documentId: string | null;
}

export function StatementPanel({
  customerId,
  balanceCents,
  heldCents,
  openItemCount,
  statements,
  scheduled,
  scheduleOn,
  canBuild,
}: {
  customerId: string;
  /** What a statement produced now would say is outstanding. */
  balanceCents: number;
  heldCents: number;
  openItemCount: number;
  statements: StatementView[];
  /** Whether the organisation's schedule reaches this customer. */
  scheduled: boolean;
  /** False when the organisation sends none at all, so the toggle explains itself. */
  scheduleOn: boolean;
  canBuild: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);

  const setScheduled = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await setStatementsEnabledAction(customerId, enabled);
      if (!result.ok) setError(result.error ?? 'That could not be changed.');
    } finally {
      setBusy(false);
    }
  };

  const build = async (formData: FormData) => {
    setBusy(true);
    setError(null);
    setMade(null);
    try {
      const result = await buildStatementAction(customerId, formData);
      if (result.ok) setMade(result.documentId ?? null);
      else setError(result.error ?? 'The statement could not be produced.');
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-ink-muted uppercase">
        <Receipt className="size-3.5" aria-hidden />
        Statement of account
      </p>

      <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
        {balanceCents > 0
          ? `${money(balanceCents)} outstanding across ${openItemCount} invoice${openItemCount === 1 ? '' : 's'}.`
          : 'Nothing outstanding.'}
        {heldCents > 0 && ` ${money(heldCents)} held on account.`}
      </p>

      {error && (
        <p
          role="alert"
          className="mt-2 flex items-start gap-1.5 rounded-lg bg-danger-soft px-2.5 py-2 text-xs leading-relaxed text-danger"
        >
          <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      )}

      {made && (
        <p className="mt-2 flex items-center gap-1.5 rounded-lg bg-ok-soft px-2.5 py-2 text-xs text-ok">
          <Check className="size-3.5 shrink-0" aria-hidden />
          Produced. Send it from the documents screen.
        </p>
      )}

      {canBuild && (
        <form action={build} className="mt-2 flex flex-wrap items-center gap-2">
          <label htmlFor={`window-${customerId}`} className="sr-only">
            Period to list movements from
          </label>
          <select
            id={`window-${customerId}`}
            name="windowDays"
            defaultValue={90}
            className="h-8 rounded-lg border border-line bg-raised px-2 text-xs text-ink focus:border-brand focus:outline-none"
          >
            {STATEMENT_WINDOWS.map((days) => (
              <option key={days} value={days}>
                {describeWindow(days)}
              </option>
            ))}
          </select>
          <Button type="submit" variant="secondary" size="sm" loading={busy}>
            Produce
          </Button>
        </form>
      )}

      {canBuild && (
        <label className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-ink-secondary">
          <input
            type="checkbox"
            checked={scheduled}
            disabled={busy}
            onChange={(event) => void setScheduled(event.target.checked)}
            className="mt-0.5 size-3.5 rounded border-line accent-[var(--brand)]"
          />
          <span>
            Include in scheduled statements.
            {!scheduleOn && ' Nothing is sent on a schedule yet — set one in Settings.'}
          </span>
        </label>
      )}

      {statements.length > 0 && (
        <ul className="mt-2 space-y-1">
          {statements.slice(0, 4).map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate text-ink-secondary">
                {relativeTime(new Date(row.issuedAt))} · {money(row.balanceCents)} due
              </span>
              {row.documentId && (
                <a
                  href={`/api/documents/${row.documentId}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex shrink-0 items-center gap-1 text-ink-muted transition-colors hover:text-ink"
                >
                  <FileText className="size-3" aria-hidden />
                  View
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
