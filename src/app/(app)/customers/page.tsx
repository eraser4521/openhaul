import { AlertTriangle, Check, Users } from 'lucide-react';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import { EmptyState, PageBody, PageHeader } from '@/components/app/page-header';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { phone, relativeTime } from '@/lib/utils/format';
import { CarrierLookup } from '@/components/app/carrier-lookup';
import { checksByCustomer } from '@/lib/fmcsa/lookup';
import { hasFmcsaKey } from '@/lib/fmcsa/qcmobile';
import { InsurancePanel } from '@/components/app/insurance-panel';
import { listCertificates } from '@/lib/insurance/certificates';
import { balancesByCustomer, movementsFor } from '@/lib/invoices/customer-credit';
import { CreditLedger } from '@/components/app/credit-ledger';
import { StatementPanel } from '@/components/app/statement-panel';
import { statementsFor, statementView } from '@/lib/invoices/statement-document';
import { scheduleFor } from '@/lib/invoices/statement-run';
import { can } from '@/lib/auth/capabilities';

export const metadata = { title: 'Customers' };

export default async function CustomersPage() {
  const { session, db } = await requireSessionOrRedirect();

  const [customers, checks, balances, invoices] = await Promise.all([
    db.select('customers'),
    checksByCustomer(db),
    balancesByCustomer(db),
    db.select('invoices'),
  ]);

  const invoiceNumbers = new Map(invoices.map((invoice) => [invoice.id, invoice.number]));

  /*
   * Only for customers who have ever had a movement. A ledger query for every
   * customer on a screen that lists all of them would be a query per card,
   * and almost all of them have no credit at all.
   */
  const ledgers = new Map(
    await Promise.all(
      customers
        .filter((customer) => balances.has(customer.id))
        .map(async (customer) => [customer.id, await movementsFor(db, customer.id)] as const),
    ),
  );

  const canStatement = can(session.role, 'invoice.read');
  const schedule = await scheduleFor(db);

  /*
   * The account position is worked out per customer rather than once, because
   * the figure on the card has to be the figure a statement would print — and
   * that comes from the same function the document uses. Two ways of counting
   * what a customer owes is how a screen and a document start disagreeing.
   */
  const accounts = new Map(
    canStatement
      ? await Promise.all(
          customers.map(
            async (customer) =>
              [
                customer.id,
                {
                  view: await statementView(db, customer.id, { windowDays: 90 }),
                  history: await statementsFor(db, customer.id),
                },
              ] as const,
          ),
        )
      : [],
  );
  const configured = hasFmcsaKey();
  const canEdit = can(session.role, 'customer.write');

  /*
   * One query per customer rather than one big one, because the scoped client
   * filters by customer id and a carrier has tens of these, not thousands.
   */
  const covers = new Map(
    await Promise.all(
      customers.map(
        async (customer) => [customer.id, await listCertificates(db, customer.id)] as const,
      ),
    ),
  );

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

                      {canStatement && accounts.has(customer.id) && (
                        <div className="mt-3 border-t border-line pt-3">
                          <StatementPanel
                            customerId={customer.id}
                            balanceCents={
                              accounts.get(customer.id)!.view.totals.closingDueCents
                            }
                            heldCents={accounts.get(customer.id)!.view.totals.closingHeldCents}
                            openItemCount={accounts.get(customer.id)!.view.items.length}
                            canBuild={canStatement}
                            scheduled={customer.statementsEnabled}
                            scheduleOn={schedule.cadence !== 'off'}
                            chased={customer.dunningEnabled}
                            statements={accounts.get(customer.id)!.history.map((row) => ({
                              id: row.id,
                              issuedAt: row.issuedAt.toISOString(),
                              windowDays: row.windowDays,
                              balanceCents: row.balanceCents,
                              heldCents: row.heldCents,
                              openItemCount: row.openItemCount,
                              documentId: row.documentId,
                            }))}
                          />
                        </div>
                      )}

                      <div className="mt-3 border-t border-line pt-3">
                        <CreditLedger
                          balanceCents={balances.get(customer.id) ?? 0}
                          movements={(ledgers.get(customer.id) ?? []).map((movement) => ({
                            id: movement.id,
                            direction: movement.direction,
                            amountCents: movement.amountCents,
                            occurredAt: movement.occurredAt.toISOString(),
                            note: movement.note,
                            invoiceId: movement.invoiceId,
                            invoiceNumber: invoiceNumbers.get(movement.invoiceId) ?? null,
                            creditNoteNumber: null,
                          }))}
                        />
                      </div>

                      <div className="mt-3 border-t border-line pt-3">
                        <InsurancePanel
                          customerId={customer.id}
                          framed={false}
                          compact
                          title="Insurance"
                          description="What the lookup above cannot tell you. Cargo cover is never filed, so a certificate is the only evidence."
                          canEdit={canEdit}
                          certificates={(covers.get(customer.id) ?? []).map((certificate) => ({
                            id: certificate.id,
                            kind: certificate.kind,
                            insurerName: certificate.insurerName,
                            policyNumber: certificate.policyNumber,
                            coverageLimitCents: certificate.coverageLimitCents,
                            deductibleCents: certificate.deductibleCents,
                            effectiveAt: certificate.effectiveAt.toISOString(),
                            expiresAt: certificate.expiresAt.toISOString(),
                            documentId: certificate.documentId,
                            verifiedAt: certificate.verifiedAt?.toISOString() ?? null,
                          }))}
                        />
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
