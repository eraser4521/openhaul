'use client';

import { useActionState, useCallback, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertCircle, Check, Loader2, Plus, Trash2, Wrench } from 'lucide-react';
import { createLoadAction, type LoadActionResult } from '../actions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { VinInput } from '@/components/scanner/vin-input';
import { classifyVin, decodeModelYear } from '@/lib/vin';
import { cn } from '@/lib/utils/cn';

interface VehicleRow {
  key: number;
  vin: string;
  year: string;
  make: string;
  model: string;
  color: string;
  inoperable: boolean;
  decoding: boolean;
  decoded: boolean;
}

const blankRow = (key: number): VehicleRow => ({
  key,
  vin: '',
  year: '',
  make: '',
  model: '',
  color: '',
  inoperable: false,
  decoding: false,
  decoded: false,
});

export function LoadForm({ suggestedNumber }: { suggestedNumber: string }) {
  const [state, formAction, pending] = useActionState<LoadActionResult | null, FormData>(
    createLoadAction,
    null,
  );
  const [rows, setRows] = useState<VehicleRow[]>([blankRow(0)]);
  const [nextKey, setNextKey] = useState(1);

  const update = (key: number, patch: Partial<VehicleRow>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const addRow = () => {
    setRows((current) => [...current, blankRow(nextKey)]);
    setNextKey((k) => k + 1);
  };

  const removeRow = (key: number) => {
    setRows((current) => (current.length === 1 ? current : current.filter((r) => r.key !== key)));
  };

  /**
   * VINs already being looked up.
   *
   * The decode is triggered from the change handler rather than an effect over
   * `rows`: an effect that both watches the rows and writes to them cancels its
   * own request on the very next render, so the lookup never lands.
   */
  const inFlight = useRef(new Set<string>());

  /**
   * Fills year, make and model from NHTSA once a VIN validates, so the
   * dispatcher types 17 characters instead of five fields.
   */
  const decodeVinFor = useCallback(async (key: number, vin: string) => {
    if (inFlight.current.has(vin)) return;
    inFlight.current.add(vin);

    update(key, { decoding: true });

    // Always available, with no network at all.
    const localYear = decodeModelYear(vin).year;

    try {
      const response = await fetch(`/api/vin/decode?vin=${encodeURIComponent(vin)}`);
      const data = (await response.json()) as {
        vehicle?: { modelYear?: number | null; make?: string | null; model?: string | null };
      };

      update(key, {
        decoding: false,
        decoded: true,
        year: String(data.vehicle?.modelYear ?? localYear ?? ''),
        make: data.vehicle?.make ?? '',
        model: data.vehicle?.model ?? '',
      });
    } catch {
      // Offline is not a failure: the year still comes out of the VIN itself,
      // and the rest can be typed.
      update(key, {
        decoding: false,
        decoded: true,
        year: String(localYear ?? ''),
      });
    } finally {
      inFlight.current.delete(vin);
    }
  }, []);

  const handleVinChange = (key: number, vin: string) => {
    update(key, { vin, decoded: false });
    if (classifyVin(vin).kind === 'modern') {
      void decodeVinFor(key, vin);
    }
  };

  return (
    <form action={formAction} className="space-y-6">
      {state?.error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {state.error}
        </p>
      )}

      <Card>
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-sm font-semibold text-ink">Load details</h2>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Input
            name="number"
            label="Reference"
            defaultValue={suggestedNumber}
            required
            error={state?.fieldErrors?.number}
            hint="Unique within your company"
          />

          <div className="flex flex-col gap-1.5">
            <label htmlFor="transportType" className="text-sm font-medium text-ink">
              Transport type
            </label>
            <select
              id="transportType"
              name="transportType"
              defaultValue="open"
              className="h-10 rounded-lg border border-line bg-raised px-3 text-sm text-ink focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
            >
              <option value="open">Open carrier</option>
              <option value="enclosed">Enclosed</option>
            </select>
          </div>

          <Input
            name="rate"
            label="Carrier pay"
            inputMode="decimal"
            placeholder="2940.00"
            leading={<span className="text-sm">$</span>}
            error={state?.fieldErrors?.rate}
            hint="What you are paid for the run"
          />

          <Input
            name="tariff"
            label="Customer tariff"
            inputMode="decimal"
            placeholder="3200.00"
            leading={<span className="text-sm">$</span>}
            error={state?.fieldErrors?.tariff}
            hint="Optional. The difference is recorded as broker fee."
          />

          <Input
            name="distanceMiles"
            label="Distance"
            inputMode="numeric"
            placeholder="1074"
            trailing={<span className="text-xs">mi</span>}
            error={state?.fieldErrors?.distanceMiles}
          />
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">Vehicles</h2>
            <p className="mt-0.5 text-xs text-ink-secondary">
              {rows.length} of up to 12. An open carrier typically holds seven to ten.
            </p>
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={addRow}>
            <Plus aria-hidden />
            Add vehicle
          </Button>
        </div>

        <div className="divide-y divide-line">
          <AnimatePresence initial={false}>
            {rows.map((row, index) => (
              <motion.div
                key={row.key}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                className="overflow-hidden"
              >
                <div className="space-y-4 p-5">
                  <div className="flex items-start justify-between gap-3">
                    <span className="mt-1 grid size-6 shrink-0 place-items-center rounded-full bg-sunken text-xs font-medium text-ink-secondary tabular-nums">
                      {index + 1}
                    </span>

                    <div className="min-w-0 flex-1">
                      <VinInput
                        value={row.vin}
                        onChange={(vin) => handleVinChange(row.key, vin)}
                        label="VIN"
                      />
                    </div>

                    {rows.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeRow(row.key)}
                        className="mt-7 grid size-9 shrink-0 place-items-center rounded-lg text-ink-muted transition-colors hover:bg-danger-soft hover:text-danger"
                        aria-label={`Remove vehicle ${index + 1}`}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </button>
                    )}
                  </div>

                  {/* Submitted alongside the visible fields. */}
                  <input type="hidden" name="vin" value={row.vin} />

                  <div className="grid gap-3 pl-9 sm:grid-cols-4">
                    <Input
                      name="year"
                      label="Year"
                      inputMode="numeric"
                      value={row.year}
                      onChange={(e) => update(row.key, { year: e.target.value })}
                    />
                    <Input
                      name="make"
                      label="Make"
                      value={row.make}
                      onChange={(e) => update(row.key, { make: e.target.value })}
                    />
                    <Input
                      name="model"
                      label="Model"
                      value={row.model}
                      onChange={(e) => update(row.key, { model: e.target.value })}
                    />
                    <Input
                      name="color"
                      label="Colour"
                      value={row.color}
                      onChange={(e) => update(row.key, { color: e.target.value })}
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-4 pl-9">
                    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink-secondary">
                      <input
                        type="checkbox"
                        name="inoperable"
                        value={String(index)}
                        checked={row.inoperable}
                        onChange={(e) => update(row.key, { inoperable: e.target.checked })}
                        className="size-4 rounded border-line accent-[var(--brand)]"
                      />
                      <Wrench className="size-3.5" aria-hidden />
                      Inoperable
                    </label>

                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 text-xs transition-opacity',
                        row.decoding || row.decoded ? 'opacity-100' : 'opacity-0',
                      )}
                    >
                      {row.decoding ? (
                        <>
                          <Loader2 className="size-3 animate-spin text-brand" aria-hidden />
                          <span className="text-ink-muted">Looking up NHTSA…</span>
                        </>
                      ) : (
                        <>
                          <Check className="size-3 text-ok" aria-hidden />
                          <span className="text-ink-muted">Filled from the VIN</span>
                        </>
                      )}
                    </span>
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </Card>

      <Card>
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-sm font-semibold text-ink">Instructions</h2>
        </div>
        <div className="p-5">
          <textarea
            name="instructions"
            rows={3}
            placeholder="Gate code, contact on site, anything the driver needs to know."
            className="w-full rounded-lg border border-line bg-raised px-3 py-2.5 text-sm text-ink placeholder:text-ink-muted focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
          />
        </div>
      </Card>

      <div className="flex justify-end gap-3">
        <Button type="submit" size="lg" loading={pending}>
          Create load
        </Button>
      </div>
    </form>
  );
}
