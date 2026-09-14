import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { organizations, type Organization } from '../db/schema';

/**
 * The organisation record.
 *
 * Organisations are the tenant root, so there is no `org_id` column for
 * `forOrg()` to weld a predicate onto — which is why this is the one shape of
 * data feature code cannot reach through the scoped client. Access is narrowed
 * here instead: every function takes the organisation id as its first argument
 * and filters on it, and the id always comes from the session rather than from
 * a request body.
 */

export async function getOrganization(orgId: string): Promise<Organization | null> {
  const [row] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return row ?? null;
}

/** The fields that appear on paperwork and can be corrected in settings. */
export interface OrganizationProfile {
  legalName: string;
  dbaName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  phone: string | null;
  email: string | null;
  usdotNumber: string | null;
  mcNumber: string | null;
}

export async function updateOrganizationProfile(
  orgId: string,
  profile: OrganizationProfile,
): Promise<void> {
  await db
    .update(organizations)
    .set({ ...profile, updatedAt: new Date() })
    .where(eq(organizations.id, orgId));
}
