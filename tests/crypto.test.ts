import { beforeAll, describe, expect, it } from 'vitest';
import {
  blindIndex,
  blindIndexEquals,
  CDL_INDEX,
  CryptoConfigError,
  decryptField,
  DecryptionError,
  DESTROYED_KEY,
  encryptField,
  envelopeVersion,
  generateDek,
  generateRootKey,
  KeyDestroyedError,
  openWithDek,
  parseKeyring,
  rewrapDek,
  rotateField,
  sealWithDek,
  setKeyringForTesting,
  unwrapDek,
  wrapDek,
  type FieldRef,
  type Keyring,
  type SubjectRef,
} from '@/lib/crypto/field';

const KEY_V1 = Buffer.alloc(32, 1).toString('base64');
const KEY_V2 = Buffer.alloc(32, 2).toString('base64');

let ring: Keyring;
let ringV2: Keyring;

const ref: FieldRef = {
  orgId: 'org-alpha',
  table: 'pii_vault',
  column: 'cdl_number',
  rowId: 'row-1',
};

beforeAll(() => {
  process.env.OPENHAUL_INDEX_KEY_VERSION = '1';
  ring = parseKeyring(`v1:${KEY_V1}`);
  ringV2 = parseKeyring(`v2:${KEY_V2},v1:${KEY_V1}`);
  setKeyringForTesting(ring);
});

describe('parseKeyring', () => {
  it('selects the highest version as current', () => {
    expect(ringV2.current).toBe(2);
    expect(ringV2.keys.size).toBe(2);
  });

  it('pins the blind-index version separately from the field version', () => {
    // Rotating the index key invalidates every stored index, so it must not
    // move just because a new field key was added.
    expect(ringV2.indexVersion).toBe(1);
  });

  it('rejects an empty configuration', () => {
    expect(() => parseKeyring(undefined)).toThrow(CryptoConfigError);
    expect(() => parseKeyring('   ')).toThrow(CryptoConfigError);
  });

  it('rejects a key of the wrong length', () => {
    const short = Buffer.alloc(16, 9).toString('base64');
    expect(() => parseKeyring(`v1:${short}`)).toThrow(/32/);
  });

  it('rejects a malformed version label', () => {
    expect(() => parseKeyring(`vX:${KEY_V1}`)).toThrow(/version label/);
  });

  it('rejects an index version that is not in the keyring', () => {
    process.env.OPENHAUL_INDEX_KEY_VERSION = '7';
    expect(() => parseKeyring(`v1:${KEY_V1}`)).toThrow(/v7/);
    process.env.OPENHAUL_INDEX_KEY_VERSION = '1';
  });
});

describe('encryptField / decryptField', () => {
  it('round-trips a value', () => {
    const sealed = encryptField(ref, 'D1234567', ring);
    expect(decryptField(ref, sealed, ring)).toBe('D1234567');
  });

  it('never stores the plaintext', () => {
    const sealed = encryptField(ref, 'D1234567', ring);
    expect(sealed).not.toContain('D1234567');
  });

  it('produces a different ciphertext each time', () => {
    // A fresh IV per call. Deterministic ciphertext would leak an equality
    // map of the whole column to anyone holding a database dump.
    const a = encryptField(ref, 'SAME VALUE', ring);
    const b = encryptField(ref, 'SAME VALUE', ring);
    expect(a).not.toBe(b);
    expect(decryptField(ref, a, ring)).toBe(decryptField(ref, b, ring));
  });

  it('stamps the key version into the envelope', () => {
    expect(envelopeVersion(encryptField(ref, 'x', ring))).toBe(1);
    expect(envelopeVersion(encryptField(ref, 'x', ringV2))).toBe(2);
  });

  it('handles unicode and empty strings', () => {
    for (const value of ['', 'Ærø Ångström 日本語', '🚛']) {
      expect(decryptField(ref, encryptField(ref, value, ring), ring)).toBe(value);
    }
  });
});

describe('AAD binding', () => {
  const sealed = () => encryptField(ref, 'D1234567', ring);

  it('refuses a ciphertext moved to another row', () => {
    // The attack this blocks: anyone who can write one column copies an
    // encrypted licence number from one driver's row into another's.
    expect(() => decryptField({ ...ref, rowId: 'row-2' }, sealed(), ring)).toThrow(DecryptionError);
  });

  it('refuses a ciphertext moved to another column', () => {
    expect(() => decryptField({ ...ref, column: 'dob' }, sealed(), ring)).toThrow(DecryptionError);
  });

  it('refuses a ciphertext moved to another organisation', () => {
    expect(() => decryptField({ ...ref, orgId: 'org-beta' }, sealed(), ring)).toThrow(
      DecryptionError,
    );
  });

  it('refuses a ciphertext moved to another table', () => {
    expect(() => decryptField({ ...ref, table: 'drivers' }, sealed(), ring)).toThrow(
      DecryptionError,
    );
  });

  it('cannot be fooled by shifting a separator between components', () => {
    // Components are length-prefixed, so ("ab","c") and ("a","bc") cannot
    // collapse to the same authenticated byte string.
    const a = encryptField({ ...ref, table: 'ab', column: 'c' }, 'secret', ring);
    expect(() => decryptField({ ...ref, table: 'a', column: 'bc' }, a, ring)).toThrow(
      DecryptionError,
    );
  });
});

describe('tamper detection', () => {
  it('rejects a modified ciphertext', () => {
    const sealed = encryptField(ref, 'D1234567', ring);
    const parts = sealed.split(':');
    const ct = Buffer.from(parts[3] as string, 'base64url');
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    parts[3] = ct.toString('base64url');
    expect(() => decryptField(ref, parts.join(':'), ring)).toThrow(/authentication failed/);
  });

  it('rejects a modified auth tag', () => {
    const sealed = encryptField(ref, 'D1234567', ring);
    const parts = sealed.split(':');
    const tag = Buffer.from(parts[2] as string, 'base64url');
    tag[0] = (tag[0] ?? 0) ^ 0xff;
    parts[2] = tag.toString('base64url');
    expect(() => decryptField(ref, parts.join(':'), ring)).toThrow(/authentication failed/);
  });

  it('rejects a wrong key', () => {
    const sealed = encryptField(ref, 'D1234567', ring);
    const otherRing = parseKeyring(`v1:${KEY_V2}`);
    expect(() => decryptField(ref, sealed, otherRing)).toThrow(/authentication failed/);
  });

  it('rejects a malformed envelope', () => {
    expect(() => decryptField(ref, 'not-an-envelope', ring)).toThrow(/malformed/);
    expect(() => decryptField(ref, 'x:y:z:w', ring)).toThrow(/version label/);
  });
});

describe('key rotation', () => {
  it('reads a v1 ciphertext with a keyring whose current is v2', () => {
    const old = encryptField(ref, 'D1234567', ring);
    expect(decryptField(ref, old, ringV2)).toBe('D1234567');
  });

  it('re-seals under the newest key without changing the value', () => {
    const old = encryptField(ref, 'D1234567', ring);
    const rotated = rotateField(ref, old, ringV2);
    expect(envelopeVersion(rotated)).toBe(2);
    expect(decryptField(ref, rotated, ringV2)).toBe('D1234567');
  });
});

describe('blind index', () => {
  it('is deterministic for the same input', () => {
    const a = blindIndex(CDL_INDEX, 'org-alpha', 'D1234567', ring);
    const b = blindIndex(CDL_INDEX, 'org-alpha', 'D1234567', ring);
    expect(a).toBe(b);
    expect(blindIndexEquals(a, b)).toBe(true);
  });

  it('normalises formatting differences', () => {
    const plain = blindIndex(CDL_INDEX, 'org-alpha', 'D1234567', ring);
    expect(blindIndex(CDL_INDEX, 'org-alpha', 'd123-4567', ring)).toBe(plain);
    expect(blindIndex(CDL_INDEX, 'org-alpha', ' D 123 4567 ', ring)).toBe(plain);
  });

  it('differs across organisations for the same licence', () => {
    // Removes cross-tenant frequency analysis, and stops one carrier probing
    // whether a driver also works for another.
    const alpha = blindIndex(CDL_INDEX, 'org-alpha', 'D1234567', ring);
    const beta = blindIndex(CDL_INDEX, 'org-beta', 'D1234567', ring);
    expect(alpha).not.toBe(beta);
  });

  it('truncates to the configured width', () => {
    // 16 bits => 2 bytes => 4 hex characters.
    expect(blindIndex(CDL_INDEX, 'org-alpha', 'D1234567', ring)).toHaveLength(4);
  });

  it('does not reveal the plaintext', () => {
    expect(blindIndex(CDL_INDEX, 'org-alpha', 'D1234567', ring)).not.toContain('1234567');
  });

  it('produces the same value it produced yesterday', () => {
    /*
     * A change detector, not a correctness check. Every assertion above is
     * relative, so none of them would notice the input format shifting — and
     * the separator between the organisation and the licence was a literal NUL
     * byte in the source until recently, which one careless save would have
     * dropped. That would not fail anything here, and would silently stop
     * every already-stored index from ever matching again.
     *
     * Verified independently rather than snapshotted from the code it tests:
     * HMAC-SHA256 over "org-alpha\0D1234567", keyed by
     * HKDF-SHA256(32 x 0x01, salt "openhaul.hkdf.v1",
     * info "bidx:pii_vault.cdl_number.exact"), truncated to two bytes, is
     * 75de. Dropping the separator gives 8aa2.
     */
    expect(blindIndex(CDL_INDEX, 'org-alpha', 'D1234567', ring)).toBe('75de');
  });
});

describe('generateRootKey', () => {
  it('produces a 32-byte key the parser accepts', () => {
    const key = generateRootKey();
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
    expect(() => parseKeyring(`v1:${key}`)).not.toThrow();
  });

  it('produces a different key each call', () => {
    expect(generateRootKey()).not.toBe(generateRootKey());
  });
});


/* -------------------------------------------------------------------------
 * Per-subject keys
 * ---------------------------------------------------------------------- */

const subject: SubjectRef = { orgId: 'org-alpha', subjectId: 'subject-1' };

describe('wrapping a subject key', () => {
  it('round-trips the key it was given', () => {
    const dek = generateDek();
    const wrapped = wrapDek(subject, dek, ring);

    expect(unwrapDek(subject, wrapped, ring).equals(dek)).toBe(true);
  });

  it('produces a different envelope every time', () => {
    const dek = generateDek();
    expect(wrapDek(subject, dek, ring)).not.toBe(wrapDek(subject, dek, ring));
  });

  it('refuses to unwrap for a different person', () => {
    // The whole model rests on this: if one subject's wrapped key opened under
    // another's id, erasing one person would not be erasing that person.
    const wrapped = wrapDek(subject, generateDek(), ring);

    expect(() => unwrapDek({ ...subject, subjectId: 'subject-2' }, wrapped, ring)).toThrow(
      DecryptionError,
    );
  });

  it('refuses to unwrap for a different organisation', () => {
    const wrapped = wrapDek(subject, generateDek(), ring);

    expect(() => unwrapDek({ ...subject, orgId: 'org-beta' }, wrapped, ring)).toThrow(
      DecryptionError,
    );
  });

  it('says a destroyed key is destroyed rather than broken', () => {
    // Two different answers for the caller: one is a person who was erased,
    // the other is a bug.
    expect(() => unwrapDek(subject, DESTROYED_KEY, ring)).toThrow(KeyDestroyedError);
  });

  it('rejects a key of the wrong length', () => {
    expect(() => wrapDek(subject, Buffer.alloc(16, 7), ring)).toThrow(CryptoConfigError);
  });
});

describe('rotating the root', () => {
  it('re-wraps the key without touching any field ciphertext', () => {
    /*
     * The reason for the indirection. A root rotation rewrites one short
     * string per person; the sealed fields, of which there may be millions,
     * are never read or written.
     */
    const dek = generateDek();
    const wrapped = wrapDek(subject, dek, ring);
    const sealed = sealWithDek(dek, { ...subject, column: 'cdl_number' }, 'D1234567');

    const rewrapped = rewrapDek(subject, wrapped, ringV2);

    expect(rewrapped).not.toBe(wrapped);
    expect(envelopeVersion(rewrapped)).toBe(2);

    const recovered = unwrapDek(subject, rewrapped, ringV2);
    expect(openWithDek(recovered, { ...subject, column: 'cdl_number' }, sealed)).toBe('D1234567');
  });
});

describe('sealing a field under a subject key', () => {
  const dek = generateDek();
  const field = { ...subject, column: 'cdl_number' };

  it('round-trips', () => {
    expect(openWithDek(dek, field, sealWithDek(dek, field, 'D1234567'))).toBe('D1234567');
  });

  it('produces different ciphertext for the same value', () => {
    expect(sealWithDek(dek, field, 'D1234567')).not.toBe(sealWithDek(dek, field, 'D1234567'));
  });

  it('will not open under another subject key', () => {
    const sealed = sealWithDek(dek, field, 'D1234567');
    expect(() => openWithDek(generateDek(), field, sealed)).toThrow(DecryptionError);
  });

  it('will not open as a different column', () => {
    // Otherwise a date of birth could be moved into the licence column and
    // would read out cleanly as a licence number.
    const sealed = sealWithDek(dek, field, 'D1234567');
    expect(() => openWithDek(dek, { ...field, column: 'dob' }, sealed)).toThrow(DecryptionError);
  });

  it('will not open for a different person', () => {
    const sealed = sealWithDek(dek, field, 'D1234567');
    expect(() => openWithDek(dek, { ...field, subjectId: 'subject-2' }, sealed)).toThrow(
      DecryptionError,
    );
  });

  it('will not open for a different organisation', () => {
    const sealed = sealWithDek(dek, field, 'D1234567');
    expect(() => openWithDek(dek, { ...field, orgId: 'org-beta' }, sealed)).toThrow(
      DecryptionError,
    );
  });
});

describe('the two encryption schemes cannot be confused', () => {
  it('will not open a root-sealed field with a data key', () => {
    const sealed = encryptField(ref, 'D1234567', ring);
    expect(() => openWithDek(generateDek(), { ...subject, column: 'cdl_number' }, sealed)).toThrow(
      DecryptionError,
    );
  });

  it('will not open a subject-sealed field with the root', () => {
    // A `k1:` label can never satisfy the `v<N>` parser, so this fails at the
    // label rather than deep inside a cipher with the wrong key.
    const sealed = sealWithDek(generateDek(), { ...subject, column: 'cdl_number' }, 'D1234567');
    expect(() => decryptField(ref, sealed, ring)).toThrow(DecryptionError);
  });
});
