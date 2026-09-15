import { NextResponse } from 'next/server';
import { databaseReachable } from '@/lib/db/probe';

/**
 * Readiness, as distinct from reachability.
 *
 * `/api/health` answers a different question and has to stay cheap: the
 * offline outbox calls it to tell a real instance apart from a truck stop's
 * captive portal, so it touches nothing and returns a header. That makes it
 * useless as a deployment probe, because a container with an unreadable
 * database answers it perfectly while being unable to serve a single page.
 *
 * This one reads. See `databaseReachable` for what the query is chosen to
 * catch — a missing or wrongly-encrypted database, and one nobody has
 * migrated.
 *
 * The body says very little on purpose. This is unauthenticated, and a probe
 * that helpfully reported "no such table: organizations" or a filesystem path
 * would be handing a stranger a map of the deployment. The detail goes to the
 * server log, where the operator already has everything.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const ok = await databaseReachable();

  return NextResponse.json(
    ok ? { ok: true } : { ok: false, reason: 'database' },
    { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
}
