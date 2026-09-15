import { describe, expect, it } from 'vitest';
import {
  FRESH_DAYS,
  NO_MOVEMENTS,
  STALE_DAYS,
  ageOf,
  anyMovement,
  movedAfter,
  netMovement,
  positionNow,
  project,
  type WindowFlow,
} from '@/lib/cash/balance';

/**
 * What is in the account, and how far it can be trusted.
 *
 * A typed bank balance is the one figure in this application that nothing can
 * check, and the only one that stops being true without anything happening.
 * So what is worth pinning is not the arithmetic — it is that the figure
 * carries its age, that the day it was read is not double-counted, and that
 * the two readings of the running balance are never quietly averaged into one
 * number sitting between a promise and a payment term.
 */

const NOW = new Date('2026-09-15T14:30:00Z');

/* -------------------------------------------------------------------------
 * How old the reading is
 * ---------------------------------------------------------------------- */

describe('the age of a reading', () => {
  const reading = (day: string) => ({ amountCents: 500_000, asOf: new Date(day) });

  it('counts by the calendar, not by the clock', () => {
    // Entered at nine in the morning, still "today" at half past two. Counting
    // in hours would have the label flip while somebody was looking at it.
    expect(ageOf(reading('2026-09-15T09:00:00Z'), NOW)).toEqual({ days: 0, state: 'fresh' });
  });

  it('treats yesterday as current enough to plan on', () => {
    expect(ageOf(reading('2026-09-14T23:00:00Z'), NOW)).toEqual({
      days: FRESH_DAYS,
      state: 'fresh',
    });
  });

  it('calls a few days old what it is', () => {
    expect(ageOf(reading('2026-09-11T12:00:00Z'), NOW)).toEqual({ days: 4, state: 'aging' });
  });

  it('stops calling a fortnight-old figure current', () => {
    /*
     * The whole failure this guards against is a balance that quietly ages
     * into fiction while the screen around it keeps its confident tone.
     */
    expect(ageOf(reading('2026-09-01T12:00:00Z'), NOW)).toEqual({
      days: STALE_DAYS,
      state: 'stale',
    });
  });

  it('never reports a negative age for a reading entered today', () => {
    expect(ageOf(reading('2026-09-15T23:59:00Z'), NOW).days).toBe(0);
  });
});

/* -------------------------------------------------------------------------
 * The gap between the reading and now
 * ---------------------------------------------------------------------- */

describe('what has moved since', () => {
  const reading = { amountCents: 500_000, asOf: new Date('2026-09-11T12:00:00Z') };

  it('leaves out the reading day itself', () => {
    /*
     * A balance is read off a bank at the end of a day, so that day's own
     * payments are already inside it. Counting them again would show the same
     * money arriving twice — and the field that collects the date says "at the
     * end of" precisely so this rule is the one somebody expects.
     */
    expect(movedAfter(reading, new Date('2026-09-11T08:00:00Z'), NOW)).toBe(false);
    expect(movedAfter(reading, new Date('2026-09-11T23:00:00Z'), NOW)).toBe(false);
  });

  it('counts the day after, and today', () => {
    expect(movedAfter(reading, new Date('2026-09-12T01:00:00Z'), NOW)).toBe(true);
    expect(movedAfter(reading, new Date('2026-09-15T23:00:00Z'), NOW)).toBe(true);
  });

  it('leaves out anything dated after today', () => {
    // A payment recorded against next Tuesday has not arrived, whatever the
    // row says.
    expect(movedAfter(reading, new Date('2026-09-20T12:00:00Z'), NOW)).toBe(false);
  });

  it('nets money in against money out', () => {
    const moved = {
      receivedCents: 400_000,
      settlementsPaidCents: 214_000,
      refundsPaidCents: 15_000,
      recurringCents: 90_000,
    };

    expect(netMovement(moved)).toBe(81_000);
    expect(positionNow(reading, moved)).toBe(581_000);
    expect(anyMovement(moved)).toBe(true);
  });

  it('leaves the reading alone when nothing has moved', () => {
    expect(positionNow(reading, NO_MOVEMENTS)).toBe(500_000);
    expect(anyMovement(NO_MOVEMENTS)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * The running balance
 * ---------------------------------------------------------------------- */

describe('carrying the balance forward', () => {
  function week(index: number, over: Partial<WindowFlow> = {}): WindowFlow {
    const from = new Date(Date.UTC(2026, 8, 15 + index * 7));
    return {
      index,
      from,
      to: new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000),
      promisedCents: 0,
      dueCents: 0,
      outCents: 0,
      ...over,
    };
  }

  it('accumulates, rather than reporting each week on its own', () => {
    const projection = project(100_000, [
      week(0, { dueCents: 50_000, outCents: 20_000 }),
      week(1, { dueCents: 10_000, outCents: 20_000 }),
    ]);

    expect(projection.windows.map((row) => row.ifAllLandsCents)).toEqual([130_000, 120_000]);
  });

  it('keeps the two readings apart the whole way down', () => {
    /*
     * Never averaged into one expected figure. An average would sit between a
     * number somebody committed to and a number nobody did, and would be
     * neither — which is the most useful-looking way this screen could lie.
     */
    const projection = project(100_000, [
      week(0, { promisedCents: 30_000, dueCents: 200_000, outCents: 50_000 }),
      week(1, { promisedCents: 0, dueCents: 100_000, outCents: 90_000 }),
    ]);

    expect(projection.windows.map((row) => row.ifAllLandsCents)).toEqual([280_000, 290_000]);
    expect(projection.windows.map((row) => row.ifOnlyPromisedCents)).toEqual([80_000, -10_000]);
  });

  it('names the first week the cautious line goes under', () => {
    const projection = project(50_000, [
      week(0, { outCents: 20_000 }),
      week(1, { outCents: 40_000 }),
      week(2, { outCents: 40_000 }),
    ]);

    expect(projection.onPromises).toMatchObject({ index: 1, cents: -10_000 });
  });

  it('separates running out on promises from running out on everything', () => {
    /*
     * Two different facts and only one of them is an emergency. Few carriers
     * have promises covering a month of costs, so the cautious line going
     * under is ordinary. The optimistic line going under means that even with
     * every invoice paid exactly on its terms the account does not reach the
     * end of the month.
     */
    const projection = project(10_000, [
      week(0, { dueCents: 100_000, outCents: 60_000 }),
      week(1, { dueCents: 0, outCents: 80_000 }),
    ]);

    expect(projection.onPromises?.index).toBe(0);
    expect(projection.onEverything?.index).toBe(1);
  });

  it('says nothing about a shortfall when there is not one', () => {
    const projection = project(500_000, [week(0, { promisedCents: 10_000, outCents: 5_000 })]);

    expect(projection.onPromises).toBeNull();
    expect(projection.onEverything).toBeNull();
  });

  it('starts from an overdrawn account without flinching', () => {
    // An overdraft is a real state. Refusing to record it would push somebody
    // into entering zero, which reads as solvent.
    const projection = project(-40_000, [week(0, { dueCents: 100_000 })]);

    expect(projection.openingCents).toBe(-40_000);
    expect(projection.windows[0]?.ifAllLandsCents).toBe(60_000);
    expect(projection.onEverything).toBeNull();
  });

  it('is an empty projection when there are no weeks', () => {
    expect(project(100_000, [])).toEqual({
      openingCents: 100_000,
      windows: [],
      onPromises: null,
      onEverything: null,
    });
  });
});
