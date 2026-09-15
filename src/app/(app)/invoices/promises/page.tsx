import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, CalendarCheck, Phone } from 'lucide-react';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import { can } from '@/lib/auth/capabilities';
import { EmptyState, PageBody, PageHeader } from '@/components/app/page-header';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { money, relativeTime } from '@/lib/utils/format';
import { worklist } from '@/lib/invoices/promise-record';
import { CHANNEL_LABEL } from '@/lib/invoices/promise';
import {
  BUCKET_LABEL,
  BUCKET_NOTE,
  BUCKET_TONE,
  WORK_BUCKETS,
  describeTally,
} from '@/lib/invoices/promise-worklist';

export const metadata = { title: 'Promises to pay' };

function dateText(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Every promise, arranged for somebody working a phone.
 *
 * The invoice screen answers "what did this customer say about this invoice".
 * This is the other direction, and it is the one a bookkeeper works from: what
 * fell due and did not arrive, what is landing today, what is still to come.
 *
 * Ordered by what to do rather than by date or by customer. The first pile is
 * the calls to make; the second is the pile where the right action is to do
 * nothing, which is why it is named rather than folded in with the first.
 */
export default async function PromisesPage() {
  const { session, db } = await requireSessionOrRedirect();
  if (!can(session.role, 'invoice.read')) redirect('/invoices');

  const list = await worklist(db);
  const outstanding = list.totals.not_kept.outstandingCents;

  return (
    <>
      <PageHeader
        title="Promises to pay"
        description={
          list.rows.length > 0
            ? outstanding > 0
              ? `${money(outstanding)} promised and not arrived`
              : 'Nothing promised has been missed'
            : 'What customers have said they would pay, and when.'
        }
        actions={
          <Link
            href="/invoices"
            className={cn(buttonVariants({ variant: 'secondary' }))}
          >
            <ArrowLeft aria-hidden />
            Invoices
          </Link>
        }
      />

      <PageBody className="space-y-6">
        {list.rows.length === 0 ? (
          <EmptyState
            icon={CalendarCheck}
            title="Nothing promised"
            description="When a customer says when they will pay, record it on the invoice. Chasing stops until the day they named, and if the money does not arrive the next notice says what they told you and when."
          />
        ) : (
          WORK_BUCKETS.map((bucket) => {
            const rows = list.byBucket[bucket];
            if (rows.length === 0) return null;

            const totals = list.totals[bucket];

            return (
              <section key={bucket}>
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
                    {BUCKET_LABEL[bucket]}
                    <Badge tone={BUCKET_TONE[bucket]} size="sm">
                      {rows.length}
                    </Badge>
                  </h2>
                  {/*
                    * "Still short" only where something is actually late. A
                    * promise for next Thursday is not short of anything, and
                    * saying so under a heading that tells somebody to leave
                    * these alone is the sort of contradiction that makes a
                    * screen untrustworthy.
                    */}
                  <p className="text-xs text-ink-secondary tabular-nums">
                    {money(totals.promisedCents)} promised
                    {bucket === 'not_kept' &&
                      totals.outstandingCents > 0 &&
                      ` · ${money(totals.outstandingCents)} still short`}
                  </p>
                </div>

                <p className="mb-3 text-xs leading-relaxed text-ink-muted">
                  {BUCKET_NOTE[bucket]}
                </p>

                <ul className="space-y-2">
                  {rows.map((row) => {
                    const record = describeTally(row.record);

                    return (
                      <li key={row.promise.id}>
                        <Card className="p-4">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-medium text-ink">
                                  {row.customerName}
                                </span>
                                <Link
                                  href={`/invoices/${row.invoiceId}`}
                                  className="font-mono text-xs text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
                                >
                                  {row.invoiceNumber}
                                </Link>
                                {record && (
                                  <Badge
                                    tone={row.record.streak >= 3 ? 'ok' : 'neutral'}
                                    size="sm"
                                  >
                                    {record}
                                  </Badge>
                                )}
                              </p>

                              <p className="mt-1 text-xs text-ink-secondary">
                                {money(row.promise.amountCents)} by{' '}
                                {dateText(row.promise.promisedFor)}
                                {row.outcome.receivedCents > 0 &&
                                  ` · ${money(row.outcome.receivedCents)} arrived`}
                                {row.outcome.shortfallCents > 0 &&
                                  row.outcome.receivedCents > 0 &&
                                  ` · ${money(row.outcome.shortfallCents)} short`}
                              </p>

                              <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
                                {row.promise.contactName && (
                                  <>
                                    <Phone className="size-3" aria-hidden />
                                    {row.promise.contactName}
                                    {' · '}
                                  </>
                                )}
                                {CHANNEL_LABEL[row.promise.channel]} ·{' '}
                                {relativeTime(row.promise.madeAt)}
                              </p>

                              {row.promise.notes && (
                                <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
                                  {row.promise.notes}
                                </p>
                              )}
                            </div>

                            <div className="shrink-0 text-right">
                              <p className="text-sm font-semibold text-ink tabular-nums">
                                {money(row.promise.amountCents)}
                              </p>
                              {/*
                                * The invoice balance beside the promised figure,
                                * because they often differ — somebody who
                                * promised part of it, or paid something else
                                * against the same invoice since.
                                */}
                              {row.invoiceBalanceCents !== row.promise.amountCents && (
                                <p className="mt-0.5 text-xs text-ink-muted tabular-nums">
                                  {money(row.invoiceBalanceCents)} on the invoice
                                </p>
                              )}
                            </div>
                          </div>
                        </Card>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })
        )}
      </PageBody>
    </>
  );
}
