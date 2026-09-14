'use client';

import { useState } from 'react';
import { AlertCircle, Check, Info, Lock, ShieldAlert, Trash2 } from 'lucide-react';
import {
  placeOrgHoldAction,
  purgeClassAction,
  releaseHoldAction,
  setRetentionDaysAction,
} from '@/app/(app)/settings/retention-actions';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { bytes as formatBytes, relativeTime } from '@/lib/utils/format';
import { DISPOSITION_LABEL, describeDays, type Disposition } from '@/lib/retention/policy';

/**
 * What the carrier has to keep, what has outlived it, and what a hold is
 * protecting.
 *
 * The counts are the point of the screen rather than the buttons. A carrier
 * who has never thought about retention should be able to read this and learn
 * their obligations; one who has should be able to see that the nine hundred
 * inspections they are paying to store are past the window anyone could still
 * use them in.
 *
 * Nothing here runs on a schedule. A purge is a form somebody fills in.
 */

export interface ClassRow {
  recordClass: string;
  label: string;
  covers: string;
  note: string;
  citation: string;
  anchorLabel: string;
  disposition: Disposition;
  retentionDays: number;
  floorDays: number;
  customised: boolean;
  total: number;
  due: number;
  held: number;
  pending: number;
  keeping: number;
  bytes: number;
  unreachable: number;
  oldestDueAt: string | null;
}

export interface HoldRow {
  id: string;
  subject: string;
  reason: string;
  placedAt: string;
}

export function RetentionPanel({
  rows,
  holds,
  canEdit,
  canPurge,
}: {
  rows: ClassRow[];
  holds: HoldRow[];
  canEdit: boolean;
  canPurge: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [purging, setPurging] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const totalDue = rows.reduce((sum, row) => sum + row.due, 0);
  const reclaimable = rows.reduce((sum, row) => sum + row.bytes, 0);

  const savePeriod = async (recordClass: string, formData: FormData) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const result = await setRetentionDaysAction(recordClass, formData);
      if (result.ok) {
        setOpen(null);
        setDone('Period saved.');
      } else {
        setError(result.error ?? 'That could not be saved.');
      }
    } finally {
      setBusy(false);
    }
  };

  const purge = async (recordClass: string, formData: FormData) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const result = await purgeClassAction(recordClass, formData);
      if (result.ok) {
        setPurging(null);
        setDone(
          `Destroyed ${result.purged} record${result.purged === 1 ? '' : 's'}` +
            `${result.bytes ? `, freeing ${formatBytes(result.bytes)}` : ''}.` +
            (result.unreachable
              ? ` ${result.unreachable} photo original${result.unreachable === 1 ? '' : 's'} predate the column that records where they are, and are still on disk.`
              : ''),
        );
      } else {
        setError(result.error ?? 'That could not be run.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card>
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-sm font-semibold text-ink">Records and retention</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
            Each kind of record is kept for its own period, measured from its own event. A period
            can be lengthened but never taken below the regulatory floor, and nothing here runs on
            a schedule — a purge is something you start after reading what it will take.
          </p>
          {totalDue > 0 && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-ink-secondary">
              <Info className="mt-px size-3.5 shrink-0 text-ink-muted" aria-hidden />
              {totalDue} record{totalDue === 1 ? ' is' : 's are'} past their period
              {reclaimable > 0 ? `, holding ${formatBytes(reclaimable)}` : ''}.
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

        {done && (
          <p className="flex items-start gap-2 border-b border-line bg-ok-soft px-5 py-3 text-sm text-ok">
            <Check className="mt-0.5 size-4 shrink-0" aria-hidden />
            {done}
          </p>
        )}

        <ul className="divide-y divide-line">
          {rows.map((row) => (
            <li key={row.recordClass} className="px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">{row.label}</span>
                    <Badge tone="neutral" size="sm">
                      {describeDays(row.retentionDays)}
                    </Badge>
                    {row.customised && (
                      <Badge tone="info" size="sm">
                        Changed
                      </Badge>
                    )}
                    {row.due > 0 && (
                      <Badge tone="warn" size="sm">
                        {row.due} past
                      </Badge>
                    )}
                    {row.held > 0 && (
                      <Badge tone="info" size="sm">
                        {row.held} on hold
                      </Badge>
                    )}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-ink-secondary">{row.covers}</p>
                  <p className="mt-1 text-xs text-ink-muted">
                    Measured from {row.anchorLabel}.{' '}
                    {row.floorDays > 0
                      ? `Minimum ${describeDays(row.floorDays)} under ${row.citation}.`
                      : 'No federal minimum.'}{' '}
                    {DISPOSITION_LABEL[row.disposition]}.
                  </p>

                  <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-muted tabular-nums">
                    <span>{row.total} total</span>
                    <span>{row.keeping} within period</span>
                    {row.pending > 0 && <span>{row.pending} clock not started</span>}
                    {row.due > 0 && <span className="text-warn">{row.due} past period</span>}
                    {row.held > 0 && <span>{row.held} held</span>}
                    {row.bytes > 0 && <span>{formatBytes(row.bytes)} reclaimable</span>}
                  </dl>
                </div>

                <div className="flex shrink-0 gap-1.5">
                  {canEdit && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setOpen(open === row.recordClass ? null : row.recordClass)}
                    >
                      Period
                    </Button>
                  )}
                  {canPurge && row.disposition === 'purge' && row.due > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setPurging(purging === row.recordClass ? null : row.recordClass)
                      }
                    >
                      <Trash2 aria-hidden />
                      Purge
                    </Button>
                  )}
                </div>
              </div>

              {open === row.recordClass && (
                <form
                  action={(formData) => void savePeriod(row.recordClass, formData)}
                  className="mt-3 rounded-lg bg-surface p-4"
                >
                  <p className="text-xs leading-relaxed text-ink-secondary">{row.note}</p>
                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <div className="w-32">
                      <Input
                        name="years"
                        label="Keep for (years)"
                        inputMode="decimal"
                        defaultValue={(row.retentionDays / 365).toFixed(1)}
                      />
                    </div>
                    <Button type="submit" size="sm" loading={busy}>
                      Save
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(null)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              )}

              {purging === row.recordClass && (
                <form
                  action={(formData) => void purge(row.recordClass, formData)}
                  className="mt-3 rounded-lg bg-danger-soft p-4"
                >
                  <input type="hidden" name="expected" value={String(row.due)} />
                  <p className="flex items-start gap-2 text-sm font-medium text-danger">
                    <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                    Destroy {row.due} record{row.due === 1 ? '' : 's'} — {row.label.toLowerCase()}
                  </p>
                  <p className="mt-1 pl-6 text-xs leading-relaxed text-ink-secondary">
                    Permanent, including the files behind them.
                    {row.oldestDueAt
                      ? ` The oldest was recorded ${relativeTime(new Date(row.oldestDueAt))}.`
                      : ''}{' '}
                    Anything on legal hold is left alone, and the check runs again when you press
                    the button rather than trusting the number above.
                    {row.unreachable > 0 &&
                      ` ${row.unreachable} photo original${row.unreachable === 1 ? '' : 's'} predate the column recording where they are stored and will stay on disk.`}
                  </p>

                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <div className="w-40">
                      <Input
                        name="confirm"
                        label={`Type ${row.due} to confirm`}
                        required
                        autoComplete="off"
                      />
                    </div>
                    <Button type="submit" size="sm" loading={busy}>
                      <Trash2 aria-hidden />
                      Destroy them
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setPurging(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <LegalHolds holds={holds} canEdit={canEdit} />
    </>
  );
}

function LegalHolds({ holds, canEdit }: { holds: HoldRow[]; canEdit: boolean }) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const place = async (formData: FormData) => {
    setBusy(true);
    setError(null);
    try {
      const result = await placeOrgHoldAction(formData);
      if (result.ok) setAdding(false);
      else setError(result.error ?? 'That could not be placed.');
    } finally {
      setBusy(false);
    }
  };

  const release = async (subject: string) => {
    setBusy(true);
    try {
      await releaseHoldAction(subject);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Legal holds</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
            A hold stops retention destroying anything it covers, whatever the periods say. Filing
            a cargo claim places one on that load automatically; an organisation-wide hold is what
            you place on being served, before anyone knows which loads are in scope.
          </p>
        </div>
        {canEdit && !adding && (
          <Button type="button" variant="secondary" size="sm" onClick={() => setAdding(true)}>
            <ShieldAlert aria-hidden />
            Hold everything
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

      {adding && (
        <form action={place} className="border-b border-line bg-surface px-5 py-4">
          <Input
            name="reason"
            label="Why"
            required
            placeholder="Served with discovery in Dowd v. Ridgeline, 14 Sep 2026"
            hint="Recorded on the audit chain, and shown here until it is released."
          />
          <div className="mt-3 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={busy}>
              Place the hold
            </Button>
          </div>
        </form>
      )}

      {holds.length === 0 ? (
        <p className="px-5 py-8 text-center text-xs text-ink-muted">
          Nothing is on hold. Retention periods apply as configured.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {holds.map((hold) => (
            <li key={hold.id} className="flex flex-wrap items-start gap-3 px-5 py-3.5">
              <Lock className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink">
                  {hold.subject === 'org' ? 'Everything' : hold.subject}
                </p>
                <p className="mt-0.5 text-xs text-ink-secondary">{hold.reason}</p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  Placed {relativeTime(new Date(hold.placedAt))}
                </p>
              </div>
              {canEdit && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void release(hold.subject)}
                >
                  Release
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
