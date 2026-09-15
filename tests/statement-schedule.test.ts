import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  DEFAULT_SCHEDULE,
  decide,
  describeSchedule,
  nextOccurrenceAfter,
  occurrenceOn,
  ordinal,
  type ScheduleRule,
} from '@/lib/invoices/statement-schedule';
import { applyMigrations } from './helpers/temp-db';

/**
 * Sending statements without a scheduler.
 *
 * There is no daemon here, so the schedule is a rule and something outside
 * pokes it. Everything that can go wrong with that is about repetition and
 * failure: a cron line that fires twice must not send twice, a machine that
 * was off for a month must not send a month of statements when it wakes, and
 * one customer's bad address must not stop the other forty-nine.
 */

const monthly = (over: Partial<ScheduleRule> = {}): ScheduleRule => ({
  ...DEFAULT_SCHEDULE,
  cadence: 'monthly',
  dayOfMonth: 1,
  ...over,
});

/* -------------------------------------------------------------------------
 * Which day an occurrence falls on
 * ---------------------------------------------------------------------- */

describe('the occurrence', () => {
  it('is the same answer all day, whenever it is asked', () => {
    /*
     * A poke at five past midnight and another at five to midnight have to
     * belong to the same run, or a cron line running hourly would send a
     * statement an hour.
     */
    const rule = monthly({ dayOfMonth: 1 });
    const early = occurrenceOn(rule, new Date('2026-09-01T00:05:00Z'));
    const late = occurrenceOn(rule, new Date('2026-09-01T23:55:00Z'));

    expect(early?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(late?.toISOString()).toBe(early?.toISOString());
  });

  it('looks back, so a poke before the day belongs to last month', () => {
    const rule = monthly({ dayOfMonth: 15 });

    expect(occurrenceOn(rule, new Date('2026-09-14T12:00:00Z'))?.toISOString()).toBe(
      '2026-08-15T00:00:00.000Z',
    );
    expect(occurrenceOn(rule, new Date('2026-09-15T00:00:00Z'))?.toISOString()).toBe(
      '2026-09-15T00:00:00.000Z',
    );
  });

  it('crosses a year end without losing a month', () => {
    const rule = monthly({ dayOfMonth: 20 });
    expect(occurrenceOn(rule, new Date('2026-01-05T12:00:00Z'))?.toISOString()).toBe(
      '2025-12-20T00:00:00.000Z',
    );
  });

  it('never picks a day February does not have', () => {
    // 28 is the cap, and a rule that somehow held 31 is clamped rather than
    // skipping February and drifting for the rest of the year.
    const rule = monthly({ dayOfMonth: 31 });
    expect(occurrenceOn(rule, new Date('2026-03-05T12:00:00Z'))?.toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
  });

  it('finds the most recent weekday for a weekly schedule', () => {
    const rule: ScheduleRule = { ...DEFAULT_SCHEDULE, cadence: 'weekly', dayOfWeek: 1 };

    // Monday 14 September 2026 is a Monday; the 16th is the Wednesday after.
    expect(occurrenceOn(rule, new Date('2026-09-16T12:00:00Z'))?.toISOString()).toBe(
      '2026-09-14T00:00:00.000Z',
    );
    expect(occurrenceOn(rule, new Date('2026-09-14T00:00:00Z'))?.toISOString()).toBe(
      '2026-09-14T00:00:00.000Z',
    );
  });

  it('is nothing at all when the schedule is off', () => {
    expect(occurrenceOn(DEFAULT_SCHEDULE, new Date('2026-09-14T12:00:00Z'))).toBeNull();
    expect(nextOccurrenceAfter(DEFAULT_SCHEDULE, new Date())).toBeNull();
  });

  it('says when the next one goes', () => {
    expect(
      nextOccurrenceAfter(monthly({ dayOfMonth: 1 }), new Date('2026-09-14T12:00:00Z'))
        ?.toISOString(),
    ).toBe('2026-10-01T00:00:00.000Z');

    expect(
      nextOccurrenceAfter(
        { ...DEFAULT_SCHEDULE, cadence: 'weekly', dayOfWeek: 1 },
        new Date('2026-09-16T12:00:00Z'),
      )?.toISOString(),
    ).toBe('2026-09-21T00:00:00.000Z');
  });
});

/* -------------------------------------------------------------------------
 * Who gets one
 * ---------------------------------------------------------------------- */

describe('the decision', () => {
  const rule = monthly();

  it('sends to somebody who owes', () => {
    expect(decide({ balanceCents: 187_500, heldCents: 0, enabled: true }, rule)).toEqual({
      send: true,
      reason: 'owes',
    });
  });

  it('sends to somebody holding credit even at a zero balance', () => {
    // Telling them the carrier has their money is the entire reason the
    // balance is visible anywhere.
    expect(decide({ balanceCents: 0, heldCents: 50_000, enabled: true }, rule)).toEqual({
      send: true,
      reason: 'holds_credit',
    });
  });

  it('sends nothing to somebody with nothing to say', () => {
    expect(decide({ balanceCents: 0, heldCents: 0, enabled: true }, rule)).toEqual({
      send: false,
      reason: 'nothing_to_say',
    });
  });

  it('respects a customer who has been turned off', () => {
    expect(decide({ balanceCents: 187_500, heldCents: 0, enabled: false }, rule)).toEqual({
      send: false,
      reason: 'disabled',
    });
  });

  it('leaves a trivial balance alone when a minimum is set', () => {
    const withFloor = monthly({ minimumBalanceCents: 5_000 });

    expect(decide({ balanceCents: 200, heldCents: 0, enabled: true }, withFloor)).toEqual({
      send: false,
      reason: 'under_minimum',
    });
    expect(decide({ balanceCents: 5_000, heldCents: 0, enabled: true }, withFloor).send).toBe(
      true,
    );
  });

  it('can be told not to chase credit holders', () => {
    expect(
      decide(
        { balanceCents: 0, heldCents: 50_000, enabled: true },
        monthly({ includeCreditHolders: false }),
      ),
    ).toEqual({ send: false, reason: 'nothing_to_say' });
  });
});

describe('describing it', () => {
  it('reads as a sentence', () => {
    expect(describeSchedule(DEFAULT_SCHEDULE)).toContain('not sent on a schedule');
    expect(describeSchedule(monthly({ dayOfMonth: 1 }))).toContain('on the 1st of each month');
    expect(describeSchedule(monthly({ dayOfMonth: 22, minimumBalanceCents: 2_500 }))).toContain(
      'owing at least $25.00',
    );
    expect(
      describeSchedule({ ...DEFAULT_SCHEDULE, cadence: 'weekly', dayOfWeek: 5 }),
    ).toContain('every Friday');
  });

  it('gets the awkward ordinals right', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '23rd',
    ]);
  });
});

/* -------------------------------------------------------------------------
 * Against a real database
 * ---------------------------------------------------------------------- */

let workspace: string;
let scoped: Awaited<ReturnType<(typeof import('@/lib/db/scope'))['forOrg']>>;
let dbModule: typeof import('@/lib/db/client');
let schema: typeof import('@/lib/db/schema');
let run: typeof import('@/lib/invoices/statement-run');
let credit: typeof import('@/lib/invoices/customer-credit');
let chain: typeof import('@/lib/audit/chain');
let transport: typeof import('@/lib/email/transport');

const NOW = new Date('2026-09-14T12:00:00Z');

let owing: string;
let settled: string;
let holder: string;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'openhaul-schedule-'));
  process.env.DATABASE_URL = `file:${path.join(workspace, 'test.db')}`;
  delete process.env.DATABASE_ENCRYPTION_KEY;
  process.env.BLOB_STORAGE_PATH = path.join(workspace, 'uploads');

  dbModule = await import('@/lib/db/client');
  schema = await import('@/lib/db/schema');
  await dbModule.ready();
  await applyMigrations(dbModule.rawClient);

  const { asOrgId, forOrg } = await import('@/lib/db/scope');
  run = await import('@/lib/invoices/statement-run');
  credit = await import('@/lib/invoices/customer-credit');
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

/**
 * Three customers: one who owes, one square, one holding credit. Rebuilt
 * every test because a run writes to all of them.
 */
beforeEach(async () => {
  vi.restoreAllMocks();

  for (const table of [
    'statementRunItems',
    'statementRuns',
    'statementSchedules',
    'statements',
    'customerCredits',
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

  const [a] = await scoped.insert('customers', {
    name: 'Cardinal Logistics Brokerage',
    kind: 'broker',
    email: 'ap@cardinal.test',
  });
  owing = a!.id;

  const [b] = await scoped.insert('customers', {
    name: 'Hollis Motors',
    kind: 'dealer',
    email: 'ap@hollis.test',
  });
  settled = b!.id;

  const [c] = await scoped.insert('customers', {
    name: 'Bayside Auto Group',
    kind: 'dealer',
    email: 'ap@bayside.test',
  });
  holder = c!.id;

  // Cardinal owes $1,875.
  await scoped.insert('invoices', {
    number: 'INV-OWING',
    customerId: owing,
    status: 'sent',
    lineHaulCents: 187_500,
    totalCents: 187_500,
    issuedAt: new Date('2026-08-01T12:00:00Z'),
    dueAt: new Date('2026-08-31T12:00:00Z'),
  });

  // Hollis paid in full.
  const [paid] = await scoped.insert('invoices', {
    number: 'INV-SETTLED',
    customerId: settled,
    status: 'paid',
    lineHaulCents: 100_000,
    totalCents: 100_000,
    paidCents: 100_000,
    issuedAt: new Date('2026-08-01T12:00:00Z'),
  });
  await scoped.insert('payments', {
    invoiceId: paid!.id,
    amountCents: 100_000,
    method: 'ach',
    receivedAt: new Date('2026-08-05T12:00:00Z'),
  });

  // Bayside overpaid and asked us to keep it.
  const [over] = await scoped.insert('invoices', {
    number: 'INV-OVER',
    customerId: holder,
    status: 'paid',
    lineHaulCents: 100_000,
    totalCents: 100_000,
    paidCents: 150_000,
    issuedAt: new Date('2026-08-01T12:00:00Z'),
  });
  await scoped.insert('payments', {
    invoiceId: over!.id,
    amountCents: 150_000,
    method: 'ach',
    receivedAt: new Date('2026-08-05T12:00:00Z'),
  });
  await credit.carryForward(scoped, over!.id, {
    amountCents: 50_000,
    occurredAt: new Date('2026-08-06T12:00:00Z'),
    note: null,
    creditNoteId: null,
  });
});

/** Pretends a mail server is configured and accepts everything. */
function mailWorks() {
  vi.spyOn(transport, 'mailConfigured').mockReturnValue(true);
  vi.spyOn(transport, 'send').mockResolvedValue({
    ok: true,
    messageId: '<test@ridgeline>',
    accepted: ['ap@cardinal.test'],
    rejected: [],
  });
}

describe('choosing who gets one', () => {
  it('separates the three kinds of customer', async () => {
    await run.saveSchedule(scoped, monthly());
    const rows = await run.candidates(scoped, monthly(), NOW);

    const byId = new Map(rows.map((row) => [row.customer.id, row]));

    expect(byId.get(owing)?.decision).toEqual({ send: true, reason: 'owes' });
    expect(byId.get(settled)?.decision).toEqual({ send: false, reason: 'nothing_to_say' });
    expect(byId.get(holder)?.decision).toEqual({ send: true, reason: 'holds_credit' });

    // The ones that will not be sent to are returned too: "why did Hollis not
    // get one" is the question asked about a batch job.
    expect(rows).toHaveLength(3);
  });

  it('drops a customer somebody has turned off', async () => {
    await run.setStatementsEnabled(scoped, owing, false);

    const rows = await run.candidates(scoped, monthly(), NOW);
    expect(rows.find((row) => row.customer.id === owing)?.decision).toEqual({
      send: false,
      reason: 'disabled',
    });
  });
});

describe('running it', () => {
  it('sends to the two with something to say and records the third as considered', async () => {
    mailWorks();
    await run.saveSchedule(scoped, monthly({ dayOfMonth: 1 }));

    const result = await run.runStatements(scoped, { trigger: 'schedule', now: NOW });

    expect(result).toMatchObject({ ok: true, considered: 3, sent: 2, failed: 0, skipped: 0 });
    expect(result.dueOn?.toISOString()).toBe('2026-09-01T00:00:00.000Z');

    const items = await run.itemsFor(scoped, result.runId!);
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.outcome === 'sent')).toBe(true);

    // The documents exist and were actually sent, not just recorded.
    expect(await scoped.select('statements')).toHaveLength(2);
    expect(await scoped.select('documentSends')).toHaveLength(2);
  });

  it('will not run the same occurrence twice', async () => {
    mailWorks();
    await run.saveSchedule(scoped, monthly({ dayOfMonth: 1 }));

    const first = await run.runStatements(scoped, { trigger: 'schedule', now: NOW });
    expect(first.ok).toBe(true);

    /*
     * A cron line firing hourly, a retry after a timeout and somebody pressing
     * the button all land here. The occurrence is claimed, so nothing happens.
     */
    const second = await run.runStatements(scoped, { trigger: 'schedule', now: NOW });
    expect(second.ok).toBe(false);
    expect(second.reason).toContain('already been done');

    expect(await scoped.select('statements')).toHaveLength(2);
  });

  it('does not make up a run that was missed', async () => {
    mailWorks();
    await run.saveSchedule(scoped, monthly({ dayOfMonth: 1 }));

    // The machine was off for July and August and comes back in September.
    const result = await run.runStatements(scoped, { trigger: 'schedule', now: NOW });

    expect(result.ok).toBe(true);
    expect(await scoped.select('statementRuns')).toHaveLength(1);
    // One statement each, not three months of them.
    expect(await scoped.select('statements')).toHaveLength(2);
  });

  it('refuses when the schedule is off', async () => {
    mailWorks();
    const result = await run.runStatements(scoped, { trigger: 'schedule', now: NOW });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not sent on a schedule');
    expect(await scoped.select('statementRuns')).toHaveLength(0);
  });

  it('refuses rather than producing statements it cannot send', async () => {
    vi.spyOn(transport, 'mailConfigured').mockReturnValue(false);
    await run.saveSchedule(scoped, monthly());

    const result = await run.runStatements(scoped, { trigger: 'schedule', now: NOW });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('No mail server');
    // Nothing produced: fifty documents nobody sent would be worse than none.
    expect(await scoped.select('statements')).toHaveLength(0);
    expect(await scoped.select('statementRuns')).toHaveLength(0);
  });

  it('runs on demand against today, and still only once', async () => {
    mailWorks();
    await run.saveSchedule(scoped, monthly({ dayOfMonth: 1 }));

    const forced = await run.runStatements(scoped, {
      trigger: 'manual',
      now: NOW,
      force: true,
    });

    expect(forced.ok).toBe(true);
    expect(forced.dueOn?.toISOString()).toBe('2026-09-14T00:00:00.000Z');

    const again = await run.runStatements(scoped, { trigger: 'manual', now: NOW, force: true });
    expect(again.ok).toBe(false);
  });
});

describe('when one of them fails', () => {
  it('carries on and records what went wrong against that customer', async () => {
    vi.spyOn(transport, 'mailConfigured').mockReturnValue(true);

    let attempt = 0;
    vi.spyOn(transport, 'send').mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) {
        return { ok: false, error: 'Mailbox unavailable' };
      }
      return { ok: true, messageId: '<ok@ridgeline>', accepted: ['x@y.test'], rejected: [] };
    });

    await run.saveSchedule(scoped, monthly());
    const result = await run.runStatements(scoped, { trigger: 'schedule', now: NOW });

    // One failed, one went. The sweep did not stop at the broken one.
    expect(result).toMatchObject({ ok: true, sent: 1, failed: 1 });

    const items = await run.itemsFor(scoped, result.runId!);
    expect(items[0]?.outcome).toBe('failed');
    expect(items[0]?.detail).toContain('Mailbox unavailable');
    // Produced anyway, so somebody can send it by hand.
    expect(items[0]?.statementId).not.toBeNull();

    expect(await run.unresolvedItems(scoped, result.runId!)).toHaveLength(1);
  });

  it('skips a customer with no address rather than failing the run', async () => {
    mailWorks();
    await scoped.update('customers', eq(schema.customers.id, owing), { email: null });
    await run.saveSchedule(scoped, monthly());

    const result = await run.runStatements(scoped, { trigger: 'schedule', now: NOW });

    expect(result).toMatchObject({ ok: true, sent: 1, skipped: 1, failed: 0 });

    const skipped = (await run.itemsFor(scoped, result.runId!)).find(
      (item) => item.outcome === 'skipped',
    );
    expect(skipped?.detail).toContain('No email address');
    // Nothing produced for them: it could not have gone anywhere.
    expect(skipped?.statementId).toBeNull();
  });

  it('skips a customer whose statement would not reconcile', async () => {
    mailWorks();

    /*
     * The invoice's own paid figure says one thing and the ledger another.
     * The statement refuses to be produced, and the run has to survive that
     * rather than stopping on it.
     */
    const [invoice] = await scoped.select('invoices', eq(schema.invoices.number, 'INV-OWING'));
    await scoped.update('invoices', eq(schema.invoices.id, invoice!.id), { paidCents: 50_000 });

    await run.saveSchedule(scoped, monthly());
    const result = await run.runStatements(scoped, { trigger: 'schedule', now: NOW });

    expect(result.ok).toBe(true);
    const skipped = (await run.itemsFor(scoped, result.runId!)).find(
      (item) => item.outcome === 'skipped',
    );
    expect(skipped?.detail).toContain('does not reconcile');
  });

  it('never retries inside a run', async () => {
    vi.spyOn(transport, 'mailConfigured').mockReturnValue(true);
    const send = vi
      .spyOn(transport, 'send')
      .mockResolvedValue({ ok: false, error: 'Connection refused' });

    await run.saveSchedule(scoped, monthly());
    const result = await run.runStatements(scoped, { trigger: 'schedule', now: NOW });

    // Two eligible customers, two attempts. An outage during a fifty-customer
    // sweep must not become several hundred attempts at a refusing server.
    expect(result.failed).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('the record', () => {
  it('logs the run and leaves the chain sound', async () => {
    mailWorks();
    await run.saveSchedule(scoped, monthly());
    const result = await run.runStatements(scoped, { trigger: 'schedule', now: NOW });

    const entries = await dbModule.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.subject, `org:${scoped.orgId}`));

    const actions = entries.map((entry) => entry.action);
    expect(actions).toContain(chain.AUDIT.statementScheduleChanged);
    expect(actions).toContain(chain.AUDIT.statementRunFinished);

    const [row] = await scoped.select('statementRuns', eq(schema.statementRuns.id, result.runId!));
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.trigger).toBe('schedule');

    expect((await chain.verifyChain()).ok).toBe(true);
  });

  it('keeps the schedule it was given', async () => {
    const rule = monthly({ dayOfMonth: 15, windowDays: 60, minimumBalanceCents: 2_500 });
    await run.saveSchedule(scoped, rule);
    expect(await run.scheduleFor(scoped)).toEqual(rule);

    // Saved twice is still one row: the schedule is per organisation.
    await run.saveSchedule(scoped, monthly({ dayOfMonth: 20 }));
    expect(await scoped.select('statementSchedules')).toHaveLength(1);
    expect((await run.scheduleFor(scoped)).dayOfMonth).toBe(20);
  });

  it('defaults to off for an organisation that has never set one', async () => {
    expect(await run.scheduleFor(scoped)).toEqual(DEFAULT_SCHEDULE);
  });
});
