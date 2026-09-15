'use client';

import { useState } from 'react';
import { AlertCircle, Check, Plus, Trash2 } from 'lucide-react';
import { removeOutgoingAction, saveOutgoingAction } from '@/app/(app)/money/cash-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { money } from '@/lib/utils/format';
import {
  CADENCE_LABEL,
  CATEGORY_LABEL,
  annualCents,
  describeOutgoing,
  hasEnded,
  nextOccurrence,
  type Outgoing,
} from '@/lib/cash/recurring';
import { OUTGOING_CADENCES, OUTGOING_CATEGORIES } from '@/lib/db/schema';

/**
 * What leaves whether or not a wheel turns.
 *
 * The truck note, the premium, the yard rent, the quarterly fuel tax. It is
 * the only part of a carrier's cash position this software cannot derive from
 * something it already holds, and it is usually the largest part — so a
 * timeline without it is a timeline of the pleasant half.
 *
 * Each row carries what it costs in a year beside what it costs each time,
 * because that is the only way to see which of a list of commitments is
 * actually the expensive one. A weekly figure and an annual premium are
 * otherwise impossible to compare at a glance, and the small frequent ones are
 * the ones that get left off.
 */

export interface StandingCost extends Outgoing {
  note: string | null;
}

const selectClass =
  'mt-1.5 h-10 w-full rounded-lg border border-line bg-raised px-2 text-sm text-ink ' +
  'focus:border-brand focus:outline-none';

function dayText(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function StandingCosts({
  costs,
  canEdit,
  now,
}: {
  costs: StandingCost[];
  canEdit: boolean;
  now: Date;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  const submit = async (id: string | null, formData: FormData) => {
    setBusy(true);
    setError(null);
    setProblems([]);
    setSaved(false);
    try {
      const result = await saveOutgoingAction(id, formData);
      if (result.ok) {
        setSaved(true);
        setAdding(false);
        setEditing(null);
      } else {
        setProblems(result.problems ?? []);
        setError(result.problems ? null : (result.error ?? 'That could not be saved.'));
      }
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await removeOutgoingAction(id);
      if (!result.ok) setError(result.error ?? 'That could not be removed.');
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  };

  const live = costs.filter((cost) => !hasEnded(cost, now));
  const ended = costs.filter((cost) => hasEnded(cost, now));

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Standing costs</h2>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-secondary">
            Everything that leaves on a schedule whether or not a wheel turns. None of it is
            anywhere else in this application, and all of it comes out of the same account the
            driver settlements do. Dearest first by what it costs in a year, which is not the same
            order as by what leaves each time.
          </p>
        </div>
        {canEdit && !adding && (
          <Button type="button" variant="secondary" size="sm" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            Add a cost
          </Button>
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

      {problems.length > 0 && (
        <ul role="alert" className="border-b border-line bg-danger-soft px-5 py-3 text-sm text-danger">
          {problems.map((problem) => (
            <li key={problem} className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
              {problem}
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <CostForm busy={busy} onCancel={() => setAdding(false)} onSubmit={(f) => submit(null, f)} />
      )}

      {costs.length === 0 && !adding ? (
        <p className="px-5 py-8 text-center text-xs leading-relaxed text-ink-muted">
          Nothing recorded. Until there is, the cash timeline shows what customers owe against what
          drivers are owed and nothing else — which is the half that makes a month look survivable.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {[...live, ...ended].map((cost) =>
            editing === cost.id ? (
              <li key={cost.id}>
                <CostForm
                  cost={cost}
                  busy={busy}
                  onCancel={() => setEditing(null)}
                  onSubmit={(formData) => submit(cost.id, formData)}
                />
              </li>
            ) : (
              <li key={cost.id} className="flex flex-wrap items-start gap-3 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-ink">{cost.name}</span>
                    <Badge tone="neutral" size="sm">
                      {CATEGORY_LABEL[cost.category]}
                    </Badge>
                    {hasEnded(cost, now) && (
                      <Badge tone="neutral" size="sm">
                        Finished
                      </Badge>
                    )}
                  </p>

                  <p className="mt-0.5 text-xs text-ink-secondary tabular-nums">
                    {money(cost.amountCents)} · {CADENCE_LABEL[cost.cadence].toLowerCase()} · about{' '}
                    {money(annualCents(cost))} a year
                  </p>

                  <p className="mt-0.5 text-xs text-ink-muted">
                    {describeOutgoing(cost)}
                    {!hasEnded(cost, now) &&
                      (() => {
                        const next = nextOccurrence(cost, now);
                        return next ? ` · next ${dayText(next)}` : '';
                      })()}
                  </p>

                  {cost.note && <p className="mt-0.5 text-xs text-ink-muted">{cost.note}</p>}
                </div>

                {canEdit && (
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    {confirming === cost.id ? (
                      <>
                        <Button
                          type="button"
                          variant="danger"
                          size="sm"
                          disabled={busy}
                          onClick={() => void remove(cost.id)}
                        >
                          Remove it
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setConfirming(null)}
                        >
                          Keep
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setEditing(cost.id)}
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setConfirming(cost.id)}
                        >
                          <Trash2 aria-hidden />
                          Remove
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </li>
            ),
          )}
        </ul>
      )}

      {ended.length > 0 && (
        <p className="border-t border-line px-5 py-3 text-xs leading-relaxed text-ink-muted">
          A finished commitment stays until somebody removes it, so a loan that has run its course
          can be seen to have run its course rather than simply vanishing. Nothing after its last
          payment is counted.
        </p>
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

function CostForm({
  cost,
  busy,
  onCancel,
  onSubmit,
}: {
  cost?: StandingCost;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (formData: FormData) => void;
}) {
  const asValue = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : '');

  return (
    <form action={onSubmit} className="border-b border-line bg-surface px-5 py-4">
      <div className="grid gap-4 sm:grid-cols-6">
        <div className="sm:col-span-3">
          <Input
            name="name"
            label="What it is"
            required
            maxLength={80}
            defaultValue={cost?.name ?? ''}
            placeholder="Freightliner note"
            hint="However it reads on the bank statement."
          />
        </div>

        <div className="sm:col-span-3">
          <label htmlFor="category" className="text-sm font-medium text-ink">
            Kind
          </label>
          <select
            id="category"
            name="category"
            defaultValue={cost?.category ?? 'other'}
            className={selectClass}
          >
            {OUTGOING_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {CATEGORY_LABEL[category]}
              </option>
            ))}
          </select>
        </div>

        <div className="sm:col-span-2">
          <Input
            name="amount"
            label="Each time"
            required
            inputMode="decimal"
            placeholder="1850.00"
            defaultValue={cost ? (cost.amountCents / 100).toFixed(2) : ''}
          />
        </div>

        <div className="sm:col-span-2">
          <label htmlFor="cadence" className="text-sm font-medium text-ink">
            How often
          </label>
          <select
            id="cadence"
            name="cadence"
            defaultValue={cost?.cadence ?? 'monthly'}
            className={selectClass}
          >
            {OUTGOING_CADENCES.map((cadence) => (
              <option key={cadence} value={cadence}>
                {CADENCE_LABEL[cadence]}
              </option>
            ))}
          </select>
        </div>

        <div className="sm:col-span-2">
          {/*
            * One anchor date says both which weekday a fortnightly payment
            * falls on and which of the two weeks, so there is no second
            * setting here to drift out of step with it.
            */}
          <Input
            name="anchorOn"
            type="date"
            label="First payment"
            required
            defaultValue={asValue(cost?.anchorOn ?? null)}
            hint="Past is fine — everything after is counted from it."
          />
        </div>

        <div className="sm:col-span-3">
          <Input
            name="endsOn"
            type="date"
            label="Last payment"
            defaultValue={asValue(cost?.endsOn ?? null)}
            hint="Leave empty if it runs until you say otherwise."
          />
        </div>

        <div className="sm:col-span-3">
          <Input
            name="note"
            label="Note"
            maxLength={300}
            placeholder="Optional"
            defaultValue={cost?.note ?? ''}
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Saving…' : cost ? 'Save changes' : 'Add it'}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
