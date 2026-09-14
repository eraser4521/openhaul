'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Camera, Check, CloudOff, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { captureExpense } from '@/lib/offline/capture';
import {
  discardLocalExpense,
  flushOutbox,
  pendingExpenses,
  retryFailedExpenses,
} from '@/lib/offline/outbox';
import type { LocalExpense } from '@/lib/offline/db';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { CATEGORY_LABEL, CATEGORY_NOTE } from '@/lib/expenses/categories';
import { EXPENSE_CATEGORIES, type ExpenseCategory } from '@/lib/db/schema';

/**
 * Recording what was spent, from the cab.
 *
 * Saved to the device first and uploaded afterwards, on the same queue that
 * carries inspection photos. A driver at a pump on the edge of coverage gets
 * the figure recorded whatever the signal does; losing it because a request
 * timed out would mean losing the reimbursement.
 *
 * The receipt is optional on purpose. A driver who has lost the paper should
 * still record the cost — a claim with no receipt is weaker than one with, and
 * far stronger than a figure nobody wrote down.
 */

export interface LoadOption {
  id: string;
  number: string;
}

export function ExpenseCapture({ loads, defaultLoadId }: { loads: LoadOption[]; defaultLoadId?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [queue, setQueue] = useState<LocalExpense[]>([]);
  const [receiptName, setReceiptName] = useState<string | null>(null);
  const [category, setCategory] = useState<ExpenseCategory>('fuel');

  const fileInput = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const refreshQueue = async () => {
    try {
      setQueue(await pendingExpenses());
    } catch {
      // No IndexedDB — a locked-down browser or a private window. Capture will
      // fail loudly when tried; there is nothing useful to say here.
    }
  };

  /*
   * The local queue is an external store, so this reads it and subscribes to
   * its own poll rather than deriving anything. A flag guards the unmount,
   * because a driver leaving the screen mid-read should not set state on a
   * component that has gone.
   */
  useEffect(() => {
    let live = true;

    const read = () => {
      pendingExpenses()
        .then((rows) => {
          if (live) setQueue(rows);
        })
        .catch(() => {});
    };

    read();
    const timer = setInterval(read, 5000);

    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  const submit = async (formData: FormData) => {
    setBusy(true);
    setError(null);
    setSaved(false);

    try {
      const amount = String(formData.get('amount') ?? '').trim();
      if (!/^[0-9]+(\.[0-9]{1,2})?$/.test(amount)) {
        setError('Enter what it cost, like 84.50.');
        return;
      }

      const file = fileInput.current?.files?.[0] ?? null;

      await captureExpense({
        loadId: String(formData.get('loadId') ?? '') || null,
        category: String(formData.get('category') ?? 'fuel'),
        amount,
        incurredAt: String(formData.get('incurredAt') ?? ''),
        vendor: String(formData.get('vendor') ?? '').trim() || null,
        notes: String(formData.get('notes') ?? '').trim() || null,
        file,
      });

      setSaved(true);
      setOpen(false);
      setReceiptName(null);
      formRef.current?.reset();
      await refreshQueue();

      // Best effort: if there is signal it goes now, and if not the outbox
      // will carry it. Either way the driver is done.
      void flushOutbox().then(() => {
        void refreshQueue();
        router.refresh();
      });
    } catch {
      setError('That could not be saved on this device. Check storage and try again.');
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    setBusy(true);
    try {
      await retryFailedExpenses();
      await flushOutbox();
      await refreshQueue();
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const discard = async (id: string) => {
    await discardLocalExpense(id);
    await refreshQueue();
  };

  const today = new Date().toISOString().slice(0, 10);
  const stuck = queue.filter((row) => row.uploadState === 'failed');

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">Record what you spent</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
            Saved on this phone first and sent when there is signal, so a yard with no bars does
            not cost you the money back.
          </p>
        </div>
        {!open && (
          <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
            <Plus aria-hidden />
            Add
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

      {saved && !open && (
        <p className="flex items-center gap-2 border-b border-line bg-ok-soft px-5 py-3 text-sm text-ok">
          <Check className="size-4 shrink-0" aria-hidden />
          Saved on this device.
        </p>
      )}

      {open && (
        <form action={submit} ref={formRef} className="border-b border-line px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-6">
            <div className="sm:col-span-3">
              <label htmlFor="category" className="text-sm font-medium text-ink">
                What for
              </label>
              <select
                id="category"
                name="category"
                value={category}
                onChange={(event) => setCategory(event.target.value as ExpenseCategory)}
                className="mt-1.5 h-11 w-full rounded-lg border border-line bg-raised px-2 text-base text-ink focus:border-brand focus:outline-none"
              >
                {EXPENSE_CATEGORIES.map((option) => (
                  <option key={option} value={option}>
                    {CATEGORY_LABEL[option]}
                  </option>
                ))}
              </select>
              {CATEGORY_NOTE[category] && (
                <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
                  {CATEGORY_NOTE[category]}
                </p>
              )}
            </div>

            <div className="sm:col-span-3">
              <Input
                name="amount"
                label="How much"
                required
                inputMode="decimal"
                placeholder="84.50"
                leading={<span className="text-sm">$</span>}
              />
            </div>

            <div className="sm:col-span-3">
              <Input name="incurredAt" label="When" type="date" required defaultValue={today} />
            </div>

            <div className="sm:col-span-3">
              <label htmlFor="loadId" className="text-sm font-medium text-ink">
                Which load
              </label>
              <select
                id="loadId"
                name="loadId"
                defaultValue={defaultLoadId ?? ''}
                className="mt-1.5 h-11 w-full rounded-lg border border-line bg-raised px-2 text-base text-ink focus:border-brand focus:outline-none"
              >
                <option value="">Not against a load</option>
                {loads.map((load) => (
                  <option key={load.id} value={load.id}>
                    {load.number}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-3">
              <Input name="vendor" label="Where" placeholder="Pilot #412" />
            </div>

            <div className="sm:col-span-3">
              <Input name="notes" label="Note" placeholder="Optional" />
            </div>

            <div className="sm:col-span-6">
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(event) => setReceiptName(event.target.files?.[0]?.name ?? null)}
              />
              <Button
                type="button"
                variant="secondary"
                className="w-full sm:w-auto"
                onClick={() => fileInput.current?.click()}
              >
                <Camera aria-hidden />
                {receiptName ? 'Receipt attached' : 'Photograph the receipt'}
              </Button>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
                Optional. Record the cost even if the receipt has gone — a figure with no receipt
                is weaker than one with, and far better than nothing written down.
              </p>
            </div>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Save it
            </Button>
          </div>
        </form>
      )}

      {queue.length > 0 && (
        <div className="px-5 py-4">
          <p className="flex items-center gap-2 text-xs font-medium tracking-wide text-ink-muted uppercase">
            <CloudOff className="size-3.5" aria-hidden />
            On this device, not sent yet
          </p>

          <ul className="mt-2 space-y-2">
            {queue.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm text-ink">
                    {CATEGORY_LABEL[row.category as keyof typeof CATEGORY_LABEL] ?? row.category} ·
                    ${row.amount}
                  </p>
                  <p className="text-xs text-ink-muted">
                    {row.uploadState === 'failed'
                      ? (row.lastError ?? 'Could not send')
                      : 'Waiting for signal'}
                    {row.receipt ? ' · receipt attached' : ''}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Discard this entry"
                  onClick={() => void discard(row.id)}
                >
                  <Trash2 aria-hidden />
                </Button>
              </li>
            ))}
          </ul>

          {stuck.length > 0 && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-3"
              loading={busy}
              onClick={() => void retry()}
            >
              <RefreshCw aria-hidden />
              Try sending again
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
