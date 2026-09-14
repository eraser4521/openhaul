import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { vinDecodes } from '@/lib/db/schema';
import { requireSession } from '@/lib/auth/guard';
import { consumeRateLimit } from '@/lib/security/rate-limit';
import {
  classifyVin,
  decodeModelYear,
  decodeVinDetailed,
  mapVpicResult,
  normalizeVin,
  type DecodedVehicle,
} from '@/lib/vin';

/**
 * Cached proxy for the NHTSA vPIC decoder.
 *
 * Proxied rather than called from the browser for three reasons: results can
 * be cached across the whole instance, NHTSA throttles bursts and a fleet of
 * drivers would look like one, and the upstream host stays fixed so the
 * endpoint cannot be turned into a general-purpose fetcher.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  let session;
  try {
    ({ session } = await requireSession());
  } catch {
    return NextResponse.json({ error: 'Sign in to decode a VIN.' }, { status: 401 });
  }

  const requested = request.nextUrl.searchParams.get('vin') ?? '';
  const vin = normalizeVin(requested);
  const classification = classifyVin(vin);

  if (classification.kind === 'invalid') {
    return NextResponse.json({ error: classification.reason }, { status: 400 });
  }

  if (classification.kind === 'legacy') {
    return NextResponse.json({
      vin,
      legacy: true,
      message: 'Pre-1981 VIN. There is no national decoder for these — enter the details by hand.',
    });
  }

  const limit = await consumeRateLimit('vinDecode', session.userId);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many lookups. Slow down for a moment.' },
      { status: 429, headers: { 'retry-after': String(Math.ceil(limit.retryAfterMs / 1000)) } },
    );
  }

  // A VIN's manufacturing specification never changes, so cached rows never
  // expire and there is no TTL to tune.
  const [cached] = await db.select().from(vinDecodes).where(eq(vinDecodes.vin, vin)).limit(1);
  if (cached) {
    return NextResponse.json({
      vin,
      cached: true,
      vehicle: mapVpicResult(vin, cached.payload as Record<string, string>),
    });
  }

  // Supplying the model year resolves the 30-year cycle ambiguity upstream and
  // measurably improves the decode.
  const localYear = decodeModelYear(vin).year;

  let vehicle: DecodedVehicle;
  let rawRow: Record<string, string>;
  try {
    const decoded = await decodeVinDetailed(vin, {
      modelYear: localYear ?? undefined,
      timeoutMs: 8000,
    });
    vehicle = decoded.vehicle;
    rawRow = decoded.raw;
  } catch {
    // NHTSA has had extended outages. Degrade to what can be derived locally
    // rather than blocking the driver.
    return NextResponse.json(
      {
        vin,
        offline: true,
        vehicle: { vin, modelYear: localYear },
        message:
          'The NHTSA lookup is unreachable. The year is decoded from the VIN itself; fill in the rest by hand.',
      },
      { status: 200 },
    );
  }

  await db
    .insert(vinDecodes)
    .values({
      // The raw vPIC row, not the mapped subset, so a later field addition
      // does not require re-fetching every VIN ever decoded.
      vin,
      payload: rawRow,
      errorCode: vehicle.errorCodes.map((e) => e.code).join(','),
    })
    .onConflictDoNothing();

  return NextResponse.json({ vin, cached: false, vehicle });
}
