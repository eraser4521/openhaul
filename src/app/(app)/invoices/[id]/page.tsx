import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { Download, FileText, Truck } from 'lucide-react';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import {
  claims as claimsTable,
  customers as customersTable,
  invoices as invoicesTable,
  loads as loadsTable,
  payments as paymentsTable,
} from '@/lib/db/schema';
import { PageBody, PageHeader } from '@/components/app/page-header';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { money, relativeTime } from '@/lib/utils/format';
import {
  BILLING_BASIS_LABEL,
  balanceCents,
  deriveCharges,
  effectiveStatus,
  grossCents,
} from '@/lib/invoices/compute';
import { termsLabel } from '@/lib/invoices/terms';
import { INVOICE_STATUS_TONE, invoiceStatusLabel, paymentMethodLabel } from '@/lib/invoices/display';
import { can } from '@/lib/auth/capabilities';
import { InvoiceDraftForm } from '@/components/app/invoice-draft-form';
import { PaymentForm, VoidInvoice } from '@/components/app/payment-form';
import { CreditNotes } from '@/components/app/credit-notes';
import { Refunds } from '@/components/app/refunds';
import { CustomerCredit } from '@/components/app/customer-credit';
import { checkRefundable, refundsFor } from '@/lib/invoices/refunds';
import {
  checkApplicable,
  checkCarryForward,
  movementsForInvoice,
} from '@/lib/invoices/customer-credit';
import { InvoiceAccessorials } from '@/components/app/invoice-accessorials';
import { checkCreditable, creditsFor } from '@/lib/invoices/credits';
import { voidBlockedReason } from '@/lib/invoices/lifecycle';
import { InvoiceDunning } from '@/components/app/invoice-dunning';
import { chaseable, ladderFor, noticesFor, ruleFor } from '@/lib/invoices/dunning-run';
import { promisesFor } from '@/lib/invoices/promise-record';
import { accessorialsFor, listRates } from '@/lib/branding/accessorials';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { db } = await requireSessionOrRedirect();
    const invoice = await db.selectOne('invoices', eq(invoicesTable.id, id));
    return { title: invoice?.number ?? 'Invoice' };
  } catch {
    return { title: 'Invoice' };
  }
}

function dateText(date: Date | null): string {
  if (!date) return '—';
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { session, db } = await requireSessionOrRedirect();

  const invoice = await db.selectOne('invoices', eq(invoicesTable.id, id));
  if (!invoice) notFound();

  const [
    customer,
    load,
    paymentRows,
    creditRows,
    creditGate,
    refundRows,
    refundGate,
    carryGate,
    applyGate,
    creditMovements,
    accessorials,
    catalogue,
  ] = await Promise.all([
      invoice.customerId
        ? db.selectOne('customers', eq(customersTable.id, invoice.customerId))
        : Promise.resolve(null),
      invoice.loadId
        ? db.selectOne('loads', eq(loadsTable.id, invoice.loadId))
        : Promise.resolve(null),
      db.select('payments', eq(paymentsTable.invoiceId, id)),
      creditsFor(db, id),
      checkCreditable(db, id),
      refundsFor(db, id),
      checkRefundable(db, id),
      checkCarryForward(db, id),
      checkApplicable(db, id),
      movementsForInvoice(db, id),
      accessorialsFor(db, id),
      listRates(db),
    ]);

  // Claims on the same load, so a credit can name the one it settles.
  const loadClaims = invoice.loadId
    ? await db.select('claims', eq(claimsTable.loadId, invoice.loadId))
    : [];
  const claimNumbers = new Map(loadClaims.map((claim) => [claim.id, claim.number]));

  const now = new Date();
  const refunded = refundRows.reduce((sum, refund) => sum + refund.amountCents, 0);
  const position = { ...invoice, refundedCents: refunded };
  const status = effectiveStatus(position, now);
  const balance = balanceCents(position);

  /*
   * Where this invoice sits on the ladder, decided by the same function the
   * sweep uses — so the card cannot say a notice is due while the sweep
   * leaves it alone, or the other way round.
   */
  const dunningRule = await ruleFor(db);
  const dunningLadder = await ladderFor(db);
  const [dunningNotices, chaseRows, promiseRows] = await Promise.all([
    noticesFor(db, id),
    chaseable(db, dunningRule, dunningLadder, now),
    promisesFor(db, id, now),
  ]);
  const chaseRow = chaseRows.find((row) => row.invoice.id === id);

  const charges = {
    lineHaulCents: invoice.lineHaulCents,
    fuelSurchargeCents: invoice.fuelSurchargeCents,
    accessorialCents: invoice.accessorialCents,
    taxCents: invoice.taxCents,
    codCollectedCents: invoice.codCollectedCents,
    depositCents: invoice.depositCents,
  };

  const basis = load ? deriveCharges(load).basis : 'rate';
  const isDraft = invoice.status === 'draft';
  const canWrite = can(session.role, 'invoice.write');
  const canPay = can(session.role, 'payment.write');

  return (
    <>
      <PageHeader
        title={invoice.number}
        description={
          customer ? `Billed to ${customer.name}` : 'No customer recorded on this invoice'
        }
        actions={
          <>
            {load && (
              <Link
                href={`/loads/${load.id}`}
                className={cn(buttonVariants({ variant: 'secondary' }))}
              >
                <Truck aria-hidden />
                {load.number}
              </Link>
            )}
            {invoice.documentId && (
              <a
                href={`/api/documents/${invoice.documentId}?download=1`}
                className={cn(buttonVariants())}
              >
                <Download aria-hidden />
                PDF
              </a>
            )}
          </>
        }
      />

      <PageBody className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={INVOICE_STATUS_TONE[status]}>{invoiceStatusLabel(status)}</Badge>
          <Badge tone="neutral">{termsLabel(invoice.terms)}</Badge>
          {invoice.factoringCompanyName && (
            <Badge tone="warn">Assigned to {invoice.factoringCompanyName}</Badge>
          )}
        </div>

        {invoice.status === 'void' && (
          <Card className="border-danger/40 p-5">
            <p className="text-sm font-medium text-ink">This invoice was voided</p>
            <p className="mt-1 text-sm leading-relaxed text-ink-secondary">
              {invoice.voidReason}
            </p>
            <p className="mt-2 text-xs text-ink-muted">
              Voided {invoice.voidedAt ? relativeTime(invoice.voidedAt) : ''}. It stays on the
              record so the number is never reused for a different document.
            </p>
          </Card>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: 'Total invoiced', value: money(invoice.totalCents) },
            { label: 'Received', value: money(invoice.paidCents) },
            {
              label: 'Credited',
              value: money(invoice.creditedCents),
              hint: invoice.creditedCents > 0 ? 'The invoice itself is unchanged' : undefined,
            },
            {
              label: balance >= 0 ? 'Balance due' : 'Owed back',
              value: money(Math.abs(balance)),
              hint: refunded > 0 ? `${money(refunded)} already sent back` : undefined,
            },
            {
              label: 'Payment due',
              value: dateText(invoice.dueAt),
              hint: invoice.issuedAt ? `Issued ${dateText(invoice.issuedAt)}` : 'Not issued yet',
            },
          ].map((stat) => (
            <Card key={stat.label} className="p-5">
              <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
                {stat.label}
              </p>
              <p className="mt-2 text-xl font-semibold text-ink tabular-nums">{stat.value}</p>
              {stat.hint && <p className="mt-0.5 text-xs text-ink-secondary">{stat.hint}</p>}
            </Card>
          ))}
        </div>

        {isDraft && canWrite ? (
          <InvoiceDraftForm
            invoiceId={invoice.id}
            values={{
              ...charges,
              terms: invoice.terms,
              factoringCompanyName: invoice.factoringCompanyName,
              factoringNoticeText: invoice.factoringNoticeText,
              notes: invoice.notes,
            }}
            basisNote={`${BILLING_BASIS_LABEL[basis]}. Check it against the rate confirmation before issuing.`}
            accessorialsItemised={accessorials.length > 0}
          />
        ) : (
          <Card>
            <div className="border-b border-line px-5 py-4">
              <h2 className="text-sm font-semibold text-ink">Charges</h2>
            </div>
            <dl className="divide-y divide-line text-sm">
              {[
                ['Line haul', charges.lineHaulCents, false],
                ['Fuel surcharge', charges.fuelSurchargeCents, false],
                ['Accessorials', charges.accessorialCents, false],
                ['Tax', charges.taxCents, false],
              ]
                .filter(([, cents]) => cents !== 0)
                .map(([label, cents]) => (
                  <div key={String(label)} className="flex justify-between px-5 py-3">
                    <dt className="text-ink-secondary">{String(label)}</dt>
                    <dd className="text-ink tabular-nums">{money(Number(cents))}</dd>
                  </div>
                ))}

              {(charges.codCollectedCents !== 0 || charges.depositCents !== 0) && (
                <div className="flex justify-between px-5 py-3">
                  <dt className="font-medium text-ink">Subtotal</dt>
                  <dd className="font-medium text-ink tabular-nums">
                    {money(grossCents(charges))}
                  </dd>
                </div>
              )}

              {charges.codCollectedCents !== 0 && (
                <div className="flex justify-between px-5 py-3">
                  <dt className="text-ink-secondary">Collected on delivery</dt>
                  <dd className="text-ink tabular-nums">({money(charges.codCollectedCents)})</dd>
                </div>
              )}
              {charges.depositCents !== 0 && (
                <div className="flex justify-between px-5 py-3">
                  <dt className="text-ink-secondary">Deposit held</dt>
                  <dd className="text-ink tabular-nums">({money(charges.depositCents)})</dd>
                </div>
              )}

              <div className="flex justify-between bg-raised px-5 py-3">
                <dt className="font-semibold text-ink">Total invoiced</dt>
                <dd className="font-semibold text-ink tabular-nums">{money(invoice.totalCents)}</dd>
              </div>

              {invoice.creditedCents > 0 && (
                <div className="flex justify-between px-5 py-3">
                  <dt className="text-ink-secondary">Credited by note</dt>
                  <dd className="text-ink tabular-nums">({money(invoice.creditedCents)})</dd>
                </div>
              )}
            </dl>

            {invoice.notes && (
              <div className="border-t border-line px-5 py-4">
                <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">Notes</p>
                <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-ink-secondary">
                  {invoice.notes}
                </p>
              </div>
            )}
          </Card>
        )}

        <InvoiceAccessorials
          invoiceId={invoice.id}
          lines={accessorials}
          catalogue={catalogue.map((rate) => ({
            id: rate.id,
            code: rate.code,
            label: rate.label,
            unit: rate.unit,
            defaultCents: rate.defaultCents,
            note: rate.note,
          }))}
          editable={isDraft && canWrite}
          totalCents={invoice.accessorialCents}
        />

        {!isDraft && invoice.status !== 'void' && (
          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-ink">Payments</h2>
              {canPay && (
                <PaymentForm
                  invoiceId={invoice.id}
                  balanceCents={balance}
                  today={now.toISOString().slice(0, 10)}
                />
              )}
            </div>

            {paymentRows.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-ink-muted">
                Nothing received yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {paymentRows
                  .slice()
                  .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
                  .map((payment) => (
                    <li
                      key={payment.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-raised p-3"
                    >
                      <div>
                        <p className="text-sm text-ink">
                          {paymentMethodLabel(payment.method)}
                          {payment.reference && (
                            <span className="ml-2 font-mono text-xs text-ink-muted">
                              {payment.reference}
                            </span>
                          )}
                        </p>
                        <p className="mt-0.5 text-xs text-ink-muted">
                          Received {dateText(payment.receivedAt)}
                        </p>
                      </div>
                      <p className="text-sm font-semibold text-ink tabular-nums">
                        {money(payment.amountCents)}
                      </p>
                    </li>
                  ))}
              </ul>
            )}
          </section>
        )}

        {invoice.documentId && (
          <section>
            <h2 className="mb-3 text-sm font-semibold text-ink">Issued document</h2>
            <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="flex items-center gap-3">
                <FileText className="size-4 text-ink-muted" aria-hidden />
                <div>
                  <p className="text-sm font-medium text-ink">Invoice {invoice.number}</p>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    Frozen when it was issued and checked against its hash on every view.
                  </p>
                </div>
              </div>
              <a
                href={`/api/documents/${invoice.documentId}`}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex h-8 items-center rounded-lg border border-line px-2.5 text-xs text-ink-secondary transition-colors hover:border-line-strong hover:text-ink"
              >
                View
              </a>
            </Card>
          </section>
        )}

        <InvoiceDunning
          invoiceId={invoice.id}
          enabled={dunningRule.enabled}
          balanceCents={Math.max(0, balance)}
          canWrite={canPay}
          promises={promiseRows.map((promise) => ({
            id: promise.id,
            amountCents: promise.amountCents,
            promisedFor: promise.promisedFor.toISOString(),
            madeAt: promise.madeAt.toISOString(),
            contactName: promise.contactName,
            channel: promise.channel,
            notes: promise.notes,
            cancelReason: promise.cancelReason,
            state: promise.outcome.state,
            receivedCents: promise.outcome.receivedCents,
            current: promise.current,
          }))}
          today={now.toISOString().slice(0, 10)}
          daysPastDue={chaseRow?.decision.daysPastDue ?? 0}
          chase={chaseRow?.decision.chase ?? false}
          reason={
            chaseRow && !chaseRow.decision.chase ? chaseRow.decision.reason : null
          }
          nextStageLabel={
            chaseRow?.decision.chase ? chaseRow.decision.stage.label : null
          }
          nextStageSequence={
            chaseRow?.decision.chase ? chaseRow.decision.stage.sequence : null
          }
          pausedUntil={invoice.dunningPausedUntil?.toISOString().slice(0, 10) ?? null}
          pauseReason={invoice.dunningPauseReason}
          notices={dunningNotices.map((notice) => ({
            id: notice.id,
            stageLabel: notice.stageLabel,
            stageSequence: notice.stageSequence,
            outcome: notice.outcome,
            detail: notice.detail,
            sentAt: notice.sentAt.toISOString(),
            documentId: notice.documentId,
            balanceCents: notice.balanceCents,
            daysPastDue: notice.daysPastDue,
          }))}
        />

        <CustomerCredit
          invoiceId={invoice.id}
          customerName={customer?.name ?? null}
          carryableCents={carryGate.carryableCents}
          applicableCents={applyGate.applicableCents}
          balanceCents={applyGate.balanceCents}
          canWrite={canPay}
          today={now.toISOString().slice(0, 10)}
          creditNotes={creditRows
            .filter((note) => note.voidedAt === null)
            .map((note) => ({ id: note.id, number: note.number, amountCents: note.amountCents }))}
          movements={creditMovements.map((movement) => ({
            id: movement.id,
            direction: movement.direction,
            amountCents: movement.amountCents,
            occurredAt: movement.occurredAt.toISOString(),
            note: movement.note,
            invoiceId: movement.invoiceId,
            invoiceNumber: invoice.number,
            creditNoteNumber:
              creditRows.find((note) => note.id === movement.creditNoteId)?.number ?? null,
          }))}
        />

        <Refunds
          invoiceId={invoice.id}
          refundableCents={refundGate.refundableCents}
          canWrite={canPay}
          today={now.toISOString().slice(0, 10)}
          creditNotes={creditRows
            .filter((note) => note.voidedAt === null)
            .map((note) => ({ id: note.id, number: note.number, amountCents: note.amountCents }))}
          refunds={refundRows.map((refund) => ({
            id: refund.id,
            amountCents: refund.amountCents,
            method: refund.method,
            reference: refund.reference,
            notes: refund.notes,
            issuedAt: refund.issuedAt.toISOString(),
            creditNoteNumber:
              creditRows.find((note) => note.id === refund.creditNoteId)?.number ?? null,
          }))}
        />

        {invoice.status !== 'draft' && invoice.status !== 'void' && (
          <section>
            <CreditNotes
              invoiceId={invoice.id}
              canWrite={canWrite}
              creditableCents={creditGate.creditableCents ?? 0}
              blockedReason={creditGate.ok ? null : (creditGate.reason ?? null)}
              claims={loadClaims.map((claim) => ({
                id: claim.id,
                number: claim.number,
                claimantName: claim.claimantName,
              }))}
              notes={creditRows.map((note) => ({
                id: note.id,
                number: note.number,
                reason: note.reason,
                detail: note.detail,
                amountCents: note.amountCents,
                createdAt: note.createdAt,
                voidedAt: note.voidedAt,
                voidReason: note.voidReason,
                documentId: note.documentId,
                claimNumber: note.claimId ? (claimNumbers.get(note.claimId) ?? null) : null,
              }))}
            />
          </section>
        )}

        {canWrite && invoice.status !== 'void' && (
          <section className="border-t border-line pt-5">
            <VoidInvoice
              invoiceId={invoice.id}
              blockedReason={voidBlockedReason(invoice, paymentRows.length)}
            />
          </section>
        )}
      </PageBody>
    </>
  );
}
