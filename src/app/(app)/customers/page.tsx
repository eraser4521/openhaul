import { AlertTriangle, Check, Users } from 'lucide-react';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import { EmptyState, PageBody, PageHeader } from '@/components/app/page-header';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { phone, relativeTime } from '@/lib/utils/format';
import { CarrierLookup } from '@/components/app/carrier-lookup';
import { checksByCustomer } from '@/lib/fmcsa/lookup';
import { hasFmcsaKey } from '@/lib/fmcsa/qcmobile';

export const metadata = { title: 'Customers' };

export default async function CustomersPage() {
  const { db } = await requireSessionOrRedirect();

  const [customers, checks] = await Promise.all([db.select('customers'), checksByCustomer(db)]);
  const configured = hasFmcsaKey();

  return (
    <>
      <PageHeader
        title="Customers"
        description="Brokers, shippers, dealers and auctions you move freight for."
      />
      <PageBody className="space-y-6">
        <CarrierLookup configured={configured} />

        {customers.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No customers yet"
            description="Customers are created as you book loads. Each one carries its payment terms and authority numbers, and can be checked against FMCSA from here."
          />
        ) : (
          <section>
            <h2 className="mb-3 text-sm font-semibold text-ink">On file</h2>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {customers.map((customer) => {
                const check = checks.get(customer.id);

                return (
                  <li key={customer.id}>
                    <Card className="h-full p-5">
                      <div className="flex items-start justify-between gap-3">
                        <h3 className="text-sm font-semibold text-ink">{customer.name}</h3>
                        <Badge tone="neutral" size="sm" className="capitalize">
                          {customer.kind}
                        </Badge>
                      </div>

                      <dl className="mt-3 space-y-1 text-xs text-ink-secondary">
                        {customer.usdotNumber && <dd>USDOT {customer.usdotNumber}</dd>}
                        {customer.mcNumber && <dd>MC {customer.mcNumber}</dd>}
                        {customer.phone && <dd>{phone(customer.phone)}</dd>}
                        {customer.email && <dd className="truncate">{customer.email}</dd>}
                      </dl>

                      <div className="mt-3 border-t border-line pt-3">
                        {check ? (
                          <p className="flex items-start gap-1.5 text-xs leading-relaxed">
                            {check.outOfService || check.allowedToOperate === false ? (
                              <>
                                <AlertTriangle
                                  className="mt-px size-3.5 shrink-0 text-danger"
                                  aria-hidden
                                />
                                <span className="text-danger">
                                  FMCSA said not permitted to operate,{' '}
                                  {relativeTime(check.checkedAt)}
                                </span>
                              </>
                            ) : (
                              <>
                                <Check className="mt-px size-3.5 shrink-0 text-ok" aria-hidden />
                                <span className="text-ink-muted">
                                  Registered and permitted, checked {relativeTime(check.checkedAt)}
                                </span>
                              </>
                            )}
                          </p>
                        ) : (
                          <p className="text-xs text-ink-muted">
                            {customer.usdotNumber || customer.mcNumber
                              ? 'Never checked against FMCSA.'
                              : 'No USDOT or MC number on file to check.'}
                          </p>
                        )}
                      </div>
                    </Card>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </PageBody>
    </>
  );
}
