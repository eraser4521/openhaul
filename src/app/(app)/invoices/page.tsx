import Link from 'next/link';
import { Receipt } from 'lucide-react';
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

export const metadata = { title: 'Invoices' };

export default async function InvoicesPage() {
  const { db } = await requireSessionOrRedirect();
  const [invoices, customers] = await Promise.all([
    db.select('invoices'),
    db.select('customers'),
  ]);

  const now = new Date();
  const outstanding = totalOutstanding(invoices);
  const aged = ageReceivables(invoices, now);
  const customerName = new Map(customers.map((customer) => [customer.id, customer.name]));

  const sorted = invoices.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return (
    <>
      <PageHeader
        title="Invoices"
        description={
          invoices.length > 0
            ? `${money(outstanding)} outstanding across ${invoices.length} invoice${invoices.length === 1 ? '' : 's'}`
            : 'Raised from a delivered load, with the signed paperwork attached.'
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
                  const balance = balanceCents(invoice.totalCents, invoice.paidCents);

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
                                  : `${money(-balance)} overpaid`}
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
