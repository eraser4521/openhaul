import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { relativeTime } from '@/lib/utils/format';

/**
 * How long ago something happened.
 *
 * The interesting property is not the arithmetic, it is that the string holds
 * still. `relativeTime` reads the clock, so anything it returns is rendered
 * once on the server and again on the client a moment later — and if those two
 * strings differ, React tears the page down with a hydration failure rather
 * than quietly patching the text.
 *
 * It used to report seconds, which meant the two renders essentially never
 * agreed for a fresh row. The Settings sessions list was the reliable case: the
 * current session's last-seen time is rewritten on every request, so it was
 * always a few seconds old. Measured against the running dev server, the same
 * row rendered "30s ago" and then "33s ago" three seconds later.
 */

const NOW = new Date('2026-09-15T12:00:00Z');

function ago(seconds: number): Date {
  return new Date(NOW.getTime() - seconds * 1000);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('holding still', () => {
  it('says the same thing however long the page takes to hydrate', () => {
    /*
     * The regression test. A row a few seconds old is rendered on the server,
     * then again on the client after the bundle has loaded. Whatever that gap
     * turns out to be, the two have to agree.
     */
    const row = ago(4);
    const onTheServer = relativeTime(row);

    for (const gapMs of [200, 1_000, 5_000, 30_000]) {
      vi.setSystemTime(new Date(NOW.getTime() + gapMs));
      expect(relativeTime(row)).toBe(onTheServer);
    }
  });

  it('holds still across a slow hydration of a minutes-old row', () => {
    const row = ago(300);
    const onTheServer = relativeTime(row);

    vi.setSystemTime(new Date(NOW.getTime() + 2_000));
    expect(relativeTime(row)).toBe(onTheServer);
  });
});

describe('what it reports', () => {
  it('calls anything inside the last minute just now', () => {
    // Not "4s ago". No screen here is answering a question where four seconds
    // and forty are different answers.
    expect(relativeTime(ago(0))).toBe('just now');
    expect(relativeTime(ago(4))).toBe('just now');
    expect(relativeTime(ago(59))).toBe('just now');
  });

  it('starts counting at a minute', () => {
    // The clamp is a floor, not a blanket: real elapsed time still shows.
    expect(relativeTime(ago(60))).toBe('1m ago');
    expect(relativeTime(ago(3_600))).toBe('1h ago');
  });

  it('still reports the larger units', () => {
    expect(relativeTime(ago(7_200))).toBe('2h ago');
    expect(relativeTime(ago(86_400 * 3))).toBe('3d ago');
    expect(relativeTime(ago(604_800 * 2))).toBe('2w ago');
    expect(relativeTime(ago(2_592_000 * 4))).toBe('4mo ago');
    expect(relativeTime(ago(31_536_000 * 2))).toBe('2y ago');
  });

  it('handles something still to come', () => {
    /*
     * Settlement periods and retention due dates are sometimes ahead of now,
     * so the future side has to read as English rather than as a negative.
     */
    expect(relativeTime(new Date(NOW.getTime() + 30 * 1000))).toBe('in a moment');
    expect(relativeTime(new Date(NOW.getTime() + 2 * 3_600 * 1000))).toBe('in 2h');
    expect(relativeTime(new Date(NOW.getTime() + 3 * 86_400 * 1000))).toBe('in 3d');
  });

  it('takes a date, a string or a number', () => {
    const at = ago(7_200);

    expect(relativeTime(at)).toBe('2h ago');
    expect(relativeTime(at.toISOString())).toBe('2h ago');
    expect(relativeTime(at.getTime())).toBe('2h ago');
  });
});
