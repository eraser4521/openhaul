import { describe, expect, it } from 'vitest';
import {
  FLOW_DAYS,
  attention,
  creditStandoffs,
  flowSince,
  live,
  overdueCents,
  owedCents,
  worstBucket,
  type InvoiceLike,
} from '@/lib/invoices/overview';
import type { HoldReason } from '@/lib/invoices/dunning';

/**
 * The money, on one page.
 *
 * Assembling the figures is easy; what is worth testing is what the screen
 * refuses to say. A draft invoice counted as owed would overstate the book. A
 * broken promise counted as money coming would be worse — it is the opposite
 * of a commitment. And a customer owing money while the carrier sits on money
 * of theirs is the one thing this page can see that no other screen can, so
 * it had better see it.
 */

const NOW = new Date('2026-09-14T12:00:00Z');

function invoice(over: Partial<InvoiceLike> = {}): InvoiceLike {
  return {
    status: 'sent',
    totalCents: 187_500,
    paidCents: 0,
    issuedAt: new Date('2026-07-01T12:00:00Z'),
    dueAt: new Date('2026-08-01T12:00:00Z'),
    ...over,
  };
}

/* -------------------------------------------------------------------------
 * The position
 * ---------------------------------------------------------------------- */

describe('what is owed', () => {
  it('leaves out anything nobody has been billed for', () => {
    /*
     * A draft has been shown to nobody and a void invoice was never validly
     * owed. Counting either would have a carrier believing money is coming
     * that nobody has been asked for.
     */
    const rows = [
      invoice({ status: 'draft' }),
      invoice({ status: 'void' }),
      invoice({ status: 'sent' }),
    ];

    expect(live(rows)).toHaveLength(1);
    expect(owedCents(rows)).toBe(187_500);
  });

  it('nets off everything that has settled an invoice, however it settled', () => {
    expect(
      owedCents([
        invoice({ paidCents: 100_000 }),
        invoice({ creditedCents: 187_500 }),
        invoice({ appliedCreditCents: 87_500 }),
      ]),
    ).toBe(87_500 + 0 + 100_000);
  });

  it('never lets an overpaid invoice reduce what other customers owe', () => {
    // A negative balance is money held on somebody's behalf, and it belongs
    // in the held figure rather than quietly cancelling somebody else's debt.
    expect(owedCents([invoice({ paidCents: 300_000 }), invoice()])).toBe(187_500);
  });

  it('separates the part that is late', () => {
    const rows = [
      invoice({ dueAt: new Date('2026-08-01T12:00:00Z') }),
      invoice({ dueAt: new Date('2026-10-01T12:00:00Z') }),
      invoice({ dueAt: null }),
    ];

    expect(owedCents(rows)).toBe(562_500);
    expect(overdueCents(rows, NOW)).toBe(187_500);
  });
});

describe('the flow', () => {
  it('counts what was billed and collected in the window', () => {
    const flow = flowSince(
      [
        invoice({ issuedAt: new Date('2026-09-10T12:00:00Z'), totalCents: 100_000 }),
        invoice({ issuedAt: new Date('2026-08-01T12:00:00Z'), totalCents: 900_000 }),
      ],
      [
        { amountCents: 40_000, receivedAt: new Date('2026-09-11T12:00:00Z') },
        { amountCents: 500_000, receivedAt: new Date('2026-07-01T12:00:00Z') },
      ],
      NOW,
    );

    expect(flow).toEqual({ days: FLOW_DAYS, invoicedCents: 100_000, receivedCents: 40_000 });
  });

  it('dates by when it happened, not when it was typed', () => {
    // A payment entered today for money that arrived a month ago belongs in
    // that month, or this week's figure flatters itself.
    const flow = flowSince(
      [],
      [{ amountCents: 50_000, receivedAt: new Date('2026-08-01T12:00:00Z') }],
      NOW,
    );

    expect(flow.receivedCents).toBe(0);
  });

  it('ignores drafts, which have been billed to nobody', () => {
    const flow = flowSince(
      [invoice({ status: 'draft', issuedAt: new Date('2026-09-12T12:00:00Z') })],
      [],
      NOW,
    );

    expect(flow.invoicedCents).toBe(0);
  });
});

/* -------------------------------------------------------------------------
 * The thing only this screen can see
 * ---------------------------------------------------------------------- */

describe('owing money while their money is held', () => {
  const names = new Map([
    ['c1', 'Cardinal Logistics Brokerage'],
    ['c2', 'Hollis Motors'],
    ['c3', 'Bayside Auto Group'],
  ]);

  it('finds the customers who are both, and says what would settle', () => {
    const rows = creditStandoffs(
      new Map([
        ['c1', 187_500],
        ['c2', 40_000],
      ]),
      new Map([
        ['c1', 50_000],
        ['c2', 90_000],
      ]),
      names,
    );

    expect(rows).toHaveLength(2);

    // Ordered by what applying the credit would settle — the size of the
    // mistake being avoided, not the size of either figure alone.
    expect(rows[0]).toMatchObject({
      customerId: 'c1',
      owedCents: 187_500,
      heldCents: 50_000,
      applicableCents: 50_000,
    });
    expect(rows[1]).toMatchObject({ customerId: 'c2', applicableCents: 40_000 });
  });

  it('says nothing about somebody who only owes, or only holds', () => {
    const rows = creditStandoffs(
      new Map([['c1', 187_500]]),
      new Map([['c3', 50_000]]),
      names,
    );

    expect(rows).toEqual([]);
  });

  it('ignores a zero or negative balance either side', () => {
    expect(
      creditStandoffs(new Map([['c1', 0]]), new Map([['c1', 50_000]]), names),
    ).toEqual([]);

    expect(
      creditStandoffs(new Map([['c1', 187_500]]), new Map([['c1', 0]]), names),
    ).toEqual([]);
  });

  it('names a customer it does not recognise rather than showing an id', () => {
    const rows = creditStandoffs(
      new Map([['gone', 100_000]]),
      new Map([['gone', 50_000]]),
      new Map(),
    );

    expect(rows[0]?.customerName).toBe('Unknown customer');
  });
});

/* -------------------------------------------------------------------------
 * What needs somebody today
 * ---------------------------------------------------------------------- */

describe('the attention list', () => {
  const empty = {
    promisesNotKept: 0,
    noticesDue: 0,
    standoffs: 0,
    heldBack: new Map<HoldReason, number>(),
    failedNotices: 0,
  };

  it('says nothing at all when there is nothing to say', () => {
    /*
     * A fixed set of counters showing zero teaches a reader to stop looking.
     * The whole value of this section is that a glance at it means something.
     */
    expect(attention(empty)).toEqual([]);
  });

  it('puts the worst first', () => {
    const rows = attention({
      ...empty,
      promisesNotKept: 2,
      standoffs: 1,
      noticesDue: 5,
    });

    expect(rows.map((row) => row.key)).toEqual(['promises', 'standoffs', 'notices']);
    expect(rows[0]?.tone).toBe('danger');
  });

  it('never nags about an invoice somebody decided not to chase', () => {
    /*
     * Disputed, paused, covered by credit the customer holds — those are
     * decisions already made. A list that reopens them is a list that gets
     * ignored, and then the rows that matter get ignored with it.
     */
    const rows = attention({
      ...empty,
      heldBack: new Map<HoldReason, number>([
        ['disputed', 3],
        ['paused', 2],
        ['covered_by_credit', 1],
        ['recently_paid', 4],
      ]),
    });

    expect(rows).toEqual([]);
  });

  it('does raise the ones nobody chose', () => {
    // No address on file and chasing switched off are not decisions about
    // this debt; they are gaps somebody can close.
    const rows = attention({
      ...empty,
      heldBack: new Map<HoldReason, number>([
        ['no_email', 2],
        ['customer_opted_out', 1],
        ['disputed', 9],
      ]),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'unchaseable', count: 3 });
  });

  it('makes the verb agree with the noun, not just the noun with itself', () => {
    /*
     * Asserted whole rather than by substring. "1 customer owe you" is the
     * shape that gets past a review — the noun looks handled and the verb is
     * three words away — and an assertion on "customer owe" would pin the
     * bug rather than catch it.
     */
    const one = attention({
      ...empty,
      promisesNotKept: 1,
      standoffs: 1,
      noticesDue: 1,
      failedNotices: 1,
      heldBack: new Map<HoldReason, number>([['no_email', 1]]),
    });

    expect(one.map((row) => row.label)).toEqual([
      'promise not kept',
      'customer owes you while you hold their money',
      'notice could not be sent',
      'overdue invoice cannot be chased automatically',
      'notice goes out on the next sweep',
    ]);

    const many = attention({
      ...empty,
      promisesNotKept: 3,
      standoffs: 2,
      noticesDue: 4,
      failedNotices: 2,
      heldBack: new Map<HoldReason, number>([['no_email', 2]]),
    });

    expect(many.map((row) => row.label)).toEqual([
      'promises not kept',
      'customers owe you while you hold their money',
      'notices could not be sent',
      'overdue invoices cannot be chased automatically',
      'notices go out on the next sweep',
    ]);
  });

  it('ends every row somewhere the thing can be done', () => {
    const rows = attention({
      ...empty,
      promisesNotKept: 1,
      standoffs: 1,
      noticesDue: 1,
      failedNotices: 1,
      heldBack: new Map<HoldReason, number>([['no_email', 1]]),
    });

    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row.href).toMatch(/^\//);
  });
});

describe('the aging summary', () => {
  it('names the oldest bucket carrying money', () => {
    expect(
      worstBucket({ current: 900_000, '1_30': 10_000, '31_60': 0, '61_90': 5_000, '90_plus': 0 }),
    ).toEqual({ bucket: '61_90', cents: 5_000 });
  });

  it('is nothing when only current money is outstanding', () => {
    expect(
      worstBucket({ current: 900_000, '1_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0 }),
    ).toBeNull();
  });
});
