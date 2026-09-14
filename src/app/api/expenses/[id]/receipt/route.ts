import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { expenses as expensesTable } from '@/lib/db/schema';
import { requireCapability } from '@/lib/auth/guard';
import { can } from '@/lib/auth/capabilities';
import { blobStore } from '@/lib/storage/blob-store';
import { driverForUser } from '@/lib/expenses/record';

/**
 * Serves a receipt photo.
 *
 * Scoped twice. The scoped client confines the lookup to one organisation; the
 * driver check narrows it again, because "any driver in this company can read
 * any other driver's receipts" is not what a fuel receipt with a location and
 * a card's last four digits should mean. Whoever approves expenses sees them
 * all, which is the point of approving them.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  let auth;
  try {
    auth = await requireCapability('expense.read');
  } catch {
    return new NextResponse(null, { status: 401 });
  }

  const { session, db } = auth;

  const expense = await db.selectOne('expenses', eq(expensesTable.id, id));
  if (!expense?.receiptStorageKey) return new NextResponse(null, { status: 404 });

  if (!can(session.role, 'expense.approve')) {
    const driver = await driverForUser(db, session.userId);
    // 404 rather than 403: whether somebody else's expense exists is itself
    // something this caller has no business learning.
    if (!driver || expense.driverId !== driver.id) {
      return new NextResponse(null, { status: 404 });
    }
  }

  const bytes = await blobStore().get(expense.receiptStorageKey);
  if (!bytes) return new NextResponse(null, { status: 404 });

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'content-type': 'image/jpeg',
      'content-length': String(bytes.byteLength),
      // Content-addressed, so the bytes behind a key never change.
      'cache-control': 'private, max-age=31536000, immutable',
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
    },
  });
}
