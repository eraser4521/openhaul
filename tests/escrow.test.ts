import { describe, expect, it } from 'vitest';
import {
  NOTICE_DAYS,
  escrowState,
  lateCount,
  outstandingReturns,
  returnDueBy,
  type Holding,
} from '@/lib/settlements/escrow';
import { escrowBalance } from '@/lib/settlements/compute';

/**
 * Money held for somebody who has left.
 *
 * This is the one deadline in the application where the carrier's interest
 * runs the other way. A late invoice costs them, a late settlement embarrasses
 * them with somebody they still need — escrow that quietly stays put costs
 * nothing and the person it belongs to has already gone. So what is worth
 * pinning is that it cannot be dismissed without the money actually moving:
 * the fund is discharged when the balance reaches zero, and the balance comes
 * from settlement lines the driver can see, not from a flag somebody ticks.
 */

const NOW = new Date('2026-09-15T09:00:00Z');

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function holding(over: Partial<Holding> = {}): Holding {
  return {
    driverId: 'd1',
    driverName: 'Marcus Webb',
    employmentType: 'owner_operator',
    deactivatedAt: daysAgo(38),
    balanceCents: 150_000,
    ...over,
  };
}

/* -------------------------------------------------------------------------
 * When a clock runs at all
 * ---------------------------------------------------------------------- */

describe('whether there is a deadline', () => {
  it('gives forty-five days from the day the lease ended', () => {
    const due = returnDueBy(holding({ deactivatedAt: new Date('2026-09-01T00:00:00Z') }));

    expect(due).toEqual(new Date('2026-10-16T00:00:00Z'));
  });

  it('runs no clock while the driver is still on the books', () => {
    // 376.12(h) counts from the lease ending. Somebody still driving has not
    // ended one, however long the fund has been held.
    const current = holding({ deactivatedAt: null });

    expect(returnDueBy(current)).toBeNull();
    expect(escrowState(current, NOW)).toBe('under_lease');
  });

  it('says nothing about a company driver', () => {
    /*
     * Part 376 governs a lease. Money held back from a company driver is a
     * different arrangement under different law, and warning about it with
     * this citation attached would be wrong in the way that matters most.
     */
    const company = holding({ employmentType: 'company' });

    expect(returnDueBy(company)).toBeNull();
    expect(escrowState(company, NOW)).toBe('not_leased');
    expect(outstandingReturns([company], NOW)).toEqual([]);
  });

  it('says nothing once the fund is empty', () => {
    const empty = holding({ balanceCents: 0 });

    expect(returnDueBy(empty)).toBeNull();
    expect(escrowState(empty, NOW)).toBe('nothing_held');
  });

  it('treats an over-returned fund as empty rather than as a debt', () => {
    // More returned than was deposited is a correction somebody made, not
    // money the driver owes back.
    expect(escrowState(holding({ balanceCents: -20_000 }), NOW)).toBe('nothing_held');
  });
});

/* -------------------------------------------------------------------------
 * What discharges it
 * ---------------------------------------------------------------------- */

describe('how a fund is settled', () => {
  it('is discharged by the lines, not by a flag', () => {
    /*
     * Escrow moves through settlement lines, so returning it means writing a
     * line that lands on a statement the driver receives. A "returned"
     * checkbox would let the obligation be marked done with nothing having
     * moved, which is precisely the failure this warning exists to catch.
     */
    const held = escrowBalance([
      { kind: 'escrow_deposit', amountCents: 50_000 },
      { kind: 'escrow_deposit', amountCents: 100_000 },
    ]);
    expect(escrowState(holding({ balanceCents: held }), NOW)).toBe('due_soon');

    const returned = escrowBalance([
      { kind: 'escrow_deposit', amountCents: 50_000 },
      { kind: 'escrow_deposit', amountCents: 100_000 },
      { kind: 'escrow_return', amountCents: 150_000 },
    ]);
    expect(escrowState(holding({ balanceCents: returned }), NOW)).toBe('nothing_held');
  });

  it('counts a permitted deduction as discharging it too', () => {
    /*
     * 376.12(h)(6) lets a carrier deduct what the lease allows. That lands as
     * lines like any other movement, so both ways of clearing the fund reach
     * the same arithmetic and neither has to be trusted separately.
     */
    const cleared = escrowBalance([
      { kind: 'escrow_deposit', amountCents: 150_000 },
      { kind: 'escrow_return', amountCents: 90_000 },
      { kind: 'escrow_return', amountCents: 60_000 },
    ]);

    expect(cleared).toBe(0);
    expect(escrowState(holding({ balanceCents: cleared }), NOW)).toBe('nothing_held');
  });
});

/* -------------------------------------------------------------------------
 * When it speaks
 * ---------------------------------------------------------------------- */

describe('when it speaks', () => {
  it('stays quiet while a carrier is dealing with it at any ordinary pace', () => {
    // Drawing a final settlement within a fortnight leaves a month on the
    // clock. Only a fund nobody has touched gets close enough to be named.
    expect(escrowState(holding({ deactivatedAt: daysAgo(3) }), NOW)).toBe('in_hand');
    expect(escrowState(holding({ deactivatedAt: daysAgo(20) }), NOW)).toBe('in_hand');
  });

  it('speaks once the notice window opens', () => {
    expect(escrowState(holding({ deactivatedAt: daysAgo(35) }), NOW)).toBe('due_soon');
    expect(escrowState(holding({ deactivatedAt: daysAgo(45) }), NOW)).toBe('due_soon');
  });

  it('opens the window exactly at the notice threshold', () => {
    const atThreshold = holding({ deactivatedAt: daysAgo(45 - NOTICE_DAYS) });
    const justOutside = holding({ deactivatedAt: daysAgo(45 - NOTICE_DAYS - 1) });

    expect(escrowState(atThreshold, NOW)).toBe('due_soon');
    expect(escrowState(justOutside, NOW)).toBe('in_hand');
  });

  it('keeps speaking, without limit, once the window has closed', () => {
    /*
     * No settled-window here, unlike the promises worklist. A fund still held
     * two years after somebody left has not become less wrong with age, and
     * letting it age off the screen would be the application quietly taking
     * the carrier's side.
     */
    expect(escrowState(holding({ deactivatedAt: daysAgo(46) }), NOW)).toBe('late');
    expect(escrowState(holding({ deactivatedAt: daysAgo(900) }), NOW)).toBe('late');
  });
});

/* -------------------------------------------------------------------------
 * The order of the list
 * ---------------------------------------------------------------------- */

describe('the order', () => {
  it('puts the least time first, then the largest sum', () => {
    const rows = outstandingReturns(
      [
        holding({ driverId: 'soon', deactivatedAt: daysAgo(36), balanceCents: 100_000 }),
        holding({ driverId: 'late', deactivatedAt: daysAgo(60), balanceCents: 20_000 }),
        holding({ driverId: 'big', deactivatedAt: daysAgo(36), balanceCents: 400_000 }),
      ],
      NOW,
    );

    expect(rows.map((row) => row.driverId)).toEqual(['late', 'big', 'soon']);
    expect(lateCount(rows)).toBe(1);
  });

  it('carries the day the lease ended, so the figure can be checked', () => {
    // A deadline derived from a date somebody typed has to show that date, or
    // the response to a warning that looks wrong is to distrust the screen
    // rather than to go and correct the record.
    const ended = daysAgo(40);
    const [row] = outstandingReturns([holding({ deactivatedAt: ended })], NOW);

    expect(row?.endedOn).toEqual(ended);
    expect(row?.daysLeft).toBe(5);
  });

  it('leaves out everyone with nothing outstanding', () => {
    const rows = outstandingReturns(
      [
        holding({ driverId: 'empty', balanceCents: 0 }),
        holding({ driverId: 'current', deactivatedAt: null }),
        holding({ driverId: 'company', employmentType: 'company' }),
        holding({ driverId: 'plenty', deactivatedAt: daysAgo(2) }),
      ],
      NOW,
    );

    expect(rows).toEqual([]);
  });
});
