import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Applies every generated migration to a throwaway database, in order.
 *
 * Reads the directory rather than naming a file, so a test written today keeps
 * exercising the schema after somebody adds a migration next month — which is
 * the case where a hardcoded filename silently stops testing anything new.
 *
 * `drizzle/manual/` is deliberately skipped: those are hand-written triggers
 * applied separately by the migrate script, and a test that needs them should
 * say so rather than picking them up by accident.
 */
export async function applyMigrations(client: {
  execute: (sql: string) => Promise<unknown>;
}): Promise<string[]> {
  const directory = path.join(process.cwd(), 'drizzle');
  const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = await readFile(path.join(directory, file), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.execute(trimmed);
    }
  }

  return files;
}
