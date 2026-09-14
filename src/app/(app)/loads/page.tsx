import Link from 'next/link';
import { ArrowRight, Plus, Truck, Upload } from 'lucide-react';
import { inArray } from 'drizzle-orm';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import { vehicles as vehiclesTable, type LoadStatus } from '@/lib/db/schema';
import { EmptyState, PageBody, PageHeader } from '@/components/app/page-header';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { money, miles, ratePerMile, relativeTime } from '@/lib/utils/format';

export const metadata = { title: 'Loads' };

const STATUS_TONE: Record<LoadStatus, 'neutral' | 'brand' | 'ok' | 'warn' | 'info' | 'danger'> = {
  draft: 'neutral',
  posted: 'neutral',
  offered: 'info',
  accepted: 'info',
  dispatched: 'brand',
  picked_up: 'warn',
  in_transit: 'info',
  delivered: 'ok',
  invoiced: 'ok',
  delivery_verified: 'ok',
  paid: 'ok',
  cancelled: 'danger',
  declined: 'danger',
};

function statusLabel(status: LoadStatus): string {
  return status.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export default async function LoadsPage() {
  const { db } = await requireSessionOrRedirect();

  const allLoads = await db.select('loads');
  const sorted = [...allLoads].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  // One query for every vehicle on the page rather than one per load.
  const loadIds = sorted.map((l) => l.id);
  const vehicles =
    loadIds.length > 0 ? await db.select('vehicles', inArray(vehiclesTable.loadId, loadIds)) : [];

  const vehiclesByLoad = new Map<string, number>();
  for (const vehicle of vehicles) {
    vehiclesByLoad.set(vehicle.loadId, (vehiclesByLoad.get(vehicle.loadId) ?? 0) + 1);
  }

  return (
    <>
      <PageHeader
        title="Loads"
        description={`${allLoads.length} load${allLoads.length === 1 ? '' : 's'} on the books`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              href="/loads/import"
              className={cn(buttonVariants({ variant: 'secondary' }))}
            >
              <Upload aria-hidden />
              Import
            </Link>
            <Link href="/loads/new" className={cn(buttonVariants())}>
              <Plus aria-hidden />
              New load
            </Link>
          </div>
        }
      />

      <PageBody>
        {sorted.length === 0 ? (
          <EmptyState
            icon={Truck}
            title="No loads yet"
            description="Create your first load, or import a dispatch sheet you already have. Enter or scan each VIN and OpenHaul fills in the year, make and model from NHTSA automatically."
            action={
              <Link href="/loads/new" className={cn(buttonVariants())}>
                <Plus aria-hidden />
                Create a load
              </Link>
            }
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-line">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">All loads for this organisation</caption>
              <thead>
                <tr className="border-b border-line bg-sunken/60">
                  <th scope="col" className="px-4 py-3 text-xs font-medium text-ink-secondary">
                    Reference
                  </th>
                  <th scope="col" className="px-4 py-3 text-xs font-medium text-ink-secondary">
                    Status
                  </th>
                  <th
                    scope="col"
                    className="hidden px-4 py-3 text-xs font-medium text-ink-secondary sm:table-cell"
                  >
                    Units
                  </th>
                  <th
                    scope="col"
                    className="hidden px-4 py-3 text-xs font-medium text-ink-secondary md:table-cell"
                  >
                    Distance
                  </th>
                  <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-ink-secondary">
                    Rate
                  </th>
                  <th scope="col" className="w-10 px-4 py-3">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((load, index) => (
                  <tr
                    key={load.id}
                    className={cn(
                      'group border-b border-line last:border-0 transition-colors hover:bg-sunken/50',
                      index % 2 === 1 && 'bg-sunken/20',
                    )}
                  >
                    <th scope="row" className="px-4 py-3 font-normal">
                      <Link href={`/loads/${load.id}`} className="block">
                        <span className="font-mono text-sm font-medium text-ink">
                          {load.number}
                        </span>
                        <span className="mt-0.5 block text-xs text-ink-muted">
                          {relativeTime(load.createdAt)}
                        </span>
                      </Link>
                    </th>
                    <td className="px-4 py-3">
                      <Badge tone={STATUS_TONE[load.status]} size="sm">
                        {statusLabel(load.status)}
                      </Badge>
                    </td>
                    <td className="hidden px-4 py-3 text-sm text-ink-secondary tabular-nums sm:table-cell">
                      {vehiclesByLoad.get(load.id) ?? 0}
                    </td>
                    <td className="hidden px-4 py-3 text-sm text-ink-secondary tabular-nums md:table-cell">
                      {miles(load.distanceMiles)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="block text-sm font-medium text-ink tabular-nums">
                        {money(load.rateCents)}
                      </span>
                      <span className="block text-xs text-ink-muted tabular-nums">
                        {ratePerMile(load.rateCents, load.distanceMiles)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/loads/${load.id}`}
                        className="grid size-8 place-items-center rounded-lg text-ink-muted transition-colors hover:bg-raised hover:text-ink"
                        aria-label={`Open load ${load.number}`}
                      >
                        <ArrowRight className="size-4" aria-hidden />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PageBody>
    </>
  );
}
