import { ScanWorkbench } from './scan-workbench';
import { PageBody, PageHeader } from '@/components/app/page-header';
import { requireSessionOrRedirect } from '@/lib/auth/guard';

export const metadata = { title: 'Scan a VIN' };

export default async function ScanPage() {
  await requireSessionOrRedirect();

  return (
    <>
      <PageHeader
        title="Scan a VIN"
        description="Point the camera at the door jamb or windshield label. The scan is only accepted once the check digit proves it was read correctly."
      />
      <PageBody>
        <ScanWorkbench />
      </PageBody>
    </>
  );
}
