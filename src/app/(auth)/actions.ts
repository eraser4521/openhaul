'use server';

import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import { memberships, organizations, users } from '@/lib/db/schema';
import { appendAudit, AUDIT } from '@/lib/audit/chain';
import { checkPasswordStrength, hashPassword, verifyPassword } from '@/lib/auth/password';
import {
  clientAddress,
  clientUserAgent,
  createSession,
  defaultMembership,
  revokeSession,
} from '@/lib/auth/session';
import { consumeRateLimit, describeRetry, resetRateLimit } from '@/lib/security/rate-limit';

/**
 * Authentication server actions.
 *
 * Server Actions are public POST endpoints, so each of these validates its own
 * input and applies its own rate limit rather than trusting the page that
 * renders the form.
 */

export interface ActionResult {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
}

const emailSchema = z
  .string()
  .trim()
  .min(1, 'Enter your email address.')
  .max(254)
  .email('That does not look like an email address.')
  // Lower-cased before storage so the unique index is genuinely unique.
  .transform((value) => value.toLowerCase());

const registerSchema = z.object({
  companyName: z.string().trim().min(2, 'Enter your company name.').max(200),
  displayName: z.string().trim().min(2, 'Enter your name.').max(120),
  email: emailSchema,
  password: z.string().min(12, 'Use at least 12 characters.').max(1024),
  usdotNumber: z.string().trim().max(20).optional().or(z.literal('')),
  mcNumber: z.string().trim().max(20).optional().or(z.literal('')),
});

function flatten(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && !fieldErrors[key]) {
      fieldErrors[key] = issue.message;
    }
  }
  return fieldErrors;
}

/**
 * Creates an organisation and its first owner.
 *
 * Every registration starts a new organisation. Adding people to an existing
 * one goes through an invitation, so a stranger who finds a self-hosted
 * instance cannot join a carrier's tenant by guessing its name.
 */
export async function registerAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = registerSchema.safeParse({
    companyName: formData.get('companyName'),
    displayName: formData.get('displayName'),
    email: formData.get('email'),
    password: formData.get('password'),
    usdotNumber: formData.get('usdotNumber'),
    mcNumber: formData.get('mcNumber'),
  });

  if (!parsed.success) {
    return { ok: false, fieldErrors: flatten(parsed.error) };
  }

  const { companyName, displayName, email, password, usdotNumber, mcNumber } = parsed.data;

  const ip = await clientAddress();
  const limit = await consumeRateLimit('register', ip ?? 'unknown');
  if (!limit.allowed) {
    return { ok: false, error: `Too many attempts. Try again in ${describeRetry(limit.retryAfterMs)}.` };
  }

  const strength = checkPasswordStrength(password, [email, displayName, companyName]);
  if (!strength.ok) {
    return { ok: false, fieldErrors: { password: strength.problems.join(' ') } };
  }

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing.length > 0) {
    return { ok: false, fieldErrors: { email: 'An account already exists for that email.' } };
  }

  const passwordHash = await hashPassword(password);

  const created = await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({
        legalName: companyName,
        kind: 'carrier',
        usdotNumber: usdotNumber || null,
        mcNumber: mcNumber || null,
      })
      .returning({ id: organizations.id });

    const [user] = await tx
      .insert(users)
      .values({ email, displayName, passwordHash })
      .returning({ id: users.id });

    if (!org || !user) throw new Error('failed to create organisation');

    await tx.insert(memberships).values({ orgId: org.id, userId: user.id, role: 'owner' });

    return { orgId: org.id, userId: user.id };
  });

  await createSession({
    userId: created.userId,
    orgId: created.orgId,
    role: 'owner',
    ip,
    userAgent: await clientUserAgent(),
  });

  await appendAudit({
    orgId: created.orgId,
    actorId: created.userId,
    actorRole: 'owner',
    action: AUDIT.loginSucceeded,
    subject: `user:${created.userId}`,
    detail: { via: 'registration' },
    ipAddress: ip,
  });

  redirect('/dashboard');
}

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password.').max(1024),
});

export async function loginAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });

  if (!parsed.success) {
    return { ok: false, fieldErrors: flatten(parsed.error) };
  }

  const { email, password } = parsed.data;
  const ip = await clientAddress();

  // Limited per account as well as per address: a carrier's whole yard can sit
  // behind one NAT address, so address-only limiting locks everyone out when
  // one driver mistypes a password.
  for (const key of [`ip:${ip ?? 'unknown'}`, `account:${email}`]) {
    const limit = await consumeRateLimit('login', key);
    if (!limit.allowed) {
      return {
        ok: false,
        error: `Too many sign-in attempts. Try again in ${describeRetry(limit.retryAfterMs)}.`,
      };
    }
  }

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  // Deliberately identical for an unknown account and a wrong password, so
  // the form cannot be used to enumerate who has an account here.
  const genericFailure: ActionResult = {
    ok: false,
    error: 'That email and password do not match.',
  };

  if (!user?.passwordHash) {
    // Spend comparable time either way so the response does not reveal
    // whether the account exists.
    await hashPassword(password).catch(() => undefined);
    return genericFailure;
  }

  if (user.disabledAt) {
    return { ok: false, error: 'That account has been disabled. Contact your administrator.' };
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    return {
      ok: false,
      error: `That account is temporarily locked. Try again in ${describeRetry(
        user.lockedUntil.getTime() - Date.now(),
      )}.`,
    };
  }

  const result = await verifyPassword(user.passwordHash, password);

  if (!result.ok) {
    const failures = user.failedLoginCount + 1;
    await db
      .update(users)
      .set({
        failedLoginCount: failures,
        // Ten consecutive failures locks the account for fifteen minutes, on
        // top of the per-address and per-account rate limits.
        lockedUntil: failures >= 10 ? new Date(Date.now() + 15 * 60_000) : user.lockedUntil,
      })
      .where(eq(users.id, user.id));

    await appendAudit({
      orgId: 'unknown',
      actorId: user.id,
      action: AUDIT.loginFailed,
      subject: `user:${user.id}`,
      outcome: 'failure',
      detail: { consecutiveFailures: failures },
      ipAddress: ip,
    });

    return genericFailure;
  }

  const membership = await defaultMembership(user.id);
  if (!membership) {
    return { ok: false, error: 'That account is not attached to an organisation yet.' };
  }

  // Upgrade the hash now that the plaintext is in hand and the parameters are
  // known to be behind current policy.
  const updates: Record<string, unknown> = {
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: new Date(),
  };
  if (result.needsRehash) {
    updates.passwordHash = await hashPassword(password);
  }
  await db.update(users).set(updates).where(eq(users.id, user.id));

  await resetRateLimit('login', `account:${email}`);

  await createSession({
    userId: user.id,
    orgId: membership.orgId,
    role: membership.role,
    ip,
    userAgent: await clientUserAgent(),
  });

  await appendAudit({
    orgId: membership.orgId,
    actorId: user.id,
    actorRole: membership.role,
    action: AUDIT.loginSucceeded,
    subject: `user:${user.id}`,
    ipAddress: ip,
  });

  redirect('/dashboard');
}

export async function logoutAction(): Promise<void> {
  await revokeSession('signed out');
  redirect('/login');
}
