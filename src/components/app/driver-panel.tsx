'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion } from 'motion/react';
import {
  AlertCircle,
  CalendarRange,
  IdCard,
  LogOut,
  Pencil,
  Plus,
  RotateCcw,
  Wallet,
} from 'lucide-react';
import {
  buildSettlementAction,
  endLeaseAction,
  reinstateDriverAction,
  saveDriverAction,
} from '@/app/(app)/drivers/actions';
import { Button } from '@/components/ui/button';
import {
  DriverPersonalData,
  type SubjectState,
} from '@/components/app/driver-personal-data';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { money, relativeTime } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';
import { describeDeadline } from '@/lib/settlements/deadline';
import { STATUS_LABEL, type SettlementStatus } from '@/lib/settlements/compute';

/**
 * A driver, their pay arrangement, and their settlements.
 *
 * Employment type is the first field because everything downstream turns on
 * it: a leased owner-operator's settlement is governed by 49 CFR Part 376 and
 * a company driver's is not, and the statement says different things as a
 * result.
 */

export interface DriverSettlement {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  netPayCents: number;
  status: SettlementStatus;
  late: boolean;
}

export interface DriverRow {
  id: string;
  displayName: string;
  employmentType: string;
  payRateBps: number | null;
  payPerMileCents: number | null;
  cdlState: string | null;
  cdlClass: string | null;
  escrowCents: number;
  /** The carrier's own record that this driver has gone. ISO, or null. */
  leftOn: string | null;
  /** Null unless escrow is still held past the forty-five days, or close to it. */
  escrowDue: { dueBy: string; daysLeft: number; state: 'due_soon' | 'late' } | null;
  settlements: DriverSettlement[];
  /**
   * Whether anything personal is on file for this driver, and whether it has
   * been erased. Read from the tombstone, so listing drivers never decrypts
   * anything and never writes an audit entry.
   */
  personalData: SubjectState;
  personalDataErasedAt: string | null;
}

const STATUS_TONE: Record<SettlementStatus, 'neutral' | 'info' | 'ok'> = {
  draft: 'neutral',
  finalized: 'info',
  paid: 'ok',
};

function payDescription(driver: DriverRow): string {
  if (driver.payRateBps) return `${(driver.payRateBps / 100).toFixed(2)}% of load revenue`;
  if (driver.payPerMileCents) return `${money(driver.payPerMileCents)} per mile`;
  return 'No pay rate set';
}

function DriverFields({ driver }: { driver?: DriverRow }) {
  const [type, setType] = useState(driver?.employmentType ?? 'company');

  return (
    <div className="grid gap-4 sm:grid-cols-6">
      <div className="sm:col-span-3">
        <Input
          name="displayName"
          label="Name"
          required
          defaultValue={driver?.displayName ?? ''}
          placeholder="Marcus Webb"
        />
      </div>

      <div className="flex flex-col gap-1.5 sm:col-span-3">
        <label htmlFor={`employmentType-${driver?.id ?? 'new'}`} className="text-sm font-medium text-ink">
          Engagement
        </label>
        <select
          id={`employmentType-${driver?.id ?? 'new'}`}
          name="employmentType"
          value={type}
          onChange={(event) => setType(event.target.value)}
          className="h-10 rounded-lg border border-line bg-raised px-3 text-sm text-ink focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
        >
          <option value="company">Company driver</option>
          <option value="owner_operator">Leased owner-operator</option>
        </select>
        <p className="text-xs leading-relaxed text-ink-muted">
          {type === 'owner_operator'
            ? 'Their settlement is governed by 49 CFR Part 376: itemised chargebacks, escrow accounting, and payment within 15 days.'
            : 'On payroll. Part 376 does not apply.'}
        </p>
      </div>

      <div className="sm:col-span-2">
        <Input
          name="payRate"
          label="Pay share"
          inputMode="decimal"
          trailing={<span className="text-xs">%</span>}
          defaultValue={driver?.payRateBps ? (driver.payRateBps / 100).toFixed(2) : ''}
          placeholder="68.00"
          hint="Of load revenue."
        />
      </div>

      <div className="sm:col-span-2">
        <Input
          name="payPerMile"
          label="Or per mile"
          inputMode="decimal"
          leading={<span className="text-sm">$</span>}
          defaultValue={driver?.payPerMileCents ? (driver.payPerMileCents / 100).toFixed(2) : ''}
          placeholder="0.55"
          hint="Used only when no share is set."
        />
      </div>

      <div className="sm:col-span-1">
        <Input
          name="cdlState"
          label="CDL state"
          maxLength={2}
          className="uppercase"
          defaultValue={driver?.cdlState ?? ''}
        />
      </div>

      <div className="flex flex-col gap-1.5 sm:col-span-1">
        <label htmlFor={`cdlClass-${driver?.id ?? 'new'}`} className="text-sm font-medium text-ink">
          Class
        </label>
        <select
          id={`cdlClass-${driver?.id ?? 'new'}`}
          name="cdlClass"
          defaultValue={driver?.cdlClass ?? ''}
          className="h-10 rounded-lg border border-line bg-raised px-3 text-sm text-ink focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
        >
          <option value="">—</option>
          <option value="A">A</option>
          <option value="B">B</option>
          <option value="C">C</option>
        </select>
      </div>
    </div>
  );
}

export function NewDriver({ canWrite }: { canWrite: boolean }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!canWrite) return null;

  if (!open) {
    return (
      <Button type="button" onClick={() => setOpen(true)}>
        <Plus aria-hidden />
        Add a driver
      </Button>
    );
  }

  const save = async (formData: FormData) => {
    setSaving(true);
    setError(null);
    try {
      const result = await saveDriverAction(null, formData);
      if (result.ok) setOpen(false);
      else setError(result.error ?? 'The driver could not be saved.');
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="w-full">
      <div className="border-b border-line px-5 py-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <IdCard className="size-4 text-ink-muted" aria-hidden />
          Add a driver
        </h2>
      </div>
      <form action={save}>
        {error && (
          <p
            role="alert"
            className="flex items-start gap-2 border-b border-line bg-danger-soft px-5 py-3 text-sm text-danger"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {error}
          </p>
        )}
        <div className="p-5">
          <DriverFields />
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            Save driver
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** A day, in the UTC calendar the rest of the application counts in. */
function dayText(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function DriverCard({
  driver,
  canWrite,
  canReadPii,
  canErasePii,
  defaultPeriodStart,
  defaultPeriodEnd,
}: {
  driver: DriverRow;
  canWrite: boolean;
  canReadPii: boolean;
  canErasePii: boolean;
  defaultPeriodStart: string;
  defaultPeriodEnd: string;
}) {
  const router = useRouter();
  const [panel, setPanel] = useState<'edit' | 'settle' | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const endLease = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await endLeaseAction(driver.id);
      if (result.ok) {
        setLeaving(false);
        router.refresh();
      } else {
        setError(result.error ?? 'That could not be recorded.');
      }
    } finally {
      setBusy(false);
    }
  };

  const reinstate = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await reinstateDriverAction(driver.id);
      if (result.ok) router.refresh();
      else setError(result.error ?? 'That could not be undone.');
    } finally {
      setBusy(false);
    }
  };

  const leased = driver.employmentType === 'owner_operator';

  const save = async (formData: FormData) => {
    setBusy(true);
    setError(null);
    try {
      const result = await saveDriverAction(driver.id, formData);
      if (result.ok) setPanel(null);
      else setError(result.error ?? 'The driver could not be saved.');
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const settle = async (formData: FormData) => {
    setBusy(true);
    setError(null);
    try {
      const result = await buildSettlementAction(driver.id, formData);
      if (result.ok && result.settlementId) router.push(`/settlements/${result.settlementId}`);
      else setError(result.error ?? 'The settlement could not be built.');
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
            {driver.displayName}
            <Badge tone={leased ? 'info' : 'neutral'} size="sm">
              {leased ? 'Owner-operator' : 'Company'}
            </Badge>
            {driver.leftOn && (
              <Badge tone="neutral" size="sm">
                Left {dayText(driver.leftOn)}
              </Badge>
            )}
          </h3>
          <p className="mt-1 text-xs text-ink-secondary">
            {payDescription(driver)}
            {driver.cdlClass ? ` · CDL ${driver.cdlClass}${driver.cdlState ? ` (${driver.cdlState})` : ''}` : ''}
          </p>
          {leased && (
            <p
              className={cn(
                'mt-0.5 flex items-center gap-1.5 text-xs',
                driver.escrowDue
                  ? driver.escrowDue.state === 'late'
                    ? 'text-danger'
                    : 'text-warn'
                  : 'text-ink-muted',
              )}
            >
              <Wallet className="size-3.5" aria-hidden />
              {money(driver.escrowCents)} held in escrow
              {driver.escrowDue && ` · to return, ${describeDeadline(driver.escrowDue.daysLeft)}`}
            </p>
          )}
        </div>

        {canWrite && (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPanel(panel === 'edit' ? null : 'edit')}
            >
              <Pencil aria-hidden />
              Edit
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setPanel(panel === 'settle' ? null : 'settle')}
            >
              <CalendarRange aria-hidden />
              Run a settlement
            </Button>
            {/*
              * Two clocks start from this: the forty-five days 376.12(h)
              * allows for returning escrow, and the retention period after
              * which the record becomes purgeable. So it is its own act with
              * its own confirmation rather than a field in the edit form,
              * where it would be changed by accident and noticed by nobody.
              */}
            {driver.leftOn ? (
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void reinstate()}>
                <RotateCcw aria-hidden />
                Still here
              </Button>
            ) : leaving ? (
              <>
                <Button type="button" variant="danger" size="sm" disabled={busy} onClick={() => void endLease()}>
                  They have left
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setLeaving(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button type="button" variant="ghost" size="sm" onClick={() => setLeaving(true)}>
                <LogOut aria-hidden />
                Mark as left
              </Button>
            )}
          </div>
        )}
      </div>

      {driver.escrowDue && (
        <p
          className={cn(
            'flex items-start gap-2 border-b border-line px-5 py-3 text-xs leading-relaxed',
            driver.escrowDue.state === 'late' ? 'bg-danger-soft text-danger' : 'bg-warn-soft text-warn',
          )}
        >
          <Wallet className="mt-px size-3.5 shrink-0" aria-hidden />
          {money(driver.escrowCents)} of this driver&rsquo;s money is still held. Under 49 CFR
          376.12(h) it goes back within forty-five days of the lease ending, which was{' '}
          {dayText(driver.leftOn!)} — {describeDeadline(driver.escrowDue.daysLeft)}. Returning it on
          a final settlement clears the balance and puts it on a statement they receive.
        </p>
      )}

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 border-b border-line bg-warn-soft px-5 py-3 text-xs leading-relaxed text-warn"
        >
          <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      )}

      {canReadPii && (
        <div className="border-b border-line px-5 py-4">
          <DriverPersonalData
            driverId={driver.id}
            driverName={driver.displayName}
            state={driver.personalData}
            erasedAt={driver.personalDataErasedAt}
            canRead={canReadPii}
            canErase={canErasePii}
          />
        </div>
      )}

      {panel === 'edit' && (
        <motion.form action={save} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <div className="p-5">
            <DriverFields driver={driver} />
          </div>
          <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
            <Button type="button" variant="ghost" onClick={() => setPanel(null)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Save
            </Button>
          </div>
        </motion.form>
      )}

      {panel === 'settle' && (
        <motion.form action={settle} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <Input
              name="periodStart"
              label="Period starts"
              type="date"
              required
              defaultValue={defaultPeriodStart}
            />
            <Input
              name="periodEnd"
              label="Period ends"
              type="date"
              required
              defaultValue={defaultPeriodEnd}
            />
          </div>
          <p className="px-5 pb-4 text-xs leading-relaxed text-ink-secondary">
            Picks up loads this driver <strong className="text-ink">delivered</strong> in the
            period, at their pay rate, plus any reimbursable expenses with receipts. A load already
            paid on another settlement is never pulled in twice.
          </p>
          <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
            <Button type="button" variant="ghost" onClick={() => setPanel(null)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Build the settlement
            </Button>
          </div>
        </motion.form>
      )}

      {driver.settlements.length === 0 ? (
        <p className="px-5 py-4 text-xs text-ink-muted">No settlements yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {driver.settlements.map((settlement) => (
            <li key={settlement.id}>
              <Link
                href={`/settlements/${settlement.id}`}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-raised"
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
                    {settlement.periodStart.toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      timeZone: 'UTC',
                    })}
                    {' — '}
                    {settlement.periodEnd.toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      timeZone: 'UTC',
                    })}
                    <Badge tone={STATUS_TONE[settlement.status]} size="sm">
                      {STATUS_LABEL[settlement.status]}
                    </Badge>
                    {settlement.late && (
                      <Badge tone="danger" size="sm">
                        Past the 15-day window
                      </Badge>
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    Ended {relativeTime(settlement.periodEnd)}
                  </p>
                </div>
                <span className="text-sm font-semibold text-ink tabular-nums">
                  {money(settlement.netPayCents)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
