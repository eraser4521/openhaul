import { notFound, redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import {
  inspections as inspectionsTable,
  loads as loadsTable,
  vehicles as vehiclesTable,
} from '@/lib/db/schema';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import { PageBody, PageHeader } from '@/components/app/page-header';
import { InspectionWorkbench } from '@/components/inspection/inspection-workbench';

export const metadata = { title: 'Inspection' };

export default async function InspectionPage({
  params,
}: {
  params: Promise<{ id: string; inspectionId: string }>;
}) {
  const { id: loadId, inspectionId } = await params;
  const { session, db } = await requireSessionOrRedirect();

  const inspection = await db.selectOne('inspections', eq(inspectionsTable.id, inspectionId));
  if (!inspection || inspection.loadId !== loadId) notFound();

  // A sealed report is not editable, so there is nothing to render here.
  if (inspection.finalizedAt) redirect(`/loads/${loadId}`);

  const [load, vehicle] = await Promise.all([
    db.selectOne('loads', eq(loadsTable.id, loadId)),
    db.selectOne('vehicles', eq(vehiclesTable.id, inspection.vehicleId)),
  ]);

  if (!load || !vehicle) notFound();

  const vehicleLabel =
    [vehicle.year, vehicle.make, vehicle.model, vehicle.color].filter(Boolean).join(' ') ||
    'Vehicle details not decoded';

  return (
    <>
      <PageHeader
        title={inspection.stage === 'pickup' ? 'Pickup inspection' : 'Delivery inspection'}
        description="Work through the walk-around. Everything is saved on this device as you go."
      />
      <PageBody className="max-w-3xl">
        <InspectionWorkbench
          inspectionId={inspection.id}
          orgId={session.orgId}
          loadId={loadId}
          loadNumber={load.number}
          vehicleId={vehicle.id}
          vin={vehicle.vin}
          vehicleLabel={vehicleLabel}
          stage={inspection.stage}
          tier={inspection.tier}
        />
      </PageBody>
    </>
  );
}
