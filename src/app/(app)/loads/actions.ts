'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { appendAudit, AUDIT } from '@/lib/audit/chain';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import { classifyVin, isValidVin, normalizeVin } from '@/lib/vin';
import { missingStopFields, readStopParty, saveStop } from '@/lib/loads/route';
import { nextLoadNumber } from '@/lib/loads/numbering';
import { readCustomer, upsertCustomer } from '@/lib/customers/upsert';

export interface LoadActionResult {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
}

/** Money arrives as a decimal string and is stored as integer cents. */
const dollarsToCents = z
  .string()
  .trim()
  .optional()
  .transform((value) => {
    if (!value) return null;
    const parsed = Number.parseFloat(value.replace(/[$,]/g, ''));
    if (!Number.isFinite(parsed)) return null;
    return Math.round(parsed * 100);
  });

const vehicleSchema = z.object({
  vin: z
    .string()
    .trim()
    .min(5, 'Enter a VIN.')
    .transform(normalizeVin)
    .refine((vin) => classifyVin(vin).kind !== 'invalid', 'That is not a usable VIN.'),
  year: z.coerce.number().int().min(1900).max(2100).optional().or(z.literal(Number.NaN)),
  make: z.string().trim().max(80).optional(),
  model: z.string().trim().max(80).optional(),
  color: z.string().trim().max(40).optional(),
  isInoperable: z.boolean().optional(),
});

const createLoadSchema = z.object({
  number: z.string().trim().min(1, 'Give the load a reference.').max(60),
  transportType: z.enum(['open', 'enclosed']),
  rate: dollarsToCents,
  tariff: dollarsToCents,
  distanceMiles: z.coerce.number().int().min(0).max(20000).optional(),
  instructions: z.string().trim().max(4000).optional(),
  vehicles: z.array(vehicleSchema).min(1, 'Add at least one vehicle.').max(12),
});

export async function suggestLoadNumber(): Promise<string> {
  try {
    const { db: scoped } = await requireCapability('load.write');
    return await nextLoadNumber(scoped);
  } catch {
    return 'OH-1001';
  }
}

export async function createLoadAction(
  _previous: LoadActionResult | null,
  formData: FormData,
): Promise<LoadActionResult> {
  let context;
  try {
    context = await requireCapability('load.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const { session, db: scoped } = context;

  // Vehicles arrive as parallel indexed fields, which keeps the form working
  // without JavaScript.
  const vins = formData.getAll('vin').map(String);
  const years = formData.getAll('year').map(String);
  const makes = formData.getAll('make').map(String);
  const models = formData.getAll('model').map(String);
  const colors = formData.getAll('color').map(String);
  const inops = new Set(formData.getAll('inoperable').map(String));

  const vehicleInput = vins
    .map((vin, index) => ({
      vin,
      year: years[index] ? Number.parseInt(years[index], 10) : undefined,
      make: makes[index] || undefined,
      model: models[index] || undefined,
      color: colors[index] || undefined,
      isInoperable: inops.has(String(index)),
    }))
    .filter((v) => v.vin.trim().length > 0);

  const parsed = createLoadSchema.safeParse({
    number: formData.get('number'),
    transportType: formData.get('transportType') ?? 'open',
    rate: formData.get('rate') ?? undefined,
    tariff: formData.get('tariff') ?? undefined,
    distanceMiles: formData.get('distanceMiles') || undefined,
    instructions: formData.get('instructions') ?? undefined,
    vehicles: vehicleInput,
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.');
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, fieldErrors, error: parsed.error.issues[0]?.message };
  }

  const data = parsed.data;

  // A route is optional at this point — vehicles are often booked before the
  // addresses land — but a half-typed one is a mistake, so it is caught here
  // rather than at bill-of-lading time.
  const pickup = readStopParty(formData, 'pickup');
  const delivery = readStopParty(formData, 'delivery');

  for (const [prefix, party] of [['pickup', pickup], ['delivery', delivery]] as const) {
    const missing = missingStopFields(party);
    if (missing.length > 0) {
      return {
        ok: false,
        fieldErrors: { [`${prefix}Name`]: `Still needs ${missing.join(', ')}.` },
        error: `The ${prefix} address is incomplete: it still needs ${missing.join(', ')}.`,
      };
    }
  }

  // The customer is upserted before the load so the load can point at it. A
  // load booked without one is fine; it just cannot be invoiced until it has
  // somebody to address the invoice to.
  const customerInput = readCustomer(formData);
  const customerId = await upsertCustomer(scoped, customerInput);

  const [created] = await scoped.insert('loads', {
    number: data.number,
    customerId,
    paymentTerms: customerInput.defaultPaymentTerms ?? null,
    status: 'draft',
    transportType: data.transportType,
    rateCents: data.rate,
    tariffCents: data.tariff,
    brokerFeeCents:
      data.tariff !== null && data.rate !== null ? Math.max(0, data.tariff - data.rate) : null,
    distanceMiles: data.distanceMiles ?? null,
    instructions: data.instructions || null,
  });

  if (!created) {
    return { ok: false, error: 'The load could not be created. Please try again.' };
  }

  await scoped.insertMany(
    'vehicles',
    data.vehicles.map((vehicle) => ({
      loadId: created.id,
      vin: vehicle.vin,
      vinCheckDigitValid: isValidVin(vehicle.vin),
      year: Number.isFinite(vehicle.year) ? (vehicle.year ?? null) : null,
      make: vehicle.make ?? null,
      model: vehicle.model ?? null,
      color: vehicle.color ?? null,
      isInoperable: vehicle.isInoperable ?? false,
    })),
  );

  await saveStop(scoped, created.id, 'pickup', pickup);
  await saveStop(scoped, created.id, 'delivery', delivery);

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.loadCreated,
    subject: `load:${created.id}`,
    detail: { number: data.number, vehicleCount: data.vehicles.length },
  });

  revalidatePath('/loads');
  revalidatePath('/dashboard');
  redirect(`/loads/${created.id}`);
}
