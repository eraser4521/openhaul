/**
 * Model year decoding from VIN position 10 (49 CFR 565.15).
 *
 * The code repeats on a 30-year cycle, so `A` means both 1980 and 2010. The
 * regulation disambiguates using position 7 — but only for light vehicles.
 */

/**
 * The 30 valid year codes in cycle order. Index 0 => 1980 (cycle 1) or
 * 2010 (cycle 2). Position 10 excludes I/O/Q like the rest of the VIN, and
 * additionally excludes U, Z and 0.
 */
export const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';

const CYCLE_ONE_BASE = 1980;
const CYCLE_TWO_BASE = 2010;

export interface ModelYearResult {
  /** Decoded model year, or `null` when position 10 is not a valid code. */
  year: number | null;
  /**
   * True when the 30-year cycle could not be resolved with confidence.
   * Heavy trucks, trailers, buses and motorcycles do not reliably follow the
   * position-7 rule, so prefer NHTSA's `ModelYear` for those.
   */
  ambiguous: boolean;
  /** The other plausible year, 30 apart, when ambiguous. */
  alternateYear: number | null;
}

/**
 * Decodes the model year from a 17-character VIN.
 *
 * Disambiguation rule for passenger cars, MPVs and trucks at or under
 * 10,000 lb GVWR: a numeric position 7 means the 1980-2009 cycle, an
 * alphabetic position 7 means the 2010-2039 cycle.
 *
 * @param referenceYear Treated as "now" when sanity-clamping. Injectable so
 *   tests do not drift as real time passes.
 */
export function decodeModelYear(vin: string, referenceYear?: number): ModelYearResult {
  const code = vin[9];
  if (code === undefined) {
    return { year: null, ambiguous: false, alternateYear: null };
  }

  const index = YEAR_CODES.indexOf(code);
  if (index === -1) {
    return { year: null, ambiguous: false, alternateYear: null };
  }

  const positionSeven = vin[6];
  if (positionSeven === undefined) {
    return { year: null, ambiguous: false, alternateYear: null };
  }

  const isAlphabetic = /[A-Z]/.test(positionSeven);
  let year = (isAlphabetic ? CYCLE_TWO_BASE : CYCLE_ONE_BASE) + index;

  // Manufacturers ship next year's models this year, so allow one year ahead.
  const maxPlausible = (referenceYear ?? new Date().getFullYear()) + 1;

  if (year > maxPlausible) {
    // The position-7 heuristic put us in the future. Fall back a cycle.
    year -= 30;
    return { year, ambiguous: true, alternateYear: year + 30 };
  }

  // Cycle-one years are only reachable when position 7 is numeric, and a
  // vehicle old enough for that is rare enough to be worth flagging.
  const alternateYear = year + 30 <= maxPlausible ? year + 30 : null;

  return { year, ambiguous: alternateYear !== null, alternateYear };
}

/** True when the character is a valid position-10 model year code. */
export function isValidYearCode(char: string): boolean {
  return YEAR_CODES.includes(char);
}

/** The position-10 code for a given model year, or `null` if out of range. */
export function encodeModelYear(year: number): string | null {
  for (const base of [CYCLE_ONE_BASE, CYCLE_TWO_BASE]) {
    const index = year - base;
    if (index >= 0 && index < YEAR_CODES.length) {
      return YEAR_CODES[index] ?? null;
    }
  }
  return null;
}
