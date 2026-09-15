import { NextResponse } from 'next/server';
import { asOrgId, forOrg } from '@/lib/db/scope';
import { allOrganizations } from '@/lib/organization/profile';
import { checkSchedulerToken } from '@/lib/auth/shared-token';
import { runCashAlerts } from '@/lib/cash/alert-run';

/**
 * Checking whether anybody needs telling, from a scheduler.
 *
 *   0 7 * * * curl -fsS -X POST -H "authorization: Bearer $TOKEN" \
 *     https://your-host/api/cash/alerts
 *
 * Its own token, like the dunning sweep and the statement run. Chasing a
 * customer, sending a summary and warning a carrier about their own solvency
 * are three different acts, and somebody should be able to have the third
 * without the first two rather than reading the source to find out which
 * switch turns on what.
 *
 * Early is the right time of day. The whole point is to reach somebody before
 * they commit to a load or a fuel stop, not to summarise a day they have
 * already spent.
 *
 * Unlike the statement run there is no occurrence to be idempotent about, and
 * none is needed: the decision itself declines to repeat news that has not
 * changed, so calling this hourly sends no more than calling it daily. That
 * makes a retry after a timeout free rather than something to guard against.
 *
 * Off entirely without `CASH_ALERT_TOKEN`.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const allowed = checkSchedulerToken(request, 'CASH_ALERT_TOKEN');
  if (!allowed.ok) {
    return allowed.error
      ? NextResponse.json({ error: allowed.error }, { status: allowed.status })
      : new NextResponse(null, { status: allowed.status });
  }

  const organisations = await allOrganizations();
  const results = [];

  for (const org of organisations) {
    const run = await runCashAlerts(forOrg(asOrgId(org.id)));

    results.push({
      orgId: org.id,
      sent: run.sent,
      kind: run.decision.send ? run.decision.kind : null,
      reason: run.decision.send ? run.decision.reason : null,
      silent: run.decision.send ? null : run.decision.why,
      error: run.error ?? null,
    });
  }

  /*
   * 200 even where a send failed, for the same reason the other sweeps do: the
   * request was handled, and a scheduler retrying on a 500 would only arrive
   * at the same mail server. The failure is recorded against the organisation
   * and shown in Settings, which is where somebody can act on it.
   */
  return NextResponse.json({
    ok: true,
    organisations: results.length,
    sent: results.filter((row) => row.sent).length,
    failed: results.filter((row) => row.error).length,
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
