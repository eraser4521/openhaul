import { describe, expect, it } from 'vitest';
import {
  describeDays,
  dueAt,
  effectivePolicy,
  isDue,
  POLICY_DEFINITIONS,
  RECORD_CLASSES,
} from '@/lib/retention/policy';

/**
 * The arithmetic and the floors, with no database in the way.
 *
 * Almost everything here is about refusing to act rather than acting: a null
 * anchor is never due, a floor cannot be gone below, a shorter period chosen
 * on purpose is not quietly lengthened. Retention bugs are not usually wrong
 * numbers, they are records destroyed because something was treated as zero.
 */

const DAY = 86_400_000;

describe('the policy table', () => {
  it('covers every record class exactly once', () => {
    expect(POLICY_DEFINITIONS.map((p) => p.recordClass).sort()).toEqual([...RECORD_CLASSES].sort());
  });

  it('never defaults below its own floor', () => {
    for (const policy of POLICY_DEFINITIONS) {
      expect(policy.defaultDays).toBeGreaterThanOrEqual(policy.floorDays);
    }
  });

  it('cites a regulation wherever it claims a floor', () => {
    /*
     * The inverse is allowed: a class may have no floor and no citation, which
     * says "nobody mandates this and here is why we chose a number". What is
     * not allowed is a floor presented as a legal minimum with nothing behind
     * it.
     */
    for (const policy of POLICY_DEFINITIONS) {
      if (policy.floorDays > 0) expect(policy.citation).not.toBe('');
    }
  });

  it('explains every class, including the ones with no floor', () => {
    for (const policy of POLICY_DEFINITIONS) {
      expect(policy.note.length).toBeGreaterThan(40);
      expect(policy.covers.length).toBeGreaterThan(10);
    }
  });
});

describe('the period in force', () => {
  it('uses the class default when nothing is configured', () => {
    expect(effectivePolicy('bill_of_lading').retentionDays).toBe(2557);
  });

  it('takes a saved override', () => {
    expect(effectivePolicy('bill_of_lading', { savedDays: 3650 }).retentionDays).toBe(3650);
    expect(effectivePolicy('bill_of_lading', { savedDays: 3650 }).customised).toBe(true);
  });

  it('raises anything below the floor rather than returning it', () => {
    // Only reachable from a row written before a floor changed. The screen
    // asking about it still needs an answer.
    const policy = effectivePolicy('bill_of_lading', { savedDays: 30 });
    expect(policy.retentionDays).toBe(365);
  });

  it('keeps the shorter photo period the note argues for', () => {
    /*
     * Inspection photographs default to three years on purpose, against the
     * window they are evidence for. An organisation-wide figure used to be
     * folded in here and, shipped at seven years, silently overrode it — so
     * the screen explained three years while enforcing seven.
     */
    expect(effectivePolicy('inspection_evidence').retentionDays).toBe(1096);
  });
});

describe('deciding whether a record is due', () => {
  const now = new Date('2026-09-14T12:00:00Z');

  it('is never due without an anchor date', () => {
    /*
     * The most important line in the feature. An undelivered load, an open
     * claim and a current driver all have a null anchor, and treating null as
     * the epoch would make every one of them instantly destroyable.
     */
    expect(isDue(null, 0, now)).toBe(false);
    expect(isDue(null, 2557, now)).toBe(false);
  });

  it('is due the moment the period has elapsed, and not before', () => {
    const anchor = new Date(now.getTime() - 365 * DAY);

    expect(isDue(anchor, 365, now)).toBe(true);
    expect(isDue(anchor, 366, now)).toBe(false);
  });

  it('counts from the anchor rather than from today', () => {
    expect(dueAt(new Date('2020-01-01T00:00:00Z'), 365).toISOString()).toBe(
      '2020-12-31T00:00:00.000Z',
    );
  });
});

describe('describing a period', () => {
  it('reads as years where it divides evenly', () => {
    expect(describeDays(365)).toBe('1 year');
    expect(describeDays(1095)).toBe('3 years');
  });

  it('handles the seven-year default, which includes leap days', () => {
    expect(describeDays(2557)).toBe('7 years');
  });

  it('says so when there is no minimum', () => {
    expect(describeDays(0)).toBe('no minimum');
  });
});
