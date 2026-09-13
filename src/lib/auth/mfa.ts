import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client';
import { recoveryCodes, totpCredentials } from '../db/schema';
import { decryptField, encryptField } from '../crypto/field';

/**
 * Two-factor authentication: TOTP with single-use recovery codes.
 */

const ISSUER = 'OpenHaul';

/**
 * SHA-1 / 6 digits / 30 seconds is an interoperability choice, not a security
 * one. Google Authenticator, Authy and most hardware tokens ignore the
 * algorithm field in an otpauth:// URI, so deviating produces codes that
 * silently never match. RFC 6238 sanctions this profile; the security comes
 * from the secret's 160 bits.
 */
function totpFor(secretBase32: string, accountLabel: string): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label: accountLabel,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
}

/** The field reference under which a TOTP secret is sealed. */
function secretRef(orgId: string, credentialId: string) {
  return { orgId, table: 'totp_credentials', column: 'secret', rowId: credentialId };
}

export interface EnrollmentChallenge {
  credentialId: string;
  /** Shown as a QR code. */
  otpauthUri: string;
  /** Shown as text, for authenticator apps that cannot scan. */
  secretBase32: string;
}

/**
 * Begins enrolment. The credential is stored inactive until the user proves
 * they can generate a valid code — otherwise a mis-scanned QR locks them out
 * permanently.
 */
export async function beginEnrollment(
  userId: string,
  orgId: string,
  accountLabel: string,
): Promise<EnrollmentChallenge> {
  // 160-bit secret, per RFC 4226 §4 R6.
  const secret = new Secret({ size: 20 });

  const [row] = await db
    .insert(totpCredentials)
    .values({
      userId,
      // Placeholder: the row id is part of the encryption AAD, so the secret
      // can only be sealed once the id exists.
      secretEncrypted: '',
    })
    .returning({ id: totpCredentials.id });

  if (!row) throw new Error('failed to create TOTP credential');

  await db
    .update(totpCredentials)
    .set({ secretEncrypted: encryptField(secretRef(orgId, row.id), secret.base32) })
    .where(eq(totpCredentials.id, row.id));

  return {
    credentialId: row.id,
    otpauthUri: totpFor(secret.base32, accountLabel).toString(),
    secretBase32: secret.base32,
  };
}

export type TotpResult =
  | { ok: true }
  | { ok: false; reason: 'no-credential' | 'invalid' | 'replayed' };

/**
 * Verifies a code and activates the credential if this is the first success.
 *
 * A window of 1 accepts the previous, current and next 30-second step, which
 * absorbs the clock drift common on phones that have been offline for days.
 * Widening it further without a rate limit would be a real weakening.
 *
 * The accepted step is recorded and a repeat is rejected — without that, a
 * shoulder-surfed code stays usable for up to 90 seconds.
 */
export async function verifyTotp(
  userId: string,
  orgId: string,
  token: string,
  accountLabel: string,
): Promise<TotpResult> {
  const [credential] = await db
    .select()
    .from(totpCredentials)
    .where(eq(totpCredentials.userId, userId))
    .limit(1);

  if (!credential || credential.secretEncrypted.length === 0) {
    return { ok: false, reason: 'no-credential' };
  }

  const secretBase32 = decryptField(secretRef(orgId, credential.id), credential.secretEncrypted);
  const totp = totpFor(secretBase32, accountLabel);

  const delta = totp.validate({ token: token.replace(/\s/g, ''), window: 1 });
  if (delta === null) return { ok: false, reason: 'invalid' };

  const step = Math.floor(Date.now() / 1000 / 30) + delta;
  if (credential.lastUsedStep !== null && step <= credential.lastUsedStep) {
    return { ok: false, reason: 'replayed' };
  }

  await db
    .update(totpCredentials)
    .set({ lastUsedStep: step, activatedAt: credential.activatedAt ?? new Date() })
    .where(eq(totpCredentials.id, credential.id));

  return { ok: true };
}

export async function isMfaEnabled(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ activatedAt: totpCredentials.activatedAt })
    .from(totpCredentials)
    .where(eq(totpCredentials.userId, userId))
    .limit(1);
  return Boolean(row?.activatedAt);
}

export async function disableMfa(userId: string): Promise<void> {
  await db.delete(totpCredentials).where(eq(totpCredentials.userId, userId));
  await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
}

/* -------------------------------------------------------------------------
 * Recovery codes
 * ---------------------------------------------------------------------- */

/** No I, L, O, 0 or 1 — these get read aloud over a phone in a noisy cab. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Ten codes of ten characters over a 31-symbol alphabet: roughly 49.5 bits
 * each.
 *
 * Hashed with SHA-256 rather than Argon2, deliberately. Argon2 exists to make
 * low-entropy human passwords expensive to guess; these are uniformly random
 * and already infeasible to brute force, so a slow hash would add login
 * latency and a denial-of-service surface for no security gain.
 */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(10);
    const body = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
    return `${body.slice(0, 5)}-${body.slice(5)}`;
  });
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256')
    .update(code.replace(/[\s-]/g, '').toUpperCase())
    .digest('hex');
}

/** Replaces every existing code. Returns the plaintext, shown exactly once. */
export async function issueRecoveryCodes(userId: string, count = 10): Promise<string[]> {
  const codes = generateRecoveryCodes(count);

  await db.transaction(async (tx) => {
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
    await tx.insert(recoveryCodes).values(
      codes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })),
    );
  });

  return codes;
}

/**
 * Consumes a recovery code.
 *
 * The match and the consumption happen in one transaction, so the same code
 * cannot be spent twice by two concurrent requests.
 */
export async function consumeRecoveryCode(userId: string, supplied: string): Promise<boolean> {
  const target = Buffer.from(hashRecoveryCode(supplied), 'hex');

  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));

    const match = rows.find((row) => {
      const candidate = Buffer.from(row.codeHash, 'hex');
      return candidate.length === target.length && timingSafeEqual(candidate, target);
    });

    if (!match) return false;

    await tx
      .update(recoveryCodes)
      .set({ usedAt: new Date() })
      .where(eq(recoveryCodes.id, match.id));

    return true;
  });
}

export async function remainingRecoveryCodes(userId: string): Promise<number> {
  const rows = await db
    .select({ id: recoveryCodes.id })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));
  return rows.length;
}
