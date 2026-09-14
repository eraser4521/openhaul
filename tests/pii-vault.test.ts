import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { applyMigrations } from './helpers/temp-db';

/**
 * Erasure, against a real database.
 *
 * The claim this feature makes is narrow and testable: destroying one stored
 * value makes one person's data unreadable, and leaves every record the
 * carrier is required to keep exactly as it was. Both halves are checked here
 * against rows on disk, because the interesting failure is the one where a
 * screen says "erased" and the data is still recoverable from the table.
 */

let workspace: string;
let scoped: Awaited<ReturnType<typeof import('@/lib/db/scope')['forOrg']>>;
let dbModule: typeof import('@/lib/db/client');
let schema: typeof import('@/lib/db/schema');
let vault: typeof import('@/lib/pii/vault');
let chain: typeof import('@/lib/audit/chain');

const ACTOR = { userId: 'user-1', role: 'owner' as const, purpose: 'test' };

const RENATA = {
  name: 'Renata Dowd',
  email: 'renata@example.test',
  phone: '(214) 555-0190',
  address: '400 Commerce St, Dallas TX 75201',
  dob: '1984-03-11',
  cdlNumber: 'D1234567',
};

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'openhaul-pii-'));
  process.env.DATABASE_URL = `file:${path.join(workspace, 'test.db')}`;
  delete process.env.DATABASE_ENCRYPTION_KEY;
  process.env.BLOB_STORAGE_PATH = path.join(workspace, 'uploads');
  process.env.OPENHAUL_KEYS = `v1:${Buffer.alloc(32, 9).toString('base64')}`;
  process.env.OPENHAUL_INDEX_KEY_VERSION = '1';

  dbModule = await import('@/lib/db/client');
  schema = await import('@/lib/db/schema');
  await dbModule.ready();
  await applyMigrations(dbModule.rawClient);

  const { asOrgId, forOrg } = await import('@/lib/db/scope');
  vault = await import('@/lib/pii/vault');
  chain = await import('@/lib/audit/chain');

  const [org] = await dbModule.db
    .insert(schema.organizations)
    .values({ legalName: 'Ridgeline Auto Transport LLC' })
    .returning();
  scoped = forOrg(asOrgId(org!.id));
});

afterAll(async () => {
  dbModule.rawClient.close();
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
});

describe('holding personal data', () => {
  it('round-trips everything it was given', async () => {
    const subjectId = await vault.createSubject(scoped, RENATA);
    const read = await vault.readSubject(scoped, subjectId, ACTOR);

    expect(read.status).toBe('live');
    if (read.status !== 'live') return;
    expect(read.data).toEqual(RENATA);
  });

  it('stores nothing readable in the table', async () => {
    /*
     * The test that matters for the claim. Every value goes in, and none of
     * it appears anywhere in the row as written.
     */
    const subjectId = await vault.createSubject(scoped, RENATA);
    const row = await scoped.selectOne('piiVault', eq(schema.piiVault.subjectId, subjectId));

    const serialised = JSON.stringify(row);
    for (const value of Object.values(RENATA)) {
      expect(serialised).not.toContain(value);
    }
    expect(row?.cdlNumberEncrypted).toBeTruthy();
  });

  it('records every decrypt on the audit chain, without the values', async () => {
    const subjectId = await vault.createSubject(scoped, RENATA);
    const before = (await chain.chainHead()).seq;

    await vault.readSubject(scoped, subjectId, { ...ACTOR, purpose: 'driver record' });

    const after = await chain.chainHead();
    expect(after.seq).toBeGreaterThan(before);

    const entries = await dbModule.db.select().from(schema.auditLog);
    const entry = entries.find((row) => row.subject === `subject:${subjectId}`);
    expect(entry?.action).toBe('pii.decrypted');

    // The audit log is a record that a read happened, never a second copy of
    // what was read.
    const detail = JSON.stringify(entry?.detail);
    expect(detail).toContain('driver record');
    expect(detail).not.toContain(RENATA.cdlNumber);
    expect(detail).not.toContain(RENATA.dob);
  });

  it('leaves a field alone when it is not mentioned, and clears it when it is null', async () => {
    const subjectId = await vault.createSubject(scoped, RENATA);

    await vault.updateSubject(scoped, subjectId, { phone: '(817) 555-0142' });
    let read = await vault.readSubject(scoped, subjectId, ACTOR);
    expect(read.status === 'live' && read.data.phone).toBe('(817) 555-0142');
    expect(read.status === 'live' && read.data.email).toBe(RENATA.email);

    await vault.updateSubject(scoped, subjectId, { email: null });
    read = await vault.readSubject(scoped, subjectId, ACTOR);
    expect(read.status === 'live' && read.data.email).toBeNull();
    expect(read.status === 'live' && read.data.name).toBe(RENATA.name);
  });

  it('finds a person by licence number, however it is punctuated', async () => {
    const subjectId = await vault.createSubject(scoped, { ...RENATA, cdlNumber: 'X-999 8887' });

    expect(await vault.findSubjectByCdl(scoped, 'x9998887', ACTOR)).toContain(subjectId);
    expect(await vault.findSubjectByCdl(scoped, 'X-999-8887', ACTOR)).toContain(subjectId);
    expect(await vault.findSubjectByCdl(scoped, 'NOTALICENCE', ACTOR)).not.toContain(subjectId);
  });

  it('reports a subject nobody ever created as missing', async () => {
    const read = await vault.readSubject(scoped, 'no-such-subject', ACTOR);
    expect(read.status).toBe('missing');
  });
});

describe('erasing a person', () => {
  it('makes the data unreadable while leaving the ciphertext in place', async () => {
    const subjectId = await vault.createSubject(scoped, RENATA);

    const before = await scoped.selectOne('piiVault', eq(schema.piiVault.subjectId, subjectId));
    expect(before?.cdlNumberEncrypted).toBeTruthy();

    const erased = await vault.eraseSubject(scoped, subjectId, 'Erasure request', ACTOR);
    expect(erased.ok).toBe(true);

    const read = await vault.readSubject(scoped, subjectId, ACTOR);
    expect(read.status).toBe('erased');

    /*
     * The ciphertext is deliberately still there. Overwriting it would leave
     * the old bytes in free pages and the WAL anyway, and the row's survival
     * is what proves nothing was quietly rewritten — the key is gone, which is
     * what makes it unreadable.
     */
    const after = await scoped.selectOne('piiVault', eq(schema.piiVault.subjectId, subjectId));
    expect(after?.cdlNumberEncrypted).toBe(before?.cdlNumberEncrypted);
    expect(after?.redactedAt).toBeTruthy();
  });

  it('destroys the key rather than deleting the tombstone', async () => {
    const subjectId = await vault.createSubject(scoped, RENATA);
    await vault.eraseSubject(scoped, subjectId, 'Erasure request', ACTOR);

    const key = await scoped.selectOne('subjectKeys', eq(schema.subjectKeys.subjectId, subjectId));

    // The row survives so it can prove a key existed and when it was
    // destroyed. It just no longer holds one.
    expect(key).not.toBeNull();
    expect(key?.wrappedDek).toBe('destroyed');
    expect(key?.destroyedAt).toBeTruthy();
    expect(key?.destroyedReason).toBe('Erasure request');
  });

  it('clears the blind index, so a guessed licence cannot be confirmed', async () => {
    /*
     * The index is an HMAC rather than the number, but it outlives the key.
     * Left in place, anyone who could read the table could test a guess
     * against it long after the data it points at became unreadable.
     */
    const subjectId = await vault.createSubject(scoped, RENATA);
    const before = await scoped.selectOne('piiVault', eq(schema.piiVault.subjectId, subjectId));
    expect(before?.cdlBlindIndex).toBeTruthy();

    await vault.eraseSubject(scoped, subjectId, 'Erasure request', ACTOR);

    const after = await scoped.selectOne('piiVault', eq(schema.piiVault.subjectId, subjectId));
    expect(after?.cdlBlindIndex).toBeNull();
    expect(await vault.findSubjectByCdl(scoped, RENATA.cdlNumber, ACTOR)).not.toContain(subjectId);
  });

  it('refuses to write to an erased person', async () => {
    // Sealing new data under a fresh key would resurrect a record somebody
    // asked to have destroyed, under the same id, tombstone and all.
    const subjectId = await vault.createSubject(scoped, RENATA);
    await vault.eraseSubject(scoped, subjectId, 'Erasure request', ACTOR);

    const result = await vault.updateSubject(scoped, subjectId, { phone: '(214) 555-0000' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('erased');
  });

  it('is idempotent and does not move the date of the first erasure', async () => {
    const subjectId = await vault.createSubject(scoped, RENATA);
    await vault.eraseSubject(scoped, subjectId, 'First request', ACTOR);

    const first = await scoped.selectOne('subjectKeys', eq(schema.subjectKeys.subjectId, subjectId));

    const second = await vault.eraseSubject(scoped, subjectId, 'Second request', ACTOR);
    expect(second.ok).toBe(true);

    const after = await scoped.selectOne('subjectKeys', eq(schema.subjectKeys.subjectId, subjectId));
    expect(after?.destroyedAt?.getTime()).toBe(first?.destroyedAt?.getTime());
    expect(after?.destroyedReason).toBe('First request');
  });

  it('puts the erasure on the audit chain', async () => {
    const subjectId = await vault.createSubject(scoped, RENATA);
    await vault.eraseSubject(scoped, subjectId, 'Erasure request', ACTOR);

    const entries = await dbModule.db.select().from(schema.auditLog);
    const entry = entries.find(
      (row) => row.subject === `subject:${subjectId}` && row.action === 'pii.erased',
    );
    expect(entry).toBeTruthy();
  });

  it('leaves the audit chain intact', async () => {
    /*
     * The other half of the claim. An erasure that broke the hash chain would
     * destroy the carrier's ability to show their records were not tampered
     * with — which is a worse outcome than the one erasure was solving.
     */
    const subjectId = await vault.createSubject(scoped, RENATA);
    await vault.eraseSubject(scoped, subjectId, 'Erasure request', ACTOR);

    const verdict = await chain.verifyChain();
    expect(verdict.ok).toBe(true);
  });

  it('reports status without decrypting, so a screen need not read to know', async () => {
    const subjectId = await vault.createSubject(scoped, RENATA);
    expect((await vault.subjectStatus(scoped, subjectId)).status).toBe('live');

    const before = (await chain.chainHead()).seq;
    await vault.eraseSubject(scoped, subjectId, 'Erasure request', ACTOR);

    expect((await vault.subjectStatus(scoped, subjectId)).status).toBe('erased');
    expect((await vault.subjectStatus(scoped, 'no-such-subject')).status).toBe('missing');

    // One entry for the erasure, and none for the two status checks.
    expect((await chain.chainHead()).seq).toBe(before + 1);
  });
});

describe('tenant isolation', () => {
  it('will not read another organisation’s subject', async () => {
    const { asOrgId, forOrg } = await import('@/lib/db/scope');

    const [other] = await dbModule.db
      .insert(schema.organizations)
      .values({ legalName: 'Someone Else Transport LLC' })
      .returning();
    const otherScope = forOrg(asOrgId(other!.id));

    const subjectId = await vault.createSubject(scoped, RENATA);

    // The scoped client cannot see the row at all, so this is "missing"
    // rather than a decryption failure — the isolation holds before the
    // cryptography is even reached.
    expect((await vault.readSubject(otherScope, subjectId, ACTOR)).status).toBe('missing');
    expect((await vault.subjectStatus(otherScope, subjectId)).status).toBe('missing');
  });
});

describe('what the form is allowed to send', () => {
  it('accepts a record with fields left blank', async () => {
    /*
     * The bug this guards: an empty date of birth was posted as "" rather than
     * nothing, and the format check rejected it. Nobody hits that in a
     * walkthrough where every field gets filled in.
     */
    const { personalDataSchema } = await import('@/lib/pii/validate');

    const parsed = personalDataSchema.safeParse({
      name: 'Marcus Alan Webb',
      email: '',
      phone: '',
      address: '',
      dob: '',
      cdlNumber: 'TX-88213947',
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.dob).toBeNull();
    expect(parsed.data.email).toBeNull();
    expect(parsed.data.name).toBe('Marcus Alan Webb');
  });

  it('still rejects a date of birth that is not a date', async () => {
    const { personalDataSchema } = await import('@/lib/pii/validate');

    const parsed = personalDataSchema.safeParse({ dob: '11/03/1984' });
    expect(parsed.success).toBe(false);
  });

  it('treats a field of only spaces as blank', async () => {
    const { personalDataSchema } = await import('@/lib/pii/validate');

    const parsed = personalDataSchema.safeParse({ name: '   ' });
    expect(parsed.success && parsed.data.name).toBeNull();
  });
});
