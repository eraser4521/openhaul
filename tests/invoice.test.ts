import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import {
  ageReceivables,
  agingBucket,
  balanceCents,
  deriveCharges,
  effectiveStatus,
  grossCents,
  nextNumberFrom,
  parseMoney,
  statusAfterPayment,
  sumPayments,
  totalCents,
  totalOutstanding,
  ZERO_CHARGES,
  type Charges,
} from '@/lib/invoices/compute';
import { daysBetween, dueDateFor, termsLabel } from '@/lib/invoices/terms';
import { defaultFactoringNotice, renderInvoice, type InvoiceInput } from '@/lib/documents/invoice';

/**
 * Invoicing is arithmetic a broker will audit line by line, so these tests
 * care about the figures first: what is charged, what is credited, what is
 * still owed, and how late it is.
 */

function charges(overrides: Partial<Charges> = {}): Charges {
  return { ...ZERO_CHARGES, lineHaulCents: 294_000, ...overrides };
}

/* -------------------------------------------------------------------------
 * Money
 * ---------------------------------------------------------------------- */

describe('parseMoney', () => {
  it('reads what people actually type', () => {
    expect(parseMoney('2940')).toBe(294_000);
    expect(parseMoney('2940.00')).toBe(294_000);
    expect(parseMoney('$2,940.00')).toBe(294_000);
    expect(parseMoney(' 2940.5 ')).toBe(294_050);
    expect(parseMoney('.5')).toBe(50);
  });

  it('treats an empty field as nothing rather than zero', () => {
    // Zero and "not filled in" are different: one is a charge of nothing, the
    // other is a field the caller should leave alone.
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('   ')).toBeNull();
    expect(parseMoney(null)).toBeNull();
    expect(parseMoney(undefined)).toBeNull();
  });

  it('rejects what is not money', () => {
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('12abc')).toBeNull();
    expect(parseMoney('.')).toBeNull();
    expect(parseMoney('-')).toBeNull();
    expect(parseMoney('1.2.3')).toBeNull();
  });

  it('keeps a negative, which is how a correction is entered', () => {
    expect(parseMoney('-150.00')).toBe(-15_000);
  });

  it('rounds a third of a cent to the nearest cent rather than truncating', () => {
    expect(parseMoney('0.005')).toBe(1);
    expect(parseMoney('0.004')).toBe(0);
    expect(parseMoney('1234.565')).toBe(123_457);
  });
});

describe('invoice totals', () => {
  it('adds the charges', () => {
    const c = charges({ fuelSurchargeCents: 18_000, accessorialCents: 7_500, taxCents: 0 });
    expect(grossCents(c)).toBe(319_500);
  });

  it('credits money already collected against the total', () => {
    const c = charges({ codCollectedCents: 95_000, depositCents: 20_000 });
    expect(grossCents(c)).toBe(294_000);
    expect(totalCents(c)).toBe(179_000);
  });

  it('does not credit anything twice', () => {
    const c = charges({ fuelSurchargeCents: 18_000, codCollectedCents: 95_000 });
    expect(totalCents(c)).toBe(294_000 + 18_000 - 95_000);
  });

  it('reports a credit balance honestly when the deposit exceeded the charge', () => {
    // This happens: a deposit is taken, then the load shrinks. Clamping it to
    // zero would hide money the customer is owed.
    const c = charges({ lineHaulCents: 50_000, depositCents: 80_000 });
    expect(totalCents(c)).toBe(-30_000);
  });

  it('computes the balance from payments received', () => {
    expect(balanceCents(294_000, 0)).toBe(294_000);
    expect(balanceCents(294_000, 100_000)).toBe(194_000);
    expect(balanceCents(294_000, 294_000)).toBe(0);
  });

  it('sums payments without floating point drift', () => {
    const payments = Array.from({ length: 100 }, () => ({ amountCents: 10 }));
    expect(sumPayments(payments)).toBe(1_000);
  });

  it('sums an empty payment list to zero', () => {
    expect(sumPayments([])).toBe(0);
  });
});

/* -------------------------------------------------------------------------
 * Deriving from the load
 * ---------------------------------------------------------------------- */

describe('deriveCharges', () => {
  const load = {
    rateCents: 294_000,
    tariffCents: null,
    fuelSurchargeCents: null,
    codAmountCents: null,
    depositCents: null,
  };

  it('bills the agreed rate when there is no tariff', () => {
    const { charges: c, basis } = deriveCharges(load);
    expect(basis).toBe('rate');
    expect(c.lineHaulCents).toBe(294_000);
  });

  it('bills the tariff when the load carries one', () => {
    const { charges: c, basis } = deriveCharges({ ...load, tariffCents: 320_000 });
    expect(basis).toBe('tariff');
    expect(c.lineHaulCents).toBe(320_000);
  });

  it('treats a zero tariff as a real figure, not a missing one', () => {
    // A load moved as a favour is billed at zero, not silently at the rate.
    const { charges: c, basis } = deriveCharges({ ...load, tariffCents: 0 });
    expect(basis).toBe('tariff');
    expect(c.lineHaulCents).toBe(0);
  });

  it('credits a COD load, because the driver already collected it', () => {
    const { charges: c } = deriveCharges({ ...load, codAmountCents: 95_000 });
    expect(c.codCollectedCents).toBe(95_000);
    expect(totalCents(c)).toBe(199_000);
  });

  it('carries the fuel surcharge across as its own line', () => {
    const { charges: c } = deriveCharges({ ...load, fuelSurchargeCents: 18_000 });
    expect(c.fuelSurchargeCents).toBe(18_000);
    expect(c.lineHaulCents).toBe(294_000);
  });

  it('starts accessorials and tax at zero for someone to fill in', () => {
    const { charges: c } = deriveCharges(load);
    expect(c.accessorialCents).toBe(0);
    expect(c.taxCents).toBe(0);
  });

  it('handles a load with no money on it at all', () => {
    const { charges: c } = deriveCharges({
      rateCents: null,
      tariffCents: null,
      fuelSurchargeCents: null,
      codAmountCents: null,
      depositCents: null,
    });
    expect(totalCents(c)).toBe(0);
  });
});

/* -------------------------------------------------------------------------
 * Terms and due dates
 * ---------------------------------------------------------------------- */

describe('payment terms', () => {
  const issued = new Date('2026-09-14T00:00:00Z');

  it('computes net terms in whole days', () => {
    expect(dueDateFor(issued, '30_days')?.toISOString()).toBe('2026-10-14T00:00:00.000Z');
    expect(dueDateFor(issued, '15_days')?.toISOString()).toBe('2026-09-29T00:00:00.000Z');
  });

  it('makes on-delivery terms due the day the invoice is raised', () => {
    expect(dueDateFor(issued, 'on_delivery')?.toISOString()).toBe('2026-09-14T00:00:00.000Z');
  });

  it('gives quick pay the two days it actually commits to', () => {
    expect(dueDateFor(issued, 'quickpay')?.toISOString()).toBe('2026-09-16T00:00:00.000Z');
  });

  it('invents no due date for terms nobody wrote down', () => {
    expect(dueDateFor(issued, 'other')).toBeNull();
    expect(dueDateFor(issued, null)).toBeNull();
  });

  it('crosses a month boundary correctly', () => {
    const endOfMonth = new Date('2026-01-31T00:00:00Z');
    expect(dueDateFor(endOfMonth, '30_days')?.toISOString()).toBe('2026-03-02T00:00:00.000Z');
  });

  it('crosses a leap day correctly', () => {
    const beforeLeap = new Date('2028-02-27T00:00:00Z');
    expect(dueDateFor(beforeLeap, '2_days')?.toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it('names every term, so none renders as a raw enum value', () => {
    expect(termsLabel('30_days')).toBe('Net 30');
    expect(termsLabel('quickpay')).toBe('Quick pay');
    expect(termsLabel(null)).toBe('Per agreement');
  });

  it('counts whole days regardless of the time of day', () => {
    const morning = new Date('2026-09-14T01:00:00Z');
    const lateNight = new Date('2026-09-15T23:00:00Z');
    expect(daysBetween(morning, lateNight)).toBe(1);
  });
});

/* -------------------------------------------------------------------------
 * Status
 * ---------------------------------------------------------------------- */

describe('effectiveStatus', () => {
  const now = new Date('2026-10-20T00:00:00Z');
  const base = { status: 'sent' as const, totalCents: 294_000, paidCents: 0, dueAt: null };

  it('leaves a draft alone', () => {
    expect(effectiveStatus({ ...base, status: 'draft' }, now)).toBe('draft');
  });

  it('leaves a void invoice alone even when it is past due', () => {
    expect(
      effectiveStatus({ ...base, status: 'void', dueAt: new Date('2026-09-01') }, now),
    ).toBe('void');
  });

  it('reports paid once the balance is cleared', () => {
    expect(effectiveStatus({ ...base, paidCents: 294_000 }, now)).toBe('paid');
  });

  it('reports paid on an overpayment rather than still owing', () => {
    expect(effectiveStatus({ ...base, paidCents: 300_000 }, now)).toBe('paid');
  });

  it('reports overdue once the due date has passed', () => {
    expect(effectiveStatus({ ...base, dueAt: new Date('2026-10-14T00:00:00Z') }, now)).toBe(
      'overdue',
    );
  });

  it('does not call an invoice overdue on its due date', () => {
    expect(effectiveStatus({ ...base, dueAt: now }, now)).toBe('sent');
  });

  it('prefers overdue over partially paid, because that is what gets chased', () => {
    expect(
      effectiveStatus(
        { ...base, paidCents: 100_000, dueAt: new Date('2026-10-01T00:00:00Z') },
        now,
      ),
    ).toBe('overdue');
  });

  it('reports partially paid when something landed and nothing is late', () => {
    expect(effectiveStatus({ ...base, paidCents: 100_000 }, now)).toBe('partially_paid');
  });

  it('never calls a settled invoice overdue', () => {
    expect(
      effectiveStatus(
        { ...base, paidCents: 294_000, dueAt: new Date('2026-09-01T00:00:00Z') },
        now,
      ),
    ).toBe('paid');
  });
});

describe('statusAfterPayment', () => {
  it('settles when the balance reaches zero', () => {
    expect(statusAfterPayment(294_000, 294_000)).toBe('paid');
  });

  it('settles on an overpayment', () => {
    expect(statusAfterPayment(294_000, 300_000)).toBe('paid');
  });

  it('is partially paid in between', () => {
    expect(statusAfterPayment(294_000, 1)).toBe('partially_paid');
  });

  it('returns to sent when every payment has been removed', () => {
    expect(statusAfterPayment(294_000, 0)).toBe('sent');
  });
});

/* -------------------------------------------------------------------------
 * Aging
 * ---------------------------------------------------------------------- */

describe('aging', () => {
  const now = new Date('2026-12-01T00:00:00Z');
  const daysBefore = (n: number) => new Date(Date.UTC(2026, 11, 1 - n));

  it('buckets by how late payment is, not how old the invoice is', () => {
    expect(agingBucket(daysBefore(-5), now)).toBe('current'); // due in five days
    expect(agingBucket(daysBefore(1), now)).toBe('1_30');
    expect(agingBucket(daysBefore(30), now)).toBe('1_30');
    expect(agingBucket(daysBefore(31), now)).toBe('31_60');
    expect(agingBucket(daysBefore(61), now)).toBe('61_90');
    expect(agingBucket(daysBefore(91), now)).toBe('90_plus');
  });

  it('treats the due date itself as current', () => {
    expect(agingBucket(now, now)).toBe('current');
  });

  it('treats an invoice with no due date as current rather than guessing', () => {
    expect(agingBucket(null, now)).toBe('current');
  });

  it('adds up what is outstanding in each bucket', () => {
    const aged = ageReceivables(
      [
        { status: 'sent', totalCents: 100_000, paidCents: 0, dueAt: daysBefore(-2) },
        { status: 'sent', totalCents: 200_000, paidCents: 50_000, dueAt: daysBefore(10) },
        { status: 'overdue', totalCents: 300_000, paidCents: 0, dueAt: daysBefore(95) },
      ],
      now,
    );

    expect(aged.current).toBe(100_000);
    expect(aged['1_30']).toBe(150_000);
    expect(aged['90_plus']).toBe(300_000);
    expect(aged['31_60']).toBe(0);
  });

  it('leaves drafts and void invoices out of receivables', () => {
    const aged = ageReceivables(
      [
        { status: 'draft', totalCents: 100_000, paidCents: 0, dueAt: daysBefore(40) },
        { status: 'void', totalCents: 100_000, paidCents: 0, dueAt: daysBefore(40) },
      ],
      now,
    );

    expect(aged['31_60']).toBe(0);
    expect(Object.values(aged).every((cents) => cents === 0)).toBe(true);
  });

  it('leaves a settled invoice out of receivables', () => {
    const aged = ageReceivables(
      [{ status: 'paid', totalCents: 100_000, paidCents: 100_000, dueAt: daysBefore(40) }],
      now,
    );
    expect(aged['31_60']).toBe(0);
  });

  it('does not let an overpayment reduce the outstanding total', () => {
    // An overpaid invoice is settled, not a negative receivable that quietly
    // offsets money another customer genuinely owes.
    const outstanding = totalOutstanding([
      { status: 'paid', totalCents: 100_000, paidCents: 150_000, dueAt: null },
      { status: 'sent', totalCents: 200_000, paidCents: 0, dueAt: null },
    ]);
    expect(outstanding).toBe(200_000);
  });
});

/* -------------------------------------------------------------------------
 * Numbering
 * ---------------------------------------------------------------------- */

describe('nextNumberFrom', () => {
  it('matches the load reference when the number is free', () => {
    expect(nextNumberFrom('INV-OH-1001', new Set())).toBe('INV-OH-1001');
  });

  it('never reuses a number, even after the first invoice was voided', () => {
    /*
     * The voided invoice still exists and may already be in the customer's
     * accounts payable system. Two different documents under one identity is
     * the thing this prevents.
     */
    expect(nextNumberFrom('INV-OH-1001', new Set(['INV-OH-1001']))).toBe('INV-OH-1001-2');
  });

  it('keeps counting past a run of voided attempts', () => {
    const taken = new Set(['INV-OH-1001', 'INV-OH-1001-2', 'INV-OH-1001-3']);
    expect(nextNumberFrom('INV-OH-1001', taken)).toBe('INV-OH-1001-4');
  });

  it('is not confused by another load whose reference starts the same way', () => {
    // INV-OH-10010 must not make INV-OH-1001 look taken.
    expect(nextNumberFrom('INV-OH-1001', new Set(['INV-OH-10010']))).toBe('INV-OH-1001');
  });

  it('refuses to invent a number rather than silently colliding', () => {
    const exhausted = new Set(['INV-OH-1001']);
    for (let i = 2; i < 1000; i += 1) exhausted.add(`INV-OH-1001-${i}`);
    expect(() => nextNumberFrom('INV-OH-1001', exhausted)).toThrow(/No free invoice number/);
  });
});

/* -------------------------------------------------------------------------
 * The printed invoice
 * ---------------------------------------------------------------------- */

async function textOf(bytes: Uint8Array): Promise<string> {
  const pdf = await PDFDocument.load(bytes);
  const runs: string[] = [];

  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const filter = object.dict.get(PDFName.of('Filter'));
    if (!filter || !String(filter).includes('FlateDecode')) continue;

    let decoded: Buffer;
    try {
      decoded = inflateSync(Buffer.from(object.contents));
    } catch {
      continue;
    }

    const stream = decoded.toString('latin1');
    if (!stream.includes('Tj')) continue;
    for (const match of stream.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      runs.push(Buffer.from(match[1] ?? '', 'hex').toString('latin1'));
    }
  }

  return runs.join('');
}

function invoiceInput(overrides: Partial<InvoiceInput> = {}): InvoiceInput {
  return {
    invoiceNumber: 'INV-OH-1001',
    loadNumber: 'OH-1001',
    issuedAt: new Date('2026-09-14T12:00:00Z'),
    dueAt: new Date('2026-10-14T12:00:00Z'),
    terms: '30_days',
    carrier: {
      name: 'Ridgeline Auto Transport LLC',
      addressLine1: '4400 Meacham Blvd',
      city: 'Fort Worth',
      state: 'TX',
      postalCode: '76106',
      phone: '(214) 555-0118',
      usdotNumber: '3312907',
      mcNumber: 'MC-1084422',
    },
    billTo: {
      name: 'Cardinal Logistics Brokerage',
      addressLine1: '400 Commerce St',
      city: 'Dallas',
      state: 'TX',
      postalCode: '75201',
      mcNumber: 'MC-889120',
    },
    charges: charges({ fuelSurchargeCents: 18_000 }),
    paidCents: 0,
    currency: 'USD',
    vehicles: [{ vin: '1HGCM82633A004352', description: '2003 HONDA Accord Silver' }],
    payments: [],
    attachments: [],
    ...overrides,
  };
}

describe('renderInvoice', () => {
  it('produces a valid PDF', async () => {
    const bytes = await renderInvoice(invoiceInput());
    expect(Buffer.from(bytes.subarray(0, 5)).toString('ascii')).toBe('%PDF-');
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  it('states who is being billed, for what, and by when', async () => {
    const text = await textOf(await renderInvoice(invoiceInput()));

    expect(text).toContain('INVOICE');
    expect(text).toContain('INV-OH-1001');
    expect(text).toContain('Cardinal Logistics Brokerage');
    expect(text).toContain('Ridgeline Auto Transport LLC');
    expect(text).toContain('OH-1001');
    expect(text).toContain('Net 30');
    expect(text).toContain('Oct 14, 2026');
  });

  it('prints the fuel surcharge on its own line', async () => {
    // Brokers audit it separately, and a combined figure invites a short
    // payment while somebody works out the split.
    const text = await textOf(await renderInvoice(invoiceInput()));
    expect(text).toContain('Fuel surcharge');
    expect(text).toContain('$180.00');
    expect(text).toContain('$2,940.00');
    expect(text).toContain('$3,120.00');
  });

  it('shows what was already collected as a credit, not a payment', async () => {
    const text = await textOf(
      await renderInvoice(
        invoiceInput({ charges: charges({ codCollectedCents: 95_000 }) }),
      ),
    );
    expect(text).toContain('Collected on delivery');
    expect(text).toContain('Subtotal');
    expect(text).toContain('$1,990.00');
  });

  it('shows the balance once a payment has landed', async () => {
    const text = await textOf(await renderInvoice(invoiceInput({ paidCents: 100_000 })));
    expect(text).toContain('Payments received');
    expect(text).toContain('Balance due');
    expect(text).toContain('$2,120.00');
  });

  it('says nothing is due when the invoice is settled', async () => {
    const text = await textOf(
      await renderInvoice(invoiceInput({ paidCents: 312_000 })),
    );
    expect(text).toContain('settled in full');
  });

  it('carries the Notice of Assignment when the invoice is factored', async () => {
    /*
     * A factored invoice without this gets paid to the carrier, and the factor
     * then comes after the carrier for money it already advanced. It has to be
     * on the face of the document.
     */
    const text = await textOf(
      await renderInvoice(invoiceInput({ factoringCompanyName: 'Apex Capital' })),
    );

    expect(text).toContain('NOTICE OF ASSIGNMENT');
    expect(text).toContain('Apex Capital');
    // Phrases are matched within a rendered line: the extractor joins the
    // content stream's runs, so anything spanning a wrap reads as one word.
    expect(text).toContain('does not discharge this obligation');
  });

  it('redirects the remittance line to the factor, not the carrier', async () => {
    const text = await textOf(
      await renderInvoice(invoiceInput({ factoringCompanyName: 'Apex Capital' })),
    );
    expect(text).toContain('Please remit');
    expect(text).toContain('to Apex Capital');
  });

  it('uses the factor’s own wording when it was supplied', async () => {
    // Factors issue their own notice text and require it reproduced exactly.
    const text = await textOf(
      await renderInvoice(
        invoiceInput({
          factoringCompanyName: 'Apex Capital',
          factoringNoticeText: 'ASSIGNED TO APEX CAPITAL LP — REMIT PER W-9 ON FILE.',
        }),
      ),
    );

    expect(text).toContain('ASSIGNED TO APEX CAPITAL LP');
    expect(text).not.toContain('This notice remains in effect until');
  });

  it('omits the notice entirely when the invoice is not factored', async () => {
    const text = await textOf(await renderInvoice(invoiceInput()));
    expect(text).not.toContain('NOTICE OF ASSIGNMENT');
  });

  it('cites the sealed paperwork so the attachments can be checked', async () => {
    const text = await textOf(
      await renderInvoice(
        invoiceInput({
          attachments: [
            { kind: 'Bill of lading', number: 'BOL-OH-1001', sha256: 'a'.repeat(64) },
            { kind: 'Delivery receipt', number: 'POD-OH-1001', sha256: 'b'.repeat(64) },
          ],
        }),
      ),
    );

    expect(text).toContain('SUPPORTING DOCUMENTS'); // headings are set in caps
    expect(text).toContain('BOL-OH-1001');
    expect(text).toContain('POD-OH-1001');
    expect(text).toContain('a'.repeat(64));
  });

  it('renders a full deck without overflowing the page', async () => {
    const bytes = await renderInvoice(
      invoiceInput({
        vehicles: Array.from({ length: 10 }, (_, i) => ({
          vin: `1HGCM82633A00435${i}`,
          description: '2003 HONDA Accord Silver',
        })),
        payments: Array.from({ length: 6 }, (_, i) => ({
          receivedAt: new Date(`2026-10-0${i + 1}T00:00:00Z`),
          method: 'ach',
          reference: `WIRE-00${i}`,
          amountCents: 50_000,
        })),
        attachments: [
          { kind: 'Bill of lading', number: 'BOL-OH-1001', sha256: 'a'.repeat(64) },
        ],
        factoringCompanyName: 'Apex Capital',
        notes: 'Detention at pickup: 3 hours. '.repeat(30),
      }),
    );

    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
  });

  it('renders when the due date is unknown rather than printing a wrong one', async () => {
    const text = await textOf(
      await renderInvoice(invoiceInput({ terms: 'other', dueAt: null })),
    );
    expect(text).toContain('Per agreement');
  });

  it('renders deterministically, so the stored hash means something', async () => {
    const fixed = invoiceInput();
    const a = await renderInvoice(fixed);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const b = await renderInvoice(fixed);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

describe('defaultFactoringNotice', () => {
  it('names the assignee and redirects payment, which is what makes it operative', () => {
    const notice = defaultFactoringNotice('Apex Capital');
    expect(notice).toContain('NOTICE OF ASSIGNMENT');
    expect(notice).toContain('Apex Capital');
    expect(notice).toContain('does not discharge this obligation');
  });
});
