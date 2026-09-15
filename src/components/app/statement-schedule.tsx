'use client';

import { useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CalendarClock,
  Check,
  Info,
  Send,
} from 'lucide-react';
import { runNowAction, saveScheduleAction } from '@/app/(app)/settings/statement-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { money, relativeTime } from '@/lib/utils/format';
import { STATEMENT_WINDOWS, describeWindow } from '@/lib/invoices/statement';
import {
  DECISION_LABEL,
  MAX_DAY_OF_MONTH,
  WEEKDAY_LABEL,
  describeSchedule,
  type ScheduleRule,
  type SendDecision,
} from '@/lib/invoices/statement-schedule';
import type { StatementCadence } from '@/lib/db/schema';

/**
 * When statements go out.
 *
 * The cadence is a rule, not a timer — nothing in this application knows what
 * time it is until something outside calls in — so the screen has to say that
 * plainly. A carrier who sets a monthly schedule and never adds the cron line
 * would otherwise believe their customers are being told, and find out months
 * later that nobody was.
 *
 * Who would receive one is listed before anything is sent, including the
 * customers who would not and why. "Why did Cardinal not get one" is the
 * question asked about a batch job, and a preview showing only recipients
 * cannot answer it.
 */

export interface CandidateView {
  customerId: string;
  name: string;
  balanceCents: number;
  heldCents: number;
  decision: SendDecision;
}

export interface RunView {
  id: string;
  dueOn: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  considered: number;
  sent: number;
  failed: number;
  skipped: number;
  /** Anything that did not go, with the reason. */
  problems: Array<{ id: string; customerName: string; outcome: string; detail: string | null }>;
}

export function StatementSchedule({
  rule,
  nextOn,
  candidates,
  runs,
  mailReady,
  triggerReady,
  canEdit,
}: {
  rule: ScheduleRule;
  /** When the next occurrence falls, or null when the schedule is off. */
  nextOn: string | null;
  candidates: CandidateView[];
  runs: RunView[];
  mailReady: boolean;
  /** Whether anything outside can actually drive the schedule. */
  triggerReady: boolean;
  canEdit: boolean;
}) {
  const [cadence, setCadence] = useState<StatementCadence>(rule.cadence);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [ran, setRan] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const save = async (formData: FormData) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    setRan(null);
    try {
      const result = await saveScheduleAction(formData);
      if (result.ok) setSaved(true);
      else setError(result.error ?? 'The schedule could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    setRan(null);
    try {
      const result = await runNowAction();
      if (!result.ok) {
        setError(result.error ?? 'Nothing was sent.');
        return;
      }
      setRan(
        `${result.sent} sent` +
          (result.failed ? `, ${result.failed} failed` : '') +
          (result.skipped ? `, ${result.skipped} skipped` : '') +
          '.',
      );
    } finally {
      setBusy(false);
    }
  };

  const willSend = candidates.filter((row) => row.decision.send);
  const shown = showAll ? candidates : willSend;

  return (
    <Card>
      <div className="border-b border-line px-5 py-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <CalendarClock className="size-4 text-ink-muted" aria-hidden />
          Sending statements on a schedule
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
          {describeSchedule(rule)}
          {nextOn && ` The next one falls on ${nextOn}.`}
        </p>
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

      {saved && (
        <p className="flex items-center gap-2 border-b border-line bg-ok-soft px-5 py-3 text-sm text-ok">
          <Check className="size-4 shrink-0" aria-hidden />
          Schedule saved.
        </p>
      )}

      {ran && (
        <p className="flex items-center gap-2 border-b border-line bg-ok-soft px-5 py-3 text-sm text-ok">
          <Check className="size-4 shrink-0" aria-hidden />
          {ran}
        </p>
      )}

      {/*
        * Two different warnings, because they fail differently. Without mail
        * nothing can be sent at all; without the token the cadence is a rule
        * nobody will ever act on, and the carrier would never find out.
        */}
      {!mailReady && (
        <p className="flex items-start gap-2 border-b border-line bg-warn-soft px-5 py-3 text-xs leading-relaxed text-warn">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          No mail server is configured, so a run would send nothing. Statements are not produced
          either — documents nobody sent would be worse than none.
        </p>
      )}

      {rule.cadence !== 'off' && !triggerReady && (
        <p className="flex items-start gap-2 border-b border-line bg-warn-soft px-5 py-3 text-xs leading-relaxed text-warn">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          Nothing outside is able to start a run, so this schedule will not fire on its own. Set{' '}
          <code className="font-mono">STATEMENT_RUN_TOKEN</code> and add the cron line from
          SELF_HOSTING.md.
        </p>
      )}

      {canEdit && (
        <form action={save} className="border-b border-line px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-6">
            <div className="sm:col-span-2">
              <label htmlFor="cadence" className="text-sm font-medium text-ink">
                How often
              </label>
              <select
                id="cadence"
                name="cadence"
                value={cadence}
                onChange={(event) => setCadence(event.target.value as StatementCadence)}
                className="mt-1.5 h-10 w-full rounded-lg border border-line bg-raised px-2 text-sm text-ink focus:border-brand focus:outline-none"
              >
                <option value="off">Never</option>
                <option value="monthly">Monthly</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>

            {cadence === 'monthly' && (
              <div className="sm:col-span-2">
                <Input
                  name="dayOfMonth"
                  label="On which day"
                  type="number"
                  min={1}
                  max={MAX_DAY_OF_MONTH}
                  defaultValue={rule.dayOfMonth}
                  hint={`1 to ${MAX_DAY_OF_MONTH}, so every month has it.`}
                />
              </div>
            )}

            {cadence === 'weekly' && (
              <div className="sm:col-span-2">
                <label htmlFor="dayOfWeek" className="text-sm font-medium text-ink">
                  On which day
                </label>
                <select
                  id="dayOfWeek"
                  name="dayOfWeek"
                  defaultValue={rule.dayOfWeek}
                  className="mt-1.5 h-10 w-full rounded-lg border border-line bg-raised px-2 text-sm text-ink focus:border-brand focus:outline-none"
                >
                  {WEEKDAY_LABEL.map((label, index) => (
                    <option key={label} value={index}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="sm:col-span-2">
              <label htmlFor="windowDays" className="text-sm font-medium text-ink">
                Movements listed from
              </label>
              <select
                id="windowDays"
                name="windowDays"
                defaultValue={rule.windowDays}
                className="mt-1.5 h-10 w-full rounded-lg border border-line bg-raised px-2 text-sm text-ink focus:border-brand focus:outline-none"
              >
                {STATEMENT_WINDOWS.map((days) => (
                  <option key={days} value={days}>
                    {describeWindow(days)}
                  </option>
                ))}
              </select>
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

            <div className="sm:col-span-4 flex items-start gap-2 pt-1">
              <input
                id="includeCreditHolders"
                name="includeCreditHolders"
                type="checkbox"
                defaultChecked={rule.includeCreditHolders}
                className="mt-0.5 size-4 rounded border-line accent-[var(--brand)]"
              />
              <label
                htmlFor="includeCreditHolders"
                className="text-xs leading-relaxed text-ink-secondary"
              >
                Also statement anyone holding credit with you, even when they owe nothing.
                Telling them you have their money is the reason the balance is recorded.
              </label>
            </div>
          </div>

          <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-ink-muted">
            <Info className="mt-px size-3.5 shrink-0" aria-hidden />
            A run missed while the machine was off is not made up. Every balance is as at the
            moment the statement is produced, so the next one covers it.
          </p>

          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || !mailReady || willSend.length === 0}
              onClick={() => void runNow()}
              title={
                willSend.length === 0 ? 'Nobody has anything worth sending' : undefined
              }
            >
              <Send aria-hidden />
              Send {willSend.length} now
            </Button>
            <Button type="submit" size="sm" loading={busy}>
              Save schedule
            </Button>
          </div>
        </form>
      )}

      {/* --- Who would get one ------------------------------------------- */}

      <div className="border-b border-line px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-xs font-medium tracking-wide text-ink-muted uppercase">
            {willSend.length} would receive one
          </h3>
          {candidates.length > willSend.length && (
            <button
              type="button"
              onClick={() => setShowAll((was) => !was)}
              className="text-xs text-ink-muted underline-offset-2 hover:text-ink hover:underline"
            >
              {showAll
                ? 'Hide the rest'
                : `Show the ${candidates.length - willSend.length} who would not`}
            </button>
          )}
        </div>

        {shown.length === 0 ? (
          <p className="mt-2 text-xs text-ink-muted">
            Nobody has an outstanding balance or credit on account.
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {shown.map((row) => (
              <li
                key={row.customerId}
                className="flex flex-wrap items-baseline justify-between gap-2 text-xs"
              >
                <span className="min-w-0 truncate text-ink">{row.name}</span>
                <span className="flex items-center gap-2">
                  {row.balanceCents !== 0 && (
                    <span className="text-ink-secondary tabular-nums">
                      {money(row.balanceCents)}
                    </span>
                  )}
                  {row.heldCents > 0 && (
                    <span className="text-brand tabular-nums">{money(row.heldCents)} held</span>
                  )}
                  <span className={row.decision.send ? 'text-ink-muted' : 'text-ink-muted/70'}>
                    {DECISION_LABEL[row.decision.reason]}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* --- What happened last time -------------------------------------- */}

      {runs.length > 0 && (
        <div className="px-5 py-4">
          <h3 className="text-xs font-medium tracking-wide text-ink-muted uppercase">
            Recent runs
          </h3>

          <ul className="mt-2 space-y-3">
            {runs.map((run) => (
              <li key={run.id}>
                <p className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-ink">{run.dueOn}</span>
                  <Badge tone={run.failed > 0 ? 'danger' : 'ok'} size="sm">
                    {run.sent} sent
                  </Badge>
                  {run.failed > 0 && (
                    <Badge tone="danger" size="sm">
                      {run.failed} failed
                    </Badge>
                  )}
                  {run.skipped > 0 && (
                    <Badge tone="warn" size="sm">
                      {run.skipped} skipped
                    </Badge>
                  )}
                  <span className="text-ink-muted">
                    {run.trigger === 'manual' ? 'by hand' : 'scheduled'} ·{' '}
                    {relativeTime(new Date(run.startedAt))}
                  </span>
                </p>

                {run.problems.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {run.problems.map((problem) => (
                      <li
                        key={problem.id}
                        className={
                          'flex items-start gap-1.5 text-xs leading-relaxed ' +
                          (problem.outcome === 'failed' ? 'text-danger' : 'text-warn')
                        }
                      >
                        <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                        <span>
                          {problem.customerName}: {problem.detail ?? 'No reason recorded.'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>

          <p className="mt-3 text-xs leading-relaxed text-ink-muted">
            Nothing is retried inside a run. A statement that was produced but not sent is on the
            documents screen and can go from there.
          </p>
        </div>
      )}
    </Card>
  );
}
