'use client';

import { useState } from 'react';
import { AlertCircle, Info, Plus, Trash2 } from 'lucide-react';
import {
  addAccessorialAction,
  removeAccessorialAction,
} from '@/app/(app)/invoices/accessorial-actions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { basisText, formatQuantity, UNIT_LABEL } from '@/lib/branding/accessorial-math';
import { money } from '@/lib/utils/format';
import { ACCESSORIAL_UNITS, type AccessorialUnit } from '@/lib/db/schema';

/**
 * Itemised accessorials on a draft invoice.
 *
 * Its own card rather than a section of the charges form, because it is a
 * different kind of edit: each line is saved on its own and the invoice total
 * is re-derived from the set, where the charges form posts one set of figures
 * at once. Nesting a form inside a form would also not work.
 */

export interface AccessorialLineView {
  id: string;
  label: string;
  code: string | null;
  unit: AccessorialUnit;
  quantityHundredths: number;
  unitCents: number;
  note: string | null;
  amountCents: number;
}

export interface CatalogueOption {
  id: string;
  code: string;
  label: string;
  unit: AccessorialUnit;
  defaultCents: number;
  note: string | null;
}

export function InvoiceAccessorials({
  invoiceId,
  lines,
  catalogue,
  editable,
  totalCents,
}: {
  invoiceId: string;
  lines: AccessorialLineView[];
  catalogue: CatalogueOption[];
  /** False once the invoice is issued. */
  editable: boolean;
  totalCents: number;
}) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>('');

  const chosen = catalogue.find((entry) => entry.id === selected) ?? null;

  const add = async (formData: FormData) => {
    setBusy(true);
    setError(null);
    try {
      const result = await addAccessorialAction(invoiceId, formData);
      if (result.ok) {
        setAdding(false);
        setSelected('');
      } else {
        setError(result.error ?? 'That charge could not be added.');
      }
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (lineId: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await removeAccessorialAction(invoiceId, lineId);
      if (!result.ok) setError(result.error ?? 'That charge could not be removed.');
    } finally {
      setBusy(false);
    }
  };

  if (!editable && lines.length === 0) return null;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Accessorials</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-secondary">
            Broken out with the arithmetic beside each one. A named line with its own working gets
            paid; a lump sum gets a phone call.
          </p>
        </div>
        {editable && !adding && (
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
        <form action={add} className="border-b border-line bg-surface px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-6">
            <div className="sm:col-span-6">
              <label htmlFor="rateId" className="text-sm font-medium text-ink">
                Charge
              </label>
              <select
                id="rateId"
                name="rateId"
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
                className="mt-1.5 h-10 w-full rounded-lg border border-line bg-raised px-2 text-sm text-ink focus:border-brand focus:outline-none"
              >
                <option value="">Something not in the catalogue…</option>
                {catalogue.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.code} · {entry.label} — {money(entry.defaultCents)}{' '}
                    {UNIT_LABEL[entry.unit]}
                  </option>
                ))}
              </select>
              {catalogue.length === 0 && (
                <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-ink-muted">
                  <Info className="mt-px size-3.5 shrink-0" aria-hidden />
                  Your catalogue is empty. Charges you add there once are picked from this list
                  afterwards, with the same name and rate every time.
                </p>
              )}
            </div>

            {!chosen && (
              <>
                <div className="sm:col-span-1">
                  <Input name="code" label="Code" maxLength={12} className="font-mono uppercase" />
                </div>
                <div className="sm:col-span-3">
                  <Input name="label" label="Name" required placeholder="Winch out" />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="unit" className="text-sm font-medium text-ink">
                    Per
                  </label>
                  <select
                    id="unit"
                    name="unit"
                    className="mt-1.5 h-10 w-full rounded-lg border border-line bg-raised px-2 text-sm text-ink focus:border-brand focus:outline-none"
                  >
                    {ACCESSORIAL_UNITS.map((unit) => (
                      <option key={unit} value={unit}>
                        {UNIT_LABEL[unit]}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}

            <div className="sm:col-span-2">
              <Input
                name="quantity"
                label={
                  chosen && chosen.unit !== 'flat'
                    ? `How many (${UNIT_LABEL[chosen.unit]})`
                    : 'How many'
                }
                inputMode="decimal"
                defaultValue="1"
                hint="3, 3.5 or 3.25."
              />
            </div>
            <div className="sm:col-span-2">
              <Input
                name="unitRate"
                label="Rate"
                required
                inputMode="decimal"
                leading={<span className="text-sm">$</span>}
                key={chosen?.id ?? 'custom'}
                defaultValue={chosen ? (chosen.defaultCents / 100).toFixed(2) : ''}
                hint={
                  chosen ? 'From your catalogue. Change it for a negotiated exception.' : undefined
                }
              />
            </div>
            <div className="sm:col-span-2">
              <Input
                name="note"
                label="Note"
                key={`note-${chosen?.id ?? 'custom'}`}
                defaultValue={chosen?.note ?? ''}
                placeholder="Optional"
              />
            </div>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setAdding(false);
                setSelected('');
              }}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={busy}>
              Add it
            </Button>
          </div>
        </form>
      )}

      {lines.length === 0 ? (
        <p className="px-5 py-8 text-center text-xs text-ink-muted">
          No accessorials on this invoice.
        </p>
      ) : (
        <>
          <ul className="divide-y divide-line">
            {lines.map((line) => (
              <li key={line.id} className="flex items-start gap-3 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-2">
                    {line.code && (
                      <span className="font-mono text-xs text-ink-muted">{line.code}</span>
                    )}
                    <span className="text-sm text-ink">{line.label}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-ink-secondary tabular-nums">
                    {basisText(line) ??
                      `${formatQuantity(line.quantityHundredths)} × ${money(line.unitCents)}`}
                  </p>
                  {line.note && <p className="mt-0.5 text-xs text-ink-muted">{line.note}</p>}
                </div>

                <p className="shrink-0 text-sm text-ink tabular-nums">{money(line.amountCents)}</p>

                {editable && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={`Remove ${line.label}`}
                    onClick={() => void remove(line.id)}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-between border-t border-line bg-raised px-5 py-3">
            <p className="text-sm font-medium text-ink">Accessorials</p>
            <p className="text-sm font-semibold text-ink tabular-nums">{money(totalCents)}</p>
          </div>
        </>
      )}
    </Card>
  );
}
