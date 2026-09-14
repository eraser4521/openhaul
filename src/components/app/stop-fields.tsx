'use client';

import { Input } from '@/components/ui/input';

/**
 * One end of a route.
 *
 * The same fields appear on the create form and on the load screen, where an
 * address that arrived late gets filled in. Sharing the component keeps the
 * form field names — which the server action reads by prefix — in one place.
 */

export interface StopDefaults {
  name?: string | null;
  businessType?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  gateCode?: string | null;
}

export interface StopFieldsProps {
  prefix: 'pickup' | 'delivery';
  defaults?: StopDefaults | null;
  error?: string | null;
}

const BUSINESS_TYPE_LABELS: Array<[string, string]> = [
  ['business', 'Business'],
  ['dealer', 'Dealer'],
  ['auction', 'Auction'],
  ['residential', 'Residential'],
  ['port', 'Port'],
  ['terminal', 'Terminal'],
  ['repo_yard', 'Repo yard'],
];

export function StopFields({ prefix, defaults, error }: StopFieldsProps) {
  const field = (suffix: string) => `${prefix}${suffix}`;
  const value = (key: keyof StopDefaults) => defaults?.[key] ?? '';

  return (
    <div className="grid gap-4 sm:grid-cols-6">
      <div className="sm:col-span-4">
        <Input
          name={field('Name')}
          label={prefix === 'pickup' ? 'Shipper' : 'Consignee'}
          defaultValue={value('name')}
          error={error}
          placeholder={prefix === 'pickup' ? 'Cardinal Auction Dallas' : 'Desert Motors Phoenix'}
        />
      </div>

      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <label htmlFor={field('BusinessType')} className="text-sm font-medium text-ink">
          Location type
        </label>
        <select
          id={field('BusinessType')}
          name={field('BusinessType')}
          defaultValue={value('businessType') || 'business'}
          className="h-10 rounded-lg border border-line bg-raised px-3 text-sm text-ink focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
        >
          {BUSINESS_TYPE_LABELS.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className="sm:col-span-4">
        <Input
          name={field('AddressLine1')}
          label="Street address"
          defaultValue={value('addressLine1')}
          placeholder="1200 Auction Way"
        />
      </div>

      <div className="sm:col-span-2">
        <Input
          name={field('AddressLine2')}
          label="Suite"
          defaultValue={value('addressLine2')}
          placeholder="Optional"
        />
      </div>

      <div className="sm:col-span-3">
        <Input name={field('City')} label="City" defaultValue={value('city')} placeholder="Dallas" />
      </div>

      <div className="sm:col-span-1">
        <Input
          name={field('State')}
          label="State"
          maxLength={2}
          defaultValue={value('state')}
          placeholder="TX"
          className="uppercase"
        />
      </div>

      <div className="sm:col-span-2">
        <Input
          name={field('PostalCode')}
          label="ZIP"
          inputMode="numeric"
          defaultValue={value('postalCode')}
          placeholder="75201"
        />
      </div>

      <div className="sm:col-span-2">
        <Input
          name={field('ContactName')}
          label="Contact"
          defaultValue={value('contactName')}
          placeholder="Optional"
        />
      </div>

      <div className="sm:col-span-2">
        <Input
          name={field('ContactPhone')}
          label="Phone"
          type="tel"
          defaultValue={value('contactPhone')}
          placeholder="Optional"
        />
      </div>

      <div className="sm:col-span-2">
        <Input
          name={field('GateCode')}
          label="Gate code"
          defaultValue={value('gateCode')}
          placeholder="Optional"
        />
      </div>
    </div>
  );
}
