'use client';

import { useState } from 'react';
import { AlertCircle, Check, Plus, RotateCcw, X } from 'lucide-react';
import {
  retireAccessorialAction,
  saveAccessorialAction,
} from '@/app/(app)/settings/template-actions';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { UNIT_LABEL } from '@/lib/branding/accessorial-math';
import { money } from '@/lib/utils/format';
import { ACCESSORIAL_UNITS, type AccessorialUnit } from '@/lib/db/schema';

/**
 * The carrier's own named charges.
 *
 * The whole reason this is a catalogue and not free text on each invoice: the
 * same charge billed as "detention" one week and "waiting time" the next is
 * what an accounts department queries. Naming it once, with a rate and a unit,
 * is what makes the line on the invoice checkable rather than arguable.
 */

export interface CatalogueEntry {
  id: string;
  code: string;
  label: string;
  unit: AccessorialUnit;
  defaultCents: number;
  note: string | null;
  active: boolean;
}

export function AccessorialCatalogue({
  entries,
  canEdit,
}: {
  entries: CatalogueEntry[];
  canEdit: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = async (id: string | null, formData: FormData) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const result = await saveAccessorialAction(id, formData);
      if (result.ok) {
        setSaved(true);
        setAdding(false);
        setEditing(null);
      } else {
        setError(result.error ?? 'That could not be saved.');
      }
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const setActive = async (id: string, active: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await retireAccessorialAction(id, active);
      if (!result.ok) setError(result.error ?? 'That could not be changed.');
    } finally {
      setBusy(false);
    }
  };

  const live = entries.filter((entry) => entry.active);
  const retired = entries.filter((entry) => !entry.active);

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Accessorial charges</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
            Your own charges, with a rate and the unit they are counted in. Picked from this list on
            an invoice, they print itemised with the arithmetic beside them.
          </p>
        </div>
        {canEdit && !adding && (
          <Button type="button" variant="secondary" size="sm" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            Add a charge
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
        <RateForm
          busy={busy}
          onCancel={() => setAdding(false)}
          onSubmit={(formData) => submit(null, formData)}
        />
      )}

      {entries.length === 0 && !adding ? (
        <p className="px-5 py-8 text-center text-xs leading-relaxed text-ink-muted">
          Nothing here yet. Until there is, an accessorial on an invoice is a single figure with no
          explanation — which is the version a broker queries.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {[...live, ...retired].map((entry) =>
            editing === entry.id ? (
              <li key={entry.id}>
                <RateForm
                  entry={entry}
                  busy={busy}
                  onCancel={() => setEditing(null)}
                  onSubmit={(formData) => submit(entry.id, formData)}
                />
              </li>
            ) : (
              <li key={entry.id} className="flex flex-wrap items-start gap-3 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-ink-muted">{entry.code}</span>
                    <span className="text-sm text-ink">{entry.label}</span>
                    {!entry.active && (
                      <Badge tone="neutral" size="sm">
                        Retired
                      </Badge>
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-secondary tabular-nums">
                    {money(entry.defaultCents)} {UNIT_LABEL[entry.unit]}
                  </p>
                  {entry.note && <p className="mt-0.5 text-xs text-ink-muted">{entry.note}</p>}
                </div>

                {canEdit && (
                  <div className="flex shrink-0 gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setEditing(entry.id)}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void setActive(entry.id, !entry.active)}
                    >
                      {entry.active ? <X aria-hidden /> : <RotateCcw aria-hidden />}
                      {entry.active ? 'Retire' : 'Restore'}
                    </Button>
                  </div>
                )}
              </li>
            ),
          )}
        </ul>
      )}

      {retired.length > 0 && (
        <p className="border-t border-line px-5 py-3 text-xs leading-relaxed text-ink-muted">
          Retired charges stay so that last year&rsquo;s invoices still explain themselves. The
          invoices that cite them keep their own copy of the rate, so nothing here rewrites what was
          charged.
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

function RateForm({
  entry,
  busy,
  onCancel,
  onSubmit,
}: {
  entry?: CatalogueEntry;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (formData: FormData) => void;
}) {
  return (
    <form action={onSubmit} className="border-b border-line bg-surface px-5 py-4">
      <div className="grid gap-4 sm:grid-cols-6">
        <div className="sm:col-span-1">
          <Input
            name="code"
            label="Code"
            required
            maxLength={12}
            className="font-mono uppercase"
            defaultValue={entry?.code ?? ''}
            placeholder="DET"
          />
        </div>
        <div className="sm:col-span-3">
          <Input
            name="label"
            label="Name"
            required
            defaultValue={entry?.label ?? ''}
            placeholder="Detention at pickup"
            hint="What the customer will read on the invoice."
          />
        </div>
        <div className="sm:col-span-1">
          <Input
            name="defaultRate"
            label="Rate"
            required
            inputMode="decimal"
            defaultValue={entry ? (entry.defaultCents / 100).toFixed(2) : ''}
            placeholder="75.00"
          />
        </div>
        <div className="sm:col-span-1">
          <label htmlFor="unit" className="text-sm font-medium text-ink">
            Per
          </label>
          <select
            id="unit"
            name="unit"
            defaultValue={entry?.unit ?? 'flat'}
            className="mt-1.5 h-10 w-full rounded-lg border border-line bg-raised px-2 text-sm text-ink focus:border-brand focus:outline-none"
          >
            {ACCESSORIAL_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {UNIT_LABEL[unit]}
              </option>
            ))}
          </select>
        </div>

        <div className="sm:col-span-6">
          <Input
            name="note"
            label="Note"
            defaultValue={entry?.note ?? ''}
            placeholder="Optional. Printed under the line on the invoice."
          />
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" size="sm" loading={busy}>
          {entry ? 'Save changes' : 'Add it'}
        </Button>
      </div>
    </form>
  );
}
