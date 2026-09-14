import Link from 'next/link';
import { ClipboardCheck } from 'lucide-react';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import { EmptyState, PageBody, PageHeader } from '@/components/app/page-header';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils/cn';
import { relativeTime } from '@/lib/utils/format';
import { PHOTO_REQUIREMENTS } from '@/lib/aiag/codes';

export const metadata = { title: 'Inspections' };

export default async function InspectionsPage() {
  const { db } = await requireSessionOrRedirect();
  const inspections = await db.select('inspections');

  const sorted = [...inspections].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return (
    <>
      <PageHeader
        title="Inspections"
        description="Condition reports at pickup and delivery. These are what answer a cargo claim."
      />

      <PageBody className="space-y-6">
        {sorted.length === 0 ? (
          <>
            <EmptyState
              icon={ClipboardCheck}
              title="No inspections yet"
              description="An inspection starts from a load. Open one and walk the guided photo set — it works with no signal and uploads when you are back in coverage."
              action={
                <Link href="/loads" className={cn(buttonVariants())}>
                  Go to loads
                </Link>
              }
            />

            <Card className="p-5">
              <h2 className="text-sm font-semibold text-ink">What each tier requires</h2>
              <div className="mt-4 space-y-3">
                {(
                  [
                    ['Standard', 'standard', 'Photos optional. Fastest, and the weakest evidence.'],
                    [
                      'Advanced',
                      'advanced',
                      'The tier most brokers require for payment-guaranteed loads.',
                    ],
                    [
                      'AIAG',
                      'aiag',
                      'OEM standard. Every defect carries a five-digit area, type and severity code.',
                    ],
                  ] as const
                ).map(([label, key, note]) => {
                  const rules = PHOTO_REQUIREMENTS[key];
                  return (
                    <div key={key} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="w-20 shrink-0 text-sm font-medium text-ink">{label}</span>
                      <span className="flex flex-wrap gap-1.5">
                        <Badge tone={rules.perStage > 0 ? 'brand' : 'neutral'} size="sm">
                          {rules.perStage > 0 ? `${rules.perStage} photos per leg` : 'Photos optional'}
                        </Badge>
                        {rules.perDamage > 0 && (
                          <Badge tone="neutral" size="sm">
                            {rules.perDamage} per damage
                          </Badge>
                        )}
                        {rules.requiresSignature && (
                          <Badge tone="neutral" size="sm">
                            Signature required
                          </Badge>
                        )}
                      </span>
                      <span className="w-full text-xs text-ink-secondary sm:w-auto sm:flex-1">
                        {note}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Card>
          </>
        ) : (
          <ul className="space-y-2">
            {sorted.map((inspection) => (
              <li key={inspection.id}>
                <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2">
                      <span className="text-sm font-medium text-ink capitalize">
                        {inspection.stage}
                      </span>
                      <Badge
                        tone={
                          inspection.status === 'finalized'
                            ? 'ok'
                            : inspection.status === 'signed'
                              ? 'brand'
                              : 'neutral'
                        }
                        size="sm"
                      >
                        {inspection.status.replace(/_/g, ' ')}
                      </Badge>
                    </p>
                    <p className="mt-1 text-xs text-ink-secondary">
                      {relativeTime(inspection.createdAt)}
                      {inspection.createdOffline ? ' · captured offline' : ''}
                    </p>
                  </div>
                  <Link
                    href={`/loads/${inspection.loadId}`}
                    className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}
                  >
                    Open load
                  </Link>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </PageBody>
    </>
  );
}
