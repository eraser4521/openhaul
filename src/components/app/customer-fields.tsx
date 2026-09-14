'use client';

import { Input } from '@/components/ui/input';
import { PAYMENT_TERMS } from '@/lib/db/schema';
import { termsLabel } from '@/lib/invoices/terms';

/**
 * The party that pays.
 *
 * Shared by the create form and the load screen, so the field names the server
 * action reads by prefix live in one place. Only the name is needed to book a
 * load; the rest is what an invoice needs, and it can arrive later.
 */

export interface CustomerDefaults {
  name?: string | null;
  kind?: string | null;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  mcNumber?: string | null;
  usdotNumber?: string | null;
  defaultPaymentTerms?: string | null;
}

const KINDS: Array<[string, string]> = [
  ['broker', 'Broker'],
  ['shipper', 'Shipper'],
  ['dealer', 'Dealer'],
  ['auction', 'Auction'],
  ['private', 'Private party'],
];

export function CustomerFields({
  defaults,
  error,
}: {
  defaults?: CustomerDefaults | null;
  error?: string | null;
}) {
  const value = (key: keyof CustomerDefaults) => defaults?.[key] ?? '';

  return (
    <div className="grid gap-4 sm:grid-cols-6">
      <div className="sm:col-span-4">
        <Input
          name="customerName"
          label="Customer"
          defaultValue={value('name')}
          error={error}
          placeholder="Cardinal Logistics Brokerage"
          hint="Who the invoice is addressed to."
        />
      </div>

      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <label htmlFor="customerKind" className="text-sm font-medium text-ink">
          Type
        </label>
        <select
          id="customerKind"
          name="customerKind"
          defaultValue={value('kind') || 'broker'}
          className="h-10 rounded-lg border border-line bg-raised px-3 text-sm text-ink focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
        >
          {KINDS.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className="sm:col-span-3">
        <Input
          name="customerContactName"
          label="Contact"
          defaultValue={value('contactName')}
          placeholder="Optional"
        />
      </div>

      <div className="sm:col-span-3">
        <Input
          name="customerEmail"
          label="Email for invoices"
          type="email"
          defaultValue={value('email')}
          placeholder="ap@example.com"
        />
      </div>

      <div className="sm:col-span-2">
        <Input
          name="customerPhone"
          label="Phone"
          type="tel"
          defaultValue={value('phone')}
          placeholder="Optional"
        />
      </div>

      <div className="sm:col-span-2">
        <Input
          name="customerMcNumber"
          label="MC number"
          defaultValue={value('mcNumber')}
          placeholder="Optional"
        />
      </div>

      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <label htmlFor="customerDefaultPaymentTerms" className="text-sm font-medium text-ink">
          Payment terms
        </label>
        <select
          id="customerDefaultPaymentTerms"
          name="customerDefaultPaymentTerms"
          defaultValue={value('defaultPaymentTerms') || ''}
          className="h-10 rounded-lg border border-line bg-raised px-3 text-sm text-ink focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
        >
          <option value="">Per agreement</option>
          {PAYMENT_TERMS.map((term) => (
            <option key={term} value={term}>
              {termsLabel(term)}
            </option>
          ))}
        </select>
      </div>

      <div className="sm:col-span-3">
        <Input
          name="customerAddressLine1"
          label="Billing address"
          defaultValue={value('addressLine1')}
          placeholder="400 Commerce St"
        />
      </div>

      <div className="sm:col-span-1">
        <Input
          name="customerCity"
          label="City"
          defaultValue={value('city')}
          placeholder="Dallas"
        />
      </div>

      <div className="sm:col-span-1">
        <Input
          name="customerState"
          label="State"
          maxLength={2}
          defaultValue={value('state')}
          placeholder="TX"
          className="uppercase"
        />
      </div>

      <div className="sm:col-span-1">
        <Input
          name="customerPostalCode"
          label="ZIP"
          inputMode="numeric"
          defaultValue={value('postalCode')}
          placeholder="75201"
        />
      </div>
    </div>
  );
}
