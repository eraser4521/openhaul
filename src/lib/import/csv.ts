/**
 * Reading a delimited file that came from somewhere else.
 *
 * Nothing here knows what a load is. It turns bytes into a grid, because the
 * failures at this layer are their own kind — a semicolon-delimited export
 * from a German-locale Excel, a BOM that makes the first header unmatchable,
 * an address with a comma in it, a note with a line break inside the quotes.
 * Getting those wrong silently shifts every column one to the left, and a
 * mapping screen built on a bad grid asks the user to confirm nonsense.
 *
 * Deliberately lenient about shape and strict about quoting. A short row is
 * padded rather than rejected: exports drop trailing empty cells all the time
 * and that is not an error. Quoting follows RFC 4180, because guessing there
 * corrupts data rather than losing it.
 */

/** Candidates in preference order; ties resolve to the earliest. */
const DELIMITERS = [',', '\t', ';', '|'] as const;

export type Delimiter = (typeof DELIMITERS)[number];

export interface CsvRow {
  /** 1-based line in the original file, so a problem can cite where it is. */
  line: number;
  cells: string[];
}

export interface CsvTable {
  delimiter: Delimiter;
  headers: string[];
  rows: CsvRow[];
}

const BOM = '﻿';

/**
 * Picks the delimiter by counting candidates in the header line only.
 *
 * The header is the one line guaranteed to be structural rather than content,
 * so an address full of commas in row 40 cannot outvote a tab-separated file.
 * Counting happens outside quotes for the same reason.
 */
export function sniffDelimiter(input: string): Delimiter {
  const counts = new Map<Delimiter, number>(DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') i += 1;
        else inQuotes = false;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === '\n' || ch === '\r') break;

    const candidate = DELIMITERS.find((d) => d === ch);
    if (candidate) counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
  }

  let best: Delimiter = ',';
  let bestCount = 0;
  for (const delimiter of DELIMITERS) {
    const count = counts.get(delimiter) ?? 0;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }

  return best;
}

/**
 * Splits a delimited file into a header row and data rows.
 *
 * Blank lines are dropped rather than becoming empty records — a spreadsheet
 * saved with a gap between sections should not import a load with no VIN.
 */
export function parseCsv(input: string, delimiter?: Delimiter): CsvTable {
  const text = input.startsWith(BOM) ? input.slice(BOM.length) : input;
  const sep = delimiter ?? sniffDelimiter(text);

  const records: CsvRow[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;

  const endRecord = () => {
    cells.push(field);
    field = '';
    // Every cell empty means a spacer line, not a record.
    if (cells.some((cell) => cell.trim() !== '')) {
      records.push({ line: recordLine, cells });
    }
    cells = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
        continue;
      }
      // A line break inside quotes belongs to the value, but the file's line
      // count still advances — otherwise later problems cite the wrong line.
      if (ch === '\r') {
        if (text[i + 1] === '\n') i += 1;
        field += '\n';
        line += 1;
        continue;
      }
      if (ch === '\n') {
        field += '\n';
        line += 1;
        continue;
      }
      field += ch;
      continue;
    }

    // A quote only opens a quoted field at the start of one. Mid-field it is
    // a literal — 24" wheels, a height in a note.
    if (ch === '"' && field === '') {
      inQuotes = true;
      continue;
    }
    if (ch === sep) {
      cells.push(field);
      field = '';
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRecord();
      line += 1;
      recordLine = line;
      continue;
    }

    field += ch;
  }

  if (field !== '' || cells.length > 0) endRecord();

  const [header, ...rest] = records;
  if (!header) return { delimiter: sep, headers: [], rows: [] };

  const headers = header.cells.map((cell) => cell.trim());
  const width = headers.length;

  const rows = rest.map((row) => ({
    line: row.line,
    cells: Array.from({ length: width }, (_, index) => (row.cells[index] ?? '').trim()),
  }));

  return { delimiter: sep, headers, rows };
}

/** Reads a cell by column index, or null when it is absent or blank. */
export function cell(row: CsvRow, index: number | null): string | null {
  if (index === null || index < 0) return null;
  const value = row.cells[index];
  return value === undefined || value === '' ? null : value;
}
