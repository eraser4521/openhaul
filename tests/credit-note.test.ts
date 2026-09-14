import { describe, expect, it } from 'vitest';
import { isPdf, pdfText } from './helpers/pdf-text';
import {
  ageReceivables,
  balanceCents,
  effectiveStatus,
  statusAfterPayment,
  totalOutstanding,
} from '@/lib/invoices/compute';
import { nextCreditNumber, sumCredits, liveCredits } from '@/lib/invoices/credits';
import { renderCreditNote, type CreditNoteInput } from '@/lib/documents/credit-note';

/**
 * A credit note reduces what is owed without altering what the invoice says.
 * These tests care about that separation holding, and about the document being
 * impossible to mistake for a second bill.
 */

/* -------------------------------------------------------------------------
 * Balance
 * ---------------------------------------------------------------------- */

describe('balanceCents with credits', () => {
  it('subtracts credits alongside payments', () => {
    expect(balanceCents(347_500, 100_000, 47_500)).toBe(200_000);
  });

  it('is unchanged when nothing is credited', () => {
    expect(balanceCents(347_500, 100_000, 0)).toBe(247_500);
    expect(balanceCents(347_500, 100_000)).toBe(247_500);
  });

  it('settles an invoice credited in full', () => {
    expect(balanceCents(347_500, 0, 347_500)).toBe(0);
  });

  it('goes negative into a refund rather than clamping', () => {
    // Paid in full, then credited: the customer is owed money back, and
    // hiding that behind a zero would lose it.
    expect(balanceCents(347_500, 347_500, 50_000)).toBe(-50_000);
  });
});

describe('statusAfterPayment with credits', () => {
  it('settles an unpaid invoice that was credited to zero', () => {
    expect(statusAfterPayment(347_500, 0, 347_500)).toBe('paid');
  });

  it('is partially paid when a payment and a credit together fall short', () => {
    expect(statusAfterPayment(347_500, 100_000, 47_500)).toBe('partially_paid');
  });

  it('stays sent when only a partial credit exists and nothing was paid', () => {
    expect(statusAfterPayment(347_500, 0, 47_500)).toBe('sent');
  });
});

describe('effectiveStatus with credits', () => {
  const now = new Date('2026-10-20T00:00:00Z');
  const base = { status: 'sent' as const, totalCents: 347_500, paidCents: 0, dueAt: null };

  it('reports paid once credits clear the balance', () => {
    expect(effectiveStatus({ ...base, creditedCents: 347_500 }, now)).toBe('paid');
  });

  it('does not call a fully credited invoice overdue', () => {
    /*
     * Nothing is owed, so nothing can be late. Chasing a customer for an
     * invoice you credited away yourself is the failure this prevents.
     */
    expect(
      effectiveStatus(
        { ...base, creditedCents: 347_500, dueAt: new Date('2026-09-01T00:00:00Z') },
        now,
      ),
    ).toBe('paid');
  });

  it('still reports overdue when a partial credit leaves a balance', () => {
    expect(
      effectiveStatus(
        { ...base, creditedCents: 47_500, dueAt: new Date('2026-09-01T00:00:00Z') },
        now,
      ),
    ).toBe('overdue');
  });
});

describe('receivables with credits', () => {
  const now = new Date('2026-12-01T00:00:00Z');
  const daysBefore = (n: number) => new Date(Date.UTC(2026, 11, 1 - n));

  it('leaves a credited-away invoice out of the aging', () => {
    const aged = ageReceivables(
      [
        {
          status: 'sent',
          totalCents: 300_000,
          paidCents: 0,
          creditedCents: 300_000,
          dueAt: daysBefore(40),
        },
      ],
      now,
    );
    expect(aged['31_60']).toBe(0);
  });

  it('ages only what is still owed after a partial credit', () => {
    const aged = ageReceivables(
      [
        {
          status: 'sent',
          totalCents: 300_000,
          paidCents: 0,
          creditedCents: 100_000,
          dueAt: daysBefore(40),
        },
      ],
      now,
    );
    expect(aged['31_60']).toBe(200_000);
  });

  it('does not count credited money as outstanding', () => {
    expect(
      totalOutstanding([
        { status: 'sent', totalCents: 300_000, paidCents: 0, creditedCents: 120_000, dueAt: null },
      ]),
    ).toBe(180_000);
  });
});

/* -------------------------------------------------------------------------
 * Numbering and summing
 * ---------------------------------------------------------------------- */

describe('nextCreditNumber', () => {
  it('is derived from the invoice it credits', () => {
    expect(nextCreditNumber('INV-OH-1001', new Set())).toBe('CN-INV-OH-1001');
  });

  it('never reuses a number, even after a credit was voided', () => {
    // A voided credit note may already be in the customer's ledger.
    expect(nextCreditNumber('INV-OH-1001', new Set(['CN-INV-OH-1001']))).toBe('CN-INV-OH-1001-2');
  });

  it('keeps counting past several', () => {
    const taken = new Set(['CN-INV-OH-1001', 'CN-INV-OH-1001-2', 'CN-INV-OH-1001-3']);
    expect(nextCreditNumber('INV-OH-1001', taken)).toBe('CN-INV-OH-1001-4');
  });

  it('is not confused by a similarly named invoice', () => {
    expect(nextCreditNumber('INV-OH-1001', new Set(['CN-INV-OH-10010']))).toBe('CN-INV-OH-1001');
  });

  it('refuses to invent a number rather than colliding', () => {
    const exhausted = new Set(['CN-INV-OH-1001']);
    for (let i = 2; i < 1000; i += 1) exhausted.add(`CN-INV-OH-1001-${i}`);
    expect(() => nextCreditNumber('INV-OH-1001', exhausted)).toThrow(/No free credit note number/);
  });
});

describe('sumCredits', () => {
  const notes = [
    { amountCents: 20_000, voidedAt: null },
    { amountCents: 5_000, voidedAt: null },
    { amountCents: 50_000, voidedAt: new Date('2026-10-01T00:00:00Z') },
  ];

  it('counts only the live notes', () => {
    // A voided credit forgives nothing.
    expect(sumCredits(notes)).toBe(25_000);
    expect(liveCredits(notes)).toHaveLength(2);
  });

  it('is zero with no notes', () => {
    expect(sumCredits([])).toBe(0);
  });
});

/* -------------------------------------------------------------------------
 * The document
 * ---------------------------------------------------------------------- */

function creditNote(overrides: Partial<CreditNoteInput> = {}): CreditNoteInput {
  return {
    creditNumber: 'CN-INV-OH-1001',
    issuedAt: new Date('2026-09-20T12:00:00Z'),
    carrier: {
      name: 'Ridgeline Auto Transport LLC',
      addressLine1: '4400 Meacham Blvd',
      city: 'Fort Worth',
      state: 'TX',
      postalCode: '76106',
    },
    billTo: {
      name: 'Cardinal Logistics Brokerage',
      addressLine1: '400 Commerce St',
      city: 'Dallas',
      state: 'TX',
      postalCode: '75201',
    },
    invoiceNumber: 'INV-OH-1001',
    invoiceIssuedAt: new Date('2026-09-14T12:00:00Z'),
    invoiceTotalCents: 347_500,
    loadNumber: 'OH-1001',
    reason: 'rate_adjustment',
    detail: 'Detention at pickup withdrawn after reviewing the gate log.',
    amountCents: 27_500,
    currency: 'USD',
    totalCreditedCents: 27_500,
    paidCents: 0,
    ...overrides,
  };
}

describe('renderCreditNote', () => {
  it('produces a valid PDF', async () => {
    expect(isPdf(await renderCreditNote(creditNote()))).toBe(true);
  });

  it('says on its face that it is not a bill', async () => {
    /*
     * The failure this prevents: accounts payable process by document type, a
     * credit that reads like an invoice gets paid instead of applied, and the
     * customer then chases a payment nobody owed.
     */
    const text = await pdfText(await renderCreditNote(creditNote()));

    expect(text).toContain('CREDIT NOTE');
    expect(text).toContain('THIS IS NOT A BILL');
    expect(text).toContain('NO PAYMENT IS DUE ON THIS DOCUMENT');
  });

  it('names the invoice it credits and both parties', async () => {
    const text = await pdfText(await renderCreditNote(creditNote()));

    expect(text).toContain('CN-INV-OH-1001');
    expect(text).toContain('INV-OH-1001');
    expect(text).toContain('Cardinal Logistics Brokerage');
    expect(text).toContain('Ridgeline Auto Transport LLC');
    expect(text).toContain('OH-1001');
  });

  it('gives the reason and the detail, not just a figure', async () => {
    const text = await pdfText(await renderCreditNote(creditNote()));
    expect(text).toContain('Rate adjustment');
    expect(text).toContain('Detention at pickup withdrawn');
    expect(text).toContain('$275.00');
  });

  it('shows the balance the credit leaves on the invoice', async () => {
    const text = await pdfText(await renderCreditNote(creditNote()));
    expect(text).toContain('Balance now due');
    expect(text).toContain('$3,200.00');
  });

  it('says the invoice is settled when the credit clears it', async () => {
    const text = await pdfText(
      await renderCreditNote(
        creditNote({ amountCents: 347_500, totalCreditedCents: 347_500 }),
      ),
    );
    expect(text).toContain('settled in full');
  });

  it('asks how to settle a refund when the customer has overpaid into credit', async () => {
    const text = await pdfText(
      await renderCreditNote(
        creditNote({ paidCents: 347_500, amountCents: 50_000, totalCreditedCents: 50_000 }),
      ),
    );

    expect(text).toContain('Refund due to you');
    expect(text).toContain('applied against your next invoice, or refunded');
  });

  it('insists the invoice itself is unchanged', async () => {
    // The separation the whole design rests on: two documents, one figure each.
    const text = await pdfText(await renderCreditNote(creditNote()));
    expect(text).toContain('is unchanged and still states $3,475.00');
    expect(text).toContain('does not replace it');
  });

  it('names the claim when the credit came off the freight bill to settle one', async () => {
    const text = await pdfText(
      await renderCreditNote(
        creditNote({ reason: 'damage_offset', claimNumber: 'CLM-2026-0001' }),
      ),
    );

    expect(text).toContain('SETTLES CLAIM'); // field labels are set in caps
    expect(text).toContain('CLM-2026-0001');
    expect(text).toContain('Damage offset');
  });

  it('shows what was already paid alongside the credit', async () => {
    const text = await pdfText(await renderCreditNote(creditNote({ paidCents: 100_000 })));
    expect(text).toContain('Already paid');
    expect(text).toContain('$1,000.00');
  });

  it('renders when almost nothing about the counterparty is known', async () => {
    const bytes = await renderCreditNote(
      creditNote({
        billTo: { name: 'Customer not recorded' },
        loadNumber: null,
        invoiceIssuedAt: null,
      }),
    );
    expect(isPdf(bytes)).toBe(true);
  });

  it('survives a detail long enough to wrap', async () => {
    const bytes = await renderCreditNote(
      creditNote({ detail: 'Agreed reduction following the rate dispute. '.repeat(30) }),
    );
    expect(isPdf(bytes)).toBe(true);
  });

  it('renders deterministically, so the stored hash means something', async () => {
    const fixed = creditNote();
    const a = await renderCreditNote(fixed);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const b = await renderCreditNote(fixed);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
