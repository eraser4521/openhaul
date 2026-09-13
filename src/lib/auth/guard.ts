import 'server-only';
import { redirect } from 'next/navigation';
import { appendAudit, AUDIT } from '../audit/chain';
import { forOrg, type ScopedDb } from '../db/scope';
import type { OrgRole } from '../db/schema';
import { getSession, MFA_FRESHNESS_MS, type SessionContext } from './session';

/**
 * Authorisation helpers.
 *
 * Server Actions are public POST endpoints. A check on the page that renders
 * a form does not protect the action defined beside it, and a layout cannot
 * stop a route segment from rendering. So every action and route handler
 * re-verifies here, next to the data, rather than relying on anything upstream.
 */

export class AuthError extends Error {
  constructor(
    public readonly kind: 'unauthenticated' | 'forbidden' | 'mfa-required',
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Role capability matrix. Kept in one place so it can be read as a whole. */
export const CAPABILITIES = {
  'load.read': ['owner', 'dispatcher', 'driver', 'accounting'],
  'load.write': ['owner', 'dispatcher'],
  'load.dispatch': ['owner', 'dispatcher'],
  'load.void': ['owner', 'dispatcher'],
  'inspection.read': ['owner', 'dispatcher', 'driver', 'accounting'],
  'inspection.write': ['owner', 'dispatcher', 'driver'],
  'invoice.read': ['owner', 'dispatcher', 'accounting'],
  'invoice.write': ['owner', 'accounting'],
  'payment.write': ['owner', 'accounting'],
  'customer.read': ['owner', 'dispatcher', 'accounting'],
  'customer.write': ['owner', 'dispatcher'],
  'driver.read': ['owner', 'dispatcher'],
  'driver.write': ['owner'],
  'equipment.write': ['owner', 'dispatcher'],
  'claim.read': ['owner', 'dispatcher', 'accounting'],
  'claim.write': ['owner', 'dispatcher'],
  'pii.read': ['owner'],
  'settings.write': ['owner'],
  'audit.read': ['owner'],
  'member.manage': ['owner'],
} as const satisfies Record<string, readonly OrgRole[]>;

export type Capability = keyof typeof CAPABILITIES;

export function can(role: OrgRole, capability: Capability): boolean {
  return (CAPABILITIES[capability] as readonly OrgRole[]).includes(role);
}

export interface AuthContext {
  session: SessionContext;
  db: ScopedDb;
}

/** Requires a signed-in user. Throws rather than redirecting, for actions. */
export async function requireSession(): Promise<AuthContext> {
  const session = await getSession();
  if (!session) throw new AuthError('unauthenticated', 'Sign in to continue.');
  return { session, db: forOrg(session.orgId) };
}

/** Page-level variant: redirects to sign-in instead of throwing. */
export async function requireSessionOrRedirect(): Promise<AuthContext> {
  const session = await getSession();
  if (!session) redirect('/login');
  return { session, db: forOrg(session.orgId) };
}

/**
 * Requires a capability.
 *
 * No ownership check is needed afterwards: the scoped client cannot reach
 * another organisation's rows, so "does this load belong to me" is answered
 * by the query itself rather than by a second lookup that might be forgotten.
 */
export async function requireCapability(capability: Capability): Promise<AuthContext> {
  const context = await requireSession();

  if (!can(context.session.role, capability)) {
    await appendAudit({
      orgId: context.session.orgId,
      actorId: context.session.userId,
      actorRole: context.session.role,
      action: AUDIT.permissionDenied,
      subject: `capability:${capability}`,
      outcome: 'denied',
    });
    throw new AuthError('forbidden', 'You do not have permission to do that.');
  }

  return context;
}

/**
 * Requires a recent MFA check on top of a capability.
 *
 * This is what makes long driver sessions safe: the session stays alive for
 * weeks, but anything that moves money or reveals personal data demands a
 * fresh second factor.
 */
export async function requireStepUp(capability: Capability): Promise<AuthContext> {
  const context = await requireCapability(capability);
  const verifiedAt = context.session.mfaVerifiedAt;

  if (!verifiedAt || Date.now() - verifiedAt.getTime() > MFA_FRESHNESS_MS) {
    throw new AuthError('mfa-required', 'Confirm your identity to continue.');
  }

  return context;
}

/**
 * Narrows a driver to their own work.
 *
 * Role alone is not enough here: every driver in an organisation shares the
 * `driver` role, so one could otherwise read another's loads.
 */
export function driverScopeFilter(session: SessionContext): { driverOnly: boolean } {
  return { driverOnly: session.role === 'driver' };
}

/** Maps an AuthError onto a response shape the UI can render. */
export function authErrorToResult(error: unknown): { ok: false; error: string; kind?: string } {
  if (error instanceof AuthError) {
    return { ok: false, error: error.message, kind: error.kind };
  }
  return { ok: false, error: 'Something went wrong. Please try again.' };
}
