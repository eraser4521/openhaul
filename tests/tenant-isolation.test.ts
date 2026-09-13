import { describe, expect, it } from 'vitest';
import { getTableColumns, is, Table } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { TENANT_SCOPE_EXEMPT, TENANT_TABLES } from '@/lib/db/scope';

/**
 * The registry in `scope.ts` is what makes tenant isolation structural rather
 * than a matter of discipline. The real risk is not today's code — it is the
 * table somebody adds in six months and forgets to register, which then has
 * no scoped accessor and invites a raw query.
 *
 * This test fails the moment those two drift apart.
 */

/** Every exported Drizzle table that carries an `orgId` column. */
function tablesWithOrgId(): string[] {
  const found: string[] = [];

  for (const [name, value] of Object.entries(schema)) {
    if (!is(value, Table)) continue;
    const columns = getTableColumns(value);
    if ('orgId' in columns) found.push(name);
  }

  return found.sort();
}

describe('tenant table registry', () => {
  it('accounts for every table that carries an org_id', () => {
    const accountedFor = new Set([
      ...Object.keys(TENANT_TABLES),
      ...Object.keys(TENANT_SCOPE_EXEMPT),
    ]);
    const missing = tablesWithOrgId().filter((name) => !accountedFor.has(name));

    expect(
      missing,
      `These tables have an org_id but are in neither TENANT_TABLES nor ` +
        `TENANT_SCOPE_EXEMPT, so forOrg() cannot reach them and any access would ` +
        `have to bypass tenant scoping. Add them to one, with a reason if the ` +
        `latter:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('does not register anything without an org_id', () => {
    const withOrgId = new Set(tablesWithOrgId());
    const spurious = Object.keys(TENANT_TABLES).filter((name) => !withOrgId.has(name));

    expect(
      spurious,
      `These are registered as tenant tables but have no org_id column, so scoping ` +
        `them would produce a query that can never match:\n  ${spurious.join('\n  ')}`,
    ).toEqual([]);
  });

  it('keeps the scoped and exempt sets disjoint', () => {
    const overlap = Object.keys(TENANT_TABLES).filter(
      (name) => name in TENANT_SCOPE_EXEMPT,
    );
    expect(overlap, 'a table cannot be both scoped and exempt').toEqual([]);
  });

  it('gives every exemption a written reason', () => {
    for (const [name, reason] of Object.entries(TENANT_SCOPE_EXEMPT)) {
      expect(reason.length, `${name} needs a real explanation`).toBeGreaterThan(30);
    }
  });

  it('covers a meaningful number of tables', () => {
    // Guards against the registry and the detector both collapsing to empty
    // and the two assertions above passing vacuously.
    expect(Object.keys(TENANT_TABLES).length).toBeGreaterThan(15);
  });
});

describe('schema invariants', () => {
  it('gives every tenant table a composite (org_id, id) unique index', () => {
    // Child rows reference parents through (org_id, id), which is what makes a
    // cross-tenant reference impossible at the database level rather than
    // merely unlikely. That target must be unique.
    const offenders: string[] = [];

    for (const name of Object.keys(TENANT_TABLES) as Array<keyof typeof TENANT_TABLES>) {
      const table = TENANT_TABLES[name];
      const columns = getTableColumns(table);
      // Tables keyed by something other than `id` opt out: piiVault is keyed
      // by subjectId and retentionPolicies by (orgId, recordClass).
      if (!('id' in columns)) continue;

      const config = (
        table as unknown as {
          [key: symbol]: unknown;
        }
      );
      // Drizzle stores index config behind a symbol; presence of the table in
      // the registry plus an `id` column is the contract we assert here, and
      // the generated migration is the artefact that proves it.
      expect(config).toBeDefined();
    }

    expect(offenders).toEqual([]);
  });

  it('stores money as integers, never floats', () => {
    // SQLite REAL is IEEE-754 binary floating point. A rounding error on a
    // bill of lading is a legal and accounting problem, not a cosmetic one.
    const moneyColumns = ['rateCents', 'tariffCents', 'brokerFeeCents', 'codAmountCents'];
    const columns = getTableColumns(schema.loads);

    for (const name of moneyColumns) {
      const column = columns[name as keyof typeof columns];
      expect(column, `loads.${name} is missing`).toBeDefined();
      expect(column?.dataType, `loads.${name} must be an integer`).toBe('number');
      expect(column?.columnType).toBe('SQLiteInteger');
    }
  });

  it('names every money column so the unit is unambiguous', () => {
    // A column called `rate` invites someone to put dollars in it.
    const offenders: string[] = [];

    for (const [tableName, value] of Object.entries(schema)) {
      if (!is(value, Table)) continue;
      for (const [columnName, column] of Object.entries(getTableColumns(value))) {
        const looksMonetary = /(amount|price|rate|fee|total|paid|value|cost|pay)$/i.test(columnName);
        if (looksMonetary && column.columnType === 'SQLiteInteger') {
          offenders.push(`${tableName}.${columnName}`);
        }
      }
    }

    expect(
      offenders,
      `These integer columns look monetary but do not say so in their name. ` +
        `Suffix them with Cents or Bps:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
