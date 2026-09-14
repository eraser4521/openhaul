import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { AlertTriangle, Check, ClipboardCheck, ScanLine, Wrench } from 'lucide-react';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import {
  customers as customersTable,
  documents as documentsTable,
  invoices as invoicesTable,
  loads as loadsTable,
  stops as stopsTable,
  venues as venuesTable,
  vehicles as vehiclesTable,
  type LoadStatus,
} from '@/lib/db/schema';
import { PageBody, PageHeader } from '@/components/app/page-header';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils/cn';
import { money, miles, ratePerMile, relativeTime, vinDisplay } from '@/lib/utils/format';
import { DocumentActions } from '@/components/app/document-actions';
import { RouteCard } from '@/components/app/route-card';
import { BillToCard } from '@/components/app/bill-to-card';
import { can } from '@/lib/auth/capabilities';

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

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { db } = await requireSessionOrRedirect();
    const load = await db.selectOne('loads', eq(loadsTable.id, id));
    return { title: load?.number ?? 'Load' };
  } catch {
    // Metadata must never be the thing that breaks a page render.
    return { title: 'Load' };
  }
}

export default async function LoadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { session, db } = await requireSessionOrRedirect();

  // The scoped client cannot reach another organisation's rows, so a load id
  // guessed from elsewhere simply does not resolve — no separate ownership
  // check to remember or forget.
  const load = await db.selectOne('loads', eq(loadsTable.id, id));
  if (!load) notFound();

  const [vehicles, issuedDocuments, stops, loadInvoices, customer] = await Promise.all([
    db.select('vehicles', eq(vehiclesTable.loadId, load.id)),
    db.select('documents', eq(documentsTable.loadId, load.id)),
    db.select('stops', eq(stopsTable.loadId, load.id)),
    db.select('invoices', eq(invoicesTable.loadId, load.id)),
    load.customerId
      ? db.selectOne('customers', eq(customersTable.id, load.customerId))
      : Promise.resolve(null),
  ]);

  // A voided invoice leaves the load billable again, so only a live one counts
  // as "this load is already invoiced".
  const liveInvoice = loadInvoices.find((invoice) => invoice.status !== 'void') ?? null;

  const venueFor = async (kind: 'pickup' | 'delivery') => {
    const stop = stops.find((s) => s.kind === kind);
    if (!stop?.venueId) return null;
    return (await db.selectOne('venues', eq(venuesTable.id, stop.venueId))) ?? null;
  };

  const [pickupVenue, deliveryVenue] = await Promise.all([venueFor('pickup'), venueFor('delivery')]);

  const unverifiedVins = vehicles.filter((v) => v.vinCheckDigitValid === false);
  const inoperable = vehicles.filter((v) => v.isInoperable);

  return (
    <>
      <PageHeader
        title={load.number}
        description={`Created ${relativeTime(load.createdAt)} · ${vehicles.length} vehicle${
          vehicles.length === 1 ? '' : 's'
        }`}
        actions={
          <>
            <Link href="/scan" className={cn(buttonVariants({ variant: 'secondary' }))}>
              <ScanLine aria-hidden />
              Scan a VIN
            </Link>
            <Link
              href={`/loads/${load.id}/inspect`}
              className={cn(buttonVariants())}
            >
              <ClipboardCheck aria-hidden />
              Start inspection
            </Link>
          </>
        }
      />

      <PageBody className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[load.status]}>{statusLabel(load.status)}</Badge>
          <Badge tone="neutral">
            {load.transportType === 'enclosed' ? 'Enclosed' : 'Open carrier'}
          </Badge>
          <Badge tone="neutral" className="capitalize">
            {load.inspectionTier} inspection
          </Badge>
          {load.legalHold && (
            <Badge tone="danger">
              <AlertTriangle aria-hidden />
              Legal hold
            </Badge>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: 'Carrier pay', value: money(load.rateCents) },
            { label: 'Customer tariff', value: money(load.tariffCents) },
            { label: 'Broker fee', value: money(load.brokerFeeCents) },
            {
              label: 'Rate per mile',
              value: ratePerMile(load.rateCents, load.distanceMiles),
              hint: miles(load.distanceMiles),
            },
          ].map((stat) => (
            <Card key={stat.label} className="p-5">
              <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
                {stat.label}
              </p>
              <p className="mt-2 text-xl font-semibold text-ink tabular-nums">{stat.value}</p>
              {stat.hint && <p className="mt-0.5 text-xs text-ink-secondary">{stat.hint}</p>}
            </Card>
          ))}
        </div>

        {(unverifiedVins.length > 0 || inoperable.length > 0) && (
          <div className="space-y-2">
            {unverifiedVins.length > 0 && (
              <p className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2.5 text-xs leading-relaxed text-warn">
                <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
                {unverifiedVins.length} VIN{unverifiedVins.length === 1 ? '' : 's'} did not pass the
                check digit. Compare against the plate before this goes on a bill of lading.
              </p>
            )}
            {inoperable.length > 0 && (
              <p className="flex items-start gap-2 rounded-lg bg-info-soft px-3 py-2.5 text-xs leading-relaxed text-info">
                <Wrench className="mt-px size-3.5 shrink-0" aria-hidden />
                {inoperable.length} inoperable unit{inoperable.length === 1 ? '' : 's'} — the driver
                needs a winch and the loading position changes.
              </p>
            )}
          </div>
        )}

        <RouteCard
          loadId={load.id}
          pickup={pickupVenue}
          delivery={deliveryVenue}
          canEdit={can(session.role, 'load.write')}
        />

        <BillToCard
          loadId={load.id}
          customer={customer}
          invoice={
            liveInvoice
              ? { id: liveInvoice.id, number: liveInvoice.number, status: liveInvoice.status }
              : null
          }
          canEdit={can(session.role, 'customer.write')}
          canInvoice={can(session.role, 'invoice.write')}
        />

        <section>
          <h2 className="mb-3 text-sm font-semibold text-ink">Vehicles</h2>
          <ul className="space-y-2">
            {vehicles.map((vehicle) => (
              <li key={vehicle.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-sm break-all text-ink">
                        {vinDisplay(vehicle.vin)}
                      </p>
                      <p className="mt-1 text-sm text-ink-secondary">
                        {[vehicle.year, vehicle.make, vehicle.model, vehicle.color]
                          .filter(Boolean)
                          .join(' ') || 'Details not decoded yet'}
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      {vehicle.vinCheckDigitValid ? (
                        <Badge tone="ok" size="sm">
                          <Check aria-hidden />
                          VIN verified
                        </Badge>
                      ) : (
                        <Badge tone="warn" size="sm">
                          <AlertTriangle aria-hidden />
                          Unverified
                        </Badge>
                      )}
                      {vehicle.isInoperable && (
                        <Badge tone="info" size="sm">
                          <Wrench aria-hidden />
                          Inoperable
                        </Badge>
                      )}
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </section>

        {load.instructions && (
          <section>
            <h2 className="mb-3 text-sm font-semibold text-ink">Instructions</h2>
            <Card className="p-5">
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink-secondary">
                {load.instructions}
              </p>
            </Card>
          </section>
        )}

        <section>
          <h2 className="mb-3 text-sm font-semibold text-ink">Documents</h2>
          <DocumentActions
            loadId={load.id}
            canIssue={can(session.role, 'load.write')}
            documents={[...issuedDocuments]
              .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
              .map((document) => ({
                id: document.id,
                kind: document.kind,
                title: document.title,
                sha256: document.sha256,
                byteSize: document.byteSize,
                version: document.version,
                createdAt: document.createdAt,
                supersedesDocumentId: document.supersedesDocumentId,
              }))}
          />
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold text-ink">Retention</h2>
          <Card className="p-5">
            <p className="text-sm leading-relaxed text-ink-secondary">
              Documents for this load are kept until{' '}
              <strong className="text-ink">
                {load.retainUntil?.toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                }) ?? 'no date set'}
              </strong>
              . The regulatory floor for a bill of lading is one year, but a cargo claim can be
              filed up to nine months after delivery and suit brought two years after a denial, so
              the default is seven.
            </p>
          </Card>
        </section>
      </PageBody>
    </>
  );
}
