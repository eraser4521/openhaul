import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowRight, Check, PiggyBank } from 'lucide-react';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import { can } from '@/lib/auth/capabilities';
import { PageBody, PageHeader } from '@/components/app/page-header';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { money } from '@/lib/utils/format';
import { AGING_LABEL, ageReceivables, balanceCents } from '@/lib/invoices/compute';
import {
  attention,
  creditStandoffs,
  flowSince,
  live,
  overdueCents,
  owedCents,
  worstBucket,
} from '@/lib/invoices/overview';
import { balancesByCustomer } from '@/lib/invoices/customer-credit';
import { worklist } from '@/lib/invoices/promise-record';
import { chaseable, failedNotices, ladderFor, recentDunningRuns, ruleFor } from '@/lib/invoices/dunning-run';
import type { HoldReason } from '@/lib/invoices/dunning';

export const metadata = { title: 'Money' };

/**
 * Where the money stands, on one page.
 *
 * Every figure is answered well somewhere else — receivables on the invoice
 * list, promises on their worklist, credit on the customer cards, chasing in
 * settings. What none of those can do is put them beside each other, which is
 * what somebody deciding on a Monday morning whether they are going to get
 * paid actually needs.
 *
 * Four figures for the position and no controls. What is left off matters as
 * much as what is on: no charts, no per-customer tables, no date pickers. A
 * page read for ten seconds before the telephone starts cannot open with a
 * question.
 */
export default async function MoneyPage() {
  const { session, db } = await requireSessionOrRedirect();
  if (!can(session.role, 'invoice.read')) redirect('/dashboard');

  const now = new Date();

  const [invoices, payments, refunds, customers, held, promises, rule] = await Promise.all([
    db.select('invoices'),
    db.select('payments'),
    db.select('refunds'),
    db.select('customers'),
    balancesByCustomer(db),
    worklist(db, now),
    ruleFor(db),
  ]);

  const refundedBy = new Map<string, number>();
  for (const refund of refunds) {
    refundedBy.set(refund.invoiceId, (refundedBy.get(refund.invoiceId) ?? 0) + refund.amountCents);
  }

  const positions = invoices.map((invoice) => ({
    ...invoice,
    refundedCents: refundedBy.get(invoice.id) ?? 0,
  }));

  /*
   * Only what is still owed and still expected. A promise somebody did not
   * keep is the opposite of money coming, and counting it here would flatter
   * the figure at exactly the moment it should not be flattered.
   */
  const promisedCents =
    promises.totals.expected.outstandingCents + promises.totals.in_the_post.outstandingCents;

  const heldTotal = [...held.values()].reduce((sum, cents) => sum + Math.max(0, cents), 0);

  const owedByCustomer = new Map<string, number>();
  for (const invoice of live(positions)) {
    if (!invoice.customerId) continue;
    const balance = Math.max(0, balanceCents(invoice));
    if (balance === 0) continue;
    owedByCustomer.set(invoice.customerId, (owedByCustomer.get(invoice.customerId) ?? 0) + balance);
  }

  const standoffs = creditStandoffs(
    owedByCustomer,
    held,
    new Map(customers.map((customer) => [customer.id, customer.name])),
  );

  const aged = ageReceivables(positions, now);
  const worst = worstBucket(aged);
  const flow = flowSince(positions, payments, now);

  /*
   * The chasing figures come from the same functions the sweep uses, so this
   * page cannot promise a notice the sweep would not send.
   */
  const ladder = await ladderFor(db);
  const chaseRows = rule.enabled ? await chaseable(db, rule, ladder, now) : [];
  const lastRun = (await recentDunningRuns(db, 1))[0];
  const failed = lastRun ? (await failedNotices(db, lastRun.id)).length : 0;

  const heldBack = new Map<HoldReason, number>();
  for (const row of chaseRows) {
    if (row.decision.chase) continue;
    if (row.decision.daysPastDue <= 0 || row.decision.balanceCents <= 0) continue;
    heldBack.set(row.decision.reason, (heldBack.get(row.decision.reason) ?? 0) + 1);
  }

  const todo = attention({
    promisesNotKept: promises.totals.not_kept.count,
    noticesDue: chaseRows.filter((row) => row.decision.chase).length,
    standoffs: standoffs.length,
    heldBack,
    failedNotices: failed,
  });

  const owed = owedCents(positions);
  const overdue = overdueCents(positions, now);

  const figures = [
    {
      label: 'Owed to you',
      value: money(owed),
      hint: overdue > 0 ? `${money(overdue)} of it past due` : 'None of it past due',
      href: '/invoices',
    },
    {
      label: 'Promised',
      value: money(promisedCents),
      // "Commitments still standing" under a zero describes commitments that
      // do not exist. A hint has to be true of the figure above it.
      hint:
        promises.totals.not_kept.count > 0
          ? `${promises.totals.not_kept.count} more not kept`
          : promisedCents > 0
            ? 'Commitments still standing'
            : 'Nothing promised',
      href: '/invoices/promises',
    },
    {
      label: 'Held for customers',
      value: money(heldTotal),
      // Named as theirs every time it appears. It sits in the same bank
      // account as everything else and is the figure most easily mistaken
      // for income.
      hint: heldTotal > 0 ? 'Their money, not yours' : 'Nothing on account',
      href: '/customers',
    },
    {
      label: 'Billed this week',
      value: money(flow.invoicedCents),
      hint: `${money(flow.receivedCents)} collected`,
      href: '/invoices',
    },
  ];

  return (
    <>
      <PageHeader
        title="Money"
        description={
          owed > 0
            ? worst
              ? `${money(owed)} outstanding, the oldest of it ${AGING_LABEL[worst.bucket].toLowerCase()} past due`
              : `${money(owed)} outstanding, none of it late`
            : 'Nothing is outstanding.'
        }
      />

      <PageBody className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {figures.map((figure) => (
            <Link key={figure.label} href={figure.href} className="block">
              <Card interactive className="h-full p-5">
                <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
                  {figure.label}
                </p>
                <p className="mt-2 text-xl font-semibold text-ink tabular-nums">{figure.value}</p>
                <p className="mt-0.5 text-xs text-ink-secondary">{figure.hint}</p>
              </Card>
            </Link>
          ))}
        </div>

        {/* --- What needs somebody ------------------------------------- */}

        <section>
          <h2 className="mb-3 text-sm font-semibold text-ink">What needs you</h2>

          {todo.length === 0 ? (
            <Card className="flex items-center gap-2 p-5 text-sm text-ink-secondary">
              <Check className="size-4 shrink-0 text-ok" aria-hidden />
              {/*
                * Only claims the ladder is working when it is. With chasing
                * switched off, "either being chased or deliberately not" is
                * an assurance nobody has earned.
                */}
              {rule.enabled
                ? 'Nothing needs you. Every overdue invoice is either being chased or deliberately not.'
                : overdue > 0
                  ? 'Nothing needs you here, though nothing is being chased automatically either.'
                  : 'Nothing needs you.'}
            </Card>
          ) : (
            <ul className="space-y-2">
              {todo.map((row) => (
                <li key={row.key}>
                  <Link href={row.href} className="block">
                    <Card
                      interactive
                      className="flex flex-wrap items-center justify-between gap-3 p-4"
                    >
                      <p className="flex items-center gap-2 text-sm text-ink">
                        <Badge tone={row.tone} size="sm">
                          {row.count}
                        </Badge>
                        {row.label}
                      </p>
                      <ArrowRight className="size-4 shrink-0 text-ink-muted" aria-hidden />
                    </Card>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* --- The one thing only this page can see --------------------- */}

        {standoffs.length > 0 && (
          <section>
            <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink">
              <PiggyBank className="size-4 text-ink-muted" aria-hidden />
              Owing you while you hold their money
            </h2>
            <p className="mb-3 text-xs leading-relaxed text-ink-muted">
              The invoice screen knows the balance and the customer screen knows the credit.
              Neither is in a position to notice both at once. Apply it from the invoice and it
              comes off what they owe.
            </p>

            <ul className="space-y-2">
              {standoffs.map((row) => (
                <li key={row.customerId}>
                  <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <p className="min-w-0 text-sm font-medium text-ink">{row.customerName}</p>
                    <p className="text-xs text-ink-secondary tabular-nums">
                      owes {money(row.owedCents)} · you hold {money(row.heldCents)} ·{' '}
                      <span className="text-brand">{money(row.applicableCents)} would settle</span>
                    </p>
                  </Card>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* --- Aging, compact ------------------------------------------- */}

        {owed > 0 && (
          <section>
            <h2 className="mb-3 text-sm font-semibold text-ink">How late it is</h2>
            <Card>
              <dl className="divide-y divide-line text-sm">
                {(Object.keys(aged) as Array<keyof typeof aged>)
                  .filter((bucket) => aged[bucket] > 0)
                  .map((bucket) => (
                    <div key={bucket} className="flex justify-between px-5 py-3">
                      <dt className={bucket === 'current' ? 'text-ink-secondary' : 'text-warn'}>
                        {AGING_LABEL[bucket]}
                      </dt>
                      <dd className="text-ink tabular-nums">{money(aged[bucket])}</dd>
                    </div>
                  ))}
              </dl>
            </Card>
          </section>
        )}
      </PageBody>
    </>
  );
}
