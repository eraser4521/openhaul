import 'server-only';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Content-addressed blob storage.
 *
 * The filesystem driver is the default because the target user runs one to ten
 * trucks and should not have to operate an object store to print a bill of
 * lading. The interface is deliberately S3-shaped so an S3 driver drops in
 * without touching callers.
 */

export interface StoredBlob {
  key: string;
  sha256: string;
  byteSize: number;
  contentType: string;
}

export interface BlobStore {
  put(bytes: Buffer, contentType: string, namespace: string): Promise<StoredBlob>;
  get(key: string): Promise<Buffer | null>;
  head(key: string): Promise<{ byteSize: number } | null>;
  delete(key: string): Promise<void>;
}

/**
 * Keys are derived from the content hash, which gives deduplication for free
 * and makes a retried upload idempotent: the same bytes always land in the
 * same place, so a half-finished upload cannot create a duplicate row.
 *
 * The two-level fan-out keeps any single directory from collecting millions of
 * entries, which some filesystems handle badly.
 */
function keyFor(sha256: string, namespace: string, extension: string): string {
  return `${namespace}/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}${extension}`;
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'application/json': '.json',
};

export function dataRoot(): string {
  return process.env.BLOB_STORAGE_PATH ?? path.join(process.cwd(), 'data', 'uploads');
}

/** Rejects any key that tries to escape the storage root. */
function resolveWithin(root: string, key: string): string {
  const resolved = path.resolve(root, key);
  const rootWithSep = path.resolve(root) + path.sep;
  if (!resolved.startsWith(rootWithSep)) {
    throw new Error('blob key escapes the storage root');
  }
  return resolved;
}

export function createFilesystemStore(root = dataRoot()): BlobStore {
  return {
    async put(bytes, contentType, namespace) {
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const key = keyFor(sha256, namespace, EXTENSIONS[contentType] ?? '.bin');
      const target = resolveWithin(root, key);

      await mkdir(path.dirname(target), { recursive: true });

      // Same content hash means identical bytes, so a re-upload is a no-op
      // rather than a rewrite.
      const existing = await stat(target).catch(() => null);
      if (!existing) {
        await writeFile(target, bytes);
      }

      return { key, sha256, byteSize: bytes.byteLength, contentType };
    },

    async get(key) {
      try {
        return await readFile(resolveWithin(root, key));
      } catch {
        return null;
      }
    },

    async head(key) {
      try {
        const info = await stat(resolveWithin(root, key));
        return { byteSize: info.size };
      } catch {
        return null;
      }
    },

    async delete(key) {
      /*
       * Content-addressed keys are shared by definition: two inspections that
       * photograph the same label produce the same key. Deleting one would
       * break the other, so callers must refcount before calling this. It
       * exists for retention purges, which operate on the whole set.
       */
      await unlink(resolveWithin(root, key)).catch(() => undefined);
    },
  };
}

let store: BlobStore | null = null;

export function blobStore(): BlobStore {
  store ??= createFilesystemStore();
  return store;
}
