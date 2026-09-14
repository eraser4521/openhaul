'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import { AlertCircle, MapPin, Pencil } from 'lucide-react';
import { saveRouteAction } from '@/app/(app)/loads/[id]/actions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { StopFields, type StopDefaults } from '@/components/app/stop-fields';

export interface RouteCardProps {
  loadId: string;
  pickup: StopDefaults | null;
  delivery: StopDefaults | null;
  canEdit: boolean;
}

function Summary({ label, stop }: { label: string; stop: StopDefaults | null }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">{label}</p>
      {stop ? (
        <>
          <p className="mt-1 text-sm font-medium text-ink">{stop.name}</p>
          <p className="mt-0.5 text-sm leading-relaxed text-ink-secondary">
            {stop.addressLine1}
            {stop.addressLine2 ? `, ${stop.addressLine2}` : ''}
            <br />
            {stop.city}, {stop.state} {stop.postalCode}
          </p>
          {(stop.contactName || stop.contactPhone) && (
            <p className="mt-1 text-xs text-ink-muted">
              {[stop.contactName, stop.contactPhone].filter(Boolean).join(' · ')}
            </p>
          )}
        </>
      ) : (
        <p className="mt-1 text-sm text-ink-muted">Not recorded yet</p>
      )}
    </div>
  );
}

export function RouteCard({ loadId, pickup, delivery, canEdit }: RouteCardProps) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (formData: FormData) => {
    setSaving(true);
    setError(null);
    try {
      const result = await saveRouteAction(loadId, formData);
      if (result.ok) setEditing(false);
      else setError(result.error ?? 'The route could not be saved.');
    } catch {
      setError('The route could not be saved. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <MapPin className="size-4 text-ink-muted" aria-hidden />
          Route
        </h2>
        {canEdit && !editing && (
          <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
            <Pencil aria-hidden />
            {pickup || delivery ? 'Edit' : 'Add addresses'}
          </Button>
        )}
      </div>

      {/*
        * Deliberately not wrapped in AnimatePresence with mode="wait": that
        * defers mounting the form until the summary's exit animation finishes,
        * and animation frames do not run in a background tab — so the panel
        * would simply never open for anyone who opened the load in one.
        */}
      {editing ? (
        <motion.form action={save} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          {error && (
            <p
              role="alert"
              className="flex items-start gap-2 border-b border-line bg-danger-soft px-5 py-3 text-sm text-danger"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
              {error}
            </p>
          )}

          <div className="divide-y divide-line">
            <div className="space-y-4 p-5">
              <h3 className="text-xs font-medium tracking-wide text-ink-muted uppercase">Pickup</h3>
              <StopFields prefix="pickup" defaults={pickup} />
            </div>
            <div className="space-y-4 p-5">
              <h3 className="text-xs font-medium tracking-wide text-ink-muted uppercase">
                Delivery
              </h3>
              <StopFields prefix="delivery" defaults={delivery} />
            </div>
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
              Save route
            </Button>
          </div>
        </motion.form>
      ) : (
        /* No entrance animation: this is the resting state of the card, and
           fading it in would leave it blank until frames run. */
        <div className="grid gap-5 p-5 sm:grid-cols-2">
          <Summary label="Pickup" stop={pickup} />
          <Summary label="Delivery" stop={delivery} />
        </div>
      )}
    </Card>
  );
}
