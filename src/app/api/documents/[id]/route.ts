import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { documents as documentsTable } from '@/lib/db/schema';
import { requireCapability } from '@/lib/auth/guard';
import { appendAudit, AUDIT } from '@/lib/audit/chain';
import { blobStore } from '@/lib/storage/blob-store';

/**
 * Serves a stored document.
 *
 * The bytes are checked against the hash recorded when the document was
 * frozen. A mismatch means the stored file has changed since it was signed,
 * which is exactly the case this application exists to detect — so it refuses
 * to serve it rather than handing over a document whose integrity is unknown.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  let auth;
  try {
    auth = await requireCapability('load.read');
  } catch {
    return new NextResponse(null, { status: 401 });
  }

  const document = await auth.db.selectOne('documents', eq(documentsTable.id, id));
  if (!document) return new NextResponse(null, { status: 404 });

  const bytes = await blobStore().get(document.storageKey);
  if (!bytes) return new NextResponse(null, { status: 404 });

  const { createHash } = await import('node:crypto');
  const actual = createHash('sha256').update(bytes).digest('hex');

  if (actual !== document.sha256) {
    await appendAudit({
      orgId: auth.session.orgId,
      actorId: auth.session.userId,
      actorRole: auth.session.role,
      action: AUDIT.documentIntegrityFailed,
      subject: `document:${id}`,
      outcome: 'failure',
      detail: { expected: document.sha256, actual },
    });

    return NextResponse.json(
      {
        error:
          'The stored file no longer matches the hash recorded when this document was signed. ' +
          'It has not been served. Treat the copy on disk as suspect.',
      },
      { status: 409 },
    );
  }

  const download = new URL(request.url).searchParams.get('download') === '1';

  /*
   * Revalidated on every view rather than cached outright.
   *
   * The bytes behind an id never change by design, which argues for a long
   * immutable cache — but the check above is the only thing that notices when
   * they change anyway, and a cached copy skips it. `no-cache` still lets the
   * browser keep the file and answer with a conditional request; it just has
   * to ask, and asking runs the hash check again. A 360 KB document is worth
   * one round trip.
   */
  const etag = `"${document.sha256}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: { etag, 'cache-control': 'private, no-cache' },
    });
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'content-type': document.contentType,
      'content-length': String(bytes.byteLength),
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${document.title.replace(/[^\w.-]/g, '_')}.pdf"`,
      etag,
      'cache-control': 'private, no-cache',
      'x-content-type-options': 'nosniff',
      'x-document-sha256': document.sha256,
    },
  });
}
