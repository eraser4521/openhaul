import 'server-only';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { stops as stopsTable, venues as venuesTable, BUSINESS_TYPES } from '../db/schema';
import type { ScopedDb } from '../db/scope';

/**
 * Origin and destination capture.
 *
 * 49 CFR 373.101 requires a bill of lading to name the origin and destination
 * points, so a load with no route cannot produce one. The two are stored as
 * `stops` pointing at `venues` rather than as columns on the load, because the
 * same auction or terminal appears on hundreds of loads and its gate code and
 * contact should be corrected in one place.
 */

/** A stop is either fully addressed or left empty. Half a shipper is not useful. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => value || null);

export const stopPartySchema = z.object({
  name: optionalText(120),
  businessType: z.enum(BUSINESS_TYPES).optional(),
  addressLine1: optionalText(160),
  addressLine2: optionalText(160),
  city: optionalText(80),
  state: optionalText(2).transform((value) => value?.toUpperCase() ?? null),
  postalCode: optionalText(12),
  contactName: optionalText(120),
  contactPhone: optionalText(32),
  contactEmail: optionalText(160),
  gateCode: optionalText(40),
  scheduledAt: optionalText(40),
});

export type StopParty = z.infer<typeof stopPartySchema>;

/** The fields a venue row cannot be written without. */
const REQUIRED: Array<[keyof StopParty, string]> = [
  ['name', 'a name'],
  ['addressLine1', 'a street address'],
  ['city', 'a city'],
  ['state', 'a state'],
  ['postalCode', 'a postal code'],
];

export function isBlankStop(party: StopParty): boolean {
  return Object.values(party).every((value) => value === null || value === undefined);
}

/**
 * Reports what a partly filled stop is still missing.
 *
 * An empty stop is allowed — a dispatcher often books vehicles before the
 * addresses land — but a half-filled one is a typo, not an intention.
 */
export function missingStopFields(party: StopParty): string[] {
  if (isBlankStop(party)) return [];
  return REQUIRED.filter(([field]) => !party[field]).map(([, label]) => label);
}

/** Reads `pickupCity`, `deliveryCity` and so on out of a form. */
export function readStopParty(formData: FormData, prefix: 'pickup' | 'delivery'): StopParty {
  const field = (name: string) => {
    const value = formData.get(`${prefix}${name}`);
    return typeof value === 'string' ? value : undefined;
  };

  return stopPartySchema.parse({
    name: field('Name'),
    businessType: field('BusinessType') || undefined,
    addressLine1: field('AddressLine1'),
    addressLine2: field('AddressLine2'),
    city: field('City'),
    state: field('State'),
    postalCode: field('PostalCode'),
    contactName: field('ContactName'),
    contactPhone: field('ContactPhone'),
    contactEmail: field('ContactEmail'),
    gateCode: field('GateCode'),
    scheduledAt: field('ScheduledAt'),
  });
}

function parseScheduled(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Finds the venue this address already is, or creates it.
 *
 * Matched on name and postal code, which is loose enough to survive a retyped
 * suite number and tight enough not to merge two dealers on the same street.
 */
async function upsertVenue(scoped: ScopedDb, party: StopParty): Promise<string | null> {
  const name = party.name;
  const addressLine1 = party.addressLine1;
  const city = party.city;
  const state = party.state;
  const postalCode = party.postalCode;

  if (!name || !addressLine1 || !city || !state || !postalCode) return null;

  const [existing] = await scoped.select(
    'venues',
    and(eq(venuesTable.name, name), eq(venuesTable.postalCode, postalCode)),
  );

  const details = {
    name,
    businessType: party.businessType ?? 'business',
    addressLine1,
    addressLine2: party.addressLine2,
    city,
    state,
    postalCode,
    contactName: party.contactName,
    contactPhone: party.contactPhone,
    contactEmail: party.contactEmail,
    gateCode: party.gateCode,
  } as const;

  if (existing) {
    await scoped.update('venues', eq(venuesTable.id, existing.id), details);
    return existing.id;
  }

  const [created] = await scoped.insert('venues', details);
  return created?.id ?? null;
}

/**
 * Writes one end of the route.
 *
 * Idempotent: saving the same load twice updates the existing stop rather than
 * stacking duplicates, so the detail screen can use the same path to correct a
 * misspelled address as the create form uses to set it.
 */
export async function saveStop(
  scoped: ScopedDb,
  loadId: string,
  kind: 'pickup' | 'delivery',
  party: StopParty,
): Promise<void> {
  if (isBlankStop(party)) return;

  const venueId = await upsertVenue(scoped, party);
  if (!venueId) return;

  const scheduledAt = parseScheduled(party.scheduledAt);

  const [existing] = await scoped.select(
    'stops',
    and(eq(stopsTable.loadId, loadId), eq(stopsTable.kind, kind)),
  );

  if (existing) {
    await scoped.update('stops', eq(stopsTable.id, existing.id), { venueId, scheduledAt });
    return;
  }

  await scoped.insert('stops', {
    loadId,
    kind,
    sequence: kind === 'pickup' ? 0 : 1,
    venueId,
    scheduledAt,
  });
}
