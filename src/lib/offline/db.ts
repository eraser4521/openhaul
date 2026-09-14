'use client';

import Dexie, { type EntityTable } from 'dexie';

/**
 * On-device store for inspections captured in the field.
 *
 * A driver in a yard with no signal must be able to finish an inspection, and
 * losing that work is not a degraded experience — it is a lost cargo claim. So
 * capture writes here first and uploads later, rather than the other way
 * round.
 */

export type PhotoUploadState = 'pending' | 'uploading' | 'uploaded' | 'failed';
export type InspectionSyncState = 'draft' | 'queued' | 'syncing' | 'synced' | 'conflict';

export interface LocalInspection {
  /** Client-generated UUIDv7, so an offline device needs no round trip. */
  id: string;
  orgId: string;
  loadId: string;
  vehicleId: string;
  vin: string;
  stage: 'pickup' | 'delivery';
  tier: 'standard' | 'advanced' | 'aiag';
  syncState: InspectionSyncState;

  odometer: number | null;
  fuelLevelEighths: number | null;
  keysPresent: boolean | null;
  personalItemsPresent: boolean | null;
  personalItemsNote: string | null;
  limitationNote: string | null;

  latitude: string | null;
  longitude: string | null;
  locationAccuracyM: number | null;

  startedAt: number;
  completedAt: number | null;
  updatedAt: number;

  /** Set once the server accepts it; the record is frozen from then on. */
  finalizedAt: number | null;
  serverVersion: number | null;
}

export interface LocalPhoto {
  id: string;
  inspectionId: string;
  /** Which shot in the guided walk-around this satisfies. */
  slot: string | null;
  damageId: string | null;

  /**
   * Stored as a Blob, not an ArrayBuffer. Browsers keep Blobs out of line as
   * file references, where an ArrayBuffer is structure-cloned into the record
   * and costs heap on every read — the difference between a smooth photo grid
   * and a janky one.
   */
  blob: Blob;
  thumbnail: Blob;
  sha256: string;
  byteSize: number;
  width: number;
  height: number;

  capturedAt: number;
  latitude: string | null;
  longitude: string | null;

  uploadState: PhotoUploadState;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
}

export interface LocalDamage {
  id: string;
  inspectionId: string;
  code: string;
  areaCode: string;
  typeCode: string;
  severityCode: string;
  gridCode: string | null;
  codeVersion: string;
  description: string | null;
  diagramView: string | null;
  diagramX: string | null;
  diagramY: string | null;
  preExisting: boolean;
  nonTransportation: boolean;
  createdAt: number;
}

export interface LocalSignature {
  id: string;
  inspectionId: string;
  signerRole: 'driver' | 'shipper' | 'consignee' | 'broker_agent';
  signerNamePrinted: string;
  signatureMethod: 'drawn' | 'typed';
  /** Stroke points with timing — far harder to forge than a flat image. */
  strokes: unknown;
  image: Blob | null;
  intentText: string;
  signedAt: number;
  latitude: string | null;
  longitude: string | null;
  customerUnavailable: boolean;
  uploadState: PhotoUploadState;
}

const database = new Dexie('openhaul') as Dexie & {
  inspections: EntityTable<LocalInspection, 'id'>;
  photos: EntityTable<LocalPhoto, 'id'>;
  damages: EntityTable<LocalDamage, 'id'>;
  signatures: EntityTable<LocalSignature, 'id'>;
};

/*
 * Migrations here are additive only. Dropping a store could destroy an
 * inspection that has not uploaded yet, which is the one thing this database
 * exists to prevent.
 */
database.version(1).stores({
  inspections: 'id, loadId, vehicleId, syncState, [loadId+stage]',
  photos: 'id, inspectionId, uploadState, sha256, [inspectionId+slot], nextAttemptAt',
  damages: 'id, inspectionId',
  signatures: 'id, inspectionId, uploadState',
});

export const localDb = database;

/**
 * Asks the browser to exempt this origin from storage eviction.
 *
 * Matters most on iOS, where a home-screen install is treated differently from
 * a tab: data from a site only visited in Safari can be cleared after a week
 * of non-use, which for a Friday inspection reviewed the following Monday week
 * would mean losing the photos.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export interface StorageStatus {
  persisted: boolean;
  usageBytes: number | null;
  quotaBytes: number | null;
  /** Captured work that has not reached the server yet. */
  pendingPhotos: number;
  pendingInspections: number;
}

export async function storageStatus(): Promise<StorageStatus> {
  const [persisted, estimate, pendingPhotos, pendingInspections] = await Promise.all([
    navigator.storage?.persisted?.().catch(() => false) ?? Promise.resolve(false),
    navigator.storage?.estimate?.().catch(() => null) ?? Promise.resolve(null),
    localDb.photos.where('uploadState').anyOf('pending', 'failed', 'uploading').count(),
    localDb.inspections.where('syncState').anyOf('draft', 'queued', 'syncing').count(),
  ]);

  return {
    persisted,
    usageBytes: estimate?.usage ?? null,
    quotaBytes: estimate?.quota ?? null,
    pendingPhotos,
    pendingInspections,
  };
}

/**
 * Removes an inspection and everything hanging off it.
 *
 * Only ever called once the server has confirmed receipt, which is what makes
 * it safe — and keeping the window short shrinks the blast radius of a browser
 * evicting storage.
 */
export async function purgeLocalInspection(inspectionId: string): Promise<void> {
  await localDb.transaction('rw', localDb.inspections, localDb.photos, localDb.damages, localDb.signatures, async () => {
    await localDb.photos.where('inspectionId').equals(inspectionId).delete();
    await localDb.damages.where('inspectionId').equals(inspectionId).delete();
    await localDb.signatures.where('inspectionId').equals(inspectionId).delete();
    await localDb.inspections.delete(inspectionId);
  });
}
