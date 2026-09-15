import { NextResponse } from 'next/server';
import { asOrgId, forOrg } from '@/lib/db/scope';
import { allOrganizations } from '@/lib/organization/profile';
import { checkSchedulerToken } from '@/lib/auth/shared-token';
import { runStatements } from '@/lib/invoices/statement-run';

/**
 * Sending statements from a scheduler.
 *
 * There is no daemon and no queue in this application, deliberately, so the
 * schedule is a rule rather than a timer and something outside has to poke
 * it. A cron line once a day is enough for any cadence: the app works out
 * which occurrence today belongs to, and an occurrence runs at most once.
 *
 *   0 6 * * * curl -fsS -X POST -H "authorization: Bearer $TOKEN" \
 *     https://your-host/api/statements/run
 *
 * Safe to call more often, and safe to call late. Firing every hour sends
 * nothing extra — the run for a given occurrence is claimed by whoever writes
 * its row first. A machine that was off for a fortnight sends one statement
 * when it comes back, not a fortnight of them: balances are always as at
 * today, so a missed occurrence has nothing left to say that the current one
 * does not.
 *
 * Authenticated by a shared token compared in constant time. Without
 * `STATEMENT_RUN_TOKEN` set the route stays off entirely — an
 * unauthenticated endpoint that sends mail to a carrier's customers is not
 * something to leave open by default.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const allowed = checkSchedulerToken(request, 'STATEMENT_RUN_TOKEN');
  if (!allowed.ok) {
    return allowed.error
      ? NextResponse.json({ error: allowed.error }, { status: allowed.status })
      : new NextResponse(null, { status: allowed.status });
  }

  /*
   * Every organisation on the instance, each through its own scoped client.
   * One poke covers all of them, and an organisation with no schedule set
   * simply reports that nothing was due.
   */
  const organisations = await allOrganizations();
  const results = [];

  for (const org of organisations) {
    const result = await runStatements(forOrg(asOrgId(org.id)), { trigger: 'schedule' });

    results.push({
      orgId: org.id,
      ran: result.ok,
      reason: result.reason ?? null,
      dueOn: result.dueOn?.toISOString().slice(0, 10) ?? null,
      sent: result.sent ?? 0,
      failed: result.failed ?? 0,
      skipped: result.skipped ?? 0,
    });
  }

  /*
   * 200 even when a customer's send failed. The request was handled; the
   * failures are recorded against the run and shown in settings. Returning
   * 5xx would make a cron line retry a sweep that has already happened, and
   * the retry would find the occurrence taken and do nothing — noise in a
   * monitoring system for a problem it cannot fix.
   */
  return NextResponse.json({
    ok: true,
    organisations: results.length,
    sent: results.reduce((sum, row) => sum + row.sent, 0),
    failed: results.reduce((sum, row) => sum + row.failed, 0),
    skipped: results.reduce((sum, row) => sum + row.skipped, 0),
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
