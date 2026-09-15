import { NextResponse } from 'next/server';
import { asOrgId, forOrg } from '@/lib/db/scope';
import { allOrganizations } from '@/lib/organization/profile';
import { checkSchedulerToken } from '@/lib/auth/shared-token';
import { runDunning } from '@/lib/invoices/dunning-run';

/**
 * Sweeping overdue invoices from a scheduler.
 *
 *   0 9 * * * curl -fsS -X POST -H "authorization: Bearer $TOKEN" \
 *     https://your-host/api/dunning/run
 *
 * Its own token rather than sharing the statement one, deliberately. Chasing
 * a debt and sending a summary are different acts with different
 * consequences, and a carrier who wants monthly statements but no automatic
 * chasing should be able to have exactly that — without reading the source to
 * find out whether one switch turns on both.
 *
 * Daily is the right cadence whatever the ladder says: the sweep decides what
 * is due, and at most one rung goes per invoice per sweep. Calling it more
 * often sends nothing extra — the occurrence is the date, and whoever writes
 * that row owns the sweep.
 *
 * Off entirely without `DUNNING_RUN_TOKEN`. An unauthenticated endpoint that
 * sends demands for money to a carrier's customers is not something to leave
 * open by default.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const allowed = checkSchedulerToken(request, 'DUNNING_RUN_TOKEN');
  if (!allowed.ok) {
    return allowed.error
      ? NextResponse.json({ error: allowed.error }, { status: allowed.status })
      : new NextResponse(null, { status: allowed.status });
  }

  const organisations = await allOrganizations();
  const results = [];

  for (const org of organisations) {
    const result = await runDunning(forOrg(asOrgId(org.id)), { trigger: 'schedule' });

    results.push({
      orgId: org.id,
      ran: result.ok,
      reason: result.reason ?? null,
      dueOn: result.dueOn?.toISOString().slice(0, 10) ?? null,
      sent: result.sent ?? 0,
      failed: result.failed ?? 0,
      held: result.held ?? 0,
    });
  }

  /*
   * 200 even when individual sends failed, for the same reason the statement
   * sweep does: the request was handled, and a retry would find the sweep
   * already done. Watch the summary in Settings, not the status code.
   */
  return NextResponse.json({
    ok: true,
    organisations: results.length,
    sent: results.reduce((sum, row) => sum + row.sent, 0),
    failed: results.reduce((sum, row) => sum + row.failed, 0),
    held: results.reduce((sum, row) => sum + row.held, 0),
    results,
  });
}

/** GET is rejected: this sends mail, so it should not be a link somebody can follow. */
export async function GET() {
  return NextResponse.json(
    { error: 'Use POST. This endpoint sends mail.' },
    { status: 405, headers: { allow: 'POST' } },
  );
}
