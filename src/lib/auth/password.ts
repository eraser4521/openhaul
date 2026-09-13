import 'server-only';
import { hash, parseOptions, verify } from '@node-rs/argon2';
import { timingSafeEqual } from 'node:crypto';

/**
 * Password hashing.
 *
 * Argon2id at the OWASP Password Storage Cheat Sheet's second configuration:
 * m=19456 (19 MiB), t=2, p=1.
 *
 * The larger 46 MiB configuration is equally approved but multiplies by the
 * number of concurrent sign-ins, which will exhaust a small VPS — and a small
 * VPS is exactly this project's deployment target. The lower-memory options
 * trade memory hardness for CPU, which favours an attacker with a GPU.
 *
 * The numeric literals for algorithm and version avoid importing the library's
 * ambient `const enum`s, which `isolatedModules` forbids.
 */
const ARGON2ID = 2;
const VERSION_0X13 = 1;

const POLICY = {
  algorithm: ARGON2ID,
  version: VERSION_0X13,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

/**
 * Optional pepper, held outside the database.
 *
 * A stolen database dump alone is then useless. Rotating it invalidates every
 * password at once, so in practice it is append-only.
 */
function pepper(): Uint8Array | undefined {
  const value = process.env.PASSWORD_PEPPER;
  return value ? Buffer.from(value, 'base64') : undefined;
}

/**
 * Argon2 has no length ceiling of its own, unlike bcrypt's silent 72-byte
 * truncation — but an unbounded input is a CPU exhaustion vector.
 */
const MAX_PASSWORD_BYTES = 1024;

export class PasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordError';
  }
}

export async function hashPassword(plaintext: string): Promise<string> {
  if (Buffer.byteLength(plaintext, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new PasswordError('Password is too long.');
  }
  return hash(plaintext, { ...POLICY, secret: pepper() });
}

export interface VerifyResult {
  ok: boolean;
  /** True when the stored hash predates the current policy. */
  needsRehash: boolean;
}

export async function verifyPassword(stored: string, plaintext: string): Promise<VerifyResult> {
  let ok = false;
  try {
    ok = await verify(stored, plaintext, { secret: pepper() });
  } catch {
    // A malformed hash is a failed verification, not a crash.
    return { ok: false, needsRehash: false };
  }

  if (!ok) return { ok: false, needsRehash: false };

  // Upgrade-on-login: if this hash was made under weaker parameters, the
  // caller should re-hash now that it holds the plaintext.
  let needsRehash = false;
  try {
    const parsed = parseOptions(stored);
    needsRehash =
      parsed.algorithm !== POLICY.algorithm ||
      parsed.version !== POLICY.version ||
      parsed.memoryCost < POLICY.memoryCost ||
      parsed.timeCost < POLICY.timeCost ||
      parsed.parallelism !== POLICY.parallelism;
  } catch {
    needsRehash = true;
  }

  return { ok: true, needsRehash };
}

/** Constant-time comparison. Never use `===` on a secret. */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface PasswordStrength {
  ok: boolean;
  problems: string[];
}

/**
 * Length-first policy, per current NIST guidance.
 *
 * Composition rules (one upper, one digit, one symbol) push people toward
 * "Password1!" and are deliberately not enforced. Length and a blocklist of
 * obvious choices do more.
 */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '12345678',
  '123456789',
  'qwertyuiop',
  'letmein',
  'iloveyou',
  'trustno1',
  'dragon',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'welcome',
  'admin',
  'openhaul',
  'trucking',
  'dispatch',
  'freight',
]);

export function checkPasswordStrength(password: string, context: string[] = []): PasswordStrength {
  const problems: string[] = [];
  const normalized = password.toLowerCase();

  if (password.length < 12) {
    problems.push('Use at least 12 characters.');
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    problems.push('Password is too long.');
  }
  if (COMMON_PASSWORDS.has(normalized)) {
    problems.push('That password appears on every breach list. Choose another.');
  }
  if (/^(.)\1+$/.test(password)) {
    problems.push('Use more than one repeated character.');
  }
  for (const item of context) {
    const trimmed = item.trim().toLowerCase();
    if (trimmed.length >= 4 && normalized.includes(trimmed)) {
      problems.push('Do not include your name, email or company in the password.');
      break;
    }
  }

  return { ok: problems.length === 0, problems };
}
