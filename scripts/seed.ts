/**
 * Seeds a demo organisation.
 *
 * For evaluating the app and for development. It refuses to run against a
 * database that already has an organisation, so it cannot be pointed at a
 * real instance by accident.
 *
 *   npm run db:seed
 */
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { hash } from '@node-rs/argon2';
import { uuidv7 } from 'uuidv7';
import * as schema from '../src/lib/db/schema';
import { computeCheckDigit } from '../src/lib/vin/validate';

const DEMO_EMAIL = 'demo@openhaul.test';
const DEMO_PASSWORD = 'harbor-crane-lantern-92';

/**
 * Repairs position 9 so every seeded VIN passes its own check digit.
 *
 * Inventing VINs by hand almost always produces invalid ones, which would
 * make the demo data contradict the validation the app is built around.
 */
function withValidCheckDigit(vin: string): string {
  const provisional = `${vin.slice(0, 8)}0${vin.slice(9)}`;
  const digit = computeCheckDigit(provisional);
  if (!digit) throw new Error(`cannot compute a check digit for ${vin}`);
  return `${vin.slice(0, 8)}${digit}${vin.slice(9)}`;
}

const VEHICLES = [
  { vin: '1HGCM82633A004352', year: 2003, make: 'HONDA', model: 'Accord', color: 'Silver', type: '2_door_coupe' },
  { vin: '5YJSA1E27HF000337', year: 2017, make: 'TESLA', model: 'Model S', color: 'Red', type: 'sedan' },
  { vin: withValidCheckDigit('1FTFW1ET0EFA00001'), year: 2014, make: 'FORD', model: 'F-150', color: 'White', type: '4_door_pickup' },
  { vin: withValidCheckDigit('JTDKN3DU0A0000001'), year: 2010, make: 'TOYOTA', model: 'Prius', color: 'Blue', type: 'sedan' },
  { vin: withValidCheckDigit('1G1ZD5ST0LF000001'), year: 2020, make: 'CHEVROLET', model: 'Malibu', color: 'Black', type: 'sedan' },
  { vin: withValidCheckDigit('WBA8E9C50GK000001'), year: 2016, make: 'BMW', model: '328i', color: 'Grey', type: 'sedan' },
  { vin: withValidCheckDigit('1C4RJFBG0FC000001'), year: 2015, make: 'JEEP', model: 'Grand Cherokee', color: 'Green', type: 'suv' },
] as const;

async function main() {
  const url = process.env.DATABASE_URL ?? 'file:./data/openhaul.db';
  const client = createClient({
    url,
    authToken: process.env.DATABASE_AUTH_TOKEN,
    encryptionKey: process.env.DATABASE_ENCRYPTION_KEY,
  });
  await client.execute('PRAGMA foreign_keys = ON');

  const db = drizzle(client, { schema });

  const existing = await db.select({ id: schema.organizations.id }).from(schema.organizations).limit(1);
  if (existing.length > 0) {
    console.error('This database already has an organisation. Refusing to seed over real data.');
    console.error('Delete the database file first if you meant to start fresh.');
    process.exit(1);
  }

  const orgId = uuidv7();
  const userId = uuidv7();

  await db.insert(schema.organizations).values({
    id: orgId,
    legalName: 'Ridgeline Auto Transport LLC',
    kind: 'carrier',
    usdotNumber: '3312907',
    mcNumber: 'MC-1084422',
    city: 'Fort Worth',
    state: 'TX',
    country: 'US',
  });

  await db.insert(schema.users).values({
    id: userId,
    email: DEMO_EMAIL,
    displayName: 'Dana Reyes',
    // Same parameters the application uses, so the demo account exercises the
    // real verification path rather than a shortcut.
    passwordHash: await hash(DEMO_PASSWORD, {
      algorithm: 2,
      version: 1,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
      secret: process.env.PASSWORD_PEPPER
        ? Buffer.from(process.env.PASSWORD_PEPPER, 'base64')
        : undefined,
    }),
  });

  await db.insert(schema.memberships).values({ orgId, userId, role: 'owner' });

  const customerId = uuidv7();
  await db.insert(schema.customers).values({
    id: customerId,
    orgId,
    name: 'Cardinal Logistics Brokerage',
    kind: 'broker',
    mcNumber: 'MC-552104',
    contactName: 'Priya Raman',
    email: 'dispatch@cardinal.test',
    phone: '2145550118',
    defaultPaymentTerms: '30_days',
  });

  const runs = [
    { number: 'OH-1001', status: 'delivered', rate: 294_000, tariff: 320_000, miles: 1074, count: 7 },
    { number: 'OH-1002', status: 'in_transit', rate: 182_000, tariff: 205_000, miles: 534, count: 5 },
    { number: 'OH-1003', status: 'dispatched', rate: 315_000, tariff: 340_000, miles: 1236, count: 6 },
    { number: 'OH-1004', status: 'draft', rate: 98_500, tariff: 115_000, miles: 312, count: 3 },
  ] as const;

  const sevenYears = 7 * 365 * 24 * 60 * 60 * 1000;
  // Derived from a fixed base rather than the clock, so repeated seeds of the
  // same database produce the same fixtures.
  const base = Date.UTC(2026, 8, 1);

  for (const [index, run] of runs.entries()) {
    const loadId = uuidv7();
    const createdAt = new Date(base + index * 86_400_000);

    await db.insert(schema.loads).values({
      id: loadId,
      orgId,
      number: run.number,
      status: run.status,
      transportType: 'open',
      customerId,
      rateCents: run.rate,
      tariffCents: run.tariff,
      brokerFeeCents: run.tariff - run.rate,
      distanceMiles: run.miles,
      deadheadMiles: 40 + index * 15,
      paymentTerms: '30_days',
      instructions:
        index === 0
          ? 'Gate code 4471. Ask for Marcus at the back lot; the front desk will not have the keys.'
          : null,
      deliveredAt: run.status === 'delivered' ? new Date(base + index * 86_400_000 + 3 * 86_400_000) : null,
      retainUntil: new Date(createdAt.getTime() + sevenYears),
      createdAt,
      updatedAt: createdAt,
    });

    await db.insert(schema.vehicles).values(
      VEHICLES.slice(0, run.count).map((vehicle, position) => ({
        id: uuidv7(),
        orgId,
        loadId,
        vin: vehicle.vin,
        vinCheckDigitValid: true,
        year: vehicle.year,
        make: vehicle.make,
        model: vehicle.model,
        color: vehicle.color,
        vehicleType: vehicle.type,
        // One inoperable per load, because that is realistic and it exercises
        // the warning path on the load detail page.
        isInoperable: position === 2,
        inoperableReason: position === 2 ? 'Will not start; rolls and steers' : null,
        priceCents: Math.round(run.rate / run.count),
        createdAt,
        updatedAt: createdAt,
      })),
    );
  }

  await client.close();

  console.log('Seeded Ridgeline Auto Transport LLC with 4 loads and 21 vehicles.');
  console.log('');
  console.log(`  email:    ${DEMO_EMAIL}`);
  console.log(`  password: ${DEMO_PASSWORD}`);
  console.log('');
  console.log('Demo data only. Never seed a production database.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
