import 'server-only';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Field-level encryption for personal data.
 *
 * Done in the application rather than in the database. A database function
 * would need the key passed in the query text, and Postgres and SQLite both
 * log query parameters under common debugging configurations — which would
 * write the encryption key and the plaintext into the same log file.
 */

const ALGORITHM = 'aes-256-gcm';
/** 96-bit nonce, the only length GCM consumes without running it through GHASH. */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HKDF_SALT = Buffer.from('openhaul.hkdf.v1');

const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');

export class CryptoConfigError extends Error {
  constructor(message: string) {
    super(`crypto config: ${message}`);
    this.name = 'CryptoConfigError';
  }
}

export class DecryptionError extends Error {
  constructor(message: string) {
    super(`decryption failed: ${message}`);
    this.name = 'DecryptionError';
  }
}

export interface Keyring {
  /** Version used for new ciphertexts. */
  current: number;
  /**
   * Version used for new blind indexes. Rotated independently and rarely,
   * because rotating it invalidates every stored index value at once.
   */
  indexVersion: number;
  keys: ReadonlyMap<number, Buffer>;
}

/**
 * Parses `OPENHAUL_KEYS`, formatted as `v2:<base64>,v1:<base64>` with the
 * newest first. Adding a key is a rotation; old ciphertexts stay readable
 * because every envelope names the version that sealed it.
 */
export function parseKeyring(raw: string | undefined): Keyring {
  if (!raw || raw.trim().length === 0) {
    throw new CryptoConfigError(
      'OPENHAUL_KEYS is not set. Run `npm run keys:generate` to create one.',
    );
  }

  const keys = new Map<number, Buffer>();
  let newest = -1;

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;

    const separator = trimmed.indexOf(':');
    if (separator === -1) {
      throw new CryptoConfigError(`entry "${trimmed.slice(0, 8)}…" is missing a version label`);
    }

    const label = trimmed.slice(0, separator);
    const match = /^v(\d+)$/.exec(label);
    if (!match?.[1]) {
      throw new CryptoConfigError(`"${label}" is not a valid version label (expected v1, v2, …)`);
    }

    const version = Number.parseInt(match[1], 10);
    const key = Buffer.from(trimmed.slice(separator + 1), 'base64');
    if (key.length !== KEY_BYTES) {
      throw new CryptoConfigError(`key v${version} is ${key.length} bytes, expected ${KEY_BYTES}`);
    }

    keys.set(version, key);
    if (version > newest) newest = version;
  }

  if (keys.size === 0) throw new CryptoConfigError('no usable keys found');

  const indexVersionRaw = process.env.OPENHAUL_INDEX_KEY_VERSION;
  const indexVersion = indexVersionRaw ? Number.parseInt(indexVersionRaw, 10) : 1;
  if (!keys.has(indexVersion)) {
    throw new CryptoConfigError(
      `blind-index key version v${indexVersion} is not in the keyring. ` +
        'Rotating it requires re-indexing every blind-index column, so it is pinned separately.',
    );
  }

  return { current: newest, indexVersion, keys };
}

let cachedKeyring: Keyring | null = null;

export function keyring(): Keyring {
  cachedKeyring ??= parseKeyring(process.env.OPENHAUL_KEYS);
  return cachedKeyring;
}

/** Test seam. */
export function setKeyringForTesting(ring: Keyring | null): void {
  cachedKeyring = ring;
}

/**
 * Derived-subkey cache, partitioned per keyring.
 *
 * Keyed on the keyring object rather than on the version number alone: two
 * keyrings can both hold a "v1" backed by entirely different root key
 * material, and a cache keyed only on (version, purpose) would hand the
 * second one the first one's derived key. That would make decryption silently
 * succeed against the wrong root — the exact failure a wrong-key check exists
 * to catch.
 */
const subkeyCache = new WeakMap<Keyring, Map<string, Buffer>>();

/**
 * Derives a purpose-specific subkey, so the key protecting licence numbers is
 * cryptographically unrelated to the one protecting dates of birth.
 */
function subkey(ring: Keyring, version: number, purpose: string): Buffer {
  let perRing = subkeyCache.get(ring);
  if (!perRing) {
    perRing = new Map();
    subkeyCache.set(ring, perRing);
  }

  const cacheKey = `${version}|${purpose}`;
  const cached = perRing.get(cacheKey);
  if (cached) return cached;

  const root = ring.keys.get(version);
  if (!root) throw new DecryptionError(`unknown key version v${version}`);

  const derived = Buffer.from(
    hkdfSync('sha256', root, HKDF_SALT, Buffer.from(purpose, 'utf8'), KEY_BYTES),
  );
  perRing.set(cacheKey, derived);
  return derived;
}

export interface FieldRef {
  orgId: string;
  table: string;
  column: string;
  rowId: string;
}

/**
 * Additional authenticated data, binding the ciphertext to its exact location.
 *
 * Without this, anyone who can write to one column can copy an encrypted
 * licence number from one driver's row into another's, and it will decrypt
 * cleanly. Components are length-prefixed so ("ab","c") and ("a","bc") cannot
 * produce the same byte string.
 */
function additionalData(ref: FieldRef, version: number): Buffer {
  const parts = [String(version), ref.orgId, ref.table, ref.column, ref.rowId];
  return Buffer.from(parts.map((p) => `${p.length}:${p}`).join('|'), 'utf8');
}

const fieldPurpose = (ref: FieldRef) => `field:${ref.table}.${ref.column}`;

/**
 * Seals a value. Envelope format: `v<N>:<iv>:<tag>:<ciphertext>`, all
 * base64url. Self-describing, so rotation never orphans old data.
 */
export function encryptField(ref: FieldRef, plaintext: string, ring = keyring()): string {
  const version = ring.current;
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, subkey(ring, version, fieldPurpose(ref)), iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(additionalData(ref, version));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v${version}:${b64(iv)}:${b64(cipher.getAuthTag())}:${b64(ciphertext)}`;
}

export function decryptField(ref: FieldRef, envelope: string, ring = keyring()): string {
  const parts = envelope.split(':');
  if (parts.length !== 4) throw new DecryptionError('malformed envelope');

  const [label, ivPart, tagPart, ctPart] = parts as [string, string, string, string];
  const match = /^v(\d+)$/.exec(label);
  if (!match?.[1]) throw new DecryptionError('bad key version label');

  const version = Number.parseInt(match[1], 10);
  const iv = unb64(ivPart);
  const tag = unb64(tagPart);
  if (iv.length !== IV_BYTES) throw new DecryptionError('bad iv length');
  if (tag.length !== TAG_BYTES) throw new DecryptionError('bad auth tag length');

  const decipher = createDecipheriv(ALGORITHM, subkey(ring, version, fieldPurpose(ref)), iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(additionalData(ref, version));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(unb64(ctPart)), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, tampered ciphertext, or a row/column/tenant mismatch. Never
    // echo the underlying error, and never retry against another key version
    // without also re-deriving the AAD.
    throw new DecryptionError('authentication failed');
  }
}

/** Re-seals under the current key. Same AAD, fresh IV. */
export function rotateField(ref: FieldRef, envelope: string, ring = keyring()): string {
  return encryptField(ref, decryptField(ref, envelope, ring), ring);
}

/** Returns the key version that sealed an envelope, for backfill queries. */
export function envelopeVersion(envelope: string): number | null {
  const match = /^v(\d+):/.exec(envelope);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

/* -------------------------------------------------------------------------
 * Per-subject keys
 * ---------------------------------------------------------------------- */

/**
 * Envelope encryption, and why it is not HKDF.
 *
 * Everything above derives its key from the root with HKDF. That is right for
 * data the carrier must always be able to read, and exactly wrong for personal
 * data, because a derived key cannot be destroyed: anyone holding the root can
 * re-derive `HKDF(root, subject)` forever, so there would be nothing to delete
 * and an erasure request could not be satisfied.
 *
 * So each data subject gets a **random** key, stored only in wrapped form.
 * Destroying that one stored value is what makes every ciphertext for that
 * person permanently unreadable, while the bill of lading, its content hash
 * and the audit chain stay exactly as they were.
 *
 * The wrapped key is versioned and the field ciphertexts are not. Rotating the
 * root therefore re-wraps one short string per subject and never rewrites a
 * single field — which is the other reason this shape is worth the extra
 * indirection.
 */

/** Format version of a DEK-sealed field. Bumped only if the AAD shape changes. */
const DEK_FORMAT = 1;

/** Label on a DEK-sealed envelope, so it can never be fed to `decryptField`. */
const DEK_LABEL = 'k1';

const SUBJECT_DEK_PURPOSE = 'subject:dek-wrap';

/**
 * What a destroyed key leaves behind.
 *
 * The row stays so the tombstone can prove a key existed and when it was
 * destroyed; `wrappedDek` is not nullable precisely so this cannot be confused
 * with a key that was never written.
 */
export const DESTROYED_KEY = 'destroyed';

export class KeyDestroyedError extends Error {
  constructor(subjectId: string) {
    super(`subject key destroyed: ${subjectId}`);
    this.name = 'KeyDestroyedError';
  }
}

export interface SubjectRef {
  orgId: string;
  subjectId: string;
}

/** A fresh data key. Random, never derived — see the note above. */
export function generateDek(): Buffer {
  return randomBytes(KEY_BYTES);
}

const wrapRef = (ref: SubjectRef): FieldRef => ({
  orgId: ref.orgId,
  table: 'subject_keys',
  column: 'wrapped_dek',
  rowId: ref.subjectId,
});

/** Seals a data key under the root. The envelope names the root version. */
export function wrapDek(ref: SubjectRef, dek: Buffer, ring = keyring()): string {
  if (dek.length !== KEY_BYTES) throw new CryptoConfigError('data key must be 32 bytes');

  const version = ring.current;
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, subkey(ring, version, SUBJECT_DEK_PURPOSE), iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(additionalData(wrapRef(ref), version));

  const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
  return `v${version}:${b64(iv)}:${b64(cipher.getAuthTag())}:${b64(wrapped)}`;
}

export function unwrapDek(ref: SubjectRef, wrapped: string, ring = keyring()): Buffer {
  // Distinguished from a malformed envelope on purpose: "this person was
  // erased" and "this ciphertext is broken" are different answers, and only
  // one of them is a bug.
  if (wrapped === DESTROYED_KEY) throw new KeyDestroyedError(ref.subjectId);

  const parts = wrapped.split(':');
  if (parts.length !== 4) throw new DecryptionError('malformed key envelope');

  const [label, ivPart, tagPart, ctPart] = parts as [string, string, string, string];
  const match = /^v(\d+)$/.exec(label);
  if (!match?.[1]) throw new DecryptionError('bad key version label');

  const version = Number.parseInt(match[1], 10);
  const iv = unb64(ivPart);
  const tag = unb64(tagPart);
  if (iv.length !== IV_BYTES) throw new DecryptionError('bad iv length');
  if (tag.length !== TAG_BYTES) throw new DecryptionError('bad auth tag length');

  const decipher = createDecipheriv(ALGORITHM, subkey(ring, version, SUBJECT_DEK_PURPOSE), iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(additionalData(wrapRef(ref), version));
  decipher.setAuthTag(tag);

  let dek: Buffer;
  try {
    dek = Buffer.concat([decipher.update(unb64(ctPart)), decipher.final()]);
  } catch {
    throw new DecryptionError('authentication failed');
  }

  if (dek.length !== KEY_BYTES) throw new DecryptionError('unwrapped key is the wrong length');
  return dek;
}

/**
 * Re-seals a data key under the current root version.
 *
 * The whole cost of a root rotation: one short string per subject. No field
 * ciphertext is touched, because none of them were sealed with the root.
 */
export function rewrapDek(ref: SubjectRef, wrapped: string, ring = keyring()): string {
  const dek = unwrapDek(ref, wrapped, ring);
  try {
    return wrapDek(ref, dek, ring);
  } finally {
    dek.fill(0);
  }
}

export interface VaultFieldRef extends SubjectRef {
  /** Column in `pii_vault`, so one field's ciphertext cannot be moved to another. */
  column: string;
}

const vaultRef = (ref: VaultFieldRef): FieldRef => ({
  orgId: ref.orgId,
  table: 'pii_vault',
  column: ref.column,
  rowId: ref.subjectId,
});

/** Seals one personal field under that subject's data key. */
export function sealWithDek(dek: Buffer, ref: VaultFieldRef, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, dek, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(additionalData(vaultRef(ref), DEK_FORMAT));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${DEK_LABEL}:${b64(iv)}:${b64(cipher.getAuthTag())}:${b64(ciphertext)}`;
}

export function openWithDek(dek: Buffer, ref: VaultFieldRef, envelope: string): string {
  const parts = envelope.split(':');
  if (parts.length !== 4) throw new DecryptionError('malformed envelope');

  const [label, ivPart, tagPart, ctPart] = parts as [string, string, string, string];
  if (label !== DEK_LABEL) throw new DecryptionError('not a subject-sealed envelope');

  const iv = unb64(ivPart);
  const tag = unb64(tagPart);
  if (iv.length !== IV_BYTES) throw new DecryptionError('bad iv length');
  if (tag.length !== TAG_BYTES) throw new DecryptionError('bad auth tag length');

  const decipher = createDecipheriv(ALGORITHM, dek, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(additionalData(vaultRef(ref), DEK_FORMAT));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(unb64(ctPart)), decipher.final()]).toString('utf8');
  } catch {
    throw new DecryptionError('authentication failed');
  }
}

/* -------------------------------------------------------------------------
 * Blind indexes
 * ---------------------------------------------------------------------- */

export interface BlindIndexSpec {
  table: string;
  column: string;
  name: string;
  /** Truncation width. Narrower leaks less and costs more false positives. */
  bits: 8 | 16 | 24 | 32;
  transform: (value: string) => string;
}

/**
 * Exact-match lookup for a commercial driver's licence number.
 *
 * Org-scoped, so two carriers employing the same driver produce different
 * index values — which removes cross-tenant frequency analysis and means one
 * carrier cannot probe whether a driver also works somewhere else.
 *
 * There is deliberately no equivalent for date of birth, social security
 * number, or bank details: those domains are small enough that an index over
 * them is close to plaintext, and nothing in the app searches by them.
 */
export const CDL_INDEX: BlindIndexSpec = {
  table: 'pii_vault',
  column: 'cdl_number',
  name: 'exact',
  bits: 16,
  transform: (v) => v.replace(/[^A-Za-z0-9]/g, '').toUpperCase(),
};

export function blindIndex(
  spec: BlindIndexSpec,
  orgId: string,
  plaintext: string,
  ring = keyring(),
): string {
  const key = subkey(ring, ring.indexVersion, `bidx:${spec.table}.${spec.column}.${spec.name}`);
  // A NUL separator cannot be forged from the value itself, because the
  // transform strips everything outside [A-Z0-9]. Written as an escape rather
  // than a literal NUL byte: the two are identical at runtime, and a literal
  // one does not survive a careless editor round-trip — which would silently
  // change every index value already stored.
  const input = `${orgId}\0${spec.transform(plaintext)}`;

  return createHmac('sha256', key)
    .update(input, 'utf8')
    .digest()
    .subarray(0, spec.bits / 8)
    .toString('hex');
}

/** Constant-time comparison, for the rare case of comparing in JS not SQL. */
export function blindIndexEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Generates a fresh 32-byte root key, base64 encoded. */
export function generateRootKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}
