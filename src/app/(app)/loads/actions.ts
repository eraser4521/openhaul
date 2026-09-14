'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { loads } from '@/lib/db/schema';
import { appendAudit, AUDIT } from '@/lib/audit/chain';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import type { ScopedDb } from '@/lib/db/scope';
import { classifyVin, isValidVin, normalizeVin } from '@/lib/vin';

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

/** Next sequential reference, scoped to the organisation. */
async function nextLoadNumber(scoped: ScopedDb): Promise<string> {
  const [latest] = await scoped.select('loads', undefined, {
    orderBy: { column: loads.createdAt, direction: 'desc' },
    limit: 1,
  });

  const match = latest?.number ? /(\d+)$/.exec(latest.number) : null;
  const next = match?.[1] ? Number.parseInt(match[1], 10) + 1 : 1001;
  return `OH-${next}`;
}

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

  const [created] = await scoped.insert('loads', {
    number: data.number,
    status: 'draft',
    transportType: data.transportType,
    rateCents: data.rate,
    tariffCents: data.tariff,
    brokerFeeCents:
      data.tariff !== null && data.rate !== null ? Math.max(0, data.tariff - data.rate) : null,
    distanceMiles: data.distanceMiles ?? null,
    instructions: data.instructions || null,
    // Default retention is seven years: the regulatory floor for a bill of
    // lading is one, but Carmack allows a claim at nine months and suit two
    // years after denial, so the real exposure is far longer.
    retainUntil: new Date(Date.now() + 7 * 365 * 24 * 60 * 60 * 1000),
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
