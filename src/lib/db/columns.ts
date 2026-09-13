import { integer, text } from 'drizzle-orm/sqlite-core';
import { uuidv7 } from 'uuidv7';

/**
 * Shared column builders.
 *
 * Keeping these in one place means a decision like "money is integer cents"
 * is made once and cannot drift table by table.
 */

/**
 * Primary key: UUIDv7 stored as TEXT.
 *
 * v7 rather than v4 because the leading 48 bits are a millisecond timestamp,
 * so keys sort chronologically. In SQLite that keeps B-tree inserts at the
 * right edge instead of fragmenting the index, and it gives photos a natural
 * capture order for free.
 *
 * TEXT rather than BLOB(16): 2.2x the bytes, but greppable in logs and
 * readable from the `sqlite3` shell. At a carrier's data volume the space
 * difference is irrelevant and the debuggability is not.
 */
export const pk = (name = 'id') =>
  text(name)
    .primaryKey()
    .$defaultFn(() => uuidv7());

/** A UUIDv7 for a non-primary-key column. */
export const id = (name: string) => text(name).$defaultFn(() => uuidv7());

/**
 * Money is ALWAYS integer minor units (cents). Never REAL.
 *
 * SQLite REAL is IEEE-754 binary floating point, where 0.1 + 0.2 !== 0.3.
 * A rounding error on a bill of lading is an accounting and legal problem,
 * not a cosmetic one.
 */
export const money = (name: string) => integer(name);

/** ISO 4217 code stored alongside every amount. Cross-border hauls exist. */
export const currency = (name = 'currency') => text(name).notNull().default('USD');

/**
 * Timestamps are epoch milliseconds in UTC.
 *
 * Not TEXT ISO strings: those cost three times the bytes, cannot be range
 * scanned from an index efficiently, and invite timezone ambiguity.
 */
export const ts = (name: string) => integer(name, { mode: 'timestamp_ms' });

/** SQLite has no boolean type; Drizzle maps 0/1 through this mode. */
export const bool = (name: string) => integer(name, { mode: 'boolean' });

/** A typed JSON column. */
export const json = <T>(name: string) => text(name, { mode: 'json' }).$type<T>();

/**
 * An encrypted field. Holds the envelope produced by `encryptField`, in the
 * form `v<N>.<keyId>.<iv>.<tag>.<ciphertext>` — never plaintext.
 */
export const encrypted = (name: string) => text(name);

/** Created/updated pair applied to nearly every table. */
export const timestamps = {
  createdAt: ts('created_at')
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: ts('updated_at')
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
};

/**
 * Tenant discriminator.
 *
 * Every row a carrier owns carries this. SQLite has no row-level security, so
 * isolation is enforced by the scoped query client in `src/lib/db/scope.ts`
 * plus composite foreign keys on (org_id, id).
 */
export const orgId = () => text('org_id').notNull();
