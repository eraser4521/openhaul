import { describe, expect, it } from 'vitest';
import {
  MATERIAL_CENTS,
  composeAlert,
  decideAlert,
  type AlertRule,
  type BalanceContext,
  type MessageInput,
  type Previous,
} from '@/lib/cash/alert';
import type { Projection, Shortfall } from '@/lib/cash/balance';

/**
 * Telling somebody who is not looking.
 *
 * Almost nothing here is arithmetic. What is worth pinning is the judgement:
 * that ordinary trouble is never pushed, that unchanged news is never repeated,
 * that good news closes the loop exactly once, and that a stale balance changes
 * what the message says rather than whether it is sent.
 *
 * One of these tests exists because of a bug that would have shipped. The
 * timeline's windows roll from whatever day the sweep runs, so the same
 * calendar week is index 2 today and index 1 a week later. Comparing a stored
 * index against a fresh one would have had this channel announce that the
 * trouble had moved closer every single week, when all that moved was the
 * calendar — a channel crying wolf on nothing at all.
 */

const NOW = new Date('2026-09-15T07:00:00Z');

const RULE: AlertRule = {
  enabled: true,
  recipients: ['owner@ridgeline.test'],
  minimumGapDays: 2,
};

function week(index: number): { from: Date; to: Date } {
  const from = new Date(Date.UTC(2026, 8, 15 + index * 7));
  return { from, to: new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000) };
}

function shortfall(index: number, cents: number): Shortfall {
  return { index, ...week(index), cents };
}

function projection(over: Partial<Projection> = {}): Projection {
  return { openingCents: 500_000, windows: [], onPromises: null, onEverything: null, ...over };
}

const FRESH: BalanceContext = {
  amountCents: 425_000,
  asOf: new Date('2026-09-15T12:00:00Z'),
  days: 0,
  state: 'fresh',
};

const STALE: BalanceContext = {
  amountCents: 80_000,
  asOf: new Date('2026-08-26T12:00:00Z'),
  days: 20,
  state: 'stale',
};

function previous(over: Partial<Previous> = {}): Previous {
  return {
    kind: 'shortfall',
    reason: 'first',
    sentAt: new Date('2026-09-01T07:00:00Z'),
    windowFrom: week(2).from,
    shortfallCents: -100_000,
    ...over,
  };
}

/* -------------------------------------------------------------------------
 * When it stays quiet
 * ---------------------------------------------------------------------- */

describe('the silences', () => {
  it('says nothing when it is switched off', () => {
    const decision = decideAlert(
      { ...RULE, enabled: false },
      { projection: projection({ onEverything: shortfall(1, -200_000) }), balance: FRESH },
      null,
      NOW,
    );

    expect(decision).toEqual({ send: false, why: 'disabled' });
  });

  it('says nothing when nobody would receive it', () => {
    const decision = decideAlert(
      { ...RULE, recipients: [] },
      { projection: projection({ onEverything: shortfall(1, -200_000) }), balance: FRESH },
      null,
      NOW,
    );

    expect(decision).toEqual({ send: false, why: 'no_recipient' });
  });

  it('never nags for a balance it has not been given', () => {
    /*
     * With no balance there is nothing to project from, so there is nothing to
     * warn about. A message saying so would arrive forever, tell nobody
     * anything, and be the exact "nag about data entry" this channel has to
     * avoid being. The screen invites a balance; the inbox does not.
     */
    const decision = decideAlert(RULE, { projection: null, balance: null }, null, NOW);

    expect(decision).toEqual({ send: false, why: 'no_balance' });
  });

  it('says nothing while the account holds up', () => {
    const decision = decideAlert(RULE, { projection: projection(), balance: FRESH }, null, NOW);

    expect(decision).toEqual({ send: false, why: 'sound' });
  });

  it('never pushes the cautious reading on its own', () => {
    /*
     * Going under on promises alone is ordinary — few carriers have promises
     * covering a month of costs — and a channel that fires on ordinary is a
     * channel that gets filtered before it ever fires on the real thing. It
     * stays on the page, where somebody chose to look.
     */
    const decision = decideAlert(
      RULE,
      {
        projection: projection({ onPromises: shortfall(0, -480_00), onEverything: null }),
        balance: FRESH,
      },
      null,
      NOW,
    );

    expect(decision).toEqual({ send: false, why: 'sound' });
  });
});

/* -------------------------------------------------------------------------
 * When it speaks
 * ---------------------------------------------------------------------- */

describe('the first warning', () => {
  it('goes when the account goes under even if everything lands', () => {
    const decision = decideAlert(
      RULE,
      { projection: projection({ onEverything: shortfall(2, -202_420) }), balance: FRESH },
      null,
      NOW,
    );

    expect(decision).toMatchObject({ send: true, kind: 'shortfall', reason: 'first' });
  });

  it('goes on a stale balance rather than going quiet', () => {
    /*
     * Refusing to send on a stale balance would go silent exactly when nobody
     * has been in the application — which is exactly when things are going
     * wrong. The age goes in the message instead, so the reader discounts it
     * rather than having it discounted for them.
     */
    const decision = decideAlert(
      RULE,
      { projection: projection({ onEverything: shortfall(2, -202_420) }), balance: STALE },
      null,
      NOW,
    );

    expect(decision).toMatchObject({ send: true, kind: 'shortfall' });
  });
});

describe('whether it is worth saying again', () => {
  it('stays quiet when nothing about it has changed', () => {
    const decision = decideAlert(
      RULE,
      { projection: projection({ onEverything: shortfall(2, -100_000) }), balance: FRESH },
      previous(),
      NOW,
    );

    expect(decision).toEqual({ send: false, why: 'no_change' });
  });

  it('does not mistake the calendar moving for the trouble moving', () => {
    /*
     * The bug this exists to prevent. Windows roll from the day the sweep
     * runs, so the same calendar week is index 2 one week and index 1 the
     * next. Comparing indices would report "moved to an earlier week" every
     * seven days forever, on a week that had not moved at all.
     */
    const sameWeekLaterIndex: Shortfall = { ...shortfall(1, -100_000), from: week(2).from };

    const decision = decideAlert(
      RULE,
      { projection: projection({ onEverything: sameWeekLaterIndex }), balance: FRESH },
      previous({ windowFrom: week(2).from }),
      NOW,
    );

    expect(decision).toEqual({ send: false, why: 'no_change' });
  });

  it('speaks when the week itself moves earlier', () => {
    const decision = decideAlert(
      RULE,
      { projection: projection({ onEverything: shortfall(1, -100_000) }), balance: FRESH },
      previous({ windowFrom: week(2).from }),
      NOW,
    );

    expect(decision).toMatchObject({ send: true, reason: 'sooner' });
  });

  it('speaks when it becomes this week, and then lets it lie', () => {
    const imminent = projection({ onEverything: shortfall(0, -100_000) });

    expect(decideAlert(RULE, { projection: imminent, balance: FRESH }, previous(), NOW)).toMatchObject(
      { send: true, reason: 'imminent' },
    );

    // Already said. Saying it again every morning until the week arrives is
    // how somebody learns to archive this sender on sight.
    expect(
      decideAlert(
        RULE,
        { projection: imminent, balance: FRESH },
        previous({ reason: 'imminent', windowFrom: week(0).from }),
        NOW,
      ),
    ).toEqual({ send: false, why: 'no_change' });
  });

  it('speaks when it gets materially deeper, and not when it drifts', () => {
    const before = previous({ shortfallCents: -100_000 });

    const drifted = decideAlert(
      RULE,
      { projection: projection({ onEverything: shortfall(2, -110_000) }), balance: FRESH },
      before,
      NOW,
    );
    expect(drifted).toEqual({ send: false, why: 'no_change' });

    // A quarter worse and at least the floor. Either alone would fire on
    // noise: a quarter of four dollars, or a rounding error on a large one.
    const worse = decideAlert(
      RULE,
      { projection: projection({ onEverything: shortfall(2, -100_000 - MATERIAL_CENTS - 1) }), balance: FRESH },
      before,
      NOW,
    );
    expect(worse).toMatchObject({ send: true, reason: 'deeper' });
  });

  it('stays quiet when it improves without going away', () => {
    // Still true, still on the page, and not worth an interruption. Only the
    // all-clear reports good news, and only when there is none left to report.
    const decision = decideAlert(
      RULE,
      { projection: projection({ onEverything: shortfall(2, -40_000) }), balance: FRESH },
      previous({ shortfallCents: -100_000 }),
      NOW,
    );

    expect(decision).toEqual({ send: false, why: 'no_change' });
  });

  it('stays quiet when the week slips later', () => {
    const decision = decideAlert(
      RULE,
      { projection: projection({ onEverything: shortfall(3, -100_000) }), balance: FRESH },
      previous({ windowFrom: week(2).from }),
      NOW,
    );

    expect(decision).toEqual({ send: false, why: 'no_change' });
  });

  it('holds real news back only for the flapping gap', () => {
    const decision = decideAlert(
      RULE,
      { projection: projection({ onEverything: shortfall(1, -100_000) }), balance: FRESH },
      previous({ windowFrom: week(2).from, sentAt: new Date('2026-09-14T07:00:00Z') }),
      NOW,
    );

    expect(decision).toEqual({ send: false, why: 'too_soon' });
  });

  it('reports no change as no change rather than as held back', () => {
    /*
     * Different facts, and only one of them means somebody should wait. A
     * settings screen that said "held back" when the situation was simply
     * unchanged would look broken.
     */
    const decision = decideAlert(
      RULE,
      { projection: projection({ onEverything: shortfall(2, -100_000) }), balance: FRESH },
      previous({ sentAt: new Date('2026-09-15T01:00:00Z') }),
      NOW,
    );

    expect(decision).toEqual({ send: false, why: 'no_change' });
  });
});

describe('closing the loop', () => {
  it('says so once when the projection recovers', () => {
    /*
     * Without this, somebody who fixed the problem is left wondering whether
     * it is still there, and the next warning arrives into a channel they have
     * learned to distrust.
     */
    const decision = decideAlert(
      RULE,
      { projection: projection(), balance: FRESH },
      previous(),
      NOW,
    );

    expect(decision).toEqual({ send: true, kind: 'all_clear', reason: 'recovered' });
  });

  it('does not keep saying it', () => {
    const decision = decideAlert(
      RULE,
      { projection: projection(), balance: FRESH },
      previous({ kind: 'all_clear', reason: 'recovered' }),
      NOW,
    );

    expect(decision).toEqual({ send: false, why: 'sound' });
  });

  it('lets good news past the gap', () => {
    // The gap exists to stop a projection flapping either side of the line,
    // which is a reason to delay bad news, never to delay the retraction.
    const decision = decideAlert(
      RULE,
      { projection: projection(), balance: FRESH },
      previous({ sentAt: new Date('2026-09-15T01:00:00Z') }),
      NOW,
    );

    expect(decision).toMatchObject({ send: true, kind: 'all_clear' });
  });

  it('will not flap straight back into a warning', () => {
    const decision = decideAlert(
      RULE,
      { projection: projection({ onEverything: shortfall(1, -100_000) }), balance: FRESH },
      previous({ kind: 'all_clear', reason: 'recovered', sentAt: new Date('2026-09-14T07:00:00Z') }),
      NOW,
    );

    expect(decision).toEqual({ send: false, why: 'too_soon' });
  });
});

/* -------------------------------------------------------------------------
 * What it says
 * ---------------------------------------------------------------------- */

describe('the message', () => {
  function message(over: Partial<MessageInput> = {}): MessageInput {
    return {
      kind: 'shortfall',
      carrierName: 'Ridgeline Auto Transport LLC',
      shortfall: shortfall(2, -202_420),
      balance: FRESH,
      positionCents: 715_080,
      horizonWeeks: 4,
      totals: {
        promisedCents: 50_000,
        dueCents: 337_500,
        settlementCents: 362_000,
        recurringCents: 443_000,
        outCents: 805_000,
      },
      overdueInCents: 120_000,
      url: 'https://haul.example/money/timeline',
      ...over,
    };
  }

  it('leads with the week and the amount', () => {
    const { subject, text } = composeAlert(message());

    expect(subject).toBe('Cash short in the week of Sep 29 – Oct 5');
    expect(text).toContain('-$2,024.20');
    expect(text).toContain('Sep 29 – Oct 5');
  });

  it('says what it is standing on before the detail', () => {
    // A carrier whose balance is a fortnight old should know that before they
    // decide what to do about the figure, not after.
    const { text } = composeAlert(message());
    const basis = text.indexOf('Based on a balance');
    const detail = text.indexOf('falls due from customers');

    expect(basis).toBeGreaterThan(-1);
    expect(basis).toBeLessThan(detail);
  });

  it('asks for a fresh balance only when the one it has is too old', () => {
    const stale = composeAlert(message({ balance: STALE })).text;
    expect(stale).toContain('20 days old');
    expect(stale).toContain('Entering a current balance');

    const fresh = composeAlert(message()).text;
    expect(fresh).not.toContain('Entering a current balance');
  });

  it('names the largest lever when there is one', () => {
    expect(composeAlert(message()).text).toContain('$1,200.00 is already past due');
    expect(composeAlert(message({ overdueInCents: 0 })).text).not.toContain('already past due');
  });

  it('keeps promised and falling due apart, as every other screen does', () => {
    const { text } = composeAlert(message());

    expect(text).toContain('$3,375.00 falls due from customers');
    expect(text).toContain('$500.00 has been promised');
  });

  it('leaves out a link it cannot make honestly', () => {
    // A message carrying a link to localhost is worse than one carrying none.
    expect(composeAlert(message({ url: null })).text).not.toContain('http');
  });

  it('retracts plainly', () => {
    const { subject, text } = composeAlert(message({ kind: 'all_clear', shortfall: null }));

    expect(subject).toBe('Cash: no longer projected short');
    expect(text).toContain('no longer projected to go under');
    expect(text).toContain('Nothing further will be sent');
  });
});

describe('the basis line', () => {
  function base(over: Partial<MessageInput> = {}): MessageInput {
    return {
      kind: 'shortfall',
      carrierName: 'Ridgeline Auto Transport LLC',
      shortfall: shortfall(2, -249_000),
      balance: { amountCents: 90_000, asOf: new Date('2026-09-14T12:00:00Z'), days: 1, state: 'fresh' },
      positionCents: 90_000,
      horizonWeeks: 4,
      totals: {
        promisedCents: 0,
        dueCents: 150_000,
        settlementCents: 214_000,
        recurringCents: 365_000,
        outCents: 579_000,
      },
      overdueInCents: 0,
      url: null,
      ...over,
    };
  }

  it('does not print the same figure twice when nothing has moved', () => {
    /*
     * "a balance of $900.00 entered yesterday, which puts the account at about
     * $900.00 today" reads like an arithmetic slip rather than like a fact.
     */
    const { text } = composeAlert(base());

    expect(text).toContain('with nothing recorded');
    expect(text).not.toContain('puts the account');
  });

  it('does print both when the position has moved off the reading', () => {
    const { text } = composeAlert(base({ positionCents: 715_080 }));

    expect(text).toContain('puts the account');
    expect(text).toContain('$7,150.80');
  });
});
