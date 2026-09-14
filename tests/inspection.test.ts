import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  AIAG_DAMAGE_AREAS,
  AIAG_DAMAGE_TYPES,
  AIAG_SEVERITIES,
  composeDamageCode,
  describeDamageCode,
  INSPECTION_SEQUENCE,
  parseDamageCode,
  PHOTO_REQUIREMENTS,
  requiresHold,
} from '@/lib/aiag/codes';
import {
  checkCompleteness,
  computeContentHash,
  intentTextFor,
} from '@/lib/inspections/finalize';
import {
  distanceMetres,
  extractExif,
  GEOFENCE_RADIUS_METRES,
  ImageRejected,
  processInspectionPhoto,
  sniffImageType,
} from '@/lib/images/process';
import type { Damage, Inspection, InspectionPhoto } from '@/lib/db/schema';

/* -------------------------------------------------------------------------
 * AIAG damage coding
 * ---------------------------------------------------------------------- */

describe('AIAG damage codes', () => {
  it('composes the documented worked example', () => {
    // Left front door (10), scratched (12), four inches (severity 3).
    expect(composeDamageCode('10', '12', '3')).toBe('10123');
  });

  it('appends the optional grid digit', () => {
    expect(composeDamageCode('10', '12', '3', '5')).toBe('101235');
  });

  it('rejects an unknown component rather than inventing a code', () => {
    expect(composeDamageCode('99999', '12', '3')).toBeNull();
    expect(composeDamageCode('10', '77', '3')).toBeNull();
    expect(composeDamageCode('10', '12', '9')).toBeNull();
  });

  it('round-trips through parse', () => {
    const parsed = parseDamageCode('10123');
    expect(parsed?.area.label).toBe('Door — left front');
    expect(parsed?.type.label).toBe('Scratched (except glass)');
    expect(parsed?.severity.imperial).toBe('> 3" to 6"');
    expect(parsed?.grid).toBeNull();
  });

  it('parses the six-digit form and surfaces the grid zone', () => {
    expect(parseDamageCode('101235')?.grid).toBe('5');
  });

  it('rejects malformed codes', () => {
    for (const bad of ['', '1012', '1012345', 'ABCDE', '10-12-3']) {
      expect(parseDamageCode(bad)).toBeNull();
    }
  });

  it('flags severity 3 and above as requiring a hold', () => {
    expect(requiresHold('10121')).toBe(false);
    expect(requiresHold('10122')).toBe(false);
    expect(requiresHold('10123')).toBe(true);
    expect(requiresHold('10126')).toBe(true);
  });

  it('describes a code in a sentence a claims adjuster can read', () => {
    expect(describeDamageCode('10123')).toBe(
      'Door — left front — Scratched (except glass) (3 to 6 inches)',
    );
  });

  it('keeps every area and type code two digits', () => {
    for (const area of AIAG_DAMAGE_AREAS) expect(area.code).toMatch(/^\d{2}$/);
    for (const type of AIAG_DAMAGE_TYPES) expect(type.code).toMatch(/^\d{2}$/);
  });

  it('has unique codes within each table', () => {
    const areaCodes = AIAG_DAMAGE_AREAS.map((a) => a.code);
    const typeCodes = AIAG_DAMAGE_TYPES.map((t) => t.code);
    expect(new Set(areaCodes).size).toBe(areaCodes.length);
    expect(new Set(typeCodes).size).toBe(typeCodes.length);
  });

  it('covers the EV additions from the 2023 revision', () => {
    const labels = AIAG_DAMAGE_AREAS.map((a) => a.label.toLowerCase());
    expect(labels.some((l) => l.includes('high voltage'))).toBe(true);
    expect(labels.some((l) => l.includes('charging cable'))).toBe(true);
    expect(AIAG_DAMAGE_TYPES.some((t) => t.label.toLowerCase().includes('thermal'))).toBe(true);
  });

  it('exposes six severities running smallest to largest', () => {
    expect(AIAG_SEVERITIES).toHaveLength(6);
    expect(AIAG_SEVERITIES.map((s) => s.code)).toEqual(['1', '2', '3', '4', '5', '6']);
  });
});

/* -------------------------------------------------------------------------
 * Completeness
 * ---------------------------------------------------------------------- */

function inspectionFixture(overrides: Partial<Inspection> = {}): Inspection {
  return {
    id: 'insp-1',
    orgId: 'org-1',
    loadId: 'load-1',
    vehicleId: 'veh-1',
    stage: 'pickup',
    tier: 'advanced',
    status: 'in_progress',
    driverId: null,
    odometer: 84_120,
    fuelLevelEighths: 4,
    keysPresent: true,
    personalItemsPresent: false,
    personalItemsNote: null,
    limitationNote: null,
    latitude: '32.7554000',
    longitude: '-97.3308000',
    locationAccuracyM: 8,
    locationSource: 'gps',
    startedAt: new Date(1_700_000_000_000),
    completedAt: null,
    clientClaimedAt: null,
    finalizedAt: null,
    contentHash: null,
    amendsInspectionId: null,
    amendmentReason: null,
    createdOffline: false,
    version: 1,
    createdAt: new Date(1_700_000_000_000),
    updatedAt: new Date(1_700_000_000_000),
    ...overrides,
  } as Inspection;
}

function photoFixture(id: string, slot: string | null, damageId: string | null = null) {
  return { id, slot, damageId, sha256: `sha-${id}` } as InspectionPhoto;
}

function damageFixture(id: string): Damage {
  return {
    id,
    code: '10123',
    codeVersion: '2023',
    description: 'Six-inch scratch below the door handle',
    preExisting: true,
    nonTransportation: false,
  } as Damage;
}

describe('checkCompleteness', () => {
  const walkAround = INSPECTION_SEQUENCE.slice(0, 6).map((step, i) =>
    photoFixture(`p${i}`, step.slot),
  );

  it('passes a complete advanced inspection', () => {
    expect(checkCompleteness(inspectionFixture(), walkAround, [], true)).toEqual([]);
  });

  it('requires the tier photo minimum', () => {
    const problems = checkCompleteness(inspectionFixture(), walkAround.slice(0, 3), [], true);
    expect(problems.map((p) => p.kind)).toContain('missing-photos');
    expect(problems[0]?.message).toContain('6 photos are required');
  });

  it('lets the standard tier through with no photos at all', () => {
    // Fastest, and the weakest evidence — which is the tier's whole point.
    expect(PHOTO_REQUIREMENTS.standard.perStage).toBe(0);
    const problems = checkCompleteness(inspectionFixture({ tier: 'standard' }), [], [], false);
    expect(problems.map((p) => p.kind)).not.toContain('missing-photos');
    expect(problems.map((p) => p.kind)).not.toContain('missing-signature');
  });

  it('requires two photos per damage under the AIAG tier', () => {
    expect(PHOTO_REQUIREMENTS.aiag.perDamage).toBe(2);

    const damage = damageFixture('d1');
    const oneShot = [...walkAround, photoFixture('dp1', null, 'd1')];

    const problems = checkCompleteness(
      inspectionFixture({ tier: 'aiag' }),
      oneShot,
      [damage],
      true,
    );
    expect(problems.map((p) => p.kind)).toContain('missing-damage-photos');

    const twoShots = [...oneShot, photoFixture('dp2', null, 'd1')];
    const resolved = checkCompleteness(
      inspectionFixture({ tier: 'aiag' }),
      twoShots,
      [damage],
      true,
    );
    expect(resolved.map((p) => p.kind)).not.toContain('missing-damage-photos');
  });

  it('requires a signature where the tier demands one', () => {
    const problems = checkCompleteness(inspectionFixture(), walkAround, [], false);
    expect(problems.map((p) => p.kind)).toContain('missing-signature');
  });

  it('requires the odometer', () => {
    const problems = checkCompleteness(
      inspectionFixture({ odometer: null }),
      walkAround,
      [],
      true,
    );
    expect(problems.map((p) => p.kind)).toContain('missing-odometer');
  });

  it('does not count damage photos toward the walk-around minimum', () => {
    // Otherwise photographing one scratch six times would satisfy the
    // requirement without a single side of the vehicle being captured.
    const damageOnly = Array.from({ length: 8 }, (_, i) => photoFixture(`d${i}`, null, 'd1'));
    const problems = checkCompleteness(inspectionFixture(), damageOnly, [], true);
    expect(problems.map((p) => p.kind)).toContain('missing-photos');
  });
});

/* -------------------------------------------------------------------------
 * Content hashing
 * ---------------------------------------------------------------------- */

describe('computeContentHash', () => {
  const inspection = inspectionFixture();
  const photos = [photoFixture('a', 'front'), photoFixture('b', 'rear')];
  const damages = [damageFixture('d1')];

  it('is stable for the same input', () => {
    expect(computeContentHash(inspection, photos, damages)).toBe(
      computeContentHash(inspection, photos, damages),
    );
  });

  it('ignores the order photos were captured in', () => {
    expect(computeContentHash(inspection, [...photos].reverse(), damages)).toBe(
      computeContentHash(inspection, photos, damages),
    );
  });

  it('changes when a photo is added', () => {
    const extra = [...photos, photoFixture('c', 'left')];
    expect(computeContentHash(inspection, extra, damages)).not.toBe(
      computeContentHash(inspection, photos, damages),
    );
  });

  it('changes when a photo is swapped for different bytes', () => {
    // This is the property that matters: substituting a photo after signing
    // must invalidate the hash the signature committed to.
    const swapped = [{ ...photos[0], sha256: 'tampered' } as InspectionPhoto, photos[1]!];
    expect(computeContentHash(inspection, swapped, damages)).not.toBe(
      computeContentHash(inspection, photos, damages),
    );
  });

  it('changes when a damage is removed', () => {
    expect(computeContentHash(inspection, photos, [])).not.toBe(
      computeContentHash(inspection, photos, damages),
    );
  });

  it('changes when the odometer changes', () => {
    expect(computeContentHash(inspectionFixture({ odometer: 999 }), photos, damages)).not.toBe(
      computeContentHash(inspection, photos, damages),
    );
  });

  it('produces a 64-character hex digest', () => {
    expect(computeContentHash(inspection, photos, damages)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('intentTextFor', () => {
  it('states the damage count so the signer knows what they are attesting to', () => {
    expect(intentTextFor('pickup', '1HGCM82633A004352', 0)).toContain('no damage was noted');
    expect(intentTextFor('pickup', '1HGCM82633A004352', 1)).toContain('1 item of damage was noted');
    expect(intentTextFor('pickup', '1HGCM82633A004352', 3)).toContain(
      '3 items of damage were noted',
    );
  });

  it('warns a consignee that unrecorded damage may not be claimable', () => {
    const text = intentTextFor('delivery', '1HGCM82633A004352', 0);
    expect(text).toContain('may not be claimable later');
  });

  it('records intent to sign, which is what makes it a signature', () => {
    for (const stage of ['pickup', 'delivery'] as const) {
      expect(intentTextFor(stage, '1HGCM82633A004352', 0)).toContain(
        'same effect as a handwritten one',
      );
    }
  });
});

/* -------------------------------------------------------------------------
 * Image ingest
 * ---------------------------------------------------------------------- */

describe('sniffImageType', () => {
  it('identifies formats by magic bytes, not by a supplied header', () => {
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe('image/jpeg');
    expect(
      sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])),
    ).toBe('image/png');
  });

  it('rejects SVG, which can carry script', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    expect(() => sniffImageType(svg)).toThrow(ImageRejected);
  });

  it('rejects a file whose extension lies about its contents', () => {
    expect(() => sniffImageType(Buffer.from('GIF89a not really'))).toThrow(/JPEG, PNG and WebP/);
  });
});

describe('processInspectionPhoto', () => {
  async function jpeg(width: number, height: number): Promise<Buffer> {
    return sharp({
      create: { width, height, channels: 3, background: { r: 120, g: 80, b: 40 } },
    })
      .jpeg()
      .toBuffer();
  }

  it('downscales an oversized photo to the serving size', async () => {
    const processed = await processInspectionPhoto(await jpeg(4032, 3024));
    expect(processed.width).toBe(1600);
    expect(processed.height).toBe(1200);
  });

  it('does not upscale a small photo', async () => {
    const processed = await processInspectionPhoto(await jpeg(800, 600));
    expect(processed.width).toBe(800);
  });

  it('keeps the original bytes untouched alongside the derivative', async () => {
    // The original is the evidence; the derivative is what gets served.
    const source = await jpeg(2000, 1500);
    const processed = await processInspectionPhoto(source);
    expect(processed.original.equals(source)).toBe(true);
    expect(processed.derivative.equals(source)).toBe(false);
  });

  it('produces a thumbnail far smaller than the derivative', async () => {
    const processed = await processInspectionPhoto(await jpeg(3000, 2000));
    expect(processed.thumbnail.byteLength).toBeLessThan(processed.derivative.byteLength);
  });

  it('strips metadata from the served derivative', async () => {
    const withExif = await sharp({
      create: { width: 1200, height: 900, channels: 3, background: { r: 10, g: 10, b: 10 } },
    })
      .withExif({ IFD0: { Make: 'TestCam', Model: 'X1' } })
      .jpeg()
      .toBuffer();

    const processed = await processInspectionPhoto(withExif);
    const servedMetadata = await sharp(processed.derivative).metadata();
    expect(servedMetadata.exif).toBeUndefined();
  });

  it('rejects an empty file', async () => {
    await expect(processInspectionPhoto(Buffer.alloc(0))).rejects.toThrow(ImageRejected);
  });

  it('rejects something that is not an image', async () => {
    await expect(processInspectionPhoto(Buffer.from('just text'))).rejects.toThrow(ImageRejected);
  });
});

describe('extractExif', () => {
  it('returns empty fields rather than throwing on malformed EXIF', () => {
    expect(extractExif(Buffer.from('nonsense'))).toEqual({
      capturedAt: null,
      latitude: null,
      longitude: null,
      device: null,
    });
  });

  it('returns empty fields when there is no EXIF at all', () => {
    expect(extractExif(undefined).capturedAt).toBeNull();
  });
});

describe('distanceMetres', () => {
  it('is zero for the same point', () => {
    expect(distanceMetres(32.7554, -97.3308, 32.7554, -97.3308)).toBeCloseTo(0, 5);
  });

  it('measures a known separation', () => {
    // One degree of latitude is roughly 111 km anywhere on the globe.
    const metres = distanceMetres(32, -97, 33, -97);
    expect(metres).toBeGreaterThan(110_000);
    expect(metres).toBeLessThan(112_000);
  });

  it('puts a nearby point inside the geofence and a distant one outside', () => {
    // Roughly 300 m north.
    const near = distanceMetres(32.7554, -97.3308, 32.7581, -97.3308);
    expect(near).toBeLessThan(GEOFENCE_RADIUS_METRES);

    // Roughly 5 km north.
    const far = distanceMetres(32.7554, -97.3308, 32.8004, -97.3308);
    expect(far).toBeGreaterThan(GEOFENCE_RADIUS_METRES);
  });

  it('uses one mile as the radius, matching industry practice', () => {
    expect(GEOFENCE_RADIUS_METRES).toBe(1609);
  });
});

describe('INSPECTION_SEQUENCE', () => {
  it('follows the standard walk-around order', () => {
    // Rear, then each side back to front, then the front, then the interior.
    const slots = INSPECTION_SEQUENCE.map((s) => s.slot);
    expect(slots[0]).toBe('rear');
    expect(slots.indexOf('left')).toBeLessThan(slots.indexOf('front'));
    expect(slots.indexOf('front')).toBeLessThan(slots.indexOf('interior'));
  });

  it('captures the odometer and the VIN plate, which a claim needs', () => {
    const slots = INSPECTION_SEQUENCE.map((s) => s.slot);
    expect(slots).toContain('odometer');
    expect(slots).toContain('vin_plate');
  });

  it('gives every slot a hint, since these are read in a yard at night', () => {
    for (const step of INSPECTION_SEQUENCE) {
      expect(step.hint.length).toBeGreaterThan(10);
    }
  });

  it('offers at least as many slots as the strictest tier requires', () => {
    const strictest = Math.max(...Object.values(PHOTO_REQUIREMENTS).map((r) => r.perStage));
    expect(INSPECTION_SEQUENCE.length).toBeGreaterThanOrEqual(strictest);
  });
});
