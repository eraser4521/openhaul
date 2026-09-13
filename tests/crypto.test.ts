import { beforeAll, describe, expect, it } from 'vitest';
import {
  blindIndex,
  blindIndexEquals,
  CDL_INDEX,
  CryptoConfigError,
  decryptField,
  DecryptionError,
  encryptField,
  envelopeVersion,
  generateRootKey,
  parseKeyring,
  rotateField,
  setKeyringForTesting,
  type FieldRef,
  type Keyring,
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
