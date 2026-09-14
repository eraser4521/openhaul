'use client';

import { useState } from 'react';
import { AlertCircle, Check } from 'lucide-react';
import { saveCompanyAction } from '@/app/(app)/settings/actions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

/**
 * The company as it appears on paperwork.
 *
 * This is the "remit to" block on every invoice and the carrier block on every
 * bill of lading. A carrier with no address here cannot be paid by check, so
 * the form says which fields the documents actually use rather than leaving
 * them looking optional.
 */

export interface CompanyValues {
  legalName: string;
  dbaName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  phone: string | null;
  email: string | null;
  usdotNumber: string | null;
  mcNumber: string | null;
}

export function CompanyForm({ values, canEdit }: { values: CompanyValues; canEdit: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async (formData: FormData) => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await saveCompanyAction(formData);
      if (result.ok) setSaved(true);
      else setError(result.error ?? 'Your company details could not be saved.');
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const missingRemitTo = !values.addressLine1 || !values.city || !values.state || !values.postalCode;

  return (
    <Card>
      <div className="border-b border-line px-5 py-4">
        <h2 className="text-sm font-semibold text-ink">Company details</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
          Printed as the carrier on every bill of lading and as the remit-to address on every
          invoice.
        </p>
      </div>

      {missingRemitTo && (
        <p className="flex items-start gap-2 border-b border-line bg-warn-soft px-5 py-3 text-xs leading-relaxed text-warn">
          <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden />
          No billing address on file. Invoices will go out with nowhere to send a check.
        </p>
      )}

      {!canEdit ? (
        <div className="p-5 text-sm text-ink-secondary">
          <p className="font-medium text-ink">{values.legalName}</p>
          <p className="mt-1">
            {[values.addressLine1, values.city, values.state, values.postalCode]
              .filter(Boolean)
              .join(', ') || 'No address recorded'}
          </p>
          <p className="mt-2 text-xs text-ink-muted">Only an owner can change these.</p>
        </div>
      ) : (
        <form action={save}>
          {error && (
            <p
              role="alert"
              className="flex items-start gap-2 border-b border-line bg-danger-soft px-5 py-3 text-sm text-danger"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
              {error}
            </p>
          )}

          <div className="grid gap-4 p-5 sm:grid-cols-6">
            <div className="sm:col-span-4">
              <Input
                name="legalName"
                label="Legal name"
                required
                defaultValue={values.legalName}
                hint="As registered with the FMCSA."
              />
            </div>
            <div className="sm:col-span-2">
              <Input name="dbaName" label="Doing business as" defaultValue={values.dbaName ?? ''} />
            </div>

            <div className="sm:col-span-4">
              <Input
                name="addressLine1"
                label="Street address"
                defaultValue={values.addressLine1 ?? ''}
                placeholder="4400 Meacham Blvd"
              />
            </div>
            <div className="sm:col-span-2">
              <Input name="addressLine2" label="Suite" defaultValue={values.addressLine2 ?? ''} />
            </div>

            <div className="sm:col-span-3">
              <Input name="city" label="City" defaultValue={values.city ?? ''} />
            </div>
            <div className="sm:col-span-1">
              <Input
                name="state"
                label="State"
                maxLength={2}
                className="uppercase"
                defaultValue={values.state ?? ''}
              />
            </div>
            <div className="sm:col-span-2">
              <Input
                name="postalCode"
                label="ZIP"
                inputMode="numeric"
                defaultValue={values.postalCode ?? ''}
              />
            </div>

            <div className="sm:col-span-3">
              <Input name="phone" label="Phone" type="tel" defaultValue={values.phone ?? ''} />
            </div>
            <div className="sm:col-span-3">
              <Input name="email" label="Email" type="email" defaultValue={values.email ?? ''} />
            </div>

            <div className="sm:col-span-3">
              <Input
                name="usdotNumber"
                label="USDOT number"
                defaultValue={values.usdotNumber ?? ''}
              />
            </div>
            <div className="sm:col-span-3">
              <Input name="mcNumber" label="MC number" defaultValue={values.mcNumber ?? ''} />
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-line px-5 py-4">
            {saved && (
              <p className="flex items-center gap-1.5 text-xs text-ok">
                <Check className="size-3.5" aria-hidden />
                Saved
              </p>
            )}
            <Button type="submit" loading={saving}>
              Save company details
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
