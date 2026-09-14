import 'server-only';
import { eq } from 'drizzle-orm';
import {
  accessorialRates as ratesTable,
  invoiceAccessorials as linesTable,
  invoices as invoicesTable,
  type AccessorialUnit,
} from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { totalCents, type Charges } from '../invoices/compute';
import { extendedCents, sumAccessorials, type AccessorialLine } from './accessorial-math';

/**
 * The carrier's accessorial catalogue, and the lines it puts on an invoice.
 *
 * Two rules, both aimed at the same failure.
 *
 * A line copies its label, unit and rate out of the catalogue at the moment it
 * is added. Editing a catalogue entry afterwards never reaches an invoice that
 * already cites it, because the customer is holding a document stating a
 * figure and a rate rise in June cannot retroactively change what was charged
 * in March.
 *
 * The invoice's accessorial total is derived from its lines on every write,
 * never incremented. The same rule the rest of the billing code follows, for
 * the same reason: an accumulated column drifts the first time somebody
 * corrects a quantity.
 */

/* -------------------------------------------------------------------------
 * The catalogue
 * ---------------------------------------------------------------------- */

export interface RateInput {
  code: string;
  label: string;
  unit: AccessorialUnit;
  defaultCents: number;
  note: string | null;
  sortOrder?: number;
}

export async function listRates(
  scoped: ScopedDb,
  options: { includeRetired?: boolean } = {},
): Promise<Array<typeof ratesTable.$inferSelect>> {
  const rows = await scoped.select(
    'accessorialRates',
    options.includeRetired ? undefined : eq(ratesTable.active, true),
  );

  // Sort order first, then label, so a carrier who never sets an order still
  // gets a list that is the same every time they open it.
  return rows.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

export async function createRate(
  scoped: ScopedDb,
  input: RateInput,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const code = input.code.trim().toUpperCase();

  const clash = await scoped.selectOne('accessorialRates', eq(ratesTable.code, code));
  if (clash) {
    return {
      ok: false,
      error: `You already have a charge coded ${code}. Edit that one rather than adding a second.`,
    };
  }

  const [row] = await scoped.insert('accessorialRates', {
    code,
    label: input.label.trim(),
    unit: input.unit,
    defaultCents: input.defaultCents,
    note: input.note,
    sortOrder: input.sortOrder ?? 0,
  });

  return row ? { ok: true, id: row.id } : { ok: false, error: 'That charge could not be saved.' };
}

export async function updateRate(
  scoped: ScopedDb,
  id: string,
  input: Partial<RateInput>,
): Promise<{ ok: boolean; error?: string }> {
  const existing = await scoped.selectOne('accessorialRates', eq(ratesTable.id, id));
  if (!existing) return { ok: false, error: 'No such charge.' };

  const code = input.code?.trim().toUpperCase();
  if (code && code !== existing.code) {
    const clash = await scoped.selectOne('accessorialRates', eq(ratesTable.code, code));
    if (clash) return { ok: false, error: `You already have a charge coded ${code}.` };
  }

  await scoped.update('accessorialRates', eq(ratesTable.id, id), {
    ...(code ? { code } : {}),
    ...(input.label !== undefined ? { label: input.label.trim() } : {}),
    ...(input.unit !== undefined ? { unit: input.unit } : {}),
    ...(input.defaultCents !== undefined ? { defaultCents: input.defaultCents } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
  });

  return { ok: true };
}

/**
 * Retires a charge rather than deleting it.
 *
 * The invoices that already cite it keep their own copy of the label and rate,
 * so deletion would not corrupt anything — but a carrier who stops billing for
 * storage this year still wants last year's invoices to make sense when the
 * broker queries one, and a retired entry is what makes the code on that
 * invoice explicable.
 */
export async function setRateActive(
  scoped: ScopedDb,
  id: string,
  active: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const existing = await scoped.selectOne('accessorialRates', eq(ratesTable.id, id));
  if (!existing) return { ok: false, error: 'No such charge.' };

  await scoped.update('accessorialRates', eq(ratesTable.id, id), { active });
  return { ok: true };
}

/* -------------------------------------------------------------------------
 * Lines on an invoice
 * ---------------------------------------------------------------------- */

export interface InvoiceAccessorialRow extends AccessorialLine {
  id: string;
  /** Always present on a stored row, where the rendering type allows it absent. */
  note: string | null;
  amountCents: number;
}

export async function accessorialsFor(
  scoped: ScopedDb,
  invoiceId: string,
): Promise<InvoiceAccessorialRow[]> {
  const rows = await scoped.select('invoiceAccessorials', eq(linesTable.invoiceId, invoiceId));

  return rows
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime())
    .map((row) => ({
      id: row.id,
      label: row.label,
      code: row.code,
      unit: row.unit,
      quantityHundredths: row.quantityHundredths,
      unitCents: row.unitCents,
      note: row.note,
      amountCents: extendedCents(row),
    }));
}

export interface AddAccessorialInput {
  /** From the catalogue, or null for a one-off. */
  rateId: string | null;
  label: string;
  code: string | null;
  unit: AccessorialUnit;
  quantityHundredths: number;
  unitCents: number;
  note: string | null;
}

/**
 * Adds one line to a draft invoice.
 *
 * Refused once the invoice is issued, for the same reason every other figure
 * on it is: the customer is holding a document that states a total, and adding
 * a charge to it after the fact would put two different numbers in circulation
 * under one invoice number. The remedy for a charge discovered late is another
 * invoice, or a credit note if it went the other way.
 */
export async function addAccessorial(
  scoped: ScopedDb,
  invoiceId: string,
  input: AddAccessorialInput,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const invoice = await scoped.selectOne('invoices', eq(invoicesTable.id, invoiceId));
  if (!invoice) return { ok: false, error: 'No such invoice.' };

  if (invoice.status !== 'draft') {
    return {
      ok: false,
      error:
        'This invoice has already been issued, so a charge cannot be added to it. Raise a ' +
        'second invoice for the extra work.',
    };
  }

  if (input.quantityHundredths <= 0) {
    return { ok: false, error: 'The quantity has to be more than nothing.' };
  }

  const [row] = await scoped.insert('invoiceAccessorials', {
    invoiceId,
    rateId: input.rateId,
    // Copied, not referenced. A rate rise next month does not rewrite this.
    label: input.label.trim(),
    code: input.code?.trim().toUpperCase() || null,
    unit: input.unit,
    quantityHundredths: input.quantityHundredths,
    unitCents: input.unitCents,
    note: input.note,
    sortOrder: (await accessorialsFor(scoped, invoiceId)).length,
  });

  if (!row) return { ok: false, error: 'That charge could not be added.' };

  await recomputeAccessorials(scoped, invoiceId);
  return { ok: true, id: row.id };
}

export async function removeAccessorial(
  scoped: ScopedDb,
  invoiceId: string,
  lineId: string,
): Promise<{ ok: boolean; error?: string }> {
  const invoice = await scoped.selectOne('invoices', eq(invoicesTable.id, invoiceId));
  if (!invoice) return { ok: false, error: 'No such invoice.' };

  if (invoice.status !== 'draft') {
    return {
      ok: false,
      error: 'This invoice has already been issued and cannot be changed.',
    };
  }

  // Fetched first so a line id belonging to another invoice cannot be removed
  // by passing it with this invoice's id.
  const line = await scoped.selectOne('invoiceAccessorials', eq(linesTable.id, lineId));
  if (!line || line.invoiceId !== invoiceId) {
    return { ok: false, error: 'No such charge on this invoice.' };
  }

  await scoped.remove('invoiceAccessorials', eq(linesTable.id, lineId));

  await recomputeAccessorials(scoped, invoiceId);
  return { ok: true };
}

/**
 * Re-derives the invoice's accessorial figure and total from its lines.
 *
 * Called after every change to a line. The total is computed from the charges
 * as a whole rather than adjusted by a delta, so a line removed and re-added
 * leaves the invoice exactly where it started.
 */
export async function recomputeAccessorials(scoped: ScopedDb, invoiceId: string): Promise<number> {
  const invoice = await scoped.selectOne('invoices', eq(invoicesTable.id, invoiceId));
  if (!invoice) return 0;

  const lines = await accessorialsFor(scoped, invoiceId);
  const accessorialCents = sumAccessorials(lines);

  const charges: Charges = {
    lineHaulCents: invoice.lineHaulCents,
    fuelSurchargeCents: invoice.fuelSurchargeCents,
    accessorialCents,
    taxCents: invoice.taxCents,
    codCollectedCents: invoice.codCollectedCents,
    depositCents: invoice.depositCents,
  };

  await scoped.update('invoices', eq(invoicesTable.id, invoiceId), {
    accessorialCents,
    totalCents: totalCents(charges),
  });

  return accessorialCents;
}
