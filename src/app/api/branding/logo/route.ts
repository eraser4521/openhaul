import { NextResponse } from 'next/server';
import { AuthError, requireCapability } from '@/lib/auth/guard';
import { appendAudit, AUDIT } from '@/lib/audit/chain';
import { consumeRateLimit } from '@/lib/security/rate-limit';
import { blobStore } from '@/lib/storage/blob-store';
import { ImageRejected, processLogo } from '@/lib/images/process';
import { clearLogo, resolveTemplate, setLogo } from '@/lib/branding/template';

/**
 * The carrier's logo.
 *
 * A route rather than a server action because the upload is a file: server
 * actions run under a 1 MB body limit by default, and a logo exported from a
 * design tool is routinely larger than that. Failing at 1.2 MB with a framework
 * error is not a thing to explain to somebody trying to put their own name on
 * their own paperwork.
 *
 * There is exactly one logo per organisation, so the URL carries no key. That
 * is not a shortcut — it means there is no key to leak and no key to guess, and
 * every request resolves through the scoped client to the caller's own
 * organisation and nowhere else.
 */
export const dynamic = 'force-dynamic';
/** Node runtime: sharp and the filesystem store are both unavailable on edge. */
export const runtime = 'nodejs';

export async function GET() {
  let auth;
  try {
    // Anyone who can see a load can see the logo — it is printed on every
    // document they already handle.
    auth = await requireCapability('load.read');
  } catch {
    return new NextResponse(null, { status: 401 });
  }

  const template = await resolveTemplate(auth.db, 'all');
  if (!template.logoStorageKey || !template.logoSha256) {
    return new NextResponse(null, { status: 404 });
  }

  const bytes = await blobStore().get(template.logoStorageKey);
  if (!bytes) return new NextResponse(null, { status: 404 });

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'content-type': 'image/png',
      'content-length': String(bytes.byteLength),
      etag: `"${template.logoSha256}"`,
      // The URL is stable while the bytes behind it are not, so the browser
      // has to ask. A carrier who replaces their logo and still sees the old
      // one will assume the upload failed.
      'cache-control': 'private, no-cache',
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function POST(request: Request) {
  let auth;
  try {
    auth = await requireCapability('settings.write');
  } catch (error) {
    const status = error instanceof AuthError && error.kind === 'forbidden' ? 403 : 401;
    return NextResponse.json({ error: 'Only an owner can change the letterhead.' }, { status });
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

  const file = form.get('logo');
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: 'No file was sent.' }, { status: 400 });
  }

  let processed;
  try {
    processed = await processLogo(Buffer.from(await file.arrayBuffer()));
  } catch (error) {
    if (error instanceof ImageRejected) {
      return NextResponse.json({ error: error.message }, { status: 415 });
    }
    return NextResponse.json({ error: 'That image could not be read.' }, { status: 400 });
  }

  const stored = await blobStore().put(processed.bytes, 'image/png', 'branding');

  await setLogo(db, {
    storageKey: stored.key,
    sha256: stored.sha256,
    width: processed.width,
    height: processed.height,
  });

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.templateChanged,
    subject: `organization:${session.orgId}`,
    detail: { field: 'logo', sha256: stored.sha256, width: processed.width, height: processed.height },
  });

  return NextResponse.json({
    ok: true,
    width: processed.width,
    height: processed.height,
    sha256: stored.sha256,
  });
}

export async function DELETE() {
  let auth;
  try {
    auth = await requireCapability('settings.write');
  } catch (error) {
    const status = error instanceof AuthError && error.kind === 'forbidden' ? 403 : 401;
    return NextResponse.json({ error: 'Only an owner can change the letterhead.' }, { status });
  }

  await clearLogo(auth.db);

  await appendAudit({
    orgId: auth.session.orgId,
    actorId: auth.session.userId,
    actorRole: auth.session.role,
    action: AUDIT.templateChanged,
    subject: `organization:${auth.session.orgId}`,
    detail: { field: 'logo', removed: true },
  });

  return NextResponse.json({ ok: true });
}
