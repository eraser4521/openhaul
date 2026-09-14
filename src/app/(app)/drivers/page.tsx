import { eq } from 'drizzle-orm';
import { IdCard } from 'lucide-react';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import { settlements as settlementsTable } from '@/lib/db/schema';
import { EmptyState, PageBody, PageHeader } from '@/components/app/page-header';
import { can } from '@/lib/auth/capabilities';
import { DriverCard, NewDriver, type DriverRow } from '@/components/app/driver-panel';
import { isPaymentLate, settlementStatus } from '@/lib/settlements/compute';
import { driverEscrowBalance } from '@/lib/settlements/lifecycle';
import { subjectStatus } from '@/lib/pii/vault';

export const metadata = { title: 'Drivers' };

/** Defaults the period to the fortnight ending today, the common cadence. */
function defaultPeriod(now: Date): { start: string; end: string } {
  const start = new Date(now.getTime());
  start.setUTCDate(start.getUTCDate() - 13);
  return { start: start.toISOString().slice(0, 10), end: now.toISOString().slice(0, 10) };
}

export default async function DriversPage() {
  const { session, db } = await requireSessionOrRedirect();

  const drivers = await db.select('drivers');
  const now = new Date();
  const period = defaultPeriod(now);

  const rows: DriverRow[] = await Promise.all(
    drivers.map(async (driver) => {
      const [settlements, escrowCents, subject] = await Promise.all([
        db.select('settlements', eq(settlementsTable.driverId, driver.id), {
          orderBy: { column: settlementsTable.periodEnd, direction: 'desc' },
        }),
        driverEscrowBalance(db, driver.id),
        // Tombstone only. Rendering this page must not decrypt anything, or
        // every visit would write an audit entry for a read nobody made.
        driver.subjectId
          ? subjectStatus(db, driver.subjectId)
          : Promise.resolve({ status: 'missing' as const, erasedAt: null }),
      ]);

      return {
        id: driver.id,
        displayName: driver.displayName,
        employmentType: driver.employmentType,
        payRateBps: driver.payRateBps,
        payPerMileCents: driver.payPerMileCents,
        cdlState: driver.cdlState,
        cdlClass: driver.cdlClass,
        escrowCents,
        personalData: subject.status === 'missing' ? 'none' : subject.status,
        personalDataErasedAt: subject.erasedAt?.toISOString() ?? null,
        settlements: settlements.map((settlement) => ({
          id: settlement.id,
          periodStart: settlement.periodStart,
          periodEnd: settlement.periodEnd,
          netPayCents: settlement.netPayCents,
          status: settlementStatus(settlement),
          late: isPaymentLate(settlement, driver.employmentType, now),
        })),
      };
    }),
  );

  const canWrite = can(session.role, 'driver.write');

  return (
    <>
      <PageHeader
        title="Drivers"
        description="Who drives, how they are paid, and what they are owed."
        actions={<NewDriver canWrite={canWrite} />}
      />

      <PageBody className="space-y-4">
        {rows.length === 0 ? (
          <EmptyState
            icon={IdCard}
            title="No drivers yet"
            description="Add a driver with their pay arrangement and settlements can be run from the loads they deliver. A leased owner-operator's statement carries the disclosures 49 CFR Part 376 requires; a company driver's does not."
          />
        ) : (
          rows.map((driver) => (
            <DriverCard
              key={driver.id}
              driver={driver}
              canWrite={can(session.role, 'settlement.write')}
              canReadPii={can(session.role, 'pii.read')}
              canErasePii={can(session.role, 'pii.erase')}
              defaultPeriodStart={period.start}
              defaultPeriodEnd={period.end}
            />
          ))
        )}
      </PageBody>
    </>
  );
}
