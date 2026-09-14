'use server';

import { revalidatePath } from 'next/cache';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import { parseCsv } from '@/lib/import/csv';
import { readTable, type ParsedLoad } from '@/lib/import/rows';
import type { ColumnMapping } from '@/lib/import/columns';
import { annotateDuplicates, commitImport, type ImportOutcome } from '@/lib/import/commit';

/**
 * The two round trips an import takes.
 *
 * Both are handed the file and the mapping and parse it again here. The
 * browser parses too, so the mapping screen responds without a round trip,
 * but nothing it produced is trusted: the preview a person approves and the
 * rows that get written are derived from the same input by the same code, so
 * they cannot disagree.
 */

/** Large enough for a year of dispatch sheets, small enough not to be a weapon. */
const MAX_CHARS = 2_000_000;
const MAX_ROWS = 2_000;

export interface PreviewResult {
  ok: boolean;
  error?: string;
  loads?: ParsedLoad[];
  /** Columns in the file that no field claimed, for display. */
  headers?: string[];
}

export interface ImportResult {
  ok: boolean;
  error?: string;
  outcome?: ImportOutcome;
}

function tooBig(text: string): string | null {
  if (text.trim() === '') return 'There is nothing in that file.';
  if (text.length > MAX_CHARS) {
    return 'That file is larger than an import can take. Split it and bring in the halves.';
  }
  return null;
}

export async function previewImportAction(
  text: string,
  mapping: ColumnMapping,
): Promise<PreviewResult> {
  let context;
  try {
    context = await requireCapability('load.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const oversize = tooBig(text);
  if (oversize) return { ok: false, error: oversize };

  const table = parseCsv(text);
  if (table.headers.length === 0) return { ok: false, error: 'That file has no header row.' };
  if (table.rows.length > MAX_ROWS) {
    return {
      ok: false,
      error: `That file has ${table.rows.length} rows. An import takes ${MAX_ROWS} at a time.`,
    };
  }

  const parsed = readTable(table, mapping);
  const annotated = await annotateDuplicates(context.db, parsed);

  return { ok: true, loads: annotated, headers: table.headers };
}

export async function runImportAction(
  text: string,
  mapping: ColumnMapping,
): Promise<ImportResult> {
  let context;
  try {
    context = await requireCapability('load.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const { session, db: scoped } = context;

  const oversize = tooBig(text);
  if (oversize) return { ok: false, error: oversize };

  const table = parseCsv(text);
  if (table.rows.length > MAX_ROWS) {
    return { ok: false, error: `An import takes ${MAX_ROWS} rows at a time.` };
  }

  const annotated = await annotateDuplicates(scoped, readTable(table, mapping));

  try {
    const outcome = await commitImport(scoped, annotated, {
      orgId: session.orgId,
      userId: session.userId,
      role: session.role,
    });

    revalidatePath('/loads');
    return { ok: true, outcome };
  } catch {
    // Loads already written stay written — they are real loads, and the
    // preview named every one. Saying how far it got beats a bare failure.
    return {
      ok: false,
      error:
        'The import stopped partway. Check the loads list for what arrived before running it again.',
    };
  }
}
