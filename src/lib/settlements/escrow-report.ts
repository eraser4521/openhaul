import 'server-only';
import type { ScopedDb } from '../db/scope';
import { escrowBalance } from './compute';
import { NOTICE_DAYS, outstandingReturns, type EscrowReturn, type Holding } from './escrow';

/**
 * What is held, for whom, across every settlement.
 *
 * One pass rather than `driverEscrowBalance` per driver, which would be a
 * query each and is called on a page that loads before anything else. The
 * arithmetic is the same function either way, so the dashboard and the driver
 * screen cannot disagree about a balance.
 */
export async function escrowHoldings(scoped: ScopedDb): Promise<Holding[]> {
  const [drivers, settlements, lines] = await Promise.all([
    scoped.select('drivers'),
    scoped.select('settlements'),
    scoped.select('settlementLines'),
  ]);

  const driverBySettlement = new Map(
    settlements.map((settlement) => [settlement.id, settlement.driverId]),
  );

  const linesByDriver = new Map<string, typeof lines>();
  for (const line of lines) {
    const driverId = driverBySettlement.get(line.settlementId);
    if (!driverId) continue;

    const list = linesByDriver.get(driverId) ?? [];
    list.push(line);
    linesByDriver.set(driverId, list);
  }

  return drivers.map((driver) => ({
    driverId: driver.id,
    driverName: driver.displayName,
    employmentType: driver.employmentType,
    deactivatedAt: driver.deactivatedAt,
    balanceCents: escrowBalance(linesByDriver.get(driver.id) ?? []),
  }));
}

/** The funds running out of time, for the dashboard. */
export async function escrowReturnsDue(
  scoped: ScopedDb,
  options: { now?: Date; noticeDays?: number } = {},
): Promise<EscrowReturn[]> {
  const holdings = await escrowHoldings(scoped);

  return outstandingReturns(holdings, options.now ?? new Date(), options.noticeDays ?? NOTICE_DAYS);
}
