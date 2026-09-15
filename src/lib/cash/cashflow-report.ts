import 'server-only';
import { eq } from 'drizzle-orm';
import { expenses as expensesTable, settlementLines as linesTable } from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { balanceCents, refundableCents } from '../invoices/compute';
import { live } from '../invoices/overview';
import { ruleFor } from '../invoices/dunning-run';
import { currentPromise, outcomeOf, supersederOf } from '../invoices/promise';
import { payBasisFor, payForLoad } from '../settlements/compute';
import {
  HORIZON_WEEKS,
  buildTimeline,
  groupStanding,
  recurringMovements,
  splitPayable,
  splitReceivable,
  unknowns,
  windowsFrom,
  type Movement,
  type Standing,
  type StandingGroup,
  type Timeline,
  type Unknown,
} from './cashflow';
import {
  ageOf,
  positionNow,
  project,
  type Aged,
  type Movements,
  type Projection,
} from './balance';
import {
  latestBalance,
  movementsSince,
  outgoingsFor,
  type BalanceView,
  type OutgoingView,
} from './treasury';

/**
 * Assembling the cash screens out of what is on file.
 *
 * One pass over the billing tables rather than a query per row, because the
 * page is read top to bottom in one go. Every judgement about what a figure
 * *means* lives in `cashflow.ts`, `recurring.ts` and `balance.ts`; every
 * judgement about whether somebody kept their word lives in `promise.ts`.
 * This file only fetches and hands over, so the screen cannot disagree with
 * the dunning sweep about the same promise.
 */

export interface BalanceState {
  reading: BalanceView;
  age: Aged;
  /** What this application knows has moved since the reading was taken. */
  moved: Movements;
  /** The reading plus that movement: where the account probably stands today. */
  positionCents: number;
}

export interface CashflowReport {
  timeline: Timeline;
  standing: StandingGroup[];
  unknowns: Unknown[];
  /** Pay earned on delivered loads nobody has drawn a settlement for. */
  accruedPayCents: number;
  accruedLoadCount: number;
  horizonWeeks: number;
  /** Null when nobody may see it, or when nobody has entered one. */
  balance: BalanceState | null;
  /** Null without a balance: there is nothing to run the weeks against. */
  projection: Projection | null;
  outgoings: OutgoingView[];
}

/**
 * Driver pay on delivered loads that no settlement has picked up.
 *
 * Worked out the same way `buildSettlement` works it out — the same pay basis
 * applied by the same function — so the figure shown as invisible is the
 * figure that will appear the moment somebody draws the statement.
 *
 * It is deliberately kept off the timeline. Nothing says when the settlement
 * will be drawn, and dating it by guessing a period end would be exactly the
 * invention this page exists to avoid. It is named as an unknown instead,
 * with the amount, because a carrier who can see the number can judge it.
 */
async function accruedPay(scoped: ScopedDb): Promise<{ cents: number; loads: number }> {
  const [loads, drivers, lines] = await Promise.all([
    scoped.select('loads'),
    scoped.select('drivers'),
    scoped.select('settlementLines', eq(linesTable.kind, 'load_pay')),
  ]);

  const settled = new Set(lines.map((line) => line.loadId).filter((id) => id !== null));
  const basisByDriver = new Map(drivers.map((driver) => [driver.id, payBasisFor(driver)]));

  let cents = 0;
  let count = 0;

  for (const load of loads) {
    if (load.deliveredAt === null || load.driverId === null) continue;
    if (load.status === 'cancelled' || load.status === 'declined') continue;
    if (settled.has(load.id)) continue;

    const basis = basisByDriver.get(load.driverId);
    if (!basis || basis.kind === 'none') continue;

    const pay = payForLoad(load, basis);
    if (pay.amountCents <= 0) continue;

    cents += pay.amountCents;
    count += 1;
  }

  return { cents, loads: count };
}

export interface ReportOptions {
  now?: Date;
  weeks?: number;
  /**
   * Whether this reader may see the bank balance.
   *
   * Passed in rather than decided here, and used to skip the query rather than
   * to blank the result: what customers owe is dispatch information and what
   * is in the account is not, so a dispatcher gets the timeline without the
   * line it runs against.
   */
  withBalance?: boolean;
}

export async function cashflowReport(
  scoped: ScopedDb,
  options: ReportOptions = {},
): Promise<CashflowReport> {
  const now = options.now ?? new Date();
  const weeks = options.weeks ?? HORIZON_WEEKS;

  const [invoices, customers, payments, refunds, promises, settlements, drivers, rule, accrued] =
    await Promise.all([
      scoped.select('invoices'),
      scoped.select('customers'),
      scoped.select('payments'),
      scoped.select('refunds'),
      scoped.select('promisesToPay'),
      scoped.select('settlements'),
      scoped.select('drivers'),
      ruleFor(scoped),
      accruedPay(scoped),
    ]);

  const outgoings = await outgoingsFor(scoped);

  const customerName = new Map(customers.map((customer) => [customer.id, customer.name]));
  const driverName = new Map(drivers.map((driver) => [driver.id, driver.displayName]));

  const paymentsByInvoice = new Map<string, typeof payments>();
  for (const payment of payments) {
    const list = paymentsByInvoice.get(payment.invoiceId) ?? [];
    list.push(payment);
    paymentsByInvoice.set(payment.invoiceId, list);
  }

  const refundedBy = new Map<string, number>();
  for (const refund of refunds) {
    refundedBy.set(refund.invoiceId, (refundedBy.get(refund.invoiceId) ?? 0) + refund.amountCents);
  }

  const promisesByInvoice = new Map<string, typeof promises>();
  for (const promise of promises) {
    const list = promisesByInvoice.get(promise.invoiceId) ?? [];
    list.push(promise);
    promisesByInvoice.set(promise.invoiceId, list);
  }

  const movements: Movement[] = [];
  const standing: Standing[] = [];

  /* --- Coming in ------------------------------------------------------- */

  for (const invoice of live(invoices)) {
    const settledInvoice = { ...invoice, refundedCents: refundedBy.get(invoice.id) ?? 0 };
    const balance = balanceCents(settledInvoice);

    /*
     * An overpaid invoice is money the carrier is holding, not money coming.
     * It goes to the outgoing side, where the carrier can see that the figure
     * in the account is not all theirs.
     */
    const refundable = refundableCents(settledInvoice);
    if (refundable > 0) {
      standing.push({
        key: `refund:${invoice.id}`,
        reason: 'refund_owed',
        amountCents: refundable,
        reference: invoice.number,
        counterparty: invoice.customerId
          ? (customerName.get(invoice.customerId) ?? 'Unknown customer')
          : 'No customer',
        daysWaiting: null,
      });
    }

    if (balance <= 0) continue;

    /*
     * Only a promise still open counts. One already kept has turned into a
     * payment, and one already broken is the opposite of money coming — both
     * would put a figure in the promised column that nobody stands behind.
     */
    const mine = promisesByInvoice.get(invoice.id) ?? [];
    const promise = currentPromise(mine);
    const outcome = promise
      ? outcomeOf(promise, paymentsByInvoice.get(invoice.id) ?? [], {
          graceDays: rule.promiseGraceDays,
          supersededBy: supersederOf(promise, mine),
          now,
        })
      : null;

    const split = splitReceivable(
      {
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        customerName: invoice.customerId
          ? (customerName.get(invoice.customerId) ?? 'Unknown customer')
          : 'No customer',
        balanceCents: balance,
        dueAt: invoice.dueAt,
        promise:
          promise && outcome?.state === 'open'
            ? { promisedFor: promise.promisedFor, outstandingCents: outcome.shortfallCents }
            : null,
        promiseBroken: outcome?.state === 'broken' || outcome?.state === 'partly_kept',
      },
      now,
    );

    movements.push(...split.movements);
    standing.push(...split.standing);
  }

  /* --- Going out ------------------------------------------------------- */

  for (const settlement of settlements) {
    if (settlement.paidAt !== null) continue;

    const split = splitPayable(
      {
        settlementId: settlement.id,
        driverName: driverName.get(settlement.driverId) ?? 'Unknown driver',
        periodEnd: settlement.periodEnd,
        netPayCents: settlement.netPayCents,
        draft: settlement.finalizedAt === null,
      },
      now,
    );

    movements.push(...split.movements);
    standing.push(...split.standing);
  }

  /*
   * Standing costs, generated only as far as the horizon.
   *
   * Not beyond it, unlike everything else here. A monthly note has no last
   * payment until somebody sets one, so a "beyond four weeks" figure for it
   * would be a number chosen by how far the loop happened to run. The page
   * says they carry on instead of pretending to total them.
   */
  const spans = windowsFrom(now, weeks);
  const horizonEnd = spans[spans.length - 1]?.to ?? now;
  for (const outgoing of outgoings) {
    movements.push(...recurringMovements(outgoing, now, horizonEnd));
  }

  /*
   * Approved expenses nobody has been paid back for.
   *
   * Only the ones somebody has actually reviewed: an unreviewed receipt is a
   * claim, not a debt, and counting it would have the carrier planning around
   * money they may well decide they do not owe.
   */
  const outstandingExpenses = await scoped.select(
    'expenses',
    eq(expensesTable.reimbursable, true),
  );

  for (const expense of outstandingExpenses) {
    if (expense.reviewedAt === null || expense.reimbursedAt !== null) continue;

    standing.push({
      key: `expense:${expense.id}`,
      reason: 'unreimbursed',
      amountCents: expense.amountCents,
      reference: expense.vendor
        ? `${expense.category.replace(/_/g, ' ')} — ${expense.vendor}`
        : expense.category.replace(/_/g, ' '),
      counterparty: expense.driverId
        ? (driverName.get(expense.driverId) ?? 'Unknown driver')
        : 'No driver',
      daysWaiting: Math.max(
        0,
        Math.round((now.getTime() - expense.incurredAt.getTime()) / 86_400_000),
      ),
    });
  }

  const timeline = buildTimeline(movements, now, weeks);

  /* --- What it all runs against ---------------------------------------- */

  let balance: BalanceState | null = null;

  if (options.withBalance) {
    const reading = await latestBalance(scoped);

    if (reading) {
      const moved = await movementsSince(scoped, reading, now);
      balance = {
        reading,
        age: ageOf(reading, now),
        moved,
        positionCents: positionNow(reading, moved),
      };
    }
  }

  return {
    timeline,
    standing: groupStanding(standing),
    unknowns: unknowns({
      accruedPayCents: accrued.cents,
      accruedLoadCount: accrued.loads,
      hasBalance: balance !== null,
      recurringCount: outgoings.length,
    }),
    accruedPayCents: accrued.cents,
    accruedLoadCount: accrued.loads,
    horizonWeeks: weeks,
    balance,
    projection: balance ? project(balance.positionCents, timeline.windows) : null,
    outgoings,
  };
}
