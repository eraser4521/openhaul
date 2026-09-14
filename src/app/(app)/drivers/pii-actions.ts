'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { drivers as driversTable } from '@/lib/db/schema';
import { authErrorToResult, requireCapability } from '@/lib/auth/guard';
import { personalDataSchema } from '@/lib/pii/validate';
import {
  createSubject,
  eraseSubject,
  readSubject,
  updateSubject,
  type PersonalData,
} from '@/lib/pii/vault';

/**
 * The driver's personal data, which is not kept on the driver row.
 *
 * Three rules shape these actions.
 *
 * Nothing personal is sent to the browser unless somebody asks for it. The
 * drivers page renders without it and `revealAction` is a separate round trip,
 * so the audit entry for a decrypt corresponds to a person actually looking at
 * it rather than to a page load.
 *
 * Erasure is a distinct capability from reading, and irreversible, so it takes
 * a typed confirmation and a reason that goes on the record.
 *
 * The subject id is only ever reached through the driver row, which the scoped
 * client has already confined to the caller's organisation. No action here
 * takes a subject id from the request.
 */

export interface PiiResult {
  ok: boolean;
  error?: string;
  data?: PersonalData;
  erasedAt?: string | null;
}

/** Resolves a driver to its subject, refusing anything outside the tenant. */
async function subjectFor(
  db: Awaited<ReturnType<typeof requireCapability>>['db'],
  driverId: string,
) {
  const driver = await db.selectOne('drivers', eq(driversTable.id, driverId));
  return driver ? { driver, subjectId: driver.subjectId } : null;
}

export async function savePersonalDataAction(
  driverId: string,
  formData: FormData,
): Promise<PiiResult> {
  let context;
  try {
    context = await requireCapability('pii.read');
  } catch (error) {
    return authErrorToResult(error);
  }

  const parsed = personalDataSchema.safeParse({
    name: formData.get('name') ?? undefined,
    email: formData.get('email') ?? undefined,
    phone: formData.get('phone') ?? undefined,
    address: formData.get('address') ?? undefined,
    dob: formData.get('dob') ?? undefined,
    cdlNumber: formData.get('cdlNumber') ?? undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the details.' };
  }

  const { db } = context;
  const found = await subjectFor(db, driverId);
  if (!found) return { ok: false, error: 'No such driver.' };

  if (found.subjectId) {
    const result = await updateSubject(db, found.subjectId, parsed.data);
    if (!result.ok) return { ok: false, error: result.error };
  } else {
    const subjectId = await createSubject(db, parsed.data);
    await db.update('drivers', eq(driversTable.id, driverId), { subjectId });
  }

  revalidatePath('/drivers');
  return { ok: true };
}

/**
 * Decrypts and returns the record, once, on request.
 *
 * Audited inside the vault rather than here, so there is no path that reads
 * personal data without leaving an entry.
 */
export async function revealPersonalDataAction(driverId: string): Promise<PiiResult> {
  let context;
  try {
    context = await requireCapability('pii.read');
  } catch (error) {
    return authErrorToResult(error);
  }

  const { session, db } = context;
  const found = await subjectFor(db, driverId);
  if (!found) return { ok: false, error: 'No such driver.' };
  if (!found.subjectId) return { ok: false, error: 'Nothing on file for this driver yet.' };

  const read = await readSubject(db, found.subjectId, {
    userId: session.userId,
    role: session.role,
    purpose: 'driver record',
  });

  if (read.status === 'missing') return { ok: false, error: 'Nothing on file for this driver.' };
  if (read.status === 'erased') {
    return {
      ok: false,
      error: 'This record was erased and cannot be recovered.',
      erasedAt: read.erasedAt?.toISOString() ?? null,
    };
  }

  return { ok: true, data: read.data };
}

export async function erasePersonalDataAction(
  driverId: string,
  formData: FormData,
): Promise<PiiResult> {
  let context;
  try {
    context = await requireCapability('pii.erase');
  } catch (error) {
    return authErrorToResult(error);
  }

  const { session, db } = context;
  const found = await subjectFor(db, driverId);
  if (!found) return { ok: false, error: 'No such driver.' };
  if (!found.subjectId) return { ok: false, error: 'Nothing on file for this driver.' };

  const reason = String(formData.get('reason') ?? '').trim();
  if (reason.length < 3) {
    return { ok: false, error: 'Say why the record is being erased. It goes on the record.' };
  }

  /*
   * Typing the name is the confirmation. This cannot be undone and there is no
   * backup of the key inside the application, so a misclick has to be made
   * harder than a click.
   */
  const confirmation = String(formData.get('confirm') ?? '').trim();
  if (confirmation !== found.driver.displayName) {
    return { ok: false, error: `Type ${found.driver.displayName} exactly to confirm.` };
  }

  const result = await eraseSubject(db, found.subjectId, reason, {
    userId: session.userId,
    role: session.role,
    purpose: 'erasure request',
  });

  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath('/drivers');
  return { ok: true };
}
