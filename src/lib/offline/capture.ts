'use client';

import { uuidv7 } from 'uuidv7';
import { localDb, type LocalPhoto } from './db';

/**
 * On-device photo capture and compression.
 *
 * Compression happens before anything is queued, not at upload time. A raw
 * phone photo is 3–6 MB, so twelve of them is around sixty megabytes — a
 * forty-minute upload over a weak LTE connection, if it finishes at all. At
 * 1600px and quality 0.8 the same set is a few megabytes and uploads in a
 * couple of minutes.
 */

const LONG_EDGE = 1600;
const QUALITY = 0.8;
const THUMBNAIL_LONG_EDGE = 320;

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Downscales in halving steps rather than one jump.
 *
 * A single large `drawImage` reduction aliases badly, and aliasing on a photo
 * of a six-inch scratch destroys exactly the detail the photo exists to prove.
 * Halving repeatedly averages neighbouring pixels at each step, which is close
 * to a proper resample for a fraction of the cost of a library.
 */
function drawDownscaled(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  targetLongEdge: number,
): HTMLCanvasElement {
  const scale = Math.min(1, targetLongEdge / Math.max(sourceWidth, sourceHeight));

  let currentWidth = sourceWidth;
  let currentHeight = sourceHeight;

  let canvas = document.createElement('canvas');
  canvas.width = currentWidth;
  canvas.height = currentHeight;
  canvas.getContext('2d')?.drawImage(source, 0, 0);

  const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale));

  while (currentWidth > targetWidth * 2) {
    const nextWidth = Math.max(targetWidth, Math.floor(currentWidth / 2));
    const nextHeight = Math.max(targetHeight, Math.floor(currentHeight / 2));

    const next = document.createElement('canvas');
    next.width = nextWidth;
    next.height = nextHeight;
    const context = next.getContext('2d');
    if (!context) break;
    context.imageSmoothingQuality = 'high';
    context.drawImage(canvas, 0, 0, nextWidth, nextHeight);

    canvas = next;
    currentWidth = nextWidth;
    currentHeight = nextHeight;
  }

  if (currentWidth !== targetWidth || currentHeight !== targetHeight) {
    const final = document.createElement('canvas');
    final.width = targetWidth;
    final.height = targetHeight;
    const context = final.getContext('2d');
    if (context) {
      context.imageSmoothingQuality = 'high';
      context.drawImage(canvas, 0, 0, targetWidth, targetHeight);
      canvas = final;
    }
  }

  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('could not encode the image'))),
      'image/jpeg',
      quality,
    );
  });
}

export interface CaptureInput {
  inspectionId: string;
  file: Blob;
  slot?: string | null;
  damageId?: string | null;
  position?: { latitude: string; longitude: string } | null;
  /** Injectable so capture ordering is testable. */
  now?: number;
}

/**
 * Compresses a photo and writes it to the local store.
 *
 * Returns the stored row. Nothing here touches the network: the photo is safe
 * on the device the moment this resolves.
 */
export async function capturePhoto(input: CaptureInput): Promise<LocalPhoto> {
  const bitmap = await createImageBitmap(input.file);

  try {
    const full = drawDownscaled(bitmap, bitmap.width, bitmap.height, LONG_EDGE);
    const small = drawDownscaled(bitmap, bitmap.width, bitmap.height, THUMBNAIL_LONG_EDGE);

    const [blob, thumbnail] = await Promise.all([toBlob(full, QUALITY), toBlob(small, 0.7)]);

    const row: LocalPhoto = {
      id: uuidv7(),
      inspectionId: input.inspectionId,
      slot: input.slot ?? null,
      damageId: input.damageId ?? null,
      blob,
      thumbnail,
      sha256: await sha256Hex(blob),
      byteSize: blob.size,
      width: full.width,
      height: full.height,
      capturedAt: input.now ?? Date.now(),
      latitude: input.position?.latitude ?? null,
      longitude: input.position?.longitude ?? null,
      uploadState: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
    };

    await localDb.photos.add(row);
    return row;
  } finally {
    bitmap.close();
  }
}

/**
 * Reads the device position for stamping an inspection.
 *
 * Resolves to null rather than rejecting: a missing fix weakens the evidence
 * but must never stop a driver completing the work.
 */
export function currentPosition(
  timeoutMs = 8000,
): Promise<{ latitude: string; longitude: string; accuracyM: number } | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          // Seven decimal places is roughly a centimetre, well beyond what any
          // handset delivers, so nothing is lost by fixing the precision.
          latitude: position.coords.latitude.toFixed(7),
          longitude: position.coords.longitude.toFixed(7),
          accuracyM: Math.round(position.coords.accuracy),
        }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}
