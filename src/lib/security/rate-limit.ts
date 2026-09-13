import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { rateLimits } from '../db/schema';

/**
 * Fixed-window rate limiting, backed by the database.
 *
 * In the database rather than memory so limits survive a restart and hold
 * across multiple app instances without introducing Redis — this project has
 * to run on one small box for a one-truck carrier.
 */

export interface RateLimitRule {
  /** Attempts permitted inside the window. */
  limit: number;
  windowMs: number;
  /** How long to lock out once the limit is passed. Defaults to the window. */
  blockMs?: number;
}

export const RATE_LIMITS = {
  login: { limit: 5, windowMs: 15 * 60_000, blockMs: 15 * 60_000 },
  totp: { limit: 5, windowMs: 5 * 60_000, blockMs: 5 * 60_000 },
  recoveryCode: { limit: 3, windowMs: 60 * 60_000, blockMs: 60 * 60_000 },
  passwordReset: { limit: 3, windowMs: 60 * 60_000 },
  register: { limit: 3, windowMs: 60 * 60_000 },
  vinDecode: { limit: 120, windowMs: 60_000 },
  upload: { limit: 300, windowMs: 60 * 60_000 },
  signatureLink: { limit: 10, windowMs: 60 * 60_000 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** When the caller may retry, if currently blocked. */
  retryAfterMs: number;
}

/**
 * Consumes one attempt against a key.
 *
 * Always limit per account as well as per IP: a carrier's whole fleet can sit
 * behind one NAT address, so IP-only limiting locks out an entire yard when
 * one driver fat-fingers a password.
 */
export async function consumeRateLimit(
  name: RateLimitName,
  identifier: string,
): Promise<RateLimitResult> {
  // Widened to the rule interface: the `satisfies` literal above narrows each
  // entry to its exact shape, so the union drops `blockMs` where it is absent.
  const rule: RateLimitRule = RATE_LIMITS[name];
  const key = `${name}:${identifier}`;
  const now = Date.now();

  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(rateLimits).where(eq(rateLimits.key, key)).limit(1);

    if (existing?.blockedUntil && existing.blockedUntil.getTime() > now) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: existing.blockedUntil.getTime() - now,
      };
    }

    const windowExpired =
      !existing || now - existing.windowStartedAt.getTime() >= rule.windowMs;

    if (windowExpired) {
      const row = {
        key,
        count: 1,
        windowStartedAt: new Date(now),
        blockedUntil: null,
      };
      if (existing) {
        await tx.update(rateLimits).set(row).where(eq(rateLimits.key, key));
      } else {
        await tx.insert(rateLimits).values(row);
      }
      return { allowed: true, remaining: rule.limit - 1, retryAfterMs: 0 };
    }

    const nextCount = existing.count + 1;

    if (nextCount > rule.limit) {
      const blockMs = rule.blockMs ?? rule.windowMs;
      await tx
        .update(rateLimits)
        .set({ count: nextCount, blockedUntil: new Date(now + blockMs) })
        .where(eq(rateLimits.key, key));
      return { allowed: false, remaining: 0, retryAfterMs: blockMs };
    }

    await tx.update(rateLimits).set({ count: nextCount }).where(eq(rateLimits.key, key));
    return { allowed: true, remaining: rule.limit - nextCount, retryAfterMs: 0 };
  });
}

/** Clears a counter after a successful attempt. */
export async function resetRateLimit(name: RateLimitName, identifier: string): Promise<void> {
  await db.delete(rateLimits).where(eq(rateLimits.key, `${name}:${identifier}`));
}

/** Renders a retry delay for a user-facing message. */
export function describeRetry(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return 'a minute';
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? 'an hour' : `${hours} hours`;
}
