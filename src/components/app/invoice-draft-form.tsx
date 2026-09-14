'use client';

import { useMemo, useState } from 'react';
import { AlertCircle, Info, Send } from 'lucide-react';
import { issueInvoiceAction, saveDraftAction } from '@/app/(app)/invoices/actions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PAYMENT_TERMS } from '@/lib/db/schema';
import { parseMoney, totalCents, grossCents } from '@/lib/invoices/compute';
import { termsLabel } from '@/lib/invoices/terms';
import { money } from '@/lib/utils/format';

/**
 * The figures, while they can still be corrected.
 *
 * A draft is editable and an issued invoice is not, because the customer is
 * holding a document that states these numbers. The running total is computed
 * here from what is typed so the person raising it sees the figure the broker
 * will see, before it is sent rather than after.
 */

export interface InvoiceDraftValues {
  lineHaulCents: number;
  fuelSurchargeCents: number;
  accessorialCents: number;
  taxCents: number;
  codCollectedCents: number;
  depositCents: number;
  terms: string | null;
  factoringCompanyName: string | null;
  factoringNoticeText: string | null;
  notes: string | null;
}

export interface InvoiceDraftFormProps {
  invoiceId: string;
  values: InvoiceDraftValues;
  /** Which load figure the line haul came from, stated rather than assumed. */
  basisNote: string;
  /**
   * True once the invoice carries itemised accessorial lines.
   *
   * The figure is then the sum of those lines and typing over it would put a
   * total on the invoice that its own breakdown contradicts. The server
   * re-derives it regardless; this is what stops somebody wondering why their
   * edit did not stick.
   */
  accessorialsItemised?: boolean;
}

const dollars = (cents: number) => (cents / 100).toFixed(2);

const AMOUNT_FIELDS = [
  { name: 'lineHaul', label: 'Line haul', key: 'lineHaulCents' },
  { name: 'fuelSurcharge', label: 'Fuel surcharge', key: 'fuelSurchargeCents' },
  { name: 'accessorial', label: 'Accessorials', key: 'accessorialCents' },
  { name: 'tax', label: 'Tax', key: 'taxCents' },
] as const;

const CREDIT_FIELDS = [
  { name: 'codCollected', label: 'Collected on delivery', key: 'codCollectedCents' },
  { name: 'deposit', label: 'Deposit held', key: 'depositCents' },
] as const;

export function InvoiceDraftForm({
  invoiceId,
  values,
  basisNote,
  accessorialsItemised = false,
}: InvoiceDraftFormProps) {
  const [amounts, setAmounts] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const field of [...AMOUNT_FIELDS, ...CREDIT_FIELDS]) {
      initial[field.name] = dollars(values[field.key]);
    }
    return initial;
  });

  const [factor, setFactor] = useState(values.factoringCompanyName ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'issue' | null>(null);

  /*
   * Itemised accessorials are read from the server on every render rather than
   * held in this form's state. Adding a line changes the figure server-side,
   * and a value captured when the form first mounted would leave the carrier
   * looking at $0.00 beside a list of charges that plainly is not nothing.
   */
  const accessorialText = accessorialsItemised
    ? dollars(values.accessorialCents)
    : (amounts.accessorial ?? '');

  const preview = useMemo(() => {
    const cents = (name: string) => parseMoney(amounts[name] ?? '') ?? 0;
    const charges = {
      lineHaulCents: cents('lineHaul'),
      fuelSurchargeCents: cents('fuelSurcharge'),
      accessorialCents: accessorialsItemised
        ? values.accessorialCents
        : cents('accessorial'),
      taxCents: cents('tax'),
      codCollectedCents: cents('codCollected'),
      depositCents: cents('deposit'),
    };
    return { gross: grossCents(charges), total: totalCents(charges) };
  }, [amounts, accessorialsItemised, values.accessorialCents]);

  const unparseable = Object.entries(amounts).find(
    ([, value]) => value.trim() !== '' && parseMoney(value) === null,
  );

  const submit = async (formData: FormData, intent: 'save' | 'issue') => {
    setBusy(intent);
    setError(null);
    try {
      const saved = await saveDraftAction(invoiceId, formData);
      if (!saved.ok) {
        setError(saved.error ?? 'The invoice could not be saved.');
        return;
      }
      if (intent === 'issue') {
        const issued = await issueInvoiceAction(invoiceId);
        if (!issued.ok) setError(issued.error ?? 'The invoice could not be issued.');
      }
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <form
      action={(formData) => void submit(formData, 'save')}
      className="space-y-4"
      id="invoice-draft"
    >
      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}

      <Card>
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-sm font-semibold text-ink">Charges</h2>
          <p className="mt-0.5 flex items-start gap-1.5 text-xs text-ink-secondary">
            <Info className="mt-px size-3.5 shrink-0" aria-hidden />
            {basisNote}
          </p>
        </div>

        <div className="grid gap-4 p-5 sm:grid-cols-2">
          {AMOUNT_FIELDS.map((field) => {
            const locked = accessorialsItemised && field.name === 'accessorial';

            return (
              <Input
                key={field.name}
                name={field.name}
                label={field.label}
                inputMode="decimal"
                readOnly={locked}
                leading={<span className="text-sm">$</span>}
                value={locked ? accessorialText : (amounts[field.name] ?? '')}
                onChange={(event) =>
                  setAmounts((current) => ({ ...current, [field.name]: event.target.value }))
                }
                hint={locked ? 'Added up from the itemised charges below.' : undefined}
                error={
                  !locked &&
                  (amounts[field.name] ?? '').trim() !== '' &&
                  parseMoney(amounts[field.name] ?? '') === null
                    ? 'Not an amount'
                    : undefined
                }
              />
            );
          })}
        </div>

        <div className="border-t border-line px-5 py-4">
          <h3 className="text-xs font-medium tracking-wide text-ink-muted uppercase">
            Already collected
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
            Credited against the total rather than recorded as a payment, because the money never
            went through this invoice.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {CREDIT_FIELDS.map((field) => (
              <Input
                key={field.name}
                name={field.name}
                label={field.label}
                inputMode="decimal"
                leading={<span className="text-sm">$</span>}
                value={amounts[field.name] ?? ''}
                onChange={(event) =>
                  setAmounts((current) => ({ ...current, [field.name]: event.target.value }))
                }
              />
            ))}
          </div>
        </div>

        <dl className="flex flex-wrap items-center justify-end gap-x-8 gap-y-2 border-t border-line bg-raised px-5 py-4 text-sm">
          <div className="flex items-center gap-2">
            <dt className="text-ink-secondary">Charges</dt>
            <dd className="font-medium text-ink tabular-nums">{money(preview.gross)}</dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="font-medium text-ink">Total invoiced</dt>
            <dd className="text-base font-semibold text-ink tabular-nums">
              {money(preview.total)}
            </dd>
          </div>
        </dl>
      </Card>

      <Card>
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-sm font-semibold text-ink">Terms and assignment</h2>
        </div>

        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="terms" className="text-sm font-medium text-ink">
              Payment terms
            </label>
            <select
              id="terms"
              name="terms"
              defaultValue={values.terms ?? ''}
              className="h-10 rounded-lg border border-line bg-raised px-3 text-sm text-ink focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
            >
              <option value="">Per agreement</option>
              {PAYMENT_TERMS.map((term) => (
                <option key={term} value={term}>
                  {termsLabel(term)}
                </option>
              ))}
            </select>
            <p className="text-xs text-ink-muted">Sets the due date when the invoice is issued.</p>
          </div>

          <Input
            name="factoringCompanyName"
            label="Factoring company"
            placeholder="Leave blank if not factored"
            value={factor}
            onChange={(event) => setFactor(event.target.value)}
            hint="Adds a Notice of Assignment to the face of the invoice."
          />
        </div>

        {factor.trim() !== '' && (
          <div className="border-t border-line px-5 py-4">
            <label htmlFor="factoringNoticeText" className="text-sm font-medium text-ink">
              Notice of Assignment wording
            </label>
            <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
              Factors issue their own wording and require it reproduced exactly. Leave this blank
              and a standard notice naming {factor.trim()} is printed instead.
            </p>
            <textarea
              id="factoringNoticeText"
              name="factoringNoticeText"
              rows={3}
              defaultValue={values.factoringNoticeText ?? ''}
              className="mt-3 w-full rounded-lg border border-line bg-raised px-3 py-2.5 text-sm text-ink placeholder:text-ink-muted focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
            />
          </div>
        )}

        <div className="border-t border-line px-5 py-4">
          <label htmlFor="notes" className="text-sm font-medium text-ink">
            Notes on the invoice
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={2}
            defaultValue={values.notes ?? ''}
            placeholder="Detention, extra stops, anything the broker will ask about."
            className="mt-2 w-full rounded-lg border border-line bg-raised px-3 py-2.5 text-sm text-ink placeholder:text-ink-muted focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
          />
        </div>
      </Card>

      <div className="flex flex-wrap justify-end gap-3">
        <Button type="submit" variant="secondary" loading={busy === 'save'} disabled={busy !== null}>
          Save draft
        </Button>
        <Button
          type="submit"
          size="lg"
          loading={busy === 'issue'}
          disabled={busy !== null || unparseable !== undefined}
          formAction={(formData) => void submit(formData, 'issue')}
        >
          <Send aria-hidden />
          Issue invoice
        </Button>
      </div>

      <p className="text-right text-xs text-ink-muted">
        Issuing freezes a PDF and starts the clock on the terms. After that the figures can only be
        changed by voiding this invoice and raising another.
      </p>
    </form>
  );
}
