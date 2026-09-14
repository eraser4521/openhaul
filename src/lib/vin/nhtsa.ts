/**
 * Client for the NHTSA vPIC vehicle API.
 *
 * Free, no API key, no registration, US federal government data. NHTSA does
 * not publish hard rate limits but does throttle bursts, so callers should go
 * through the cached server proxy at /api/vin/decode rather than hitting this
 * directly from the browser.
 */

const VPIC_BASE = 'https://vpic.nhtsa.dot.gov/api/vehicles';

/** vPIC batch decode accepts at most 50 VINs per request. */
export const VPIC_BATCH_LIMIT = 50;

/**
 * A raw vPIC result row.
 *
 * Every value is a string — including numbers — and unknown fields come back
 * as empty strings rather than `null` or absent keys.
 */
export type VpicResult = Record<string, string>;

export interface VpicErrorMeaning {
  code: number;
  message: string;
  /** Whether the decode is still usable despite this code. */
  benign: boolean;
}

const ERROR_CODES: Readonly<Record<number, Omit<VpicErrorMeaning, 'code'>>> = {
  0: { message: 'VIN decoded clean. Check digit is correct.', benign: true },
  1: { message: 'Check digit (9th position) does not calculate properly.', benign: true },
  2: { message: 'VIN corrected, error in one position.', benign: false },
  3: { message: 'VIN corrected, error in one position (assuming check digit is correct).', benign: false },
  4: { message: 'VIN corrected, multiple matches found.', benign: false },
  5: { message: 'VIN has errors in several positions.', benign: false },
  6: { message: 'Incomplete VIN.', benign: false },
  7: { message: 'Manufacturer is not registered with NHTSA for US sale or import.', benign: true },
  8: { message: 'No detailed data available for this VIN.', benign: true },
  9: { message: 'Glider warning: a glider kit is not a complete motor vehicle.', benign: true },
  10: { message: 'Off-road vehicle warning.', benign: true },
  11: { message: 'Incorrect model year: position 10 is not a valid year code.', benign: false },
  12: { message: 'Model year warning: supplied model year does not match the VIN.', benign: true },
  14: { message: 'Unable to decode some characters in the VIN.', benign: true },
  400: { message: 'Invalid characters present in the VIN.', benign: false },
};

/**
 * Parses vPIC's `ErrorCode` field.
 *
 * The field is a comma-separated *list*, not a scalar — real values include
 * "0", "0,10", "1,400" and "1,10,400" — so an equality check against "0" is
 * wrong and will misclassify usable decodes.
 */
export function parseVpicErrors(errorCode: string | undefined): VpicErrorMeaning[] {
  if (!errorCode) return [];
  return errorCode
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => !Number.isNaN(n))
    .map((code) => {
      const known = ERROR_CODES[code];
      return {
        code,
        message: known?.message ?? `Unrecognized vPIC error code ${code}.`,
        benign: known?.benign ?? false,
      };
    });
}

/** True when every returned error code still leaves the decode trustworthy. */
export function isUsableDecode(errorCode: string | undefined): boolean {
  const errors = parseVpicErrors(errorCode);
  if (errors.length === 0) return false;
  return errors.every((e) => e.benign);
}

/** The subset of vPIC fields this app actually stores against a vehicle. */
export interface DecodedVehicle {
  vin: string;
  make: string | null;
  model: string | null;
  modelYear: number | null;
  trim: string | null;
  bodyClass: string | null;
  vehicleType: string | null;
  driveType: string | null;
  fuelType: string | null;
  electrificationLevel: string | null;
  engineCylinders: number | null;
  displacementL: number | null;
  gvwr: string | null;
  manufacturer: string | null;
  plantCountry: string | null;
  doors: number | null;
  errorCodes: VpicErrorMeaning[];
  usable: boolean;
  /** NHTSA's corrected VIN when it detected a single-character error. */
  suggestedVin: string | null;
}

/** vPIC returns "" for unknown values; normalize those to `null`. */
function str(result: VpicResult, key: string): string | null {
  const value = result[key];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function num(result: VpicResult, key: string): number | null {
  const value = str(result, key);
  if (value === null) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Maps a raw vPIC row onto the fields this app stores. */
export function mapVpicResult(vin: string, result: VpicResult): DecodedVehicle {
  const errorCode = result['ErrorCode'];

  // vPIC reports unrounded displacement, e.g. "2.998832712" for a 3.0L engine.
  const rawDisplacement = num(result, 'DisplacementL');

  return {
    vin,
    make: str(result, 'Make'),
    model: str(result, 'Model'),
    modelYear: num(result, 'ModelYear'),
    trim: str(result, 'Trim') ?? str(result, 'Series'),
    bodyClass: str(result, 'BodyClass'),
    vehicleType: str(result, 'VehicleType'),
    driveType: str(result, 'DriveType'),
    fuelType: str(result, 'FuelTypePrimary'),
    electrificationLevel: str(result, 'ElectrificationLevel'),
    engineCylinders: num(result, 'EngineCylinders'),
    displacementL: rawDisplacement === null ? null : Math.round(rawDisplacement * 10) / 10,
    gvwr: str(result, 'GVWR'),
    manufacturer: str(result, 'Manufacturer'),
    plantCountry: str(result, 'PlantCountry'),
    doors: num(result, 'Doors'),
    errorCodes: parseVpicErrors(errorCode),
    usable: isUsableDecode(errorCode),
    suggestedVin: str(result, 'SuggestedVIN'),
  };
}

export interface DecodeOptions {
  /**
   * Strongly recommended. Resolves the 30-year model-year cycle and materially
   * improves decode accuracy.
   */
  modelYear?: number;
  signal?: AbortSignal;
  /** Milliseconds before the request is abandoned. Defaults to 10 seconds. */
  timeoutMs?: number;
}

async function vpicFetch(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Chain any caller-supplied signal onto our timeout controller.
  const callerSignal = init.signal;
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`vPIC request failed with HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function extractResults(payload: unknown): VpicResult[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const results = (payload as { Results?: unknown }).Results;
  if (!Array.isArray(results)) return [];
  return results.filter((row): row is VpicResult => typeof row === 'object' && row !== null);
}

/**
 * Decodes a single VIN, returning both the mapped fields and the raw vPIC row.
 *
 * The raw row is what callers should cache: vPIC returns around 140 fields and
 * this app currently maps a fraction of them, so keeping the original means
 * surfacing GVWR or axle configuration later needs no re-fetch.
 */
export async function decodeVinDetailed(
  vin: string,
  options: DecodeOptions = {},
): Promise<{ vehicle: DecodedVehicle; raw: VpicResult }> {
  const params = new URLSearchParams({ format: 'json' });
  if (options.modelYear !== undefined) {
    params.set('modelyear', String(options.modelYear));
  }

  const url = `${VPIC_BASE}/DecodeVinValues/${encodeURIComponent(vin)}?${params.toString()}`;
  const payload = await vpicFetch(
    url,
    { signal: options.signal, headers: { accept: 'application/json' } },
    options.timeoutMs ?? 10_000,
  );

  const first = extractResults(payload)[0];
  if (!first) {
    throw new Error('vPIC returned no results for this VIN');
  }
  return { vehicle: mapVpicResult(vin, first), raw: first };
}

/** Decodes a single VIN via vPIC's flat-format endpoint. */
export async function decodeVin(vin: string, options: DecodeOptions = {}): Promise<DecodedVehicle> {
  const { vehicle } = await decodeVinDetailed(vin, options);
  return vehicle;
}

/**
 * Decodes many VINs, chunked to vPIC's 50-per-request batch limit.
 *
 * A batch counts as one request against the rate limiter rather than 50, so
 * this is strongly preferred over looping `decodeVin` when flushing an
 * offline queue.
 */
export async function decodeVinBatch(
  entries: ReadonlyArray<{ vin: string; modelYear?: number }>,
  options: Pick<DecodeOptions, 'signal' | 'timeoutMs'> = {},
): Promise<DecodedVehicle[]> {
  const decoded: DecodedVehicle[] = [];

  for (let i = 0; i < entries.length; i += VPIC_BATCH_LIMIT) {
    const chunk = entries.slice(i, i + VPIC_BATCH_LIMIT);
    const data = chunk
      .map((e) => (e.modelYear !== undefined ? `${e.vin},${e.modelYear}` : e.vin))
      .join(';');

    const payload = await vpicFetch(
      `${VPIC_BASE}/DecodeVINValuesBatch/`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({ format: 'json', data }).toString(),
        signal: options.signal,
      },
      options.timeoutMs ?? 30_000,
    );

    const results = extractResults(payload);
    chunk.forEach((entry, index) => {
      const row = results[index];
      if (row) decoded.push(mapVpicResult(entry.vin, row));
    });
  }

  return decoded;
}
