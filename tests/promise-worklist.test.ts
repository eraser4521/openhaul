import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  BUCKET_LABEL,
  SETTLED_WINDOW_DAYS,
  bucketOf,
  compareWithin,
  describeTally,
  tally,
  totalsFor,
  type WorkBucket,
} from '@/lib/invoices/promise-worklist';
import { outcomeOf, type PromiseOutcome, type PromiseRecord } from '@/lib/invoices/promise';
import { applyMigrations } from './helpers/temp-db';

/**
 * Every promise, arranged for somebody working a phone.
 *
 * The arrangement is the whole feature, so the tests are about which pile a
 * promise lands in and what the list says about the person who made it. Two
 * things must not go wrong: a promise whose cheque is still in the post must
 * not sit among the broken ones, because the action there is to do nothing;
 * and a customer's record must not be counted in a way that punishes them for
 * ringing to say they cannot pay.
 */

const NOW = new Date('2026-09-14T12:00:00Z');

function promise(over: Partial<PromiseRecord> = {}): PromiseRecord {
  return {
    id: 'p1',
    invoiceId: 'inv-1',
    amountCents: 187_500,
    promisedFor: new Date('2026-09-10T12:00:00Z'),
    madeAt: new Date('2026-09-01T12:00:00Z'),
    contactName: 'Renata Dowd',
    channel: 'phone',
    notes: null,
    cancelledAt: null,
    cancelReason: null,
    ...over,
  };
}

const paid = (amountCents: number, on: string) => ({ amountCents, receivedAt: new Date(on) });

/** The real outcome, so the buckets are tested against the real states. */
function outcome(
  record: PromiseRecord,
  payments: ReadonlyArray<{ amountCents: number; receivedAt: Date }> = [],
  over: { graceDays?: number; supersededBy?: PromiseRecord | null; now?: Date } = {},
): PromiseOutcome {
  return outcomeOf(record, payments, {
    graceDays: over.graceDays ?? 3,
    supersededBy: over.supersededBy ?? null,
    now: over.now ?? NOW,
  });
}

/* -------------------------------------------------------------------------
 * Which pile
 * ---------------------------------------------------------------------- */

describe('the buckets', () => {
  it('keeps a cheque still in the post away from the broken ones', () => {
    /*
     * The single case where the right action is to do nothing. A list that
     * lumped it in with the broken promises would have somebody ringing a
     * customer whose payment is on its way.
     */
    const stillInGrace = promise({ promisedFor: new Date('2026-09-13T12:00:00Z') });
    expect(bucketOf(stillInGrace, outcome(stillInGrace), NOW)).toBe('in_the_post');

    const graceGone = promise({ promisedFor: new Date('2026-09-05T12:00:00Z') });
    expect(bucketOf(graceGone, outcome(graceGone), NOW)).toBe('not_kept');
  });

  it('treats a promise for today as due today, whatever the hour', () => {
    const today = promise({ promisedFor: new Date('2026-09-14T00:00:00Z') });

    // Nine in the morning and five at night are the same day to a bookkeeper.
    for (const hour of ['2026-09-14T09:00:00Z', '2026-09-14T17:00:00Z']) {
      const at = new Date(hour);
      expect(bucketOf(today, outcome(today, [], { now: at }), at)).toBe('in_the_post');
    }
  });

  it('puts a part payment in with the broken ones, because it still needs a call', () => {
    const short = promise({ promisedFor: new Date('2026-09-05T12:00:00Z') });
    const result = outcome(short, [paid(50_000, '2026-09-04T12:00:00Z')]);

    expect(result.state).toBe('partly_kept');
    expect(bucketOf(short, result, NOW)).toBe('not_kept');
  });

  it('shows what arrived, then stops', () => {
    const recent = promise({ promisedFor: new Date('2026-09-10T12:00:00Z') });
    expect(bucketOf(recent, outcome(recent, [paid(187_500, '2026-09-09T12:00:00Z')]), NOW)).toBe(
      'kept',
    );

    // Past the window it is no longer news, and the list does not grow forever.
    const old = promise({
      promisedFor: new Date('2026-08-01T12:00:00Z'),
      madeAt: new Date('2026-07-20T12:00:00Z'),
    });
    expect(bucketOf(old, outcome(old, [paid(187_500, '2026-07-30T12:00:00Z')]), NOW)).toBeNull();
  });

  it('leaves off the promises nobody should be rung about', () => {
    /*
     * A customer who rang back with a new date does not want to be chased
     * about the old one, and neither does one who withdrew it.
     */
    const superseded = promise();
    const later = promise({ id: 'p2', madeAt: new Date('2026-09-05T12:00:00Z') });
    expect(
      bucketOf(superseded, outcome(superseded, [], { supersededBy: later }), NOW),
    ).toBeNull();

    const withdrawn = promise({ cancelledAt: new Date('2026-09-02T12:00:00Z') });
    expect(bucketOf(withdrawn, outcome(withdrawn), NOW)).toBeNull();
  });

  it('separates what is still to come', () => {
    const ahead = promise({ promisedFor: new Date('2026-09-30T12:00:00Z') });
    expect(bucketOf(ahead, outcome(ahead), NOW)).toBe('expected');
  });

  it('honours a longer settled window when one is given', () => {
    const old = promise({
      promisedFor: new Date('2026-08-20T12:00:00Z'),
      madeAt: new Date('2026-08-10T12:00:00Z'),
    });
    const kept = outcome(old, [paid(187_500, '2026-08-19T12:00:00Z')]);

    expect(bucketOf(old, kept, NOW, SETTLED_WINDOW_DAYS)).toBeNull();
    expect(bucketOf(old, kept, NOW, 60)).toBe('kept');
  });
});

describe('the order within a pile', () => {
  const early = { promisedFor: new Date('2026-09-01T12:00:00Z') };
  const late = { promisedFor: new Date('2026-09-12T12:00:00Z') };

  it('puts the longest-ignored first where there is something to do', () => {
    for (const bucket of ['not_kept', 'in_the_post', 'expected'] as WorkBucket[]) {
      expect([late, early].sort((a, b) => compareWithin(bucket, a, b))[0]).toBe(early);
    }
  });

  it('reads the arrived pile the other way, newest first', () => {
    expect([early, late].sort((a, b) => compareWithin('kept', a, b))[0]).toBe(late);
  });
});

/* -------------------------------------------------------------------------
 * Whether somebody's word has been good
 * ---------------------------------------------------------------------- */

describe('a customer record', () => {
  const on = (day: string) => new Date(`2026-09-${day}T12:00:00Z`);

  it('counts the resolved ones and says so plainly', () => {
    const count = tally([
      { state: 'kept', promisedFor: on('01') },
      { state: 'kept', promisedFor: on('05') },
      { state: 'broken', promisedFor: on('09') },
    ]);

    expect(count).toMatchObject({ kept: 2, notKept: 1, partlyKept: 0, resolved: 3 });
    // A fact, not a score. "67%" is the same fact dressed as a measurement.
    expect(describeTally(count)).toBe('Kept 2 of 3');
  });

  it('never counts a withdrawn promise against them', () => {
    /*
     * Ringing to say the payment cannot be made is the honest thing to do.
     * Counting it as a failure would score somebody down for candour.
     */
    const count = tally([
      { state: 'kept', promisedFor: on('01') },
      { state: 'cancelled', promisedFor: on('05') },
      { state: 'superseded', promisedFor: on('07') },
      { state: 'open', promisedFor: on('20') },
    ]);

    expect(count).toMatchObject({ kept: 1, resolved: 1 });
    expect(describeTally(count)).toBe('Kept 1 of 1');
  });

  it('notices a run of kept promises, counting back from the most recent', () => {
    const count = tally([
      { state: 'broken', promisedFor: on('01') },
      { state: 'kept', promisedFor: on('05') },
      { state: 'kept', promisedFor: on('09') },
      { state: 'kept', promisedFor: on('12') },
    ]);

    expect(count.streak).toBe(3);
    expect(describeTally(count)).toBe('Kept 3 of 4 — last 3 in a row');
  });

  it('breaks the run on the most recent failure, not an old one', () => {
    const count = tally([
      { state: 'kept', promisedFor: on('01') },
      { state: 'kept', promisedFor: on('05') },
      { state: 'partly_kept', promisedFor: on('12') },
    ]);

    expect(count.streak).toBe(0);
  });

  it('says nothing at all when there is nothing to say', () => {
    expect(describeTally(tally([]))).toBeNull();
    expect(describeTally(tally([{ state: 'open', promisedFor: on('20') }]))).toBeNull();
  });

  it('says so when none have been kept', () => {
    const count = tally([
      { state: 'broken', promisedFor: on('01') },
      { state: 'broken', promisedFor: on('05') },
    ]);

    expect(describeTally(count)).toBe('Kept 0 of 2 — none yet');
  });
});

describe('the totals', () => {
  it('adds up what was promised and what is still short', () => {
    const broken = promise({ promisedFor: new Date('2026-09-05T12:00:00Z') });
    const partly = promise({ id: 'p2', promisedFor: new Date('2026-09-05T12:00:00Z') });

    const totals = totalsFor([
      { amountCents: broken.amountCents, outcome: outcome(broken) },
      {
        amountCents: partly.amountCents,
        outcome: outcome(partly, [paid(50_000, '2026-09-04T12:00:00Z')]),
      },
    ]);

    expect(totals).toEqual({
      count: 2,
      promisedCents: 375_000,
      outstandingCents: 187_500 + 137_500,
    });
  });

  it('shows nothing outstanding against what arrived', () => {
    const kept = promise();
    const totals = totalsFor([
      { amountCents: kept.amountCents, outcome: outcome(kept, [paid(187_500, '2026-09-09T12:00:00Z')]) },
    ]);

    expect(totals.outstandingCents).toBe(0);
  });
});

describe('the labels', () => {
  it('say what to do rather than what state a row is in', () => {
    expect(BUCKET_LABEL.not_kept).toBe('Did not arrive');
    expect(BUCKET_LABEL.in_the_post).toContain('within grace');
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

let cardinal: string;
let hollis: string;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'openhaul-worklist-'));
  process.env.DATABASE_URL = `file:${path.join(workspace, 'test.db')}`;
  delete process.env.DATABASE_ENCRYPTION_KEY;
  process.env.BLOB_STORAGE_PATH = path.join(workspace, 'uploads');

  dbModule = await import('@/lib/db/client');
  schema = await import('@/lib/db/schema');
  await dbModule.ready();
  await applyMigrations(dbModule.rawClient);

  const { asOrgId, forOrg } = await import('@/lib/db/scope');
  promises = await import('@/lib/invoices/promise-record');

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

beforeEach(async () => {
  for (const table of ['promisesToPay', 'payments', 'invoices', 'customers'] as const) {
    for (const row of await scoped.select(table)) {
      const column = (schema[table] as unknown as { id: Parameters<typeof eq>[0] }).id;
      await scoped.remove(table, eq(column, row.id));
    }
  }

  const [a] = await scoped.insert('customers', {
    name: 'Cardinal Logistics Brokerage',
    kind: 'broker',
    email: 'ap@cardinal.test',
  });
  cardinal = a!.id;

  const [b] = await scoped.insert('customers', {
    name: 'Hollis Motors',
    kind: 'dealer',
    email: 'ap@hollis.test',
  });
  hollis = b!.id;
});

async function invoiceFor(customerId: string, number: string, totalCents = 187_500) {
  const [row] = await scoped.insert('invoices', {
    number,
    customerId,
    status: 'sent',
    lineHaulCents: totalCents,
    totalCents,
    issuedAt: new Date('2026-07-01T12:00:00Z'),
    dueAt: new Date('2026-08-01T12:00:00Z'),
  });
  return row!;
}

describe('gathering the list', () => {
  it('sorts every promise into its pile with the invoice and customer beside it', async () => {
    const broken = await invoiceFor(cardinal, 'INV-BROKEN');
    await promises.recordPromise(scoped, broken.id, {
      amountCents: 187_500,
      promisedFor: new Date('2026-09-05T12:00:00Z'),
      madeAt: new Date('2026-09-01T12:00:00Z'),
      contactName: 'Renata Dowd',
      channel: 'phone',
      notes: null,
    });

    const ahead = await invoiceFor(hollis, 'INV-AHEAD');
    await promises.recordPromise(scoped, ahead.id, {
      amountCents: 100_000,
      promisedFor: new Date('2026-09-30T12:00:00Z'),
      madeAt: new Date('2026-09-12T12:00:00Z'),
      contactName: null,
      channel: 'email',
      notes: null,
    });

    const list = await promises.worklist(scoped, NOW);

    expect(list.byBucket.not_kept).toHaveLength(1);
    expect(list.byBucket.expected).toHaveLength(1);

    expect(list.byBucket.not_kept[0]).toMatchObject({
      invoiceNumber: 'INV-BROKEN',
      customerName: 'Cardinal Logistics Brokerage',
      invoiceBalanceCents: 187_500,
    });

    expect(list.totals.not_kept).toMatchObject({
      count: 1,
      promisedCents: 187_500,
      outstandingCents: 187_500,
    });
    expect(list.totals.expected.promisedCents).toBe(100_000);
  });

  it('puts the same customer record beside every row for that customer', async () => {
    const first = await invoiceFor(cardinal, 'INV-1');
    await promises.recordPromise(scoped, first.id, {
      amountCents: 187_500,
      promisedFor: new Date('2026-08-10T12:00:00Z'),
      madeAt: new Date('2026-08-01T12:00:00Z'),
      contactName: null,
      channel: 'phone',
      notes: null,
    });
    await scoped.insert('payments', {
      invoiceId: first.id,
      amountCents: 187_500,
      method: 'ach',
      receivedAt: new Date('2026-08-09T12:00:00Z'),
    });

    const second = await invoiceFor(cardinal, 'INV-2');
    await promises.recordPromise(scoped, second.id, {
      amountCents: 187_500,
      promisedFor: new Date('2026-09-05T12:00:00Z'),
      madeAt: new Date('2026-09-01T12:00:00Z'),
      contactName: null,
      channel: 'phone',
      notes: null,
    });

    const list = await promises.worklist(scoped, NOW);
    const row = list.byBucket.not_kept[0];

    /*
     * Both promises counted, the row's own included. Excluding it would give
     * this customer a different record on every row of the same page, which
     * reads as a bug to anybody scanning it.
     */
    expect(row?.record).toMatchObject({ kept: 1, notKept: 1, resolved: 2 });
    expect(row?.record.streak).toBe(0);
  });

  it('keeps one customer out of another customer record', async () => {
    const theirs = await invoiceFor(hollis, 'INV-H');
    await promises.recordPromise(scoped, theirs.id, {
      amountCents: 100_000,
      promisedFor: new Date('2026-09-05T12:00:00Z'),
      madeAt: new Date('2026-09-01T12:00:00Z'),
      contactName: null,
      channel: 'phone',
      notes: null,
    });

    const ours = await invoiceFor(cardinal, 'INV-C');
    await promises.recordPromise(scoped, ours.id, {
      amountCents: 187_500,
      promisedFor: new Date('2026-09-06T12:00:00Z'),
      madeAt: new Date('2026-09-01T12:00:00Z'),
      contactName: null,
      channel: 'phone',
      notes: null,
    });

    const list = await promises.worklist(scoped, NOW);
    expect(list.byBucket.not_kept).toHaveLength(2);

    // Two customers, one broken promise each. Each record counts its own and
    // nobody else's — two would mean the tallies had run together.
    for (const row of list.byBucket.not_kept) {
      expect(row.record).toMatchObject({ resolved: 1, notKept: 1, kept: 0 });
    }
  });

  it('leaves a withdrawn promise off the list but keeps the invoice reachable', async () => {
    const invoice = await invoiceFor(cardinal, 'INV-W');
    const made = await promises.recordPromise(scoped, invoice.id, {
      amountCents: 187_500,
      promisedFor: new Date('2026-09-05T12:00:00Z'),
      madeAt: new Date('2026-09-01T12:00:00Z'),
      contactName: null,
      channel: 'phone',
      notes: null,
    });
    await promises.cancelPromise(scoped, made.promiseId!, 'They rang back');

    const list = await promises.worklist(scoped, NOW);
    expect(list.rows).toHaveLength(0);

    // Still on the invoice, where the history belongs.
    expect(await promises.promisesFor(scoped, invoice.id, NOW)).toHaveLength(1);
  });

  it('is empty rather than broken when nobody has promised anything', async () => {
    const list = await promises.worklist(scoped, NOW);

    expect(list.rows).toEqual([]);
    expect(list.totals.not_kept.count).toBe(0);
  });
});
