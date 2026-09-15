import { timingSafeEqual } from 'node:crypto';

/**
 * Authenticating a scheduler rather than a person.
 *
 * Two endpoints are driven from outside a browser session — a cron line
 * checking the bounce mailbox and one sending statements — and both are
 * authenticated the same way, by a shared token compared in constant time.
 * Shared rather than copied into each route: a second implementation of a
 * timing-safe compare is how one of them ends up using `===`.
 */

/** Constant-time comparison that does not leak the token's length. */
export function tokenMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still compare something, so a wrong length costs the same as a wrong byte.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** The bearer token on a request, however the caller spelled the header. */
export function bearerFrom(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : header;
}

export type TokenCheck =
  | { ok: true }
  | { ok: false; status: 404 | 401; error?: string };

/**
 * Whether a request may drive a scheduled job.
 *
 * An unset token turns the endpoint off entirely rather than leaving it open.
 * An unauthenticated route that writes to the database and sends mail is not
 * something to have on by default, and a deployment that never sets the
 * variable should not quietly acquire one.
 */
export function checkSchedulerToken(request: Request, variable: string): TokenCheck {
  const expected = process.env[variable];
  if (!expected) {
    return {
      ok: false,
      status: 404,
      error: `Driving this from outside a session is off. Set ${variable} to enable it.`,
    };
  }

  const supplied = bearerFrom(request);
  if (!supplied || !tokenMatches(supplied, expected)) return { ok: false, status: 401 };

  return { ok: true };
}
