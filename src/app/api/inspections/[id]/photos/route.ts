import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import {
  inspections as inspectionsTable,
  inspectionPhotos as photosTable,
  stops as stopsTable,
  venues as venuesTable,
  FROZEN_STATUSES,
} from '@/lib/db/schema';
import { AuthError, requireCapability } from '@/lib/auth/guard';
import { appendAudit, AUDIT } from '@/lib/audit/chain';
import { consumeRateLimit } from '@/lib/security/rate-limit';
import { blobStore } from '@/lib/storage/blob-store';
import {
  distanceMetres,
  GEOFENCE_RADIUS_METRES,
  ImageRejected,
  processInspectionPhoto,
} from '@/lib/images/process';

/**
 * Receives one inspection photo.
 *
 * Photos arrive already compressed on the device — roughly 300 KB rather than
 * the 3–6 MB a phone produces — so a plain request body is appropriate here
 * and a self-hoster needs no object store. The nginx `client_max_body_size`
 * note in the self-hosting guide exists because its 1 MB default would reject
 * these.
 */

export const dynamic = 'force-dynamic';
/** Node runtime: sharp and the filesystem store are both unavailable on edge. */
export const runtime = 'nodejs';

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: inspectionId } = await context.params;

  let auth;
  try {
    auth = await requireCapability('inspection.write');
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

  // The scoped client cannot reach another organisation's rows, so an id
  // guessed from elsewhere simply does not resolve.
  const inspection = await db.selectOne('inspections', eq(inspectionsTable.id, inspectionId));
  if (!inspection) {
    return NextResponse.json({ error: 'No such inspection.' }, { status: 404 });
  }

  // A signed report is evidence. Adding a photo afterwards would change what
  // was attested to, so the remedy is an amendment, not an append.
  if (inspection.finalizedAt || FROZEN_STATUSES.includes(inspection.status)) {
    return NextResponse.json(
      {
        error: 'This inspection is already signed and cannot be changed.',
        remedy: 'create-amendment',
        finalizedAt: inspection.finalizedAt,
      },
      { status: 409 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Malformed upload.' }, { status: 400 });
  }

  const file = form.get('photo');
  const photoId = String(form.get('photoId') ?? '');

  if (!(file instanceof Blob) || photoId.length === 0) {
    return NextResponse.json({ error: 'Missing photo or photo id.' }, { status: 400 });
  }

  /*
   * Idempotency. The client uses the photo id as its key, so a retry after a
   * lost response resolves to the row that already exists rather than
   * creating a second one.
   */
  const existing = await db.selectOne('inspectionPhotos', eq(photosTable.id, photoId));
  if (existing) {
    return NextResponse.json({ photo: existing, deduplicated: true });
  }

  let processed;
  try {
    processed = await processInspectionPhoto(Buffer.from(await file.arrayBuffer()));
  } catch (error) {
    if (error instanceof ImageRejected) {
      return NextResponse.json({ error: error.message }, { status: 415 });
    }
    return NextResponse.json({ error: 'That image could not be read.' }, { status: 400 });
  }

  const store = blobStore();

  // The original is stored and hashed but never served. The derivative is what
  // clients receive: re-encoded, resized, and stripped of metadata.
  const [original, derivative, thumbnail] = await Promise.all([
    store.put(processed.original, processed.originalContentType, 'originals'),
    store.put(processed.derivative, 'image/jpeg', 'photos'),
    store.put(processed.thumbnail, 'image/jpeg', 'thumbs'),
  ]);

  const capturedLatitude = String(form.get('latitude') ?? '') || null;
  const capturedLongitude = String(form.get('longitude') ?? '') || null;

  const photo = await db.insert('inspectionPhotos', {
    id: photoId,
    inspectionId,
    slot: (String(form.get('slot') ?? '') || null) as string | null,
    damageId: (String(form.get('damageId') ?? '') || null) as string | null,

    storageKey: derivative.key,
    sha256: derivative.sha256,
    byteSize: derivative.byteSize,
    contentType: 'image/jpeg',
    width: processed.width,
    height: processed.height,

    // Lifted out of the original before it was re-encoded. This metadata is
    // what makes the photo evidence rather than decoration.
    exifCapturedAt: processed.exif.capturedAt,
    exifLatitude: processed.exif.latitude,
    exifLongitude: processed.exif.longitude,
    exifDevice: processed.exif.device,

    capturedLatitude,
    capturedLongitude,
    withinGeofence: await isWithinGeofence(db, inspection.loadId, inspection.stage, {
      latitude: capturedLatitude ?? processed.exif.latitude,
      longitude: capturedLongitude ?? processed.exif.longitude,
    }),

    uploadedAt: new Date(),
  });

  await appendAudit({
    orgId: session.orgId,
    actorId: session.userId,
    actorRole: session.role,
    action: AUDIT.photoAdded,
    subject: `inspection:${inspectionId}`,
    detail: {
      photoId,
      slot: form.get('slot') ?? null,
      sha256: derivative.sha256,
      originalSha256: original.sha256,
      thumbnailKey: thumbnail.key,
    },
  });

  return NextResponse.json({ photo: photo[0] ?? null, deduplicated: false });
}

/**
 * Was the photo taken at the stop?
 *
 * Not a gate — a driver with no fix must still be able to work — but the
 * strongest available signal that an inspection happened where it claims to,
 * and precisely what carrier scorecards on the paid platforms grade.
 */
async function isWithinGeofence(
  db: Awaited<ReturnType<typeof requireCapability>>['db'],
  loadId: string,
  stage: 'pickup' | 'delivery',
  position: { latitude: string | null; longitude: string | null },
): Promise<boolean | null> {
  if (!position.latitude || !position.longitude) return null;

  const [stop] = await db.select(
    'stops',
    and(eq(stopsTable.loadId, loadId), eq(stopsTable.kind, stage)),
  );
  if (!stop?.venueId) return null;

  const venue = await db.selectOne('venues', eq(venuesTable.id, stop.venueId));
  if (venue?.latitude == null || venue.longitude == null) return null;

  const metres = distanceMetres(
    Number(position.latitude),
    Number(position.longitude),
    Number(venue.latitude),
    Number(venue.longitude),
  );

  return Number.isFinite(metres) ? metres <= GEOFENCE_RADIUS_METRES : null;
}
