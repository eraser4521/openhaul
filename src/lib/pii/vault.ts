import 'server-only';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { piiVault, subjectKeys } from '../db/schema';
import type { ScopedDb } from '../db/scope';
import type { OrgRole } from '../db/schema';
import { appendAudit, AUDIT } from '../audit/chain';
import {
  blindIndex,
  CDL_INDEX,
  DESTROYED_KEY,
  generateDek,
  KeyDestroyedError,
  openWithDek,
  sealWithDek,
  unwrapDek,
  wrapDek,
} from '../crypto/field';

/**
 * Personal data, held apart from the records that must outlive it.
 *
 * A carrier is required to keep a bill of lading for years and may be required
 * to erase the driver's personal data long before that. Those two obligations
 * only coexist if the data is separable, so nothing personal is inlined on a
 * business row: the driver record carries a `subjectId` and nothing else, and
 * everything identifying lives here sealed under a key that belongs to that
 * one person.
 *
 * Erasure destroys the key rather than the rows. The ciphertext stays, the
 * document hash stays valid, the audit chain stays intact, and the personal
 * data becomes unreadable. Overwriting columns instead would leave the old
 * values in free pages, in the WAL and in every backup — and would break the
 * audit chain if it touched anything the chain commits to.
 *
 * What is *not* here: the driver's display name. The app cannot dispatch a
 * load without something to call the driver, and that name is printed on
 * documents that must be retained anyway. Pretending otherwise would mean an
 * erasure that leaves the name on screen — so the split is stated rather than
 * fudged.
 */

export interface PersonalData {
  /** Full legal name, which is not always the name on the dispatch board. */
  name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  /** ISO date. Stored as text because it is an identifier, not an instant. */
  dob: string | null;
  cdlNumber: string | null;
}

export const EMPTY_PERSONAL_DATA: PersonalData = {
  name: null,
  email: null,
  phone: null,
  address: null,
  dob: null,
  cdlNumber: null,
};

/** Field name to the column that holds its ciphertext. */
const COLUMNS = {
  name: 'name_encrypted',
  email: 'email_encrypted',
  phone: 'phone_encrypted',
  address: 'address_encrypted',
  dob: 'dob_encrypted',
  cdlNumber: 'cdl_number_encrypted',
} as const satisfies Record<keyof PersonalData, string>;

type Field = keyof PersonalData;
const FIELDS = Object.keys(COLUMNS) as Field[];

/** Row shape written to `pii_vault`, keyed by the Drizzle property names. */
const ROW_KEYS = {
  name: 'nameEncrypted',
  email: 'emailEncrypted',
  phone: 'phoneEncrypted',
  address: 'addressEncrypted',
  dob: 'dobEncrypted',
  cdlNumber: 'cdlNumberEncrypted',
} as const satisfies Record<Field, string>;

/** Who is reading, and why. Every decrypt goes on the audit chain. */
export interface Actor {
  userId: string;
  role: OrgRole;
  /** Free text, recorded verbatim: "driver record", "settlement", "erasure". */
  purpose: string;
}

export type SubjectRead =
  | { status: 'live'; data: PersonalData }
  | { status: 'erased'; erasedAt: Date | null; reason: string | null }
  | { status: 'missing' };

function normaliseCdl(value: string): string {
  return CDL_INDEX.transform(value);
}

/**
 * Seals a set of fields under a subject's key.
 *
 * Null clears a field; undefined leaves it alone. The difference matters on an
 * update, where "the driver has no middle name" and "I did not touch the name"
 * are different edits.
 */
function sealAll(
  dek: Buffer,
  orgId: string,
  subjectId: string,
  data: Partial<PersonalData>,
): Record<string, string | null> {
  const row: Record<string, string | null> = {};

  for (const field of FIELDS) {
    const value = data[field];
    if (value === undefined) continue;

    row[ROW_KEYS[field]] =
      value === null || value.trim() === ''
        ? null
        : sealWithDek(dek, { orgId, subjectId, column: COLUMNS[field] }, value.trim());
  }

  return row;
}

/**
 * Creates a subject and returns its id.
 *
 * The data key is generated here, used once, wrapped, and zeroed. It is never
 * returned to a caller and never stored unwrapped.
 */
export async function createSubject(
  scoped: ScopedDb,
  data: Partial<PersonalData>,
): Promise<string> {
  const subjectId = uuidv7();
  const dek = generateDek();

  try {
    const wrapped = wrapDek({ orgId: scoped.orgId, subjectId }, dek);

    await scoped.insert('subjectKeys', { subjectId, wrappedDek: wrapped });
    await scoped.insert('piiVault', {
      subjectId,
      ...sealAll(dek, scoped.orgId, subjectId, data),
      cdlBlindIndex: data.cdlNumber?.trim()
        ? blindIndex(CDL_INDEX, scoped.orgId, data.cdlNumber)
        : null,
    });

    return subjectId;
  } finally {
    // Best effort. V8 may have copied the buffer during the calls above, so
    // this narrows the window rather than closing it.
    dek.fill(0);
  }
}

/**
 * Reads a subject, recording the decrypt.
 *
 * The actor is a required argument rather than something the caller may
 * remember to audit afterwards: an unlogged read of personal data is the one
 * outcome this module exists to prevent.
 */
export async function readSubject(
  scoped: ScopedDb,
  subjectId: string,
  actor: Actor,
): Promise<SubjectRead> {
  const [key, row] = await Promise.all([
    scoped.selectOne('subjectKeys', eq(subjectKeys.subjectId, subjectId)),
    scoped.selectOne('piiVault', eq(piiVault.subjectId, subjectId)),
  ]);

  if (!key || !row) return { status: 'missing' };

  if (key.wrappedDek === DESTROYED_KEY) {
    return { status: 'erased', erasedAt: key.destroyedAt, reason: key.destroyedReason };
  }

  const dek = unwrapDek({ orgId: scoped.orgId, subjectId }, key.wrappedDek);

  try {
    const data = { ...EMPTY_PERSONAL_DATA };

    for (const field of FIELDS) {
      const envelope = row[ROW_KEYS[field]];
      if (!envelope) continue;
      data[field] = openWithDek(
        dek,
        { orgId: scoped.orgId, subjectId, column: COLUMNS[field] },
        envelope,
      );
    }

    await appendAudit({
      orgId: scoped.orgId,
      actorId: actor.userId,
      actorRole: actor.role,
      action: AUDIT.piiDecrypted,
      subject: `subject:${subjectId}`,
      // The values are never in the detail. The record is that a read
      // happened, by whom and for what — not a second copy of the data.
      detail: {
        purpose: actor.purpose,
        fields: FIELDS.filter((field) => data[field] !== null),
      },
    });

    return { status: 'live', data };
  } finally {
    dek.fill(0);
  }
}

export interface SubjectStatus {
  status: 'live' | 'erased' | 'missing';
  erasedAt: Date | null;
}

/**
 * Whether a subject can still be read, without decrypting anything.
 *
 * Screens need to show "erased" and when, and a page load must not perform —
 * or audit — a read nobody asked for. This touches the tombstone only, so
 * rendering a list of drivers costs no decrypts and writes no audit entries.
 */
export async function subjectStatus(
  scoped: ScopedDb,
  subjectId: string,
): Promise<SubjectStatus> {
  const key = await scoped.selectOne('subjectKeys', eq(subjectKeys.subjectId, subjectId));
  if (!key) return { status: 'missing', erasedAt: null };

  return key.wrappedDek === DESTROYED_KEY
    ? { status: 'erased', erasedAt: key.destroyedAt }
    : { status: 'live', erasedAt: null };
}

export async function updateSubject(
  scoped: ScopedDb,
  subjectId: string,
  data: Partial<PersonalData>,
): Promise<{ ok: boolean; error?: string }> {
  const key = await scoped.selectOne('subjectKeys', eq(subjectKeys.subjectId, subjectId));
  if (!key) return { ok: false, error: 'No such person on file.' };

  /*
   * An erased subject cannot be written to. Sealing new data under a fresh key
   * would quietly resurrect a record somebody asked to have destroyed, under
   * the same id, with the tombstone still claiming it was erased.
   */
  if (key.wrappedDek === DESTROYED_KEY) {
    return {
      ok: false,
      error:
        'This person’s data was erased and cannot be written to again. Add them as a new person ' +
        'if they have genuinely returned.',
    };
  }

  const dek = unwrapDek({ orgId: scoped.orgId, subjectId }, key.wrappedDek);

  try {
    const values: Record<string, unknown> = sealAll(dek, scoped.orgId, subjectId, data);

    if (data.cdlNumber !== undefined) {
      values.cdlBlindIndex = data.cdlNumber?.trim()
        ? blindIndex(CDL_INDEX, scoped.orgId, data.cdlNumber)
        : null;
    }

    await scoped.update('piiVault', eq(piiVault.subjectId, subjectId), values);
    return { ok: true };
  } finally {
    dek.fill(0);
  }
}

export interface EraseResult {
  ok: boolean;
  error?: string;
}

/**
 * Destroys a subject's key.
 *
 * Irreversible, and the only operation here that is. The wrapped key is
 * overwritten with a sentinel, the tombstone records when and why, and the
 * ciphertext is left exactly as it was — unreadable, and provably unaltered.
 *
 * The blind index is cleared as part of this. It is an HMAC of the licence
 * number rather than the number itself, but it survives key destruction, and
 * anyone who can read the table could otherwise confirm a guessed licence
 * against it long after the data it points at became unreadable.
 *
 * What this does not reach: a backup taken before the erasure still holds the
 * wrapped key and the ciphertext together. Erasure is complete only once those
 * have aged out of rotation, and the caller is told so rather than left to
 * assume otherwise.
 */
export async function eraseSubject(
  scoped: ScopedDb,
  subjectId: string,
  reason: string,
  actor: Actor,
): Promise<EraseResult> {
  const key = await scoped.selectOne('subjectKeys', eq(subjectKeys.subjectId, subjectId));
  if (!key) return { ok: false, error: 'No such person on file.' };

  if (key.wrappedDek === DESTROYED_KEY) {
    // Idempotent: a second request is not an error, and re-stamping the date
    // would falsify when the first one happened.
    return { ok: true };
  }

  const erasedAt = new Date();

  await scoped.update('subjectKeys', eq(subjectKeys.subjectId, subjectId), {
    wrappedDek: DESTROYED_KEY,
    destroyedAt: erasedAt,
    destroyedReason: reason,
  });

  await scoped.update('piiVault', eq(piiVault.subjectId, subjectId), {
    cdlBlindIndex: null,
    redactedAt: erasedAt,
    redactionReason: reason,
  });

  await appendAudit({
    orgId: scoped.orgId,
    actorId: actor.userId,
    actorRole: actor.role,
    action: AUDIT.piiErased,
    subject: `subject:${subjectId}`,
    detail: { reason, purpose: actor.purpose, erasedAt: erasedAt.toISOString() },
  });

  return { ok: true };
}

/**
 * Finds a person by licence number.
 *
 * The stored index is a 16-bit truncated HMAC, so a match is a candidate
 * rather than an answer — the truncation is deliberate, because a full-width
 * index of a high-entropy identifier is close to plaintext for anyone who can
 * read the column. Candidates are confirmed by decrypting, which is why this
 * takes an actor: confirming is a read of personal data like any other.
 */
export async function findSubjectByCdl(
  scoped: ScopedDb,
  cdlNumber: string,
  actor: Actor,
): Promise<string[]> {
  const wanted = normaliseCdl(cdlNumber);
  if (!wanted) return [];

  const index = blindIndex(CDL_INDEX, scoped.orgId, cdlNumber);
  const candidates = await scoped.select('piiVault', eq(piiVault.cdlBlindIndex, index));

  const matched: string[] = [];

  for (const candidate of candidates) {
    const read = await readSubject(scoped, candidate.subjectId, actor).catch(() => null);
    if (read?.status !== 'live' || !read.data.cdlNumber) continue;
    if (normaliseCdl(read.data.cdlNumber) === wanted) matched.push(candidate.subjectId);
  }

  return matched;
}

export { KeyDestroyedError };
