import 'server-only';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { customers as customersTable, PAYMENT_TERMS } from '../db/schema';
import type { ScopedDb } from '../db/scope';

/**
 * The party an invoice is addressed to.
 *
 * Stored as a customer rather than as fields on the load, because a broker
 * appears on hundreds of loads and its terms, authority numbers and remit
 * address should be corrected once. The load points at the customer; the
 * invoice bills it.
 */

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => value || null);

export const customerSchema = z.object({
  name: optionalText(160),
  kind: z.enum(['broker', 'shipper', 'dealer', 'private', 'auction']).optional(),
  contactName: optionalText(120),
  email: optionalText(160),
  phone: optionalText(32),
  addressLine1: optionalText(160),
  city: optionalText(80),
  state: optionalText(2).transform((value) => value?.toUpperCase() ?? null),
  postalCode: optionalText(12),
  mcNumber: optionalText(24),
  usdotNumber: optionalText(24),
  defaultPaymentTerms: z.enum(PAYMENT_TERMS).optional(),
});

export type CustomerInput = z.infer<typeof customerSchema>;

export function isBlankCustomer(input: CustomerInput): boolean {
  return !input.name;
}

/** Reads `customerName`, `customerEmail` and so on out of a form. */
export function readCustomer(formData: FormData): CustomerInput {
  const field = (name: string) => {
    const value = formData.get(`customer${name}`);
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  };

  return customerSchema.parse({
    name: field('Name'),
    kind: field('Kind'),
    contactName: field('ContactName'),
    email: field('Email'),
    phone: field('Phone'),
    addressLine1: field('AddressLine1'),
    city: field('City'),
    state: field('State'),
    postalCode: field('PostalCode'),
    mcNumber: field('McNumber'),
    usdotNumber: field('UsdotNumber'),
    defaultPaymentTerms: field('DefaultPaymentTerms'),
  });
}

/**
 * Finds this customer by name within the organisation, or creates it.
 *
 * Name is the only thing a dispatcher reliably types the same way twice, and
 * a broker's name is what appears on the rate confirmation. Details given on a
 * later load update the record rather than forking it — but a blank field
 * never overwrites something already known, so booking a load without
 * retyping the address does not erase the address.
 */
export async function upsertCustomer(
  scoped: ScopedDb,
  input: CustomerInput,
): Promise<string | null> {
  if (!input.name) return null;

  const [existing] = await scoped.select('customers', eq(customersTable.name, input.name));

  const given = {
    kind: input.kind,
    contactName: input.contactName,
    email: input.email,
    phone: input.phone,
    addressLine1: input.addressLine1,
    city: input.city,
    state: input.state,
    postalCode: input.postalCode,
    mcNumber: input.mcNumber,
    usdotNumber: input.usdotNumber,
    defaultPaymentTerms: input.defaultPaymentTerms,
  };

  if (existing) {
    const changes = Object.fromEntries(
      Object.entries(given).filter(([, value]) => value !== null && value !== undefined),
    );
    if (Object.keys(changes).length > 0) {
      await scoped.update('customers', eq(customersTable.id, existing.id), changes);
    }
    return existing.id;
  }

  const [created] = await scoped.insert('customers', {
    ...given,
    name: input.name,
    // Most auto transport is moved for brokers, so that is the useful default
    // when nobody said otherwise.
    kind: input.kind ?? 'broker',
  });

  return created?.id ?? null;
}
