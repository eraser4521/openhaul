import 'server-only';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
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

/**
 * Makes sure the folder a local database file lives in exists.
 *
 * SQLite will create the file but not the directory, so a fresh clone throws
 * `SQLITE_CANTOPEN` the first time anything imports this — before migrations
 * have ever run, which is exactly when `data/` does not exist yet. The
 * migrate script already does this for itself; doing it here covers every
 * other way in, including a test run on a clean checkout.
 */
function ensureDirectory(url: string): void {
  if (!url.startsWith('file:')) return;

  const filePath = url.slice('file:'.length);
  // `:memory:` and shared-cache URIs have no directory to make.
  if (!filePath || filePath.startsWith(':')) return;

  try {
    mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  } catch {
    // Read-only filesystem, or a path the process cannot create. Let the
    // connection itself produce the error, which says more than this could.
  }
}

const url = connectionUrl();
ensureDirectory(url);

const client = createClient({
  url,
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
