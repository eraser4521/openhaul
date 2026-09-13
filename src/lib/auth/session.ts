import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { db } from '../db/client';
import { memberships, organizations, sessions, users, type OrgRole } from '../db/schema';
import { asOrgId, type OrgId } from '../db/scope';

/**
 * Opaque server-side sessions.
 *
 * The cookie holds a 256-bit random token; the database stores only its
 * SHA-256. Opaque rather than JWT because revocation has to be immediate —
 * when a dispatcher is let go, "their token expires in fifteen minutes" is
 * not an acceptable answer for a load board.
 */

/**
 * The `__Host-` prefix is the strongest binding the platform offers: a browser
 * rejects the cookie unless it is Secure, Path=/, and carries no Domain
 * attribute, which makes subdomain cookie-fixation structurally impossible.
 *
 * It requires HTTPS, so development over plain http falls back to an
 * unprefixed name.
 */
const SECURE_COOKIE = '__Host-openhaul_session';
const DEV_COOKIE = 'openhaul_session';

export function sessionCookieName(): string {
  return process.env.NODE_ENV === 'production' ? SECURE_COOKIE : DEV_COOKIE;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Timeout policy by role.
 *
 * This is the decision most apps get wrong for field workers. A dispatcher at
 * a desk can re-authenticate in seconds, so short windows cost them nothing.
 * A driver in a canyon with no signal *cannot* re-authenticate, and forcing it
 * means either lost inspection data or passwords written on the dash.
 *
 * Drivers get long, device-bound sessions, and the compensating controls are
 * immediate server-side revocation, a device list the owner can see and kill,
 * and step-up MFA on sensitive actions rather than blanket short expiry.
 */
export const SESSION_POLICY: Record<OrgRole, { idleMs: number; absoluteMs: number }> = {
  driver: { idleMs: 30 * DAY, absoluteMs: 90 * DAY },
  dispatcher: { idleMs: 8 * HOUR, absoluteMs: 12 * HOUR },
  owner: { idleMs: 8 * HOUR, absoluteMs: 12 * HOUR },
  accounting: { idleMs: 1 * HOUR, absoluteMs: 8 * HOUR },
};

/** Window within which a recent MFA check still satisfies a step-up demand. */
export const MFA_FRESHNESS_MS = 15 * 60 * 1000;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export interface SessionContext {
  token: string;
  userId: string;
  orgId: OrgId;
  role: OrgRole;
  displayName: string;
  email: string;
  orgName: string;
  mfaVerifiedAt: Date | null;
  absoluteExpiresAt: Date;
}

export interface CreateSessionInput {
  userId: string;
  orgId: string;
  role: OrgRole;
  ip?: string | null;
  userAgent?: string | null;
  deviceLabel?: string | null;
  mfaVerified?: boolean;
}

/** Issues a session and sets the cookie. Returns the raw token. */
export async function createSession(input: CreateSessionInput): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  const now = Date.now();
  const policy = SESSION_POLICY[input.role];

  await db.insert(sessions).values({
    tokenHash: sha256(raw),
    userId: input.userId,
    orgId: input.orgId,
    role: input.role,
    createdAt: new Date(now),
    lastSeenAt: new Date(now),
    idleExpiresAt: new Date(now + policy.idleMs),
    absoluteExpiresAt: new Date(now + policy.absoluteMs),
    mfaVerifiedAt: input.mfaVerified ? new Date(now) : null,
    ipCreated: input.ip ?? null,
    userAgentCreated: input.userAgent ?? null,
    deviceLabel: input.deviceLabel ?? null,
  });

  const store = await cookies();
  store.set(sessionCookieName(), raw, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // 'lax' blocks cross-site POST while still allowing an inbound link from
    // an email to land on an authenticated page. 'strict' breaks that.
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(policy.absoluteMs / 1000),
    // No domain attribute — required by the __Host- prefix.
  });

  return raw;
}

/**
 * Reads and validates the current session.
 *
 * Returns null rather than throwing, so callers decide between redirecting
 * and rendering a public view.
 */
export async function getSession(): Promise<SessionContext | null> {
  const store = await cookies();
  const raw = store.get(sessionCookieName())?.value;
  if (!raw) return null;

  const now = new Date();
  const rows = await db
    .select({
      session: sessions,
      user: users,
      org: organizations,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(organizations, eq(organizations.id, sessions.orgId))
    .where(
      and(
        eq(sessions.tokenHash, sha256(raw)),
        isNull(sessions.revokedAt),
        gt(sessions.idleExpiresAt, now),
        gt(sessions.absoluteExpiresAt, now),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.user.disabledAt) return null;

  // Sliding idle window, capped by the absolute expiry. Written back only
  // when it moves meaningfully, to avoid a write on every request.
  const policy = SESSION_POLICY[row.session.role];
  const nextIdle = new Date(Math.min(now.getTime() + policy.idleMs, row.session.absoluteExpiresAt.getTime()));
  if (nextIdle.getTime() - row.session.idleExpiresAt.getTime() > 60_000) {
    await db
      .update(sessions)
      .set({ lastSeenAt: now, idleExpiresAt: nextIdle })
      .where(eq(sessions.tokenHash, row.session.tokenHash));
  }

  return {
    token: raw,
    userId: row.session.userId,
    orgId: asOrgId(row.session.orgId),
    role: row.session.role,
    displayName: row.user.displayName,
    email: row.user.email,
    orgName: row.org.legalName,
    mfaVerifiedAt: row.session.mfaVerifiedAt,
    absoluteExpiresAt: row.session.absoluteExpiresAt,
  };
}

/**
 * Rotates the session token.
 *
 * Called on every privilege change — sign-in, MFA completion, password
 * change, role change, organisation switch — so a token captured before the
 * change cannot be replayed after it.
 */
export async function rotateSession(reason: string): Promise<string | null> {
  const current = await getSession();
  if (!current) return null;

  await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(eq(sessions.tokenHash, sha256(current.token)));

  return createSession({
    userId: current.userId,
    orgId: current.orgId,
    role: current.role,
    mfaVerified: current.mfaVerifiedAt !== null,
  });
}

export async function markMfaVerified(): Promise<void> {
  const store = await cookies();
  const raw = store.get(sessionCookieName())?.value;
  if (!raw) return;
  await db
    .update(sessions)
    .set({ mfaVerifiedAt: new Date() })
    .where(eq(sessions.tokenHash, sha256(raw)));
}

export async function revokeSession(reason = 'signed out'): Promise<void> {
  const store = await cookies();
  const raw = store.get(sessionCookieName())?.value;
  if (raw) {
    await db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(eq(sessions.tokenHash, sha256(raw)));
  }
  store.delete(sessionCookieName());
}

/** Kills every session for a user. Called on password reset and MFA reset. */
export async function revokeAllSessions(userId: string, reason: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

/** Sessions a user can review and revoke from settings. */
export async function listSessions(userId: string) {
  const now = new Date();
  return db
    .select({
      tokenHash: sessions.tokenHash,
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
      deviceLabel: sessions.deviceLabel,
      ipCreated: sessions.ipCreated,
      userAgentCreated: sessions.userAgentCreated,
      absoluteExpiresAt: sessions.absoluteExpiresAt,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.absoluteExpiresAt, now)));
}

/** Removes sessions that can no longer authenticate anyone. */
export async function pruneExpiredSessions(): Promise<void> {
  const now = new Date();
  await db
    .delete(sessions)
    .where(or(lt(sessions.absoluteExpiresAt, now), lt(sessions.idleExpiresAt, now)));
}

/** The membership a user signs in under, when they belong to several orgs. */
export async function defaultMembership(userId: string) {
  const rows = await db
    .select({ orgId: memberships.orgId, role: memberships.role })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

/** Best-effort client address, for the session and signature records. */
export async function clientAddress(): Promise<string | null> {
  const h = await headers();
  const forwarded = h.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return h.get('x-real-ip');
}

export async function clientUserAgent(): Promise<string | null> {
  const h = await headers();
  return h.get('user-agent');
}
