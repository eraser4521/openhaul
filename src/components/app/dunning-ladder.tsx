'use client';

import { useState } from 'react';
import { AlertCircle, AlertTriangle, Check, Info, Plus, Send, Trash2 } from 'lucide-react';
import { runDunningAction, saveDunningAction } from '@/app/(app)/settings/dunning-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { money, relativeTime } from '@/lib/utils/format';
import { HOLD_LABEL, describeLateness, type DunningRule, type HoldReason, type LadderStage } from '@/lib/invoices/dunning';

/**
 * How firmly overdue invoices are chased.
 *
 * The ladder is the carrier's own words, because the relationship is theirs.
 * What this screen insists on is the shape: rungs in order, spaced far enough
 * apart that the minimum gap does not silently delay them, and none of them
 * on the due date itself.
 *
 * It also says out loud that the defaults threaten nothing, and why. A
 * carrier who wants to name a consequence should write it themselves and mean
 * it — a threat nobody follows through on is ignored the next time, and the
 * next time is the one that mattered.
 */

export interface ChaseRow {
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  balanceCents: number;
  daysPastDue: number;
  chase: boolean;
  stageLabel?: string;
  reason?: HoldReason;
}

export interface SweepRow {
  id: string;
  dueOn: string;
  trigger: string;
  startedAt: string;
  sent: number;
  failed: number;
  held: number;
  failures: Array<{ id: string; invoiceNumber: string; detail: string | null }>;
}

export function DunningLadder({
  rule,
  ladder,
  rows,
  sweeps,
  mailReady,
  triggerReady,
  canEdit,
}: {
  rule: DunningRule;
  ladder: LadderStage[];
  rows: ChaseRow[];
  sweeps: SweepRow[];
  mailReady: boolean;
  triggerReady: boolean;
  canEdit: boolean;
}) {
  const [stages, setStages] = useState(ladder);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [swept, setSwept] = useState<string | null>(null);
  const [showHeld, setShowHeld] = useState(false);

  const due = rows.filter((row) => row.chase);
  const held = rows.filter((row) => !row.chase);

  const save = async (formData: FormData) => {
    setBusy(true);
    setError(null);
    setProblems([]);
    setSaved(false);
    setSwept(null);
    try {
      const result = await saveDunningAction(formData);
      if (result.ok) setSaved(true);
      else {
        setError(result.error ?? 'That could not be saved.');
        setProblems(result.problems ?? []);
      }
    } finally {
      setBusy(false);
    }
  };

  const sweep = async () => {
    setBusy(true);
    setError(null);
    setProblems([]);
    setSaved(false);
    setSwept(null);
    try {
      const result = await runDunningAction();
      if (!result.ok) {
        setError(result.error ?? 'Nothing was sent.');
        return;
      }
      setSwept(
        `${result.sent} sent` +
          (result.failed ? `, ${result.failed} failed` : '') +
          (result.held ? `, ${result.held} left alone` : '') +
          '.',
      );
    } finally {
      setBusy(false);
    }
  };

  const addStage = () => {
    setStages((was) => [
      ...was,
      {
        sequence: was.length + 1,
        label: 'New rung',
        daysPastDue: (was[was.length - 1]?.daysPastDue ?? 0) + rule.minimumGapDays + 4,
        message: '',
        enabled: true,
      },
    ]);
  };

  const removeStage = (index: number) => {
    setStages((was) => was.filter((_, at) => at !== index));
  };

  return (
    <Card>
      <div className="border-b border-line px-5 py-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <AlertTriangle className="size-4 text-ink-muted" aria-hidden />
          Chasing overdue invoices
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
          {rule.enabled
            ? `${stages.filter((stage) => stage.enabled).length} rungs, one at a time, at most one per invoice per day.`
            : 'Overdue invoices are not chased automatically.'}
        </p>
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

      {saved && (
        <p className="flex items-center gap-2 border-b border-line bg-ok-soft px-5 py-3 text-sm text-ok">
          <Check className="size-4 shrink-0" aria-hidden />
          Saved.
        </p>
      )}

      {swept && (
        <p className="flex items-center gap-2 border-b border-line bg-ok-soft px-5 py-3 text-sm text-ok">
          <Check className="size-4 shrink-0" aria-hidden />
          {swept}
        </p>
      )}

      {!mailReady && (
        <p className="flex items-start gap-2 border-b border-line bg-warn-soft px-5 py-3 text-xs leading-relaxed text-warn">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          No mail server is configured, so nothing can be sent and no notices are produced.
        </p>
      )}

      {rule.enabled && !triggerReady && (
        <p className="flex items-start gap-2 border-b border-line bg-warn-soft px-5 py-3 text-xs leading-relaxed text-warn">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          Nothing outside is able to start a sweep, so this ladder will not climb on its own. Set{' '}
          <code className="font-mono">DUNNING_RUN_TOKEN</code> and add the cron line from
          SELF_HOSTING.md.
        </p>
      )}

      {canEdit && (
        <form action={save} className="border-b border-line px-5 py-4">
          <input type="hidden" name="stageCount" value={stages.length} />

          <div className="grid gap-4 sm:grid-cols-6">
            <div className="sm:col-span-6 flex items-start gap-2">
              <input
                id="dunningEnabled"
                name="enabled"
                type="checkbox"
                defaultChecked={rule.enabled}
                className="mt-0.5 size-4 rounded border-line accent-[var(--brand)]"
              />
              <label htmlFor="dunningEnabled" className="text-sm font-medium text-ink">
                Chase overdue invoices automatically
              </label>
            </div>

            <div className="sm:col-span-2">
              <Input
                name="minimumBalance"
                label="Minimum balance"
                inputMode="decimal"
                leading={<span className="text-sm">$</span>}
                defaultValue={(rule.minimumBalanceCents / 100).toFixed(2)}
                hint="Below this, leave them alone."
              />
            </div>

            <div className="sm:col-span-2">
              <Input
                name="minimumGapDays"
                label="Days between notices"
                type="number"
                min={1}
                max={90}
                defaultValue={rule.minimumGapDays}
                hint="However close the rungs are."
              />
            </div>

            <div className="sm:col-span-2">
              <Input
                name="pauseAfterPaymentDays"
                label="Quiet after a payment"
                type="number"
                min={0}
                max={90}
                defaultValue={rule.pauseAfterPaymentDays}
                hint="Somebody paying is not somebody to chase."
              />
            </div>

            <div className="sm:col-span-2">
              <Input
                name="promiseGraceDays"
                label="Grace on a promise"
                type="number"
                min={0}
                max={30}
                defaultValue={rule.promiseGraceDays}
                hint="A cheque posted on the day takes most of a week."
              />
            </div>
          </div>

          <div className="mt-5 space-y-4">
            {stages.map((stage, index) => (
              <div key={index} className="rounded-lg border border-line p-4">
                <div className="grid gap-3 sm:grid-cols-6">
                  <div className="sm:col-span-3">
                    <Input
                      name={`stage${index}Label`}
                      label={`Rung ${index + 1}`}
                      defaultValue={stage.label}
                      required
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Input
                      name={`stage${index}Days`}
                      label="Days past due"
                      type="number"
                      min={1}
                      max={365}
                      defaultValue={stage.daysPastDue}
                    />
                  </div>
                  <div className="sm:col-span-1 flex items-end justify-between gap-2 pb-2">
                    <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
                      <input
                        name={`stage${index}Enabled`}
                        type="checkbox"
                        defaultChecked={stage.enabled}
                        className="size-3.5 rounded border-line accent-[var(--brand)]"
                      />
                      On
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove rung ${index + 1}`}
                      onClick={() => removeStage(index)}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>

                  <div className="sm:col-span-6">
                    <label
                      htmlFor={`stage${index}Message`}
                      className="text-sm font-medium text-ink"
                    >
                      What it says
                    </label>
                    <textarea
                      id={`stage${index}Message`}
                      name={`stage${index}Message`}
                      defaultValue={stage.message}
                      rows={3}
                      className="mt-1.5 w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm leading-relaxed text-ink focus:border-brand focus:outline-none"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-3"
            onClick={addStage}
            disabled={stages.length >= 8}
          >
            <Plus aria-hidden />
            Add a rung
          </Button>

          <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-ink-muted">
            <Info className="mt-px size-3.5 shrink-0" aria-hidden />
            None of the wording above threatens anything, deliberately. If you want to name what
            happens next, write it yourself and mean it — a threat you do not follow through on is
            ignored the next time, and the next time is the one that matters. The figures, the
            dates and how to pay are printed by the document; you only write the sentence.
          </p>

          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || !mailReady || !rule.enabled || due.length === 0}
              onClick={() => void sweep()}
            >
              <Send aria-hidden />
              Send {due.length} now
            </Button>
            <Button type="submit" size="sm" loading={busy}>
              Save ladder
            </Button>
          </div>
        </form>
      )}

      {/* --- Who is due, and who is being left alone --------------------- */}

      <div className="border-b border-line px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-xs font-medium tracking-wide text-ink-muted uppercase">
            {due.length} due a notice
          </h3>
          {held.length > 0 && (
            <button
              type="button"
              onClick={() => setShowHeld((was) => !was)}
              className="text-xs text-ink-muted underline-offset-2 hover:text-ink hover:underline"
            >
              {showHeld ? 'Hide' : `Show the ${held.length} being left alone`}
            </button>
          )}
        </div>

        {due.length === 0 && !showHeld && (
          <p className="mt-2 text-xs text-ink-muted">Nothing is due a notice today.</p>
        )}

        <ul className="mt-2 space-y-1.5">
          {(showHeld ? rows : due).map((row) => (
            <li
              key={row.invoiceId}
              className="flex flex-wrap items-baseline justify-between gap-2 text-xs"
            >
              <span className="min-w-0 truncate text-ink">
                {row.invoiceNumber}
                <span className="text-ink-secondary"> · {row.customerName}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="text-ink-secondary tabular-nums">
                  {money(row.balanceCents)}
                </span>
                <span className="text-ink-muted">{describeLateness(row.daysPastDue)}</span>
                {row.chase ? (
                  <Badge tone="warn" size="sm">
                    {row.stageLabel}
                  </Badge>
                ) : (
                  <span className="text-ink-muted/80">
                    {row.reason ? HOLD_LABEL[row.reason] : 'Left alone'}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* --- What the last sweeps did ------------------------------------ */}

      {sweeps.length > 0 && (
        <div className="px-5 py-4">
          <h3 className="text-xs font-medium tracking-wide text-ink-muted uppercase">
            Recent sweeps
          </h3>

          <ul className="mt-2 space-y-3">
            {sweeps.map((sweepRow) => (
              <li key={sweepRow.id}>
                <p className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-ink">{sweepRow.dueOn}</span>
                  <Badge tone={sweepRow.failed > 0 ? 'danger' : 'ok'} size="sm">
                    {sweepRow.sent} sent
                  </Badge>
                  {sweepRow.failed > 0 && (
                    <Badge tone="danger" size="sm">
                      {sweepRow.failed} failed
                    </Badge>
                  )}
                  {sweepRow.held > 0 && (
                    <Badge tone="neutral" size="sm">
                      {sweepRow.held} left alone
                    </Badge>
                  )}
                  <span className="text-ink-muted">
                    {sweepRow.trigger === 'manual' ? 'by hand' : 'scheduled'} ·{' '}
                    {relativeTime(new Date(sweepRow.startedAt))}
                  </span>
                </p>

                {sweepRow.failures.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {sweepRow.failures.map((failure) => (
                      <li
                        key={failure.id}
                        className="flex items-start gap-1.5 text-xs leading-relaxed text-danger"
                      >
                        <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                        <span>
                          {failure.invoiceNumber}: {failure.detail ?? 'No reason recorded.'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
