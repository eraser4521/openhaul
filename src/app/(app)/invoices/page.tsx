import { Receipt } from 'lucide-react';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import { EmptyState, PageBody, PageHeader } from '@/components/app/page-header';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { money } from '@/lib/utils/format';

export const metadata = { title: 'Invoices' };

export default async function InvoicesPage() {
  const { db } = await requireSessionOrRedirect();
  const invoices = await db.select('invoices');

  const outstanding = invoices
    .filter((i) => i.status !== 'paid' && i.status !== 'void')
    .reduce((sum, i) => sum + (i.totalCents - i.paidCents), 0);

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
      <PageBody>
        {invoices.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No invoices yet"
            description="Deliver a load and its invoice is built from the rate already on file, with the bill of lading and condition reports attached so the broker has no reason to hold it."
          />
        ) : (
          <ul className="space-y-2">
            {invoices.map((invoice) => (
              <li key={invoice.id}>
                <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div>
                    <p className="flex items-center gap-2">
                      <span className="font-mono text-sm font-medium text-ink">{invoice.number}</span>
                      <Badge
                        tone={
                          invoice.status === 'paid'
                            ? 'ok'
                            : invoice.status === 'overdue'
                              ? 'danger'
                              : 'neutral'
                        }
                        size="sm"
                      >
                        {invoice.status.replace(/_/g, ' ')}
                      </Badge>
                    </p>
                    {invoice.factoringCompanyName && (
                      <p className="mt-1 text-xs text-ink-secondary">
                        Assigned to {invoice.factoringCompanyName}
                      </p>
                    )}
                  </div>
                  <p className="text-sm font-semibold text-ink tabular-nums">
                    {money(invoice.totalCents)}
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </PageBody>
    </>
  );
}
