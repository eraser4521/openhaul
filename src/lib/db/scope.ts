import 'server-only';
import { and, asc, desc, eq, type Column, type SQL } from 'drizzle-orm';
import { db } from './client';
import * as schema from './schema';
import { appendAudit, AUDIT } from '../audit/chain';

/**
 * Tenant-scoped database access.
 *
 * SQLite has no row-level security, no database roles, and no `SET LOCAL`, so
 * isolation cannot be pushed into the engine. It is enforced here instead, by
 * never handing feature code a database handle that can reach a tenant table
 * without an organisation id.
 *
 * Three layers back this up:
 *   1. This wrapper, which welds `org_id = ?` onto every query.
 *   2. Composite foreign keys on (org_id, id), so a child row physically
 *      cannot reference a parent in another organisation.
 *   3. An ESLint rule banning the raw `db` import outside src/lib/db.
 */

/**
 * Every table carrying an `org_id`. A tenant table missing from this map
 * cannot be reached through `forOrg`, and a test asserts the two stay in sync.
 */
export const TENANT_TABLES = {
  customers: schema.customers,
  venues: schema.venues,
  drivers: schema.drivers,
  equipment: schema.equipment,
  trips: schema.trips,
  loads: schema.loads,
  stops: schema.stops,
  vehicles: schema.vehicles,
  inspections: schema.inspections,
  inspectionPhotos: schema.inspectionPhotos,
  damages: schema.damages,
  signatureEvents: schema.signatureEvents,
  invoices: schema.invoices,
  payments: schema.payments,
  expenses: schema.expenses,
  settlements: schema.settlements,
  settlementLines: schema.settlementLines,
  documents: schema.documents,
  claims: schema.claims,
  insuranceCertificates: schema.insuranceCertificates,
  carrierChecks: schema.carrierChecks,
  retentionPolicies: schema.retentionPolicies,
  legalHolds: schema.legalHolds,
  esignConsents: schema.esignConsents,
  monitoringConsents: schema.monitoringConsents,
  piiVault: schema.piiVault,
  subjectKeys: schema.subjectKeys,
} as const;

/**
 * Tables that carry an `org_id` but are deliberately unreachable through
 * `forOrg`, each with the reason it cannot be scoped.
 *
 * Every entry here is a place where a tenant context does not yet exist or
 * does not apply. Anything else with an `org_id` must go in `TENANT_TABLES`;
 * a test asserts the three sets partition cleanly, so a table added later
 * cannot quietly end up outside both.
 */
export const TENANT_SCOPE_EXEMPT = {
  sessions: 'Looked up by token hash before any organisation context exists.',
  memberships: 'Establishes the organisation context, so scoping it would be circular.',
  invitations: 'Redeemed by token by someone who is not yet a member of the organisation.',
  auditLog:
    'A single append-only hash chain across all tenants. Writes go through appendAudit and ' +
    'reads through verifyChain, both of which filter by organisation themselves. Scoping the ' +
    'table would break chain verification, which must see every entry in sequence.',
} as const;

export type TenantTableName = keyof typeof TENANT_TABLES;
type TenantTable<T extends TenantTableName> = (typeof TENANT_TABLES)[T];
type Row<T extends TenantTableName> = TenantTable<T>['$inferSelect'];
type Insert<T extends TenantTableName> = TenantTable<T>['$inferInsert'];

/**
 * A branded organisation id.
 *
 * Only `session.orgId` produces one, so a value taken from a request body
 * cannot be passed where a tenant scope is expected without an explicit,
 * greppable cast.
 */
declare const orgBrand: unique symbol;
export type OrgId = string & { readonly [orgBrand]: 'OrgId' };

export function asOrgId(value: string): OrgId {
  return value as OrgId;
}

export class TenantIsolationError extends Error {
  constructor(table: string, expected: string, found: string) {
    super(`tenant isolation violation reading ${table}: expected org ${expected}, found ${found}`);
    this.name = 'TenantIsolationError';
  }
}

/**
 * Runtime tripwire.
 *
 * If a row from another organisation ever reaches this point there is a bug
 * severe enough to stop the request rather than return data. Cheap, and it
 * turns a silent cross-tenant leak into a loud failure plus an audit entry.
 */
function assertAllInOrg<R extends { orgId?: string }>(rows: R[], orgId: string, table: string): R[] {
  for (const row of rows) {
    if (row.orgId !== undefined && row.orgId !== orgId) {
      void appendAudit({
        orgId,
        action: AUDIT.tenantViolation,
        subject: `table:${table}`,
        outcome: 'failure',
        detail: { table, expectedOrg: orgId, foundOrg: row.orgId },
      });
      throw new TenantIsolationError(table, orgId, row.orgId);
    }
  }
  return rows;
}

export interface SelectOptions {
  /** Column to order by, plus direction. */
  orderBy?: { column: Column; direction?: 'asc' | 'desc' };
  limit?: number;
}

export interface ScopedDb {
  readonly orgId: OrgId;

  select<T extends TenantTableName>(
    table: T,
    where?: SQL,
    options?: SelectOptions,
  ): Promise<Row<T>[]>;
  selectOne<T extends TenantTableName>(table: T, where: SQL): Promise<Row<T> | null>;
  insert<T extends TenantTableName>(table: T, values: Omit<Insert<T>, 'orgId'>): Promise<Row<T>[]>;
  insertMany<T extends TenantTableName>(
    table: T,
    values: Array<Omit<Insert<T>, 'orgId'>>,
  ): Promise<Row<T>[]>;
  update<T extends TenantTableName>(
    table: T,
    where: SQL,
    values: Partial<Omit<Insert<T>, 'orgId'>>,
  ): Promise<Row<T>[]>;
  remove<T extends TenantTableName>(table: T, where: SQL): Promise<void>;
  count<T extends TenantTableName>(table: T, where?: SQL): Promise<number>;
}

/**
 * The only sanctioned entry point to tenant data.
 *
 * @param orgId Comes from the verified session, never from user input.
 */
export function forOrg(orgId: OrgId): ScopedDb {
  const scope = <T extends TenantTableName>(table: T): SQL => {
    // Every registered table has an `orgId` column, but the generic lookup
    // widens to a union of 26 table types that Drizzle cannot narrow, so the
    // column is read through `unknown`. The registry is the guarantee here,
    // and a test asserts it covers exactly the tables that have an org_id.
    const column = (TENANT_TABLES[table] as unknown as { orgId: Column }).orgId;
    return eq(column, orgId);
  };

  const merge = <T extends TenantTableName>(table: T, where?: SQL): SQL => {
    const base = scope(table);
    return where ? (and(base, where) as SQL) : base;
  };

  return {
    orgId,

    async select(table, where, options) {
      let query = db
        .select()
        .from(TENANT_TABLES[table] as never)
        .where(merge(table, where))
        .$dynamic();

      if (options?.orderBy) {
        const { column, direction } = options.orderBy;
        query = query.orderBy(direction === 'asc' ? asc(column) : desc(column));
      }
      if (options?.limit !== undefined) {
        query = query.limit(options.limit);
      }

      const rows = await query;
      return assertAllInOrg(rows as never[], orgId, table) as never;
    },

    async selectOne(table, where) {
      const rows = await db
        .select()
        .from(TENANT_TABLES[table] as never)
        .where(merge(table, where))
        .limit(1);
      const checked = assertAllInOrg(rows as never[], orgId, table);
      return (checked[0] ?? null) as never;
    },

    async insert(table, values) {
      // The organisation id is forced, never taken from the caller's object.
      const rows = await db
        .insert(TENANT_TABLES[table] as never)
        .values({ ...values, orgId } as never)
        .returning();
      return rows as never;
    },

    async insertMany(table, values) {
      if (values.length === 0) return [] as never;
      const rows = await db
        .insert(TENANT_TABLES[table] as never)
        .values(values.map((v) => ({ ...v, orgId })) as never)
        .returning();
      return rows as never;
    },

    async update(table, where, values) {
      // `orgId` is immutable: stripping it here means a load can never be
      // moved into another organisation by an update.
      const { orgId: _ignored, ...safe } = values as Record<string, unknown>;
      const rows = await db
        .update(TENANT_TABLES[table] as never)
        .set(safe as never)
        .where(merge(table, where))
        .returning();
      return assertAllInOrg(rows as never[], orgId, table) as never;
    },

    async remove(table, where) {
      await db.delete(TENANT_TABLES[table] as never).where(merge(table, where));
    },

    async count(table, where) {
      const rows = await db
        .select()
        .from(TENANT_TABLES[table] as never)
        .where(merge(table, where));
      return (rows as unknown[]).length;
    },
  };
}
