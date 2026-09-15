'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import { parseMoney } from '@/lib/invoices/compute';
import { recordBalance, removeOutgoing, saveOutgoing } from '@/lib/cash/treasury';
import { OUTGOING_CADENCES, OUTGOING_CATEGORIES } from '@/lib/db/schema';

/**
 * The two things a carrier has to tell this application itself.
 *
 * `cash.write` rather than `invoice.write`. What customers owe is dispatch
 * information; what is in the bank, and what leaves it every month, is not —
 * so the people who can set these are the ones who already handle payments
 * and settlements.
 */

export interface CashActionResult {
  ok: boolean;
  error?: string;
  problems?: string[];
}

/**
 * Calendar dates, pinned to noon UTC so no reader's offset moves the day.
 *
 * The same convention the rest of the application uses for dates somebody
 * typed rather than moments something happened.
 */
function atNoon(value: string): Date | null {
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/* -------------------------------------------------------------------------
 * The balance
 * ---------------------------------------------------------------------- */

const balanceSchema = z.object({
  asOf: z.string().trim().min(1, 'Say which day this balance is from.'),
  note: z.string().trim().max(300).optional(),
});

export async function recordBalanceAction(formData: FormData): Promise<CashActionResult> {
  let context;
  try {
    context = await requireCapability('cash.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const parsed = balanceSchema.safeParse({
    asOf: formData.get('asOf') ?? '',
    note: formData.get('note') ?? undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the details.' };
  }

  /*
   * Zero is a balance and has to be accepted, so the empty check is on the
   * parse rather than on the figure. An overdrawn account parses negative and
   * is accepted too: refusing it would push somebody into entering zero, which
   * reads as solvent.
   */
  const amountCents = parseMoney(String(formData.get('amount') ?? ''));
  if (amountCents === null) {
    return { ok: false, error: 'Enter the balance, like 4250.00 — or -320.15 if you are overdrawn.' };
  }

  const asOf = atNoon(parsed.data.asOf);
  if (!asOf) return { ok: false, error: 'That is not a date.' };

  const { session, db } = context;
  const result = await recordBalance(db, {
    amountCents,
    asOf,
    note: parsed.data.note || null,
    userId: session.userId,
  });

  if (!result.ok) return result;

  revalidatePath('/money/timeline');
  revalidatePath('/money');
  return { ok: true };
}

/* -------------------------------------------------------------------------
 * Standing costs
 * ---------------------------------------------------------------------- */

const outgoingSchema = z.object({
  name: z.string().trim().min(1, 'Give it a name you would recognise on a bank statement.').max(80),
  category: z.enum(OUTGOING_CATEGORIES),
  cadence: z.enum(OUTGOING_CADENCES),
  anchorOn: z.string().trim().min(1, 'Say when the first payment is, or was.'),
  endsOn: z.string().trim().optional(),
  note: z.string().trim().max(300).optional(),
});

export async function saveOutgoingAction(
  id: string | null,
  formData: FormData,
): Promise<CashActionResult> {
  let context;
  try {
    context = await requireCapability('cash.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const parsed = outgoingSchema.safeParse({
    name: formData.get('name') ?? '',
    category: formData.get('category') ?? 'other',
    cadence: formData.get('cadence') ?? 'monthly',
    anchorOn: formData.get('anchorOn') ?? '',
    endsOn: formData.get('endsOn') ?? undefined,
    note: formData.get('note') ?? undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the details.' };
  }

  const amountCents = parseMoney(String(formData.get('amount') ?? ''));
  if (amountCents === null) {
    return { ok: false, error: 'Enter what leaves each time, like 1850.00.' };
  }

  const anchorOn = atNoon(parsed.data.anchorOn);
  if (!anchorOn) return { ok: false, error: 'That first payment date is not a date.' };

  const endsOn = parsed.data.endsOn ? atNoon(parsed.data.endsOn) : null;
  if (parsed.data.endsOn && !endsOn) {
    return { ok: false, error: 'That last payment date is not a date.' };
  }

  const { session, db } = context;
  const result = await saveOutgoing(
    db,
    id,
    {
      name: parsed.data.name,
      category: parsed.data.category,
      amountCents,
      cadence: parsed.data.cadence,
      anchorOn,
      endsOn,
      note: parsed.data.note || null,
    },
    session.userId,
  );

  if (!result.ok) return result;

  revalidatePath('/money/outgoings');
  revalidatePath('/money/timeline');
  return { ok: true };
}

export async function removeOutgoingAction(id: string): Promise<CashActionResult> {
  let context;
  try {
    context = await requireCapability('cash.write');
  } catch (error) {
    return authErrorToResult(error);
  }

  const { session, db } = context;
  const result = await removeOutgoing(db, id, session.userId);
  if (!result.ok) return result;

  revalidatePath('/money/outgoings');
  revalidatePath('/money/timeline');
  return { ok: true };
}
