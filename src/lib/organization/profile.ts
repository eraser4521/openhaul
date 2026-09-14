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

/**
 * Every organisation on this instance.
 *
 * Only for work that runs outside a session and therefore outside a tenant —
 * the scheduled bounce poll, which reads one mailbox configured per deployment
 * and has to attribute what it finds to whichever organisation sent it. Each
 * one is then handled through its own scoped client.
 */
export async function allOrganizations(): Promise<Array<{ id: string; legalName: string }>> {
  return db.select({ id: organizations.id, legalName: organizations.legalName }).from(organizations);
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
