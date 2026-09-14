import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { ShieldAlert } from 'lucide-react';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import { documents as documentsTable } from '@/lib/db/schema';
import { EmptyState, PageBody, PageHeader } from '@/components/app/page-header';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { money, relativeTime } from '@/lib/utils/format';
import { claimDeadlines, worstState, type DeadlineState } from '@/lib/claims/deadlines';
import { isDisposed } from '@/lib/claims/lifecycle';
import {
  CLAIM_STATUS_TONE,
  claimStatusLabel,
  DEADLINE_SUMMARY,
  DEADLINE_TONE,
} from '@/lib/claims/display';

export const metadata = { title: 'Claims' };

/** Most urgent first. A missed statutory deadline outranks everything. */
const URGENCY: Record<DeadlineState, number> = {
  overdue: 0,
  due_soon: 1,
  pending: 2,
  not_applicable: 3,
  met: 4,
};

export default async function ClaimsPage() {
  const { db } = await requireSessionOrRedirect();
  const claims = await db.select('claims');

  const now = new Date();

  const rows = await Promise.all(
    claims.map(async (claim) => {
      const letters = await db.select(
        'documents',
        eq(documentsTable.subject, `claim:${claim.id}`),
      );

      const lastStatusLetter = letters
        .filter((letter) => letter.kind === 'claim_status')
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

      const deadlines = claimDeadlines(
        {
          filedAt: claim.filedAt,
          acknowledgedAt: claim.acknowledgedAt,
          acknowledgeDueAt: claim.acknowledgeDueAt,
          resolveDueAt: claim.resolveDueAt,
          lastStatusLetterAt: lastStatusLetter?.createdAt ?? null,
          disposedAt: claim.settledAt ?? claim.declinedAt ?? null,
          declinedAt: claim.declinedAt,
        },
        now,
      );

      // A closed claim has no live obligation, so it should not sit at the top
      // of the list wearing a red badge for a deadline nobody owes any more.
      const state: DeadlineState = isDisposed(claim.status)
        ? 'not_applicable'
        : worstState(deadlines.filter((deadline) => deadline.state !== 'met'));

      return { claim, state };
    }),
  );

  rows.sort((a, b) => {
    const urgency = URGENCY[a.state] - URGENCY[b.state];
    if (urgency !== 0) return urgency;
    return b.claim.filedAt.getTime() - a.claim.filedAt.getTime();
  });

  const open = rows.filter((row) => !isDisposed(row.claim.status));
  const overdue = rows.filter((row) => row.state === 'overdue').length;
  const exposure = open.reduce((sum, row) => sum + (row.claim.demandAmountCents ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Claims"
        description={
          claims.length > 0
            ? `${open.length} open · ${money(exposure)} claimed${overdue > 0 ? ` · ${overdue} past a statutory deadline` : ''}`
            : 'Cargo claims, with the deadlines the regulation sets as real dates.'
        }
      />

      <PageBody>
        {claims.length === 0 ? (
          <EmptyState
            icon={ShieldAlert}
            title="No claims"
            description="File a claim from the load it concerns. The acknowledgement is due within 30 days of receiving it and a decision within 120, so both clocks start the moment it is recorded."
          />
        ) : (
          <ul className="space-y-2">
            {rows.map(({ claim, state }) => (
              <li key={claim.id}>
                <Link href={`/claims/${claim.id}`} className="block">
                  <Card interactive className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-medium text-ink">
                          {claim.number}
                        </span>
                        <Badge tone={CLAIM_STATUS_TONE[claim.status]} size="sm">
                          {claimStatusLabel(claim.status)}
                        </Badge>
                        {state !== 'not_applicable' && (
                          <Badge tone={DEADLINE_TONE[state]} size="sm">
                            {DEADLINE_SUMMARY[state]}
                          </Badge>
                        )}
                      </p>
                      <p className="mt-1 text-xs text-ink-secondary">
                        {claim.claimantName} · received {relativeTime(claim.filedAt)}
                      </p>
                    </div>

                    <p className="text-sm font-semibold text-ink tabular-nums">
                      {claim.demandAmountCents !== null ? money(claim.demandAmountCents) : '—'}
                    </p>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PageBody>
    </>
  );
}
