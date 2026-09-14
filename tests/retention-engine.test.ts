import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { applyMigrations } from './helpers/temp-db';

/**
 * The engine, against a real database and a real blob store.
 *
 * What these check is mostly what the engine refuses to destroy: a record
 * whose clock has not started, one under a legal hold placed after the report
 * was read, a blob a second record still points at, a class whose disposition
 * says report-only. A retention bug deletes a bill of lading somebody needed,
 * so the negative cases are the ones worth the most here.
 */

const DAY = 86_400_000;
const NOW = new Date('2026-09-14T12:00:00Z');
const LONG_AGO = new Date(NOW.getTime() - 4000 * DAY);
const RECENT = new Date(NOW.getTime() - 10 * DAY);

let workspace: string;
let scoped: Awaited<ReturnType<typeof import('@/lib/db/scope')['forOrg']>>;
let dbModule: typeof import('@/lib/db/client');
let schema: typeof import('@/lib/db/schema');
let engine: typeof import('@/lib/retention/engine');
let holds: typeof import('@/lib/retention/holds');
let chain: typeof import('@/lib/audit/chain');
let blobs: typeof import('@/lib/storage/blob-store');

/** A real row: `legal_holds.placed_by_user_id` is a foreign key. */
let ACTOR: { userId: string; role: string };

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'openhaul-retention-'));
  process.env.DATABASE_URL = `file:${path.join(workspace, 'test.db')}`;
  delete process.env.DATABASE_ENCRYPTION_KEY;
  process.env.BLOB_STORAGE_PATH = path.join(workspace, 'uploads');

  dbModule = await import('@/lib/db/client');
  schema = await import('@/lib/db/schema');
  await dbModule.ready();
  await applyMigrations(dbModule.rawClient);

  const { asOrgId, forOrg } = await import('@/lib/db/scope');
  engine = await import('@/lib/retention/engine');
  holds = await import('@/lib/retention/holds');
  chain = await import('@/lib/audit/chain');
  blobs = await import('@/lib/storage/blob-store');

  const [org] = await dbModule.db
    .insert(schema.organizations)
    .values({ legalName: 'Ridgeline Auto Transport LLC' })
    .returning();
  scoped = forOrg(asOrgId(org!.id));

  const [user] = await dbModule.db
    .insert(schema.users)
    .values({ email: 'owner@ridgeline.test', displayName: 'Alexis Campos' })
    .returning();
  ACTOR = { userId: user!.id, role: 'owner' };
});

afterAll(async () => {
  dbModule.rawClient.close();
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
});

/** Wipes everything the previous test made, so each starts from nothing. */
beforeEach(async () => {
  // Children before parents: the composite foreign keys are real, and the
  // order they are removed in is the order they depend on each other.
  for (const table of [
    'documents',
    'inspectionPhotos',
    'inspections',
    'legalHolds',
    'invoices',
    'vehicles',
    'loads',
    'carrierChecks',
    'retentionPolicies',
  ] as const) {
    const rows = await scoped.select(table);
    for (const row of rows) {
      const id = (row as { id?: string }).id;
      if (id) {
        const column = (schema[table] as unknown as { id: Parameters<typeof eq>[0] }).id;
        await scoped.remove(table, eq(column, id));
      }
    }
  }
});

async function makeLoad(deliveredAt: Date | null): Promise<string> {
  const [load] = await scoped.insert('loads', {
    number: `OH-${Math.floor(Math.random() * 100_000)}`,
    status: deliveredAt ? 'delivered' : 'in_transit',
    deliveredAt,
  });
  return load!.id;
}

/** An inspection needs a load and a vehicle; both are required columns. */
async function makeInspection(loadId: string, startedAt: Date): Promise<string> {
  const [vehicle] = await scoped.insert('vehicles', {
    loadId,
    vin: `1HGCM82633A${Math.floor(Math.random() * 1_000_000)}`,
  });

  const [inspection] = await scoped.insert('inspections', {
    loadId,
    vehicleId: vehicle!.id,
    stage: 'pickup',
    status: 'signed',
    startedAt,
  });

  return inspection!.id;
}

async function makeDocument(options: {
  kind: 'bol' | 'pod';
  loadId: string | null;
  finalizedAt: Date;
  bytes?: Buffer;
}): Promise<{ id: string; storageKey: string }> {
  const bytes = options.bytes ?? Buffer.from(`pdf-${Math.random()}`);
  const stored = await blobs.blobStore().put(bytes, 'application/pdf', 'documents');

  const [row] = await scoped.insert('documents', {
    kind: options.kind,
    loadId: options.loadId,
    title: `Document ${options.kind}`,
    storageKey: stored.key,
    sha256: stored.sha256,
    byteSize: stored.byteSize,
    contentType: 'application/pdf',
    finalizedAt: options.finalizedAt,
  });

  return { id: row!.id, storageKey: stored.key };
}

function reportFor(reports: Awaited<ReturnType<typeof engine.retentionReport>>, cls: string) {
  return reports.find((report) => report.recordClass === cls)!;
}

describe('what is due', () => {
  it('leaves a document inside its period alone', async () => {
    await makeDocument({ kind: 'bol', loadId: await makeLoad(RECENT), finalizedAt: RECENT });

    const report = reportFor(await engine.retentionReport(scoped, NOW), 'bill_of_lading');
    expect(report.total).toBe(1);
    expect(report.due).toBe(0);
    expect(report.keeping).toBe(1);
  });

  it('counts one past its period as due', async () => {
    await makeDocument({ kind: 'bol', loadId: await makeLoad(LONG_AGO), finalizedAt: LONG_AGO });

    const report = reportFor(await engine.retentionReport(scoped, NOW), 'bill_of_lading');
    expect(report.due).toBe(1);
    expect(report.oldestDueAt?.getTime()).toBe(LONG_AGO.getTime());
  });

  it('never counts an inspection on an undelivered load, however old', async () => {
    /*
     * The clock runs from delivery, and this load has not been delivered. An
     * implementation that fell back to the inspection's own date would destroy
     * the pickup photos of a vehicle still on the truck.
     */
    const loadId = await makeLoad(null);
    await makeInspection(loadId, LONG_AGO);

    const report = reportFor(await engine.retentionReport(scoped, NOW), 'inspection_evidence');
    expect(report.total).toBe(1);
    expect(report.pending).toBe(1);
    expect(report.due).toBe(0);
  });

  it('counts photos whose original was never recorded, rather than ignoring them', async () => {
    const loadId = await makeLoad(LONG_AGO);
    const inspectionId = await makeInspection(loadId, LONG_AGO);

    await scoped.insert('inspectionPhotos', {
      inspectionId,
      storageKey: 'photos/aa/bb/old.jpg',
      sha256: 'a'.repeat(64),
      byteSize: 1000,
      contentType: 'image/jpeg',
      // No originalStorageKey: a row written before the column existed.
    });

    const report = reportFor(await engine.retentionReport(scoped, NOW), 'inspection_evidence');
    expect(report.due).toBe(1);
    expect(report.unreachable).toBe(1);
  });
});

describe('legal holds', () => {
  it('moves a due record out of reach', async () => {
    const loadId = await makeLoad(LONG_AGO);
    await makeDocument({ kind: 'bol', loadId, finalizedAt: LONG_AGO });

    let report = reportFor(await engine.retentionReport(scoped, NOW), 'bill_of_lading');
    expect(report.due).toBe(1);

    await holds.placeHold(scoped, holds.holdOnLoad(loadId), 'Claim filed', ACTOR);

    report = reportFor(await engine.retentionReport(scoped, NOW), 'bill_of_lading');
    expect(report.due).toBe(0);
    expect(report.held).toBe(1);
  });

  it('covers everything when placed on the organisation', async () => {
    // What gets placed on being served with discovery, before anybody knows
    // which loads are in scope.
    await makeDocument({ kind: 'bol', loadId: await makeLoad(LONG_AGO), finalizedAt: LONG_AGO });
    await scoped.insert('carrierChecks', {
      usdotNumber: '3210987',
      source: 'manual',
      checkedAt: LONG_AGO,
    });

    await holds.placeHold(scoped, holds.ORG_HOLD, 'Served with discovery', ACTOR);

    const reports = await engine.retentionReport(scoped, NOW);
    expect(reportFor(reports, 'bill_of_lading').due).toBe(0);
    expect(reportFor(reports, 'carrier_check').due).toBe(0);
    expect(reportFor(reports, 'carrier_check').held).toBe(1);
  });

  it('keeps a load held while a second reason is still live', async () => {
    /*
     * Two claims on one load are two independent reasons to keep it. Closing
     * one must not release the other — the bug a single boolean invites.
     */
    const loadId = await makeLoad(LONG_AGO);
    const subject = holds.holdOnLoad(loadId);

    await holds.placeHold(scoped, subject, 'Claim one', ACTOR);
    await holds.placeHold(scoped, subject, 'Claim two', ACTOR);

    const live = await holds.activeHolds(scoped);
    expect(live).toHaveLength(2);

    await holds.releaseHolds(scoped, subject, ACTOR);

    const load = await scoped.selectOne('loads', eq(schema.loads.id, loadId));
    expect(load?.legalHold).toBe(false);
    expect(await holds.activeHolds(scoped)).toHaveLength(0);
  });

  it('sets and clears the flag the load screen reads', async () => {
    const loadId = await makeLoad(LONG_AGO);

    await holds.placeHold(scoped, holds.holdOnLoad(loadId), 'Claim filed', ACTOR);
    expect((await scoped.selectOne('loads', eq(schema.loads.id, loadId)))?.legalHold).toBe(true);

    await holds.releaseHolds(scoped, holds.holdOnLoad(loadId), ACTOR);
    expect((await scoped.selectOne('loads', eq(schema.loads.id, loadId)))?.legalHold).toBe(false);
  });
});

describe('purging', () => {
  it('deletes the rows and the bytes behind them', async () => {
    const loadId = await makeLoad(LONG_AGO);
    const doc = await makeDocument({ kind: 'bol', loadId, finalizedAt: LONG_AGO });

    expect(await blobs.blobStore().get(doc.storageKey)).not.toBeNull();

    const result = await engine.purgeClass(scoped, 'bill_of_lading', ACTOR, NOW);

    expect(result.ok).toBe(true);
    expect(result.purged).toBe(1);
    expect(await scoped.selectOne('documents', eq(schema.documents.id, doc.id))).toBeNull();
    expect(await blobs.blobStore().get(doc.storageKey)).toBeNull();
  });

  it('leaves a blob two records share', async () => {
    /*
     * Storage is content-addressed, so identical bytes are one object. The
     * failure this prevents is a document aging out and blanking a second,
     * still-live document that happened to be byte-identical.
     */
    const identical = Buffer.from('the same two pages');
    const old = await makeDocument({
      kind: 'bol',
      loadId: await makeLoad(LONG_AGO),
      finalizedAt: LONG_AGO,
      bytes: identical,
    });
    const fresh = await makeDocument({
      kind: 'pod',
      loadId: await makeLoad(RECENT),
      finalizedAt: RECENT,
      bytes: identical,
    });

    expect(old.storageKey).toBe(fresh.storageKey);

    await engine.purgeClass(scoped, 'bill_of_lading', ACTOR, NOW);

    expect(await scoped.selectOne('documents', eq(schema.documents.id, old.id))).toBeNull();
    expect(await scoped.selectOne('documents', eq(schema.documents.id, fresh.id))).not.toBeNull();
    expect(await blobs.blobStore().get(fresh.storageKey)).not.toBeNull();
  });

  it('clears pointers to a document it removes', async () => {
    // These columns carry no foreign key, so a dangling one survives as a
    // "View PDF" button that 404s.
    const loadId = await makeLoad(LONG_AGO);
    const doc = await makeDocument({ kind: 'bol', loadId, finalizedAt: LONG_AGO });

    const [invoice] = await scoped.insert('invoices', {
      number: 'INV-OH-1',
      status: 'paid',
      totalCents: 1000,
      documentId: doc.id,
    });

    await engine.purgeClass(scoped, 'bill_of_lading', ACTOR, NOW);

    const after = await scoped.selectOne('invoices', eq(schema.invoices.id, invoice!.id));
    expect(after).not.toBeNull();
    expect(after?.documentId).toBeNull();
  });

  it('honours a hold placed after the report was read', async () => {
    /*
     * The report and the button press are separate moments, and the gap
     * between them is exactly when somebody places a hold. The purge
     * re-evaluates rather than acting on the list it was shown.
     */
    const loadId = await makeLoad(LONG_AGO);
    const doc = await makeDocument({ kind: 'bol', loadId, finalizedAt: LONG_AGO });

    const report = reportFor(await engine.retentionReport(scoped, NOW), 'bill_of_lading');
    expect(report.due).toBe(1);

    await holds.placeHold(scoped, holds.holdOnLoad(loadId), 'Claim just filed', ACTOR);

    const result = await engine.purgeClass(scoped, 'bill_of_lading', ACTOR, NOW);
    expect(result.purged).toBe(0);
    expect(await scoped.selectOne('documents', eq(schema.documents.id, doc.id))).not.toBeNull();
  });

  it('takes the photos and every object behind them', async () => {
    const loadId = await makeLoad(LONG_AGO);
    const inspectionId = await makeInspection(loadId, LONG_AGO);

    const store = blobs.blobStore();
    const derivative = await store.put(Buffer.from('served'), 'image/jpeg', 'photos');
    const original = await store.put(Buffer.from('untouched, with a gps fix'), 'image/jpeg', 'originals');
    const thumbnail = await store.put(Buffer.from('tiny'), 'image/jpeg', 'thumbs');

    await scoped.insert('inspectionPhotos', {
      inspectionId,
      storageKey: derivative.key,
      originalStorageKey: original.key,
      thumbnailStorageKey: thumbnail.key,
      sha256: derivative.sha256,
      byteSize: derivative.byteSize,
      contentType: 'image/jpeg',
    });

    const result = await engine.purgeClass(scoped, 'inspection_evidence', ACTOR, NOW);
    expect(result.purged).toBe(1);

    // The derivative is the one that was served; the original is the one that
    // still carried EXIF and a position. Both have to go.
    expect(await store.get(derivative.key)).toBeNull();
    expect(await store.get(original.key)).toBeNull();
    expect(await store.get(thumbnail.key)).toBeNull();
    expect(await scoped.select('inspectionPhotos')).toHaveLength(0);
  });

  it('refuses a class that is reported only', async () => {
    const result = await engine.purgeClass(scoped, 'cargo_claim', ACTOR, NOW);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('reported only');
  });

  it('points at erasure for driver records rather than deleting them', async () => {
    const result = await engine.purgeClass(scoped, 'driver_record', ACTOR, NOW);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Erase the personal data');
  });

  it('records what it destroyed without breaking the chain', async () => {
    await makeDocument({ kind: 'bol', loadId: await makeLoad(LONG_AGO), finalizedAt: LONG_AGO });

    const before = (await chain.chainHead()).seq;
    await engine.purgeClass(scoped, 'bill_of_lading', ACTOR, NOW);

    expect((await chain.chainHead()).seq).toBeGreaterThan(before);

    const entries = await dbModule.db.select().from(schema.auditLog);
    const entry = entries.find((row) => row.action === 'retention.purged');
    expect(entry?.subject).toBe('retention:bill_of_lading');
    expect(JSON.stringify(entry?.detail)).toContain('"purged":1');

    expect((await chain.verifyChain()).ok).toBe(true);
  });

  it('does nothing, quietly, when nothing is due', async () => {
    await makeDocument({ kind: 'bol', loadId: await makeLoad(RECENT), finalizedAt: RECENT });

    const result = await engine.purgeClass(scoped, 'bill_of_lading', ACTOR, NOW);
    expect(result).toMatchObject({ ok: true, purged: 0 });
    expect(await scoped.select('documents')).toHaveLength(1);
  });
});

describe('changing a period', () => {
  it('refuses to go below the regulatory floor, and says which one', async () => {
    const result = await engine.setRetentionDays(scoped, 'bill_of_lading', 30, ACTOR);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('365');
    expect(result.error).toContain('49 CFR 379 App. A');
  });

  it('accepts a longer period and applies it', async () => {
    const loadId = await makeLoad(LONG_AGO);
    await makeDocument({ kind: 'bol', loadId, finalizedAt: LONG_AGO });

    // 4000 days old, so due at the 2557-day default.
    expect(reportFor(await engine.retentionReport(scoped, NOW), 'bill_of_lading').due).toBe(1);

    const result = await engine.setRetentionDays(scoped, 'bill_of_lading', 5000, ACTOR);
    expect(result.ok).toBe(true);

    const report = reportFor(await engine.retentionReport(scoped, NOW), 'bill_of_lading');
    expect(report.due).toBe(0);
    expect(report.policy.retentionDays).toBe(5000);
    expect(report.policy.customised).toBe(true);
  });

  it('rejects a period that is not a whole number of days', async () => {
    expect((await engine.setRetentionDays(scoped, 'carrier_check', -1, ACTOR)).ok).toBe(false);
    expect((await engine.setRetentionDays(scoped, 'carrier_check', 1.5, ACTOR)).ok).toBe(false);
  });
});
