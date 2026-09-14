import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { parseCsv, sniffDelimiter } from '@/lib/import/csv';
import { guessMapping, normalizeHeader, unmappedColumns } from '@/lib/import/columns';
import {
  countProblems,
  importable,
  parseDate,
  parseFlag,
  parseLocation,
  parseState,
  parseVehicleType,
  parseYear,
  readTable,
  splitVins,
} from '@/lib/import/rows';
import { applyMigrations } from './helpers/temp-db';

/**
 * Bringing loads in from somewhere else.
 *
 * The failures worth testing here are the quiet ones. A shifted column, a
 * date read day-first, a broker's price recorded as the driver's pay — none
 * of them error, all of them are wrong, and every one is discovered weeks
 * later on an invoice or a settlement. So most of what follows checks that
 * the importer refuses rather than guesses.
 */

/* -------------------------------------------------------------------------
 * The grid
 * ---------------------------------------------------------------------- */

describe('reading the file', () => {
  it('keeps a comma that is inside an address', () => {
    const table = parseCsv('Ref,Pickup\n88231,"4400 N Main St, Suite 3"\n');

    expect(table.headers).toEqual(['Ref', 'Pickup']);
    expect(table.rows[0]?.cells).toEqual(['88231', '4400 N Main St, Suite 3']);
  });

  it('keeps a line break inside a quoted note, and still counts lines', () => {
    const table = parseCsv('Ref,Note\nA,"top gate\nafter 6pm"\nB,later\n');

    expect(table.rows[0]?.cells[1]).toBe('top gate\nafter 6pm');
    // B is on line 4 of the file, not line 3 of the record list.
    expect(table.rows[1]?.line).toBe(4);
  });

  it('reads a doubled quote as one', () => {
    const table = parseCsv('Ref,Note\nA,"24"" wheels"\n');
    expect(table.rows[0]?.cells[1]).toBe('24" wheels');
  });

  it('treats a quote in the middle of a value as a character', () => {
    const table = parseCsv('Ref,Note\nA,24" wheels\n');
    expect(table.rows[0]?.cells[1]).toBe('24" wheels');
  });

  it('strips a byte order mark so the first header still matches', () => {
    const table = parseCsv('﻿Order ID,VIN\n1,X\n');

    expect(table.headers[0]).toBe('Order ID');
    expect(guessMapping(table.headers).loadNumber).toBe(0);
  });

  it('finds the delimiter from the header, not from the data', () => {
    // Every address in the body is full of commas; the file is tab separated.
    const file = 'Ref\tPickup\tDelivery\nA\t"Dallas, TX"\t"Phoenix, AZ"\n';

    expect(sniffDelimiter(file)).toBe('\t');
    expect(parseCsv(file).rows[0]?.cells).toEqual(['A', 'Dallas, TX', 'Phoenix, AZ']);
  });

  it('reads a semicolon export', () => {
    expect(parseCsv('Ref;VIN\nA;1HGCM82633A004352\n').rows[0]?.cells[1]).toBe(
      '1HGCM82633A004352',
    );
  });

  it('handles CRLF, a missing final newline and a short row', () => {
    const table = parseCsv('Ref,VIN,Colour\r\nA,X,Red\r\nB,Y');

    expect(table.rows).toHaveLength(2);
    // Padded, not rejected: exports drop trailing empty cells constantly.
    expect(table.rows[1]?.cells).toEqual(['B', 'Y', '']);
  });

  it('drops a blank spacer line rather than importing an empty load', () => {
    const table = parseCsv('Ref,VIN\nA,X\n\n,,\nB,Y\n');

    expect(table.rows.map((row) => row.cells[0])).toEqual(['A', 'B']);
  });
});

/* -------------------------------------------------------------------------
 * The mapping
 * ---------------------------------------------------------------------- */

describe('guessing what the columns are', () => {
  it('ignores case, spacing, punctuation and bracketed units', () => {
    expect(normalizeHeader('Pickup ZIP Code')).toBe('pickupzipcode');
    expect(normalizeHeader('pickup_zip_code')).toBe('pickupzipcode');
    expect(normalizeHeader('Carrier Pay ($)')).toBe('carrierpay');
  });

  it('maps a dispatch-sheet header row', () => {
    const mapping = guessMapping([
      'Order ID',
      'Customer',
      'Carrier Pay',
      'Pickup City',
      'Pickup State',
      'Pickup Zip',
      'Delivery City',
      'Delivery State',
      'Delivery Zip',
      'VIN',
      'Year',
      'Make',
      'Model',
    ]);

    expect(mapping.loadNumber).toBe(0);
    expect(mapping.customerName).toBe(1);
    expect(mapping.rate).toBe(2);
    expect(mapping.pickupCity).toBe(3);
    expect(mapping.deliveryZip).toBe(8);
    expect(mapping.vin).toBe(9);
  });

  it('claims a header once, so two candidates do not both win', () => {
    const headers = ['Customer', 'Broker', 'VIN'];
    const mapping = guessMapping(headers);

    expect(mapping.customerName).toBe(0);
    // Broker is a customer alias too, but Customer already took the field.
    expect(unmappedColumns(headers, mapping)).toEqual([1]);
  });

  it('gives a bare phone to the customer and a prefixed one to the stop', () => {
    const mapping = guessMapping(['Phone', 'Pickup Phone', 'VIN']);

    expect(mapping.customerPhone).toBe(0);
    expect(mapping.pickupPhone).toBe(1);
  });

  it('leaves an invertible column alone', () => {
    // "Operable: Yes" mapped to Inoperable turns every running car into a
    // winch job. Better unmapped and visible.
    const headers = ['VIN', 'Operable'];
    expect(guessMapping(headers).inoperable).toBeUndefined();
    expect(unmappedColumns(headers, guessMapping(headers))).toEqual([1]);
  });

  it('reads a bare price as the customer price, not the carrier pay', () => {
    const mapping = guessMapping(['Price', 'VIN']);

    expect(mapping.tariff).toBe(0);
    expect(mapping.rate).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------
 * Single values
 * ---------------------------------------------------------------------- */

describe('reading a value', () => {
  it('reads a US date month first', () => {
    const reading = parseDate('03/04/2026');
    expect(reading.ok && reading.date?.getMonth()).toBe(2);
    expect(reading.ok && reading.date?.getDate()).toBe(4);
  });

  it('refuses a day-first date rather than switching convention for one cell', () => {
    const reading = parseDate('25/12/2026');
    expect(reading).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('reads ISO, which is never ambiguous', () => {
    const reading = parseDate('2026-12-25');
    expect(reading.ok && reading.date?.getMonth()).toBe(11);
    expect(reading.ok && reading.date?.getDate()).toBe(25);
  });

  it('takes the near end of a window, with its time', () => {
    const reading = parseDate('3/4/2026 8:00 AM - 3/6/2026 5:00 PM');
    expect(reading.ok && reading.date?.getDate()).toBe(4);
    expect(reading.ok && reading.date?.getHours()).toBe(8);
  });

  it('rejects a day that does not exist instead of rolling into next month', () => {
    expect(parseDate('02/30/2026')).toEqual({ ok: false, reason: 'unreadable' });
    expect(parseDate('ASAP')).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('reads a blank date as no date, not as a problem', () => {
    expect(parseDate('')).toEqual({ ok: true, date: null });
    expect(parseDate('TBD')).toEqual({ ok: true, date: null });
  });

  it('reads a two-digit year the way a title clerk would', () => {
    const now = new Date(2026, 0, 1);
    expect(parseYear('03', now)).toBe(2003);
    expect(parseYear('98', now)).toBe(1998);
    expect(parseYear('2024', now)).toBe(2024);
    // A row number that landed in the year column.
    expect(parseYear('7', now)).toBeNull();
    expect(parseYear('3026', now)).toBeNull();
  });

  it('splits a location cell', () => {
    expect(parseLocation('Dallas, TX 75201')).toEqual({
      addressLine1: null,
      city: 'Dallas',
      state: 'TX',
      postalCode: '75201',
    });
    expect(parseLocation('Phoenix AZ')).toEqual({
      addressLine1: null,
      city: 'Phoenix',
      state: 'AZ',
      postalCode: null,
    });
    expect(parseLocation('Winston-Salem, NC 27101-1234')).toEqual({
      addressLine1: null,
      city: 'Winston-Salem',
      state: 'NC',
      postalCode: '27101',
    });
  });

  it('keeps a street out of the city when the cell carries the whole address', () => {
    // A city recorded as "4550 Blue Mound Rd" is wrong on the screen, wrong
    // in a search and wrong on the bill of lading.
    expect(parseLocation('4550 Blue Mound Rd, Fort Worth, TX 76106')).toEqual({
      addressLine1: '4550 Blue Mound Rd',
      city: 'Fort Worth',
      state: 'TX',
      postalCode: '76106',
    });
    expect(parseLocation('Gate 4, 1200 Harbor Blvd, Tampa, Florida 33602')).toEqual({
      addressLine1: 'Gate 4, 1200 Harbor Blvd',
      city: 'Tampa',
      state: 'FL',
      postalCode: '33602',
    });
  });

  it('converts a state name rather than storing half of it', () => {
    expect(parseState('Texas')).toBe('TX');
    expect(parseState('tx')).toBe('TX');
    expect(parseState('New York')).toBe('NY');
    // Not a state: better blank than "PA" from "Pacific".
    expect(parseState('Pacific Region')).toBeNull();
  });

  it('splits several VINs in one cell without breaking one with a typo space', () => {
    expect(splitVins('1HGCM82633A004352, 5YJSA1E27HF000337')).toEqual([
      '1HGCM82633A004352',
      '5YJSA1E27HF000337',
    ]);
    // normalizeVin already repairs an internal space; splitting there would
    // turn one vehicle into two fragments.
    expect(splitVins('1HGCM826 33A004352')).toEqual(['1HGCM82633A004352']);
  });

  it('reads a flag, and reads nothing as nothing', () => {
    expect(parseFlag('Yes')).toBe(true);
    expect(parseFlag('INOP')).toBe(true);
    expect(parseFlag('no')).toBe(false);
    expect(parseFlag('maybe')).toBeNull();
    expect(parseFlag('')).toBeNull();
  });

  it('maps only body types it is sure of', () => {
    expect(parseVehicleType('SUV')).toBe('suv');
    expect(parseVehicleType('Pick-up')).toBe('pickup');
    expect(parseVehicleType('4 door pickup')).toBe('4_door_pickup');
    expect(parseVehicleType('Motorcycle')).toBe('motorcycle');
    expect(parseVehicleType('Class A')).toBeNull();
  });
});

/* -------------------------------------------------------------------------
 * The whole table
 * ---------------------------------------------------------------------- */

const ACCORD = '1HGCM82633A004352';
const TESLA = '5YJSA1E27HF000337';
const BAD_CHECK_DIGIT = '5YJSA1E26HF000337';

function read(file: string) {
  const table = parseCsv(file);
  return readTable(table, guessMapping(table.headers));
}

describe('reading a file into loads', () => {
  it('folds rows that share a load number into one load', () => {
    const loads = read(
      [
        'Order ID,VIN,Carrier Pay,Pickup City,Pickup State',
        `88231,${ACCORD},950,Dallas,TX`,
        `88231,${TESLA},950,Dallas,TX`,
        '',
      ].join('\n'),
    );

    expect(loads).toHaveLength(1);
    expect(loads[0]?.number).toBe('88231');
    expect(loads[0]?.vehicles.map((v) => v.vin)).toEqual([ACCORD, TESLA]);
    expect(loads[0]?.rateCents).toBe(95_000);
    expect(loads[0]?.lines).toEqual([2, 3]);
  });

  it('keeps rows apart when the file has no load number', () => {
    const loads = read(`VIN,Pickup City\n${ACCORD},Dallas\n${TESLA},Reno\n`);

    expect(loads).toHaveLength(2);
    expect(loads.every((load) => load.number === null)).toBe(true);
  });

  it('says so when rows in one load disagree, and keeps the first', () => {
    const loads = read(
      [
        'Order ID,VIN,Carrier Pay',
        `88231,${ACCORD},950`,
        `88231,${TESLA},1250`,
        '',
      ].join('\n'),
    );

    expect(loads[0]?.rateCents).toBe(95_000);
    expect(loads[0]?.problems.filter((p) => p.message.includes('disagree'))).toHaveLength(1);
  });

  it('turns several VINs in one cell into several vehicles, and drops the detail', () => {
    const loads = read(`Order ID,VIN,Year,Make\n88231,"${ACCORD}; ${TESLA}",2003,Honda\n`);

    expect(loads[0]?.vehicles).toHaveLength(2);
    // The year and make cannot be attributed to either VIN, so neither gets
    // them — a Tesla recorded as a 2003 Honda is worse than a blank.
    expect(loads[0]?.vehicles.every((v) => v.make === null && v.year === null)).toBe(true);
    expect(loads[0]?.problems.some((p) => p.message.includes('2 VINs in one cell'))).toBe(true);
  });

  it('keeps the year and make when the row is one vehicle', () => {
    const loads = read(`Order ID,VIN,Year,Make,Model\n88231,${ACCORD},03,Honda,Accord\n`);

    expect(loads[0]?.vehicles[0]).toMatchObject({ year: 2003, make: 'Honda', model: 'Accord' });
  });

  it('flags a VIN that fails its check digit but still imports it', () => {
    const loads = read(`Order ID,VIN\n88231,${BAD_CHECK_DIGIT}\n`);

    expect(loads[0]?.vehicles[0]?.vinCheckDigitValid).toBe(false);
    expect(countProblems(loads)).toEqual({ errors: 0, warnings: 3 });
    expect(loads[0]?.problems.some((p) => p.message.includes('fails its check digit'))).toBe(
      true,
    );
    expect(importable(loads)).toHaveLength(1);
  });

  it('refuses a load whose VIN column is a placeholder', () => {
    // A pre-1981 VIN is five to sixteen characters of letters and digits, and
    // so is the word somebody types while waiting for the real one. Length
    // cannot tell them apart, so the placeholders are named.
    const loads = read('Order ID,VIN\n88231,PENDING\n');

    expect(importable(loads)).toHaveLength(0);
    // One reason, not two: "no vehicle on this load" is the same fault said
    // again, and reads as a second thing to chase.
    expect(loads[0]?.problems.filter((p) => p.severity === 'error')).toHaveLength(1);
  });

  it('still accepts a genuine short VIN from before 1981', () => {
    const loads = read('Order ID,VIN\n88231,CE145F123456\n');

    expect(importable(loads)).toHaveLength(1);
    expect(loads[0]?.vehicles[0]?.vinCheckDigitValid).toBeNull();
  });

  it('refuses more vehicles than a trailer holds, because that is a reused number', () => {
    const rows = Array.from({ length: 13 }, (_, i) => {
      const vin = `1HGCM82633A0043${String(50 + i).padStart(2, '0')}`;
      return `88231,${vin}`;
    });
    const loads = read(['Order ID,VIN', ...rows, ''].join('\n'));

    expect(loads[0]?.vehicles).toHaveLength(13);
    expect(importable(loads)).toHaveLength(0);
  });

  it('drops a VIN repeated on the same load', () => {
    const loads = read(`Order ID,VIN\n88231,${ACCORD}\n88231,${ACCORD}\n`);

    expect(loads[0]?.vehicles).toHaveLength(1);
    expect(loads[0]?.problems.some((p) => p.message.includes('more than once'))).toBe(true);
  });

  it('reads an origin column that is one string', () => {
    const loads = read(`Order ID,VIN,Origin,Destination\n88231,${ACCORD},"Dallas, TX 75201","Phoenix, AZ"\n`);

    expect(loads[0]?.pickup).toMatchObject({ city: 'Dallas', state: 'TX', postalCode: '75201' });
    expect(loads[0]?.delivery).toMatchObject({ city: 'Phoenix', state: 'AZ' });
  });

  it('warns that a city and state alone will not produce an address', () => {
    const loads = read(`Order ID,VIN,Pickup City,Pickup State\n88231,${ACCORD},Dallas,TX\n`);

    expect(importable(loads)).toHaveLength(1);
    expect(
      loads[0]?.problems.some((p) => p.message.includes('pickup still needs')),
    ).toBe(true);
    // Named, not merely called incomplete.
    expect(loads[0]?.problems.some((p) => p.message.includes('a street address'))).toBe(true);
  });

  it('accepts a residential pickup with a contact and no business name', () => {
    const loads = read(
      [
        'Order ID,VIN,Pickup Address,Pickup City,Pickup State,Pickup Zip,Pickup Contact',
        `88231,${ACCORD},220 Willow Ln,Dallas,TX,75201,Marta Reyes`,
        '',
      ].join('\n'),
    );

    expect(loads[0]?.problems.some((p) => p.message.includes('pickup still needs'))).toBe(
      false,
    );
  });

  it('says when the file never mentions where the load goes', () => {
    const loads = read(`Order ID,VIN\n88231,${ACCORD}\n`);

    expect(loads[0]?.problems.some((p) => p.message.includes('picks up'))).toBe(true);
    expect(loads[0]?.problems.some((p) => p.message.includes('delivers'))).toBe(true);
    expect(importable(loads)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------
 * Against a real database
 * ---------------------------------------------------------------------- */

let workspace: string;
let scoped: Awaited<ReturnType<(typeof import('@/lib/db/scope'))['forOrg']>>;
let dbModule: typeof import('@/lib/db/client');
let schema: typeof import('@/lib/db/schema');
let commit: typeof import('@/lib/import/commit');
let chain: typeof import('@/lib/audit/chain');

const ACTOR = { orgId: '', userId: '', role: 'owner' };

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'openhaul-import-'));
  process.env.DATABASE_URL = `file:${path.join(workspace, 'test.db')}`;
  delete process.env.DATABASE_ENCRYPTION_KEY;
  process.env.BLOB_STORAGE_PATH = path.join(workspace, 'uploads');

  dbModule = await import('@/lib/db/client');
  schema = await import('@/lib/db/schema');
  await dbModule.ready();
  await applyMigrations(dbModule.rawClient);

  const { asOrgId, forOrg } = await import('@/lib/db/scope');
  commit = await import('@/lib/import/commit');
  chain = await import('@/lib/audit/chain');

  const [org] = await dbModule.db
    .insert(schema.organizations)
    .values({ legalName: 'Ridgeline Auto Transport LLC' })
    .returning();
  ACTOR.orgId = org!.id;

  const [user] = await dbModule.db
    .insert(schema.users)
    .values({ email: 'dispatch@ridgeline.test', displayName: 'Dispatch', passwordHash: 'x' })
    .returning();
  ACTOR.userId = user!.id;

  scoped = forOrg(asOrgId(org!.id));
});

afterAll(async () => {
  dbModule.rawClient.close();
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  for (const table of ['vehicles', 'stops', 'loads', 'venues', 'customers'] as const) {
    for (const row of await scoped.select(table)) {
      const column = (schema[table] as unknown as { id: Parameters<typeof eq>[0] }).id;
      await scoped.remove(table, eq(column, row.id));
    }
  }
});

describe('writing what was read', () => {
  it('creates the load, its vehicles and its route', async () => {
    const parsed = read(
      [
        'Order ID,Customer,Carrier Pay,Price,VIN,Pickup Name,Pickup Address,Pickup City,Pickup State,Pickup Zip,Pickup Date,Delivery Name,Delivery Address,Delivery City,Delivery State,Delivery Zip',
        `88231,Copart Dallas,950,1200,${ACCORD},Copart Dallas,4550 Blue Mound Rd,Fort Worth,TX,76106,03/04/2026,Ridge Motors,88 Camelback Rd,Phoenix,AZ,85004`,
        '',
      ].join('\n'),
    );

    const outcome = await commit.commitImport(scoped, parsed, ACTOR);
    expect(outcome).toMatchObject({ created: 1, vehicles: 1, skipped: 0 });

    const [load] = await scoped.select('loads');
    expect(load?.number).toBe('88231');
    expect(load?.status).toBe('draft');
    expect(load?.rateCents).toBe(95_000);
    expect(load?.tariffCents).toBe(120_000);
    // The spread is the broker fee, derived rather than imported.
    expect(load?.brokerFeeCents).toBe(25_000);

    const stops = await scoped.select('stops');
    expect(stops).toHaveLength(2);
    expect(stops.every((stop) => stop.venueId !== null)).toBe(true);

    const [customer] = await scoped.select('customers');
    expect(customer?.name).toBe('Copart Dallas');
  });

  it('keeps a city-and-state-only stop as a note instead of inventing a street', async () => {
    const parsed = read(`Order ID,VIN,Origin\n88231,${ACCORD},"Dallas, TX 75201"\n`);
    await commit.commitImport(scoped, parsed, ACTOR);

    const [pickup] = await scoped.select('stops', eq(schema.stops.kind, 'pickup'));
    expect(pickup?.venueId).toBeNull();
    expect(pickup?.notes).toContain('Dallas, TX');
    // Nothing was written that could reach a bill of lading as an address.
    expect(await scoped.select('venues')).toHaveLength(0);
  });

  it('assigns numbers when the file has none, and does not reuse one', async () => {
    const parsed = read(`VIN\n${ACCORD}\n${TESLA}\n`);
    const outcome = await commit.commitImport(scoped, parsed, ACTOR);

    expect(outcome.numbers).toEqual(['OH-1001', 'OH-1002']);
    expect(new Set(outcome.numbers).size).toBe(2);
  });

  it('will not import onto a load number that already exists', async () => {
    await scoped.insert('loads', { number: 'OH-5000', status: 'draft' });

    const parsed = await commit.annotateDuplicates(
      scoped,
      read(`Order ID,VIN\nOH-5000,${ACCORD}\n`),
    );

    expect(importable(parsed)).toHaveLength(0);
    const outcome = await commit.commitImport(scoped, parsed, ACTOR);
    expect(outcome).toMatchObject({ created: 0, skipped: 1 });
    expect(await scoped.select('loads')).toHaveLength(1);
  });

  it('flags a VIN already moving, without blocking a genuine second move', async () => {
    const [existing] = await scoped.insert('loads', { number: 'OH-4000', status: 'dispatched' });
    await scoped.insert('vehicles', { loadId: existing!.id, vin: ACCORD });

    const parsed = await commit.annotateDuplicates(
      scoped,
      read(`Order ID,VIN\n99000,${ACCORD}\n`),
    );

    expect(parsed[0]?.problems.some((p) => p.message.includes('still open'))).toBe(true);
    expect(importable(parsed)).toHaveLength(1);
  });

  it('does not flag a VIN whose last load is finished', async () => {
    const [existing] = await scoped.insert('loads', { number: 'OH-4001', status: 'delivered' });
    await scoped.insert('vehicles', { loadId: existing!.id, vin: ACCORD });

    const parsed = await commit.annotateDuplicates(
      scoped,
      read(`Order ID,VIN\n99001,${ACCORD}\n`),
    );

    expect(parsed[0]?.problems.some((p) => p.message.includes('still open'))).toBe(false);
  });

  it('writes one audit entry for the batch, and leaves the chain sound', async () => {
    const parsed = read(`Order ID,VIN\n91001,${ACCORD}\n91002,${TESLA}\n`);
    await commit.commitImport(scoped, parsed, ACTOR);

    // Filtered by subject, not just action: the chain spans the whole run and
    // earlier tests in this file imported too.
    const entries = await dbModule.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.subject, 'import:91001'));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe(chain.AUDIT.loadsImported);
    expect(entries[0]?.detail).toMatchObject({ created: 2, vehicles: 2, skipped: 0 });

    expect((await chain.verifyChain()).ok).toBe(true);
  });
});
