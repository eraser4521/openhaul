'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import { AlertCircle, Building2, Pencil, Receipt } from 'lucide-react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { saveBillToAction } from '@/app/(app)/loads/[id]/actions';
import { createInvoiceAction } from '@/app/(app)/invoices/actions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CustomerFields, type CustomerDefaults } from '@/components/app/customer-fields';
import { termsLabel } from '@/lib/invoices/terms';
import type { PaymentTerms } from '@/lib/db/schema';

export interface ExistingInvoice {
  id: string;
  number: string;
  status: string;
}

export interface BillToCardProps {
  loadId: string;
  customer: CustomerDefaults | null;
  invoice: ExistingInvoice | null;
  canEdit: boolean;
  canInvoice: boolean;
}

export function BillToCard({ loadId, customer, invoice, canEdit, canInvoice }: BillToCardProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [raising, setRaising] = useState(false);

  const save = async (formData: FormData) => {
    setSaving(true);
    setError(null);
    try {
      const result = await saveBillToAction(loadId, formData);
      if (result.ok) setEditing(false);
      else setError(result.error ?? 'The customer could not be saved.');
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const raise = async () => {
    setRaising(true);
    setError(null);
    try {
      const result = await createInvoiceAction(loadId);
      if (result.ok && result.invoiceId) router.push(`/invoices/${result.invoiceId}`);
      else setError(result.error ?? 'The invoice could not be raised.');
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setRaising(false);
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Building2 className="size-4 text-ink-muted" aria-hidden />
          Bill to
        </h2>

        <div className="flex flex-wrap gap-2">
          {canEdit && !editing && (
            <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
              <Pencil aria-hidden />
              {customer ? 'Edit' : 'Add a customer'}
            </Button>
          )}

          {invoice ? (
            <Link
              href={`/invoices/${invoice.id}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs text-ink-secondary transition-colors hover:border-line-strong hover:text-ink"
            >
              <Receipt className="size-3.5" aria-hidden />
              {invoice.number}
            </Link>
          ) : (
            canInvoice &&
            !editing && (
              <Button
                type="button"
                size="sm"
                onClick={() => void raise()}
                loading={raising}
                disabled={raising}
              >
                <Receipt aria-hidden />
                Raise invoice
              </Button>
            )
          )}
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 border-b border-line bg-warn-soft px-5 py-3 text-xs leading-relaxed text-warn"
        >
          <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      )}

      {/*
        Not gated on an exit animation: animation frames do not run in a
        background tab, so a panel that waits for one never opens there.
      */}
      {editing ? (
        <motion.form action={save} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <div className="p-5">
            <CustomerFields defaults={customer} />
          </div>
          <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setEditing(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" loading={saving}>
              Save customer
            </Button>
          </div>
        </motion.form>
      ) : (
        <div className="p-5">
          {customer ? (
            <>
              <p className="text-sm font-medium text-ink">{customer.name}</p>
              <p className="mt-0.5 text-sm leading-relaxed text-ink-secondary">
                {[customer.addressLine1, [customer.city, customer.state, customer.postalCode].filter(Boolean).join(' ')]
                  .filter(Boolean)
                  .join(', ') || 'No billing address recorded'}
              </p>
              <p className="mt-1 text-xs text-ink-muted">
                {[
                  customer.contactName,
                  customer.email,
                  customer.mcNumber ? `MC ${customer.mcNumber}` : null,
                  customer.defaultPaymentTerms
                    ? termsLabel(customer.defaultPaymentTerms as PaymentTerms)
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </>
          ) : (
            <p className="text-sm text-ink-muted">
              No customer on this load yet. An invoice needs somebody to address it to.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
