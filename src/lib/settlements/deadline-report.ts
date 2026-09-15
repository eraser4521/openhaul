import 'server-only';
import type { ScopedDb } from '../db/scope';
import { approaching, NOTICE_DAYS, type Deadline, type PayableSettlement } from './deadline';

/**
 * Gathering what is about to run out.
 *
 * One pass over settlements and drivers rather than a query per row. Every
 * judgement about whether a deadline exists at all, and whether it is worth
 * mentioning, lives in `deadline.ts` — this only fetches and hands over, so
 * the dashboard cannot disagree with the settlement screen about the same
 * date.
 */
export async function settlementsDue(
  scoped: ScopedDb,
  options: { now?: Date; noticeDays?: number } = {},
): Promise<Deadline[]> {
  const now = options.now ?? new Date();

  const [settlements, drivers] = await Promise.all([
    scoped.select('settlements'),
    scoped.select('drivers'),
  ]);

  const byId = new Map(drivers.map((driver) => [driver.id, driver]));

  const payable: PayableSettlement[] = [];

  for (const settlement of settlements) {
    const driver = byId.get(settlement.driverId);
    /*
     * No driver record means no employment type, and without that there is no
     * way to know which body of law applies. Silence is the only honest
     * answer — guessing "owner-operator" would attach a citation to somebody
     * it may not govern.
     */
    if (!driver) continue;

    payable.push({
      id: settlement.id,
      driverId: driver.id,
      driverName: driver.displayName,
      employmentType: driver.employmentType,
      periodEnd: settlement.periodEnd,
      netPayCents: settlement.netPayCents,
      finalizedAt: settlement.finalizedAt,
      paidAt: settlement.paidAt,
    });
  }

  return approaching(payable, now, options.noticeDays ?? NOTICE_DAYS);
}
