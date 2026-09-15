import { sqliteTable, text, index, uniqueIndex, foreignKey } from 'drizzle-orm/sqlite-core';
import { currency, money, orgId, pk, timestamps, ts } from '../columns';
import { organizations, users } from './auth';

/**
 * What is in the account, and what leaves it without anybody deciding.
 *
 * Everything else in this application records something that happened between
 * the carrier and somebody else: a load, an invoice, a payment, a settlement.
 * These two tables record the things a carrier knows and this software never
 * will — the bank balance, and the payments that go out every month whether or
 * not a truck moves.
 *
 * Neither can be derived, so both are typed in. That makes them the only
 * figures here whose accuracy is nobody's responsibility but the person who
 * entered them, which is why the balance carries the moment it was true rather
 * than being a single number somebody overwrites.
 */

/**
 * A statement of what was in the bank at a moment.
 *
 * A row per reading rather than one mutable figure. The difference matters:
 * a number that is overwritten has no age, and a cash projection built on a
 * balance with no age is the exact failure this is meant to prevent — it
 * quietly stops being true and nothing on the screen says when that happened.
 *
 * Keeping the readings also means "what did we think we had on the 1st" has an
 * answer, which is the question asked when the projection turns out to have
 * been wrong.
 */
export const cashBalances = sqliteTable(
  'cash_balances',
  {
    id: pk(),
    orgId: orgId(),

    /** Signed. An overdrawn account is a real state and has to be recordable. */
    amountCents: money('amount_cents').notNull(),
    currency: currency(),

    /**
     * When this was true, which is not when the row was written. Somebody
     * reading Friday's closing balance on Monday morning is entering a fact
     * about Friday.
     */
    asOf: ts('as_of').notNull(),

    /** Who read it off the bank, so a figure that looks wrong has an author. */
    recordedByUserId: text('recorded_by_user_id').references(() => users.id),
    note: text('note'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('cash_balances_org_id_uq').on(t.orgId, t.id),
    index('cash_balances_org_as_of_idx').on(t.orgId, t.asOf),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'cash_balances_org_fk',
    }).onDelete('cascade'),
  ],
);

export type CashBalance = typeof cashBalances.$inferSelect;

export const OUTGOING_CADENCES = [
  'weekly',
  'every_two_weeks',
  'monthly',
  'quarterly',
  'annually',
] as const;
export type OutgoingCadence = (typeof OUTGOING_CADENCES)[number];

/**
 * What the money is for.
 *
 * Categories rather than free text because the useful question a year later is
 * "what are we committed to before we have hauled anything", and that is a
 * question about kinds of cost. Deliberately short: a list long enough to
 * require thought at the point of entry gets one category used for everything.
 */
export const OUTGOING_CATEGORIES = [
  'loan',
  'lease',
  'insurance',
  'permit',
  'payroll',
  'premises',
  'software',
  'tax',
  'other',
] as const;
export type OutgoingCategory = (typeof OUTGOING_CATEGORIES)[number];

/**
 * A payment that leaves on a schedule, whether or not a wheel turns.
 *
 * The truck note, the insurance premium, the yard rent, the quarterly fuel
 * tax. None of it is visible anywhere else in this application, and all of it
 * comes out of the same account the settlements do — so a cash projection
 * without it is a projection of the pleasant half.
 *
 * Every occurrence is derived from `anchorOn` and the cadence rather than
 * stored, for the same reason invoice balances are derived from payments: a
 * table of generated future dates goes stale the moment the amount or the day
 * changes, and reconciling it is work nobody would remember to do.
 */
export const recurringOutgoings = sqliteTable(
  'recurring_outgoings',
  {
    id: pk(),
    orgId: orgId(),

    /** What somebody would call it out loud: "Freightliner note", "Progressive". */
    name: text('name').notNull(),
    category: text('category', { enum: OUTGOING_CATEGORIES }).notNull().default('other'),

    amountCents: money('amount_cents').notNull(),
    currency: currency(),

    cadence: text('cadence', { enum: OUTGOING_CADENCES }).notNull(),
    /**
     * The first payment. Everything after it is counted from here, so a
     * fortnightly commitment needs no separate weekday and a monthly one needs
     * no separate day of the month — the anchor already says both.
     */
    anchorOn: ts('anchor_on').notNull(),
    /**
     * The last payment, where there is one.
     *
     * A truck loan has a final instalment from the day it is signed, and a
     * projection that runs it past the end of the term is overstating what the
     * carrier owes. Null means it runs until somebody says otherwise.
     */
    endsOn: ts('ends_on'),

    note: text('note'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('recurring_outgoings_org_id_uq').on(t.orgId, t.id),
    index('recurring_outgoings_org_idx').on(t.orgId),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'recurring_outgoings_org_fk',
    }).onDelete('cascade'),
  ],
);

export type RecurringOutgoing = typeof recurringOutgoings.$inferSelect;
