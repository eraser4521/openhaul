import 'server-only';
import { eq } from 'drizzle-orm';
import { carrierChecks as carrierChecksTable, customers as customersTable } from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { carrierByDot, carriersByDocket, hasFmcsaKey, type QcCarrier, type QcFailure } from './qcmobile';
import { assess, toProfile, verdictFrom, type CarrierProfile, type Finding, type Role, type Verdict } from './assess';

/**
 * Looking a carrier up, and keeping what was found.
 *
 * The stored record is the point. "We checked their authority before we
 * tendered" is a defence; remembering that somebody looked at a screen is not.
 * So every lookup that reaches FMCSA is written to `carrier_checks` with the
 * raw payload and the time, and the screen always shows when the answer is
 * from.
 */

/**
 * How long a stored answer is offered instead of a fresh call.
 *
 * FMCSA's census is refreshed on their schedule, and a carrier's authority
 * does not change by the minute — but it does change, and the whole value of
 * the check is currency. An hour is short enough that a revocation is caught
 * the same day and long enough that opening a customer five times does not
 * spend five calls.
 */
export const CACHE_TTL_MS = 60 * 60 * 1000;

export interface CarrierLookup {
  profile: CarrierProfile;
  findings: Finding[];
  verdict: Verdict;
  role: Role;
  checkedAt: Date;
  /** True when this came from a stored check rather than a fresh call. */
  cached: boolean;
  checkId: string | null;
}

export type LookupOutcome =
  | { ok: true; lookup: CarrierLookup }
  | { ok: false; reason: QcFailure; message: string; candidates?: CandidateSummary[] };

export interface CandidateSummary {
  dotNumber: string | null;
  legalName: string | null;
  dbaName: string | null;
  location: string | null;
}

function summarise(carrier: QcCarrier): CandidateSummary {
  const profile = toProfile(carrier);
  return {
    dotNumber: profile.dotNumber,
    legalName: profile.legalName,
    dbaName: profile.dbaName,
    location: profile.address,
  };
}

function build(carrier: QcCarrier, role: Role, checkedAt: Date, cached: boolean, checkId: string | null): CarrierLookup {
  const profile = toProfile(carrier);
  const findings = assess(profile, role);
  return { profile, findings, verdict: verdictFrom(findings), role, checkedAt, cached, checkId };
}

/** The most recent stored check for a USDOT number, whatever its age. */
export async function lastCheck(scoped: ScopedDb, dotNumber: string) {
  const [row] = await scoped.select(
    'carrierChecks',
    eq(carrierChecksTable.usdotNumber, dotNumber),
    { orderBy: { column: carrierChecksTable.checkedAt, direction: 'desc' }, limit: 1 },
  );
  return row ?? null;
}

/**
 * Verifies a USDOT number.
 *
 * Falls back to the stored answer when FMCSA cannot be reached, clearly marked
 * as stale — an hour-old "authorised" is far more useful to somebody standing
 * at a gate than an error, provided they can see how old it is.
 */
export async function lookupByDot(
  scoped: ScopedDb,
  dotNumber: string,
  role: Role,
  options: { customerId?: string | null; force?: boolean } = {},
): Promise<LookupOutcome> {
  const digits = dotNumber.replace(/\D/g, '');
  if (!digits) {
    return { ok: false, reason: 'not_found', message: 'That is not a USDOT number.' };
  }

  const stored = await lastCheck(scoped, digits);

  if (!options.force && stored?.raw && Date.now() - stored.checkedAt.getTime() < CACHE_TTL_MS) {
    return {
      ok: true,
      lookup: build(stored.raw as QcCarrier, role, stored.checkedAt, true, stored.id),
    };
  }

  if (!hasFmcsaKey()) {
    if (stored?.raw) {
      return {
        ok: true,
        lookup: build(stored.raw as QcCarrier, role, stored.checkedAt, true, stored.id),
      };
    }
    return {
      ok: false,
      reason: 'no_key',
      message:
        'No FMCSA key is configured, so this cannot be checked. Register for a free key at ' +
        'mobile.fmcsa.dot.gov and set FMCSA_WEB_KEY.',
    };
  }

  const result = await carrierByDot(digits);

  if (!result.ok) {
    // A stored answer beats no answer when the outage is theirs, but never
    // when the number simply does not exist.
    if (stored?.raw && result.reason !== 'not_found') {
      return {
        ok: true,
        lookup: build(stored.raw as QcCarrier, role, stored.checkedAt, true, stored.id),
      };
    }
    return { ok: false, reason: result.reason, message: result.message };
  }

  const profile = toProfile(result.data);
  const checkedAt = new Date();

  const [row] = await scoped.insert('carrierChecks', {
    customerId: options.customerId ?? null,
    usdotNumber: digits,
    mcNumber: null,
    legalName: profile.legalName,
    dbaName: profile.dbaName,
    allowedToOperate: profile.allowedToOperate,
    outOfService: profile.outOfServiceAt !== null,
    outOfServiceAt: profile.outOfServiceAt,
    safetyRating: profile.safetyRating,
    source: 'qcmobile',
    raw: result.data as Record<string, unknown>,
    checkedAt,
  });

  return { ok: true, lookup: build(result.data, role, checkedAt, false, row?.id ?? null) };
}

/**
 * Verifies a docket (MC) number.
 *
 * A docket number can map to more than one carrier, so an ambiguous answer is
 * returned as candidates for somebody to choose from rather than resolved by
 * picking the first — picking the first is how the wrong company gets cleared.
 */
export async function lookupByDocket(
  scoped: ScopedDb,
  docketNumber: string,
  role: Role,
  options: { customerId?: string | null } = {},
): Promise<LookupOutcome> {
  if (!hasFmcsaKey()) {
    return {
      ok: false,
      reason: 'no_key',
      message:
        'No FMCSA key is configured, so this cannot be checked. Register for a free key at ' +
        'mobile.fmcsa.dot.gov and set FMCSA_WEB_KEY.',
    };
  }

  const result = await carriersByDocket(docketNumber);
  if (!result.ok) return { ok: false, reason: result.reason, message: result.message };

  if (result.data.length > 1) {
    return {
      ok: false,
      reason: 'not_found',
      message:
        `Docket number ${docketNumber} matches ${result.data.length} records. Pick the one you ` +
        'mean — the number alone is not unique across MC, FF and MX prefixes.',
      candidates: result.data.map(summarise),
    };
  }

  const carrier = result.data[0];
  const dot = toProfile(carrier!).dotNumber;

  if (!dot) {
    return { ok: false, reason: 'not_found', message: 'That record carries no USDOT number.' };
  }

  // Resolved to a USDOT number, then looked up properly so the stored check is
  // keyed the same way as every other one.
  return lookupByDot(scoped, dot, role, options);
}

/** Attaches a completed check to a customer record, so it is found again. */
export async function attachCheckToCustomer(
  scoped: ScopedDb,
  checkId: string,
  customerId: string,
): Promise<void> {
  await scoped.update('carrierChecks', eq(carrierChecksTable.id, checkId), { customerId });
}

/** The most recent check recorded against each customer, for the list screen. */
export async function checksByCustomer(
  scoped: ScopedDb,
): Promise<Map<string, { checkedAt: Date; allowedToOperate: boolean | null; outOfService: boolean | null }>> {
  const rows = await scoped.select('carrierChecks', undefined, {
    orderBy: { column: carrierChecksTable.checkedAt, direction: 'desc' },
  });

  const byCustomer = new Map<
    string,
    { checkedAt: Date; allowedToOperate: boolean | null; outOfService: boolean | null }
  >();

  for (const row of rows) {
    if (!row.customerId || byCustomer.has(row.customerId)) continue;
    byCustomer.set(row.customerId, {
      checkedAt: row.checkedAt,
      allowedToOperate: row.allowedToOperate,
      outOfService: row.outOfService,
    });
  }

  return byCustomer;
}

/** A customer's USDOT number, preferred over the docket number when present. */
export async function customerIdentifiers(
  scoped: ScopedDb,
  customerId: string,
): Promise<{ usdotNumber: string | null; mcNumber: string | null; name: string } | null> {
  const customer = await scoped.selectOne('customers', eq(customersTable.id, customerId));
  if (!customer) return null;
  return {
    usdotNumber: customer.usdotNumber,
    mcNumber: customer.mcNumber,
    name: customer.name,
  };
}
