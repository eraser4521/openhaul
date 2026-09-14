import 'server-only';
import { inArray } from 'drizzle-orm';
import { vehicles as vehiclesTable, OPEN_LOAD_STATUSES } from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { appendAudit, AUDIT } from '../audit/chain';
import { upsertCustomer } from '../customers/upsert';
import { saveStop } from '../loads/route';
import { allocateLoadNumbers } from '../loads/numbering';
import {
  describeStop,
  importable,
  stopHasAnything,
  stopIsComplete,
  venueName,
  type ParsedLoad,
  type ParsedStop,
} from './rows';

/**
 * Putting an import on the record.
 *
 * Split from the parsing on purpose: everything that decides *what* an import
 * means is pure and testable without a database, and everything here only
 * writes what has already been decided and shown to a person.
 *
 * Two checks need the database and so live here. A load number already in use
 * is fatal — the unique index would reject it anyway, and quietly renumbering
 * somebody's reference is worse than refusing. A VIN already on an open load
 * is only a warning: a car really can move twice, and a re-delivery is a
 * normal job. Both are the sort of thing nobody notices until an invoice goes
 * to the wrong broker.
 */

export interface ImportOutcome {
  created: number;
  vehicles: number;
  numbers: string[];
  skipped: number;
}

/**
 * Adds the problems only the database knows about.
 *
 * Returns new objects rather than mutating, so the caller can keep showing
 * the parse it already has if this fails.
 */
export async function annotateDuplicates(
  scoped: ScopedDb,
  parsed: ParsedLoad[],
): Promise<ParsedLoad[]> {
  const existingLoads = await scoped.select('loads');
  const taken = new Map(existingLoads.map((load) => [load.number.toUpperCase(), load.number]));

  const openIds = existingLoads
    .filter((load) => OPEN_LOAD_STATUSES.includes(load.status))
    .map((load) => load.id);

  const onOpenLoads = new Map<string, string>();
  if (openIds.length > 0) {
    const rows = await scoped.select('vehicles', inArray(vehiclesTable.loadId, openIds));
    const numbers = new Map(existingLoads.map((load) => [load.id, load.number]));
    for (const row of rows) {
      const number = numbers.get(row.loadId);
      if (number) onOpenLoads.set(row.vin, number);
    }
  }

  return parsed.map((load) => {
    const problems = [...load.problems];

    const clash = load.number ? taken.get(load.number.toUpperCase()) : undefined;
    if (clash) {
      problems.push({
        line: load.lines[0] ?? null,
        severity: 'error',
        message: `Load ${clash} already exists. Change the number in the file, or clear the load-number column to have numbers assigned.`,
      });
    }

    for (const vehicle of load.vehicles) {
      const openOn = onOpenLoads.get(vehicle.vin);
      if (openOn) {
        problems.push({
          line: vehicle.line,
          severity: 'warning',
          message: `${vehicle.vin} is already on ${openOn}, which is still open. Importing this makes a second move of the same vehicle.`,
        });
      }
    }

    return { ...load, problems };
  });
}

/** Writes a stop, keeping a location that cannot become an address. */
async function saveImportedStop(
  scoped: ScopedDb,
  loadId: string,
  kind: 'pickup' | 'delivery',
  stop: ParsedStop,
): Promise<void> {
  if (!stopHasAnything(stop)) return;

  const scheduledAt = stop.scheduledAt?.toISOString() ?? null;

  if (stopIsComplete(stop)) {
    await saveStop(scoped, loadId, kind, {
      name: venueName(stop),
      businessType: undefined,
      addressLine1: stop.addressLine1,
      addressLine2: null,
      city: stop.city,
      state: stop.state,
      postalCode: stop.postalCode,
      contactName: stop.contactName,
      contactPhone: stop.contactPhone,
      contactEmail: null,
      gateCode: null,
      scheduledAt,
    });
    return;
  }

  /*
   * A venue row needs a name, street, city, state and postal code, and a
   * board export usually carries only a city and a state. Writing a venue
   * with an invented street would put that street on a bill of lading, so
   * the stop is created without one and what the file did say is kept as a
   * note — visible on the load, and enough for whoever fills in the rest.
   */
  await scoped.insert('stops', {
    loadId,
    kind,
    sequence: kind === 'pickup' ? 0 : 1,
    scheduledAt: stop.scheduledAt,
    notes: `Imported: ${describeStop(stop)}. Address still needed.`,
  });
}

/**
 * Creates every load that has nothing blocking it.
 *
 * Loads with errors are counted and left alone rather than partly written.
 * Numbers are allocated up front so a file that mixes its own references with
 * blanks cannot generate one that collides with a reference later in the same
 * file.
 */
export async function commitImport(
  scoped: ScopedDb,
  parsed: ParsedLoad[],
  actor: { orgId: string; userId: string; role: string },
): Promise<ImportOutcome> {
  const ready = importable(parsed);
  const skipped = parsed.length - ready.length;

  const explicit = new Set(
    ready.map((load) => load.number?.toUpperCase()).filter((number): number is string => !!number),
  );

  const needed = ready.filter((load) => !load.number).length;
  const pool = (await allocateLoadNumbers(scoped, needed + explicit.size)).filter(
    (number) => !explicit.has(number.toUpperCase()),
  );

  const numbers: string[] = [];
  let vehicleCount = 0;
  let assigned = 0;

  for (const load of ready) {
    const number = load.number ?? pool[assigned++];
    if (!number) continue;

    const customerId = await upsertCustomer(scoped, {
      name: load.customer.name,
      contactName: load.customer.contactName,
      email: load.customer.email,
      phone: load.customer.phone,
      kind: undefined,
      addressLine1: null,
      city: null,
      state: null,
      postalCode: null,
      mcNumber: null,
      usdotNumber: null,
      defaultPaymentTerms: undefined,
    });

    const [created] = await scoped.insert('loads', {
      number,
      customerId,
      status: 'draft',
      transportType: load.transportType ?? 'open',
      rateCents: load.rateCents,
      tariffCents: load.tariffCents,
      brokerFeeCents:
        load.tariffCents !== null && load.rateCents !== null
          ? Math.max(0, load.tariffCents - load.rateCents)
          : null,
      distanceMiles: load.distanceMiles,
      instructions: load.instructions,
    });

    if (!created) continue;

    await scoped.insertMany(
      'vehicles',
      load.vehicles.map((vehicle) => ({
        loadId: created.id,
        vin: vehicle.vin,
        vinCheckDigitValid: vehicle.vinCheckDigitValid,
        year: vehicle.year,
        make: vehicle.make,
        model: vehicle.model,
        color: vehicle.color,
        vehicleType: vehicle.vehicleType ?? undefined,
        lotNumber: vehicle.lotNumber,
        isInoperable: vehicle.isInoperable,
      })),
    );

    await saveImportedStop(scoped, created.id, 'pickup', load.pickup);
    await saveImportedStop(scoped, created.id, 'delivery', load.delivery);

    numbers.push(number);
    vehicleCount += load.vehicles.length;
  }

  if (numbers.length > 0) {
    await appendAudit({
      orgId: actor.orgId,
      actorId: actor.userId,
      actorRole: actor.role,
      action: AUDIT.loadsImported,
      subject: `import:${numbers[0]}`,
      detail: {
        created: numbers.length,
        vehicles: vehicleCount,
        skipped,
        numbers: numbers.slice(0, 50),
      },
    });
  }

  return { created: numbers.length, vehicles: vehicleCount, numbers, skipped };
}
