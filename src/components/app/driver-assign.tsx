'use client';

import { useState } from 'react';
import { AlertCircle, IdCard } from 'lucide-react';
import { assignDriverAction } from '@/app/(app)/loads/[id]/actions';
import { Card } from '@/components/ui/card';

/**
 * Who is taking this load.
 *
 * Saves on change rather than behind a button: it is one field, and a dispatch
 * board where the assignment silently failed to save because nobody pressed
 * anything is worse than an extra round trip.
 */

export interface DriverOption {
  id: string;
  displayName: string;
  employmentType: string;
}

export function DriverAssign({
  loadId,
  drivers,
  currentDriverId,
  canAssign,
}: {
  loadId: string;
  drivers: DriverOption[];
  currentDriverId: string | null;
  canAssign: boolean;
}) {
  const [driverId, setDriverId] = useState(currentDriverId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const assigned = drivers.find((driver) => driver.id === driverId) ?? null;

  const change = async (next: string) => {
    const previous = driverId;
    setDriverId(next);
    setSaving(true);
    setError(null);
    try {
      const result = await assignDriverAction(loadId, next === '' ? null : next);
      if (!result.ok) {
        setDriverId(previous);
        setError(result.error ?? 'The driver could not be assigned.');
      }
    } catch {
      setDriverId(previous);
      setError('That did not go through. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <IdCard className="size-4 text-ink-muted" aria-hidden />
            Driver
          </h2>
          <p className="mt-0.5 text-xs text-ink-secondary">
            {assigned
              ? `Pay for this load lands on ${assigned.displayName}'s settlement once it is delivered.`
              : drivers.length === 0
                ? 'No drivers on file yet.'
                : 'Nobody assigned, so this load will not appear on any settlement.'}
          </p>
        </div>

        {canAssign && drivers.length > 0 && (
          <select
            aria-label="Assign a driver"
            value={driverId}
            disabled={saving}
            onChange={(event) => void change(event.target.value)}
            className="h-10 rounded-lg border border-line bg-raised px-3 text-sm text-ink focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none disabled:opacity-60"
          >
            <option value="">Unassigned</option>
            {drivers.map((driver) => (
              <option key={driver.id} value={driver.id}>
                {driver.displayName}
                {driver.employmentType === 'owner_operator' ? ' (owner-operator)' : ''}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 border-t border-line bg-danger-soft px-5 py-3 text-xs text-danger"
        >
          <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      )}
    </Card>
  );
}
