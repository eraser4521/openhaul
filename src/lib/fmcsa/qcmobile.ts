/**
 * Client for FMCSA's QCMobile service.
 *
 * The authoritative source for whether a motor carrier or broker is registered
 * and permitted to operate. Free, but unlike NHTSA's vPIC it needs a key: one
 * is issued instantly at https://mobile.fmcsa.dot.gov/QCDevsite/home/register
 * and goes in FMCSA_WEB_KEY.
 *
 * Two behaviours of this API shape the whole client.
 *
 * It answers a missing or invalid key with HTTP 404 and a body whose `content`
 * is the string "Must provide Webkey" or "Webkey not found" — the same status
 * a genuinely unknown USDOT number would produce. Treating 404 as "no such
 * carrier" would therefore report every carrier as unregistered the moment a
 * key expired, which is the most dangerous possible failure for a check whose
 * whole job is to say who may be trusted. So the body is inspected, not the
 * status: a string `content` is an error, an object or array is data.
 *
 * And it is a snapshot of the census, not a live feed. `retrievalDate` comes
 * back on every response and is kept, because "authorised as of last Tuesday"
 * is a different statement from "authorised".
 */

const QC_BASE = 'https://mobile.fmcsa.dot.gov/qc/services';

export type QcFailure =
  | 'no_key'
  | 'bad_key'
  | 'not_found'
  | 'rate_limited'
  | 'unavailable'
  | 'timeout';

export type QcResult<T> =
  | { ok: true; data: T; retrievalDate: Date | null }
  | { ok: false; reason: QcFailure; message: string };

export const FAILURE_MESSAGE: Record<QcFailure, string> = {
  no_key: 'No FMCSA key is configured. Set FMCSA_WEB_KEY to enable carrier lookups.',
  bad_key: 'FMCSA rejected the key. Check FMCSA_WEB_KEY against the one you registered.',
  not_found: 'FMCSA has no record under that number.',
  rate_limited: 'FMCSA is rate limiting this key. Try again shortly.',
  unavailable: 'FMCSA did not answer. This is their service, not yours — try again later.',
  timeout: 'FMCSA took too long to answer.',
};

/** The envelope every QCMobile response uses. */
interface QcEnvelope {
  content?: unknown;
  retrievalDate?: string;
}

function parseRetrievalDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Distinguishes an error body from a data body.
 *
 * A string `content` is always an error message; the service never returns
 * bare text as a successful payload.
 */
function keyFailureFrom(content: unknown): QcFailure | null {
  if (typeof content !== 'string') return null;
  const text = content.toLowerCase();
  if (text.includes('webkey') || text.includes('web key')) return 'bad_key';
  return 'not_found';
}

export interface QcOptions {
  webKey?: string | undefined;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function qcFetch<T>(path: string, options: QcOptions): Promise<QcResult<T>> {
  const webKey = options.webKey ?? process.env.FMCSA_WEB_KEY;
  if (!webKey) return { ok: false, reason: 'no_key', message: FAILURE_MESSAGE.no_key };

  const url = `${QC_BASE}${path}${path.includes('?') ? '&' : '?'}webKey=${encodeURIComponent(webKey)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      // A carrier's authority changes on FMCSA's schedule, not on ours, and a
      // stale cached answer is the failure mode that matters here.
      cache: 'no-store',
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      reason: aborted ? 'timeout' : 'unavailable',
      message: aborted ? FAILURE_MESSAGE.timeout : FAILURE_MESSAGE.unavailable,
    };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    return { ok: false, reason: 'rate_limited', message: FAILURE_MESSAGE.rate_limited };
  }

  let body: QcEnvelope;
  try {
    body = (await response.json()) as QcEnvelope;
  } catch {
    return { ok: false, reason: 'unavailable', message: FAILURE_MESSAGE.unavailable };
  }

  const keyFailure = keyFailureFrom(body.content);
  if (keyFailure) {
    return { ok: false, reason: keyFailure, message: FAILURE_MESSAGE[keyFailure] };
  }

  if (!response.ok && response.status !== 404) {
    return { ok: false, reason: 'unavailable', message: FAILURE_MESSAGE.unavailable };
  }

  if (body.content === null || body.content === undefined) {
    return { ok: false, reason: 'not_found', message: FAILURE_MESSAGE.not_found };
  }

  return {
    ok: true,
    data: body.content as T,
    retrievalDate: parseRetrievalDate(body.retrievalDate),
  };
}

/* -------------------------------------------------------------------------
 * Shapes
 * ---------------------------------------------------------------------- */

/**
 * A census record as QCMobile returns it.
 *
 * Every field is optional on purpose. This is a third-party API whose payload
 * varies by carrier and changes without notice, and a lookup that throws
 * because one field moved is worse than one that reports what it found.
 */
export interface QcCarrier {
  dotNumber?: number | string;
  legalName?: string;
  dbaName?: string | null;
  /** "Y" or "N". */
  allowedToOperate?: string;
  /** "A" for active, "I" for inactive. */
  statusCode?: string;
  ein?: number | string;

  phyStreet?: string;
  phyCity?: string;
  phyState?: string;
  phyZipcode?: string;
  phyCountry?: string;
  telephone?: string;

  totalDrivers?: number | string;
  totalPowerUnits?: number | string;

  safetyRating?: string | null;
  safetyRatingDate?: string | null;
  reviewDate?: string | null;

  oosDate?: string | null;

  /** "A" active, "I" inactive, "N" none — per authority type. */
  commonAuthorityStatus?: string;
  contractAuthorityStatus?: string;
  brokerAuthorityStatus?: string;

  bipdInsuranceOnFile?: string;
  bipdInsuranceRequired?: string;
  cargoInsuranceOnFile?: string;
  cargoInsuranceRequired?: string;
  bondInsuranceOnFile?: string;
  bondInsuranceRequired?: string;

  mcs150Date?: string | null;
  mcs150Outdated?: string;
  mcs150Mileage?: number | string;
  mcs150MileageYear?: number | string;

  crashTotal?: number | string;
  fatalCrash?: number | string;
  injCrash?: number | string;
  towawayCrash?: number | string;

  driverInsp?: number | string;
  driverOosInsp?: number | string;
  driverOosRate?: number | string;
  driverOosRateNationalAverage?: number | string | null;

  vehicleInsp?: number | string;
  vehicleOosInsp?: number | string;
  vehicleOosRate?: number | string;
  vehicleOosRateNationalAverage?: number | string | null;

  carrierOperation?: { carrierOperationCode?: string; carrierOperationDesc?: string };

  [key: string]: unknown;
}

/** Single-carrier responses wrap the record; search responses list wrappers. */
interface QcCarrierWrapper {
  carrier?: QcCarrier;
}

function unwrap(content: unknown): QcCarrier | null {
  if (!content || typeof content !== 'object') return null;

  const wrapper = content as QcCarrierWrapper;
  if (wrapper.carrier && typeof wrapper.carrier === 'object') return wrapper.carrier;

  // Some endpoints return the record unwrapped.
  const direct = content as QcCarrier;
  return direct.dotNumber !== undefined || direct.legalName !== undefined ? direct : null;
}

/* -------------------------------------------------------------------------
 * Lookups
 * ---------------------------------------------------------------------- */

/** USDOT numbers are the stable identity; docket (MC) numbers are not unique. */
export async function carrierByDot(
  dotNumber: string,
  options: QcOptions = {},
): Promise<QcResult<QcCarrier>> {
  const digits = dotNumber.replace(/\D/g, '');
  if (!digits) {
    return { ok: false, reason: 'not_found', message: 'That is not a USDOT number.' };
  }

  const result = await qcFetch<unknown>(`/carriers/${digits}`, options);
  if (!result.ok) return result;

  const carrier = unwrap(result.data);
  if (!carrier) return { ok: false, reason: 'not_found', message: FAILURE_MESSAGE.not_found };

  return { ok: true, data: carrier, retrievalDate: result.retrievalDate };
}

/**
 * Looks a carrier up by docket number.
 *
 * The docket prefix is dropped because FMCSA indexes the number alone, and the
 * same digits can exist under MC, FF and MX prefixes. That means a docket
 * lookup can legitimately match more than one carrier, which is why this
 * returns a list and the caller has to choose rather than being handed a guess.
 */
export async function carriersByDocket(
  docketNumber: string,
  options: QcOptions = {},
): Promise<QcResult<QcCarrier[]>> {
  const digits = docketNumber.replace(/\D/g, '');
  if (!digits) {
    return { ok: false, reason: 'not_found', message: 'That is not a docket number.' };
  }

  const result = await qcFetch<unknown>(`/carriers/docket-number/${digits}`, options);
  if (!result.ok) return result;

  const list = Array.isArray(result.data) ? result.data : [result.data];
  const carriers = list.map(unwrap).filter((carrier): carrier is QcCarrier => carrier !== null);

  if (carriers.length === 0) {
    return { ok: false, reason: 'not_found', message: FAILURE_MESSAGE.not_found };
  }

  return { ok: true, data: carriers, retrievalDate: result.retrievalDate };
}

/** Name search, for when somebody has a company name and nothing else. */
export async function carriersByName(
  name: string,
  options: QcOptions = {},
): Promise<QcResult<QcCarrier[]>> {
  const trimmed = name.trim();
  if (trimmed.length < 3) {
    return { ok: false, reason: 'not_found', message: 'Enter at least three characters.' };
  }

  const result = await qcFetch<unknown>(
    `/carriers/name/${encodeURIComponent(trimmed)}`,
    options,
  );
  if (!result.ok) return result;

  const list = Array.isArray(result.data) ? result.data : [result.data];
  const carriers = list.map(unwrap).filter((carrier): carrier is QcCarrier => carrier !== null);

  if (carriers.length === 0) {
    return { ok: false, reason: 'not_found', message: FAILURE_MESSAGE.not_found };
  }

  return { ok: true, data: carriers, retrievalDate: result.retrievalDate };
}

export function hasFmcsaKey(): boolean {
  return Boolean(process.env.FMCSA_WEB_KEY);
}
