import { NextResponse } from 'next/server';
import { asOrgId, forOrg } from '@/lib/db/scope';
import { checkBounces } from '@/lib/documents/bounces';
import { allOrganizations } from '@/lib/organization/profile';
import { checkSchedulerToken } from '@/lib/auth/shared-token';

/**
 * Checking the bounce mailbox from a scheduler.
 *
 * There is no daemon and no queue in this application, deliberately: a
 * one-person carrier should be able to run it with `npm start` and nothing
 * else. Bounce checking therefore needs a way in from outside a browser
 * session, so a cron line or a systemd timer can do it every quarter of an
 * hour without anybody logging in.
 *
 *   *\/15 * * * * curl -fsS -H "authorization: Bearer $TOKEN" \
 *     https://your-host/api/bounces/check
 *
 * Authenticated by a shared token rather than a session, compared in constant
 * time. Without `BOUNCE_CHECK_TOKEN` set the route stays off entirely — an
 * unauthenticated endpoint that reads a mailbox and writes to the database is
 * not something to leave open by default.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const allowed = checkSchedulerToken(request, 'BOUNCE_CHECK_TOKEN');
  if (!allowed.ok) {
    return allowed.error
      ? NextResponse.json({ error: allowed.error }, { status: allowed.status })
      : new NextResponse(null, { status: allowed.status });
  }

  /*
   * Runs for every organisation on the instance. The mailbox is configured
   * per deployment rather than per tenant, so one poll covers all of them and
   * each one's sends are matched through its own scoped client.
   */
  const organisations = await allOrganizations();
  const results: Array<{ orgId: string; matched: number; permanent: number }> = [];

  for (const org of organisations) {
    const result = await checkBounces(forOrg(asOrgId(org.id)));
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }
    results.push({ orgId: org.id, matched: result.matched, permanent: result.permanent });
  }

  return NextResponse.json({
    ok: true,
    organisations: results.length,
    matched: results.reduce((sum, row) => sum + row.matched, 0),
    permanent: results.reduce((sum, row) => sum + row.permanent, 0),
  });
}

/** GET is rejected: this changes data, so it should not be a link somebody can follow. */
export async function GET() {
  return NextResponse.json(
    { error: 'Use POST. This endpoint changes data.' },
    { status: 405, headers: { allow: 'POST' } },
  );
}
