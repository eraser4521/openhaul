import { describe, expect, it } from 'vitest';
import { isPdf, pdfText } from './helpers/pdf-text';
import {
  addMonths,
  claimClock,
  claimDeadlines,
  claimFilingDeadline,
  deadlineState,
  isLateFiled,
  nextStatusLetterDue,
  suitDeadline,
  worstState,
} from '@/lib/claims/deadlines';
import {
  assessPrimaFacie,
  checkClaimValidity,
  isValidClaim,
  type DamageRecord,
} from '@/lib/claims/validity';
import { nextClaimNumber } from '@/lib/claims/lifecycle';
import { renderClaimLetter, type ClaimLetterInput } from '@/lib/documents/claim-letter';

/**
 * A cargo claim is decided on dates and on the inspection record. These tests
 * care about both: that the statutory clocks land on the right day, and that
 * the comparison between the two ends of the trip says what it should.
 */

const FILED = new Date('2026-09-14T00:00:00Z');

/* -------------------------------------------------------------------------
 * 49 CFR 370.5 and 370.9 — the clocks
 * ---------------------------------------------------------------------- */

describe('claimClock', () => {
  it('puts the written acknowledgement 30 days out', () => {
    expect(claimClock(FILED).acknowledgeDueAt.toISOString()).toBe('2026-10-14T00:00:00.000Z');
  });

  it('puts disposition 120 days out', () => {
    expect(claimClock(FILED).resolveDueAt.toISOString()).toBe('2027-01-12T00:00:00.000Z');
  });

  it('counts from the date the claim was received, not the date it was entered', () => {
    // A claim that sat in an inbox for a week has already burned a week.
    const backdated = new Date('2026-08-01T00:00:00Z');
    expect(claimClock(backdated).acknowledgeDueAt.toISOString()).toBe('2026-08-31T00:00:00.000Z');
  });
});

describe('nextStatusLetterDue', () => {
  it('owes nothing until the 120-day disposition deadline passes', () => {
    expect(nextStatusLetterDue(FILED, null)?.toISOString()).toBe('2027-01-12T00:00:00.000Z');
  });

  it('then owes one every 60 days', () => {
    const first = nextStatusLetterDue(FILED, null)!;
    const second = nextStatusLetterDue(FILED, first)!;
    const third = nextStatusLetterDue(FILED, second)!;

    expect(second.toISOString()).toBe('2027-03-13T00:00:00.000Z');
    expect(third.toISOString()).toBe('2027-05-12T00:00:00.000Z');
  });

  it('does not let a late letter reset the schedule', () => {
    /*
     * A letter sent on day 200 satisfies the day-120 and day-180 deadlines it
     * passed; the next one owed is day 240, not 260. Restarting the clock from
     * the send date would quietly grant the carrier extra time it does not have.
     */
    const lateLetter = new Date('2027-04-02T00:00:00Z'); // ~day 200
    expect(nextStatusLetterDue(FILED, lateLetter)?.toISOString()).toBe('2027-05-12T00:00:00.000Z');
  });

  it('stops once the claim is disposed of, because the duty runs while pending', () => {
    expect(nextStatusLetterDue(FILED, null, { disposed: true })).toBeNull();
  });
});

/* -------------------------------------------------------------------------
 * Carmack windows
 * ---------------------------------------------------------------------- */

describe('addMonths', () => {
  it('lands on the same day of the later month', () => {
    expect(addMonths(new Date('2026-01-15T00:00:00Z'), 9).toISOString()).toBe(
      '2026-10-15T00:00:00.000Z',
    );
  });

  it('clamps to the end of a shorter month instead of rolling over', () => {
    // 31 May plus nine months is 28 February, not 3 March. Naive arithmetic
    // silently overshoots and moves the deadline two days later.
    expect(addMonths(new Date('2026-05-31T00:00:00Z'), 9).toISOString()).toBe(
      '2027-02-28T00:00:00.000Z',
    );
  });

  it('handles a leap February', () => {
    expect(addMonths(new Date('2027-05-31T00:00:00Z'), 9).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });

  it('crosses a year boundary', () => {
    expect(addMonths(new Date('2026-11-30T00:00:00Z'), 9).toISOString()).toBe(
      '2027-08-30T00:00:00.000Z',
    );
  });
});

describe('the Carmack windows', () => {
  it('allows nine months from delivery to file', () => {
    expect(claimFilingDeadline(new Date('2026-09-14T00:00:00Z')).toISOString()).toBe(
      '2027-06-14T00:00:00.000Z',
    );
  });

  it('allows two years from a written declination to sue', () => {
    expect(suitDeadline(new Date('2027-01-05T00:00:00Z')).toISOString()).toBe(
      '2029-01-05T00:00:00.000Z',
    );
  });

  it('flags a claim that arrived after the window closed', () => {
    const delivered = new Date('2026-01-10T00:00:00Z');
    // Delivered 10 January, so the window closes 10 October.
    expect(isLateFiled(new Date('2026-10-11T00:00:00Z'), delivered)).toBe(true);
    expect(isLateFiled(new Date('2026-10-10T00:00:00Z'), delivered)).toBe(false);
    expect(isLateFiled(new Date('2026-02-01T00:00:00Z'), delivered)).toBe(false);
  });

  it('does not call a claim late when the delivery date is unknown', () => {
    // Guessing against a missing date would manufacture a defence.
    expect(isLateFiled(FILED, null)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * Pressure
 * ---------------------------------------------------------------------- */

describe('deadlineState', () => {
  const now = new Date('2026-10-01T00:00:00Z');

  it('is met once the thing was done, regardless of the date', () => {
    expect(deadlineState(new Date('2026-09-01'), new Date('2026-09-20'), now)).toBe('met');
  });

  it('is overdue after the date passes unmet', () => {
    expect(deadlineState(new Date('2026-09-30T00:00:00Z'), null, now)).toBe('overdue');
  });

  it('is due soon inside a week', () => {
    expect(deadlineState(new Date('2026-10-06T00:00:00Z'), null, now)).toBe('due_soon');
  });

  it('is not overdue on the day it falls due', () => {
    expect(deadlineState(now, null, now)).toBe('due_soon');
  });

  it('is pending further out', () => {
    expect(deadlineState(new Date('2026-11-01T00:00:00Z'), null, now)).toBe('pending');
  });

  it('is not applicable when there is no date', () => {
    expect(deadlineState(null, null, now)).toBe('not_applicable');
  });
});

describe('claimDeadlines', () => {
  const base = {
    filedAt: FILED,
    acknowledgedAt: null,
    acknowledgeDueAt: claimClock(FILED).acknowledgeDueAt,
    resolveDueAt: claimClock(FILED).resolveDueAt,
    lastStatusLetterAt: null,
    disposedAt: null,
    declinedAt: null,
  };

  it('lists the acknowledgement and the disposition', () => {
    const deadlines = claimDeadlines(base, new Date('2026-09-20T00:00:00Z'));
    expect(deadlines.map((d) => d.label)).toContain('Written acknowledgement');
    expect(deadlines.map((d) => d.label)).toContain('Pay, decline or offer');
  });

  it('cites the regulation on every deadline', () => {
    for (const deadline of claimDeadlines(base, new Date('2026-09-20T00:00:00Z'))) {
      expect(deadline.citation).toMatch(/49 (CFR|U\.S\.C\.)/);
    }
  });

  it('drops the status letter once the claim is closed', () => {
    const closed = claimDeadlines(
      { ...base, disposedAt: new Date('2026-10-01T00:00:00Z') },
      new Date('2027-02-01T00:00:00Z'),
    );
    expect(closed.map((d) => d.label)).not.toContain('Next status letter');
  });

  it('adds the claimant’s suit deadline once the claim is declined', () => {
    const declined = claimDeadlines(
      {
        ...base,
        disposedAt: new Date('2026-11-01T00:00:00Z'),
        declinedAt: new Date('2026-11-01T00:00:00Z'),
      },
      new Date('2026-12-01T00:00:00Z'),
    );

    const suit = declined.find((d) => d.label.includes('sue'));
    expect(suit?.dueAt?.toISOString()).toBe('2028-11-01T00:00:00.000Z');
  });

  it('surfaces a missed acknowledgement as overdue', () => {
    const deadlines = claimDeadlines(base, new Date('2026-10-20T00:00:00Z'));
    const ack = deadlines.find((d) => d.label === 'Written acknowledgement');
    expect(ack?.state).toBe('overdue');
    expect(ack?.daysRemaining).toBeLessThan(0);
  });
});

describe('worstState', () => {
  it('reports the most urgent state on the claim', () => {
    const deadlines = claimDeadlines(
      {
        filedAt: FILED,
        acknowledgedAt: null,
        acknowledgeDueAt: claimClock(FILED).acknowledgeDueAt,
        resolveDueAt: claimClock(FILED).resolveDueAt,
        lastStatusLetterAt: null,
        disposedAt: null,
        declinedAt: null,
      },
      new Date('2026-10-20T00:00:00Z'),
    );
    expect(worstState(deadlines)).toBe('overdue');
  });

  it('falls back sensibly on an empty list', () => {
    expect(worstState([])).toBe('not_applicable');
  });
});

/* -------------------------------------------------------------------------
 * 49 CFR 370.3 — what counts as a claim
 * ---------------------------------------------------------------------- */

describe('checkClaimValidity', () => {
  const valid = {
    loadNumber: 'OH-1001',
    vin: '1HGCM82633A004352',
    assertsLiability: true,
    demandAmountCents: 185_000,
    inWriting: true,
  };

  it('accepts a communication meeting all three requirements', () => {
    expect(checkClaimValidity(valid)).toEqual([]);
    expect(isValidClaim(valid)).toBe(true);
  });

  it('requires the shipment to be identified', () => {
    const missing = checkClaimValidity({ ...valid, loadNumber: null, vin: null });
    expect(missing.map((m) => m.element)).toContain('identification');
  });

  it('accepts a VIN alone as identifying the shipment', () => {
    expect(checkClaimValidity({ ...valid, loadNumber: null })).toEqual([]);
  });

  it('requires an assertion of liability, not just a report of damage', () => {
    const missing = checkClaimValidity({ ...valid, assertsLiability: false });
    expect(missing.map((m) => m.element)).toContain('liability');
  });

  it('requires an amount', () => {
    const missing = checkClaimValidity({ ...valid, demandAmountCents: null });
    expect(missing.map((m) => m.element)).toContain('amount');
  });

  it('treats a zero demand as no demand', () => {
    const missing = checkClaimValidity({ ...valid, demandAmountCents: 0 });
    expect(missing.map((m) => m.element)).toContain('amount');
  });

  it('accepts a determinable amount with no figure on the page', () => {
    // "The cost of repair per the attached estimate" satisfies 370.3(b)(3).
    expect(
      checkClaimValidity({ ...valid, demandAmountCents: null, amountDeterminable: true }),
    ).toEqual([]);
  });

  it('rejects a claim that was never put in writing', () => {
    expect(checkClaimValidity({ ...valid, inWriting: false })).not.toEqual([]);
  });

  it('cites the regulation on every finding', () => {
    const missing = checkClaimValidity({
      loadNumber: null,
      vin: null,
      assertsLiability: false,
      demandAmountCents: null,
      inWriting: false,
    });

    expect(missing).toHaveLength(4);
    for (const finding of missing) expect(finding.citation).toBe('49 CFR 370.3');
  });
});

/* -------------------------------------------------------------------------
 * The prima facie comparison
 * ---------------------------------------------------------------------- */

function damage(code: string, overrides: Partial<DamageRecord> = {}): DamageRecord {
  return {
    code,
    description: 'Scratch on the door',
    preExisting: false,
    nonTransportation: false,
    ...overrides,
  };
}

describe('assessPrimaFacie', () => {
  const sealed = { originSealed: true, destinationSealed: true, originPhotoCount: 6, destinationPhotoCount: 6 };

  it('finds damage that appeared between the two ends of the trip', () => {
    const result = assessPrimaFacie({
      ...sealed,
      originDamages: [],
      destinationDamages: [damage('10123')],
    });

    expect(result.newAtDestination.map((d) => d.code)).toEqual(['10123']);
    expect(result.gaps).toEqual([]);
  });

  it('does not count damage that was already there at pickup', () => {
    // This is the carrier's whole defence, so it has to be exact.
    const result = assessPrimaFacie({
      ...sealed,
      originDamages: [damage('10123', { preExisting: true })],
      destinationDamages: [damage('10123')],
    });

    expect(result.newAtDestination).toEqual([]);
    expect(result.documentedAtBoth.map((d) => d.code)).toEqual(['10123']);
  });

  it('distinguishes the same damage type on a different panel', () => {
    const result = assessPrimaFacie({
      ...sealed,
      originDamages: [damage('10123')],
      destinationDamages: [damage('14045')],
    });
    expect(result.newAtDestination.map((d) => d.code)).toEqual(['14045']);
  });

  it('leaves non-transportation damage out of what the carrier caused', () => {
    const result = assessPrimaFacie({
      ...sealed,
      originDamages: [],
      destinationDamages: [damage('10123', { nonTransportation: true })],
    });
    expect(result.newAtDestination).toEqual([]);
  });

  it('names an unsealed pickup inspection as a gap in the file', () => {
    const result = assessPrimaFacie({
      ...sealed,
      originSealed: false,
      originDamages: [],
      destinationDamages: [damage('10123')],
    });
    expect(result.gaps.join(' ')).toContain('no sealed pickup inspection');
  });

  it('names missing photographs at either end', () => {
    const result = assessPrimaFacie({
      ...sealed,
      originPhotoCount: 0,
      destinationPhotoCount: 0,
      originDamages: [],
      destinationDamages: [],
    });
    expect(result.gaps.join(' ')).toContain('No photographs were taken at pickup');
    expect(result.gaps.join(' ')).toContain('No photographs were taken at delivery');
  });

  it('reports a clean delivery with nothing new', () => {
    const result = assessPrimaFacie({ ...sealed, originDamages: [], destinationDamages: [] });
    expect(result.newAtDestination).toEqual([]);
    expect(result.gaps).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * Numbering
 * ---------------------------------------------------------------------- */

describe('nextClaimNumber', () => {
  it('starts at one for the year', () => {
    expect(nextClaimNumber(2026, new Set())).toBe('CLM-2026-0001');
  });

  it('counts on from the highest already used', () => {
    expect(nextClaimNumber(2026, new Set(['CLM-2026-0001', 'CLM-2026-0002']))).toBe('CLM-2026-0003');
  });

  it('does not reuse a number after a gap', () => {
    expect(nextClaimNumber(2026, new Set(['CLM-2026-0001', 'CLM-2026-0007']))).toBe('CLM-2026-0008');
  });

  it('restarts each year without colliding across years', () => {
    expect(nextClaimNumber(2027, new Set(['CLM-2026-0009']))).toBe('CLM-2027-0001');
  });

  it('ignores numbers that are not claim numbers', () => {
    expect(nextClaimNumber(2026, new Set(['INV-OH-1001', 'BOL-OH-1001']))).toBe('CLM-2026-0001');
  });
});

/* -------------------------------------------------------------------------
 * The letters
 * ---------------------------------------------------------------------- */

function letter(overrides: Partial<ClaimLetterInput> = {}): ClaimLetterInput {
  return {
    kind: 'acknowledgement',
    claimNumber: 'CLM-2026-0001',
    issuedAt: new Date('2026-09-20T12:00:00Z'),
    carrier: {
      name: 'Ridgeline Auto Transport LLC',
      addressLine1: '4400 Meacham Blvd',
      city: 'Fort Worth',
      state: 'TX',
      postalCode: '76106',
      usdotNumber: '3312907',
    },
    claimantName: 'Cardinal Logistics Brokerage',
    receivedAt: new Date('2026-09-14T00:00:00Z'),
    loadNumber: 'OH-1001',
    vin: '1HGCM82633A004352',
    demandAmountCents: 185_000,
    ...overrides,
  };
}

describe('renderClaimLetter', () => {
  it('produces a valid PDF', async () => {
    const bytes = await renderClaimLetter(letter());
    expect(isPdf(bytes)).toBe(true);
  });

  it('acknowledges receipt, names the date, and cites 370.5', async () => {
    const text = await pdfText(await renderClaimLetter(letter()));

    expect(text).toContain('ACKNOWLEDGEMENT OF CLAIM');
    expect(text).toContain('CLM-2026-0001');
    expect(text).toContain('September 14, 2026');
    expect(text).toContain('49 CFR 370.5');
    expect(text).toContain('thirty days');
  });

  it('tells the claimant what happens next and by when', async () => {
    const text = await pdfText(await renderClaimLetter(letter()));
    expect(text).toContain('49 CFR 370.9');
    expect(text).toContain('one hundred and twenty days');
    // Counted from receipt, and said so: the letter carries two dates and
    // "the date above" would leave which one open to argument.
    expect(text).toContain('September 14, 2026, the date we received it');
  });

  it('reserves the late-filing defence without refusing the claim', async () => {
    /*
     * Acknowledging a late claim is required anyway; saying nothing about the
     * nine-month window risks the acknowledgement being read as a waiver.
     */
    const text = await pdfText(
      await renderClaimLetter(
        letter({ lateFiled: true, deliveredAt: new Date('2025-10-01T00:00:00Z') }),
      ),
    );

    expect(text).toContain('nine months of delivery');
    expect(text).toContain('not a waiver');
  });

  it('says nothing about late filing when the claim was timely', async () => {
    const text = await pdfText(await renderClaimLetter(letter()));
    expect(text).not.toContain('not a waiver');
  });

  it('gives a reason for the delay on a status letter', async () => {
    const text = await pdfText(
      await renderClaimLetter(
        letter({ kind: 'status', delayReason: 'Awaiting the repair estimate from the claimant.' }),
      ),
    );

    expect(text).toContain('CLAIM STATUS UPDATE');
    expect(text).toContain('Awaiting the repair estimate');
    expect(text).toContain('sixty');
  });

  it('falls back to a stated reason rather than leaving the delay unexplained', async () => {
    const text = await pdfText(await renderClaimLetter(letter({ kind: 'status' })));
    expect(text).toContain('Reason for the delay');
  });

  it('states the amount allowed when a claim is paid', async () => {
    const text = await pdfText(
      await renderClaimLetter(
        letter({ kind: 'disposition', disposition: 'paid', dispositionAmountCents: 185_000 }),
      ),
    );

    expect(text).toContain('DISPOSITION OF CLAIM');
    expect(text).toContain('allowed in the amount of $1,850.00');
  });

  it('makes a compromise offer firm and time-limited', async () => {
    const text = await pdfText(
      await renderClaimLetter(
        letter({ kind: 'disposition', disposition: 'offered', dispositionAmountCents: 90_000 }),
      ),
    );

    expect(text).toContain('firm compromise settlement offer of $900.00');
    expect(text).toContain('$1,850.00'); // the amount originally demanded
    expect(text).toContain('thirty days');
  });

  it('starts the two-year suit clock explicitly when declining', async () => {
    /*
     * Carmack runs the two-year window from written notice of disallowance, so
     * this letter is what starts it. A declination that does not say so invites
     * an argument later about whether notice was ever given.
     */
    const text = await pdfText(
      await renderClaimLetter(
        letter({
          kind: 'disposition',
          disposition: 'declined',
          declineReason: 'The damage was recorded on the pickup inspection before carriage.',
        }),
      ),
    );

    expect(text).toContain('Your claim is declined');
    expect(text).toContain('The damage was recorded on the pickup inspection');
    expect(text).toContain('49 U.S.C. 14706');
    expect(text).toContain('two years');
  });

  it('never leaves a declination without a stated reason', async () => {
    const text = await pdfText(
      await renderClaimLetter(letter({ kind: 'disposition', disposition: 'declined' })),
    );
    expect(text).toContain('Reason:');
  });

  it('renders on a claim with no load or VIN recorded', async () => {
    const bytes = await renderClaimLetter(letter({ loadNumber: null, vin: null }));
    expect(isPdf(bytes)).toBe(true);
  });

  it('renders deterministically, so the stored hash means something', async () => {
    const fixed = letter();
    const a = await renderClaimLetter(fixed);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const b = await renderClaimLetter(fixed);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
