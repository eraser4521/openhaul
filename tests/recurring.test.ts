import { describe, expect, it } from 'vitest';
import {
  annualCents,
  describeOutgoing,
  hasEnded,
  nextOccurrence,
  occurrencesBetween,
  outgoingProblems,
  type Outgoing,
} from '@/lib/cash/recurring';

/**
 * The money that leaves whether or not a wheel turns.
 *
 * Date arithmetic is where a forecast rots quietly. Nothing here throws when
 * it is wrong — a truck note that silently skips February, or lands twice in
 * a week because two windows both claimed the boundary, just produces a figure
 * that is a bit off, on a screen whose whole claim is that its figures are
 * not. So the month ends, the half-open boundaries and the end date are each
 * pinned rather than assumed.
 */

function outgoing(over: Partial<Outgoing> = {}): Outgoing {
  return {
    id: 'o1',
    name: 'Freightliner note',
    category: 'loan',
    amountCents: 214_000,
    cadence: 'monthly',
    anchorOn: new Date('2026-01-10T00:00:00Z'),
    endsOn: null,
    ...over,
  };
}

const days = (dates: Date[]) => dates.map((date) => date.toISOString().slice(0, 10));

/* -------------------------------------------------------------------------
 * The cadences
 * ---------------------------------------------------------------------- */

describe('when a standing cost falls', () => {
  it('counts weekly from the anchor and nothing else', () => {
    const dates = occurrencesBetween(
      outgoing({ cadence: 'weekly', anchorOn: new Date('2026-09-02T00:00:00Z') }),
      new Date('2026-09-15T00:00:00Z'),
      new Date('2026-10-06T00:00:00Z'),
    );

    expect(days(dates)).toEqual(['2026-09-16', '2026-09-23', '2026-09-30']);
  });

  it('counts every two weeks from the anchor, not every other Wednesday', () => {
    /*
     * The distinction matters when the anchor moves. One anchor date says both
     * "which weekday" and "which of the two weeks", so there is no second
     * setting to fall out of step with it.
     */
    const dates = occurrencesBetween(
      outgoing({ cadence: 'every_two_weeks', anchorOn: new Date('2026-09-04T00:00:00Z') }),
      new Date('2026-09-15T00:00:00Z'),
      new Date('2026-10-20T00:00:00Z'),
    );

    expect(days(dates)).toEqual(['2026-09-18', '2026-10-02', '2026-10-16']);
  });

  it('keeps the same day each month', () => {
    const dates = occurrencesBetween(
      outgoing(),
      new Date('2026-09-15T00:00:00Z'),
      new Date('2026-12-15T00:00:00Z'),
    );

    expect(days(dates)).toEqual(['2026-10-10', '2026-11-10', '2026-12-10']);
  });

  it('falls back to the last day of a month too short to hold it', () => {
    // What the lender's bank does with a note anchored on the 31st.
    const dates = occurrencesBetween(
      outgoing({ anchorOn: new Date('2026-01-31T00:00:00Z') }),
      new Date('2026-02-01T00:00:00Z'),
      new Date('2026-05-01T00:00:00Z'),
    );

    expect(days(dates)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('does not let the short month stick', () => {
    /*
     * The failure this guards against: clamping February to the 28th and then
     * counting every later month from *that*, so a payment date walks
     * backwards through the year and every figure after it is on the wrong
     * day. Each occurrence is computed from the anchor, so March returns to
     * the 31st.
     */
    const dates = occurrencesBetween(
      outgoing({ anchorOn: new Date('2026-01-31T00:00:00Z') }),
      new Date('2026-01-01T00:00:00Z'),
      new Date('2027-01-01T00:00:00Z'),
    );

    expect(days(dates).filter((day) => day.endsWith('-31'))).toEqual([
      '2026-01-31',
      '2026-03-31',
      '2026-05-31',
      '2026-07-31',
      '2026-08-31',
      '2026-10-31',
      '2026-12-31',
    ]);
  });

  it('counts quarterly in threes and annually in twelves', () => {
    expect(
      days(
        occurrencesBetween(
          outgoing({ cadence: 'quarterly', anchorOn: new Date('2026-01-15T00:00:00Z') }),
          new Date('2026-02-01T00:00:00Z'),
          new Date('2027-02-01T00:00:00Z'),
        ),
      ),
    ).toEqual(['2026-04-15', '2026-07-15', '2026-10-15', '2027-01-15']);

    expect(
      days(
        occurrencesBetween(
          outgoing({ cadence: 'annually', anchorOn: new Date('2020-06-01T00:00:00Z') }),
          new Date('2026-01-01T00:00:00Z'),
          new Date('2028-01-01T00:00:00Z'),
        ),
      ),
    ).toEqual(['2026-06-01', '2027-06-01']);
  });
});

/* -------------------------------------------------------------------------
 * The edges
 * ---------------------------------------------------------------------- */

describe('the boundaries', () => {
  it('includes the first day of the window and excludes the last', () => {
    /*
     * Half-open, matching the timeline windows. If both ends were inclusive a
     * payment landing on a boundary would be counted in two consecutive weeks,
     * which is the kind of error that makes a total look plausible and be
     * wrong.
     */
    const dates = occurrencesBetween(
      outgoing({ cadence: 'weekly', anchorOn: new Date('2026-09-15T00:00:00Z') }),
      new Date('2026-09-15T00:00:00Z'),
      new Date('2026-09-22T00:00:00Z'),
    );

    expect(days(dates)).toEqual(['2026-09-15']);
  });

  it('stops at the last payment', () => {
    // A loan has a final instalment from the day it is signed. Running it past
    // the end of the term overstates what the carrier is committed to.
    const dates = occurrencesBetween(
      outgoing({ endsOn: new Date('2026-11-10T00:00:00Z') }),
      new Date('2026-09-15T00:00:00Z'),
      new Date('2027-03-01T00:00:00Z'),
    );

    expect(days(dates)).toEqual(['2026-10-10', '2026-11-10']);
  });

  it('counts the last payment itself rather than stopping the day before', () => {
    const dates = occurrencesBetween(
      outgoing({ endsOn: new Date('2026-10-10T00:00:00Z') }),
      new Date('2026-09-15T00:00:00Z'),
      new Date('2027-03-01T00:00:00Z'),
    );

    expect(days(dates)).toEqual(['2026-10-10']);
  });

  it('says nothing about a commitment that ended before the window', () => {
    expect(
      occurrencesBetween(
        outgoing({ endsOn: new Date('2026-03-10T00:00:00Z') }),
        new Date('2026-09-15T00:00:00Z'),
        new Date('2026-12-01T00:00:00Z'),
      ),
    ).toEqual([]);
  });

  it('says nothing before the first payment', () => {
    // Signing a lease that starts in November should not put anything in
    // September, and needs no special case to avoid it.
    expect(
      occurrencesBetween(
        outgoing({ anchorOn: new Date('2026-11-01T00:00:00Z') }),
        new Date('2026-09-15T00:00:00Z'),
        new Date('2026-10-13T00:00:00Z'),
      ),
    ).toEqual([]);
  });

  it('handles an anchor years behind the window', () => {
    // Jumped to rather than walked, or opening the page would cost one
    // iteration per week since the truck was bought.
    const dates = occurrencesBetween(
      outgoing({ cadence: 'weekly', anchorOn: new Date('2019-01-02T00:00:00Z') }),
      new Date('2026-09-15T00:00:00Z'),
      new Date('2026-09-29T00:00:00Z'),
    );

    expect(days(dates)).toEqual(['2026-09-16', '2026-09-23']);
  });

  it('returns nothing for a window that ends before it starts', () => {
    expect(
      occurrencesBetween(
        outgoing(),
        new Date('2026-10-01T00:00:00Z'),
        new Date('2026-09-01T00:00:00Z'),
      ),
    ).toEqual([]);
  });
});

describe('the next one', () => {
  it('finds the next payment from today', () => {
    expect(nextOccurrence(outgoing(), new Date('2026-09-15T09:00:00Z'))?.toISOString()).toBe(
      '2026-10-10T00:00:00.000Z',
    );
  });

  it('is nothing once the commitment has run out', () => {
    expect(
      nextOccurrence(
        outgoing({ endsOn: new Date('2026-08-10T00:00:00Z') }),
        new Date('2026-09-15T09:00:00Z'),
      ),
    ).toBeNull();
  });
});

/* -------------------------------------------------------------------------
 * Comparing and describing
 * ---------------------------------------------------------------------- */

describe('what it costs in a year', () => {
  it('puts a weekly charge and an annual premium on the same footing', () => {
    // The only way to see which of a list of commitments is the expensive one.
    expect(annualCents({ cadence: 'weekly', amountCents: 10_000 })).toBe(520_000);
    expect(annualCents({ cadence: 'every_two_weeks', amountCents: 10_000 })).toBe(260_000);
    expect(annualCents({ cadence: 'monthly', amountCents: 10_000 })).toBe(120_000);
    expect(annualCents({ cadence: 'quarterly', amountCents: 10_000 })).toBe(40_000);
    expect(annualCents({ cadence: 'annually', amountCents: 10_000 })).toBe(10_000);
  });
});

describe('what it refuses', () => {
  const base = {
    name: 'Freightliner note',
    amountCents: 214_000,
    anchorOn: new Date('2026-01-10T00:00:00Z'),
    endsOn: null,
  };

  it('accepts a commitment that makes sense', () => {
    expect(outgoingProblems(base)).toEqual([]);
  });

  it('refuses a commitment of nothing', () => {
    expect(outgoingProblems({ ...base, amountCents: 0 })).toHaveLength(1);
  });

  it('refuses one that ends before it begins', () => {
    const problems = outgoingProblems({
      ...base,
      endsOn: new Date('2025-01-10T00:00:00Z'),
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('before the first');
  });

  it('collects every objection at once', () => {
    // A form that reveals its objections one per submission is a form people
    // abandon halfway through.
    expect(outgoingProblems({ name: '  ', amountCents: 0, anchorOn: null, endsOn: null })).toHaveLength(3);
  });
});

describe('describing it', () => {
  it('reads as one line', () => {
    expect(describeOutgoing(outgoing())).toBe('Monthly from Jan 10, 2026');
    expect(
      describeOutgoing(outgoing({ endsOn: new Date('2029-03-10T00:00:00Z') })),
    ).toBe('Monthly from Jan 10, 2026, last one Mar 10, 2029');
  });

  it('knows when a commitment is behind us', () => {
    const now = new Date('2026-09-15T00:00:00Z');

    expect(hasEnded({ endsOn: new Date('2026-08-10T00:00:00Z') }, now)).toBe(true);
    expect(hasEnded({ endsOn: new Date('2026-09-15T00:00:00Z') }, now)).toBe(false);
    expect(hasEnded({ endsOn: null }, now)).toBe(false);
  });
});
