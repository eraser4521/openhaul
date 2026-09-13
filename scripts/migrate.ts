/**
 * Applies database migrations.
 *
 * Run as a one-shot step before the server starts, never from inside a
 * request. Strangers upgrade this app unattended across arbitrary version
 * gaps, so the script takes a consistent backup first and tells them exactly
 * how to roll back if anything fails.
 */
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { readdir, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const DATABASE_URL = process.env.DATABASE_URL ?? 'file:./data/openhaul.db';

function localFilePath(url: string): string | null {
  return url.startsWith('file:') ? url.slice('file:'.length) : null;
}

async function main() {
  const filePath = localFilePath(DATABASE_URL);
  if (filePath) {
    await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  }

  const client = createClient({
    url: DATABASE_URL,
    authToken: process.env.DATABASE_AUTH_TOKEN,
    encryptionKey: process.env.DATABASE_ENCRYPTION_KEY,
  });

  // Foreign keys are OFF by default in SQLite, which would make every
  // composite (org_id, id) key decorative.
  await client.execute('PRAGMA foreign_keys = ON');
  await client.execute('PRAGMA journal_mode = WAL');

  // Back up before touching anything. VACUUM INTO is transactionally
  // consistent; copying the file is not, because it can capture a torn WAL.
  let backupPath: string | null = null;
  if (filePath) {
    const existing = await client
      .execute("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1")
      .then((r) => r.rows.length > 0)
      .catch(() => false);

    if (existing) {
      const dir = path.join(path.dirname(path.resolve(filePath)), 'backups');
      await mkdir(dir, { recursive: true });
      // A monotonic counter rather than a timestamp: the script must be
      // deterministic enough to re-run safely.
      const stamp = process.env.MIGRATION_STAMP ?? String(process.hrtime.bigint());
      backupPath = path.join(dir, `pre-migrate-${stamp}.db`);
      await client.execute({ sql: 'VACUUM INTO ?', args: [backupPath] });
      console.log(`Backup written to ${backupPath}`);
    }
  }

  const db = drizzle(client);

  try {
    await migrate(db, { migrationsFolder: './drizzle' });
    console.log('Schema migrations applied.');
  } catch (error) {
    console.error('Migration FAILED.');
    if (backupPath) {
      console.error(`Restore with:\n  cp "${backupPath}" "${filePath}"`);
    }
    throw error;
  }

  // Hand-written statements drizzle-kit cannot generate: triggers, and any
  // other DDL that has to be expressed directly. Each file is idempotent.
  const manualDir = path.join(process.cwd(), 'drizzle', 'manual');
  let manualFiles: string[] = [];
  try {
    manualFiles = (await readdir(manualDir)).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    // No manual directory is fine.
  }

  for (const file of manualFiles) {
    const sql = await readFile(path.join(manualDir, file), 'utf8');
    // libSQL executes one statement per call. Splitting on semicolons is wrong
    // here because trigger bodies contain their own, so these files mark
    // boundaries explicitly with the same breakpoint drizzle-kit emits.
    const statements = sql
      .split('--> statement-breakpoint')
      .map((chunk) =>
        chunk
          .split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join('\n')
          .trim(),
      )
      .filter((chunk) => chunk.length > 0);

    for (const statement of statements) {
      await client.execute(statement);
    }
    console.log(`Applied ${file}`);
  }

  await client.close();
  console.log('Migrations complete.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
