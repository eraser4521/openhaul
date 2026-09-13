/**
 * VIN validation per ISO 3779 / 49 CFR Part 565.
 *
 * Everything in this module is pure and dependency-free so it runs identically
 * on the server, in the browser, and inside a service worker while offline.
 */

/**
 * Transliteration table (49 CFR 565.15). Digits map to themselves.
 * `I`, `O` and `Q` are deliberately absent: they are illegal in a 1981+ VIN
 * because they are confusable with `1` and `0` on stamped metal and in OCR.
 */
const TRANSLITERATION: Readonly<Record<string, number>> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
  '0': 0, '1': 1, '2': 2, '3': 3, '4': 4,
  '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
};

/**
 * Positional weights. Position 8 is weighted 10 (not 1), and position 9 is
 * weighted 0 so the printed check digit cancels itself out of the sum.
 */
const WEIGHTS: readonly number[] = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** The canonical VIN character class: A-Z minus I, O, Q, plus digits. */
export const VIN_CHAR_CLASS = /^[A-HJ-NPR-Z0-9]{17}$/;

/** Same set, for per-character checks and OCR whitelists. */
export const VIN_ALPHABET = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';

export const VIN_LENGTH = 17;

/**
 * Computes the check character that *should* sit at position 9.
 * Returns `null` when the VIN is not 17 legal characters.
 *
 * A remainder of 10 is written as `X` — the only place `X` appears as a
 * check digit, and the reason some real VINs contain one at position 9.
 */
export function computeCheckDigit(vin: string): string | null {
  if (vin.length !== VIN_LENGTH) return null;

  let sum = 0;
  for (let i = 0; i < VIN_LENGTH; i++) {
    const char = vin[i];
    if (char === undefined) return null;
    const value = TRANSLITERATION[char];
    const weight = WEIGHTS[i];
    // `undefined` here catches I, O, Q and any non-alphanumeric in one shot.
    if (value === undefined || weight === undefined) return null;
    sum += value * weight;
  }

  const remainder = sum % 11;
  return remainder === 10 ? 'X' : String(remainder);
}

/** True when position 9 matches the computed check character. */
export function isCheckDigitValid(vin: string): boolean {
  const expected = computeCheckDigit(vin);
  return expected !== null && expected === vin[8];
}

/** Full structural validation for a modern (1981+) VIN. */
export function isValidVin(vin: string): boolean {
  return VIN_CHAR_CLASS.test(vin) && isCheckDigitValid(vin);
}

/**
 * Normalizes a raw barcode payload or pasted string into a candidate VIN.
 *
 * Handles the AIAG "import" prefix: Code 39 VIN labels on vehicles frequently
 * encode 18 characters, a leading `I` followed by the 17-character VIN.
 * Stripping it is provably safe because `I` is illegal inside a VIN, so an
 * 18-character payload starting with `I` is unambiguously prefixed.
 */
export function normalizeVin(raw: string): string {
  let s = raw.toUpperCase().trim();

  // Code 39 start/stop delimiters. Mainstream decoders strip these, but a
  // hardware wedge scanner may not.
  s = s.replace(/^\*+/, '').replace(/\*+$/, '');

  // Whitespace and common label separators.
  s = s.replace(/[\s\-_.]/g, '');

  // AIAG import prefix.
  if (s.length === 18 && s.startsWith('I')) s = s.slice(1);

  return s;
}

export type VinClassification =
  | {
      kind: 'modern';
      vin: string;
      checkDigitValid: boolean;
      expectedCheckDigit: string | null;
    }
  | { kind: 'legacy'; vin: string; note: string }
  | { kind: 'invalid'; vin: string; reason: string };

/**
 * Classifies a VIN without rejecting anything outright.
 *
 * Pre-1981 VINs run 5-16 characters, have no check digit, no standard year
 * position, and *may* legally contain I, O and Q. They are still real vehicles
 * a hauler has to move, so they get their own bucket rather than an error.
 */
export function classifyVin(raw: string): VinClassification {
  const vin = normalizeVin(raw);

  if (vin.length === 0) {
    return { kind: 'invalid', vin, reason: 'VIN is empty' };
  }
  if (!/^[A-Z0-9]+$/.test(vin)) {
    return { kind: 'invalid', vin, reason: 'VIN contains non-alphanumeric characters' };
  }

  if (vin.length === VIN_LENGTH) {
    if (/[IOQ]/.test(vin)) {
      return {
        kind: 'invalid',
        vin,
        reason: 'A 17-character VIN cannot contain the letters I, O or Q',
      };
    }
    return {
      kind: 'modern',
      vin,
      checkDigitValid: isCheckDigitValid(vin),
      expectedCheckDigit: computeCheckDigit(vin),
    };
  }

  if (vin.length >= 5 && vin.length < VIN_LENGTH) {
    return {
      kind: 'legacy',
      vin,
      note: 'Pre-1981 VIN: no check digit and no standardized decode available',
    };
  }

  return {
    kind: 'invalid',
    vin,
    reason: `Expected 17 characters, got ${vin.length}`,
  };
}

/**
 * Position 3 === '9' marks a manufacturer building fewer than 500 vehicles a
 * year. For those, positions 12-14 are *also* manufacturer identifier, which
 * breaks the "last four characters are numeric" rule in 49 CFR 565.15.
 */
export function isLowVolumeManufacturer(vin: string): boolean {
  return vin[2] === '9';
}

/** The 3-character World Manufacturer Identifier (positions 1-3). */
export function getWmi(vin: string): string {
  return vin.slice(0, 3);
}

/**
 * The extended 6-character WMI used by low-volume manufacturers
 * (positions 1-3 + 12-14), or `null` for ordinary manufacturers.
 */
export function getExtendedWmi(vin: string): string | null {
  if (!isLowVolumeManufacturer(vin) || vin.length !== VIN_LENGTH) return null;
  return vin.slice(0, 3) + vin.slice(11, 14);
}

/** The serial / sequential portion (positions 12-17). */
export function getSerial(vin: string): string {
  return vin.slice(11);
}

/** Masks all but the last 6 characters, for logs and support tooling. */
export function maskVin(vin: string): string {
  if (vin.length <= 6) return vin;
  return '*'.repeat(vin.length - 6) + vin.slice(-6);
}
