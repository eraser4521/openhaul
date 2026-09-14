import 'server-only';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { documents as documentsTable, type DocumentKind } from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { blobStore } from '../storage/blob-store';

/**
 * Freezes rendered bytes as a document row.
 *
 * Shared by every generator so they cannot drift on the part that matters:
 * the bytes are hashed before they are stored, the row records that hash, and
 * `finalizedAt` is set immediately — which is what the append-only trigger
 * keys off to refuse any later edit. A new version supersedes its predecessor
 * instead of replacing it, because the copy somebody already acted on has to
 * stay retrievable.
 */
export interface StoredDocument {
  documentId: string;
  sha256: string;
  byteSize: number;
  version: number;
}

export async function storeDocument(options: {
  scoped: ScopedDb;
  kind: DocumentKind;
  loadId: string | null;
  subject: string;
  title: string;
  bytes: Uint8Array;
  contentType?: string;
  supersedesDocumentId?: string | null;
}): Promise<StoredDocument | { error: string }> {
  const bytes = Buffer.from(options.bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const contentType = options.contentType ?? 'application/pdf';

  const stored = await blobStore().put(bytes, contentType, 'documents');

  const previousVersion = options.supersedesDocumentId
    ? (
        await options.scoped.selectOne(
          'documents',
          eq(documentsTable.id, options.supersedesDocumentId),
        )
      )?.version ?? 0
    : 0;

  const [row] = await options.scoped.insert('documents', {
    kind: options.kind,
    loadId: options.loadId,
    subject: options.subject,
    title: options.title,
    storageKey: stored.key,
    sha256,
    byteSize: bytes.byteLength,
    contentType,
    version: previousVersion + 1,
    supersedesDocumentId: options.supersedesDocumentId ?? null,
    finalizedAt: new Date(),
  });

  if (!row) return { error: 'The document could not be stored.' };

  return { documentId: row.id, sha256, byteSize: bytes.byteLength, version: previousVersion + 1 };
}
