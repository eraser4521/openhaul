import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import {
  AlertTriangle,
  CalendarClock,
  Check,
  FileText,
  Lock,
  ShieldAlert,
  Truck,
} from 'lucide-react';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import {
  claims as claimsTable,
  documents as documentsTable,
  loads as loadsTable,
} from '@/lib/db/schema';
import { PageBody, PageHeader } from '@/components/app/page-header';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { money, relativeTime, vinDisplay } from '@/lib/utils/format';
import { can } from '@/lib/auth/capabilities';
import { claimDeadlines, isLateFiled, type Deadline } from '@/lib/claims/deadlines';
import { claimEvidence, claimCustomerName, isDisposed } from '@/lib/claims/lifecycle';
import { CLAIM_STATUS_TONE, claimStatusLabel, DEADLINE_TONE } from '@/lib/claims/display';
import { ClaimActions } from '@/components/app/claim-actions';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { db } = await requireSessionOrRedirect();
    const claim = await db.selectOne('claims', eq(claimsTable.id, id));
    return { title: claim?.number ?? 'Claim' };
  } catch {
    return { title: 'Claim' };
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

function DeadlineRow({ deadline }: { deadline: Deadline }) {
  const tone = DEADLINE_TONE[deadline.state];

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
          {deadline.label}
          <span className="font-mono text-[0.6875rem] text-ink-muted">{deadline.citation}</span>
        </p>
        <p className="mt-0.5 text-xs text-ink-muted">
          {deadline.metAt
            ? `Done ${dateText(deadline.metAt)}`
            : deadline.dueAt
              ? `Due ${dateText(deadline.dueAt)}`
              : 'No date'}
        </p>
      </div>

      <Badge tone={tone} size="sm">
        {deadline.state === 'met'
          ? 'Met'
          : deadline.state === 'overdue'
            ? `${Math.abs(deadline.daysRemaining ?? 0)} days late`
            : deadline.state === 'due_soon'
              ? `${deadline.daysRemaining} days left`
              : deadline.state === 'pending'
                ? `${deadline.daysRemaining} days`
                : '—'}
      </Badge>
    </li>
  );
}

export default async function ClaimDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { session, db } = await requireSessionOrRedirect();

  const claim = await db.selectOne('claims', eq(claimsTable.id, id));
  if (!claim) notFound();

  const [load, customerName, evidence, letters] = await Promise.all([
    claim.loadId ? db.selectOne('loads', eq(loadsTable.id, claim.loadId)) : Promise.resolve(null),
    claimCustomerName(db, claim.customerId),
    claimEvidence(db, id),
    db.select('documents', eq(documentsTable.subject, `claim:${id}`)),
  ]);

  const now = new Date();
  const closed = isDisposed(claim.status);

  const lastStatusLetter = letters
    .filter((letter) => letter.kind === 'claim_status')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

  const disposedAt = claim.settledAt ?? claim.declinedAt ?? null;

  const deadlines = claimDeadlines(
    {
      filedAt: claim.filedAt,
      acknowledgedAt: claim.acknowledgedAt,
      acknowledgeDueAt: claim.acknowledgeDueAt,
      resolveDueAt: claim.resolveDueAt,
      lastStatusLetterAt: lastStatusLetter?.createdAt ?? null,
      disposedAt,
      declinedAt: claim.declinedAt,
    },
    now,
  );

  const lateFiled = isLateFiled(claim.filedAt, load?.deliveredAt ?? null);
  const assembled = 'error' in evidence ? null : evidence;

  return (
    <>
      <PageHeader
        title={claim.number}
        description={`${claim.claimantName}${customerName && customerName !== claim.claimantName ? ` · ${customerName}` : ''}`}
        actions={
          load && (
            <Link
              href={`/loads/${load.id}`}
              className={cn(buttonVariants({ variant: 'secondary' }))}
            >
              <Truck aria-hidden />
              {load.number}
            </Link>
          )
        }
      />

      <PageBody className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={CLAIM_STATUS_TONE[claim.status]}>{claimStatusLabel(claim.status)}</Badge>
          {claim.demandAmountCents !== null && (
            <Badge tone="neutral">{money(claim.demandAmountCents)} claimed</Badge>
          )}
          {load?.legalHold && (
            <Badge tone="info">
              <Lock aria-hidden />
              Records on legal hold
            </Badge>
          )}
          {lateFiled && (
            <Badge tone="warn">
              <AlertTriangle aria-hidden />
              Filed outside the nine-month window
            </Badge>
          )}
        </div>

        {lateFiled && load?.deliveredAt && (
          <Card className="p-5">
            <p className="text-sm leading-relaxed text-ink-secondary">
              This load was delivered on <strong className="text-ink">{dateText(load.deliveredAt)}</strong>{' '}
              and the claim was received on{' '}
              <strong className="text-ink">{dateText(claim.filedAt)}</strong>, outside the nine
              months the bill of lading allows. That is a defence, not a reason to ignore the claim:
              the acknowledgement still goes out on time and reserves it expressly.
            </p>
          </Card>
        )}

        {/* --- Deadlines ------------------------------------------------- */}
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
            <CalendarClock className="size-4 text-ink-muted" aria-hidden />
            Deadlines
          </h2>
          <Card>
            <ul className="divide-y divide-line">
              {deadlines.map((deadline) => (
                <DeadlineRow key={deadline.label} deadline={deadline} />
              ))}
            </ul>
            <p className="border-t border-line px-5 py-3 text-xs leading-relaxed text-ink-muted">
              Counted from {dateText(claim.filedAt)}, the date the written claim was received — not
              the date it was entered here.
            </p>
          </Card>
        </section>

        {/* --- What is claimed ------------------------------------------- */}
        <section>
          <h2 className="mb-3 text-sm font-semibold text-ink">The claim</h2>
          <Card className="p-5">
            <dl className="grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-xs font-medium tracking-wide text-ink-muted uppercase">
                  Claimant
                </dt>
                <dd className="mt-1 text-sm text-ink">{claim.claimantName}</dd>
                {claim.claimantEmail && (
                  <dd className="mt-0.5 text-xs text-ink-muted">{claim.claimantEmail}</dd>
                )}
              </div>
              <div>
                <dt className="text-xs font-medium tracking-wide text-ink-muted uppercase">
                  Amount claimed
                </dt>
                <dd className="mt-1 text-sm text-ink tabular-nums">
                  {claim.demandAmountCents !== null
                    ? money(claim.demandAmountCents)
                    : 'Determinable, not stated'}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium tracking-wide text-ink-muted uppercase">
                  Vehicle
                </dt>
                <dd className="mt-1 font-mono text-sm break-all text-ink">
                  {assembled?.vehicle ? vinDisplay(assembled.vehicle.vin) : 'Not specified'}
                </dd>
                {assembled?.vehicle && (
                  <dd className="mt-0.5 text-xs text-ink-muted">{assembled.vehicle.description}</dd>
                )}
              </div>
            </dl>

            <p className="mt-5 border-t border-line pt-4 text-sm leading-relaxed whitespace-pre-wrap text-ink-secondary">
              {claim.description}
            </p>

            {(claim.offeredAt || claim.settledAt || claim.declinedAt) && (
              <div className="mt-4 space-y-1.5 border-t border-line pt-4 text-sm">
                {claim.offeredAt && (
                  <p className="text-ink-secondary">
                    Offered {money(claim.offerAmountCents)} on {dateText(claim.offeredAt)}.
                  </p>
                )}
                {claim.settledAt && (
                  <p className="text-ok">
                    Paid {money(claim.settledAmountCents)} on {dateText(claim.settledAt)}.
                  </p>
                )}
                {claim.declinedAt && (
                  <>
                    <p className="text-ink">Declined on {dateText(claim.declinedAt)}.</p>
                    <p className="text-ink-secondary">{claim.declineReason}</p>
                  </>
                )}
                {claim.status === 'withdrawn' && (
                  <p className="text-ink-secondary">Withdrawn. {claim.declineReason}</p>
                )}
              </div>
            )}
          </Card>
        </section>

        {/* --- The evidence ---------------------------------------------- */}
        {assembled && (
          <section>
            <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink">
              <ShieldAlert className="size-4 text-ink-muted" aria-hidden />
              The record
            </h2>
            <p className="mb-3 text-xs leading-relaxed text-ink-secondary">
              Under Carmack a shipper makes its case by showing the vehicle was sound at origin,
              damaged at destination, and what that costs. This is what the inspection record says
              about the first two.
            </p>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card className="p-5">
                <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
                  At pickup
                </p>
                <p className="mt-2 text-2xl font-semibold text-ink tabular-nums">
                  {assembled.originPhotos.length}
                </p>
                <p className="text-xs text-ink-secondary">
                  photograph{assembled.originPhotos.length === 1 ? '' : 's'} ·{' '}
                  {assembled.assessment.preExistingAtOrigin.length} pre-existing damage
                  {assembled.assessment.preExistingAtOrigin.length === 1 ? '' : 's'} noted
                </p>
                {assembled.originInspectionId && (
                  <Link
                    href={`/inspections`}
                    className="mt-3 inline-block text-xs text-brand hover:underline"
                  >
                    Open the pickup inspection
                  </Link>
                )}
              </Card>

              <Card className="p-5">
                <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
                  At delivery
                </p>
                <p className="mt-2 text-2xl font-semibold text-ink tabular-nums">
                  {assembled.destinationPhotos.length}
                </p>
                <p className="text-xs text-ink-secondary">
                  photograph{assembled.destinationPhotos.length === 1 ? '' : 's'} ·{' '}
                  {assembled.assessment.newAtDestination.length} new damage
                  {assembled.assessment.newAtDestination.length === 1 ? '' : 's'}
                </p>
              </Card>
            </div>

            {assembled.assessment.newAtDestination.length > 0 && (
              <Card className="mt-4">
                <div className="border-b border-line px-5 py-3">
                  <h3 className="text-sm font-medium text-ink">
                    Recorded at delivery, not at pickup
                  </h3>
                  <p className="mt-0.5 text-xs text-ink-secondary">
                    Matched on AIAG code, which fixes the area, type and severity — so the same dent
                    at both ends is not counted here, and a dent on a different panel is.
                  </p>
                </div>
                <ul className="divide-y divide-line">
                  {assembled.assessment.newAtDestination.map((damage) => (
                    <li key={damage.code} className="flex items-start gap-3 px-5 py-3">
                      <span className="font-mono text-xs text-warn">{damage.code}</span>
                      <span className="text-sm text-ink-secondary">
                        {damage.description ?? 'No description recorded'}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {assembled.assessment.documentedAtBoth.length > 0 && (
              <Card className="mt-4">
                <div className="border-b border-line px-5 py-3">
                  <h3 className="text-sm font-medium text-ink">Already there at pickup</h3>
                  <p className="mt-0.5 text-xs text-ink-secondary">
                    Recorded at both ends, which is the carrier&rsquo;s answer to a claim on it.
                  </p>
                </div>
                <ul className="divide-y divide-line">
                  {assembled.assessment.documentedAtBoth.map((damage) => (
                    <li key={damage.code} className="flex items-start gap-3 px-5 py-3">
                      <span className="font-mono text-xs text-ok">{damage.code}</span>
                      <span className="text-sm text-ink-secondary">
                        {damage.description ?? 'No description recorded'}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {assembled.assessment.gaps.length > 0 && (
              <Card className="mt-4 p-5">
                <h3 className="flex items-center gap-2 text-sm font-medium text-warn">
                  <AlertTriangle className="size-4 shrink-0" aria-hidden />
                  Gaps in the file
                </h3>
                <ul className="mt-2 space-y-1.5">
                  {assembled.assessment.gaps.map((gap) => (
                    <li key={gap} className="text-xs leading-relaxed text-ink-secondary">
                      · {gap}
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {assembled.assessment.gaps.length === 0 &&
              assembled.assessment.newAtDestination.length === 0 && (
                <Card className="mt-4 p-5">
                  <p className="flex items-start gap-2 text-sm leading-relaxed text-ink-secondary">
                    <Check className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
                    Both inspections are sealed and photographed, and nothing was recorded at
                    delivery that was not already recorded at pickup.
                  </p>
                </Card>
              )}

            {assembled.documents.length > 0 && (
              <Card className="mt-4">
                <div className="border-b border-line px-5 py-3">
                  <h3 className="text-sm font-medium text-ink">Documents on the shipment</h3>
                </div>
                <ul className="divide-y divide-line">
                  {assembled.documents.map((document) => (
                    <li
                      key={document.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                    >
                      <div className="min-w-0">
                        <p className="text-sm text-ink">{document.title}</p>
                        <p className="mt-0.5 font-mono text-[0.6875rem] text-ink-muted">
                          sha256 {document.sha256.slice(0, 24)}…
                        </p>
                      </div>
                      <a
                        href={`/api/documents/${document.id}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex h-8 items-center rounded-lg border border-line px-2.5 text-xs text-ink-secondary transition-colors hover:border-line-strong hover:text-ink"
                      >
                        View
                      </a>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </section>
        )}

        {/* --- Correspondence -------------------------------------------- */}
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
            <FileText className="size-4 text-ink-muted" aria-hidden />
            Letters sent
          </h2>
          {letters.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs leading-relaxed text-ink-muted">
              Nothing written yet. The acknowledgement is due by{' '}
              {dateText(claim.acknowledgeDueAt)}.
            </p>
          ) : (
            <ul className="space-y-2">
              {letters
                .slice()
                .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
                .map((letter) => (
                  <li
                    key={letter.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-raised p-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm text-ink">{letter.title}</p>
                      <p className="mt-0.5 text-xs text-ink-muted">
                        Written {relativeTime(letter.createdAt)} · sha256{' '}
                        <span className="font-mono">{letter.sha256.slice(0, 16)}…</span>
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      <a
                        href={`/api/documents/${letter.id}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex h-8 items-center rounded-lg border border-line px-2.5 text-xs text-ink-secondary transition-colors hover:border-line-strong hover:text-ink"
                      >
                        View
                      </a>
                      <a
                        href={`/api/documents/${letter.id}?download=1`}
                        className="inline-flex h-8 items-center rounded-lg border border-line px-2.5 text-xs text-ink-secondary transition-colors hover:border-line-strong hover:text-ink"
                      >
                        PDF
                      </a>
                    </div>
                  </li>
                ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-ink-muted">
            OpenHaul writes these; it does not send them. Sending, and keeping proof of sending, is
            still yours to do.
          </p>
        </section>

        {/* --- Actions ---------------------------------------------------- */}
        <section className="border-t border-line pt-5">
          <ClaimActions
            claimId={claim.id}
            status={claim.status}
            acknowledged={claim.acknowledgedAt !== null}
            closed={closed}
            demandAmountCents={claim.demandAmountCents}
            legalHold={load?.legalHold ?? false}
            canWrite={can(session.role, 'claim.write')}
          />
        </section>
      </PageBody>
    </>
  );
}
