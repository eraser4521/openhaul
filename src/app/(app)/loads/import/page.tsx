import { redirect } from 'next/navigation';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import { can } from '@/lib/auth/capabilities';
import { PageBody, PageHeader } from '@/components/app/page-header';
import { LoadImport } from '@/components/app/load-import';

export const metadata = { title: 'Import loads' };

export default async function ImportLoadsPage() {
  const { session } = await requireSessionOrRedirect();
  if (!can(session.role, 'load.write')) redirect('/loads');

  return (
    <>
      <PageHeader
        title="Import loads"
        description="Bring in a dispatch sheet or a board export rather than retyping it."
      />

      <PageBody>
        <LoadImport />
      </PageBody>
    </>
  );
}
