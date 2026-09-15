import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import { can } from '@/lib/auth/capabilities';
import { PageBody, PageHeader } from '@/components/app/page-header';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { money } from '@/lib/utils/format';
import { StandingCosts } from '@/components/app/standing-costs';
import { outgoingsFor } from '@/lib/cash/treasury';
import { annualCents, hasEnded } from '@/lib/cash/recurring';

export const metadata = { title: 'Standing costs' };

/**
 * What a carrier is committed to before anybody has hauled anything.
 *
 * Its own screen rather than a section of the timeline, because entering these
 * is a sitting-down job done once and the timeline is read standing up. Putting
 * a form somebody uses twice a year on a page somebody reads twice a day would
 * push the figures that matter below the fold.
 */
export default async function OutgoingsPage() {
  const { session, db } = await requireSessionOrRedirect();
  if (!can(session.role, 'cash.read')) redirect('/money');

  const now = new Date();
  const costs = await outgoingsFor(db);
  const live = costs.filter((cost) => !hasEnded(cost, now));
  const yearly = live.reduce((total, cost) => total + annualCents(cost), 0);

  return (
    <>
      <PageHeader
        title="Standing costs"
        description={
          live.length > 0
            ? `${live.length === 1 ? 'One commitment' : `${live.length} commitments`}, about ${money(yearly)} a year.`
            : 'What leaves every month whether or not a wheel turns.'
        }
        actions={
          <Link
            href="/money/timeline"
            className={cn(buttonVariants({ variant: 'secondary' }))}
          >
            <ArrowLeft aria-hidden />
            Cash coming
          </Link>
        }
      />

      <PageBody className="space-y-6">
        <StandingCosts costs={costs} canEdit={can(session.role, 'cash.write')} now={now} />

        <p className="max-w-prose text-xs leading-relaxed text-ink-muted">
          Every payment is worked out from the first one and the cadence rather than being written
          down in advance, so changing an amount changes every future date at once and leaves no
          stale copies behind. A commitment anchored on the 31st comes out on the 28th in February
          and returns to the 31st in March, which is what a lender&rsquo;s bank does. Annual figures
          say &ldquo;about&rdquo; because a year holds a little over 52 weeks.
        </p>
      </PageBody>
    </>
  );
}
