import { NextResponse } from 'next/server';
import { EXPENSE_CATEGORIES, type ExpenseCategory } from '@/lib/db/schema';
import { AuthError, requireCapability } from '@/lib/auth/guard';
import { consumeRateLimit } from '@/lib/security/rate-limit';
import { blobStore } from '@/lib/storage/blob-store';
import { ImageRejected, processReceipt } from '@/lib/images/process';
import { attachReceipt, driverForUser, recordExpense } from '@/lib/expenses/record';

/**
 * An expense captured in the cab.
 *
 * A route rather than a server action because the receipt is a photograph and
 * because the offline outbox posts it: the queue that carries inspection
 * photos through a canyon is the same machinery, and it speaks in `fetch` and
 * FormData, not in server actions.
 *
 * The expense id is minted on the device before anything is queued, and is the
 * idempotency key. A response lost in a tunnel must not turn one tank of fuel
 * into two reimbursements.
 */
export const dynamic = 'force-dynamic';
/** Node runtime: sharp and the filesystem store are both unavailable on edge. */
export const runtime = 'nodejs';

function parseCategory(value: string): ExpenseCategory | null {
  return (EXPENSE_CATEGORIES as readonly string[]).includes(value)
    ? (value as ExpenseCategory)
    : null;
}

/** Cents from a decimal string, without floating point in the middle. */
function parseAmount(value: string): number | null {
  const text = value.trim();
  if (!/^[0-9]+(\.[0-9]{1,2})?$/.test(text)) return null;

  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

export async function POST(request: Request) {
  let auth;
  try {
    auth = await requireCapability('expense.write');
  } catch (error) {
    const status = error instanceof AuthError && error.kind === 'forbidden' ? 403 : 401;
    return NextResponse.json({ error: 'Not permitted.' }, { status });
  }

  const { session, db } = auth;

  const limit = await consumeRateLimit('upload', session.userId);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many uploads. Slow down for a moment.' },
      { status: 429, headers: { 'retry-after': String(Math.ceil(limit.retryAfterMs / 1000)) } },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Malformed upload.' }, { status: 400 });
  }

  const category = parseCategory(String(form.get('category') ?? ''));
  if (!category) return NextResponse.json({ error: 'Unknown category.' }, { status: 400 });

  const amountCents = parseAmount(String(form.get('amount') ?? ''));
  if (amountCents === null) {
    return NextResponse.json({ error: 'That is not an amount.' }, { status: 400 });
  }

  const incurred = String(form.get('incurredAt') ?? '');
  const incurredAt = new Date(/^\d{4}-\d{2}-\d{2}$/.test(incurred) ? `${incurred}T12:00:00Z` : incurred);
  if (Number.isNaN(incurredAt.getTime())) {
    return NextResponse.json({ error: 'That is not a date.' }, { status: 400 });
  }

  /*
   * The expense is attributed to the driver who recorded it, resolved from the
   * session rather than taken from the request. A driver id in a body would be
   * a way to bill somebody else's expense to a colleague.
   */
  const driver = await driverForUser(db, session.userId);

  const result = await recordExpense(db, driver?.id ?? null, {
    id: String(form.get('expenseId') ?? '') || undefined,
    loadId: String(form.get('loadId') ?? '') || null,
    category,
    amountCents,
    incurredAt,
    vendor: String(form.get('vendor') ?? '').trim() || null,
    notes: String(form.get('notes') ?? '').trim() || null,
  });

  if (!result.ok || !result.expenseId) {
    return NextResponse.json({ error: result.error ?? 'That could not be saved.' }, { status: 400 });
  }

  // A retry that resolved to the existing row must not re-store the receipt or
  // append a second audit entry; the first attempt already did both.
  if (result.deduplicated) {
    return NextResponse.json({ ok: true, expenseId: result.expenseId, deduplicated: true });
  }

  const receipt = form.get('receipt');
  if (receipt instanceof Blob && receipt.size > 0) {
    let processed;
    try {
      processed = await processReceipt(Buffer.from(await receipt.arrayBuffer()));
    } catch (error) {
      if (error instanceof ImageRejected) {
        // The expense itself is saved. Losing the figure because the photo was
        // unreadable would be the worse outcome of the two.
        return NextResponse.json(
          { ok: true, expenseId: result.expenseId, receiptError: error.message },
          { status: 200 },
        );
      }
      return NextResponse.json(
        { ok: true, expenseId: result.expenseId, receiptError: 'That image could not be read.' },
        { status: 200 },
      );
    }

    const stored = await blobStore().put(processed.bytes, 'image/jpeg', 'receipts');
    await attachReceipt(db, result.expenseId, { storageKey: stored.key, sha256: stored.sha256 });
  }

  return NextResponse.json({ ok: true, expenseId: result.expenseId, deduplicated: false });
}
