import 'server-only';
import { loads as loadsTable } from '../db/schema';
import type { ScopedDb } from '../db/scope';

/**
 * Load references.
 *
 * A carrier's own numbering is the one their customers quote back at them, so
 * this is only a default — anything typed wins. It lives here rather than in
 * the create action because the importer needs a run of numbers at once and a
 * second copy of the rule would drift the first time either changed.
 */

const PREFIX = 'OH-';
const FIRST = 1001;

/** Next sequential reference, scoped to the organisation. */
export async function nextLoadNumber(scoped: ScopedDb): Promise<string> {
  const [number] = await allocateLoadNumbers(scoped, 1);
  return number ?? `${PREFIX}${FIRST}`;
}

/**
 * A run of consecutive references.
 *
 * Taken from the most recently created load rather than from a counter, which
 * is how the single-load path has always worked. Duplicates are still
 * impossible — `loads_org_number_uq` rejects them — so the worst a race can
 * do is fail an import, not silently give two loads one number.
 */
export async function allocateLoadNumbers(scoped: ScopedDb, count: number): Promise<string[]> {
  if (count <= 0) return [];

  const [latest] = await scoped.select('loads', undefined, {
    orderBy: { column: loadsTable.createdAt, direction: 'desc' },
    limit: 1,
  });

  const match = latest?.number ? /(\d+)$/.exec(latest.number) : null;
  const start = match?.[1] ? Number.parseInt(match[1], 10) + 1 : FIRST;

  return Array.from({ length: count }, (_, index) => `${PREFIX}${start + index}`);
}
