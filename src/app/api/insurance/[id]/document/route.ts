import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { insuranceCertificates as certificatesTable } from '@/lib/db/schema';
import { AuthError, requireCapability } from '@/lib/auth/guard';
import { appendAudit, AUDIT } from '@/lib/audit/chain';
import { consumeRateLimit } from '@/lib/security/rate-limit';
import { storeDocument } from '@/lib/documents/store';
import { attachDocument } from '@/lib/insurance/certificates';

/**
 * The certificate itself, as the insurer issued it.
 *
 * The typed figures are a claim about a document; this is the document. A
 * broker asking for proof wants the PDF, and a carrier defending a claim wants
 * to show what they were given rather than what somebody keyed in.
 *
 * A route rather than a server action because of the 1 MB body limit actions
 * run under — certificates arrive as scanned PDFs and routinely exceed it.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 10 MB. A scanned certificate larger than this is a scanner misconfigured. */
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Accepts a PDF and nothing else.
 *
 * Checked by magic bytes, because the content type is supplied by whoever is
 * uploading and is therefore not evidence of anything. Certificates arrive
 * from insurers as PDFs; narrowing to one format keeps the set of things that
 * can be stored and served back small.
 */
function looksLikePdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 5).toString('ascii') === '%PDF-';
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  let auth;
  try {
    auth = await requireCapability('customer.write');
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

  // The scoped client cannot reach another organisation's row, so an id from
  // elsewhere simply does not resolve.
  const certificate = await db.selectOne(
    'insuranceCertificates',
    eq(certificatesTable.id, id),
  );
  if (!certificate) {
    return NextResponse.json({ error: 'No such certificate.' }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Malformed upload.' }, { status: 400 });
  }

  const file = form.get('certificate');
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: 'No file was sent.' }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  if (bytes.byteLength === 0) {
    return NextResponse.json({ error: 'That file is empty.' }, { status: 400 });
  }
  if (bytes.byteLength > MAX_BYTES) {
    return NextResponse.json({ error: 'That file is too large. Keep it under 10 MB.' }, { status: 413 });
  }
  if (!looksLikePdf(bytes)) {
    return NextResponse.json(
      { error: 'Certificates are stored as PDFs. Save or print the certificate to PDF first.' },
      { status: 415 },
    );
  }

  const stored = await storeDocument({
    scoped: db,
    kind: 'insurance_certificate',
    loadId: null,
    subject: `insurance:${certificate.id}`,
    title: `${certificate.insurerName} ${certificate.policyNumber}`,
    bytes,
  });

  if ('error' in stored) {
    return NextResponse.json({ error: stored.error }, { status: 500 });
  }

  await attachDocument(db, certificate.id, stored.documentId);

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.insuranceRecorded,
    subject: `insurance:${certificate.id}`,
    detail: {
      attached: true,
      documentId: stored.documentId,
      sha256: stored.sha256,
      byteSize: stored.byteSize,
    },
  });

  return NextResponse.json({ ok: true, documentId: stored.documentId, sha256: stored.sha256 });
}
