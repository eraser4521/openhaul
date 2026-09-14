'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Download, FileText, Loader2 } from 'lucide-react';
import { issueDocumentAction, type DocumentResult } from '@/app/(app)/loads/[id]/actions';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { bytes as formatBytes, relativeTime } from '@/lib/utils/format';

export interface IssuedDocument {
  id: string;
  kind: string;
  title: string;
  sha256: string;
  byteSize: number;
  version: number;
  createdAt: Date;
  supersedesDocumentId: string | null;
}

export interface DocumentActionsProps {
  loadId: string;
  documents: IssuedDocument[];
  canIssue: boolean;
}

export function DocumentActions({ loadId, documents, canIssue }: DocumentActionsProps) {
  const [busy, setBusy] = useState<'bol' | 'pod' | null>(null);
  const [result, setResult] = useState<DocumentResult | null>(null);

  const issue = async (kind: 'bol' | 'pod') => {
    setBusy(kind);
    setResult(null);
    try {
      setResult(await issueDocumentAction(loadId, kind));
    } catch {
      setResult({ ok: false, error: 'The document could not be issued. Try again.' });
    } finally {
      setBusy(null);
    }
  };

  // Only the newest version of each kind is current; earlier ones are retained
  // but shown as superseded.
  const supersededIds = new Set(
    documents.map((d) => d.supersedesDocumentId).filter((id): id is string => id !== null),
  );

  return (
    <div className="space-y-4">
      {canIssue && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => void issue('bol')}
            loading={busy === 'bol'}
            disabled={busy !== null}
          >
            <FileText aria-hidden />
            {documents.some((d) => d.kind === 'bol') ? 'Reissue bill of lading' : 'Issue bill of lading'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void issue('pod')}
            loading={busy === 'pod'}
            disabled={busy !== null}
          >
            <FileText aria-hidden />
            {documents.some((d) => d.kind === 'pod') ? 'Reissue delivery receipt' : 'Issue delivery receipt'}
          </Button>
        </div>
      )}

      <AnimatePresence>
        {result && !result.ok && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            role="alert"
            className="rounded-lg bg-warn-soft px-3 py-2.5"
          >
            <p className="flex items-start gap-2 text-xs leading-relaxed text-warn">
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
              {result.error}
            </p>
            {result.missing && result.missing.length > 0 && (
              <ul className="mt-2 space-y-1 pl-5 text-[0.6875rem] text-warn">
                {result.missing.map((item) => (
                  <li key={item.field}>
                    · {item.message}{' '}
                    <span className="font-mono opacity-70">{item.citation}</span>
                  </li>
                ))}
              </ul>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {documents.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs leading-relaxed text-ink-muted">
          No documents issued yet. A bill of lading can be issued once every vehicle has a sealed
          pickup inspection — the document reports condition, so it cannot exist before that record
          does.
        </p>
      ) : (
        <ul className="space-y-2">
          {documents.map((document) => {
            const superseded = supersededIds.has(document.id);
            return (
              <li
                key={document.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-raised p-3"
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">{document.title}</span>
                    <Badge tone={superseded ? 'neutral' : 'ok'} size="sm">
                      {superseded ? 'Superseded' : 'Current'}
                    </Badge>
                    {document.version > 1 && (
                      <Badge tone="neutral" size="sm">
                        v{document.version}
                      </Badge>
                    )}
                  </p>
                  <p className="mt-1 font-mono text-[0.6875rem] text-ink-muted">
                    sha256 {document.sha256.slice(0, 24)}…
                  </p>
                  <p className="mt-0.5 text-[0.6875rem] text-ink-muted">
                    {formatBytes(document.byteSize)} · issued {relativeTime(document.createdAt)}
                  </p>
                </div>

                <div className="flex shrink-0 gap-1.5">
                  <a
                    href={`/api/documents/${document.id}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs text-ink-secondary transition-colors hover:border-line-strong hover:text-ink"
                  >
                    View
                  </a>
                  <a
                    href={`/api/documents/${document.id}?download=1`}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs text-ink-secondary transition-colors hover:border-line-strong hover:text-ink"
                  >
                    <Download className="size-3.5" aria-hidden />
                    PDF
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {busy && (
        <p className="flex items-center gap-2 text-xs text-ink-muted">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          Rendering and sealing the document…
        </p>
      )}
    </div>
  );
}
