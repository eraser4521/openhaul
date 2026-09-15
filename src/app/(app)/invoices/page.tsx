import Link from 'next/link';
import { CalendarCheck, Receipt } from 'lucide-react';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import { EmptyState, PageBody, PageHeader } from '@/components/app/page-header';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { money, relativeTime } from '@/lib/utils/format';
import {
  AGING_BUCKETS,
  AGING_LABEL,
  ageReceivables,
  balanceCents,
  effectiveStatus,
  totalOutstanding,
} from '@/lib/invoices/compute';
import { INVOICE_STATUS_TONE, invoiceStatusLabel } from '@/lib/invoices/display';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { worklist } from '@/lib/invoices/promise-record';

export const metadata = { title: 'Invoices' };

export default async function InvoicesPage() {
  const { db } = await requireSessionOrRedirect();
  const [invoices, customers, refunds] = await Promise.all([
    db.select('invoices'),
    db.select('customers'),
    db.select('refunds'),
  ]);

  const now = new Date();

  /*
   * Refunds are rows rather than a column, so the position of every invoice
   * is assembled once here. Leaving them out would show an invoice that was
   * overpaid and sent back as still owing money to the customer, on the one
   * screen a carrier scans to decide what to chase.
   */
  const refundedBy = new Map<string, number>();
  for (const refund of refunds) {
    refundedBy.set(refund.invoiceId, (refundedBy.get(refund.invoiceId) ?? 0) + refund.amountCents);
  }

  const positions = invoices.map((invoice) => ({
    ...invoice,
    refundedCents: refundedBy.get(invoice.id) ?? 0,
  }));

  const outstanding = totalOutstanding(positions);
  const aged = ageReceivables(positions, now);
  const customerName = new Map(customers.map((customer) => [customer.id, customer.name]));

  const sorted = positions.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  /*
   * Promises live on their own screen because working them is a different
   * job from reading an aging report. The count comes here so somebody does
   * not have to go and look to find out whether there is anything to do.
   */
  const promises = await worklist(db, now);
  const missed = promises.totals.not_kept.count;
  const promised = promises.totals.not_kept.count + promises.totals.in_the_post.count +
    promises.totals.expected.count;

  return (
    <>
      <PageHeader
        title="Invoices"
        description={
          invoices.length > 0
            ? `${money(outstanding)} outstanding across ${invoices.length} invoice${invoices.length === 1 ? '' : 's'}`
            : 'Raised from a delivered load, with the signed paperwork attached.'
        }
        actions={
          promised > 0 ? (
            <Link
              href="/invoices/promises"
              className={cn(buttonVariants({ variant: missed > 0 ? 'primary' : 'secondary' }))}
            >
              <CalendarCheck aria-hidden />
              {missed > 0
                ? `${missed} promise${missed === 1 ? '' : 's'} not kept`
                : `${promised} promise${promised === 1 ? '' : 's'}`}
            </Link>
          ) : undefined
        }
      />
      <PageBody className="space-y-6">
        {invoices.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No invoices yet"
            description="Issue a delivery receipt on a load and its invoice can be raised from the rate already on file, citing the signed paperwork so the broker has no reason to hold it."
          />
        ) : (
          <>
            {/*
              Aging by how late payment is, not how old the invoice is. Two
              invoices raised the same morning on net 10 and net 60 are not
              equally late, and lateness is what gets chased.
            */}
            <section>
              <h2 className="mb-3 text-sm font-semibold text-ink">Receivables</h2>
              <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
                {AGING_BUCKETS.map((bucket) => (
                  <Card key={bucket} className="p-4">
                    <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
                      {AGING_LABEL[bucket]}
                    </p>
                    <p
                      className={
                        'mt-2 text-lg font-semibold tabular-nums ' +
                        (aged[bucket] > 0 && bucket !== 'current' ? 'text-warn' : 'text-ink')
                      }
                    >
                      {money(aged[bucket])}
                    </p>
                  </Card>
                ))}
              </div>
            </section>

            <section>
              <h2 className="mb-3 text-sm font-semibold text-ink">All invoices</h2>
              <ul className="space-y-2">
                {sorted.map((invoice) => {
                  const status = effectiveStatus(invoice, now);
                  const balance = balanceCents(invoice);

                  return (
                    <li key={invoice.id}>
                      <Link href={`/invoices/${invoice.id}`} className="block">
                        <Card
                          interactive
                          className="flex flex-wrap items-center justify-between gap-3 p-4"
                        >
                          <div className="min-w-0">
                            <p className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-sm font-medium text-ink">
                                {invoice.number}
                              </span>
                              <Badge tone={INVOICE_STATUS_TONE[status]} size="sm">
                                {invoiceStatusLabel(status)}
                              </Badge>
                            </p>
                            <p className="mt-1 text-xs text-ink-secondary">
                              {invoice.customerId
                                ? (customerName.get(invoice.customerId) ?? 'Customer removed')
                                : 'No customer'}
                              {' · '}
                              {invoice.issuedAt
                                ? `issued ${relativeTime(invoice.issuedAt)}`
                                : `drafted ${relativeTime(invoice.createdAt)}`}
                            </p>
                            {invoice.factoringCompanyName && (
                              <p className="mt-0.5 text-xs text-ink-muted">
                                Assigned to {invoice.factoringCompanyName}
                              </p>
                            )}
                          </div>

                          <div className="text-right">
                            <p className="text-sm font-semibold text-ink tabular-nums">
                              {money(invoice.totalCents)}
                            </p>
                            {invoice.status !== 'void' && balance !== 0 && (
                              <p className="mt-0.5 text-xs text-ink-muted tabular-nums">
                                {balance > 0
                                  ? `${money(balance)} outstanding`
                                  : `${money(-balance)} to refund`}
                              </p>
                            )}
                          </div>
                        </Card>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          </>
        )}
      </PageBody>
    </>
  );
}
