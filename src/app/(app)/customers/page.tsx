import { Users } from 'lucide-react';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import { EmptyState, PageBody, PageHeader } from '@/components/app/page-header';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { phone } from '@/lib/utils/format';

export const metadata = { title: 'Customers' };

export default async function CustomersPage() {
  const { db } = await requireSessionOrRedirect();
  const customers = await db.select('customers');

  return (
    <>
      <PageHeader
        title="Customers"
        description="Brokers, shippers, dealers and auctions you move freight for."
      />
      <PageBody>
        {customers.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No customers yet"
            description="Customers are created as you book loads. Each one carries its payment terms, authority numbers and insurance certificate expiry."
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {customers.map((customer) => (
              <li key={customer.id}>
                <Card interactive className="h-full p-5">
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="text-sm font-semibold text-ink">{customer.name}</h2>
                    <Badge tone="neutral" size="sm" className="capitalize">
                      {customer.kind}
                    </Badge>
                  </div>
                  <dl className="mt-3 space-y-1 text-xs text-ink-secondary">
                    {customer.mcNumber && <dd>MC {customer.mcNumber}</dd>}
                    {customer.phone && <dd>{phone(customer.phone)}</dd>}
                    {customer.email && <dd className="truncate">{customer.email}</dd>}
                  </dl>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </PageBody>
    </>
  );
}
