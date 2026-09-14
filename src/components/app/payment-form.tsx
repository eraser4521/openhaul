'use client';

import { useState } from 'react';
import { AlertCircle, Ban, BadgeCheck, Plus } from 'lucide-react';
import { recordPaymentAction, voidInvoiceAction } from '@/app/(app)/invoices/actions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PAYMENT_METHODS } from '@/lib/db/schema';
import { money } from '@/lib/utils/format';
import { paymentMethodLabel } from '@/lib/invoices/display';

export interface PaymentFormProps {
  invoiceId: string;
  balanceCents: number;
  /** Today in YYYY-MM-DD, computed on the server so the field has a default. */
  today: string;
}

/**
 * Recording money that arrived.
 *
 * The amount defaults to the outstanding balance because a broker usually pays
 * in full, and a short payment is the thing worth typing deliberately.
 */
export function PaymentForm({ invoiceId, balanceCents, today }: PaymentFormProps) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  const record = async (formData: FormData) => {
    setSaving(true);
    setError(null);
    try {
      const result = await recordPaymentAction(invoiceId, formData);
      if (result.ok) setOpen(false);
      else setError(result.error ?? 'The payment could not be recorded.');
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        <Plus aria-hidden />
        Record a payment
      </Button>
    );
  }

  return (
    <Card>
      <div className="border-b border-line px-5 py-4">
        <h2 className="text-sm font-semibold text-ink">Record a payment</h2>
      </div>

      <form action={record}>
        {error && (
          <p
            role="alert"
            className="flex items-start gap-2 border-b border-line bg-danger-soft px-5 py-3 text-sm text-danger"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {error}
          </p>
        )}

        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Input
            name="amount"
            label="Amount received"
            inputMode="decimal"
            required
            defaultValue={(Math.max(0, balanceCents) / 100).toFixed(2)}
            leading={<span className="text-sm">$</span>}
            hint={`Balance outstanding is ${money(balanceCents)}`}
          />

          <div className="flex flex-col gap-1.5">
            <label htmlFor="method" className="text-sm font-medium text-ink">
              Method
            </label>
            <select
              id="method"
              name="method"
              defaultValue="ach"
              className="h-10 rounded-lg border border-line bg-raised px-3 text-sm text-ink focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
            >
              {PAYMENT_METHODS.map((method) => (
                <option key={method} value={method}>
                  {paymentMethodLabel(method)}
                </option>
              ))}
            </select>
          </div>

          <Input
            name="reference"
            label="Reference"
            placeholder="Check or trace number"
            hint="What you would quote when chasing it."
          />

          <Input name="receivedAt" label="Date received" type="date" defaultValue={today} />
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            <BadgeCheck aria-hidden />
            Record payment
          </Button>
        </div>
      </form>
    </Card>
  );
}

export interface VoidInvoiceProps {
  invoiceId: string;
  /**
   * Why voiding is unavailable, or null when it is.
   *
   * A reason rather than a flag: the rules are all about money attached to
   * the invoice, there is more than one of them, and the screen has no
   * business restating any of them in its own words.
   */
  blockedReason: string | null;
}

/**
 * Voiding, which is not deleting.
 *
 * The invoice stays on the record with the reason attached, because a number
 * that was sent to a customer and then vanished is exactly what an audit
 * queries.
 */
export function VoidInvoice({ invoiceId, blockedReason }: VoidInvoiceProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (blockedReason) {
    return <p className="text-xs leading-relaxed text-ink-muted">{blockedReason}</p>;
  }

  if (!open) {
    return (
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Ban aria-hidden />
        Void this invoice
      </Button>
    );
  }

  const submit = async (formData: FormData) => {
    setSaving(true);
    setError(null);
    try {
      const result = await voidInvoiceAction(invoiceId, formData);
      if (result.ok) setOpen(false);
      else setError(result.error ?? 'The invoice could not be voided.');
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form action={submit} className="space-y-3">
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <Input
        name="reason"
        label="Why is this being voided?"
        required
        placeholder="Wrong rate — reissuing against the signed rate confirmation."
        hint="Kept on the record with the invoice."
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="secondary" size="sm" loading={saving}>
          Void invoice
        </Button>
      </div>
    </form>
  );
}
