import { describe, expect, it } from 'vitest';
import {
  classifyVin,
  computeCheckDigit,
  decodeModelYear,
  encodeModelYear,
  getExtendedWmi,
  getWmi,
  isCheckDigitValid,
  isLowVolumeManufacturer,
  isUsableDecode,
  isValidVin,
  mapVpicResult,
  maskVin,
  normalizeVin,
  parseVpicErrors,
  YEAR_CODES,
} from '@/lib/vin';

/**
 * Fixtures verified against the live NHTSA vPIC validator.
 *
 * Note that NHTSA's own API documentation uses `5YJSA1E26HF000337` as a
 * sample, and that VIN fails its own check digit — the correct one is `7`.
 * Never use vendor doc samples as validator fixtures.
 */
const HONDA_ACCORD_2003 = '1HGCM82633A004352';
const TESLA_MODEL_S_2017 = '5YJSA1E27HF000337';
const TESLA_BAD_CHECK_DIGIT = '5YJSA1E26HF000337';
const X_CHECK_DIGIT = '1M8GDM9AXKP042788';
const ALL_ONES = '11111111111111111';

describe('computeCheckDigit', () => {
  it('computes the documented check digit for a known-good VIN', () => {
    expect(computeCheckDigit(HONDA_ACCORD_2003)).toBe('3');
  });

  it('returns X when the remainder is 10', () => {
    expect(computeCheckDigit(X_CHECK_DIGIT)).toBe('X');
  });

  it('handles the all-ones smoke test', () => {
    expect(computeCheckDigit(ALL_ONES)).toBe('1');
  });

  it('rejects VINs containing I, O or Q', () => {
    expect(computeCheckDigit('1HGCM8263IA004352')).toBeNull();
    expect(computeCheckDigit('1HGCM8263OA004352')).toBeNull();
    expect(computeCheckDigit('1HGCM8263QA004352')).toBeNull();
  });

  it('rejects VINs of the wrong length', () => {
    expect(computeCheckDigit('1HGCM82633A00435')).toBeNull();
    expect(computeCheckDigit('1HGCM82633A0043521')).toBeNull();
    expect(computeCheckDigit('')).toBeNull();
  });

  it('rejects non-alphanumeric characters', () => {
    expect(computeCheckDigit('1HGCM8263-A004352')).toBeNull();
  });
});

describe('isCheckDigitValid', () => {
  it.each([HONDA_ACCORD_2003, TESLA_MODEL_S_2017, X_CHECK_DIGIT, ALL_ONES])(
    'accepts %s',
    (vin) => {
      expect(isCheckDigitValid(vin)).toBe(true);
    },
  );

  it('rejects the NHTSA documentation sample with a bad check digit', () => {
    expect(isCheckDigitValid(TESLA_BAD_CHECK_DIGIT)).toBe(false);
  });
});

describe('isValidVin', () => {
  it('accepts structurally valid VINs', () => {
    expect(isValidVin(HONDA_ACCORD_2003)).toBe(true);
  });

  it('rejects a valid-length VIN with an illegal letter', () => {
    expect(isValidVin('1HGCM8263IA004352')).toBe(false);
  });

  it('rejects lowercase input, which callers must normalize first', () => {
    expect(isValidVin(HONDA_ACCORD_2003.toLowerCase())).toBe(false);
  });
});

describe('normalizeVin', () => {
  it('uppercases and trims', () => {
    expect(normalizeVin(`  ${HONDA_ACCORD_2003.toLowerCase()}  `)).toBe(HONDA_ACCORD_2003);
  });

  it('strips the AIAG import prefix from an 18-character Code 39 payload', () => {
    expect(normalizeVin(`I${HONDA_ACCORD_2003}`)).toBe(HONDA_ACCORD_2003);
  });

  it('leaves a legitimate 17-character VIN starting with a digit alone', () => {
    expect(normalizeVin(HONDA_ACCORD_2003)).toBe(HONDA_ACCORD_2003);
  });

  it('does not strip a leading digit from an 18-character payload', () => {
    // Digits are legal VIN characters, so a leading '1' is not provably a prefix.
    const eighteen = `1${HONDA_ACCORD_2003}`;
    expect(normalizeVin(eighteen)).toBe(eighteen);
  });

  it('strips Code 39 start and stop delimiters', () => {
    expect(normalizeVin(`*${HONDA_ACCORD_2003}*`)).toBe(HONDA_ACCORD_2003);
  });

  it('strips separators that appear on printed labels', () => {
    expect(normalizeVin('1HG-CM8 2633A00.4352')).toBe(HONDA_ACCORD_2003);
  });
});

describe('classifyVin', () => {
  it('classifies a modern VIN with a good check digit', () => {
    const result = classifyVin(HONDA_ACCORD_2003);
    expect(result.kind).toBe('modern');
    if (result.kind === 'modern') {
      expect(result.checkDigitValid).toBe(true);
      expect(result.expectedCheckDigit).toBe('3');
    }
  });

  it('classifies a modern VIN with a bad check digit without rejecting it', () => {
    const result = classifyVin(TESLA_BAD_CHECK_DIGIT);
    expect(result.kind).toBe('modern');
    if (result.kind === 'modern') {
      expect(result.checkDigitValid).toBe(false);
      expect(result.expectedCheckDigit).toBe('7');
    }
  });

  it('treats a 13-character pre-1981 VIN as legacy rather than invalid', () => {
    const result = classifyVin('1G1AY87K6E5');
    expect(result.kind).toBe('legacy');
  });

  it('allows I, O and Q in a legacy VIN', () => {
    const result = classifyVin('CCL337Z1O5432');
    expect(result.kind).toBe('legacy');
  });

  it('rejects I, O and Q in a 17-character VIN', () => {
    const result = classifyVin('1HGCM8263IA004352');
    expect(result.kind).toBe('invalid');
  });

  it('rejects empty input', () => {
    expect(classifyVin('   ').kind).toBe('invalid');
  });

  it('rejects an implausibly short fragment', () => {
    expect(classifyVin('1HG').kind).toBe('invalid');
  });
});

describe('decodeModelYear', () => {
  it('decodes a 2003 vehicle using the numeric position-7 rule', () => {
    const result = decodeModelYear(HONDA_ACCORD_2003, 2026);
    expect(result.year).toBe(2003);
  });

  it('decodes a 2017 vehicle using the alphabetic position-7 rule', () => {
    const result = decodeModelYear(TESLA_MODEL_S_2017, 2026);
    expect(result.year).toBe(2017);
    expect(result.ambiguous).toBe(false);
  });

  it('returns null for an invalid year code', () => {
    // Position 10 additionally excludes U, Z and 0 on top of I, O and Q.
    const withU = `${HONDA_ACCORD_2003.slice(0, 9)}U${HONDA_ACCORD_2003.slice(10)}`;
    expect(decodeModelYear(withU, 2026).year).toBeNull();
  });

  it('falls back a cycle rather than returning a future year', () => {
    // Position 7 is 'C' (alphabetic) and position 10 is 'Y', which the
    // position-7 rule would read as 2030 — past the plausibility clamp.
    const future = 'JHLRD1C89YC0043XX';
    const result = decodeModelYear(future, 2026);
    expect(result.year).toBe(2000);
    expect(result.ambiguous).toBe(true);
    expect(result.alternateYear).toBe(2030);
  });

  it('flags a genuine cycle ambiguity when both candidates are plausible', () => {
    // Numeric position 7 with code 'S' gives 1995, but 2025 is equally
    // plausible for a heavy truck, which does not follow the position-7 rule.
    const result = decodeModelYear('1FUJA6559SLS12345', 2026);
    expect(result.year).toBe(1995);
    expect(result.ambiguous).toBe(true);
    expect(result.alternateYear).toBe(2025);
  });

  it('exposes exactly 30 year codes and excludes I, O, Q, U, Z and 0', () => {
    expect(YEAR_CODES).toHaveLength(30);
    for (const excluded of ['I', 'O', 'Q', 'U', 'Z', '0']) {
      expect(YEAR_CODES).not.toContain(excluded);
    }
  });
});

describe('encodeModelYear', () => {
  it('round-trips through decodeModelYear for the current cycle', () => {
    expect(encodeModelYear(2017)).toBe('H');
    expect(encodeModelYear(2003)).toBe('3');
  });

  it('returns null outside the supported range', () => {
    expect(encodeModelYear(1975)).toBeNull();
    expect(encodeModelYear(2045)).toBeNull();
  });
});

describe('WMI helpers', () => {
  it('extracts the 3-character WMI', () => {
    expect(getWmi(HONDA_ACCORD_2003)).toBe('1HG');
  });

  it('detects low-volume manufacturers by position 3', () => {
    expect(isLowVolumeManufacturer('1H9CM82633A004352')).toBe(true);
    expect(isLowVolumeManufacturer(HONDA_ACCORD_2003)).toBe(false);
  });

  it('builds the extended 6-character WMI only for low-volume makers', () => {
    expect(getExtendedWmi(HONDA_ACCORD_2003)).toBeNull();
    // Positions 1-3 plus 12-14.
    expect(getExtendedWmi('1H9CM82633A004352')).toBe('1H9004');
  });
});

describe('maskVin', () => {
  it('keeps only the last six characters', () => {
    expect(maskVin(HONDA_ACCORD_2003)).toBe('***********004352');
  });

  it('leaves short strings untouched', () => {
    expect(maskVin('ABC')).toBe('ABC');
  });
});

describe('parseVpicErrors', () => {
  it('parses a single clean code', () => {
    const errors = parseVpicErrors('0');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.benign).toBe(true);
  });

  it('parses a comma-separated list rather than treating it as a scalar', () => {
    const errors = parseVpicErrors('1,10,400');
    expect(errors.map((e) => e.code)).toEqual([1, 10, 400]);
  });

  it('returns an empty list for undefined input', () => {
    expect(parseVpicErrors(undefined)).toEqual([]);
  });
});

describe('isUsableDecode', () => {
  it('accepts a clean decode', () => {
    expect(isUsableDecode('0')).toBe(true);
  });

  it('accepts a bad check digit combined with an off-road warning', () => {
    expect(isUsableDecode('1,10')).toBe(true);
  });

  it('rejects a decode reporting invalid characters', () => {
    expect(isUsableDecode('1,400')).toBe(false);
  });

  it('rejects an empty error code', () => {
    expect(isUsableDecode('')).toBe(false);
  });
});

describe('mapVpicResult', () => {
  it('normalizes empty strings to null and rounds displacement', () => {
    const mapped = mapVpicResult(HONDA_ACCORD_2003, {
      Make: 'HONDA',
      Model: 'Accord',
      ModelYear: '2003',
      BodyClass: 'Coupe',
      DriveType: '',
      DisplacementL: '2.998832712',
      EngineCylinders: '6',
      ErrorCode: '0',
      ErrorText: '0 - VIN decoded clean.',
    });

    expect(mapped.make).toBe('HONDA');
    expect(mapped.modelYear).toBe(2003);
    // vPIC returns "" for unknowns, not null and not an absent key.
    expect(mapped.driveType).toBeNull();
    expect(mapped.displacementL).toBe(3);
    expect(mapped.engineCylinders).toBe(6);
    expect(mapped.usable).toBe(true);
  });

  it('surfaces a suggested VIN when NHTSA corrects one character', () => {
    const mapped = mapVpicResult(TESLA_BAD_CHECK_DIGIT, {
      ErrorCode: '2',
      SuggestedVIN: TESLA_MODEL_S_2017,
    });
    expect(mapped.suggestedVin).toBe(TESLA_MODEL_S_2017);
    expect(mapped.usable).toBe(false);
  });
});
