import { describe, expect, it } from 'vitest';
import {
  NOTICE_DAYS,
  approaching,
  daysUntil,
  deadlineFor,
  deadlineState,
  describeAction,
  describeDeadline,
  lateCount,
  type PayableSettlement,
} from '@/lib/settlements/deadline';

/**
 * Saying so before the fifteen days run out.
 *
 * The arithmetic is a date subtraction. What is worth pinning is who the rule
 * binds: 49 CFR Part 376 governs a lease between an authorised carrier and an
 * owner-operator, and a company driver on payroll is covered by wage law that
 * this application does not model. Warning about a company driver would mean
 * printing a regulation against somebody it does not govern, which is a worse
 * failure than saying nothing.
 *
 * The rest is about what earns an interruption: a settlement paid on any
 * ordinary schedule must never appear here, or the list stops being read
 * before the one that matters arrives.
 */

const NOW = new Date('2026-09-15T09:00:00Z');

/** A period ending `days` before today, so the deadline lands predictably. */
function endedDaysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function settlement(over: Partial<PayableSettlement> = {}): PayableSettlement {
  return {
    id: 's1',
    driverId: 'd1',
    driverName: 'Marcus Webb',
    employmentType: 'owner_operator',
    periodEnd: endedDaysAgo(11),
    netPayCents: 214_000,
    finalizedAt: new Date('2026-09-05T00:00:00Z'),
    paidAt: null,
    ...over,
  };
}

/* -------------------------------------------------------------------------
 * Who the rule binds
 * ---------------------------------------------------------------------- */

describe('who this is about', () => {
  it('gives a leased owner-operator fifteen days from the period end', () => {
    const due = deadlineFor(settlement({ periodEnd: new Date('2026-09-12T00:00:00Z') }));

    expect(due).toEqual(new Date('2026-09-27T00:00:00Z'));
  });

  it('says nothing at all about a company driver', () => {
    /*
     * Part 376 governs a lease. A company driver is on payroll under state
     * wage law, which is not modelled here — so there is no deadline to be
     * near, and inventing one would attach a citation to somebody it does not
     * bind.
     */
    const company = settlement({ employmentType: 'company', periodEnd: endedDaysAgo(60) });

    expect(deadlineFor(company)).toBeNull();
    expect(deadlineState(company, NOW)).toBe('fine');
    expect(approaching([company], NOW)).toEqual([]);
  });

  it('says nothing when the period left nothing to pay', () => {
    // 376.12(f) is a deadline for payment. A period whose deductions swallowed
    // the earnings has no payment to be late with — furnishing the statement
    // is a separate obligation, and not one a date subtraction can police.
    expect(deadlineFor(settlement({ netPayCents: 0 }))).toBeNull();
    expect(deadlineFor(settlement({ netPayCents: -5_000 }))).toBeNull();
  });
});

/* -------------------------------------------------------------------------
 * What earns an interruption
 * ---------------------------------------------------------------------- */

describe('when it speaks', () => {
  it('stays quiet while there is plenty of time', () => {
    /*
     * A carrier paying within a week of the period end still has eight days on
     * the clock and must never see this. Only a settlement nobody has touched
     * gets close enough to be worth naming.
     */
    expect(deadlineState(settlement({ periodEnd: endedDaysAgo(2) }), NOW)).toBe('fine');
    expect(deadlineState(settlement({ periodEnd: endedDaysAgo(7) }), NOW)).toBe('fine');
  });

  it('speaks once the notice window opens', () => {
    expect(deadlineState(settlement({ periodEnd: endedDaysAgo(10) }), NOW)).toBe('due_soon');
    expect(deadlineState(settlement({ periodEnd: endedDaysAgo(15) }), NOW)).toBe('due_soon');
  });

  it('keeps speaking once the window has closed', () => {
    expect(deadlineState(settlement({ periodEnd: endedDaysAgo(16) }), NOW)).toBe('late');
    expect(deadlineState(settlement({ periodEnd: endedDaysAgo(40) }), NOW)).toBe('late');
  });

  it('opens the window exactly at the notice threshold', () => {
    const atThreshold = settlement({ periodEnd: endedDaysAgo(15 - NOTICE_DAYS) });
    const justOutside = settlement({ periodEnd: endedDaysAgo(15 - NOTICE_DAYS - 1) });

    expect(daysUntil(deadlineFor(atThreshold)!, NOW)).toBe(NOTICE_DAYS);
    expect(deadlineState(atThreshold, NOW)).toBe('due_soon');
    expect(deadlineState(justOutside, NOW)).toBe('fine');
  });

  it('drops a settlement the moment it is paid', () => {
    const paid = settlement({ periodEnd: endedDaysAgo(40), paidAt: new Date('2026-09-14T00:00:00Z') });

    expect(deadlineState(paid, NOW)).toBe('fine');
    expect(approaching([paid], NOW)).toEqual([]);
  });

  it('drops one paid late, rather than keeping it as a reproach', () => {
    /*
     * Whether it went out late is a fact about the past, and the settlement
     * screen answers it. A list of what to do today has no use for it, and
     * padding the list with history is how a list stops being read.
     */
    const paidLate = settlement({
      periodEnd: endedDaysAgo(40),
      paidAt: new Date('2026-09-10T00:00:00Z'),
    });

    expect(approaching([paidLate], NOW)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * The order of the list
 * ---------------------------------------------------------------------- */

describe('the order', () => {
  it('puts the least time first', () => {
    const rows = approaching(
      [
        settlement({ id: 'soon', periodEnd: endedDaysAgo(12) }),
        settlement({ id: 'late', periodEnd: endedDaysAgo(20) }),
        settlement({ id: 'edge', periodEnd: endedDaysAgo(10) }),
      ],
      NOW,
    );

    expect(rows.map((row) => row.settlementId)).toEqual(['late', 'soon', 'edge']);
    expect(lateCount(rows)).toBe(1);
  });

  it('puts a draft ahead of a finalised one falling on the same day', () => {
    /*
     * The clock runs from the driver's paperwork, not from the day somebody
     * gets round to drawing the statement — so a draft three days out needs
     * two things done rather than one, and is in more trouble, not less.
     */
    const rows = approaching(
      [
        settlement({ id: 'ready', finalizedAt: new Date('2026-09-05T00:00:00Z') }),
        settlement({ id: 'draft', finalizedAt: null }),
      ],
      NOW,
    );

    expect(rows.map((row) => row.settlementId)).toEqual(['draft', 'ready']);
    expect(rows[0]?.draft).toBe(true);
  });

  it('puts the larger sum first when nothing else separates them', () => {
    const rows = approaching(
      [
        settlement({ id: 'small', netPayCents: 40_000 }),
        settlement({ id: 'large', netPayCents: 300_000 }),
      ],
      NOW,
    );

    expect(rows.map((row) => row.settlementId)).toEqual(['large', 'small']);
  });
});

/* -------------------------------------------------------------------------
 * Wording
 * ---------------------------------------------------------------------- */

describe('how it reads', () => {
  it('counts down, then counts up', () => {
    const rows = approaching(
      [
        settlement({ id: 'a', periodEnd: endedDaysAgo(12) }),
        settlement({ id: 'b', periodEnd: endedDaysAgo(14) }),
        settlement({ id: 'c', periodEnd: endedDaysAgo(15) }),
        settlement({ id: 'd', periodEnd: endedDaysAgo(16) }),
        settlement({ id: 'e', periodEnd: endedDaysAgo(23) }),
      ],
      NOW,
    );

    const said = new Map(rows.map((row) => [row.settlementId, describeDeadline(row.daysLeft)]));

    expect(said.get('a')).toBe('3 days left');
    expect(said.get('b')).toBe('1 day left');
    expect(said.get('c')).toBe('due today');
    expect(said.get('d')).toBe('1 day over');
    expect(said.get('e')).toBe('8 days over');
  });

  it('says what is actually left to do', () => {
    // "Pay this" understates a draft, which has to be drawn first.
    const [draft] = approaching([settlement({ finalizedAt: null })], NOW);
    const [ready] = approaching([settlement({ id: 'r' })], NOW);

    expect(describeAction(draft!)).toContain('finalise');
    expect(describeAction(ready!)).toBe('ready to pay');
  });
});
