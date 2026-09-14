import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { applyMigrations } from './helpers/temp-db';

/**
 * Certificates against a real database.
 *
 * Two behaviours need one. A carrier's own cover and a customer's are kept in
 * the same table and separated only by a null, so the split has to be checked
 * rather than assumed. And editing the figures has to drop an earlier
 * verification, because a tick that survives a changed limit is a record of a
 * check nobody performed.
 */

const DAY = 86_400_000;
const NOW = new Date('2026-09-14T12:00:00Z');
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

let workspace: string;
let scoped: Awaited<ReturnType<typeof import('@/lib/db/scope')['forOrg']>>;
let dbModule: typeof import('@/lib/db/client');
let schema: typeof import('@/lib/db/schema');
let certificates: typeof import('@/lib/insurance/certificates');

let ACTOR: { userId: string; role: string };
let customerId: string;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'openhaul-insurance-'));
  process.env.DATABASE_URL = `file:${path.join(workspace, 'test.db')}`;
  delete process.env.DATABASE_ENCRYPTION_KEY;
  process.env.BLOB_STORAGE_PATH = path.join(workspace, 'uploads');

  dbModule = await import('@/lib/db/client');
  schema = await import('@/lib/db/schema');
  await dbModule.ready();
  await applyMigrations(dbModule.rawClient);

  const { asOrgId, forOrg } = await import('@/lib/db/scope');
  certificates = await import('@/lib/insurance/certificates');

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

  const [customer] = await scoped.insert('customers', { name: 'Cardinal Logistics LLC' });
  customerId = customer!.id;
});

afterAll(async () => {
  dbModule.rawClient.close();
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  for (const row of await scoped.select('insuranceCertificates')) {
    await scoped.remove('insuranceCertificates', eq(schema.insuranceCertificates.id, row.id));
  }
});

function cargo(overrides: Partial<import('@/lib/insurance/certificates').CertificateInput> = {}) {
  return {
    customerId: null,
    kind: 'cargo' as const,
    insurerName: 'Great West Casualty',
    policyNumber: 'CG-4471902',
    coverageLimitCents: 10_000_000,
    deductibleCents: 250_000,
    effectiveAt: at(-300),
    expiresAt: at(60),
    ...overrides,
  };
}

describe('keeping certificates', () => {
  it('separates the carrier’s own cover from a customer’s', async () => {
    await certificates.saveCertificate(scoped, cargo(), ACTOR);
    await certificates.saveCertificate(scoped, cargo({ customerId, policyNumber: 'THEIRS' }), ACTOR);

    const own = await certificates.listCertificates(scoped, null);
    const theirs = await certificates.listCertificates(scoped, customerId);

    expect(own).toHaveLength(1);
    expect(own[0]?.policyNumber).toBe('CG-4471902');
    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.policyNumber).toBe('THEIRS');
  });

  it('lists the one expiring soonest first', async () => {
    await certificates.saveCertificate(scoped, cargo({ expiresAt: at(200), policyNumber: 'LATER' }), ACTOR);
    await certificates.saveCertificate(scoped, cargo({ expiresAt: at(20), policyNumber: 'SOONER' }), ACTOR);

    const rows = await certificates.listCertificates(scoped, null);
    expect(rows.map((row) => row.policyNumber)).toEqual(['SOONER', 'LATER']);
  });

  it('refuses an expiry that comes before the effective date', async () => {
    const result = await certificates.saveCertificate(
      scoped,
      cargo({ effectiveAt: at(10), expiresAt: at(5) }),
      ACTOR,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('after the effective date');
  });

  it('accepts a policy that has already expired, for reconstructing a file', async () => {
    // Not a typo: a carrier catching up on their records needs to say what was
    // in force last year.
    const result = await certificates.saveCertificate(
      scoped,
      cargo({ effectiveAt: at(-800), expiresAt: at(-400) }),
      ACTOR,
    );

    expect(result.ok).toBe(true);
  });
});

describe('verifying one', () => {
  it('records who looked and when', async () => {
    const saved = await certificates.saveCertificate(scoped, cargo(), ACTOR);
    await certificates.verifyCertificate(scoped, saved.certificateId!, ACTOR);

    const row = await scoped.selectOne(
      'insuranceCertificates',
      eq(schema.insuranceCertificates.id, saved.certificateId!),
    );

    expect(row?.verifiedAt).toBeTruthy();
    expect(row?.verifiedByUserId).toBe(ACTOR.userId);

    const entries = await dbModule.db.select().from(schema.auditLog);
    expect(entries.some((entry) => entry.action === 'insurance.verified')).toBe(true);
  });

  it('drops the verification when the figures change', async () => {
    /*
     * Somebody checked the certificate against the numbers that were on screen
     * then. Leaving the tick in place would let a raised limit inherit a check
     * nobody performed on it.
     */
    const saved = await certificates.saveCertificate(scoped, cargo(), ACTOR);
    await certificates.verifyCertificate(scoped, saved.certificateId!, ACTOR);

    await certificates.saveCertificate(
      scoped,
      cargo({ coverageLimitCents: 25_000_000 }),
      ACTOR,
      saved.certificateId,
    );

    const row = await scoped.selectOne(
      'insuranceCertificates',
      eq(schema.insuranceCertificates.id, saved.certificateId!),
    );

    expect(row?.coverageLimitCents).toBe(25_000_000);
    expect(row?.verifiedAt).toBeNull();
    expect(row?.verifiedByUserId).toBeNull();
  });
});

describe('what is lapsing', () => {
  it('lists the expired alongside the expiring, soonest first', async () => {
    // A lapse nobody noticed is worse than one about to happen, so dropping it
    // off the list the day it happens is how it stays unnoticed.
    await certificates.saveCertificate(scoped, cargo({ expiresAt: at(400), policyNumber: 'FINE' }), ACTOR);
    await certificates.saveCertificate(scoped, cargo({ expiresAt: at(10), policyNumber: 'SOON' }), ACTOR);
    await certificates.saveCertificate(
      scoped,
      cargo({ effectiveAt: at(-700), expiresAt: at(-30), policyNumber: 'GONE' }),
      ACTOR,
    );

    const lapsing = await certificates.expiringCertificates(scoped, NOW);

    expect(lapsing.map((entry) => entry.state)).toEqual(['expired', 'expiring']);
    expect(lapsing.map((entry) => entry.insurerName)).toHaveLength(2);
  });
});

describe('cover against a load', () => {
  async function loadWith(values: Array<number | null>): Promise<string> {
    const [load] = await scoped.insert('loads', {
      number: `OH-${Math.floor(Math.random() * 100_000)}`,
      status: 'dispatched',
    });

    for (const declaredValueCents of values) {
      await scoped.insert('vehicles', {
        loadId: load!.id,
        vin: `1HGCM82633A${Math.floor(Math.random() * 1_000_000)}`,
        declaredValueCents,
      });
    }

    return load!.id;
  }

  it('reports the shortfall against the policy actually in force', async () => {
    await certificates.saveCertificate(scoped, cargo(), ACTOR);
    const loadId = await loadWith([5_000_000, 5_000_000, 5_000_000]);

    const coverage = await certificates.loadCoverage(scoped, loadId, NOW);

    expect(coverage.status).toBe('short');
    expect(coverage.exposureCents).toBe(15_000_000);
    expect(coverage.shortfallCents).toBe(5_000_000);
    expect(coverage.policyNumber).toBe('CG-4471902');
  });

  it('ignores a lapsed policy when working out cover', async () => {
    // The dangerous version of this bug is reading an expired certificate as
    // cover, which would report a load as insured on the day it is not.
    await certificates.saveCertificate(
      scoped,
      cargo({ effectiveAt: at(-700), expiresAt: at(-1) }),
      ACTOR,
    );
    const loadId = await loadWith([2_000_000]);

    const coverage = await certificates.loadCoverage(scoped, loadId, NOW);

    expect(coverage.status).toBe('no_cover');
    expect(coverage.policyNumber).toBeNull();
  });

  it('will not call a load covered while a vehicle is unvalued', async () => {
    await certificates.saveCertificate(scoped, cargo(), ACTOR);
    const loadId = await loadWith([2_000_000, null]);

    const coverage = await certificates.loadCoverage(scoped, loadId, NOW);

    expect(coverage.status).toBe('unknown');
    expect(coverage.undeclared).toBe(1);
  });

  it('does not treat a customer’s certificate as the carrier’s own cover', async () => {
    // The null customerId is the only thing separating them, so this is the
    // mistake worth a test.
    await certificates.saveCertificate(scoped, cargo({ customerId }), ACTOR);
    const loadId = await loadWith([2_000_000]);

    const coverage = await certificates.loadCoverage(scoped, loadId, NOW);
    expect(coverage.status).toBe('no_cover');
  });
});
