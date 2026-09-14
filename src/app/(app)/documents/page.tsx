import { FileText } from 'lucide-react';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import { EmptyState, PageBody, PageHeader } from '@/components/app/page-header';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { bytes, relativeTime } from '@/lib/utils/format';

export const metadata = { title: 'Documents' };

export default async function DocumentsPage() {
  const { db } = await requireSessionOrRedirect();
  const documents = await db.select('documents');

  return (
    <>
      <PageHeader
        title="Documents"
        description="Bills of lading, delivery receipts and rate confirmations, stored as the exact bytes that were signed."
      />
      <PageBody>
        {documents.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No documents yet"
            description="A bill of lading is frozen the moment it is signed and stored byte for byte, because regenerating one from a later template does not reproduce the record that was actually agreed."
          />
        ) : (
          <ul className="space-y-2">
            {documents.map((document) => (
              <li key={document.id}>
                <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-ink">{document.title}</span>
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
                  </div>
                  <p className="text-xs text-ink-secondary">
                    {bytes(document.byteSize)} · {relativeTime(document.createdAt)}
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </PageBody>
    </>
  );
}
