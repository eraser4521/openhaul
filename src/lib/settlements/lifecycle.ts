import 'server-only';
import { and, eq, gte, lte } from 'drizzle-orm';
import {
  drivers as driversTable,
  expenses as expensesTable,
  loads as loadsTable,
  settlementLines as linesTable,
  settlements as settlementsTable,
  type SettlementLineKind,
} from '../db/schema';
import type { ScopedDb } from '../db/scope';
import {
  escrowBalance,
  payBasisFor,
  payForLoad,
  settlementStatus,
  totalsFrom,
  type SettlementTotals,
} from './compute';

/**
 * Building, freezing and paying a settlement.
 *
 * A draft is assembled from what the period already contains — loads the
 * driver delivered, and reimbursable expenses they have receipts for — and
 * then edited, because chargebacks and advances are things only the office
 * knows about. Finalising freezes a statement; after that the lines cannot
 * move, since the driver is holding a document that states them.
 */

export interface BuildResult {
  ok: boolean;
  settlementId?: string;
  error?: string;
  loadsIncluded?: number;
}

/**
 * Loads that belong on a settlement for this period.
 *
 * Delivered loads only, dated by delivery rather than by dispatch: a load
 * picked up in one period and delivered in the next is earned in the second,
 * and paying it in the first would pay for work not yet finished.
 */
async function loadsForPeriod(
  scoped: ScopedDb,
  driverId: string,
  periodStart: Date,
  periodEnd: Date,
) {
  const rows = await scoped.select(
    'loads',
    and(
      eq(loadsTable.driverId, driverId),
      gte(loadsTable.deliveredAt, periodStart),
      lte(loadsTable.deliveredAt, periodEnd),
    ),
  );

  return rows.filter((load) => load.status !== 'cancelled' && load.status !== 'declined');
}

/** Loads already paid on another settlement, which must not be paid twice. */
async function alreadySettledLoadIds(scoped: ScopedDb): Promise<Set<string>> {
  const lines = await scoped.select('settlementLines', eq(linesTable.kind, 'load_pay'));
  return new Set(lines.map((line) => line.loadId).filter((id): id is string => id !== null));
}

export async function buildSettlement(
  scoped: ScopedDb,
  driverId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<BuildResult> {
  if (periodEnd.getTime() < periodStart.getTime()) {
    return { ok: false, error: 'The period ends before it starts.' };
  }

  const driver = await scoped.selectOne('drivers', eq(driversTable.id, driverId));
  if (!driver) return { ok: false, error: 'No such driver.' };

  const basis = payBasisFor(driver);
  if (basis.kind === 'none') {
    return {
      ok: false,
      error: `${driver.displayName} has no pay rate set, so there is nothing to calculate from.`,
    };
  }

  const [loads, settled] = await Promise.all([
    loadsForPeriod(scoped, driverId, periodStart, periodEnd),
    alreadySettledLoadIds(scoped),
  ]);

  const payable = loads.filter((load) => !settled.has(load.id));

  const [settlement] = await scoped.insert('settlements', {
    driverId,
    periodStart,
    periodEnd,
    payRateBps: driver.payRateBps,
    grossRevenueCents: payable.reduce((sum, load) => sum + (load.rateCents ?? 0), 0),
    brokerFeesCents: payable.reduce((sum, load) => sum + (load.brokerFeeCents ?? 0), 0),
  });

  if (!settlement) return { ok: false, error: 'The settlement could not be created.' };

  let sequence = 0;

  for (const load of payable.sort((a, b) => (a.deliveredAt?.getTime() ?? 0) - (b.deliveredAt?.getTime() ?? 0))) {
    const pay = payForLoad(load, basis);
    await scoped.insert('settlementLines', {
      settlementId: settlement.id,
      kind: 'load_pay',
      sequence: sequence++,
      description: `Load ${load.number}`,
      amountCents: pay.amountCents,
      loadId: load.id,
      basisNote: pay.basisNote,
    });
  }

  /*
   * Reimbursable expenses the driver has not yet been paid back for. Only the
   * ones marked reimbursable: a driver's own fuel on a percentage lease is
   * their cost, and sweeping it in would hand back money nobody agreed to.
   */
  const expenses = await scoped.select(
    'expenses',
    and(eq(expensesTable.driverId, driverId), eq(expensesTable.reimbursable, true)),
  );

  for (const expense of expenses) {
    if (expense.reimbursedAt) continue;
    if (expense.incurredAt.getTime() < periodStart.getTime()) continue;
    if (expense.incurredAt.getTime() > periodEnd.getTime()) continue;

    await scoped.insert('settlementLines', {
      settlementId: settlement.id,
      kind: 'reimbursement',
      sequence: sequence++,
      description: `${expense.category.replace(/_/g, ' ')}${expense.vendor ? ` — ${expense.vendor}` : ''}`,
      amountCents: expense.amountCents,
      loadId: expense.loadId,
      expenseId: expense.id,
      basisNote: expense.receiptStorageKey ? 'Receipt on file' : 'No receipt on file',
    });
  }

  await recomputeTotals(scoped, settlement.id);

  return { ok: true, settlementId: settlement.id, loadsIncluded: payable.length };
}

/* -------------------------------------------------------------------------
 * Lines
 * ---------------------------------------------------------------------- */

export interface AddLineInput {
  kind: SettlementLineKind;
  description: string;
  amountCents: number;
  loadId?: string | null;
  documentId?: string | null;
  basisNote?: string | null;
}

export async function addLine(
  scoped: ScopedDb,
  settlementId: string,
  input: AddLineInput,
): Promise<{ ok: boolean; error?: string }> {
  const settlement = await scoped.selectOne('settlements', eq(settlementsTable.id, settlementId));
  if (!settlement) return { ok: false, error: 'No such settlement.' };

  if (settlement.finalizedAt) {
    return {
      ok: false,
      error:
        'This settlement has been finalised. The driver is holding a statement that shows these ' +
        'lines, so a correction belongs on the next one.',
    };
  }

  if (!input.description.trim()) {
    return { ok: false, error: 'Say what the line is for — the driver will ask.' };
  }
  if (input.amountCents === 0) {
    return { ok: false, error: 'A line of zero changes nothing.' };
  }

  const existing = await scoped.select('settlementLines', eq(linesTable.settlementId, settlementId));

  await scoped.insert('settlementLines', {
    settlementId,
    kind: input.kind,
    sequence: existing.length,
    description: input.description.trim(),
    amountCents: input.amountCents,
    loadId: input.loadId ?? null,
    documentId: input.documentId ?? null,
    basisNote: input.basisNote ?? null,
  });

  await recomputeTotals(scoped, settlementId);
  return { ok: true };
}

export async function removeLine(
  scoped: ScopedDb,
  settlementId: string,
  lineId: string,
): Promise<{ ok: boolean; error?: string }> {
  const settlement = await scoped.selectOne('settlements', eq(settlementsTable.id, settlementId));
  if (!settlement) return { ok: false, error: 'No such settlement.' };
  if (settlement.finalizedAt) {
    return { ok: false, error: 'This settlement has been finalised.' };
  }

  await scoped.remove('settlementLines', eq(linesTable.id, lineId));
  await recomputeTotals(scoped, settlementId);
  return { ok: true };
}

/**
 * Rewrites the stored totals from the lines.
 *
 * Never incremented. A settlement whose stored net disagrees with the lines
 * printed beneath it is the single thing most likely to end a working
 * relationship, so the totals are only ever a projection of the lines.
 */
export async function recomputeTotals(
  scoped: ScopedDb,
  settlementId: string,
): Promise<SettlementTotals> {
  const lines = await scoped.select('settlementLines', eq(linesTable.settlementId, settlementId));
  const totals = totalsFrom(lines);

  await scoped.update('settlements', eq(settlementsTable.id, settlementId), {
    driverPayCents: totals.earningsCents,
    reimbursementsCents: totals.reimbursementsCents,
    deductionsCents: totals.deductionsCents + totals.advancesCents + totals.escrowHeldCents,
    netPayCents: totals.netPayCents,
  });

  return totals;
}

/* -------------------------------------------------------------------------
 * Reading one
 * ---------------------------------------------------------------------- */

/** Escrow held across every settlement for a driver, not just this one. */
export async function driverEscrowBalance(scoped: ScopedDb, driverId: string): Promise<number> {
  const settlements = await scoped.select('settlements', eq(settlementsTable.driverId, driverId));
  const ids = new Set(settlements.map((settlement) => settlement.id));

  const lines = await scoped.select('settlementLines');
  return escrowBalance(lines.filter((line) => ids.has(line.settlementId)));
}

/* -------------------------------------------------------------------------
 * Finalising and paying
 * ---------------------------------------------------------------------- */

export async function finalizeSettlement(
  scoped: ScopedDb,
  settlementId: string,
): Promise<{ ok: boolean; error?: string }> {
  const settlement = await scoped.selectOne('settlements', eq(settlementsTable.id, settlementId));
  if (!settlement) return { ok: false, error: 'No such settlement.' };
  if (settlement.finalizedAt) return { ok: false, error: 'This settlement is already finalised.' };

  const lines = await scoped.select('settlementLines', eq(linesTable.settlementId, settlementId));
  if (lines.length === 0) {
    return { ok: false, error: 'There is nothing on this settlement to finalise.' };
  }

  const totals = await recomputeTotals(scoped, settlementId);

  if (totals.netPayCents < 0) {
    return {
      ok: false,
      error:
        `The deductions exceed the earnings, leaving the driver owing ${Math.abs(totals.netPayCents / 100).toFixed(2)}. ` +
        'That is allowed but almost never intended — check the chargebacks before finalising.',
    };
  }

  await scoped.update('settlements', eq(settlementsTable.id, settlementId), {
    finalizedAt: new Date(),
  });

  // Reimbursed expenses are marked so the next settlement does not pay them
  // a second time.
  for (const line of lines) {
    if (line.kind === 'reimbursement' && line.expenseId) {
      await scoped.update('expenses', eq(expensesTable.id, line.expenseId), {
        reimbursedAt: new Date(),
      });
    }
  }

  return { ok: true };
}

export async function recordSettlementPayment(
  scoped: ScopedDb,
  settlementId: string,
  reference: string | null,
  paidAt: Date,
): Promise<{ ok: boolean; error?: string }> {
  const settlement = await scoped.selectOne('settlements', eq(settlementsTable.id, settlementId));
  if (!settlement) return { ok: false, error: 'No such settlement.' };

  if (!settlement.finalizedAt) {
    return { ok: false, error: 'Finalise the settlement before recording payment against it.' };
  }
  if (settlement.paidAt) return { ok: false, error: 'This settlement is already paid.' };

  await scoped.update('settlements', eq(settlementsTable.id, settlementId), {
    paidAt,
    paymentReference: reference,
  });

  return { ok: true };
}

export { settlementStatus };
