import { describe, expect, it } from 'vitest';
import {
  assessAccent,
  contrastOnWhite,
  darkenForText,
  luminance,
  MIN_TEXT_CONTRAST,
  parseHex,
  toHex,
} from '@/lib/branding/color';
import {
  basisText,
  extendedCents,
  formatQuantity,
  parseQuantity,
  sumAccessorials,
  unitNoun,
} from '@/lib/branding/accessorial-math';

/**
 * The two pieces of arithmetic behind a template.
 *
 * Both exist because a document leaves the screen. The colour maths decides
 * whether a heading survives a fax; the accessorial maths decides whether a
 * broker's accounts department can check a line without ringing up.
 */

describe('reading a colour', () => {
  it('takes six hex digits with or without the hash', () => {
    expect(parseHex('#1F4E79')).toEqual({ r: 0x1f, g: 0x4e, b: 0x79 });
    expect(parseHex('1f4e79')).toEqual({ r: 0x1f, g: 0x4e, b: 0x79 });
    expect(parseHex('  1F4E79  ')).toEqual({ r: 0x1f, g: 0x4e, b: 0x79 });
  });

  it('refuses anything else rather than guessing', () => {
    // Three-digit shorthand is deliberately not accepted: guessing that 'f00'
    // means 'ff0000' is a guess, and the field says six digits.
    expect(parseHex('f00')).toBeNull();
    expect(parseHex('nonsense')).toBeNull();
    expect(parseHex('1f4e7')).toBeNull();
    expect(parseHex('1f4e79ff')).toBeNull();
    expect(parseHex(null)).toBeNull();
    expect(parseHex('')).toBeNull();
  });

  it('round-trips through hex', () => {
    expect(toHex({ r: 31, g: 78, b: 121 })).toBe('1f4e79');
    expect(toHex({ r: 0, g: 0, b: 0 })).toBe('000000');
    expect(toHex({ r: 255, g: 255, b: 255 })).toBe('ffffff');
  });

  it('clamps out-of-range channels rather than emitting invalid hex', () => {
    expect(toHex({ r: -5, g: 300, b: 127.6 })).toBe('00ff80');
  });
});

describe('contrast against white', () => {
  it('matches the known bounds', () => {
    expect(luminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
    expect(luminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5);
    expect(contrastOnWhite({ r: 0, g: 0, b: 0 })).toBeCloseTo(21, 1);
    expect(contrastOnWhite({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
  });

  it('leaves a colour that already reads as text exactly as it was', () => {
    const navy = { r: 0x1f, g: 0x4e, b: 0x79 };
    expect(contrastOnWhite(navy)).toBeGreaterThan(MIN_TEXT_CONTRAST);
    expect(darkenForText(navy)).toEqual(navy);
  });

  it('darkens a colour too pale to print as text until it clears the threshold', () => {
    /*
     * A mid-orange is the case that matters: it looks strong on a screen and
     * disappears on the photocopy a broker files. Darkening rather than
     * replacing keeps it recognisably the carrier's colour.
     */
    const orange = { r: 0xf5, g: 0x9e, b: 0x0b };
    expect(contrastOnWhite(orange)).toBeLessThan(MIN_TEXT_CONTRAST);

    const darkened = darkenForText(orange);
    expect(contrastOnWhite(darkened)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);

    // Same hue, less light: the channel ratios are preserved.
    expect(darkened.r / darkened.g).toBeCloseTo(orange.r / orange.g, 3);
    expect(darkened.b / darkened.g).toBeCloseTo(orange.b / orange.g, 3);
    expect(darkened.r).toBeLessThan(orange.r);
  });

  it('handles yellow, which is the worst case', () => {
    const yellow = { r: 255, g: 255, b: 0 };
    expect(contrastOnWhite(darkenForText(yellow))).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });

  it('reports whether a colour was darkened, so the carrier is told', () => {
    const pale = assessAccent('F59E0B');
    expect(pale.darkened).toBe(true);
    expect(pale.color).not.toBeNull();

    const dark = assessAccent('1F4E79');
    expect(dark.darkened).toBe(false);

    const broken = assessAccent('not a colour');
    expect(broken.color).toBeNull();
    expect(broken.textColor).toBeNull();
    expect(broken.darkened).toBe(false);
  });
});

describe('accessorial arithmetic', () => {
  it('extends quantity by rate in whole cents', () => {
    // 3.5 hours at $75.00.
    expect(extendedCents({ quantityHundredths: 350, unitCents: 7_500 })).toBe(26_250);
    expect(extendedCents({ quantityHundredths: 100, unitCents: 15_000 })).toBe(15_000);
    expect(extendedCents({ quantityHundredths: 0, unitCents: 15_000 })).toBe(0);
  });

  it('rounds a half cent away from zero, so a reversal matches its original', () => {
    /*
     * Math.round takes -0.5 up to 0, which would make a credit a cent short of
     * the charge it reverses. Every one of those is a query.
     */
    const line = { quantityHundredths: 150, unitCents: 33 };
    expect(extendedCents(line)).toBe(50);
    expect(extendedCents({ ...line, unitCents: -33 })).toBe(-50);
  });

  it('sums a set of lines', () => {
    expect(
      sumAccessorials([
        { quantityHundredths: 350, unitCents: 7_500 },
        { quantityHundredths: 100, unitCents: 22_500 },
      ]),
    ).toBe(48_750);
    expect(sumAccessorials([])).toBe(0);
  });

  it('prints only the decimals a quantity needs', () => {
    expect(formatQuantity(100)).toBe('1');
    expect(formatQuantity(350)).toBe('3.5');
    expect(formatQuantity(325)).toBe('3.25');
    expect(formatQuantity(305)).toBe('3.05');
    expect(formatQuantity(1_200)).toBe('12');
  });

  it('agrees the unit with the quantity', () => {
    expect(unitNoun('per_hour', 100)).toBe('hr');
    expect(unitNoun('per_hour', 350)).toBe('hrs');
    expect(unitNoun('per_day', 100)).toBe('day');
    expect(unitNoun('per_day', 200)).toBe('days');
    expect(unitNoun('flat', 100)).toBe('');
  });

  it('shows the working on anything that is not a single flat charge', () => {
    expect(
      basisText({
        label: 'Detention',
        code: 'DET',
        unit: 'per_hour',
        quantityHundredths: 350,
        unitCents: 7_500,
      }),
    ).toBe('3.5 hrs at $75.00');

    expect(
      basisText({
        label: 'Storage',
        code: null,
        unit: 'per_day',
        quantityHundredths: 100,
        unitCents: 5_000,
      }),
    ).toBe('1 day at $50.00');
  });

  it('says nothing for one flat charge, which has no working to show', () => {
    expect(
      basisText({
        label: 'Winch out',
        code: 'WIN',
        unit: 'flat',
        quantityHundredths: 100,
        unitCents: 22_500,
      }),
    ).toBeNull();
  });

  it('still shows the working for more than one of a flat charge', () => {
    expect(
      basisText({
        label: 'Extra stop',
        code: null,
        unit: 'flat',
        quantityHundredths: 200,
        unitCents: 5_000,
      }),
    ).toBe('2 at $50.00');
  });

  it('reads a typed quantity to two decimals', () => {
    expect(parseQuantity('3')).toBe(300);
    expect(parseQuantity('3.5')).toBe(350);
    expect(parseQuantity('3.25')).toBe(325);
    expect(parseQuantity(' 0.5 ')).toBe(50);
  });

  it('refuses a quantity it cannot bill exactly', () => {
    /*
     * 3.333 hours is a figure the invoice cannot express. Rounding it to 3.33
     * would bill a number nobody chose, so it is rejected and the carrier is
     * asked again.
     */
    expect(parseQuantity('3.333')).toBeNull();
    expect(parseQuantity('-2')).toBeNull();
    expect(parseQuantity('two')).toBeNull();
    expect(parseQuantity('')).toBeNull();
    expect(parseQuantity('3,5')).toBeNull();
  });
});
