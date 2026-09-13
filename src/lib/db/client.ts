import 'server-only';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema';

/**
 * The raw database handle.
 *
 * Do not import this outside `src/lib/db/**` and `scripts/**`. Feature code
 * must go through `forOrg()` in `./scope`, which welds the tenant predicate
 * onto every query. An ESLint rule enforces this — see eslint.config.mjs.
 */

function connectionUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url) return url;

  // Default to a file beside the app so a one-person carrier can run this
  // with no configuration at all.
  return 'file:./data/openhaul.db';
}

const client = createClient({
  url: connectionUrl(),
  authToken: process.env.DATABASE_AUTH_TOKEN,
  // Whole-database encryption at rest. Protects a stolen disk or a copied
  // backup file; field-level encryption additionally protects against an
  // app-level read. Both are worth having.
  encryptionKey: process.env.DATABASE_ENCRYPTION_KEY,
});

/**
 * Connection pragmas.
 *
 * `foreign_keys` defaults to OFF in SQLite, which silently makes every foreign
 * key declaration decorative. That would disable the composite (org_id, id)
 * keys this app relies on for tenant isolation, so it is set first.
 */
export async function applyPragmas(): Promise<void> {
  await client.execute('PRAGMA foreign_keys = ON');
  // WAL persists in the file, but setting it is idempotent and cheap.
  await client.execute('PRAGMA journal_mode = WAL');
  // NORMAL is safe under WAL and avoids an fsync per commit.
  await client.execute('PRAGMA synchronous = NORMAL');
  // SQLite has a single writer; wait rather than failing when drivers flush
  // their offline queues at the same time.
  await client.execute('PRAGMA busy_timeout = 5000');
}

let pragmasApplied: Promise<void> | null = null;

/** Applies pragmas exactly once per process. */
export function ready(): Promise<void> {
  pragmasApplied ??= applyPragmas();
  return pragmasApplied;
}

export const db = drizzle(client, { schema });

export { client as rawClient };
export type Database = typeof db;
