import { LoadForm } from './load-form';
import { PageBody, PageHeader } from '@/components/app/page-header';
import { requireCapability } from '@/lib/auth/guard';
import { suggestLoadNumber } from '../actions';
import { redirect } from 'next/navigation';

export const metadata = { title: 'New load' };

export default async function NewLoadPage() {
  try {
    await requireCapability('load.write');
  } catch {
    redirect('/loads');
  }

  const suggestedNumber = await suggestLoadNumber();

  return (
    <>
      <PageHeader
        title="New load"
        description="Enter each VIN and the year, make and model fill in automatically."
      />
      <PageBody className="max-w-3xl">
        <LoadForm suggestedNumber={suggestedNumber} />
      </PageBody>
    </>
  );
}
