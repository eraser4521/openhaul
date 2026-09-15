import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  agedTotals,
  before,
  describeWindow,
  inOrder,
  openItems,
  reconcile,
  sumDue,
  sumHeld,
  totalsFor,
  windowStart,
  withRunningBalance,
  within,
  type StatementEntry,
} from '@/lib/invoices/statement';
import { renderStatement } from '@/lib/documents/statement';
import { compose } from '@/lib/email/compose';
import { isPdf, pdfText } from './helpers/pdf-text';
import { applyMigrations } from './helpers/temp-db';

/**
 * The statement of account.
 *
 * Its only value is that a customer can reconcile it. Opening balance, every
 * movement since, closing balance — and if that does not close, the document
 * turns a collections call into an argument about the document. So most of
 * what follows is about the arithmetic closing, and about the two ways a
 * statement can lie: showing a draft nobody has been sent, or hiding an old
 * debt because it fell outside the period.
 */

const FROM = new Date('2026-06-01T00:00:00Z');
const NOW = new Date('2026-09-14T12:00:00Z');

function entry(over: Partial<StatementEntry> & Pick<StatementEntry, 'at' | 'kind'>): StatementEntry {
  return {
    reference: 'INV-1',
    detail: null,
    dueCents: 0,
    heldCents: 0,
    ...over,
  };
}

/* -------------------------------------------------------------------------
 * The arithmetic
 * ---------------------------------------------------------------------- */

describe('the ledger', () => {
  it('sorts oldest first and breaks ties the same way twice', () => {
    const same = new Date('2026-07-01T00:00:00Z');
    const entries = [
      entry({ at: new Date('2026-08-01T00:00:00Z'), kind: 'payment', reference: 'INV-9' }),
      entry({ at: same, kind: 'payment', reference: 'INV-3' }),
      entry({ at: same, kind: 'invoice', reference: 'INV-2' }),
    ];

    const once = inOrder(entries).map((row) => row.reference);
    const twice = inOrder(entries.slice().reverse()).map((row) => row.reference);

    expect(once).toEqual(['INV-2', 'INV-3', 'INV-9']);
    expect(twice).toEqual(once);
  });

  it('puts same-day movements in the order they could have happened', () => {
    /*
     * A carry-forward only exists because a payment overpaid something. Sorted
     * alphabetically it lands first, and the running balance climbs above
     * anything the customer was ever billed before falling back — which reads
     * as an error and gets queried rather than paid.
     */
    const day = new Date('2026-07-01T00:00:00Z');
    const entries = [
      entry({ at: day, kind: 'credit_kept', reference: 'INV-1', dueCents: 50_000 }),
      entry({ at: day, kind: 'payment', reference: 'INV-1', dueCents: -344_000 }),
      entry({ at: day, kind: 'invoice', reference: 'INV-1', dueCents: 294_000 }),
    ];

    const ordered = inOrder(entries);
    expect(ordered.map((row) => row.kind)).toEqual(['invoice', 'payment', 'credit_kept']);

    const running = withRunningBalance(ordered, 0).map((row) => row.balanceCents);
    expect(running).toEqual([294_000, -50_000, 0]);
    // Never above what was billed.
    expect(Math.max(...running)).toBe(294_000);
  });

  it('splits on the period boundary with nothing falling outside both', () => {
    const entries = [
      entry({ at: new Date('2026-05-31T23:59:59Z'), kind: 'invoice', dueCents: 100 }),
      entry({ at: FROM, kind: 'invoice', dueCents: 200 }),
      // Dated in the future by a typo. It is still inside the period, because
      // there is no upper bound — otherwise it would unbalance the document.
      entry({ at: new Date('2030-01-01T00:00:00Z'), kind: 'payment', dueCents: -50 }),
    ];

    expect(sumDue(before(entries, FROM))).toBe(100);
    expect(sumDue(within(entries, FROM))).toBe(150);
    expect(sumDue(before(entries, FROM)) + sumDue(within(entries, FROM))).toBe(sumDue(entries));
  });

  it('closes: opening plus the period is the closing balance', () => {
    const entries = [
      entry({ at: new Date('2026-04-01T00:00:00Z'), kind: 'invoice', dueCents: 294_000 }),
      entry({ at: new Date('2026-06-10T00:00:00Z'), kind: 'invoice', dueCents: 187_500 }),
      entry({ at: new Date('2026-06-20T00:00:00Z'), kind: 'payment', dueCents: -294_000 }),
      entry({ at: new Date('2026-07-02T00:00:00Z'), kind: 'credit_note', dueCents: -27_500 }),
    ];

    const totals = totalsFor(entries, FROM);

    expect(totals.openingDueCents).toBe(294_000);
    expect(totals.invoicedCents).toBe(187_500);
    expect(totals.paidCents).toBe(294_000);
    expect(totals.creditedCents).toBe(27_500);
    expect(totals.closingDueCents).toBe(294_000 + 187_500 - 294_000 - 27_500);
    expect(totals.closingDueCents).toBe(sumDue(entries));
  });

  it('tracks what is owed and what is held as two separate balances', () => {
    /*
     * A carried-forward overpayment moves between the two ledgers at once:
     * the invoice it came off settles, and the carrier starts holding the
     * money. Netting them into one figure loses which is which.
     */
    const entries = [
      entry({ at: new Date('2026-06-05T00:00:00Z'), kind: 'invoice', dueCents: 294_000 }),
      entry({ at: new Date('2026-06-06T00:00:00Z'), kind: 'payment', dueCents: -344_000 }),
      entry({
        at: new Date('2026-06-07T00:00:00Z'),
        kind: 'credit_kept',
        dueCents: 50_000,
        heldCents: 50_000,
      }),
      entry({ at: new Date('2026-07-01T00:00:00Z'), kind: 'invoice', dueCents: 120_000 }),
      entry({
        at: new Date('2026-07-02T00:00:00Z'),
        kind: 'credit_applied',
        dueCents: -50_000,
        heldCents: -50_000,
      }),
    ];

    const totals = totalsFor(entries, FROM);

    expect(totals.closingDueCents).toBe(70_000);
    expect(totals.closingHeldCents).toBe(0);
    expect(totals.keptCents).toBe(50_000);
    expect(totals.appliedCents).toBe(50_000);
    expect(sumHeld(entries)).toBe(0);
  });

  it('nets a withdrawn credit note against the one it withdraws', () => {
    const entries = [
      entry({ at: new Date('2026-06-05T00:00:00Z'), kind: 'invoice', dueCents: 347_500 }),
      entry({ at: new Date('2026-06-10T00:00:00Z'), kind: 'credit_note', dueCents: -27_500 }),
      entry({ at: new Date('2026-06-20T00:00:00Z'), kind: 'credit_note_void', dueCents: 27_500 }),
    ];

    const totals = totalsFor(entries, FROM);

    // Both movements are shown, so a customer holding the note can find it —
    // and the period's credited figure is what was actually forgiven.
    expect(totals.creditedCents).toBe(0);
    expect(totals.closingDueCents).toBe(347_500);
  });

  it('shows a running balance beside each movement', () => {
    const rows = withRunningBalance(
      [
        entry({ at: FROM, kind: 'invoice', dueCents: 100_000 }),
        entry({ at: NOW, kind: 'payment', dueCents: -40_000 }),
      ],
      25_000,
    );

    expect(rows.map((row) => row.balanceCents)).toEqual([125_000, 85_000]);
  });
});

describe('what is still open', () => {
  const invoice = (over: Record<string, unknown> = {}) => ({
    number: 'INV-1',
    issuedAt: new Date('2026-06-01T00:00:00Z'),
    dueAt: new Date('2026-07-01T00:00:00Z'),
    totalCents: 100_000,
    paidCents: 0,
    ...over,
  });

  it('drops anything settled, however it was settled', () => {
    const items = openItems(
      [
        invoice({ number: 'PAID', paidCents: 100_000 }),
        invoice({ number: 'CREDITED', creditedCents: 100_000 }),
        invoice({ number: 'FROM-ACCOUNT', appliedCreditCents: 100_000 }),
        invoice({ number: 'OPEN' }),
      ],
      NOW,
    );

    expect(items.map((item) => item.invoiceNumber)).toEqual(['OPEN']);
  });

  it('never hides an old debt behind the statement period', () => {
    /*
     * The one thing a statement must not say by accident is "nothing older
     * is outstanding". Open items are deliberately not filtered by period.
     */
    const ancient = invoice({
      number: 'OLD',
      issuedAt: new Date('2024-01-01T00:00:00Z'),
      dueAt: new Date('2024-02-01T00:00:00Z'),
    });

    const items = openItems([ancient], NOW);

    expect(items).toHaveLength(1);
    expect(items[0]?.bucket).toBe('90_plus');
    expect(items[0]?.daysLate).toBeGreaterThan(500);
  });

  it('orders by due date so the oldest is chased first', () => {
    const items = openItems(
      [
        invoice({ number: 'B', dueAt: new Date('2026-08-01T00:00:00Z') }),
        invoice({ number: 'A', dueAt: new Date('2026-07-01T00:00:00Z') }),
      ],
      NOW,
    );

    expect(items.map((item) => item.invoiceNumber)).toEqual(['A', 'B']);
  });

  it('ages by lateness, not by how old the invoice is', () => {
    const items = openItems(
      [
        invoice({ number: 'NOT-DUE', dueAt: new Date('2026-10-01T00:00:00Z') }),
        invoice({ number: 'LATE', dueAt: new Date('2026-08-20T00:00:00Z') }),
      ],
      NOW,
    );

    const aged = agedTotals(items);
    expect(aged.current).toBe(100_000);
    expect(aged['1_30']).toBe(100_000);
    expect(aged['31_60']).toBe(0);
  });
});

describe('the reconciliation', () => {
  const totals = totalsFor(
    [entry({ at: FROM, kind: 'invoice', dueCents: 294_000 })],
    FROM,
  );

  it('passes when both ways of counting agree', () => {
    expect(reconcile(totals, 294_000)).toMatchObject({ ok: true, differenceCents: 0 });
  });

  it('fails and names the gap when they do not', () => {
    expect(reconcile(totals, 250_000)).toMatchObject({
      ok: false,
      fromEntriesCents: 294_000,
      fromInvoicesCents: 250_000,
      differenceCents: 44_000,
    });
  });
});

describe('the period', () => {
  it('starts at midnight UTC so the boundary is not a time of day', () => {
    const start = windowStart(90, NOW);
    expect(start.toISOString()).toBe('2026-06-16T00:00:00.000Z');
  });

  it('describes itself in months where that reads better than days', () => {
    expect(describeWindow(30)).toBe('Last 30 days');
    expect(describeWindow(90)).toBe('Last 3 months');
    expect(describeWindow(365)).toBe('Last 12 months');
    expect(describeWindow(45)).toBe('Last 45 days');
  });
});

/* -------------------------------------------------------------------------
 * The document
 * ---------------------------------------------------------------------- */

describe('the page', () => {
  const carrier = {
    name: 'Ridgeline Auto Transport LLC',
    addressLine1: '4400 Meacham Blvd',
    city: 'Fort Worth',
    state: 'TX',
    postalCode: '76106',
  };

  const billTo = {
    name: 'Cardinal Logistics Brokerage',
    contactName: 'Accounts Payable',
    city: 'Dallas',
    state: 'TX',
  };

  const entries = [
    entry({ at: new Date('2026-06-05T00:00:00Z'), kind: 'invoice', reference: 'INV-OH-1001', dueCents: 294_000 }),
    entry({ at: new Date('2026-06-20T00:00:00Z'), kind: 'payment', reference: 'INV-OH-1001', dueCents: -344_000 }),
    entry({
      at: new Date('2026-06-21T00:00:00Z'),
      kind: 'credit_kept',
      reference: 'INV-OH-1001',
      dueCents: 50_000,
      heldCents: 50_000,
    }),
    entry({ at: new Date('2026-08-01T00:00:00Z'), kind: 'invoice', reference: 'INV-OH-1002', dueCents: 187_500 }),
  ];

  async function render() {
    const totals = totalsFor(entries, FROM);
    const items = openItems(
      [
        {
          number: 'INV-OH-1002',
          issuedAt: new Date('2026-08-01T00:00:00Z'),
          dueAt: new Date('2026-08-31T00:00:00Z'),
          totalCents: 187_500,
          paidCents: 0,
        },
      ],
      NOW,
    );

    return renderStatement({
      issuedAt: NOW,
      periodFrom: FROM,
      periodLabel: 'Last 3 months',
      carrier,
      billTo,
      currency: 'USD',
      totals,
      openItems: items,
      aged: agedTotals(items),
      activity: withRunningBalance(within(entries, FROM), totals.openingDueCents),
    });
  }

  it('is a PDF that says what it is and what it is not', async () => {
    const bytes = await render();
    expect(isPdf(bytes)).toBe(true);

    const text = await pdfText(bytes);
    expect(text).toContain('STATEMENT OF ACCOUNT');
    // An AP department that processes a statement as a payable pays twice.
    expect(text).toContain('THIS IS NOT AN INVOICE');
  });

  it('prints the balance, the open invoice and how late it is', async () => {
    const text = await pdfText(await render());

    expect(text).toContain('$1,875.00');
    expect(text).toContain('INV-OH-1002');
    expect(text).toContain('14d late');
  });

  it('tells the customer what is being held for them', async () => {
    const text = await pdfText(await render());

    expect(text).toContain('holding $500.00');
    expect(text).toContain('Payable after credit');
    expect(text).toContain('$1,375.00');
  });

  it('shows the movements with a running balance', async () => {
    const text = await pdfText(await render());

    expect(text).toContain('Payment received');
    expect(text).toContain('Kept on account');
    expect(text).toContain('$3,440.00');
  });
});

describe('the covering email', () => {
  it('leads with what is outstanding and mentions the credit', () => {
    const message = compose('statement', {
      carrierName: 'Ridgeline Auto Transport LLC',
      reference: 'Statement',
      recipientName: 'Accounts Payable',
      periodLabel: 'Last 3 months',
      balanceCents: 187_500,
      heldCents: 50_000,
      openItemCount: 1,
    });

    expect(message.subject).toContain('$1,875.00 outstanding');
    expect(message.body).toContain('not an invoice');
    expect(message.body).toContain('holding $500.00');
  });

  it('says so plainly when nothing is owed', () => {
    const message = compose('statement', {
      carrierName: 'Ridgeline Auto Transport LLC',
      reference: 'Statement',
      balanceCents: 0,
      heldCents: 0,
      openItemCount: 0,
    });

    expect(message.subject).toContain('nothing outstanding');
    expect(message.body).toContain('Nothing is outstanding');
  });
});

/* -------------------------------------------------------------------------
 * Against a real database
 * ---------------------------------------------------------------------- */

let workspace: string;
let scoped: Awaited<ReturnType<(typeof import('@/lib/db/scope'))['forOrg']>>;
let dbModule: typeof import('@/lib/db/client');
let schema: typeof import('@/lib/db/schema');
let statement: typeof import('@/lib/invoices/statement-document');
let credit: typeof import('@/lib/invoices/customer-credit');
let chain: typeof import('@/lib/audit/chain');

let customerId: string;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'openhaul-statement-'));
  process.env.DATABASE_URL = `file:${path.join(workspace, 'test.db')}`;
  delete process.env.DATABASE_ENCRYPTION_KEY;
  process.env.BLOB_STORAGE_PATH = path.join(workspace, 'uploads');

  dbModule = await import('@/lib/db/client');
  schema = await import('@/lib/db/schema');
  await dbModule.ready();
  await applyMigrations(dbModule.rawClient);

  const { asOrgId, forOrg } = await import('@/lib/db/scope');
  statement = await import('@/lib/invoices/statement-document');
  credit = await import('@/lib/invoices/customer-credit');
  chain = await import('@/lib/audit/chain');

  const [org] = await dbModule.db
    .insert(schema.organizations)
    .values({
      legalName: 'Ridgeline Auto Transport LLC',
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
    email: 'ap@cardinal.test',
  });
  customerId = customer!.id;
});

afterAll(async () => {
  dbModule.rawClient.close();
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  for (const table of [
    'statements',
    'customerCredits',
    'refunds',
    'creditNotes',
    'payments',
    'invoices',
    'documents',
  ] as const) {
    for (const row of await scoped.select(table)) {
      const column = (schema[table] as unknown as { id: Parameters<typeof eq>[0] }).id;
      await scoped.remove(table, eq(column, row.id));
    }
  }
});

async function issued(number: string, over: Record<string, unknown> = {}) {
  const [row] = await scoped.insert('invoices', {
    number,
    customerId,
    status: 'sent',
    lineHaulCents: 294_000,
    totalCents: 294_000,
    issuedAt: new Date('2026-07-01T12:00:00Z'),
    dueAt: new Date('2026-07-31T12:00:00Z'),
    ...over,
  });
  return row!;
}

describe('gathering an account', () => {
  it('never shows a draft or a void invoice', async () => {
    await issued('INV-DRAFT', { status: 'draft' });
    await issued('INV-VOID', { status: 'void' });
    await issued('INV-REAL');

    const { entries } = await statement.gatherEntries(scoped, customerId);

    expect(entries.map((row) => row.reference)).toEqual(['INV-REAL']);
  });

  it('reconciles a full account against the invoices themselves', async () => {
    const one = await issued('INV-1');
    await scoped.insert('payments', {
      invoiceId: one.id,
      amountCents: 344_000,
      method: 'ach',
      receivedAt: new Date('2026-07-10T12:00:00Z'),
    });
    await scoped.update('invoices', eq(schema.invoices.id, one.id), {
      paidCents: 344_000,
      status: 'paid',
    });

    await credit.carryForward(scoped, one.id, {
      amountCents: 50_000,
      occurredAt: new Date('2026-07-11T12:00:00Z'),
      note: null,
      creditNoteId: null,
    });

    const two = await issued('INV-2', { lineHaulCents: 120_000, totalCents: 120_000 });
    await credit.applyCredit(scoped, two.id, {
      amountCents: 50_000,
      occurredAt: new Date('2026-07-20T12:00:00Z'),
      note: null,
    });

    const view = await statement.statementView(scoped, customerId, {
      windowDays: 365,
      now: NOW,
    });

    expect(view.reconciliation.ok).toBe(true);
    expect(view.totals.closingDueCents).toBe(70_000);
    expect(view.totals.closingHeldCents).toBe(0);
    expect(view.items.map((item) => item.invoiceNumber)).toEqual(['INV-2']);
  });

  it('puts a withdrawn credit note on the statement twice', async () => {
    const one = await issued('INV-3');
    await scoped.insert('creditNotes', {
      number: 'CN-INV-3',
      invoiceId: one.id,
      customerId,
      reason: 'billing_error',
      detail: 'Detention withdrawn',
      amountCents: 27_500,
      issuedAt: new Date('2026-07-05T12:00:00Z'),
      voidedAt: new Date('2026-07-09T12:00:00Z'),
      voidReason: 'Gate log was for the wrong day',
    });

    const { entries } = await statement.gatherEntries(scoped, customerId);
    const kinds = entries.map((row) => row.kind);

    expect(kinds).toContain('credit_note');
    expect(kinds).toContain('credit_note_void');
    // The invoice still stands at its full figure.
    expect(entries.reduce((sum, row) => sum + row.dueCents, 0)).toBe(294_000);
  });
});

describe('producing one', () => {
  it('freezes a document, records what it said, and logs it', async () => {
    const one = await issued('INV-10');
    await scoped.insert('payments', {
      invoiceId: one.id,
      amountCents: 100_000,
      method: 'ach',
      receivedAt: new Date('2026-07-10T12:00:00Z'),
    });
    await scoped.update('invoices', eq(schema.invoices.id, one.id), {
      paidCents: 100_000,
      status: 'partially_paid',
    });

    const result = await statement.buildStatement(scoped, customerId, {
      windowDays: 365,
      now: NOW,
    });

    expect(result).toMatchObject({ ok: true, balanceCents: 194_000, heldCents: 0 });

    const [row] = await scoped.select('statements');
    expect(row).toMatchObject({
      customerId,
      windowDays: 365,
      balanceCents: 194_000,
      openItemCount: 1,
      documentId: result.documentId,
    });

    const [document] = await scoped.select('documents');
    expect(document?.kind).toBe('statement');
    expect(document?.subject).toBe(`statement:${row!.id}`);
    expect(document?.finalizedAt).not.toBeNull();

    const bytes = await (await import('@/lib/storage/blob-store'))
      .blobStore()
      .get(document!.storageKey);
    expect(bytes).not.toBeNull();
    expect(await pdfText(bytes!)).toContain('$1,940.00');

    const entries = await dbModule.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.subject, `customer:${customerId}`));
    expect(entries.some((e) => e.action === chain.AUDIT.statementIssued)).toBe(true);

    expect((await chain.verifyChain()).ok).toBe(true);
  });

  it('refuses to produce one that does not reconcile', async () => {
    const one = await issued('INV-11');

    /*
     * A payment with no invoice movement behind it: the invoice's own paid
     * figure says one thing, the ledger another. Exactly the shape of a bug
     * that would otherwise reach a customer as a statement they dispute.
     */
    await scoped.update('invoices', eq(schema.invoices.id, one.id), { paidCents: 50_000 });

    const result = await statement.buildStatement(scoped, customerId, {
      windowDays: 365,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('does not reconcile');
    expect(await scoped.select('documents')).toHaveLength(0);
    expect(await scoped.select('statements')).toHaveLength(0);
  });

  it('produces a nil statement rather than refusing one', async () => {
    const result = await statement.buildStatement(scoped, customerId, {
      windowDays: 90,
      now: NOW,
    });

    expect(result).toMatchObject({ ok: true, balanceCents: 0, entryCount: 0 });

    const [document] = await scoped.select('documents');
    const bytes = await (await import('@/lib/storage/blob-store'))
      .blobStore()
      .get(document!.storageKey);
    expect(bytes).not.toBeNull();
    expect(await pdfText(bytes!)).toContain('Nothing is outstanding');
  });

  it('lists what has been produced, newest first', async () => {
    await statement.buildStatement(scoped, customerId, { windowDays: 30, now: NOW });
    await statement.buildStatement(scoped, customerId, {
      windowDays: 90,
      now: new Date(NOW.getTime() + 60_000),
    });

    const rows = await statement.statementsFor(scoped, customerId);
    expect(rows.map((row) => row.windowDays)).toEqual([90, 30]);
  });

  it('drafts the email from the statement, not from the account as it stands', async () => {
    const one = await issued('INV-20');
    await scoped.insert('payments', {
      invoiceId: one.id,
      amountCents: 100_000,
      method: 'ach',
      receivedAt: new Date('2026-07-10T12:00:00Z'),
    });
    await scoped.update('invoices', eq(schema.invoices.id, one.id), {
      paidCents: 100_000,
      status: 'partially_paid',
    });

    const built = await statement.buildStatement(scoped, customerId, {
      windowDays: 365,
      now: NOW,
    });

    /*
     * The account moves after the statement is frozen. The covering email has
     * to describe the attachment, not the account — otherwise the reader has
     * two different balances in front of them for the same thing.
     */
    await scoped.insert('payments', {
      invoiceId: one.id,
      amountCents: 194_000,
      method: 'ach',
      receivedAt: NOW,
    });
    await scoped.update('invoices', eq(schema.invoices.id, one.id), {
      paidCents: 294_000,
      status: 'paid',
    });

    const send = await import('@/lib/documents/send');
    const draft = await send.draftFor(scoped, built.documentId!);

    expect(draft?.to).toEqual(['ap@cardinal.test']);
    expect(draft?.recipientLabel).toBe('Cardinal Logistics Brokerage');
    expect(draft?.subject).toContain('$1,940.00 outstanding');
    expect(draft?.subject).toContain('Last 12 months');
  });
});
