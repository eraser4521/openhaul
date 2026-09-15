import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  DEFAULT_LADDER,
  DEFAULT_RULE,
  decideChase,
  describeLateness,
  ladderProblems,
  nextStage,
  normalizeLadder,
  type ChaseContext,
  type DunningRule,
} from '@/lib/invoices/dunning';
import { renderDunningNotice } from '@/lib/documents/dunning-notice';
import { compose } from '@/lib/email/compose';
import { isPdf, pdfText } from './helpers/pdf-text';
import { applyMigrations } from './helpers/temp-db';

/**
 * Chasing an unpaid invoice.
 *
 * Almost every test here is about *not* sending. Escalating letters are easy;
 * the work is the cases where doing so is wrong, and those are the cases that
 * lose a customer rather than collect a debt — chasing somebody whose money
 * you are already holding, escalating on a disputed invoice, sending three
 * rungs in one minute because the sweep had not run for a month.
 */

const NOW = new Date('2026-09-14T12:00:00Z');
const rule: DunningRule = { ...DEFAULT_RULE, enabled: true };

function context(over: Partial<ChaseContext> = {}): ChaseContext {
  return {
    invoice: {
      id: 'inv-1',
      number: 'INV-1',
      status: 'sent',
      totalCents: 187_500,
      paidCents: 0,
      dueAt: new Date('2026-08-01T12:00:00Z'),
      dunningPausedUntil: null,
    },
    customerCreditCents: 0,
    customerDunningEnabled: true,
    customerHasEmail: true,
    hasOpenClaim: false,
    loadOnLegalHold: false,
    lastPaymentAt: null,
    lastNoticeAt: null,
    lastStageSent: 0,
    promiseHolds: false,
    ...over,
  };
}

/* -------------------------------------------------------------------------
 * When it does chase
 * ---------------------------------------------------------------------- */

describe('climbing the ladder', () => {
  it('sends the first rung once it is earned', () => {
    const decision = decideChase(context(), rule, DEFAULT_LADDER, NOW);

    expect(decision.chase).toBe(true);
    expect(decision.chase && decision.stage.sequence).toBe(1);
    expect(decision.daysPastDue).toBe(44);
  });

  it('never skips a rung, however late the invoice is', () => {
    /*
     * A sweep that has not run for a month finds an invoice where all three
     * thresholds are met. A customer whose first contact about a debt is a
     * final notice has been ambushed, however late they are.
     */
    const ancient = context({
      invoice: {
        ...context().invoice,
        dueAt: new Date('2026-01-01T12:00:00Z'),
      },
    });

    const decision = decideChase(ancient, rule, DEFAULT_LADDER, NOW);
    expect(decision.chase && decision.stage.sequence).toBe(1);

    // And the one after it is the second, not the third.
    expect(nextStage(DEFAULT_LADDER, 1, 400)?.sequence).toBe(2);
    expect(nextStage(DEFAULT_LADDER, 2, 400)?.sequence).toBe(3);
    expect(nextStage(DEFAULT_LADDER, 3, 400)).toBeNull();
  });

  it('waits for the threshold of the next rung, not just the gap', () => {
    const early = context({
      lastStageSent: 1,
      lastNoticeAt: new Date('2026-08-10T12:00:00Z'),
      invoice: { ...context().invoice, dueAt: new Date('2026-09-02T12:00:00Z') },
    });

    // 12 days past due: the gap has passed but rung two wants 21.
    const decision = decideChase(early, rule, DEFAULT_LADDER, NOW);
    expect(decision).toMatchObject({ chase: false, reason: 'ladder_finished' });
  });

  it('stops when every rung has been climbed', () => {
    const done = context({
      lastStageSent: 3,
      lastNoticeAt: new Date('2026-07-01T12:00:00Z'),
    });

    expect(decideChase(done, rule, DEFAULT_LADDER, NOW)).toMatchObject({
      chase: false,
      reason: 'ladder_finished',
    });
  });
});

/* -------------------------------------------------------------------------
 * When it does not
 * ---------------------------------------------------------------------- */

describe('leaving it alone', () => {
  it('never chases somebody whose money it is holding', () => {
    /*
     * The one that would be indefensible. A letter demanding $1,875 from
     * somebody whose $1,875 is sitting in the carrier's account cannot be
     * defended when it is read back to them.
     */
    const covered = context({ customerCreditCents: 187_500 });

    expect(decideChase(covered, rule, DEFAULT_LADDER, NOW)).toMatchObject({
      chase: false,
      reason: 'covered_by_credit',
    });

    // Partly covered is still chased — for the part that is not.
    expect(decideChase(context({ customerCreditCents: 100_000 }), rule, DEFAULT_LADDER, NOW).chase).toBe(
      true,
    );
  });

  it('does not escalate an invoice under dispute', () => {
    expect(decideChase(context({ hasOpenClaim: true }), rule, DEFAULT_LADDER, NOW)).toMatchObject({
      chase: false,
      reason: 'disputed',
    });

    expect(
      decideChase(context({ loadOnLegalHold: true }), rule, DEFAULT_LADDER, NOW),
    ).toMatchObject({ chase: false, reason: 'legal_hold' });
  });

  it('gives somebody who is paying room to keep paying', () => {
    const paying = context({ lastPaymentAt: new Date('2026-09-10T12:00:00Z') });

    expect(decideChase(paying, rule, DEFAULT_LADDER, NOW)).toMatchObject({
      chase: false,
      reason: 'recently_paid',
    });

    // But the ladder is not reset — once the grace is up, the next rung is
    // still the next rung, so somebody paying a pound a month still ends up
    // at the end of it.
    const older = context({
      lastPaymentAt: new Date('2026-08-01T12:00:00Z'),
      lastStageSent: 1,
      lastNoticeAt: new Date('2026-08-02T12:00:00Z'),
      invoice: { ...context().invoice, dueAt: new Date('2026-07-01T12:00:00Z') },
    });
    expect(decideChase(older, rule, DEFAULT_LADDER, NOW).chase && true).toBe(true);
  });

  it('honours a pause, and stops honouring it when it expires', () => {
    const paused = context({
      invoice: { ...context().invoice, dunningPausedUntil: new Date('2026-09-20T12:00:00Z') },
    });
    expect(decideChase(paused, rule, DEFAULT_LADDER, NOW)).toMatchObject({
      chase: false,
      reason: 'paused',
    });

    const expired = context({
      invoice: { ...context().invoice, dunningPausedUntil: new Date('2026-09-01T12:00:00Z') },
    });
    expect(decideChase(expired, rule, DEFAULT_LADDER, NOW).chase).toBe(true);
  });

  it('keeps quiet for a while after each notice', () => {
    const recent = context({
      lastStageSent: 1,
      lastNoticeAt: new Date('2026-09-10T12:00:00Z'),
      invoice: { ...context().invoice, dueAt: new Date('2026-07-01T12:00:00Z') },
    });

    expect(decideChase(recent, rule, DEFAULT_LADDER, NOW)).toMatchObject({
      chase: false,
      reason: 'too_soon',
    });
  });

  it('leaves settled, unpaid-but-current and trivial invoices alone', () => {
    expect(
      decideChase(
        context({ invoice: { ...context().invoice, paidCents: 187_500 } }),
        rule,
        DEFAULT_LADDER,
        NOW,
      ),
    ).toMatchObject({ chase: false, reason: 'nothing_owed' });

    expect(
      decideChase(
        context({ invoice: { ...context().invoice, dueAt: new Date('2026-10-01T12:00:00Z') } }),
        rule,
        DEFAULT_LADDER,
        NOW,
      ),
    ).toMatchObject({ chase: false, reason: 'not_due' });

    expect(
      decideChase(context(), { ...rule, minimumBalanceCents: 500_000 }, DEFAULT_LADDER, NOW),
    ).toMatchObject({ chase: false, reason: 'under_minimum' });
  });

  it('respects a customer who has asked not to be chased', () => {
    expect(
      decideChase(context({ customerDunningEnabled: false }), rule, DEFAULT_LADDER, NOW),
    ).toMatchObject({ chase: false, reason: 'customer_opted_out' });

    expect(
      decideChase(context({ customerHasEmail: false }), rule, DEFAULT_LADDER, NOW),
    ).toMatchObject({ chase: false, reason: 'no_email' });
  });
});

/* -------------------------------------------------------------------------
 * The ladder itself
 * ---------------------------------------------------------------------- */

describe('the ladder', () => {
  it('threatens nothing by default', () => {
    const words = DEFAULT_LADDER.map((stage) => stage.message.toLowerCase()).join(' ');

    /*
     * A default that promised collections or legal action would put words in
     * the carrier's mouth about a step they may have no intention of taking,
     * and a threat not followed through is ignored the next time.
     */
    for (const threat of ['collection', 'legal', 'court', 'attorney', 'lawyer', 'credit rating']) {
      expect(words).not.toContain(threat);
    }
  });

  it('gets firmer without getting later than it should', () => {
    expect(DEFAULT_LADDER.map((stage) => stage.daysPastDue)).toEqual([7, 21, 45]);
    expect(ladderProblems(DEFAULT_LADDER, rule)).toEqual([]);
  });

  it('closes gaps in the sequence when a rung is removed', () => {
    const missing = [DEFAULT_LADDER[0]!, DEFAULT_LADDER[2]!];
    expect(normalizeLadder(missing).map((stage) => stage.sequence)).toEqual([1, 2]);
  });

  it('says what is wrong with a ladder somebody has broken', () => {
    const backwards = [
      { ...DEFAULT_LADDER[0]!, daysPastDue: 30 },
      { ...DEFAULT_LADDER[1]!, daysPastDue: 10 },
    ];
    expect(ladderProblems(backwards, rule).join(' ')).toContain('does not escalate');

    const crowded = [
      { ...DEFAULT_LADDER[0]!, daysPastDue: 7 },
      { ...DEFAULT_LADDER[1]!, daysPastDue: 10 },
    ];
    // "only 1 days after" would be the sort of thing a carrier notices
    // instead of the problem it is telling them about.
    expect(ladderProblems(crowded, rule).join(' ')).toContain('only 3 days after');
    expect(
      ladderProblems(
        [
          { ...DEFAULT_LADDER[0]!, daysPastDue: 7 },
          { ...DEFAULT_LADDER[1]!, daysPastDue: 8 },
        ],
        rule,
      ).join(' '),
    ).toContain('only 1 day after');

    const sameDay = [{ ...DEFAULT_LADDER[0]!, daysPastDue: 0 }];
    expect(ladderProblems(sameDay, rule).join(' ')).toContain('due date itself');

    const silent = [{ ...DEFAULT_LADDER[0]!, message: '  ' }];
    expect(ladderProblems(silent, rule).join(' ')).toContain('no message');

    expect(ladderProblems([], rule).join(' ')).toContain('nothing would ever be sent');
  });

  it('describes lateness the way a person would', () => {
    expect(describeLateness(0)).toBe('not yet due');
    expect(describeLateness(1)).toBe('1 day past due');
    expect(describeLateness(44)).toBe('44 days past due');
  });
});

/* -------------------------------------------------------------------------
 * The letter
 * ---------------------------------------------------------------------- */

describe('the notice', () => {
  async function render(over: Record<string, unknown> = {}) {
    return renderDunningNotice({
      stageLabel: 'Second reminder',
      stageSequence: 2,
      stageCount: 3,
      issuedAt: NOW,
      carrier: {
        name: 'Ridgeline Auto Transport LLC',
        addressLine1: '4400 Meacham Blvd',
        city: 'Fort Worth',
        state: 'TX',
        postalCode: '76106',
      },
      billTo: { name: 'Cardinal Logistics Brokerage', contactName: 'Accounts Payable' },
      message: DEFAULT_LADDER[1]!.message,
      invoiceNumber: 'INV-OH-1001',
      invoiceIssuedAt: new Date('2026-07-01T12:00:00Z'),
      dueAt: new Date('2026-08-01T12:00:00Z'),
      daysPastDue: 44,
      totalCents: 294_000,
      paidCents: 100_000,
      creditedCents: 0,
      balanceCents: 194_000,
      currency: 'USD',
      ...over,
    });
  }

  it('prints the carrier words and the figures beside them', async () => {
    const bytes = await render();
    expect(isPdf(bytes)).toBe(true);

    const text = await pdfText(bytes);
    expect(text).toContain('SECOND REMINDER');
    expect(text).toContain('Notice 2 of 3');
    expect(text).toContain('INV-OH-1001');
    expect(text).toContain('$1,940.00');
    expect(text).toContain('44 days past due');
  });

  it('leaves a door open for the payment that crossed with it', async () => {
    const text = await pdfText(await render());
    expect(text).toContain('crossed with your payment');
    expect(text).toContain('tell us which line');
  });

  it('says on the face when it is holding money of theirs', async () => {
    const text = await pdfText(await render({ creditOnAccountCents: 50_000 }));
    expect(text).toContain('holding $500.00 of yours');
  });

  it('keeps the subject line factual rather than shouting', () => {
    const message = compose('dunning_notice', {
      carrierName: 'Ridgeline Auto Transport LLC',
      reference: 'INV-OH-1001',
      balanceCents: 194_000,
      daysPastDue: 44,
      stageLabel: 'Second reminder',
    });

    expect(message.subject).toBe('Invoice INV-OH-1001 — $1,940.00 outstanding — 44 days past due');
    expect(message.subject).not.toMatch(/OVERDUE|URGENT|FINAL/);
    expect(message.body).toContain('crossed with your payment');
  });
});

/* -------------------------------------------------------------------------
 * Against a real database
 * ---------------------------------------------------------------------- */

let workspace: string;
let scoped: Awaited<ReturnType<(typeof import('@/lib/db/scope'))['forOrg']>>;
let dbModule: typeof import('@/lib/db/client');
let schema: typeof import('@/lib/db/schema');
let dunning: typeof import('@/lib/invoices/dunning-run');
let credit: typeof import('@/lib/invoices/customer-credit');
let chain: typeof import('@/lib/audit/chain');
let transport: typeof import('@/lib/email/transport');

let customerId: string;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'openhaul-dunning-'));
  process.env.DATABASE_URL = `file:${path.join(workspace, 'test.db')}`;
  delete process.env.DATABASE_ENCRYPTION_KEY;
  process.env.BLOB_STORAGE_PATH = path.join(workspace, 'uploads');

  dbModule = await import('@/lib/db/client');
  schema = await import('@/lib/db/schema');
  await dbModule.ready();
  await applyMigrations(dbModule.rawClient);

  const { asOrgId, forOrg } = await import('@/lib/db/scope');
  dunning = await import('@/lib/invoices/dunning-run');
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

beforeEach(async () => {
  vi.restoreAllMocks();

  for (const table of [
    'dunningNotices',
    'dunningRuns',
    'dunningStages',
    'dunningSettings',
    'customerCredits',
    'documentSends',
    'documents',
    'claims',
    'payments',
    'invoices',
    'customers',
    'loads',
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

/** An issued invoice, overdue by `daysLate`. */
async function overdue(number: string, daysLate: number, over: Record<string, unknown> = {}) {
  const dueAt = new Date(NOW.getTime() - daysLate * 86_400_000);
  const [row] = await scoped.insert('invoices', {
    number,
    customerId,
    status: 'sent',
    lineHaulCents: 187_500,
    totalCents: 187_500,
    issuedAt: new Date(dueAt.getTime() - 30 * 86_400_000),
    dueAt,
    ...over,
  });
  return row!;
}

describe('the sweep', () => {
  it('sends one rung and records it against the invoice', async () => {
    mailWorks();
    await dunning.saveDunning(scoped, rule, DEFAULT_LADDER);
    const invoice = await overdue('INV-LATE', 44);

    const result = await dunning.runDunning(scoped, { trigger: 'schedule', now: NOW });

    expect(result).toMatchObject({ ok: true, sent: 1, failed: 0 });

    const notices = await dunning.noticesFor(scoped, invoice.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      outcome: 'sent',
      stageSequence: 1,
      balanceCents: 187_500,
      daysPastDue: 44,
    });
    expect(notices[0]?.documentId).not.toBeNull();

    const [document] = await scoped.select('documents');
    expect(document?.kind).toBe('dunning_notice');
  });

  it('sends at most one rung per invoice per sweep', async () => {
    mailWorks();
    await dunning.saveDunning(scoped, rule, DEFAULT_LADDER);
    const invoice = await overdue('INV-ANCIENT', 200);

    await dunning.runDunning(scoped, { trigger: 'schedule', now: NOW });

    // Every threshold is met, and exactly one letter went.
    const notices = await dunning.noticesFor(scoped, invoice.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.stageSequence).toBe(1);
  });

  it('will not sweep twice in a day', async () => {
    mailWorks();
    await dunning.saveDunning(scoped, rule, DEFAULT_LADDER);
    await overdue('INV-LATE', 44);

    expect((await dunning.runDunning(scoped, { trigger: 'schedule', now: NOW })).ok).toBe(true);

    const second = await dunning.runDunning(scoped, { trigger: 'schedule', now: NOW });
    expect(second.ok).toBe(false);
    expect(second.reason).toContain('already been swept');

    expect(await scoped.select('documents')).toHaveLength(1);
  });

  it('climbs a rung at a time across successive sweeps', async () => {
    mailWorks();
    await dunning.saveDunning(scoped, rule, DEFAULT_LADDER);
    const invoice = await overdue('INV-CLIMB', 44);

    await dunning.runDunning(scoped, { trigger: 'schedule', now: NOW });

    // Eleven days later: the gap has passed and rung two is earned.
    const later = new Date(NOW.getTime() + 11 * 86_400_000);
    await dunning.runDunning(scoped, { trigger: 'schedule', now: later });

    const notices = await dunning.noticesFor(scoped, invoice.id);
    expect(notices.map((notice) => notice.stageSequence).sort()).toEqual([1, 2]);
  });

  it('refuses when chasing is off, and when there is no mail server', async () => {
    mailWorks();
    await overdue('INV-LATE', 44);

    const off = await dunning.runDunning(scoped, { trigger: 'schedule', now: NOW });
    expect(off.ok).toBe(false);
    expect(off.reason).toContain('not chased automatically');

    await dunning.saveDunning(scoped, rule, DEFAULT_LADDER);
    vi.spyOn(transport, 'mailConfigured').mockReturnValue(false);

    const noMail = await dunning.runDunning(scoped, { trigger: 'schedule', now: NOW });
    expect(noMail.ok).toBe(false);
    expect(await scoped.select('documents')).toHaveLength(0);
    expect(await scoped.select('dunningRuns')).toHaveLength(0);
  });

  it('holds back a customer whose money it is holding, and says so', async () => {
    mailWorks();
    await dunning.saveDunning(scoped, rule, DEFAULT_LADDER);
    await overdue('INV-COVERED', 44);

    // An overpayment on another invoice, kept on account at their request.
    const [over] = await scoped.insert('invoices', {
      number: 'INV-OVER',
      customerId,
      status: 'paid',
      lineHaulCents: 100_000,
      totalCents: 100_000,
      paidCents: 300_000,
      issuedAt: new Date('2026-08-01T12:00:00Z'),
    });
    await credit.carryForward(scoped, over!.id, {
      amountCents: 200_000,
      occurredAt: new Date('2026-08-02T12:00:00Z'),
      note: null,
      creditNoteId: null,
    });

    const result = await dunning.runDunning(scoped, { trigger: 'schedule', now: NOW });

    expect(result).toMatchObject({ ok: true, sent: 0 });
    expect(
      result.notices?.find((notice) => notice.invoiceNumber === 'INV-COVERED')?.detail,
    ).toBe('covered_by_credit');
    expect(await scoped.select('documents')).toHaveLength(0);
  });

  it('holds back an invoice with an open claim on its load', async () => {
    mailWorks();
    await dunning.saveDunning(scoped, rule, DEFAULT_LADDER);

    const [load] = await scoped.insert('loads', { number: 'OH-9001', status: 'delivered' });
    await overdue('INV-DISPUTED', 44, { loadId: load!.id });
    await scoped.insert('claims', {
      number: 'CLM-1',
      loadId: load!.id,
      status: 'investigating',
      claimantName: 'Cardinal Logistics Brokerage',
      description: 'Scuff to the nearside rear quarter, noted at delivery.',
      filedAt: new Date('2026-08-10T12:00:00Z'),
      acknowledgeDueAt: new Date('2026-09-09T12:00:00Z'),
      resolveDueAt: new Date('2026-12-08T12:00:00Z'),
    });

    const result = await dunning.runDunning(scoped, { trigger: 'schedule', now: NOW });

    expect(result.sent).toBe(0);
    expect(result.notices?.[0]?.detail).toBe('disputed');
  });

  it('carries on past a failure and keeps the notice it could not send', async () => {
    vi.spyOn(transport, 'mailConfigured').mockReturnValue(true);

    let attempt = 0;
    vi.spyOn(transport, 'send').mockImplementation(async () => {
      attempt += 1;
      return attempt === 1
        ? { ok: false, error: 'Mailbox unavailable' }
        : { ok: true, messageId: '<ok@ridgeline>', accepted: ['x@y.test'], rejected: [] };
    });

    await dunning.saveDunning(scoped, rule, DEFAULT_LADDER);
    await overdue('INV-A', 60);
    await overdue('INV-B', 50);

    const result = await dunning.runDunning(scoped, { trigger: 'schedule', now: NOW });

    expect(result).toMatchObject({ ok: true, sent: 1, failed: 1 });

    const failures = await dunning.failedNotices(scoped, result.runId!);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.detail).toContain('Mailbox unavailable');
    // The document exists, so somebody can send it by hand.
    expect(failures[0]?.documentId).not.toBeNull();
  });

  it('tries the same rung again after a failure rather than skipping it', async () => {
    vi.spyOn(transport, 'mailConfigured').mockReturnValue(true);
    vi.spyOn(transport, 'send').mockResolvedValue({ ok: false, error: 'Connection refused' });

    await dunning.saveDunning(scoped, rule, DEFAULT_LADDER);
    const invoice = await overdue('INV-RETRY', 44);

    await dunning.runDunning(scoped, { trigger: 'schedule', now: NOW });

    mailWorks();
    const later = new Date(NOW.getTime() + 86_400_000);
    await dunning.runDunning(scoped, { trigger: 'schedule', now: later });

    const notices = await dunning.noticesFor(scoped, invoice.id);
    // A failed attempt is not a rung climbed, so rung one went out properly.
    expect(notices.map((notice) => notice.outcome).sort()).toEqual(['failed', 'sent']);
    expect(notices.every((notice) => notice.stageSequence === 1)).toBe(true);
  });
});

describe('stopping it by hand', () => {
  it('pauses an invoice with a reason, and refuses one without', async () => {
    mailWorks();
    await dunning.saveDunning(scoped, rule, DEFAULT_LADDER);
    const invoice = await overdue('INV-PAUSE', 44);

    const blank = await dunning.pauseDunning(scoped, invoice.id, new Date('2026-09-30'), '  ');
    expect(blank.ok).toBe(false);

    const paused = await dunning.pauseDunning(
      scoped,
      invoice.id,
      new Date('2026-09-30T12:00:00Z'),
      'Marta says the cheque goes out Friday',
    );
    expect(paused.ok).toBe(true);

    const result = await dunning.runDunning(scoped, { trigger: 'schedule', now: NOW });
    expect(result.sent).toBe(0);
    expect(result.notices?.[0]?.detail).toBe('paused');
  });

  it('sends a rung on demand, the same letter the sweep would have sent', async () => {
    mailWorks();
    await dunning.saveDunning(scoped, rule, DEFAULT_LADDER);
    const invoice = await overdue('INV-BYHAND', 44);

    const result = await dunning.sendNotice(scoped, invoice.id, DEFAULT_LADDER[0]!, {
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect((await dunning.noticesFor(scoped, invoice.id))[0]?.outcome).toBe('sent');

    // And the sweep then has nothing left to do for it today.
    const swept = await dunning.runDunning(scoped, { trigger: 'schedule', now: NOW });
    expect(swept.sent).toBe(0);
  });
});

describe('the record', () => {
  it('logs the notice and the sweep, and leaves the chain sound', async () => {
    mailWorks();
    await dunning.saveDunning(scoped, rule, DEFAULT_LADDER);
    const invoice = await overdue('INV-AUDIT', 44);

    await dunning.runDunning(scoped, { trigger: 'schedule', now: NOW });

    const perInvoice = await dbModule.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.subject, `invoice:${invoice.id}`));
    expect(perInvoice.map((entry) => entry.action)).toContain(chain.AUDIT.dunningNoticeSent);

    const perOrg = await dbModule.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.subject, `org:${scoped.orgId}`));
    const actions = perOrg.map((entry) => entry.action);
    expect(actions).toContain(chain.AUDIT.dunningSettingsChanged);
    expect(actions).toContain(chain.AUDIT.dunningRunFinished);

    expect((await chain.verifyChain()).ok).toBe(true);
  });

  it('keeps the ladder it was given, and replaces it wholesale', async () => {
    await dunning.saveDunning(scoped, rule, DEFAULT_LADDER);
    expect(await scoped.select('dunningStages')).toHaveLength(3);

    // A rung deleted from the middle actually goes, rather than lingering.
    await dunning.saveDunning(scoped, rule, [DEFAULT_LADDER[0]!, DEFAULT_LADDER[2]!]);
    const ladder = await dunning.ladderFor(scoped);

    expect(ladder).toHaveLength(2);
    expect(ladder.map((stage) => stage.sequence)).toEqual([1, 2]);
    expect(ladder[1]?.label).toBe('Final notice');
  });

  it('defaults to off with the standard ladder', async () => {
    expect(await dunning.ruleFor(scoped)).toEqual(DEFAULT_RULE);
    expect(await dunning.ladderFor(scoped)).toEqual(DEFAULT_LADDER);
  });
});
