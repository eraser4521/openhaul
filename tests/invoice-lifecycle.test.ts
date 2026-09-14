import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { applyMigrations } from './helpers/temp-db';

/**
 * The invoice workflow against a real database.
 *
 * The arithmetic is covered by unit tests; what needs a database is the part
 * that spans rows — that a load cannot carry two live invoices, that voiding
 * hands the load back, that a reissue never reuses a number, and that the paid
 * total is rebuilt from the payment rows rather than incremented.
 *
 * Everything runs against a throwaway file database and blob directory, both
 * pointed at by environment variables that must be set before the modules
 * under test are imported — hence the dynamic imports in `beforeAll`.
 */

let workspace: string;
let scoped: Awaited<ReturnType<typeof import('@/lib/db/scope')['forOrg']>>;
let lifecycle: typeof import('@/lib/invoices/lifecycle');
let credits: typeof import('@/lib/invoices/credits');
let dbModule: typeof import('@/lib/db/client');
let schema: typeof import('@/lib/db/schema');

let orgId: string;
let customerId: string;
let loadId: string;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'openhaul-invoice-'));

  process.env.DATABASE_URL = `file:${path.join(workspace, 'test.db')}`;
  delete process.env.DATABASE_ENCRYPTION_KEY;
  delete process.env.DATABASE_AUTH_TOKEN;
  process.env.BLOB_STORAGE_PATH = path.join(workspace, 'uploads');

  dbModule = await import('@/lib/db/client');
  schema = await import('@/lib/db/schema');

  await dbModule.ready();

  await applyMigrations(dbModule.rawClient);

  const { asOrgId, forOrg } = await import('@/lib/db/scope');
  lifecycle = await import('@/lib/invoices/lifecycle');
  credits = await import('@/lib/invoices/credits');

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
  orgId = org!.id;
  scoped = forOrg(asOrgId(orgId));

  const [customer] = await scoped.insert('customers', {
    name: 'Cardinal Logistics Brokerage',
    kind: 'broker',
    defaultPaymentTerms: '30_days',
  });
  customerId = customer!.id;
});

afterAll(async () => {
  // Close first: Windows will not unlink the -shm and -wal files while the
  // connection holds them. Cleanup of a temp directory is not worth failing
  // the suite over, so a refusal is swallowed.
  dbModule.rawClient.close();
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
});

/** A delivered load with the delivery receipt the invoice gate requires. */
async function deliveredLoad(number: string, figures: Record<string, unknown> = {}) {
  const [load] = await scoped.insert('loads', {
    number,
    status: 'delivered',
    customerId,
    rateCents: 294_000,
    retainUntil: new Date(),
    ...figures,
  });

  await scoped.insert('documents', {
    kind: 'pod',
    loadId: load!.id,
    subject: `load:${load!.id}`,
    title: `Delivery receipt POD-${number}`,
    storageKey: `fixture/${number}`,
    sha256: 'f'.repeat(64),
    byteSize: 1,
    contentType: 'application/pdf',
    version: 1,
    finalizedAt: new Date(),
  });

  return load!.id;
}

describe('the invoice gate', () => {
  it('refuses a load with no delivery receipt', async () => {
    const [bare] = await scoped.insert('loads', {
      number: 'OH-NOPOD',
      status: 'delivered',
      customerId,
      retainUntil: new Date(),
    });

    const gate = await lifecycle.checkInvoiceable(scoped, bare!.id);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('delivery receipt');
  });

  it('refuses a load with no customer to bill', async () => {
    const [orphan] = await scoped.insert('loads', {
      number: 'OH-NOCUST',
      status: 'delivered',
      retainUntil: new Date(),
    });

    const gate = await lifecycle.checkInvoiceable(scoped, orphan!.id);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('nobody to address');
  });

  it('refuses a cancelled load', async () => {
    const id = await deliveredLoad('OH-CANCELLED');
    await scoped.update('loads', eq(schema.loads.id, id), { status: 'cancelled' });

    const gate = await lifecycle.checkInvoiceable(scoped, id);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('cancelled');
  });

  it('refuses a load that does not exist', async () => {
    const gate = await lifecycle.checkInvoiceable(scoped, 'not-an-id');
    expect(gate.ok).toBe(false);
  });
});

describe('raising and voiding', () => {
  it('raises an invoice from the load and marks the load invoiced on issue', async () => {
    loadId = await deliveredLoad('OH-2001');

    const created = await lifecycle.createInvoiceForLoad(scoped, loadId);
    expect(created.ok).toBe(true);
    expect(created.number).toBe('INV-OH-2001');
    expect(created.basis).toBe('rate');

    const invoice = await scoped.selectOne('invoices', eq(schema.invoices.id, created.invoiceId!));
    expect(invoice?.status).toBe('draft');
    expect(invoice?.lineHaulCents).toBe(294_000);
    expect(invoice?.totalCents).toBe(294_000);
    // Terms follow the customer when the load carries none of its own.
    expect(invoice?.terms).toBe('30_days');

    const issued = await lifecycle.issueInvoice(scoped, created.invoiceId!);
    expect(issued.ok).toBe(true);

    const afterIssue = await scoped.selectOne('invoices', eq(schema.invoices.id, created.invoiceId!));
    expect(afterIssue?.status).toBe('sent');
    expect(afterIssue?.issuedAt).not.toBeNull();
    expect(afterIssue?.dueAt).not.toBeNull();
    expect(afterIssue?.documentId).not.toBeNull();

    const load = await scoped.selectOne('loads', eq(schema.loads.id, loadId));
    expect(load?.status).toBe('invoiced');
  });

  it('will not raise a second invoice while one is live', async () => {
    const duplicate = await lifecycle.createInvoiceForLoad(scoped, loadId);
    expect(duplicate.ok).toBe(false);
    expect(duplicate.error).toContain('already on invoice');
  });

  it('will not edit the figures once the customer is holding the document', async () => {
    const [invoice] = await scoped.select('invoices', eq(schema.invoices.loadId, loadId));

    const edit = await lifecycle.updateDraft(scoped, invoice!.id, {
      charges: {
        lineHaulCents: 1,
        fuelSurchargeCents: 0,
        accessorialCents: 0,
        taxCents: 0,
        codCollectedCents: 0,
        depositCents: 0,
      },
      terms: '30_days',
      factoringCompanyName: null,
      factoringNoticeText: null,
      notes: null,
    });

    expect(edit.ok).toBe(false);
    expect(edit.error).toContain('voided and raised again');

    const unchanged = await scoped.selectOne('invoices', eq(schema.invoices.id, invoice!.id));
    expect(unchanged?.lineHaulCents).toBe(294_000);
  });

  it('hands the load back when the invoice is voided, and never reuses the number', async () => {
    const [invoice] = await scoped.select('invoices', eq(schema.invoices.loadId, loadId));

    const voided = await lifecycle.voidInvoice(scoped, invoice!.id, 'Wrong rate on the confirmation.');
    expect(voided.ok).toBe(true);

    const after = await scoped.selectOne('invoices', eq(schema.invoices.id, invoice!.id));
    expect(after?.status).toBe('void');
    expect(after?.voidReason).toBe('Wrong rate on the confirmation.');

    const load = await scoped.selectOne('loads', eq(schema.loads.id, loadId));
    expect(load?.status).toBe('delivered');

    const reissued = await lifecycle.createInvoiceForLoad(scoped, loadId);
    expect(reissued.ok).toBe(true);
    expect(reissued.number).toBe('INV-OH-2001-2');
  });

  it('refuses to void without a reason', async () => {
    const live = (await scoped.select('invoices', eq(schema.invoices.loadId, loadId))).find(
      (i) => i.status !== 'void',
    );

    const result = await lifecycle.voidInvoice(scoped, live!.id, '   ');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('why');
  });

  it('refuses to void the same invoice twice', async () => {
    const already = (await scoped.select('invoices', eq(schema.invoices.loadId, loadId))).find(
      (i) => i.status === 'void',
    );

    const result = await lifecycle.voidInvoice(scoped, already!.id, 'Again.');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('already void');
  });
});

describe('payments', () => {
  let invoiceId: string;

  beforeAll(async () => {
    const id = await deliveredLoad('OH-3001', { rateCents: 100_000 });
    const created = await lifecycle.createInvoiceForLoad(scoped, id);
    await lifecycle.issueInvoice(scoped, created.invoiceId!);
    invoiceId = created.invoiceId!;
  });

  it('refuses a payment against a draft, which nobody has been asked to pay', async () => {
    const draftLoad = await deliveredLoad('OH-3002');
    const draft = await lifecycle.createInvoiceForLoad(scoped, draftLoad);

    const result = await lifecycle.recordPayment(scoped, draft.invoiceId!, {
      amountCents: 1000,
      method: 'ach',
      reference: null,
      receivedAt: new Date(),
      notes: null,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not been issued');
  });

  it('records a part payment and leaves the balance outstanding', async () => {
    const result = await lifecycle.recordPayment(scoped, invoiceId, {
      amountCents: 40_000,
      method: 'ach',
      reference: 'ACH-1',
      receivedAt: new Date(),
      notes: null,
    });

    expect(result.ok).toBe(true);
    expect(result.paidCents).toBe(40_000);
    expect(result.balanceCents).toBe(60_000);

    const invoice = await scoped.selectOne('invoices', eq(schema.invoices.id, invoiceId));
    expect(invoice?.status).toBe('partially_paid');
    expect(invoice?.paidAt).toBeNull();
  });

  it('settles the invoice and the load when the balance is cleared', async () => {
    const result = await lifecycle.recordPayment(scoped, invoiceId, {
      amountCents: 60_000,
      method: 'check',
      reference: 'CHK-882',
      receivedAt: new Date(),
      notes: null,
    });

    expect(result.ok).toBe(true);
    expect(result.balanceCents).toBe(0);

    const invoice = await scoped.selectOne('invoices', eq(schema.invoices.id, invoiceId));
    expect(invoice?.status).toBe('paid');
    expect(invoice?.paidAt).not.toBeNull();

    const load = await scoped.selectOne('loads', eq(schema.loads.id, invoice!.loadId!));
    expect(load?.status).toBe('paid');
  });

  it('rebuilds the paid total from the payment rows rather than incrementing', async () => {
    /*
     * The guard against a stale figure: delete a payment behind the lifecycle's
     * back, record another, and the total must reflect what is actually there.
     * An incremented column would keep the deleted money forever.
     */
    const rows = await scoped.select('payments', eq(schema.payments.invoiceId, invoiceId));
    await dbModule.db.delete(schema.payments).where(eq(schema.payments.id, rows[0]!.id));

    const result = await lifecycle.recordPayment(scoped, invoiceId, {
      amountCents: 5_000,
      method: 'ach',
      reference: 'ACH-2',
      receivedAt: new Date(),
      notes: null,
    });

    // 100_000 total, one 40_000 payment removed, 60_000 + 5_000 remaining.
    expect(result.paidCents).toBe(65_000);
    expect(result.balanceCents).toBe(35_000);

    const invoice = await scoped.selectOne('invoices', eq(schema.invoices.id, invoiceId));
    expect(invoice?.status).toBe('partially_paid');
  });

  it('refuses to void an invoice that money has been received against', async () => {
    const result = await lifecycle.voidInvoice(scoped, invoiceId, 'Changed my mind.');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Raise a credit');
  });

  it('accepts an overpayment and settles rather than silently rejecting it', async () => {
    const result = await lifecycle.recordPayment(scoped, invoiceId, {
      amountCents: 50_000,
      method: 'ach',
      reference: 'ACH-3',
      receivedAt: new Date(),
      notes: 'Paid twice.',
    });

    expect(result.ok).toBe(true);
    expect(result.paidCents).toBe(115_000);
    expect(result.balanceCents).toBe(-15_000);

    const invoice = await scoped.selectOne('invoices', eq(schema.invoices.id, invoiceId));
    expect(invoice?.status).toBe('paid');
  });

  it('refuses a zero payment, which records nothing and hides a typo', async () => {
    const result = await lifecycle.recordPayment(scoped, invoiceId, {
      amountCents: 0,
      method: 'ach',
      reference: null,
      receivedAt: new Date(),
      notes: null,
    });

    expect(result.ok).toBe(false);
  });
});

describe('the issued document', () => {
  it('freezes a PDF whose bytes match the hash recorded against it', async () => {
    const id = await deliveredLoad('OH-4001', { tariffCents: 320_000, fuelSurchargeCents: 18_000 });
    const created = await lifecycle.createInvoiceForLoad(scoped, id);

    expect(created.basis).toBe('tariff');

    const issued = await lifecycle.issueInvoice(scoped, created.invoiceId!);
    expect(issued.ok).toBe(true);

    const document = await scoped.selectOne(
      'documents',
      eq(schema.documents.id, issued.documentId!),
    );
    expect(document?.kind).toBe('invoice');
    expect(document?.finalizedAt).not.toBeNull();

    const { createHash } = await import('node:crypto');
    const bytes = await readFile(path.join(workspace, 'uploads', document!.storageKey));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(document!.sha256);
    expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');

    /*
     * The remit-to block comes from the organisation record, which is why it
     * is editable in settings: an invoice naming a carrier with no address
     * gives the customer nowhere to send a check.
     */
    const { inflateSync } = await import('node:zlib');
    const { PDFDocument, PDFName, PDFRawStream } = await import('pdf-lib');
    const pdf = await PDFDocument.load(bytes);

    let text = '';
    for (const [, object] of pdf.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFRawStream)) continue;
      const filter = object.dict.get(PDFName.of('Filter'));
      if (!filter || !String(filter).includes('FlateDecode')) continue;
      try {
        const stream = inflateSync(Buffer.from(object.contents)).toString('latin1');
        for (const match of stream.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
          text += Buffer.from(match[1] ?? '', 'hex').toString('latin1');
        }
      } catch {
        continue;
      }
    }

    expect(text).toContain('Ridgeline Auto Transport LLC');
    expect(text).toContain('4400 Meacham Blvd');
    expect(text).toContain('Fort Worth TX 76106');
    expect(text).toContain('Cardinal Logistics Brokerage');
    // Billed the tariff, and the fuel surcharge kept its own line.
    expect(text).toContain('$3,200.00');
    expect(text).toContain('$180.00');
    expect(text).toContain('$3,380.00');
  });

  it('will not issue the same invoice twice', async () => {
    const [invoice] = await scoped.select('invoices', eq(schema.invoices.status, 'sent'));
    const again = await lifecycle.issueInvoice(scoped, invoice!.id);
    expect(again.ok).toBe(false);
    expect(again.error).toContain('already been issued');
  });
});

/* -------------------------------------------------------------------------
 * Credit notes
 * ---------------------------------------------------------------------- */

describe('credit notes', () => {
  let invoiceId: string;
  let loadId: string;

  beforeAll(async () => {
    loadId = await deliveredLoad('OH-6001', { rateCents: 100_000 });
    const created = await lifecycle.createInvoiceForLoad(scoped, loadId);
    await lifecycle.issueInvoice(scoped, created.invoiceId!);
    invoiceId = created.invoiceId!;
  });

  it('refuses to credit a draft, which can simply be corrected', async () => {
    const draftLoad = await deliveredLoad('OH-6002');
    const draft = await lifecycle.createInvoiceForLoad(scoped, draftLoad);

    const gate = await credits.checkCreditable(scoped, draft.invoiceId!);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('not been issued');
  });

  it('credits an issued invoice without touching what it says', async () => {
    /*
     * The separation the whole design rests on. The customer holds a document
     * stating $1,000.00, and that stays true — only what is owed moves.
     */
    const result = await credits.raiseCreditNote(scoped, {
      invoiceId,
      reason: 'rate_adjustment',
      detail: 'Detention withdrawn after reviewing the gate log.',
      amountCents: 25_000,
    });

    expect(result.ok).toBe(true);
    expect(result.number).toBe('CN-INV-OH-6001');
    expect(result.balanceCents).toBe(75_000);

    const invoice = await scoped.selectOne('invoices', eq(schema.invoices.id, invoiceId));
    expect(invoice?.totalCents).toBe(100_000);
    expect(invoice?.creditedCents).toBe(25_000);
  });

  it('refuses a credit larger than what is left of the invoice', async () => {
    const result = await credits.raiseCreditNote(scoped, {
      invoiceId,
      reason: 'goodwill',
      detail: 'Too much.',
      amountCents: 90_000,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('left to');
  });

  it('refuses a credit with no explanation', async () => {
    const result = await credits.raiseCreditNote(scoped, {
      invoiceId,
      reason: 'other',
      detail: '   ',
      amountCents: 1_000,
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a zero or negative credit', async () => {
    expect(
      (await credits.raiseCreditNote(scoped, {
        invoiceId,
        reason: 'other',
        detail: 'Nothing.',
        amountCents: 0,
      })).ok,
    ).toBe(false);
  });

  it('settles the invoice when credits and payments clear it', async () => {
    await lifecycle.recordPayment(scoped, invoiceId, {
      amountCents: 75_000,
      method: 'ach',
      reference: 'ACH-6001',
      receivedAt: new Date(),
      notes: null,
    });

    const invoice = await scoped.selectOne('invoices', eq(schema.invoices.id, invoiceId));
    expect(invoice?.status).toBe('paid');
  });

  it('puts the money back on the balance when a credit is withdrawn', async () => {
    const [note] = await scoped.select(
      'creditNotes',
      eq(schema.creditNotes.invoiceId, invoiceId),
    );

    const voided = await credits.voidCreditNote(scoped, note!.id, 'Raised against the wrong load.');
    expect(voided.ok).toBe(true);

    const invoice = await scoped.selectOne('invoices', eq(schema.invoices.id, invoiceId));
    expect(invoice?.creditedCents).toBe(0);
    // Paid 75,000 of 100,000, so it is owed again.
    expect(invoice?.status).toBe('partially_paid');
  });

  it('refuses to withdraw a credit twice, or without a reason', async () => {
    const [note] = await scoped.select(
      'creditNotes',
      eq(schema.creditNotes.invoiceId, invoiceId),
    );

    expect((await credits.voidCreditNote(scoped, note!.id, 'Again.')).ok).toBe(false);

    const fresh = await credits.raiseCreditNote(scoped, {
      invoiceId,
      reason: 'billing_error',
      detail: 'Corrected rate.',
      amountCents: 5_000,
    });
    expect((await credits.voidCreditNote(scoped, fresh.creditNoteId!, '  ')).ok).toBe(false);
  });

  it('never reuses a credit note number after one was withdrawn', async () => {
    const again = await credits.raiseCreditNote(scoped, {
      invoiceId,
      reason: 'goodwill',
      detail: 'Second credit.',
      amountCents: 1_000,
    });
    expect(again.number).toBe('CN-INV-OH-6001-3');
  });

  it('refuses to credit a voided invoice', async () => {
    const otherLoad = await deliveredLoad('OH-6003');
    const other = await lifecycle.createInvoiceForLoad(scoped, otherLoad);
    await lifecycle.issueInvoice(scoped, other.invoiceId!);
    await lifecycle.voidInvoice(scoped, other.invoiceId!, 'Wrong customer.');

    const gate = await credits.checkCreditable(scoped, other.invoiceId!);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('voided');
  });

  it('will not attach a claim raised against a different load', async () => {
    const { fileClaim } = await import('@/lib/claims/lifecycle');
    const elsewhere = await deliveredLoad('OH-6004');

    const claim = await fileClaim(scoped, {
      loadId: elsewhere,
      vehicleId: null,
      claimantName: 'Somebody Else',
      claimantEmail: null,
      demandAmountCents: 1_000,
      description: 'Damage on another load.',
      filedAt: new Date(),
    });

    const result = await credits.raiseCreditNote(scoped, {
      invoiceId,
      reason: 'damage_offset',
      detail: 'Offsetting the wrong claim.',
      amountCents: 1_000,
      claimId: claim.claimId,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('different load');
  });

  it('freezes a credit note document whose bytes match its hash', async () => {
    const { buildCreditDocument } = await import('@/lib/invoices/credit-document');
    const [note] = await credits.creditsFor(scoped, invoiceId);

    const document = await buildCreditDocument(scoped, note!.id);
    expect(document.ok).toBe(true);

    const row = await scoped.selectOne('documents', eq(schema.documents.id, document.documentId!));
    expect(row?.kind).toBe('credit_note');

    const { createHash } = await import('node:crypto');
    const bytes = await readFile(path.join(workspace, 'uploads', row!.storageKey));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(row!.sha256);
  });
});
