import { describe, expect, it } from 'vitest';
import {
  CERTIFICATE_KINDS,
  KIND_NOTE,
  coverageCheck,
  currentCertificate,
  daysUntil,
  describeState,
  expiryState,
} from '@/lib/insurance/status';

/**
 * What a certificate says, and what it does not.
 *
 * The coverage check is the part worth the most care: a seven-car load of new
 * vehicles clears $350,000 without being unusual, and the $100,000 cargo
 * policy brokers ask for leaves the difference with the carrier. The failure
 * that matters is reporting full cover on a load nobody has valued, so an
 * unvalued vehicle has to make the answer unknown rather than cheap.
 */

const NOW = new Date('2026-09-14T12:00:00Z');
const DAY = 86_400_000;

const at = (days: number) => new Date(NOW.getTime() + days * DAY);

describe('where a certificate sits against the clock', () => {
  it('is current while it has more than a month to run', () => {
    expect(expiryState({ effectiveAt: at(-300), expiresAt: at(60) }, NOW)).toBe('current');
  });

  it('starts warning a month out', () => {
    // Thirty days is what an insurer wants to renew, and what a carrier needs
    // to avoid a week of loads they cannot accept.
    expect(expiryState({ effectiveAt: at(-300), expiresAt: at(30) }, NOW)).toBe('expiring');
    expect(expiryState({ effectiveAt: at(-300), expiresAt: at(31) }, NOW)).toBe('current');
  });

  it('is expired the day after it ends', () => {
    expect(expiryState({ effectiveAt: at(-400), expiresAt: at(-1) }, NOW)).toBe('expired');
  });

  it('knows a policy that has not started', () => {
    // Next year's renewal, uploaded early.
    expect(expiryState({ effectiveAt: at(20), expiresAt: at(385) }, NOW)).toBe('future');
  });

  it('counts whole days either side of expiry', () => {
    expect(daysUntil(at(14), NOW)).toBe(14);
    expect(daysUntil(at(-3), NOW)).toBe(-3);
  });

  it('says what it means in words', () => {
    expect(describeState({ effectiveAt: at(-300), expiresAt: at(-3) }, NOW)).toBe(
      'Expired 3 days ago',
    );
    expect(describeState({ effectiveAt: at(-300), expiresAt: at(5) }, NOW)).toBe(
      'Expires in 5 days',
    );
    expect(describeState({ effectiveAt: at(10), expiresAt: at(380) }, NOW)).toBe(
      'Not in force yet',
    );
  });
});

describe('picking the certificate that counts', () => {
  it('prefers the one that keeps cover longest', () => {
    /*
     * A carrier who uploads next year's renewal beside this year's policy
     * should see the one covering them furthest out, not whichever row was
     * typed last.
     */
    const thisYear = { effectiveAt: at(-300), expiresAt: at(60), policyNumber: 'A' };
    const renewal = { effectiveAt: at(-10), expiresAt: at(420), policyNumber: 'B' };

    expect(currentCertificate([thisYear, renewal], NOW)?.policyNumber).toBe('B');
  });

  it('ignores one that has not taken effect', () => {
    const future = { effectiveAt: at(30), expiresAt: at(400), policyNumber: 'B' };
    const live = { effectiveAt: at(-300), expiresAt: at(20), policyNumber: 'A' };

    expect(currentCertificate([future, live], NOW)?.policyNumber).toBe('A');
  });

  it('returns nothing when everything has lapsed', () => {
    expect(currentCertificate([{ effectiveAt: at(-400), expiresAt: at(-2) }], NOW)).toBeNull();
    expect(currentCertificate([], NOW)).toBeNull();
  });
});

describe('cover against what is on the deck', () => {
  const car = (value: number | null) => ({ declaredValueCents: value });

  it('reports cover when the load fits inside the limit', () => {
    const check = coverageCheck(10_000_000, [car(2_500_000), car(3_000_000)]);

    expect(check.status).toBe('covered');
    expect(check.exposureCents).toBe(5_500_000);
    expect(check.shortfallCents).toBe(0);
  });

  it('reports the shortfall when it does not', () => {
    // Seven vehicles at $50,000 against the $100,000 brokers ask for.
    const check = coverageCheck(10_000_000, Array.from({ length: 7 }, () => car(5_000_000)));

    expect(check.status).toBe('short');
    expect(check.exposureCents).toBe(35_000_000);
    expect(check.shortfallCents).toBe(25_000_000);
  });

  it('is unknown, never covered, when a vehicle has no declared value', () => {
    /*
     * The failure this exists to prevent. Treating a missing value as zero
     * would report full cover on precisely the load nobody has valued.
     */
    const check = coverageCheck(10_000_000, [car(2_500_000), car(null)]);

    expect(check.status).toBe('unknown');
    expect(check.exposureCents).toBeNull();
    expect(check.undeclared).toBe(1);
    expect(check.shortfallCents).toBe(0);
  });

  it('says there is no cover rather than guessing, when no policy is on file', () => {
    const check = coverageCheck(null, [car(2_500_000)]);

    expect(check.status).toBe('no_cover');
    expect(check.limitCents).toBeNull();
  });

  it('treats an empty deck as covered rather than unknown', () => {
    expect(coverageCheck(10_000_000, []).status).toBe('covered');
    expect(coverageCheck(10_000_000, []).exposureCents).toBe(0);
  });

  it('counts a load exactly at the limit as covered', () => {
    const check = coverageCheck(10_000_000, [car(10_000_000)]);
    expect(check.status).toBe('covered');
    expect(check.shortfallCents).toBe(0);
  });
});

describe('what each kind of cover is for', () => {
  it('explains every one, and says which are filed', () => {
    for (const kind of CERTIFICATE_KINDS) {
      expect(KIND_NOTE[kind].length).toBeGreaterThan(60);
    }

    // The two claims most likely to be got wrong the other way round.
    expect(KIND_NOTE.cargo).toContain('Not filed with FMCSA');
    expect(KIND_NOTE.liability).toContain('BMC-91');
  });
});
