import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  citableBreach,
  currentPromise,
  holdsChasing,
  outcomeOf,
  promiseProblems,
  supersederOf,
  type PromiseRecord,
} from '@/lib/invoices/promise';
import { DEFAULT_LADDER, DEFAULT_RULE } from '@/lib/invoices/dunning';
import { renderDunningNotice } from '@/lib/documents/dunning-notice';
import { pdfText } from './helpers/pdf-text';
import { applyMigrations } from './helpers/temp-db';

/**
 * What a customer said they would do.
 *
 * The risk here is the opposite of the dunning ladder's. There the danger was
 * chasing somebody who should have been left alone; here it is telling
 * somebody they broke their word when they did not — a payment that landed a
 * day late, a cheque still in the post, a second conversation that replaced
 * the first. That accusation is worse than any reminder, so the grace period,
 * the partly-kept state and superseding all exist to avoid making it.
 */

const NOW = new Date('2026-09-14T12:00:00Z');

function promise(over: Partial<PromiseRecord> = {}): PromiseRecord {
  return {
    id: 'p1',
    invoiceId: 'inv-1',
    amountCents: 187_500,
    promisedFor: new Date('2026-09-05T12:00:00Z'),
    madeAt: new Date('2026-09-01T12:00:00Z'),
    contactName: 'Renata Dowd',
    channel: 'phone',
    notes: null,
    cancelledAt: null,
    cancelReason: null,
    ...over,
  };
}

const paid = (amountCents: number, on: string) => ({
  amountCents,
  receivedAt: new Date(on),
});

/* -------------------------------------------------------------------------
 * How it turned out
 * ---------------------------------------------------------------------- */

describe('the outcome', () => {
  it('is kept when the money arrived', () => {
    const outcome = outcomeOf(promise(), [paid(187_500, '2026-09-04T12:00:00Z')], {
      graceDays: 3,
      now: NOW,
    });

    expect(outcome).toMatchObject({ state: 'kept', receivedCents: 187_500, shortfallCents: 0 });
    expect(holdsChasing(outcome)).toBe(true);
  });

  it('counts only money that arrived after they said it', () => {
    /*
     * A payment already on the invoice when they rang was not what they were
     * promising. Counting it would mark a promise kept that nobody kept.
     */
    const outcome = outcomeOf(promise(), [paid(187_500, '2026-08-20T12:00:00Z')], {
      graceDays: 3,
      now: NOW,
    });

    expect(outcome).toMatchObject({ state: 'broken', receivedCents: 0 });
  });

  it('waits out the grace before calling anything broken', () => {
    /*
     * A cheque posted on the day it was promised takes most of a week.
     * Chasing on the morning after is both petty and usually wrong.
     */
    const justAfter = new Date('2026-09-06T12:00:00Z');
    const outcome = outcomeOf(promise(), [], { graceDays: 3, now: justAfter });

    expect(outcome.state).toBe('open');
    expect(holdsChasing(outcome)).toBe(true);

    const afterGrace = new Date('2026-09-09T12:00:00Z');
    expect(outcomeOf(promise(), [], { graceDays: 3, now: afterGrace }).state).toBe('broken');
  });

  it('is kept when the money arrives late but within grace', () => {
    const outcome = outcomeOf(promise(), [paid(187_500, '2026-09-07T12:00:00Z')], {
      graceDays: 3,
      now: NOW,
    });

    expect(outcome.state).toBe('kept');
  });

  it('separates a part payment from silence', () => {
    const outcome = outcomeOf(promise(), [paid(50_000, '2026-09-03T12:00:00Z')], {
      graceDays: 3,
      now: NOW,
    });

    expect(outcome).toMatchObject({
      state: 'partly_kept',
      receivedCents: 50_000,
      shortfallCents: 137_500,
    });

    // Both resume chasing; what changes is what the letter can honestly say.
    expect(holdsChasing(outcome)).toBe(false);
  });

  it('treats a withdrawn promise as withdrawn, not broken', () => {
    const outcome = outcomeOf(
      promise({ cancelledAt: new Date('2026-09-03T12:00:00Z'), cancelReason: 'Cannot pay yet' }),
      [],
      { graceDays: 3, now: NOW },
    );

    expect(outcome.state).toBe('cancelled');
    expect(holdsChasing(outcome)).toBe(false);
  });

  it('lets money settle a promise that a later one replaced', () => {
    // Somebody who rang twice and then paid has kept their word, and no
    // reading of the file should say otherwise.
    const later = promise({ id: 'p2', madeAt: new Date('2026-09-10T12:00:00Z') });

    const outcome = outcomeOf(promise(), [paid(187_500, '2026-09-02T12:00:00Z')], {
      graceDays: 3,
      supersededBy: later,
      now: NOW,
    });

    expect(outcome.state).toBe('kept');
  });

  it('marks the earlier one superseded rather than broken', () => {
    const later = promise({ id: 'p2', madeAt: new Date('2026-09-10T12:00:00Z') });

    const outcome = outcomeOf(promise(), [], {
      graceDays: 3,
      supersededBy: later,
      now: NOW,
    });

    expect(outcome.state).toBe('superseded');
    expect(holdsChasing(outcome)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * Which one counts
 * ---------------------------------------------------------------------- */

describe('picking the one that matters', () => {
  const first = promise({ id: 'p1', madeAt: new Date('2026-09-01T12:00:00Z') });
  const second = promise({ id: 'p2', madeAt: new Date('2026-09-10T12:00:00Z') });

  it('is the most recent that was not withdrawn', () => {
    expect(currentPromise([first, second])?.id).toBe('p2');

    const withdrawn = { ...second, cancelledAt: new Date('2026-09-11T12:00:00Z') };
    expect(currentPromise([first, withdrawn])?.id).toBe('p1');

    expect(currentPromise([])).toBeNull();
  });

  it('knows which promise replaced which', () => {
    expect(supersederOf(first, [first, second])?.id).toBe('p2');
    expect(supersederOf(second, [first, second])).toBeNull();
  });
});

/* -------------------------------------------------------------------------
 * Saying it in a letter
 * ---------------------------------------------------------------------- */

describe('citing a broken promise', () => {
  it('names what was said and what arrived', () => {
    const breach = citableBreach(
      [promise()],
      [paid(50_000, '2026-09-03T12:00:00Z')],
      { graceDays: 3, now: NOW },
    );

    expect(breach).toMatchObject({ amountCents: 187_500, receivedCents: 50_000 });
  });

  it('cites nothing when the promise was kept, open or withdrawn', () => {
    const grace = { graceDays: 3, now: NOW };

    expect(citableBreach([promise()], [paid(187_500, '2026-09-02T12:00:00Z')], grace)).toBeNull();
    expect(
      citableBreach(
        [promise({ promisedFor: new Date('2026-09-30T12:00:00Z') })],
        [],
        grace,
      ),
    ).toBeNull();
    expect(
      citableBreach([promise({ cancelledAt: new Date('2026-09-03T12:00:00Z') })], [], grace),
    ).toBeNull();
  });

  it('cites the most recent breach, not the oldest', () => {
    const older = promise({
      id: 'p1',
      madeAt: new Date('2026-08-01T12:00:00Z'),
      promisedFor: new Date('2026-08-05T12:00:00Z'),
      amountCents: 100_000,
    });
    const newer = promise({
      id: 'p2',
      madeAt: new Date('2026-09-01T12:00:00Z'),
      promisedFor: new Date('2026-09-05T12:00:00Z'),
      amountCents: 187_500,
    });

    expect(citableBreach([older, newer], [], { graceDays: 3, now: NOW })?.amountCents).toBe(
      187_500,
    );
  });

  it('prints as a fact on the notice, not as a reproach', async () => {
    const bytes = await renderDunningNotice({
      stageLabel: 'Second reminder',
      stageSequence: 2,
      stageCount: 3,
      issuedAt: NOW,
      carrier: { name: 'Ridgeline Auto Transport LLC' },
      billTo: { name: 'Cardinal Logistics Brokerage' },
      message: DEFAULT_LADDER[1]!.message,
      invoiceNumber: 'INV-OH-1001',
      invoiceIssuedAt: new Date('2026-07-01T12:00:00Z'),
      dueAt: new Date('2026-08-01T12:00:00Z'),
      daysPastDue: 44,
      totalCents: 187_500,
      paidCents: 50_000,
      creditedCents: 0,
      balanceCents: 137_500,
      currency: 'USD',
      promise: {
        madeAt: new Date('2026-09-01T12:00:00Z'),
        promisedFor: new Date('2026-09-05T12:00:00Z'),
        amountCents: 187_500,
        receivedCents: 50_000,
      },
    });

    const text = await pdfText(bytes);

    expect(text).toContain('WHAT YOU TOLD US');
    expect(text).toContain('On Sep 1, 2026 you said $1,875.00 would be paid on Sep 5, 2026');
    expect(text).toContain('$500.00 has arrived since');
    /*
     * Stated, not editorialised. Word boundaries matter: "broke" lives inside
     * "Brokerage", and an assertion that catches the customer's own name
     * would fail on every document that named them.
     */
    expect(text).not.toMatch(/(failed|broke|reneged|despite|promised faithfully)/i);
  });

  it('says plainly when nothing arrived', async () => {
    const text = await pdfText(
      await renderDunningNotice({
        stageLabel: 'Second reminder',
        stageSequence: 2,
        stageCount: 3,
        issuedAt: NOW,
        carrier: { name: 'Ridgeline Auto Transport LLC' },
        billTo: { name: 'Cardinal Logistics Brokerage' },
        message: DEFAULT_LADDER[1]!.message,
        invoiceNumber: 'INV-OH-1001',
        invoiceIssuedAt: null,
        dueAt: new Date('2026-08-01T12:00:00Z'),
        daysPastDue: 44,
        totalCents: 187_500,
        paidCents: 0,
        creditedCents: 0,
        balanceCents: 187_500,
        currency: 'USD',
        promise: {
          madeAt: new Date('2026-09-01T12:00:00Z'),
          promisedFor: new Date('2026-09-05T12:00:00Z'),
          amountCents: 187_500,
          receivedCents: 0,
        },
      }),
    );

    expect(text).toContain('Nothing has arrived since');
  });
});

describe('what cannot be promised', () => {
  const madeAt = new Date('2026-09-01T12:00:00Z');

  it('refuses more than the invoice owes', () => {
    const problems = promiseProblems(
      { amountCents: 300_000, promisedFor: new Date('2026-09-05T12:00:00Z'), madeAt },
      187_500,
    );

    expect(problems.join(' ')).toContain('more than the invoice owes');
  });

  it('refuses nothing, and a date already gone', () => {
    expect(
      promiseProblems(
        { amountCents: 0, promisedFor: new Date('2026-09-05T12:00:00Z'), madeAt },
        187_500,
      ).join(' '),
    ).toContain('needs an amount');

    expect(
      promiseProblems(
        { amountCents: 100_000, promisedFor: new Date('2026-08-01T12:00:00Z'), madeAt },
        187_500,
      ).join(' '),
    ).toContain('already passed');
  });

  it('accepts today, and the full balance', () => {
    expect(
      promiseProblems({ amountCents: 187_500, promisedFor: madeAt, madeAt }, 187_500),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * Against a real database
 * ---------------------------------------------------------------------- */

let workspace: string;
let scoped: Awaited<ReturnType<(typeof import('@/lib/db/scope'))['forOrg']>>;
let dbModule: typeof import('@/lib/db/client');
let schema: typeof import('@/lib/db/schema');
let promises: typeof import('@/lib/invoices/promise-record');
let dunning: typeof import('@/lib/invoices/dunning-run');
let chain: typeof import('@/lib/audit/chain');
let transport: typeof import('@/lib/email/transport');

let customerId: string;
let invoiceId: string;

const rule = { ...DEFAULT_RULE, enabled: true };

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'openhaul-promise-'));
  process.env.DATABASE_URL = `file:${path.join(workspace, 'test.db')}`;
  delete process.env.DATABASE_ENCRYPTION_KEY;
  process.env.BLOB_STORAGE_PATH = path.join(workspace, 'uploads');

  dbModule = await import('@/lib/db/client');
  schema = await import('@/lib/db/schema');
  await dbModule.ready();
  await applyMigrations(dbModule.rawClient);

  const { asOrgId, forOrg } = await import('@/lib/db/scope');
  promises = await import('@/lib/invoices/promise-record');
  dunning = await import('@/lib/invoices/dunning-run');
  chain = await import('@/lib/audit/chain');
  transport = await import('@/lib/email/transport');

  const [org] = await dbModule.db
    .insert(schema.organizations)
    .values({ legalName: 'Ridgeline Auto Transport LLC' })
    .returning();
  scoped = forOrg(asOrgId(org!.id));
});

afterAll(async () => {
  vi.restoreAllMocks();
  dbModule.rawClient.close();
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  vi.restoreAllMocks();

  for (const table of [
    'promisesToPay',
    'dunningNotices',
    'dunningRuns',
    'dunningStages',
    'dunningSettings',
    'documentSends',
    'documents',
    'payments',
    'invoices',
    'customers',
  ] as const) {
    for (const row of await scoped.select(table)) {
      const column = (schema[table] as unknown as { id: Parameters<typeof eq>[0] }).id;
      await scoped.remove(table, eq(column, row.id));
    }
  }

  const [customer] = await scoped.insert('customers', {
    name: 'Cardinal Logistics Brokerage',
    kind: 'broker',
    email: 'ap@cardinal.test',
  });
  customerId = customer!.id;

  const [invoice] = await scoped.insert('invoices', {
    number: 'INV-LATE',
    customerId,
    status: 'sent',
    lineHaulCents: 187_500,
    totalCents: 187_500,
    issuedAt: new Date('2026-07-01T12:00:00Z'),
    dueAt: new Date('2026-08-01T12:00:00Z'),
  });
  invoiceId = invoice!.id;

  await dunning.saveDunning(scoped, rule, DEFAULT_LADDER);
});

function mailWorks() {
  vi.spyOn(transport, 'mailConfigured').mockReturnValue(true);
  vi.spyOn(transport, 'send').mockResolvedValue({
    ok: true,
    messageId: '<test@ridgeline>',
    accepted: ['ap@cardinal.test'],
    rejected: [],
  });
}

describe('recording one', () => {
  it('holds the ladder until the promised day has come and gone', async () => {
    mailWorks();

    const promised = await promises.recordPromise(scoped, invoiceId, {
      amountCents: 187_500,
      promisedFor: new Date('2026-09-18T12:00:00Z'),
      madeAt: NOW,
      contactName: 'Renata Dowd',
      channel: 'phone',
      notes: 'Said the run goes out on the 18th',
    });
    expect(promised.ok).toBe(true);

    const swept = await dunning.runDunning(scoped, { trigger: 'schedule', now: NOW });
    expect(swept.sent).toBe(0);
    expect(swept.notices?.[0]?.detail).toBe('promised');

    // Past the promised day and its grace, chasing resumes.
    const later = new Date('2026-09-25T12:00:00Z');
    const after = await dunning.runDunning(scoped, { trigger: 'schedule', now: later });
    expect(after.sent).toBe(1);
  });

  it('refuses one for more than the invoice owes', async () => {
    const result = await promises.recordPromise(scoped, invoiceId, {
      amountCents: 500_000,
      promisedFor: new Date('2026-09-20T12:00:00Z'),
      madeAt: NOW,
      contactName: null,
      channel: 'phone',
      notes: null,
    });

    expect(result.ok).toBe(false);
    expect(result.problems?.join(' ')).toContain('more than the invoice owes');
    expect(await scoped.select('promisesToPay')).toHaveLength(0);
  });

  it('resolves itself when the money turns up', async () => {
    await promises.recordPromise(scoped, invoiceId, {
      amountCents: 187_500,
      promisedFor: new Date('2026-09-18T12:00:00Z'),
      madeAt: NOW,
      contactName: null,
      channel: 'phone',
      notes: null,
    });

    await scoped.insert('payments', {
      invoiceId,
      amountCents: 187_500,
      method: 'ach',
      receivedAt: new Date('2026-09-17T12:00:00Z'),
    });

    const [view] = await promises.promisesFor(scoped, invoiceId, new Date('2026-09-25T12:00:00Z'));
    expect(view?.outcome.state).toBe('kept');
  });
});

describe('when it is not kept', () => {
  it('puts what they said into the next notice', async () => {
    mailWorks();

    await promises.recordPromise(scoped, invoiceId, {
      amountCents: 187_500,
      promisedFor: new Date('2026-09-05T12:00:00Z'),
      madeAt: new Date('2026-09-01T12:00:00Z'),
      contactName: 'Renata Dowd',
      channel: 'phone',
      notes: null,
    });

    const result = await dunning.runDunning(scoped, { trigger: 'schedule', now: NOW });
    expect(result.sent).toBe(1);

    const [document] = await scoped.select('documents');
    const bytes = await (await import('@/lib/storage/blob-store'))
      .blobStore()
      .get(document!.storageKey);

    const text = await pdfText(bytes!);
    expect(text).toContain('WHAT YOU TOLD US');
    expect(text).toContain('$1,875.00 would be paid on Sep 5, 2026');
  });

  it('does not accuse somebody who was replaced by a later promise', async () => {
    mailWorks();

    await promises.recordPromise(scoped, invoiceId, {
      amountCents: 187_500,
      promisedFor: new Date('2026-09-05T12:00:00Z'),
      madeAt: new Date('2026-09-01T12:00:00Z'),
      contactName: null,
      channel: 'phone',
      notes: null,
    });

    // They rang again with a new date before the first fell due.
    await promises.recordPromise(scoped, invoiceId, {
      amountCents: 187_500,
      promisedFor: new Date('2026-09-25T12:00:00Z'),
      madeAt: new Date('2026-09-03T12:00:00Z'),
      contactName: null,
      channel: 'phone',
      notes: null,
    });

    const swept = await dunning.runDunning(scoped, { trigger: 'schedule', now: NOW });
    expect(swept.sent).toBe(0);
    expect(swept.notices?.[0]?.detail).toBe('promised');

    const views = await promises.promisesFor(scoped, invoiceId, NOW);
    expect(views.map((view) => view.outcome.state)).toEqual(['open', 'superseded']);
  });
});

describe('withdrawing one', () => {
  it('needs a reason, and releases the ladder', async () => {
    mailWorks();

    const made = await promises.recordPromise(scoped, invoiceId, {
      amountCents: 187_500,
      promisedFor: new Date('2026-09-25T12:00:00Z'),
      madeAt: NOW,
      contactName: null,
      channel: 'phone',
      notes: null,
    });

    expect((await promises.cancelPromise(scoped, made.promiseId!, '  ')).ok).toBe(false);

    const cancelled = await promises.cancelPromise(
      scoped,
      made.promiseId!,
      'They rang back — cannot pay until the new year',
    );
    expect(cancelled.ok).toBe(true);

    const swept = await dunning.runDunning(scoped, { trigger: 'schedule', now: NOW });
    expect(swept.sent).toBe(1);

    // Withdrawn, not broken — so nothing accuses them in the letter.
    const [document] = await scoped.select('documents');
    const bytes = await (await import('@/lib/storage/blob-store'))
      .blobStore()
      .get(document!.storageKey);
    expect(await pdfText(bytes!)).not.toContain('WHAT YOU TOLD US');
  });
});

describe('the record', () => {
  it('logs what was said and what was withdrawn, and leaves the chain sound', async () => {
    const made = await promises.recordPromise(scoped, invoiceId, {
      amountCents: 187_500,
      promisedFor: new Date('2026-09-25T12:00:00Z'),
      madeAt: NOW,
      contactName: 'Renata Dowd',
      channel: 'phone',
      notes: null,
    });
    await promises.cancelPromise(scoped, made.promiseId!, 'Changed their mind');

    const entries = await dbModule.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.subject, `invoice:${invoiceId}`));

    const actions = entries.map((entry) => entry.action);
    expect(actions).toContain(chain.AUDIT.promiseRecorded);
    expect(actions).toContain(chain.AUDIT.promiseCancelled);

    expect((await chain.verifyChain()).ok).toBe(true);
  });
});
