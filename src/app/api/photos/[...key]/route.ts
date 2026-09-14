import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { inspectionPhotos as photosTable } from '@/lib/db/schema';
import { requireCapability } from '@/lib/auth/guard';
import { blobStore } from '@/lib/storage/blob-store';

/**
 * Serves an inspection photo.
 *
 * Storage keys are content hashes, so they are unguessable — but that is
 * obscurity, not access control. Every request is checked against the scoped
 * client, so a key leaked out of one organisation is still unreadable by
 * another.
 *
 * Only the stripped, re-encoded derivative is reachable here. The original
 * bytes are stored under a different namespace with no route at all.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  context: { params: Promise<{ key: string[] }> },
) {
  const { key } = await context.params;
  const storageKey = key.join('/');

  let auth;
  try {
    auth = await requireCapability('inspection.read');
  } catch {
    return new NextResponse(null, { status: 401 });
  }

  // Deliberately not a filesystem lookup by key: the row is the authority on
  // who may read these bytes.
  const photo = await auth.db.selectOne('inspectionPhotos', eq(photosTable.storageKey, storageKey));
  if (!photo) return new NextResponse(null, { status: 404 });

  const bytes = await blobStore().get(photo.storageKey);
  if (!bytes) return new NextResponse(null, { status: 404 });

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'content-type': photo.contentType,
      'content-length': String(bytes.byteLength),
      // Content-addressed, so the bytes behind a key never change.
      'cache-control': 'private, max-age=31536000, immutable',
      // Belt and braces against a stored-XSS attempt surviving re-encoding.
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
    },
  });
}
