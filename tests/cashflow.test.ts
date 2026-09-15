import { describe, expect, it } from 'vitest';
import {
  HORIZON_WEEKS,
  buildTimeline,
  describeWait,
  describeWindow,
  groupStanding,
  netOf,
  recurringMovements,
  splitPayable,
  splitReceivable,
  unknowns,
  windowsFrom,
  type Movement,
  type Receivable,
  type Standing,
} from '@/lib/cash/cashflow';

/**
 * What moves, and when.
 *
 * The arithmetic in this module is trivial. Everything worth testing is a
 * refusal: money with no future date stays off the timeline, a promise is
 * never added to the due date covering the same money, a promise for a day
 * that has passed is never quietly moved to today, and the things the page
 * cannot see are named rather than left out.
 *
 * Those are the four ways a cash forecast becomes something nobody believes,
 * and each of them looks reasonable in isolation.
 */

const NOW = new Date('2026-09-15T14:30:00Z');

function receivable(over: Partial<Receivable> = {}): Receivable {
  return {
    invoiceId: 'i1',
    invoiceNumber: 'INV-1042',
    customerName: 'Cardinal Logistics Brokerage',
    balanceCents: 187_500,
    dueAt: new Date('2026-09-25T00:00:00Z'),
    promise: null,
    ...over,
  };
}

/* -------------------------------------------------------------------------
 * Money coming in
 * ---------------------------------------------------------------------- */

describe('splitting a receivable', () => {
  it('puts the whole balance on its due date when nobody has promised anything', () => {
    const { movements, standing } = splitReceivable(receivable(), NOW);

    expect(standing).toEqual([]);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ kind: 'due', amountCents: 187_500 });
  });

  it('never counts the same money as both promised and falling due', () => {
    /*
     * The single most misleading thing this page could do. A customer who
     * promised $500 against a $1,875 invoice is paying $500 of it on the day
     * they named and the rest under the terms — not $2,375 in total.
     */
    const { movements } = splitReceivable(
      receivable({
        promise: { promisedFor: new Date('2026-09-18T00:00:00Z'), outstandingCents: 50_000 },
      }),
      NOW,
    );

    expect(movements.map((row) => [row.kind, row.amountCents])).toEqual([
      ['promised', 50_000],
      ['due', 137_500],
    ]);

    const total = movements.reduce((sum, row) => sum + row.amountCents, 0);
    expect(total).toBe(187_500);
  });

  it('never puts more on the timeline than is still owed', () => {
    // A promise made before a part-payment landed would otherwise overstate
    // what is coming, on a page whose whole value is that it does not.
    const { movements } = splitReceivable(
      receivable({
        balanceCents: 30_000,
        promise: { promisedFor: new Date('2026-09-18T00:00:00Z'), outstandingCents: 50_000 },
      }),
      NOW,
    );

    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ kind: 'promised', amountCents: 30_000 });
  });

  it('refuses to move a promise made for a day that has passed', () => {
    /*
     * Rolling it forward to today would have the carrier reading a commitment
     * nobody made. The day they named is gone; that it may still be in the
     * post is a matter for the promises worklist, not for a figure in a week.
     */
    const { movements, standing } = splitReceivable(
      receivable({
        promise: { promisedFor: new Date('2026-09-11T00:00:00Z'), outstandingCents: 50_000 },
      }),
      NOW,
    );

    expect(movements.map((row) => row.kind)).toEqual(['due']);
    expect(standing).toHaveLength(1);
    expect(standing[0]).toMatchObject({
      reason: 'promise_late',
      amountCents: 50_000,
      daysWaiting: 4,
    });
  });

  it('keeps a promise for today on the timeline rather than treating it as late', () => {
    // Compared by calendar day. A promise for today is due today whether it
    // is half past two in the afternoon or nine in the morning.
    const { movements, standing } = splitReceivable(
      receivable({
        balanceCents: 50_000,
        promise: { promisedFor: new Date('2026-09-15T00:00:00Z'), outstandingCents: 50_000 },
      }),
      NOW,
    );

    expect(standing).toEqual([]);
    expect(movements[0]).toMatchObject({ kind: 'promised' });
  });

  it('leaves what is already past due off the timeline entirely', () => {
    /*
     * It could arrive any day, or never. Putting it in the first week would
     * be inventing a date the customer has not given, and it would bury the
     * one fact somebody most needs to see.
     */
    const { movements, standing } = splitReceivable(
      receivable({ dueAt: new Date('2026-06-17T00:00:00Z') }),
      NOW,
    );

    expect(movements).toEqual([]);
    expect(standing[0]).toMatchObject({ reason: 'overdue', daysWaiting: 90 });
  });

  it('says so when the invoice never had a due date', () => {
    // A different thing from overdue, and fixable: setting payment terms puts
    // it on the timeline. Folding it in with the late ones would hide that.
    const { standing } = splitReceivable(receivable({ dueAt: null }), NOW);

    expect(standing[0]).toMatchObject({ reason: 'no_due_date', daysWaiting: null });
  });

  it('says on the row when a promise on that invoice was broken', () => {
    /*
     * The broken promise is deliberately not in the promised column — it is
     * the opposite of money coming. But the due date has not moved, and a row
     * reading as a plain payment term would be this page flattering the one
     * receivable it has the most reason to doubt.
     */
    const { movements } = splitReceivable(receivable({ promiseBroken: true }), NOW);

    expect(movements[0]?.kind).toBe('due');
    expect(movements[0]?.because).toContain('broken');
  });

  it('ignores an invoice with nothing left owing', () => {
    expect(splitReceivable(receivable({ balanceCents: 0 }), NOW)).toEqual({
      movements: [],
      standing: [],
    });
  });
});

/* -------------------------------------------------------------------------
 * Money going out
 * ---------------------------------------------------------------------- */

describe('an unpaid settlement', () => {
  const payable = {
    settlementId: 's1',
    driverName: 'Marcus Ruiz',
    periodEnd: new Date('2026-09-12T00:00:00Z'),
    netPayCents: 214_000,
    draft: false,
  };

  it('is dated by the fifteen days the law allows, not by when anybody means to pay', () => {
    const { movements } = splitPayable(payable, NOW);

    expect(movements[0]?.on).toEqual(new Date('2026-09-27T00:00:00Z'));
    expect(movements[0]).toMatchObject({ kind: 'settlement', amountCents: 214_000 });
    expect(movements[0]?.because).toContain('376.12(f)');
  });

  it('counts a draft, because the clock does not wait for the paperwork', () => {
    /*
     * The fifteen days run from the driver's documents, not from the day
     * somebody gets round to drawing the statement. Leaving drafts off would
     * let a carrier make Friday look survivable by not finalising — which is
     * precisely the week they most need the truth.
     */
    const { movements } = splitPayable({ ...payable, draft: true }, NOW);

    expect(movements).toHaveLength(1);
    expect(movements[0]?.reference).toBe('Settlement still in draft');
  });

  it('comes off the timeline once it is past that deadline', () => {
    const { movements, standing } = splitPayable(
      { ...payable, periodEnd: new Date('2026-08-01T00:00:00Z') },
      NOW,
    );

    expect(movements).toEqual([]);
    expect(standing[0]).toMatchObject({ reason: 'settlement_late', daysWaiting: 30 });
  });
});

/* -------------------------------------------------------------------------
 * The weeks
 * ---------------------------------------------------------------------- */

describe('the timeline', () => {
  function movement(over: Partial<Movement>): Movement {
    return {
      key: 'k',
      kind: 'due',
      on: new Date('2026-09-16T00:00:00Z'),
      amountCents: 10_000,
      reference: 'INV-1',
      counterparty: 'Someone',
      because: 'because',
      ...over,
    };
  }

  it('runs in rolling weeks from today rather than from a calendar Sunday', () => {
    // Which avoids having to decide what day a week starts on, and answers
    // "the next fortnight" rather than "which side of the weekend".
    const spans = windowsFrom(NOW);

    expect(spans).toHaveLength(HORIZON_WEEKS);
    expect(spans[0]?.from).toEqual(new Date('2026-09-15T00:00:00Z'));
    expect(spans[0]?.to).toEqual(new Date('2026-09-22T00:00:00Z'));
    expect(spans[3]?.to).toEqual(new Date('2026-10-13T00:00:00Z'));
  });

  it('keeps promised and falling due in separate columns', () => {
    const timeline = buildTimeline(
      [
        movement({ key: 'a', kind: 'promised', amountCents: 50_000 }),
        movement({ key: 'b', kind: 'due', amountCents: 137_500 }),
        movement({ key: 'c', kind: 'settlement', amountCents: 214_000 }),
      ],
      NOW,
    );

    expect(timeline.windows[0]).toMatchObject({
      promisedCents: 50_000,
      dueCents: 137_500,
      outCents: 214_000,
    });
  });

  it('adds standing costs to what goes out while still saying which is which', () => {
    /*
     * The account sees one figure leave, so the total has to include both. But
     * a driver settlement and a truck note are answerable in completely
     * different ways — one can be drawn a week later, the other cannot — so
     * the split is kept beside the total rather than instead of it.
     */
    const timeline = buildTimeline(
      [
        movement({ key: 'c', kind: 'settlement', amountCents: 214_000 }),
        movement({ key: 'd', kind: 'recurring', amountCents: 90_000 }),
      ],
      NOW,
    );

    expect(timeline.windows[0]).toMatchObject({
      settlementCents: 214_000,
      recurringCents: 90_000,
      outCents: 304_000,
    });
    expect(timeline.totals.outCents).toBe(304_000);
  });

  it('turns a standing cost into one movement per payment', () => {
    const rows = recurringMovements(
      {
        id: 'o1',
        name: 'Freightliner note',
        category: 'loan',
        amountCents: 90_000,
        cadence: 'weekly',
        anchorOn: new Date('2026-09-16T00:00:00Z'),
        endsOn: null,
      },
      NOW,
      new Date('2026-10-13T00:00:00Z'),
    );

    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ kind: 'recurring', amountCents: 90_000 });
    // Keyed by the day as well as the commitment, or four payments from one
    // note would collide into one row.
    expect(new Set(rows.map((row) => row.key)).size).toBe(4);
  });

  it('carries what is dated past the horizon rather than dropping it', () => {
    const timeline = buildTimeline(
      [movement({ on: new Date('2026-11-20T00:00:00Z'), amountCents: 90_000 })],
      NOW,
    );

    expect(timeline.totals.dueCents).toBe(0);
    expect(timeline.later.dueCents).toBe(90_000);
  });

  it('drops anything already in the past instead of sweeping it into this week', () => {
    const timeline = buildTimeline(
      [movement({ on: new Date('2026-08-01T00:00:00Z'), amountCents: 90_000 })],
      NOW,
    );

    expect(timeline.totals.dueCents).toBe(0);
    expect(timeline.later.dueCents).toBe(0);
  });

  it('reads the net two ways, because the gap between them is the point', () => {
    /*
     * A week that clears on everything and drowns on promises alone depends
     * entirely on invoices nobody has committed to paying. One "net" figure
     * would hide which of the two it was.
     */
    const net = netOf({ promisedCents: 50_000, dueCents: 200_000, outCents: 214_000 });

    expect(net.ifAllLands).toBe(36_000);
    expect(net.ifOnlyPromised).toBe(-164_000);
  });
});

/* -------------------------------------------------------------------------
 * What has no date
 * ---------------------------------------------------------------------- */

describe('grouping what is not on the timeline', () => {
  function standing(over: Partial<Standing>): Standing {
    return {
      key: 'k',
      reason: 'overdue',
      amountCents: 10_000,
      reference: 'INV-1',
      counterparty: 'Someone',
      daysWaiting: 5,
      ...over,
    };
  }

  it('groups by why it has no date, longest wait first', () => {
    const groups = groupStanding([
      standing({ key: 'a', daysWaiting: 5 }),
      standing({ key: 'b', daysWaiting: 90 }),
      standing({ key: 'c', reason: 'settlement_late', amountCents: 214_000 }),
    ]);

    expect(groups.map((group) => group.reason)).toEqual(['overdue', 'settlement_late']);
    expect(groups[0]?.rows.map((row) => row.key)).toEqual(['b', 'a']);
    expect(groups[0]?.amountCents).toBe(20_000);
  });

  it('marks which way each pile moves', () => {
    const groups = groupStanding([
      standing({ reason: 'refund_owed' }),
      standing({ reason: 'no_due_date' }),
    ]);

    expect(groups.map((group) => [group.reason, group.direction])).toEqual([
      ['no_due_date', 'in'],
      ['refund_owed', 'out'],
    ]);
  });

  it('leaves out the reasons that have nothing under them', () => {
    expect(groupStanding([])).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * What it cannot see
 * ---------------------------------------------------------------------- */

describe('the gaps', () => {
  it('says it does not know the bank balance, until it does', () => {
    /*
     * The important one. Without a balance this shows movement and not whether
     * there will be enough, and a reader who does not know that will take a
     * week that nets positive as a week they can cover.
     *
     * It has to stop once somebody enters one. A caveat the page has outgrown
     * is how a reader learns to skip the section the real caveats are in.
     */
    const without = unknowns({
      accruedPayCents: 0,
      accruedLoadCount: 0,
      hasBalance: false,
      recurringCount: 0,
    });

    expect(without[0]?.what).toBe('What is actually in the account');
    expect(without[0]?.why).toContain('not what you have');

    const with_ = unknowns({
      accruedPayCents: 0,
      accruedLoadCount: 0,
      hasBalance: true,
      recurringCount: 0,
    });

    expect(with_.some((row) => row.what === 'What is actually in the account')).toBe(false);
  });

  it('names standing costs as the largest gap until some are recorded', () => {
    const none = unknowns({
      accruedPayCents: 0,
      accruedLoadCount: 0,
      hasBalance: true,
      recurringCount: 0,
    });

    expect(none.some((row) => row.why.includes('largest thing missing'))).toBe(true);

    // And stops saying so once they are, because by then it is not true.
    const some = unknowns({
      accruedPayCents: 0,
      accruedLoadCount: 0,
      hasBalance: true,
      recurringCount: 3,
    });

    expect(some.some((row) => row.why.includes('largest thing missing'))).toBe(false);
    expect(some.some((row) => row.why.includes('3 standing costs'))).toBe(true);
  });

  it('counts one standing cost as one', () => {
    const rows = unknowns({
      accruedPayCents: 0,
      accruedLoadCount: 0,
      hasBalance: true,
      recurringCount: 1,
    });

    expect(rows.some((row) => row.why.includes('one standing cost'))).toBe(true);
  });

  it('gives accrued driver pay as a figure rather than as a category', () => {
    // Somebody who can see the number can decide whether it matters to them.
    // Somebody told only that a category exists cannot.
    const rows = unknowns({
      accruedPayCents: 412_000,
      accruedLoadCount: 6,
      hasBalance: false, recurringCount: 0,
    });

    expect(rows.some((row) => row.why.includes('6 delivered loads'))).toBe(true);
  });

  it('counts one load as one load', () => {
    const rows = unknowns({
      accruedPayCents: 70_000,
      accruedLoadCount: 1,
      hasBalance: false, recurringCount: 0,
    });

    expect(rows.some((row) => row.why.includes('one delivered load'))).toBe(true);
  });

  it('says nothing about accrued pay when every delivered load is settled', () => {
    const rows = unknowns({ accruedPayCents: 0, accruedLoadCount: 0, hasBalance: false, recurringCount: 0 });

    expect(rows.some((row) => row.what.includes('Driver pay'))).toBe(false);
  });

  it('always warns that a due date is not a commitment', () => {
    const rows = unknowns({ accruedPayCents: 0, accruedLoadCount: 0, hasBalance: true, recurringCount: 0 });

    expect(rows.map((row) => row.what)).toContain('Whether a due date means a payment');
  });
});

/* -------------------------------------------------------------------------
 * Wording
 * ---------------------------------------------------------------------- */

describe('how it is worded', () => {
  it('names a week by its days, so nobody has to agree when a week starts', () => {
    expect(
      describeWindow({
        from: new Date('2026-09-15T00:00:00Z'),
        to: new Date('2026-09-22T00:00:00Z'),
      }),
    ).toBe('Sep 15 – Sep 21');
  });

  it('agrees the noun with the count', () => {
    expect(describeWait(1)).toBe('1 day');
    expect(describeWait(11)).toBe('11 days');
    expect(describeWait(0)).toBeNull();
    expect(describeWait(null)).toBeNull();
  });
});
