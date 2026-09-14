'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { accessorialRates as ratesTable, ACCESSORIAL_UNITS } from '@/lib/db/schema';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import { addAccessorial, removeAccessorial } from '@/lib/branding/accessorials';
import { parseQuantity } from '@/lib/branding/accessorial-math';
import { parseMoney } from '@/lib/invoices/compute';

/**
 * Putting an itemised charge on a draft invoice.
 *
 * A line can come from the catalogue or be typed for a one-off. Either way the
 * label, unit and rate are copied onto the line rather than referenced, so the
 * invoice keeps saying what it said even after the catalogue moves on.
 */

export interface AccessorialActionResult {
  ok: boolean;
  error?: string;
}

export async function addAccessorialAction(
  invoiceId: string,
  formData: FormData,
): Promise<AccessorialActionResult> {
  let context;
  try {
    context = await requireCapability('invoice.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const { db } = context;

  const rateId = String(formData.get('rateId') ?? '') || null;
  const quantity = parseQuantity(String(formData.get('quantity') ?? '1'));
  if (quantity === null) {
    return {
      ok: false,
      error: 'The quantity is a number, to at most two decimals — 3, or 3.5, or 3.25.',
    };
  }

  const unitCents = parseMoney(String(formData.get('unitRate') ?? ''));
  if (unitCents === null) return { ok: false, error: 'The rate is not an amount.' };

  let label = String(formData.get('label') ?? '').trim();
  let code = String(formData.get('code') ?? '').trim() || null;
  let unit = String(formData.get('unit') ?? 'flat');

  if (rateId) {
    /*
     * The catalogue is the authority on what the charge is called. Taking the
     * label from the form as well would let two invoices carry the same code
     * under different names, which is precisely the confusion the catalogue
     * exists to remove — the rate is still editable, because a negotiated
     * exception is a real thing.
     */
    const rate = await db.selectOne('accessorialRates', eq(ratesTable.id, rateId));
    if (!rate) return { ok: false, error: 'That charge is no longer in your catalogue.' };
    label = rate.label;
    code = rate.code;
    unit = rate.unit;
  }

  if (!label) return { ok: false, error: 'Give the charge a name the customer will recognise.' };
  if (!ACCESSORIAL_UNITS.includes(unit as (typeof ACCESSORIAL_UNITS)[number])) {
    return { ok: false, error: 'Unknown unit.' };
  }

  const result = await addAccessorial(db, invoiceId, {
    rateId,
    label,
    code,
    unit: unit as (typeof ACCESSORIAL_UNITS)[number],
    quantityHundredths: quantity,
    unitCents,
    note: String(formData.get('note') ?? '').trim() || null,
  });

  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath(`/invoices/${invoiceId}`);
  return { ok: true };
}

export async function removeAccessorialAction(
  invoiceId: string,
  lineId: string,
): Promise<AccessorialActionResult> {
  let context;
  try {
    context = await requireCapability('invoice.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const result = await removeAccessorial(context.db, invoiceId, lineId);
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath(`/invoices/${invoiceId}`);
  return { ok: true };
}
