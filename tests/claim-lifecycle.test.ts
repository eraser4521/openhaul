import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { applyMigrations } from './helpers/temp-db';
import { pdfText } from './helpers/pdf-text';

/**
 * The claim workflow against a real database.
 *
 * The dates and the letter wording are covered by unit tests. What needs a
 * database is the part that spans rows: that filing puts the load's records
 * beyond the reach of retention, that each letter is frozen as a document, and
 * that the hold is not released while anything is still open.
 */

let workspace: string;
let scoped: Awaited<ReturnType<typeof import('@/lib/db/scope')['forOrg']>>;
let claims: typeof import('@/lib/claims/lifecycle');
let dbModule: typeof import('@/lib/db/client');
let schema: typeof import('@/lib/db/schema');

let loadId: string;
let vehicleId: string;
let claimId: string;

const RECEIVED = new Date('2026-09-14T12:00:00Z');

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'openhaul-claim-'));

  process.env.DATABASE_URL = `file:${path.join(workspace, 'test.db')}`;
  delete process.env.DATABASE_ENCRYPTION_KEY;
  delete process.env.DATABASE_AUTH_TOKEN;
  process.env.BLOB_STORAGE_PATH = path.join(workspace, 'uploads');

  dbModule = await import('@/lib/db/client');
  schema = await import('@/lib/db/schema');
  await dbModule.ready();

  await applyMigrations(dbModule.rawClient);

  const { asOrgId, forOrg } = await import('@/lib/db/scope');
  claims = await import('@/lib/claims/lifecycle');

  const [org] = await dbModule.db
    .insert(schema.organizations)
    .values({
      legalName: 'Ridgeline Auto Transport LLC',
      usdotNumber: '3312907',
      addressLine1: '4400 Meacham Blvd',
      city: 'Fort Worth',
      state: 'TX',
      postalCode: '76106',
    })
    .returning();

  scoped = forOrg(asOrgId(org!.id));

  const [customer] = await scoped.insert('customers', {
    name: 'Cardinal Logistics Brokerage',
    kind: 'broker',
  });

  const [load] = await scoped.insert('loads', {
    number: 'OH-5001',
    status: 'delivered',
    customerId: customer!.id,
    rateCents: 294_000,
    deliveredAt: new Date('2026-09-01T00:00:00Z'),
    retainUntil: new Date(),
  });
  loadId = load!.id;

  const [vehicle] = await scoped.insert('vehicles', {
    loadId,
    vin: '1HGCM82633A004352',
    year: 2003,
    make: 'HONDA',
    model: 'Accord',
  });
  vehicleId = vehicle!.id;
});

afterAll(async () => {
  dbModule.rawClient.close();
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
});

/** A sealed inspection with damages and photographs, as the app would leave it. */
async function sealInspection(
  stage: 'pickup' | 'delivery',
  damageCodes: string[],
  photoCount: number,
) {
  const [inspection] = await scoped.insert('inspections', {
    loadId,
    vehicleId,
    stage,
    tier: 'advanced',
    status: 'finalized',
    startedAt: new Date(),
    completedAt: new Date(),
    finalizedAt: new Date(),
    contentHash: `${stage}`.padEnd(64, '0'),
  });

  for (const code of damageCodes) {
    await scoped.insert('damages', {
      inspectionId: inspection!.id,
      code,
      areaCode: code.slice(0, 2),
      typeCode: code.slice(2, 4),
      severityCode: code.slice(4),
      codeVersion: 'aiag-m22',
      description: `Damage ${code}`,
      preExisting: stage === 'pickup',
      nonTransportation: false,
    });
  }

  for (let i = 0; i < photoCount; i += 1) {
    await scoped.insert('inspectionPhotos', {
      inspectionId: inspection!.id,
      slot: null,
      storageKey: `fixture/${stage}-${i}`,
      sha256: `${stage}${i}`.padEnd(64, '0'),
      byteSize: 1,
      contentType: 'image/jpeg',
    });
  }

  return inspection!.id;
}

describe('filing', () => {
  it('refuses a claim with nobody making it', async () => {
    const result = await claims.fileClaim(scoped, {
      loadId,
      vehicleId,
      claimantName: '   ',
      claimantEmail: null,
      demandAmountCents: 185_000,
      description: 'Damage.',
      filedAt: RECEIVED,
    });

    expect(result.ok).toBe(false);
  });

  it('refuses a claim that does not say what is claimed', async () => {
    const result = await claims.fileClaim(scoped, {
      loadId,
      vehicleId,
      claimantName: 'Cardinal Logistics Brokerage',
      claimantEmail: null,
      demandAmountCents: 185_000,
      description: '',
      filedAt: RECEIVED,
    });

    expect(result.ok).toBe(false);
  });

  it('files a claim, numbers it for the year, and sets the clocks', async () => {
    const result = await claims.fileClaim(scoped, {
      loadId,
      vehicleId,
      claimantName: 'Cardinal Logistics Brokerage',
      claimantEmail: 'claims@cardinal.test',
      demandAmountCents: 185_000,
      description: 'Deep scratch to the passenger door, not present at pickup.',
      filedAt: RECEIVED,
    });

    expect(result.ok).toBe(true);
    expect(result.number).toBe('CLM-2026-0001');
    claimId = result.claimId!;

    const claim = await scoped.selectOne('claims', eq(schema.claims.id, claimId));
    expect(claim?.status).toBe('filed');
    expect(claim?.acknowledgeDueAt.toISOString()).toBe('2026-10-14T12:00:00.000Z');
    expect(claim?.resolveDueAt.toISOString()).toBe('2027-01-12T12:00:00.000Z');
    // Not owed until the claim is still open at 120 days.
    expect(claim?.nextStatusDueAt).toBeNull();
    // Inherited from the load, so the claim knows who the counterparty is.
    expect(claim?.customerId).not.toBeNull();
  });

  it('puts the load’s records on legal hold', async () => {
    /*
     * The retention sweep does not know a claim is coming, so the hold has to
     * go on at filing rather than at disposition.
     */
    const load = await scoped.selectOne('loads', eq(schema.loads.id, loadId));
    expect(load?.legalHold).toBe(true);
  });

  it('reports a claim received inside the nine-month window as timely', async () => {
    // Delivered 1 September 2026, received 14 September 2026.
    const claim = await scoped.selectOne('claims', eq(schema.claims.id, claimId));
    expect(claim).not.toBeNull();

    const late = await claims.fileClaim(scoped, {
      loadId,
      vehicleId,
      claimantName: 'Second Claimant',
      claimantEmail: null,
      demandAmountCents: 1000,
      description: 'Filed far too late.',
      filedAt: new Date('2027-09-01T12:00:00Z'),
    });

    expect(late.ok).toBe(true);
    expect(late.lateFiled).toBe(true);

    // Recorded anyway — a late claim is a defence, not a reason to lose the paperwork.
    const stored = await scoped.selectOne('claims', eq(schema.claims.id, late.claimId!));
    expect(stored?.status).toBe('filed');

    await claims.withdrawClaim(scoped, late.claimId!, 'Fixture for the late-filing check.');
  });
});

describe('the acknowledgement', () => {
  it('writes a letter, freezes it, and records the date', async () => {
    const result = await claims.acknowledgeClaim(scoped, claimId);
    expect(result.ok).toBe(true);

    const claim = await scoped.selectOne('claims', eq(schema.claims.id, claimId));
    expect(claim?.status).toBe('acknowledged');
    expect(claim?.acknowledgedAt).not.toBeNull();
    // The 60-day obligation is scheduled from day 120 once the claim is live.
    expect(claim?.nextStatusDueAt?.toISOString()).toBe('2027-01-12T12:00:00.000Z');

    const document = await scoped.selectOne(
      'documents',
      eq(schema.documents.id, result.documentId!),
    );
    expect(document?.kind).toBe('claim_acknowledgement');
    expect(document?.subject).toBe(`claim:${claimId}`);
    expect(document?.finalizedAt).not.toBeNull();

    const bytes = await readFile(path.join(workspace, 'uploads', document!.storageKey));
    const text = await pdfText(bytes);

    expect(text).toContain('ACKNOWLEDGEMENT OF CLAIM');
    expect(text).toContain('CLM-2026-0001');
    expect(text).toContain('49 CFR 370.5');
    // The carrier's own address, which is what makes the letter usable.
    expect(text).toContain('4400 Meacham Blvd');
  });

  it('will not acknowledge the same claim twice', async () => {
    const again = await claims.acknowledgeClaim(scoped, claimId);
    expect(again.ok).toBe(false);
    expect(again.error).toContain('already been acknowledged');
  });
});

describe('status letters', () => {
  it('writes one with the reason for the delay, without discharging a duty not yet owed', async () => {
    /*
     * A status letter sent before day 120 is a courtesy, not compliance: 370.9
     * requires the update at the expiration of the period, so an early letter
     * must not move the first deadline out. Getting this wrong would quietly
     * tell a carrier it had satisfied an obligation that had not arisen.
     */
    const before = await scoped.selectOne('claims', eq(schema.claims.id, claimId));

    const result = await claims.sendStatusLetter(
      scoped,
      claimId,
      'Awaiting the repair estimate from the claimant.',
    );
    expect(result.ok).toBe(true);

    const after = await scoped.selectOne('claims', eq(schema.claims.id, claimId));
    expect(after?.status).toBe('investigating');
    expect(after?.nextStatusDueAt?.toISOString()).toBe(before!.nextStatusDueAt!.toISOString());
    expect(after?.nextStatusDueAt?.toISOString()).toBe('2027-01-12T12:00:00.000Z');

    const document = await scoped.selectOne(
      'documents',
      eq(schema.documents.id, result.documentId!),
    );
    expect(document?.kind).toBe('claim_status');

    const text = await pdfText(
      await readFile(path.join(workspace, 'uploads', document!.storageKey)),
    );
    expect(text).toContain('CLAIM STATUS UPDATE');
    expect(text).toContain('Awaiting the repair estimate');
  });
});

describe('the evidence', () => {
  it('compares the two inspections and reports what appeared in transit', async () => {
    await sealInspection('pickup', ['10123'], 6);
    await sealInspection('delivery', ['10123', '14045'], 4);

    const evidence = await claims.claimEvidence(scoped, claimId);
    expect('error' in evidence).toBe(false);
    if ('error' in evidence) return;

    expect(evidence.vehicle?.vin).toBe('1HGCM82633A004352');
    expect(evidence.originPhotos).toHaveLength(6);
    expect(evidence.destinationPhotos).toHaveLength(4);

    // 10123 was already noted at pickup; 14045 is new.
    expect(evidence.assessment.newAtDestination.map((d) => d.code)).toEqual(['14045']);
    expect(evidence.assessment.documentedAtBoth.map((d) => d.code)).toEqual(['10123']);
    expect(evidence.assessment.gaps).toEqual([]);
  });
});

describe('disposition', () => {
  it('refuses a declination with no reason', async () => {
    const result = await claims.disposeClaim(scoped, claimId, {
      disposition: 'declined',
      amountCents: null,
      reason: '   ',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('has to say why');
  });

  it('refuses a compromise offer with no figure, which is not a firm offer', async () => {
    const result = await claims.disposeClaim(scoped, claimId, {
      disposition: 'offered',
      amountCents: null,
      reason: 'Split the difference.',
    });

    expect(result.ok).toBe(false);
  });

  it('leaves the claim open after a firm offer, because the clock keeps running', async () => {
    const result = await claims.disposeClaim(scoped, claimId, {
      disposition: 'offered',
      amountCents: 90_000,
      reason: 'Half the damage was recorded at pickup.',
    });

    expect(result.ok).toBe(true);

    const claim = await scoped.selectOne('claims', eq(schema.claims.id, claimId));
    expect(claim?.status).toBe('offered');
    expect(claim?.offerAmountCents).toBe(90_000);
    // Still pending, so 370.9's 60-day obligation has not stopped.
    expect(claim?.nextStatusDueAt).not.toBeNull();

    const text = await pdfText(
      await readFile(
        path.join(
          workspace,
          'uploads',
          (await scoped.selectOne('documents', eq(schema.documents.id, result.documentId!)))!
            .storageKey,
        ),
      ),
    );
    expect(text).toContain('firm compromise settlement offer of $900.00');
  });

  it('closes the claim on a declination and stops the status letters', async () => {
    const result = await claims.disposeClaim(scoped, claimId, {
      disposition: 'declined',
      amountCents: null,
      reason: 'The damage claimed appears on the sealed pickup inspection.',
    });

    expect(result.ok).toBe(true);

    const claim = await scoped.selectOne('claims', eq(schema.claims.id, claimId));
    expect(claim?.status).toBe('declined');
    expect(claim?.declinedAt).not.toBeNull();
    expect(claim?.nextStatusDueAt).toBeNull();

    const text = await pdfText(
      await readFile(
        path.join(
          workspace,
          'uploads',
          (await scoped.selectOne('documents', eq(schema.documents.id, result.documentId!)))!
            .storageKey,
        ),
      ),
    );
    expect(text).toContain('Your claim is declined');
    expect(text).toContain('two years');
  });

  it('will not dispose of a closed claim twice', async () => {
    const again = await claims.disposeClaim(scoped, claimId, {
      disposition: 'paid',
      amountCents: 1000,
      reason: null,
    });

    expect(again.ok).toBe(false);
    expect(again.error).toContain('already been closed');
  });

  it('owes no status letter once the claim is closed', async () => {
    const result = await claims.sendStatusLetter(scoped, claimId, 'Still looking.');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('closed');
  });
});

describe('the legal hold', () => {
  it('stays on while another claim on the load is open', async () => {
    const second = await claims.fileClaim(scoped, {
      loadId,
      vehicleId,
      claimantName: 'Desert Motors Phoenix',
      claimantEmail: null,
      demandAmountCents: 40_000,
      description: 'Separate claim on the same load.',
      filedAt: RECEIVED,
    });

    const blocked = await claims.releaseHold(scoped, claimId);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain('still open');

    await claims.disposeClaim(scoped, second.claimId!, {
      disposition: 'paid',
      amountCents: 40_000,
      reason: null,
    });
  });

  it('will not release while the claim itself is open', async () => {
    const open = await claims.fileClaim(scoped, {
      loadId,
      vehicleId,
      claimantName: 'Third Claimant',
      claimantEmail: null,
      demandAmountCents: 1_000,
      description: 'Open claim.',
      filedAt: RECEIVED,
    });

    const result = await claims.releaseHold(scoped, open.claimId!);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('still open');

    await claims.withdrawClaim(scoped, open.claimId!, 'Claimant withdrew.');
  });

  it('releases once every claim on the load is closed', async () => {
    const result = await claims.releaseHold(scoped, claimId);
    expect(result.ok).toBe(true);

    const load = await scoped.selectOne('loads', eq(schema.loads.id, loadId));
    expect(load?.legalHold).toBe(false);
  });
});

describe('withdrawal', () => {
  it('needs a reason and closes the file', async () => {
    const filed = await claims.fileClaim(scoped, {
      loadId,
      vehicleId,
      claimantName: 'Fourth Claimant',
      claimantEmail: null,
      demandAmountCents: 5_000,
      description: 'To be withdrawn.',
      filedAt: RECEIVED,
    });

    const noReason = await claims.withdrawClaim(scoped, filed.claimId!, '  ');
    expect(noReason.ok).toBe(false);

    const done = await claims.withdrawClaim(
      scoped,
      filed.claimId!,
      'Claimant withdrew after seeing the pickup photographs.',
    );
    expect(done.ok).toBe(true);

    const claim = await scoped.selectOne('claims', eq(schema.claims.id, filed.claimId!));
    expect(claim?.status).toBe('withdrawn');
    expect(claim?.nextStatusDueAt).toBeNull();
  });
});
