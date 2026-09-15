import 'server-only';
import { rawClient } from './client';

/**
 * Whether the database is there and migrated.
 *
 * Lives here rather than in the route because `no-restricted-imports` bans the
 * raw handle from `src/app/**`, and rightly: everything a request does on
 * behalf of a signed-in person must go through `forOrg`, which welds the
 * tenant predicate onto the query. A readiness probe is the one thing with no
 * tenant to scope to — it runs before any session exists, and the question it
 * asks is about the file, not about anybody's data. So it sits on this side of
 * the boundary, next to `appendAudit` and `verifyChain`, which are unscoped
 * for their own stated reasons.
 *
 * The query is chosen to fail in both of the ways a fresh deployment fails:
 * a database that cannot be opened at all — missing, unreadable, or encrypted
 * with a different `DATABASE_ENCRYPTION_KEY` — and one that opens but has
 * never had `npm run db:migrate` run against it, where the table does not
 * exist yet. Reading zero rows is a pass; an empty instance nobody has
 * registered on is ready to be registered on.
 */
export async function databaseReachable(): Promise<boolean> {
  try {
    await rawClient.execute('select 1 from organizations limit 1');
    return true;
  } catch (error) {
    console.error('[ready] database probe failed:', error);
    return false;
  }
}
