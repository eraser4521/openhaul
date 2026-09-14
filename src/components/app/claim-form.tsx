'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'motion/react';
import { AlertCircle, AlertTriangle, Info, ShieldAlert } from 'lucide-react';
import { fileClaimAction } from '@/app/(app)/claims/actions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NOT_A_CLAIM } from '@/lib/claims/validity';
import { vinDisplay } from '@/lib/utils/format';

/**
 * Filing a cargo claim.
 *
 * The date the claim was received is the most consequential field on the page
 * and the one most likely to be wrong, because a claim usually sits in an
 * inbox before anybody enters it. Every statutory deadline counts from that
 * date, not from today, so it is a real input with today only as a default.
 */

export interface ClaimableVehicle {
  id: string;
  vin: string;
  description: string;
}

export interface ClaimFormProps {
  loadId: string;
  loadNumber: string;
  vehicles: ClaimableVehicle[];
  /** Today in YYYY-MM-DD, from the server so the field has a default. */
  today: string;
  /** The load's delivery date, used to warn about the nine-month window. */
  deliveredOn: string | null;
  onCancel: () => void;
}

export function ClaimForm({
  loadId,
  loadNumber,
  vehicles,
  today,
  deliveredOn,
  onCancel,
}: ClaimFormProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (formData: FormData) => {
    setSaving(true);
    setError(null);
    try {
      const result = await fileClaimAction(formData);
      if (result.ok && result.claimId) router.push(`/claims/${result.claimId}`);
      else setError(result.error ?? 'The claim could not be filed.');
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <Card>
        <div className="border-b border-line px-5 py-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <ShieldAlert className="size-4 text-ink-muted" aria-hidden />
            File a cargo claim on {loadNumber}
          </h2>
        </div>

        <form action={submit}>
          <input type="hidden" name="loadId" value={loadId} />

          {error && (
            <p
              role="alert"
              className="flex items-start gap-2 border-b border-line bg-danger-soft px-5 py-3 text-sm text-danger"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
              {error}
            </p>
          )}

          <div className="border-b border-line bg-raised px-5 py-4">
            <p className="flex items-start gap-2 text-xs leading-relaxed text-ink-secondary">
              <Info className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>
                Under 49 CFR 370.3 a claim is a written demand that identifies the shipment, asserts
                the carrier is liable, and asks for a specific or determinable amount. These are
                <strong className="text-ink"> not </strong>
                claims and do not start the clock: {NOT_A_CLAIM.join('; ').toLowerCase()}.
              </span>
            </p>
          </div>

          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <Input
              name="claimantName"
              label="Claimant"
              required
              placeholder="Cardinal Logistics Brokerage"
              hint="Whoever made the written demand."
            />

            <Input
              name="claimantEmail"
              label="Claimant email"
              type="email"
              placeholder="claims@example.com"
              hint="Where the acknowledgement goes."
            />

            <div className="flex flex-col gap-1.5">
              <label htmlFor="vehicleId" className="text-sm font-medium text-ink">
                Vehicle
              </label>
              <select
                id="vehicleId"
                name="vehicleId"
                defaultValue={vehicles[0]?.id ?? ''}
                className="h-10 rounded-lg border border-line bg-raised px-3 text-sm text-ink focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
              >
                <option value="">Not vehicle-specific</option>
                {vehicles.map((vehicle) => (
                  <option key={vehicle.id} value={vehicle.id}>
                    {vinDisplay(vehicle.vin)} — {vehicle.description}
                  </option>
                ))}
              </select>
              <p className="text-xs text-ink-muted">
                Naming the vehicle is what lets the file assemble the two inspections.
              </p>
            </div>

            <Input
              name="demand"
              label="Amount claimed"
              inputMode="decimal"
              leading={<span className="text-sm">$</span>}
              placeholder="1850.00"
              hint="Leave blank if the demand is determinable but not stated."
            />

            <div className="sm:col-span-2">
              <Input
                name="receivedAt"
                label="Date the written claim was received"
                type="date"
                required
                defaultValue={today}
                hint="Every deadline counts from this date, not from today."
              />
            </div>
          </div>

          {deliveredOn && (
            <p className="flex items-start gap-2 border-t border-line px-5 py-3 text-xs leading-relaxed text-ink-secondary">
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
              This load was delivered on {deliveredOn}. The bill of lading allows nine months from
              delivery to file. A claim received after that is still recorded and acknowledged — the
              late filing is noted as a reserved defence rather than used to refuse it.
            </p>
          )}

          <div className="border-t border-line px-5 py-4">
            <label htmlFor="description" className="text-sm font-medium text-ink">
              What is being claimed
            </label>
            <textarea
              id="description"
              name="description"
              rows={4}
              required
              placeholder="Deep scratch to the passenger door and mirror housing, not present on the pickup inspection. Claimant attaches a repair estimate from Desert Collision."
              className="mt-2 w-full rounded-lg border border-line bg-raised px-3 py-2.5 text-sm text-ink placeholder:text-ink-muted focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
            />
          </div>

          <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
            <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" loading={saving}>
              File claim
            </Button>
          </div>
        </form>
      </Card>
    </motion.div>
  );
}
