'use client';

import { useState } from 'react';
import { AlertCircle, ArrowUpRight, Info, Trash2, Undo2 } from 'lucide-react';
import { recordRefundAction, removeRefundAction } from '@/app/(app)/invoices/refund-actions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { money, relativeTime } from '@/lib/utils/format';
import { paymentMethodLabel } from '@/lib/invoices/display';
import { PAYMENT_METHODS } from '@/lib/db/schema';

/**
 * Money going back to the customer.
 *
 * Only shown when something is actually owed back or has already been sent —
 * a refund panel on an ordinary invoice is an invitation to a mistake. The
 * amount is prefilled with exactly what is owed, because the common case is
 * returning all of it and the uncommon one should be a deliberate edit.
 */

export interface RefundView {
  id: string;
  amountCents: number;
  method: string;
  reference: string | null;
  notes: string | null;
  issuedAt: string;
  creditNoteNumber: string | null;
}

export function Refunds({
  invoiceId,
  refundableCents,
  refunds,
  creditNotes,
  canWrite,
  today,
}: {
  invoiceId: string;
  /** Owed back and not yet sent. */
  refundableCents: number;
  refunds: RefundView[];
  creditNotes: Array<{ id: string; number: string; amountCents: number }>;
  canWrite: boolean;
  today: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (refundableCents === 0 && refunds.length === 0) return null;

  const send = async (formData: FormData) => {
    setBusy(true);
    setError(null);
    try {
      const result = await recordRefundAction(invoiceId, formData);
      if (result.ok) setOpen(false);
      else setError(result.error ?? 'The refund could not be recorded.');
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (refundId: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await removeRefundAction(invoiceId, refundId);
      if (!result.ok) setError(result.error ?? 'That could not be removed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">Refunds</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
            {refundableCents > 0
              ? `${money(refundableCents)} of the customer's money is being held against this invoice.`
              : 'Everything owed back on this invoice has been sent.'}
          </p>
        </div>
        {canWrite && refundableCents > 0 && !open && (
          <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
            <ArrowUpRight aria-hidden />
            Send it back
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

      {open && (
        <form action={send} className="border-b border-line bg-surface px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-6">
            <div className="sm:col-span-2">
              <Input
                name="amount"
                label="Amount"
                required
                inputMode="decimal"
                leading={<span className="text-sm">$</span>}
                defaultValue={(refundableCents / 100).toFixed(2)}
                hint={`${money(refundableCents)} is owed back.`}
              />
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="method" className="text-sm font-medium text-ink">
                How it went
              </label>
              <select
                id="method"
                name="method"
                defaultValue="check"
                className="mt-1.5 h-10 w-full rounded-lg border border-line bg-raised px-2 text-sm text-ink focus:border-brand focus:outline-none"
              >
                {PAYMENT_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {paymentMethodLabel(method)}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-2">
              <Input name="issuedAt" label="Sent on" type="date" defaultValue={today} />
            </div>

            <div className="sm:col-span-3">
              <Input
                name="reference"
                label="Reference"
                placeholder="Cheque number, ACH trace"
                hint="What proves it went."
              />
            </div>

            {creditNotes.length > 0 && (
              <div className="sm:col-span-3">
                <label htmlFor="creditNoteId" className="text-sm font-medium text-ink">
                  Against which credit
                </label>
                <select
                  id="creditNoteId"
                  name="creditNoteId"
                  defaultValue=""
                  className="mt-1.5 h-10 w-full rounded-lg border border-line bg-raised px-2 text-sm text-ink focus:border-brand focus:outline-none"
                >
                  <option value="">Not against a credit note</option>
                  {creditNotes.map((note) => (
                    <option key={note.id} value={note.id}>
                      {note.number} — {money(note.amountCents)}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="sm:col-span-6">
              <Input name="notes" label="Note" placeholder="Optional" />
            </div>
          </div>

          <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-ink-muted">
            <Info className="mt-px size-3.5 shrink-0" aria-hidden />
            This records money that has left, not an instruction to send it. The invoice keeps
            saying what the customer paid; only the position moves.
          </p>

          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={busy}>
              Record it
            </Button>
          </div>
        </form>
      )}

      {refunds.length > 0 && (
        <ul className="divide-y divide-line">
          {refunds.map((refund) => (
            <li key={refund.id} className="flex flex-wrap items-start gap-3 px-5 py-3.5">
              <Undo2 className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink">
                  {money(refund.amountCents)} by {paymentMethodLabel(refund.method)}
                  {refund.reference && (
                    <span className="text-ink-secondary"> · {refund.reference}</span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  Sent {relativeTime(new Date(refund.issuedAt))}
                  {refund.creditNoteNumber && ` · against ${refund.creditNoteNumber}`}
                </p>
                {refund.notes && <p className="mt-0.5 text-xs text-ink-secondary">{refund.notes}</p>}
              </div>
              {canWrite && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label="Remove this refund"
                  title="Recorded in error"
                  onClick={() => void remove(refund.id)}
                >
                  <Trash2 aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
