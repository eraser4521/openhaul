import 'server-only';
import sharp from 'sharp';
import exifReader from 'exif-reader';

/**
 * Inspection photo ingest.
 *
 * Resolves a genuine conflict. Stripping EXIF is correct for privacy and for
 * not handing an attacker a metadata channel — but the capture timestamp and
 * GPS in an inspection photo are precisely what makes it evidence in a cargo
 * claim. So: keep the original bytes immutable and never serve them, lift the
 * metadata into database columns, and serve a re-encoded derivative with the
 * metadata gone.
 */

export class ImageRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageRejected';
  }
}

/** 12 MB before compression. A phone photo that large is already unusual. */
const MAX_BYTES = 12 * 1024 * 1024;

/**
 * Long edge of the served derivative.
 *
 * Large enough that a claims adjuster can see a six-inch scratch, small enough
 * that a twelve-photo inspection is a few megabytes rather than sixty — which
 * is the difference between an upload that finishes over LTE and one that does
 * not.
 */
const DERIVATIVE_LONG_EDGE = 1600;
const THUMBNAIL_LONG_EDGE = 320;

interface Signature {
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  matches: (bytes: Buffer) => boolean;
}

/**
 * Format detection by magic bytes.
 *
 * The Content-Type header is supplied by the client and therefore worthless as
 * a security control. SVG is absent deliberately: it can carry script, and
 * there is no use for it here.
 */
const SIGNATURES: Signature[] = [
  {
    contentType: 'image/jpeg',
    matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    contentType: 'image/png',
    matches: (b) =>
      b.length > 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    contentType: 'image/webp',
    matches: (b) =>
      b.length > 12 &&
      b.subarray(0, 4).toString('ascii') === 'RIFF' &&
      b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

export function sniffImageType(bytes: Buffer): Signature['contentType'] {
  const hit = SIGNATURES.find((signature) => signature.matches(bytes));
  if (!hit) {
    throw new ImageRejected('Only JPEG, PNG and WebP images are accepted.');
  }
  return hit.contentType;
}

export interface ExtractedExif {
  capturedAt: Date | null;
  latitude: string | null;
  longitude: string | null;
  device: string | null;
}

/**
 * Converts EXIF degrees/minutes/seconds into a signed decimal string.
 *
 * Stored as a string rather than a float: these are evidence, and a decimal
 * string round-trips exactly, where a float does not.
 */
function toDecimal(
  dms: number[] | undefined,
  ref: string | undefined,
): string | null {
  if (!dms || dms.length < 3) return null;
  const [degrees = 0, minutes = 0, seconds = 0] = dms;
  let decimal = degrees + minutes / 60 + seconds / 3600;
  if (ref === 'S' || ref === 'W') decimal = -decimal;
  if (!Number.isFinite(decimal)) return null;
  return decimal.toFixed(7);
}

export function extractExif(exifBuffer: Buffer | undefined): ExtractedExif {
  const empty: ExtractedExif = {
    capturedAt: null,
    latitude: null,
    longitude: null,
    device: null,
  };
  if (!exifBuffer) return empty;

  try {
    const parsed = exifReader(exifBuffer);

    const captured =
      parsed.Photo?.DateTimeOriginal ?? parsed.Photo?.DateTimeDigitized ?? parsed.Image?.DateTime;

    const gps = parsed.GPSInfo;
    const make = parsed.Image?.Make?.toString().trim();
    const model = parsed.Image?.Model?.toString().trim();

    return {
      capturedAt: captured instanceof Date && !Number.isNaN(captured.getTime()) ? captured : null,
      latitude: toDecimal(gps?.GPSLatitude as number[] | undefined, gps?.GPSLatitudeRef as string),
      longitude: toDecimal(
        gps?.GPSLongitude as number[] | undefined,
        gps?.GPSLongitudeRef as string,
      ),
      device: [make, model].filter(Boolean).join(' ') || null,
    };
  } catch {
    // Malformed EXIF is common and is not a reason to reject a photo.
    return empty;
  }
}

export interface ProcessedImage {
  /** Exactly what was uploaded. Hashed, stored, never served. */
  original: Buffer;
  originalContentType: string;
  /** Re-encoded and metadata-free. This is what gets served. */
  derivative: Buffer;
  thumbnail: Buffer;
  width: number;
  height: number;
  exif: ExtractedExif;
}

export async function processInspectionPhoto(bytes: Buffer): Promise<ProcessedImage> {
  if (bytes.byteLength === 0) throw new ImageRejected('The file is empty.');
  if (bytes.byteLength > MAX_BYTES) {
    throw new ImageRejected('That image is too large. Photos are compressed on the device first.');
  }

  const originalContentType = sniffImageType(bytes);

  let metadata;
  try {
    metadata = await sharp(bytes).metadata();
  } catch {
    throw new ImageRejected('That file is not a readable image.');
  }

  // Guards against a decompression bomb: a small file that expands to an
  // enormous bitmap in memory.
  const pixels = (metadata.width ?? 0) * (metadata.height ?? 0);
  if (pixels > 80_000_000) {
    throw new ImageRejected('That image has an implausible resolution.');
  }

  const exif = extractExif(metadata.exif);

  /*
   * Re-encoding is a security control as much as a size one: it discards
   * anything hidden in the container, including a polyglot payload or script
   * smuggled in a metadata segment.
   *
   * `rotate()` with no argument applies the EXIF orientation and then drops
   * it, so the served image is upright without relying on a viewer to honour
   * a tag that is about to be stripped.
   */
  const pipeline = sharp(bytes).rotate();

  const derivative = await pipeline
    .clone()
    .resize(DERIVATIVE_LONG_EDGE, DERIVATIVE_LONG_EDGE, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();

  const thumbnail = await pipeline
    .clone()
    .resize(THUMBNAIL_LONG_EDGE, THUMBNAIL_LONG_EDGE, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 70, mozjpeg: true })
    .toBuffer();

  const derivativeMeta = await sharp(derivative).metadata();

  return {
    original: bytes,
    originalContentType,
    derivative,
    thumbnail,
    width: derivativeMeta.width ?? 0,
    height: derivativeMeta.height ?? 0,
    exif,
  };
}

/**
 * Long edge of a stored logo.
 *
 * A logo prints at most 168 points wide, which is 700 pixels at 300 dpi — the
 * resolution a shipper's office laser printer actually uses. Anything beyond
 * that is bytes embedded in every PDF the carrier ever sends for no visible
 * difference on paper.
 */
const LOGO_LONG_EDGE = 720;

/** 4 MB. A logo larger than this is a photograph somebody has mistaken for one. */
const LOGO_MAX_BYTES = 4 * 1024 * 1024;

export interface ProcessedLogo {
  /** Always PNG. */
  bytes: Buffer;
  width: number;
  height: number;
}

/**
 * Normalises an uploaded logo.
 *
 * Always converted to PNG, for two reasons that happen to agree. The PDF
 * writer embeds PNG and JPEG and nothing else, so a WebP upload would
 * otherwise be rejected at render time rather than at upload time, which is
 * far too late to tell someone. And a logo with a transparent ground has to
 * stay PNG to keep it — re-encoded to JPEG it acquires a black rectangle,
 * which is exactly what the carrier will notice on the first bill of lading
 * they print and not before.
 *
 * Re-encoding is also the same security control it is for photos: whatever was
 * hiding in the container does not survive a decode and re-encode.
 */
export async function processLogo(bytes: Buffer): Promise<ProcessedLogo> {
  if (bytes.byteLength === 0) throw new ImageRejected('The file is empty.');
  if (bytes.byteLength > LOGO_MAX_BYTES) {
    throw new ImageRejected('That image is too large for a logo. Keep it under 4 MB.');
  }

  sniffImageType(bytes);

  let metadata;
  try {
    metadata = await sharp(bytes).metadata();
  } catch {
    throw new ImageRejected('That file is not a readable image.');
  }

  const pixels = (metadata.width ?? 0) * (metadata.height ?? 0);
  if (pixels === 0) throw new ImageRejected('That image has no dimensions.');
  if (pixels > 80_000_000) throw new ImageRejected('That image has an implausible resolution.');

  const output = await sharp(bytes)
    .rotate()
    .resize(LOGO_LONG_EDGE, LOGO_LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();

  const final = await sharp(output).metadata();

  return { bytes: output, width: final.width ?? 0, height: final.height ?? 0 };
}

/**
 * Great-circle distance in metres.
 *
 * Used to decide whether a photo was taken at the stop. Carrier scorecards on
 * the paid platforms grade exactly this, and it is the strongest signal
 * available that an inspection happened where it claims to have happened.
 */
export function distanceMetres(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;

  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** One mile, the radius the industry uses for on-site photo verification. */
export const GEOFENCE_RADIUS_METRES = 1609;
