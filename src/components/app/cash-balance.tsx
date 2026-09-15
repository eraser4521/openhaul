'use client';

import { useState } from 'react';
import { AlertCircle, Check, Landmark, Pencil } from 'lucide-react';
import { recordBalanceAction } from '@/app/(app)/money/cash-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { money } from '@/lib/utils/format';
import { AGE_NOTE, anyMovement, type BalanceAge, type Movements } from '@/lib/cash/balance';

/**
 * What the bank says, and how long ago it said it.
 *
 * The one figure in this application that nothing can check and the only one
 * that stops being true without anything happening — so the age is not a
 * footnote here, it is the second most prominent thing on the card. A balance
 * shown without its age is how a screen like this ends up confidently wrong on
 * exactly the week somebody was relying on it.
 *
 * What has moved since is shown as arithmetic rather than as a single adjusted
 * figure. Somebody who can see the four components can tell at a glance
 * whether the derived position is worth trusting; somebody handed only the
 * total cannot.
 */

export interface BalanceCardProps {
  reading: { amountCents: number; asOf: Date; note: string | null } | null;
  age: { days: number; state: BalanceAge } | null;
  moved: Movements | null;
  positionCents: number | null;
  canEdit: boolean;
}

const AGE_TONE: Record<BalanceAge, 'ok' | 'warn' | 'danger'> = {
  fresh: 'ok',
  aging: 'warn',
  stale: 'danger',
};

function dayText(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function describeAge(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/** Today in the same UTC calendar the rest of the cash screens count in. */
function todayValue(): string {
  return new Date().toISOString().slice(0, 10);
}

export function CashBalance({ reading, age, moved, positionCents, canEdit }: BalanceCardProps) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = async (formData: FormData) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const result = await recordBalanceAction(formData);
      if (result.ok) {
        setSaved(true);
        setEditing(false);
      } else {
        setError(result.error ?? 'That could not be saved.');
      }
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-xs font-medium tracking-wide text-ink-muted uppercase">
            <Landmark className="size-3.5" aria-hidden />
            In the account
          </h2>

          {reading ? (
            <>
              <p className="mt-2 text-xl font-semibold text-ink tabular-nums">
                {money(reading.amountCents)}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
                <span>at the end of {dayText(reading.asOf)}</span>
                {age && (
                  <Badge tone={AGE_TONE[age.state]} size="sm">
                    {describeAge(age.days)}
                  </Badge>
                )}
              </p>
              {age && (
                <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-ink-muted">
                  {AGE_NOTE[age.state]}
                </p>
              )}
              {reading.note && (
                <p className="mt-1 text-xs text-ink-muted">&ldquo;{reading.note}&rdquo;</p>
              )}
            </>
          ) : (
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-secondary">
              Nobody has entered one. The weeks below say what moves, not what you have — which
              means a week that nets positive can still be a week you cannot cover. Enter what your
              bank says and they become a running balance.
            </p>
          )}
        </div>

        {canEdit && !editing && (
          <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
            {reading ? <Pencil aria-hidden /> : null}
            {reading ? 'Update' : 'Enter a balance'}
          </Button>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 border-t border-line bg-danger-soft px-5 py-3 text-sm text-danger"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}

      {editing && (
        <form action={submit} className="border-t border-line bg-surface px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-6">
            <div className="sm:col-span-2">
              <Input
                name="amount"
                label="Balance"
                required
                inputMode="decimal"
                placeholder="4250.00"
                defaultValue={reading ? (reading.amountCents / 100).toFixed(2) : ''}
                hint="Negative if you are overdrawn."
              />
            </div>
            <div className="sm:col-span-2">
              {/*
                * "At the end of" rather than "as at", because it decides what
                * gets counted afterwards: everything on this day is treated as
                * already inside the figure, and only the days after it are
                * added on. A vaguer label would leave that rule to be guessed.
                */}
              <Input
                name="asOf"
                type="date"
                label="At the end of"
                required
                max={todayValue()}
                defaultValue={
                  reading ? reading.asOf.toISOString().slice(0, 10) : todayValue()
                }
              />
            </div>
            <div className="sm:col-span-2">
              <Input
                name="note"
                label="Note"
                maxLength={300}
                placeholder="Optional"
                defaultValue={reading?.note ?? ''}
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? 'Saving…' : 'Save balance'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {reading && moved && positionCents !== null && anyMovement(moved) && (
        <div className="border-t border-line px-5 py-4">
          <p className="text-xs text-ink-muted">Recorded here since then</p>

          <dl className="mt-2 space-y-1 text-xs">
            <Line label="Payments banked" cents={moved.receivedCents} direction="in" />
            <Line label="Settlements paid" cents={moved.settlementsPaidCents} direction="out" />
            <Line label="Refunds sent" cents={moved.refundsPaidCents} direction="out" />
            <Line
              label="Standing costs due"
              cents={moved.recurringCents}
              direction="out"
              /*
               * A direct debit falling due is not proof it cleared, so this
               * one is marked apart from the three above it — which are things
               * that happened and are on file.
               */
              note="expected, not confirmed"
            />
          </dl>

          <p className="mt-3 border-t border-line pt-3 text-sm text-ink">
            Probably{' '}
            <span className="font-semibold tabular-nums">{money(positionCents)}</span> now
            <span className="block text-xs leading-relaxed text-ink-muted">
              Probably, because a fuel card, a card machine and anything paid in cash moved too and
              none of it is recorded here. The weeks below run from this figure.
            </span>
          </p>
        </div>
      )}

      {saved && (
        <p className="flex items-center gap-1.5 border-t border-line px-5 py-3 text-xs text-ok">
          <Check className="size-3.5" aria-hidden />
          Saved
        </p>
      )}
    </Card>
  );
}

function Line({
  label,
  cents,
  direction,
  note,
}: {
  label: string;
  cents: number;
  direction: 'in' | 'out';
  note?: string;
}) {
  if (cents === 0) return null;

  /*
   * The caveat sits on its own line rather than after the label. Left inline
   * it pushed the amount onto a second line at phone width, so one row in a
   * column of figures ended up with its number left-aligned under the label —
   * which reads as a different kind of thing, which is the opposite of what a
   * column of figures is for.
   */
  return (
    <div>
      <div className="flex items-baseline justify-between gap-x-3">
        <dt className="text-ink-secondary">{label}</dt>
        <dd className={direction === 'in' ? 'text-ok tabular-nums' : 'text-ink tabular-nums'}>
          {direction === 'in' ? '+' : '−'}
          {money(cents)}
        </dd>
      </div>
      {note && <p className="text-ink-muted">{note}</p>}
    </div>
  );
}
