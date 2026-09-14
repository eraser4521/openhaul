import { describe, expect, it } from 'vitest';
import { isPdf, pdfText } from './helpers/pdf-text';
import {
  describeBasis,
  escrowBalance,
  isPaymentLate,
  payBasisFor,
  payForLoad,
  paymentDueBy,
  settlementStatus,
  signedCents,
  sumKind,
  totalsFrom,
} from '@/lib/settlements/compute';
import { renderSettlement, type SettlementInput } from '@/lib/documents/settlement';
import type { SettlementLineKind } from '@/lib/db/schema';

/**
 * A driver checks their own settlement more carefully than anybody checks an
 * invoice. These tests care about the arithmetic reconciling exactly, and
 * about the statement carrying what a lease obliges the carrier to show.
 */

function line(kind: SettlementLineKind, amountCents: number) {
  return { kind, amountCents };
}

/* -------------------------------------------------------------------------
 * Direction and totals
 * ---------------------------------------------------------------------- */

describe('signedCents', () => {
  it('adds what a driver earns', () => {
    expect(signedCents(line('load_pay', 82_320))).toBe(82_320);
    expect(signedCents(line('bonus', 5_000))).toBe(5_000);
    expect(signedCents(line('reimbursement', 4_150))).toBe(4_150);
    expect(signedCents(line('escrow_return', 50_000))).toBe(50_000);
  });

  it('subtracts what is taken off', () => {
    expect(signedCents(line('deduction', 12_500))).toBe(-12_500);
    expect(signedCents(line('advance', 20_000))).toBe(-20_000);
    expect(signedCents(line('escrow_deposit', 10_000))).toBe(-10_000);
  });

  it('treats a negative amount as a reversal of its own kind', () => {
    /*
     * How a chargeback raised in error is undone without deleting a line the
     * driver has already seen on a statement.
     */
    expect(signedCents(line('deduction', -12_500))).toBe(12_500);
  });
});

describe('totalsFrom', () => {
  const lines = [
    line('load_pay', 82_320),
    line('load_pay', 61_600),
    line('bonus', 5_000),
    line('reimbursement', 4_150),
    line('deduction', 12_500),
    line('advance', 20_000),
    line('escrow_deposit', 10_000),
  ];

  it('groups each kind', () => {
    const totals = totalsFrom(lines);
    expect(totals.earningsCents).toBe(148_920);
    expect(totals.reimbursementsCents).toBe(4_150);
    expect(totals.deductionsCents).toBe(12_500);
    expect(totals.advancesCents).toBe(20_000);
    expect(totals.escrowHeldCents).toBe(10_000);
  });

  it('reconciles the net against the lines exactly', () => {
    // The one number a driver will recompute by hand.
    const totals = totalsFrom(lines);
    expect(totals.netPayCents).toBe(148_920 + 4_150 - 12_500 - 20_000 - 10_000);
    expect(totals.netPayCents).toBe(110_570);
  });

  it('nets to zero on no lines', () => {
    expect(totalsFrom([]).netPayCents).toBe(0);
  });

  it('allows a negative net rather than hiding it', () => {
    // A week of deductions against one short load. Rare, and it has to be
    // visible rather than clamped to zero.
    expect(totalsFrom([line('load_pay', 5_000), line('deduction', 20_000)]).netPayCents).toBe(
      -15_000,
    );
  });

  it('sums a kind without touching the others', () => {
    expect(sumKind(lines, 'load_pay')).toBe(143_920);
    expect(sumKind(lines, 'load_pay', 'bonus')).toBe(148_920);
    expect(sumKind(lines, 'escrow_return')).toBe(0);
  });
});

/* -------------------------------------------------------------------------
 * Pay basis
 * ---------------------------------------------------------------------- */

describe('payBasisFor', () => {
  it('reads a percentage rate', () => {
    const basis = payBasisFor({ employmentType: 'owner_operator', payRateBps: 6_800, payPerMileCents: null });
    expect(basis).toEqual({ kind: 'percentage', rateBps: 6_800 });
    expect(describeBasis(basis)).toBe('68.00% of load revenue');
  });

  it('reads a per-mile rate', () => {
    const basis = payBasisFor({ employmentType: 'company', payRateBps: null, payPerMileCents: 55 });
    expect(basis).toEqual({ kind: 'per_mile', centsPerMile: 55 });
    expect(describeBasis(basis)).toBe('$0.55 per mile');
  });

  it('prefers the percentage when a stale per-mile figure is also set', () => {
    /*
     * Paying the lower of two plausible bases by accident is the error that
     * costs trust, so the share wins and the choice is stated on the
     * statement rather than left implicit.
     */
    const basis = payBasisFor({
      employmentType: 'owner_operator',
      payRateBps: 6_800,
      payPerMileCents: 55,
    });
    expect(basis.kind).toBe('percentage');
  });

  it('reports no basis rather than defaulting to zero pay', () => {
    const basis = payBasisFor({ employmentType: 'company', payRateBps: null, payPerMileCents: null });
    expect(basis.kind).toBe('none');
    expect(describeBasis(basis)).toBe('No pay rate set');
  });

  it('ignores a rate of zero, which is not a rate', () => {
    expect(payBasisFor({ employmentType: 'company', payRateBps: 0, payPerMileCents: 0 }).kind).toBe(
      'none',
    );
  });
});

describe('payForLoad', () => {
  const percentage = { kind: 'percentage' as const, rateBps: 6_800 };

  it('takes the share of the load revenue', () => {
    const pay = payForLoad({ rateCents: 294_000, distanceMiles: 1_074 }, percentage);
    expect(pay.amountCents).toBe(199_920);
  });

  it('shows the arithmetic, which the lease entitles the driver to see', () => {
    // 49 CFR 376.12(d): the rated revenue behind a percentage.
    const pay = payForLoad({ rateCents: 294_000, distanceMiles: null }, percentage);
    expect(pay.basisNote).toBe('68.00% of $2,940.00');
  });

  it('rounds half up so a cent never drifts against the driver', () => {
    // 1 cent at 50% would truncate to 0; it rounds to 1.
    expect(payForLoad({ rateCents: 1, distanceMiles: null }, { kind: 'percentage', rateBps: 5_000 })
      .amountCents).toBe(1);
    expect(
      payForLoad({ rateCents: 333, distanceMiles: null }, { kind: 'percentage', rateBps: 3_333 })
        .amountCents,
    ).toBe(111);
  });

  it('pays per mile when that is the basis', () => {
    const pay = payForLoad(
      { rateCents: 294_000, distanceMiles: 1_074 },
      { kind: 'per_mile', centsPerMile: 55 },
    );
    expect(pay.amountCents).toBe(59_070);
    expect(pay.basisNote).toBe('1,074 mi at $0.55 per mile');
  });

  it('pays nothing on a load with no revenue recorded, and says so plainly', () => {
    const pay = payForLoad({ rateCents: null, distanceMiles: null }, percentage);
    expect(pay.amountCents).toBe(0);
    expect(pay.basisNote).toBe('68.00% of $0.00');
  });

  it('pays nothing when the driver has no rate', () => {
    const pay = payForLoad({ rateCents: 294_000, distanceMiles: 1_074 }, { kind: 'none' });
    expect(pay.amountCents).toBe(0);
    expect(pay.basisNote).toContain('No pay rate');
  });
});

/* -------------------------------------------------------------------------
 * Escrow — 49 CFR 376.12(h)
 * ---------------------------------------------------------------------- */

describe('escrowBalance', () => {
  it('is deposits less returns', () => {
    expect(
      escrowBalance([
        line('escrow_deposit', 10_000),
        line('escrow_deposit', 10_000),
        line('escrow_return', 5_000),
      ]),
    ).toBe(15_000);
  });

  it('ignores every other kind of line', () => {
    expect(escrowBalance([line('load_pay', 500_000), line('deduction', 9_000)])).toBe(0);
  });

  it('is zero when nothing has been held', () => {
    expect(escrowBalance([])).toBe(0);
  });
});

/* -------------------------------------------------------------------------
 * Payment timing — 49 CFR 376.12(f)
 * ---------------------------------------------------------------------- */

describe('paymentDueBy', () => {
  it('allows fifteen days from the end of the period', () => {
    expect(paymentDueBy(new Date('2026-09-14T00:00:00Z')).toISOString()).toBe(
      '2026-09-29T00:00:00.000Z',
    );
  });

  it('crosses a month boundary', () => {
    expect(paymentDueBy(new Date('2026-01-25T00:00:00Z')).toISOString()).toBe(
      '2026-02-09T00:00:00.000Z',
    );
  });
});

describe('isPaymentLate', () => {
  const periodEnd = new Date('2026-09-14T00:00:00Z');

  it('is late once fifteen days pass unpaid', () => {
    expect(
      isPaymentLate({ periodEnd, paidAt: null }, 'owner_operator', new Date('2026-09-30T00:00:00Z')),
    ).toBe(true);
  });

  it('is not late on the fifteenth day', () => {
    expect(
      isPaymentLate({ periodEnd, paidAt: null }, 'owner_operator', new Date('2026-09-29T00:00:00Z')),
    ).toBe(false);
  });

  it('records that a payment already made was made late', () => {
    expect(
      isPaymentLate(
        { periodEnd, paidAt: new Date('2026-10-05T00:00:00Z') },
        'owner_operator',
        new Date('2026-12-01T00:00:00Z'),
      ),
    ).toBe(true);
  });

  it('does not call an on-time payment late afterwards', () => {
    expect(
      isPaymentLate(
        { periodEnd, paidAt: new Date('2026-09-20T00:00:00Z') },
        'owner_operator',
        new Date('2026-12-01T00:00:00Z'),
      ),
    ).toBe(false);
  });

  it('never applies the lease window to a company driver', () => {
    /*
     * Part 376 governs a lease. A company driver is on payroll and covered by
     * wage law instead, which this does not attempt to model — claiming a
     * federal deadline that does not apply would be worse than silence.
     */
    expect(
      isPaymentLate({ periodEnd, paidAt: null }, 'company', new Date('2027-01-01T00:00:00Z')),
    ).toBe(false);
  });
});

describe('settlementStatus', () => {
  it('is a draft until finalised', () => {
    expect(settlementStatus({ finalizedAt: null, paidAt: null })).toBe('draft');
  });

  it('is ready to pay once finalised', () => {
    expect(settlementStatus({ finalizedAt: new Date(), paidAt: null })).toBe('finalized');
  });

  it('is paid once paid', () => {
    expect(settlementStatus({ finalizedAt: new Date(), paidAt: new Date() })).toBe('paid');
  });
});

/* -------------------------------------------------------------------------
 * The statement
 * ---------------------------------------------------------------------- */

function statement(overrides: Partial<SettlementInput> = {}): SettlementInput {
  return {
    settlementNumber: 'STL-2026-0007',
    issuedAt: new Date('2026-09-15T12:00:00Z'),
    periodStart: new Date('2026-09-01T00:00:00Z'),
    periodEnd: new Date('2026-09-14T00:00:00Z'),
    paymentDueBy: new Date('2026-09-29T00:00:00Z'),
    carrier: {
      name: 'Ridgeline Auto Transport LLC',
      addressLine1: '4400 Meacham Blvd',
      city: 'Fort Worth',
      state: 'TX',
      postalCode: '76106',
    },
    driverName: 'Marcus Webb',
    employmentType: 'owner_operator',
    payBasis: '68.00% of load revenue',
    lines: [
      {
        kind: 'load_pay',
        description: 'Load OH-1001',
        amountCents: 199_920,
        basisNote: '68.00% of $2,940.00',
        loadNumber: 'OH-1001',
      },
      {
        kind: 'reimbursement',
        description: 'tolls — Oklahoma Turnpike',
        amountCents: 4_150,
        basisNote: 'Receipt on file',
        loadNumber: 'OH-1001',
      },
      {
        kind: 'deduction',
        description: 'Occupational accident insurance',
        amountCents: 12_500,
        basisNote: 'Weekly premium per lease schedule B',
        loadNumber: null,
      },
      {
        kind: 'escrow_deposit',
        description: 'Escrow contribution',
        amountCents: 10_000,
        basisNote: 'Per lease, until $2,500 is held',
        loadNumber: null,
      },
    ],
    escrowBalanceCents: 110_000,
    ...overrides,
  };
}

describe('renderSettlement', () => {
  it('produces a valid PDF', async () => {
    expect(isPdf(await renderSettlement(statement()))).toBe(true);
  });

  it('names the driver, the period and the basis', async () => {
    const text = await pdfText(await renderSettlement(statement()));

    expect(text).toContain('SETTLEMENT STATEMENT');
    expect(text).toContain('STL-2026-0007');
    expect(text).toContain('Marcus Webb');
    expect(text).toContain('Sep 1, 2026 — Sep 14, 2026');
    expect(text).toContain('68.00% of load revenue');
  });

  it('shows the revenue each percentage was taken from', async () => {
    // 49 CFR 376.12(d). Without it the driver has to take the figure on trust.
    const text = await pdfText(await renderSettlement(statement()));
    expect(text).toContain('68.00% of $2,940.00');
  });

  it('names every deduction rather than showing one total', async () => {
    // 49 CFR 376.12(g): each item identified, not aggregated.
    const text = await pdfText(await renderSettlement(statement()));
    expect(text).toContain('Occupational accident insurance');
    expect(text).toContain('Weekly premium per lease schedule B');
  });

  it('reconciles to the net the lines actually produce', async () => {
    const text = await pdfText(await renderSettlement(statement()));
    // 199,920 + 4,150 - 12,500 - 10,000
    expect(text).toContain('Net pay');
    expect(text).toContain('$1,815.70');
  });

  it('accounts for the escrow fund and says the driver can demand more', async () => {
    const text = await pdfText(await renderSettlement(statement()));
    expect(text).toContain('$1,100.00');
    expect(text).toContain('376.12(h)');
    expect(text).toContain('45 days');
  });

  it('states the fifteen-day payment window on a lease', async () => {
    const text = await pdfText(await renderSettlement(statement()));
    expect(text).toContain('376.12(f)');
    expect(text).toContain('15 days');
    expect(text).toContain('Sep 29, 2026');
  });

  it('tells the driver they may examine the documents behind a chargeback', async () => {
    const text = await pdfText(await renderSettlement(statement()));
    expect(text).toContain('376.12(g)');
    expect(text).toContain('examine the documents');
  });

  it('leaves the lease disclosures off a company driver’s statement', async () => {
    /*
     * Part 376 governs a lease. Printing lease rights on a payroll driver's
     * statement would assert a relationship that does not exist.
     */
    const text = await pdfText(
      await renderSettlement(
        statement({ employmentType: 'company', escrowBalanceCents: 0, paymentDueBy: null }),
      ),
    );

    expect(text).toContain('Company driver');
    expect(text).not.toContain('376.12');
    expect(text).not.toContain('Your rights under the lease');
  });

  it('still itemises everything for a company driver', async () => {
    const text = await pdfText(
      await renderSettlement({ ...statement(), employmentType: 'company', escrowBalanceCents: 0 }),
    );
    expect(text).toContain('Occupational accident insurance');
    expect(text).toContain('Net pay');
  });

  it('groups the lines by kind whatever order they arrived in', async () => {
    const shuffled = statement();
    shuffled.lines = [...shuffled.lines].reverse();

    const text = await pdfText(await renderSettlement(shuffled));
    expect(text.indexOf('Load pay')).toBeLessThan(text.indexOf('Deduction'));
  });

  it('renders a settlement with a negative net rather than failing', async () => {
    const text = await pdfText(
      await renderSettlement(
        statement({
          lines: [
            { kind: 'load_pay', description: 'Load OH-1', amountCents: 5_000, basisNote: null, loadNumber: 'OH-1' },
            { kind: 'deduction', description: 'Damage chargeback', amountCents: 40_000, basisNote: null, loadNumber: null },
          ],
        }),
      ),
    );
    expect(text).toContain('-$350.00');
  });

  it('grows onto more pages on a heavy period rather than overflowing', async () => {
    const heavy = statement({
      lines: Array.from({ length: 40 }, (_, i) => ({
        kind: 'load_pay' as const,
        description: `Load OH-${2000 + i}`,
        amountCents: 120_000,
        basisNote: '68.00% of $1,764.71',
        loadNumber: `OH-${2000 + i}`,
      })),
    });

    const { PDFDocument } = await import('pdf-lib');
    const pdf = await PDFDocument.load(await renderSettlement(heavy));
    expect(pdf.getPageCount()).toBeGreaterThan(1);
  });

  it('renders deterministically, so the stored hash means something', async () => {
    const fixed = statement();
    const a = await renderSettlement(fixed);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const b = await renderSettlement(fixed);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
