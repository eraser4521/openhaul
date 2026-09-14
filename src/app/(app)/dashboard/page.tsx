import Link from 'next/link';
import { inArray } from 'drizzle-orm';
import {
  ArrowRight,
  ClipboardCheck,
  DollarSign,
  Gauge,
  ScanLine,
  Truck,
  TriangleAlert,
} from 'lucide-react';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import { loads } from '@/lib/db/schema';
import { PageBody, PageHeader } from '@/components/app/page-header';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { money, miles, ratePerMile, relativeTime } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';
import type { LoadStatus } from '@/lib/db/schema';

export const metadata = { title: 'Dashboard' };

/** Statuses that mean the load is live work rather than history. */
const OPEN_STATUSES: LoadStatus[] = [
  'draft',
  'posted',
  'offered',
  'accepted',
  'dispatched',
  'picked_up',
  'in_transit',
];

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

function Stat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card interactive className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">{label}</p>
          <p className="mt-2 text-2xl font-semibold text-ink tabular-nums">{value}</p>
          {hint && <p className="mt-1 text-xs text-ink-secondary">{hint}</p>}
        </div>
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">
          <Icon className="size-4" aria-hidden />
        </span>
      </div>
    </Card>
  );
}

export default async function DashboardPage() {
  const { session, db } = await requireSessionOrRedirect();

  // Carrier-scale volumes, so the aggregate is computed in memory rather than
  // pushed into SQL. Revisit if a tenant ever carries tens of thousands of
  // open loads, which a car hauler will not.
  const openLoads = await db.select('loads', inArray(loads.status, OPEN_STATUSES));
  const allLoads = await db.select('loads');

  const delivered = allLoads.filter((l) => l.deliveredAt !== null);
  const revenueCents = delivered.reduce((sum, l) => sum + (l.rateCents ?? 0), 0);
  const totalMiles = delivered.reduce((sum, l) => sum + (l.distanceMiles ?? 0), 0);
  const unpaid = allLoads.filter((l) => l.status === 'invoiced' || l.status === 'delivered');
  const unpaidCents = unpaid.reduce((sum, l) => sum + (l.rateCents ?? 0), 0);

  const recent = [...openLoads]
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, 8);

  const firstName = session.displayName.split(' ')[0] ?? session.displayName;

  return (
    <>
      <PageHeader
        title={`Afternoon, ${firstName}`}
        description={`${session.orgName} · ${openLoads.length} load${openLoads.length === 1 ? '' : 's'} in motion`}
        actions={
          <>
            <Link href="/scan" className={cn(buttonVariants({ variant: 'secondary' }))}>
              <ScanLine aria-hidden />
              Scan a VIN
            </Link>
            <Link href="/loads/new" className={cn(buttonVariants())}>
              New load
            </Link>
          </>
        }
      />

      <PageBody className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            icon={Truck}
            label="Open loads"
            value={String(openLoads.length)}
            hint={`${allLoads.length} all time`}
          />
          <Stat
            icon={DollarSign}
            label="Delivered revenue"
            value={money(revenueCents, true)}
            hint={`${delivered.length} delivered`}
          />
          <Stat
            icon={Gauge}
            label="Average rate"
            value={ratePerMile(revenueCents, totalMiles)}
            hint={miles(totalMiles)}
          />
          <Stat
            icon={ClipboardCheck}
            label="Awaiting payment"
            value={money(unpaidCents, true)}
            hint={`${unpaid.length} invoice${unpaid.length === 1 ? '' : 's'}`}
          />
        </div>

        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-ink">In motion</h2>
            <Link
              href="/loads"
              className="group inline-flex items-center gap-1 text-xs text-ink-secondary hover:text-ink"
            >
              All loads
              <ArrowRight
                className="size-3 transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
            </Link>
          </div>

          {recent.length === 0 ? (
            <Card className="bg-dots px-6 py-14 text-center">
              <span className="mx-auto grid size-12 place-items-center rounded-xl bg-brand-soft text-brand">
                <Truck className="size-5" aria-hidden />
              </span>
              <h3 className="mt-4 text-base font-semibold text-ink">No loads yet</h3>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-ink-secondary">
                Create your first load and OpenHaul will fill in each vehicle&rsquo;s year, make and
                model from its VIN.
              </p>
              <Link href="/loads/new" className={cn(buttonVariants(), 'mt-6')}>
                Create a load
              </Link>
            </Card>
          ) : (
            <ul className="space-y-2">
              {recent.map((load) => (
                <li key={load.id}>
                  <Link
                    href={`/loads/${load.id}`}
                    className="group flex items-center gap-4 rounded-xl border border-line bg-raised p-4 transition-all duration-200 hover:-translate-y-px hover:border-line-strong hover:shadow-md"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-medium text-ink">
                          {load.number}
                        </span>
                        <Badge tone={STATUS_TONE[load.status]} size="sm">
                          {statusLabel(load.status)}
                        </Badge>
                        {load.legalHold && (
                          <Badge tone="danger" size="sm">
                            <TriangleAlert aria-hidden />
                            Legal hold
                          </Badge>
                        )}
                      </p>
                      <p className="mt-1 truncate text-xs text-ink-secondary">
                        Updated {relativeTime(load.updatedAt)}
                        {load.distanceMiles ? ` · ${miles(load.distanceMiles)}` : ''}
                      </p>
                    </div>

                    <div className="shrink-0 text-right">
                      <p className="text-sm font-semibold text-ink tabular-nums">
                        {money(load.rateCents)}
                      </p>
                      <p className="text-xs text-ink-muted tabular-nums">
                        {ratePerMile(load.rateCents, load.distanceMiles)}
                      </p>
                    </div>

                    <ArrowRight
                      className="size-4 shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5"
                      aria-hidden
                    />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </PageBody>
    </>
  );
}
