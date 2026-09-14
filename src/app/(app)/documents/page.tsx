import { Download, FileText } from 'lucide-react';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import { EmptyState, PageBody, PageHeader } from '@/components/app/page-header';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { bytes, relativeTime } from '@/lib/utils/format';
import { can } from '@/lib/auth/capabilities';
import { SendDocument } from '@/components/app/send-document';
import { BounceCheck } from '@/components/app/bounce-check';
import { sendsFor } from '@/lib/documents/send';
import { mailConfigured } from '@/lib/email/transport';
import { inboxConfigured } from '@/lib/email/inbox';

export const metadata = { title: 'Documents' };

export default async function DocumentsPage() {
  const { session, db } = await requireSessionOrRedirect();

  const documents = await db.select('documents');
  const configured = mailConfigured();
  const canSend = can(session.role, 'load.read');

  // Newest first: the thing somebody wants to send is almost always the thing
  // that was just produced.
  const sorted = documents
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const sends = await Promise.all(sorted.map((document) => sendsFor(db, document.id)));

  return (
    <>
      <PageHeader
        title="Documents"
        description="Every document this produces, stored as the exact bytes that were sealed — and sendable from here."
      />
      <PageBody className="space-y-4">
        {canSend && <BounceCheck configured={inboxConfigured()} />}

        {documents.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No documents yet"
            description="A bill of lading is frozen the moment it is signed and stored byte for byte, because regenerating one from a later template does not reproduce the record that was actually agreed."
          />
        ) : (
          <ul className="space-y-3">
            {sorted.map((document, index) => (
              <li key={document.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink">
                          {document.title}
                        </span>
                        <Badge tone="neutral" size="sm" className="uppercase">
                          {document.kind.replace(/_/g, ' ')}
                        </Badge>
                        {document.finalizedAt && (
                          <Badge tone="ok" size="sm">
                            Sealed
                          </Badge>
                        )}
                      </p>
                      <p className="mt-1 font-mono text-[0.6875rem] text-ink-muted">
                        sha256 {document.sha256.slice(0, 16)}…
                      </p>
                      <p className="mt-0.5 text-xs text-ink-secondary">
                        {bytes(document.byteSize)} · {relativeTime(document.createdAt)}
                      </p>
                    </div>

                    <div className="flex shrink-0 gap-1.5">
                      <a
                        href={`/api/documents/${document.id}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex h-8 items-center rounded-lg border border-line px-2.5 text-xs text-ink-secondary transition-colors hover:border-line-strong hover:text-ink"
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
                  </div>

                  <div className="mt-3 border-t border-line pt-3">
                    <SendDocument
                      documentId={document.id}
                      documentTitle={document.title}
                      configured={configured}
                      canSend={canSend}
                      sends={(sends[index] ?? []).map((send) => ({
                        id: send.id,
                        to: send.toAddresses,
                        cc: send.ccAddresses,
                        subject: send.subject,
                        status: send.status,
                        error: send.error,
                        attemptedAt: send.attemptedAt,
                        bouncedAt: send.bouncedAt,
                        bounceType: send.bounceType,
                        bounceCode: send.bounceCode,
                        bounceRecipient: send.bounceRecipient,
                        bounceDiagnostic: send.bounceDiagnostic,
                      }))}
                    />
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </PageBody>
    </>
  );
}
