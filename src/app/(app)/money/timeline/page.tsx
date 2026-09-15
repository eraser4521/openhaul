import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowDownLeft, ArrowLeft, ArrowUpRight, CalendarRange, EyeOff } from 'lucide-react';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import { can } from '@/lib/auth/capabilities';
import { EmptyState, PageBody, PageHeader } from '@/components/app/page-header';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { money } from '@/lib/utils/format';
import { cashflowReport } from '@/lib/invoices/cashflow-report';
import {
  STANDING_LABEL,
  STANDING_NOTE,
  describeOffset,
  describeWait,
  describeWindow,
  netOf,
} from '@/lib/invoices/cashflow';

export const metadata = { title: 'Cash coming' };

function dayText(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function signed(cents: number): string {
  return cents > 0 ? `+${money(cents)}` : money(cents);
}

/**
 * What is coming and what is going, week by week.
 *
 * The money page says what is outstanding. It does not answer the question a
 * carrier actually loses sleep over, which is whether Friday works — and that
 * needs what is going *out* set against what is coming in, on a timeline
 * rather than as a total.
 *
 * The temptation with a screen like this is to make it a forecast. It is not
 * one. Every figure sits on a date that is already on a record, nothing is
 * averaged, nothing is projected, and money with no future date is kept off
 * the timeline entirely and listed underneath with the reason. What the page
 * cannot see is printed on it, because the distance between "this is
 * everything" and "this is everything I was told about" is exactly where a
 * screen like this stops being useful.
 */
export default async function TimelinePage() {
  const { session, db } = await requireSessionOrRedirect();
  if (!can(session.role, 'invoice.read')) redirect('/dashboard');

  const report = await cashflowReport(db);
  const { timeline } = report;
  const anythingDated = timeline.windows.some(
    (window) => window.movements.length > 0,
  );

  const horizonTotal = netOf(timeline.totals);

  return (
    <>
      <PageHeader
        title="Cash coming"
        description={
          /*
           * Three figures rather than two. Summing what was promised with
           * what merely falls due is the one thing this page refuses to do
           * everywhere else, and a header that did it would give the lie to
           * every column underneath.
           */
          anythingDated
            ? `Over the next ${report.horizonWeeks} weeks, ${money(timeline.totals.promisedCents)} is promised, ${money(timeline.totals.dueCents)} falls due, and ${money(timeline.totals.outCents)} goes out.`
            : 'Nothing on file carries a future date, so there is nothing to lay out yet.'
        }
        actions={
          <Link href="/money" className={cn(buttonVariants({ variant: 'secondary' }))}>
            <ArrowLeft aria-hidden />
            Money
          </Link>
        }
      />

      <PageBody className="space-y-6">
        {/* --- The weeks ------------------------------------------------- */}

        {!anythingDated && (
          <EmptyState
            icon={CalendarRange}
            title="Nothing is dated yet"
            description="Four empty weeks would say nothing four times over. Issue an invoice with payment terms, record what a customer said on the telephone, or draw a settlement, and it appears here on the day it is expected — never on a day this page has guessed."
          />
        )}

        <section className="space-y-3">
          {anythingDated &&
            timeline.windows.map((window) => {
            const net = netOf(window);
            const quiet = window.movements.length === 0;

            return (
              <Card key={window.index} className={cn('p-5', quiet && 'opacity-70')}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-sm font-semibold text-ink">
                    {describeWindow(window)}
                    <span className="ml-2 text-xs font-normal text-ink-muted">
                      {describeOffset(window.index)}
                    </span>
                  </h2>

                  {!quiet && (
                    <p className="text-xs text-ink-secondary tabular-nums">
                      <span className={net.ifAllLands < 0 ? 'text-danger' : 'text-ok'}>
                        {signed(net.ifAllLands)}
                      </span>{' '}
                      if everything lands
                      {window.promisedCents > 0 && window.dueCents > 0 && (
                        <>
                          {' · '}
                          <span className={net.ifOnlyPromised < 0 ? 'text-warn' : 'text-ink'}>
                            {signed(net.ifOnlyPromised)}
                          </span>{' '}
                          on promises alone
                        </>
                      )}
                    </p>
                  )}
                </div>

                {quiet ? (
                  <p className="mt-2 text-xs text-ink-muted">Nothing is dated for this week.</p>
                ) : (
                  <>
                    <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
                      <div>
                        <dt className="text-xs text-ink-muted">Promised</dt>
                        <dd className="mt-0.5 font-medium text-ink tabular-nums">
                          {money(window.promisedCents)}
                        </dd>
                      </div>
                      <div>
                        {/*
                          * Kept apart from the promised figure everywhere it
                          * appears. A due date is a payment term and a promise
                          * is a person's word, and a column that added them
                          * would be the most misleading thing on this page.
                          */}
                        <dt className="text-xs text-ink-muted">Falls due</dt>
                        <dd className="mt-0.5 font-medium text-ink tabular-nums">
                          {money(window.dueCents)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-ink-muted">Going out</dt>
                        <dd className="mt-0.5 font-medium text-ink tabular-nums">
                          {money(window.outCents)}
                        </dd>
                      </div>
                    </dl>

                    <details open={window.index === 0} className="mt-4">
                      <summary className="cursor-pointer text-xs text-ink-muted hover:text-ink-secondary">
                        {window.movements.length === 1
                          ? '1 dated item'
                          : `${window.movements.length} dated items`}
                      </summary>

                      <ul className="mt-2 divide-y divide-line border-t border-line">
                        {window.movements.map((movement) => (
                          <li
                            key={movement.key}
                            className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2"
                          >
                            <span className="flex min-w-0 items-center gap-2 text-sm text-ink">
                              {movement.kind === 'settlement' ? (
                                <ArrowUpRight className="size-3.5 shrink-0 text-warn" aria-hidden />
                              ) : (
                                <ArrowDownLeft className="size-3.5 shrink-0 text-ok" aria-hidden />
                              )}
                              <span className="truncate">{movement.counterparty}</span>
                              <span className="shrink-0 text-xs text-ink-muted">
                                {movement.reference}
                              </span>
                            </span>

                            <span className="text-xs text-ink-secondary tabular-nums">
                              {dayText(movement.on)} · {money(movement.amountCents)}{' '}
                              <span className="text-ink-muted">· {movement.because}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  </>
                )}
              </Card>
            );
          })}
        </section>

        {(timeline.later.promisedCents > 0 ||
          timeline.later.dueCents > 0 ||
          timeline.later.outCents > 0) && (
          <p className="text-xs text-ink-muted">
            Beyond {report.horizonWeeks} weeks: {money(timeline.later.promisedCents)} promised,{' '}
            {money(timeline.later.dueCents)} falling due, {money(timeline.later.outCents)} going
            out. Counted here so nothing is dropped, not laid out, because a date that far ahead
            moves.
          </p>
        )}

        {anythingDated && (
          /*
           * Not the four-week version of "on promises alone". Over a month
           * that reading implies a deficit nobody is facing — no carrier
           * expects a month's income to arrive entirely as promises — so what
           * the second figure is actually for is said outright instead.
           */
          <p className="text-xs text-ink-muted">
            Across the whole {report.horizonWeeks} weeks that is {signed(horizonTotal.ifAllLands)}{' '}
            if everything lands.{' '}
            {timeline.totals.promisedCents > 0
              ? `Only ${money(timeline.totals.promisedCents)} of what arrives is money somebody has actually committed to.`
              : 'None of what arrives is money anybody has committed to.'}
          </p>
        )}

        {/* --- Money with no date --------------------------------------- */}

        {report.standing.length > 0 && (
          <section>
            <h2 className="mb-1 text-sm font-semibold text-ink">Not on the timeline</h2>
            <p className="mb-3 text-xs leading-relaxed text-ink-muted">
              Real money, with nothing on file saying which day it moves. Putting it in a week
              would mean inventing a date, so it sits here with the reason instead.
            </p>

            <ul className="space-y-2">
              {report.standing.map((group) => (
                <li key={group.reason}>
                  <Card className="p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="flex items-center gap-2 text-sm font-medium text-ink">
                        <Badge tone={group.direction === 'in' ? 'info' : 'warn'} size="sm">
                          {group.direction === 'in' ? 'In' : 'Out'}
                        </Badge>
                        {STANDING_LABEL[group.reason]}
                      </h3>
                      <p className="text-sm text-ink tabular-nums">{money(group.amountCents)}</p>
                    </div>

                    <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                      {STANDING_NOTE[group.reason]}
                    </p>

                    <ul className="mt-3 divide-y divide-line border-t border-line">
                      {group.rows.map((row) => {
                        const waited = describeWait(row.daysWaiting);

                        return (
                          <li
                            key={row.key}
                            className="flex flex-wrap items-baseline justify-between gap-x-3 py-2"
                          >
                            <span className="flex min-w-0 items-center gap-2 text-sm text-ink">
                              <span className="truncate">{row.counterparty}</span>
                              <span className="shrink-0 text-xs text-ink-muted">
                                {row.reference}
                              </span>
                            </span>
                            <span className="text-xs text-ink-secondary tabular-nums">
                              {money(row.amountCents)}
                              {waited && ` · waiting ${waited}`}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </Card>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* --- The gaps, stated ----------------------------------------- */}

        <section>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink">
            <EyeOff className="size-4 text-ink-muted" aria-hidden />
            What this cannot see
          </h2>
          <p className="mb-3 text-xs leading-relaxed text-ink-muted">
            Written down rather than left to be found out. A page like this gets believed about
            things it knows nothing about, and that is worse than not having one.
          </p>

          <Card>
            <dl className="divide-y divide-line">
              {report.unknowns.map((row) => (
                <div key={row.what} className="px-5 py-3">
                  <dt className="text-sm font-medium text-ink">{row.what}</dt>
                  <dd className="mt-0.5 text-xs leading-relaxed text-ink-secondary">{row.why}</dd>
                </div>
              ))}
            </dl>
          </Card>
        </section>
      </PageBody>
    </>
  );
}
