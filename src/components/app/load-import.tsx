'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, AlertTriangle, ArrowLeft, Check, FileUp, Table2 } from 'lucide-react';
import { previewImportAction, runImportAction } from '@/app/(app)/loads/import/actions';
import { parseCsv, type CsvTable } from '@/lib/import/csv';
import {
  FIELD_SPECS,
  GROUP_LABEL,
  IMPORT_FIELDS,
  guessMapping,
  unmappedColumns,
  type ColumnMapping,
  type FieldGroup,
} from '@/lib/import/columns';
import { countProblems, importable, type ParsedLoad } from '@/lib/import/rows';
import type { ImportOutcome } from '@/lib/import/commit';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils/cn';
import { money } from '@/lib/utils/format';

/**
 * Bringing a dispatch sheet in.
 *
 * Three steps, and the middle one is the point. Nothing is written until a
 * person has seen what each column was taken to mean and what every row would
 * become — because an import that quietly creates two hundred wrong loads
 * costs more to unpick than it ever saved, and the mistakes it makes are the
 * kind nobody notices until an invoice goes out.
 *
 * The file is parsed here as well as on the server. That is not duplication
 * for its own sake: it lets the mapping screen show a live sample of every
 * column without a round trip, while the preview and the import are both
 * still derived on the server from the file itself, so what was approved and
 * what gets written cannot come apart.
 */

type Stage = 'file' | 'map' | 'preview' | 'done';

/** The first row's value for a column, so an off-by-one is visible. */
function sampleFor(table: CsvTable, index: number | null | undefined): string | null {
  if (index === null || index === undefined) return null;
  for (const row of table.rows.slice(0, 5)) {
    const value = row.cells[index];
    if (value) return value.length > 40 ? `${value.slice(0, 40)}…` : value;
  }
  return null;
}

/**
 * Decodes a spreadsheet export.
 *
 * Excel still writes CSV in the system code page on Windows, so a strict
 * UTF-8 read of a file with an accented city name throws. Falling back keeps
 * "Pueblo Nuevo" spelled correctly instead of full of replacement characters.
 */
async function readFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

const MAX_SHOWN = 200;

export function LoadImport() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('file');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [text, setText] = useState('');
  const [source, setSource] = useState<string | null>(null);
  const [table, setTable] = useState<CsvTable | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [preview, setPreview] = useState<ParsedLoad[] | null>(null);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);

  const load = (contents: string, name: string) => {
    const parsed = parseCsv(contents);
    if (parsed.headers.length === 0) {
      setError('That file has no header row, so there is nothing to map.');
      return;
    }
    setError(null);
    setText(contents);
    setSource(name);
    setTable(parsed);
    setMapping(guessMapping(parsed.headers));
    setStage('map');
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      load(await readFile(file), file.name);
    } catch {
      setError('That file could not be read.');
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await previewImportAction(text, mapping);
      if (!result.ok || !result.loads) {
        setError(result.error ?? 'The file could not be checked.');
        return;
      }
      setPreview(result.loads);
      setStage('preview');
    } catch {
      setError('The file could not be checked. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await runImportAction(text, mapping);
      if (!result.ok || !result.outcome) {
        setError(result.error ?? 'The import did not run.');
        return;
      }
      setOutcome(result.outcome);
      setStage('done');
      router.refresh();
    } catch {
      setError('The import did not run. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setStage('file');
    setText('');
    setSource(null);
    setTable(null);
    setMapping({});
    setPreview(null);
    setOutcome(null);
    setError(null);
  };

  return (
    <div className="space-y-6">
      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}

      {stage === 'file' && <ChooseFile busy={busy} onFile={onFile} onPaste={load} />}

      {stage === 'map' && table && (
        <MapColumns
          table={table}
          source={source}
          mapping={mapping}
          busy={busy}
          onChange={setMapping}
          onBack={restart}
          onNext={() => void check()}
        />
      )}

      {stage === 'preview' && preview && (
        <Preview
          loads={preview}
          busy={busy}
          onBack={() => setStage('map')}
          onRun={() => void run()}
        />
      )}

      {stage === 'done' && outcome && <Done outcome={outcome} onAgain={restart} />}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Step one
 * ---------------------------------------------------------------------- */

function ChooseFile({
  busy,
  onFile,
  onPaste,
}: {
  busy: boolean;
  onFile: (file: File | undefined) => Promise<void>;
  onPaste: (text: string, name: string) => void;
}) {
  const [pasted, setPasted] = useState('');

  return (
    <Card>
      <div className="border-b border-line px-5 py-4">
        <h2 className="text-sm font-semibold text-ink">Bring in a file</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
          A CSV or tab-separated export from a load board, a broker, or your own spreadsheet. One
          row per vehicle; rows that share a load number become one load.
        </p>
      </div>

      <div className="space-y-5 px-5 py-5">
        <div>
          <label
            htmlFor="import-file"
            className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong px-6 py-8 text-center transition-colors hover:border-brand"
          >
            <FileUp className="size-6 text-ink-muted" aria-hidden />
            <span className="text-sm font-medium text-ink">Choose a file</span>
            <span className="text-xs text-ink-muted">.csv, .tsv or .txt</span>
          </label>
          <input
            id="import-file"
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
            className="sr-only"
            disabled={busy}
            onChange={(event) => void onFile(event.target.files?.[0])}
          />
        </div>

        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-line" />
          <span className="text-xs text-ink-muted">or paste it</span>
          <span className="h-px flex-1 bg-line" />
        </div>

        <div>
          <textarea
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            rows={5}
            spellCheck={false}
            placeholder={'Order ID,VIN,Origin,Destination,Carrier Pay\n88231,1HGCM82633A004352,"Dallas, TX","Phoenix, AZ",950'}
            className="w-full rounded-lg border border-line bg-raised px-3 py-2 font-mono text-xs text-ink focus:border-brand focus:outline-none"
          />
          <div className="mt-2 flex justify-end">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || pasted.trim() === ''}
              onClick={() => onPaste(pasted, 'pasted text')}
            >
              Use this
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------
 * Step two
 * ---------------------------------------------------------------------- */

const GROUPS: FieldGroup[] = ['load', 'pickup', 'delivery', 'vehicle'];

function MapColumns({
  table,
  source,
  mapping,
  busy,
  onChange,
  onBack,
  onNext,
}: {
  table: CsvTable;
  source: string | null;
  mapping: ColumnMapping;
  busy: boolean;
  onChange: (mapping: ColumnMapping) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const unused = unmappedColumns(table.headers, mapping);
  const hasVin = typeof mapping.vin === 'number';

  const set = (field: (typeof IMPORT_FIELDS)[number], raw: string) => {
    const next = { ...mapping };
    if (raw === '') delete next[field];
    else next[field] = Number.parseInt(raw, 10);
    onChange(next);
  };

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Table2 className="size-4 text-ink-muted" aria-hidden />
            What each column means
          </h2>
          <p className="mt-1 text-xs text-ink-secondary">
            {source} · {table.headers.length} columns · {table.rows.length} rows
          </p>
        </div>
        <p className="text-xs text-ink-muted">
          Guessed from the header names. Correct anything that is wrong.
        </p>
      </div>

      <div className="divide-y divide-line">
        {GROUPS.map((group) => (
          <div key={group} className="px-5 py-4">
            <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
              {GROUP_LABEL[group]}
            </p>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {IMPORT_FIELDS.filter((field) => FIELD_SPECS[field].group === group).map((field) => {
                const spec = FIELD_SPECS[field];
                const value = mapping[field];
                const sample = sampleFor(table, value);

                return (
                  <div key={field}>
                    <label
                      htmlFor={`map-${field}`}
                      className="text-sm font-medium text-ink"
                    >
                      {spec.label}
                    </label>
                    <select
                      id={`map-${field}`}
                      value={typeof value === 'number' ? String(value) : ''}
                      onChange={(event) => set(field, event.target.value)}
                      className="mt-1.5 h-10 w-full rounded-lg border border-line bg-raised px-2 text-sm text-ink focus:border-brand focus:outline-none"
                    >
                      <option value="">Not in the file</option>
                      {table.headers.map((header, index) => (
                        <option key={index} value={index}>
                          {header || `Column ${index + 1}`}
                        </option>
                      ))}
                    </select>
                    {sample && (
                      <p className="mt-1 truncate font-mono text-xs text-ink-secondary">
                        {sample}
                      </p>
                    )}
                    {spec.note && (
                      <p className="mt-1 text-xs leading-relaxed text-ink-muted">{spec.note}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {unused.length > 0 && (
        <p className="border-t border-line px-5 py-3 text-xs leading-relaxed text-ink-muted">
          Nothing will be read from{' '}
          <span className="text-ink-secondary">
            {unused.map((index) => table.headers[index] || `column ${index + 1}`).join(', ')}
          </span>
          . There is nowhere to put {unused.length === 1 ? 'it' : 'them'}.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4">
        <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
          <ArrowLeft aria-hidden />
          Different file
        </Button>
        <div className="flex items-center gap-3">
          {!hasVin && (
            <p className="text-xs text-warn">A VIN column is needed before anything can import.</p>
          )}
          <Button type="button" loading={busy} disabled={!hasVin} onClick={onNext}>
            Check the file
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------
 * Step three
 * ---------------------------------------------------------------------- */

function Preview({
  loads,
  busy,
  onBack,
  onRun,
}: {
  loads: ParsedLoad[];
  busy: boolean;
  onBack: () => void;
  onRun: () => void;
}) {
  const ready = importable(loads);
  const { errors, warnings } = countProblems(loads);
  const vehicles = ready.reduce((sum, load) => sum + load.vehicles.length, 0);

  // Whatever needs a decision first.
  const ordered = [...loads].sort((a, b) => weight(b) - weight(a));
  const shown = ordered.slice(0, MAX_SHOWN);

  return (
    <Card>
      <div className="border-b border-line px-5 py-4">
        <h2 className="text-sm font-semibold text-ink">
          {ready.length} load{ready.length === 1 ? '' : 's'} ready, {vehicles} vehicle
          {vehicles === 1 ? '' : 's'}
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
          {loads.length - ready.length > 0
            ? `${loads.length - ready.length} will not import. `
            : ''}
          {errors > 0 && `${errors} problem${errors === 1 ? '' : 's'} to fix. `}
          {warnings > 0 && `${warnings} thing${warnings === 1 ? '' : 's'} worth knowing. `}
          {errors === 0 && warnings === 0 && 'Nothing looks wrong.'}
        </p>
      </div>

      <ul className="divide-y divide-line">
        {shown.map((load, index) => {
          const blocked = load.problems.some((problem) => problem.severity === 'error');

          return (
            <li key={load.key ?? `row-${index}`} className="px-5 py-3.5">
              <p className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-ink">
                  {load.number ?? 'Number to be assigned'}
                </span>
                <Badge tone={blocked ? 'danger' : 'neutral'} size="sm">
                  {blocked ? 'Will not import' : `${load.vehicles.length} vehicle${load.vehicles.length === 1 ? '' : 's'}`}
                </Badge>
                {load.customer.name && (
                  <span className="text-xs text-ink-secondary">{load.customer.name}</span>
                )}
                {load.rateCents !== null && (
                  <span className="text-xs text-ink-secondary tabular-nums">
                    {money(load.rateCents)}
                  </span>
                )}
              </p>

              <p className="mt-0.5 text-xs text-ink-muted">
                {describeRoute(load)} · line{load.lines.length === 1 ? '' : 's'}{' '}
                {load.lines.join(', ')}
              </p>

              {load.problems.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {load.problems.map((problem, at) => (
                    <li
                      key={at}
                      className={`flex items-start gap-1.5 text-xs leading-relaxed ${
                        problem.severity === 'error' ? 'text-danger' : 'text-warn'
                      }`}
                    >
                      {problem.severity === 'error' ? (
                        <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      ) : (
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      )}
                      <span>
                        {problem.line !== null && (
                          <span className="text-ink-muted">Line {problem.line}: </span>
                        )}
                        {problem.message}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {ordered.length > shown.length && (
        <p className="border-t border-line px-5 py-3 text-xs text-ink-muted">
          Showing {shown.length} of {ordered.length}, worst first. The rest import the same way.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4">
        <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
          <ArrowLeft aria-hidden />
          Change the mapping
        </Button>
        <Button type="button" loading={busy} disabled={ready.length === 0} onClick={onRun}>
          Import {ready.length} load{ready.length === 1 ? '' : 's'}
        </Button>
      </div>
    </Card>
  );
}

function weight(load: ParsedLoad): number {
  if (load.problems.some((problem) => problem.severity === 'error')) return 2;
  return load.problems.length > 0 ? 1 : 0;
}

function describeRoute(load: ParsedLoad): string {
  const from = [load.pickup.city, load.pickup.state].filter(Boolean).join(', ');
  const to = [load.delivery.city, load.delivery.state].filter(Boolean).join(', ');
  if (!from && !to) return 'Route not in the file';
  return `${from || 'unknown'} → ${to || 'unknown'}`;
}

/* -------------------------------------------------------------------------
 * After
 * ---------------------------------------------------------------------- */

function Done({ outcome, onAgain }: { outcome: ImportOutcome; onAgain: () => void }) {
  return (
    <Card>
      <div className="flex items-start gap-3 border-b border-line bg-ok-soft px-5 py-4">
        <Check className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ok">
            {outcome.created} load{outcome.created === 1 ? '' : 's'} created,{' '}
            {outcome.vehicles} vehicle{outcome.vehicles === 1 ? '' : 's'}
          </h2>
          {outcome.skipped > 0 && (
            <p className="mt-1 text-xs text-ink-secondary">
              {outcome.skipped} row{outcome.skipped === 1 ? '' : 's'} had something blocking and
              {outcome.skipped === 1 ? ' was' : ' were'} left out.
            </p>
          )}
        </div>
      </div>

      <div className="px-5 py-4">
        <p className="text-xs leading-relaxed text-ink-secondary">
          Every one came in as a draft, so nothing is dispatched and nothing is billed until
          somebody says so. Addresses that were only a city and a state are noted on the stop and
          still need filling in before a bill of lading can be produced.
        </p>

        {outcome.numbers.length > 0 && (
          <p className="mt-3 font-mono text-xs break-words text-ink-muted">
            {outcome.numbers.slice(0, 40).join('  ')}
            {outcome.numbers.length > 40 ? ` +${outcome.numbers.length - 40} more` : ''}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4">
        <Button type="button" variant="ghost" onClick={onAgain}>
          Import another file
        </Button>
        <Link href="/loads" className={cn(buttonVariants())}>
          See the loads
        </Link>
      </div>
    </Card>
  );
}
