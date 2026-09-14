import { notFound, redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { AlertTriangle, Check, ClipboardCheck, Wrench } from 'lucide-react';
import {
  inspections as inspectionsTable,
  loads as loadsTable,
  vehicles as vehiclesTable,
} from '@/lib/db/schema';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import { PageBody, PageHeader } from '@/components/app/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { vinDisplay } from '@/lib/utils/format';
import { startInspectionAction } from './actions';

export const metadata = { title: 'Inspect' };

/**
 * Pick the vehicle and the leg.
 *
 * A load carries up to ten vehicles and each needs its own condition report at
 * each end, so this is the fork before the walk-around rather than a step
 * inside it.
 */
export default async function InspectPickerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: loadId } = await params;
  const { db } = await requireSessionOrRedirect();

  const load = await db.selectOne('loads', eq(loadsTable.id, loadId));
  if (!load) notFound();

  const vehicles = await db.select('vehicles', eq(vehiclesTable.loadId, loadId));
  const inspections = await db.select('inspections', eq(inspectionsTable.loadId, loadId));

  const statusFor = (vehicleId: string, stage: 'pickup' | 'delivery') =>
    inspections.find((i) => i.vehicleId === vehicleId && i.stage === stage) ?? null;

  async function begin(formData: FormData) {
    'use server';

    const result = await startInspectionAction({
      loadId,
      vehicleId: String(formData.get('vehicleId') ?? ''),
      stage: String(formData.get('stage') ?? 'pickup'),
    });

    if (!result.ok || !result.inspectionId) {
      // Falls back to this page, where the existing report is already shown as
      // sealed — which is the only reason starting one fails.
      redirect(`/loads/${loadId}/inspect`);
    }

    redirect(`/loads/${loadId}/inspect/${result.inspectionId}`);
  }

  return (
    <>
      <PageHeader
        title={`Inspect ${load.number}`}
        description="One condition report per vehicle, per leg. Pickup is the one that clears you of pre-existing damage."
      />

      <PageBody className="max-w-3xl space-y-3">
        {vehicles.length === 0 && (
          <Card className="px-6 py-12 text-center">
            <ClipboardCheck className="mx-auto size-8 text-ink-muted" aria-hidden />
            <p className="mt-3 text-sm text-ink-secondary">This load has no vehicles on it yet.</p>
          </Card>
        )}

        {vehicles.map((vehicle) => {
          const pickup = statusFor(vehicle.id, 'pickup');
          const delivery = statusFor(vehicle.id, 'delivery');

          return (
            <Card key={vehicle.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-sm break-all text-ink">{vinDisplay(vehicle.vin)}</p>
                  <p className="mt-0.5 text-xs text-ink-secondary">
                    {[vehicle.year, vehicle.make, vehicle.model, vehicle.color]
                      .filter(Boolean)
                      .join(' ') || 'Details not decoded'}
                  </p>
                </div>
                <div className="flex gap-1.5">
                  {vehicle.isInoperable && (
                    <Badge tone="info" size="sm">
                      <Wrench aria-hidden />
                      Inoperable
                    </Badge>
                  )}
                  {vehicle.vinCheckDigitValid === false && (
                    <Badge tone="warn" size="sm">
                      <AlertTriangle aria-hidden />
                      VIN unverified
                    </Badge>
                  )}
                </div>
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {(
                  [
                    ['pickup', 'Pickup', pickup],
                    ['delivery', 'Delivery', delivery],
                  ] as const
                ).map(([stage, label, existing]) => {
                  const sealed = existing?.finalizedAt != null;

                  return (
                    <form action={begin} key={stage}>
                      <input type="hidden" name="vehicleId" value={vehicle.id} />
                      <input type="hidden" name="stage" value={stage} />
                      <Button
                        type="submit"
                        block
                        variant={sealed ? 'secondary' : existing ? 'outline' : 'primary'}
                        disabled={sealed}
                      >
                        {sealed ? (
                          <>
                            <Check aria-hidden />
                            {label} sealed
                          </>
                        ) : existing ? (
                          <>Resume {label.toLowerCase()}</>
                        ) : (
                          <>Start {label.toLowerCase()}</>
                        )}
                      </Button>
                    </form>
                  );
                })}
              </div>
            </Card>
          );
        })}
      </PageBody>
    </>
  );
}
