'use client';

import { useState } from 'react';
import { AlertCircle, BadgeCheck, Lock, Plus, Trash2 } from 'lucide-react';
import {
  addLineAction,
  finalizeSettlementAction,
  paySettlementAction,
  removeLineAction,
} from '@/app/(app)/drivers/actions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SETTLEMENT_LINE_KINDS } from '@/lib/db/schema';
import { LINE_LABEL } from '@/lib/settlements/compute';
import { money } from '@/lib/utils/format';

/**
 * Editing a settlement while it is still a draft.
 *
 * Chargebacks and advances are things only the office knows about, so they are
 * added here rather than derived. Each one takes a note explaining how it was
 * arrived at, because 49 CFR 376.12(g) entitles a leased driver to know what
 * every deducted item is — and "misc: $125" is not that.
 */

export interface SettlementEditorProps {
  settlementId: string;
  finalized: boolean;
  paid: boolean;
  canWrite: boolean;
  leased: boolean;
  netPayCents: number;
  today: string;
}

export function SettlementEditor({
  settlementId,
  finalized,
  paid,
  canWrite,
  leased,
  netPayCents,
  today,
}: SettlementEditorProps) {
  const [panel, setPanel] = useState<'line' | 'pay' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (!canWrite) {
    return <p className="text-xs text-ink-muted">Your role can read settlements but not run them.</p>;
  }

  const run = async (key: string, work: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(key);
    setError(null);
    try {
      const result = await work();
      if (result.ok) setPanel(null);
      else setError(result.error ?? 'That did not go through.');
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm leading-relaxed text-danger"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {!finalized && (
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setPanel(panel === 'line' ? null : 'line')}
            >
              <Plus aria-hidden />
              Add a line
            </Button>
            <Button
              type="button"
              onClick={() => void run('finalize', () => finalizeSettlementAction(settlementId))}
              loading={busy === 'finalize'}
              disabled={busy !== null}
            >
              <Lock aria-hidden />
              Finalise and produce the statement
            </Button>
          </>
        )}

        {finalized && !paid && (
          <Button
            type="button"
            onClick={() => setPanel(panel === 'pay' ? null : 'pay')}
            disabled={busy !== null}
          >
            <BadgeCheck aria-hidden />
            Record payment of {money(netPayCents)}
          </Button>
        )}
      </div>

      {!finalized && (
        <p className="text-xs leading-relaxed text-ink-muted">
          Finalising freezes these lines and produces the statement.
          {leased
            ? ' After that a correction goes on the next settlement — the driver will be holding a document that states these figures.'
            : ' After that the lines cannot be changed.'}
        </p>
      )}

      {panel === 'line' && (
        <Card>
          <form action={(formData) => void run('line', () => addLineAction(settlementId, formData))}>
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="kind" className="text-sm font-medium text-ink">
                  Kind
                </label>
                <select
                  id="kind"
                  name="kind"
                  defaultValue="deduction"
                  className="h-10 rounded-lg border border-line bg-raised px-3 text-sm text-ink focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
                >
                  {SETTLEMENT_LINE_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {LINE_LABEL[kind]}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-ink-muted">
                  Deductions, advances and escrow come off; the rest go on.
                </p>
              </div>

              <Input
                name="amount"
                label="Amount"
                required
                inputMode="decimal"
                leading={<span className="text-sm">$</span>}
                placeholder="125.00"
                hint="A negative reverses an earlier line of the same kind."
              />

              <Input
                name="description"
                label="What it is"
                required
                placeholder="Occupational accident insurance"
              />

              <Input
                name="basisNote"
                label="How it was worked out"
                placeholder="Weekly premium per lease schedule B"
                hint={
                  leased
                    ? 'Printed on the statement. 376.12(g) entitles the driver to know.'
                    : 'Printed on the statement.'
                }
              />
            </div>

            <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
              <Button type="button" variant="ghost" onClick={() => setPanel(null)}>
                Cancel
              </Button>
              <Button type="submit" loading={busy === 'line'}>
                Add the line
              </Button>
            </div>
          </form>
        </Card>
      )}

      {panel === 'pay' && (
        <Card>
          <form action={(formData) => void run('pay', () => paySettlementAction(settlementId, formData))}>
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <Input
                name="reference"
                label="Reference"
                placeholder="ACH trace or check number"
                hint="What the driver would quote when asking about it."
              />
              <Input name="paidAt" label="Date paid" type="date" defaultValue={today} />
            </div>
            <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
              <Button type="button" variant="ghost" onClick={() => setPanel(null)}>
                Cancel
              </Button>
              <Button type="submit" loading={busy === 'pay'}>
                Record the payment
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}

export function RemoveLine({
  settlementId,
  lineId,
  disabled,
}: {
  settlementId: string;
  lineId: string;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState(false);

  if (disabled) return null;

  return (
    <button
      type="button"
      aria-label="Remove this line"
      className="rounded-lg p-1.5 text-ink-muted transition-colors hover:bg-danger-soft hover:text-danger disabled:opacity-50"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void removeLineAction(settlementId, lineId).finally(() => setBusy(false));
      }}
    >
      <Trash2 className="size-3.5" aria-hidden />
    </button>
  );
}
