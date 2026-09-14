import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { AlertTriangle, Download, IdCard, Scale, Wallet } from 'lucide-react';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import {
  drivers as driversTable,
  loads as loadsTable,
  settlementLines as linesTable,
  settlements as settlementsTable,
} from '@/lib/db/schema';
import { PageBody, PageHeader } from '@/components/app/page-header';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { money } from '@/lib/utils/format';
import { can } from '@/lib/auth/capabilities';
import {
  describeBasis,
  isPaymentLate,
  LINE_LABEL,
  payBasisFor,
  paymentDueBy,
  settlementStatus,
  signedCents,
  STATUS_LABEL,
  totalsFrom,
} from '@/lib/settlements/compute';
import { driverEscrowBalance } from '@/lib/settlements/lifecycle';
import { statementNumber } from '@/lib/settlements/statement';
import { RemoveLine, SettlementEditor } from '@/components/app/settlement-editor';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { db } = await requireSessionOrRedirect();
    const settlement = await db.selectOne('settlements', eq(settlementsTable.id, id));
    if (!settlement) return { title: 'Settlement' };
    const driver = await db.selectOne('drivers', eq(driversTable.id, settlement.driverId));
    return {
      title: driver ? statementNumber(driver.displayName, settlement.periodEnd) : 'Settlement',
    };
  } catch {
    return { title: 'Settlement' };
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

const STATUS_TONE = { draft: 'neutral', finalized: 'info', paid: 'ok' } as const;

export default async function SettlementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { session, db } = await requireSessionOrRedirect();

  const settlement = await db.selectOne('settlements', eq(settlementsTable.id, id));
  if (!settlement) notFound();

  const [driver, lines] = await Promise.all([
    db.selectOne('drivers', eq(driversTable.id, settlement.driverId)),
    db.select('settlementLines', eq(linesTable.settlementId, id), {
      orderBy: { column: linesTable.sequence, direction: 'asc' },
    }),
  ]);

  if (!driver) notFound();

  const loadNumbers = new Map<string, string>();
  for (const loadId of new Set(lines.map((l) => l.loadId).filter((x): x is string => x !== null))) {
    const load = await db.selectOne('loads', eq(loadsTable.id, loadId));
    if (load) loadNumbers.set(loadId, load.number);
  }

  const now = new Date();
  const status = settlementStatus(settlement);
  const totals = totalsFrom(lines);
  const leased = driver.employmentType === 'owner_operator';
  const late = isPaymentLate(settlement, driver.employmentType, now);
  const escrow = await driverEscrowBalance(db, driver.id);
  const number = statementNumber(driver.displayName, settlement.periodEnd);

  return (
    <>
      <PageHeader
        title={number}
        description={`${driver.displayName} · ${dateText(settlement.periodStart)} — ${dateText(settlement.periodEnd)}`}
        actions={
          <>
            <Link href="/drivers" className={cn(buttonVariants({ variant: 'secondary' }))}>
              <IdCard aria-hidden />
              Drivers
            </Link>
            {settlement.documentId && (
              <a
                href={`/api/documents/${settlement.documentId}?download=1`}
                className={cn(buttonVariants())}
              >
                <Download aria-hidden />
                Statement
              </a>
            )}
          </>
        }
      />

      <PageBody className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
          <Badge tone={leased ? 'info' : 'neutral'}>
            {leased ? 'Leased owner-operator' : 'Company driver'}
          </Badge>
          <Badge tone="neutral">{describeBasis(payBasisFor(driver))}</Badge>
          {late && (
            <Badge tone="danger">
              <AlertTriangle aria-hidden />
              Past the 15-day window
            </Badge>
          )}
        </div>

        {leased && late && (
          <Card className="p-5">
            <p className="text-sm leading-relaxed text-ink-secondary">
              49 CFR 376.12(f) requires a leased owner-operator to be paid within fifteen days of
              submitting the paperwork needed to bill these loads. That fell due on{' '}
              <strong className="text-ink">{dateText(paymentDueBy(settlement.periodEnd))}</strong>.
            </p>
          </Card>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: 'Earnings', value: money(totals.earningsCents) },
            { label: 'Reimbursements', value: money(totals.reimbursementsCents) },
            {
              label: 'Taken off',
              value: money(totals.deductionsCents + totals.advancesCents + totals.escrowHeldCents),
            },
            { label: 'Net pay', value: money(totals.netPayCents) },
          ].map((stat) => (
            <Card key={stat.label} className="p-5">
              <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
                {stat.label}
              </p>
              <p className="mt-2 text-xl font-semibold text-ink tabular-nums">{stat.value}</p>
            </Card>
          ))}
        </div>

        <section>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
            <Scale className="size-4 text-ink-muted" aria-hidden />
            Lines
          </h2>

          {lines.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs leading-relaxed text-ink-muted">
              Nothing on this settlement. No delivered loads fell in the period, or they were all
              paid on an earlier one.
            </p>
          ) : (
            <Card>
              <ul className="divide-y divide-line">
                {lines.map((line) => (
                  <li key={line.id} className="flex items-start justify-between gap-3 px-5 py-3.5">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2">
                        <Badge tone="neutral" size="sm">
                          {LINE_LABEL[line.kind]}
                        </Badge>
                        <span className="text-sm text-ink">{line.description}</span>
                        {line.loadId && (
                          <Link
                            href={`/loads/${line.loadId}`}
                            className="font-mono text-xs text-brand hover:underline"
                          >
                            {loadNumbers.get(line.loadId) ?? 'load'}
                          </Link>
                        )}
                      </p>
                      {line.basisNote && (
                        <p className="mt-0.5 text-xs text-ink-muted">{line.basisNote}</p>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <span
                        className={
                          'text-sm tabular-nums ' +
                          (signedCents(line) < 0 ? 'text-warn' : 'text-ink')
                        }
                      >
                        {money(signedCents(line))}
                      </span>
                      <RemoveLine
                        settlementId={settlement.id}
                        lineId={line.id}
                        disabled={settlement.finalizedAt !== null || !can(session.role, 'settlement.write')}
                      />
                    </div>
                  </li>
                ))}
              </ul>

              <div className="flex items-center justify-between border-t border-line bg-raised px-5 py-3.5">
                <span className="text-sm font-semibold text-ink">Net pay</span>
                <span className="text-base font-semibold text-ink tabular-nums">
                  {money(totals.netPayCents)}
                </span>
              </div>
            </Card>
          )}
        </section>

        {(leased || escrow !== 0) && (
          <section>
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
              <Wallet className="size-4 text-ink-muted" aria-hidden />
              Escrow
            </h2>
            <Card className="p-5">
              <p className="text-xl font-semibold text-ink tabular-nums">{money(escrow)}</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
                Held across every settlement for {driver.displayName}, not just this one.
                {leased &&
                  ' Under 49 CFR 376.12(h) they may demand an accounting of it at any time, and it is returned within 45 days of the lease ending.'}
              </p>
            </Card>
          </section>
        )}

        {settlement.paidAt && (
          <Card className="p-5">
            <p className="text-sm text-ink">
              Paid {dateText(settlement.paidAt)}
              {settlement.paymentReference ? ` · ${settlement.paymentReference}` : ''}
            </p>
          </Card>
        )}

        <section className="border-t border-line pt-5">
          <SettlementEditor
            settlementId={settlement.id}
            finalized={settlement.finalizedAt !== null}
            paid={settlement.paidAt !== null}
            canWrite={can(session.role, 'settlement.write')}
            leased={leased}
            netPayCents={settlement.netPayCents}
            today={now.toISOString().slice(0, 10)}
          />
        </section>
      </PageBody>
    </>
  );
}
