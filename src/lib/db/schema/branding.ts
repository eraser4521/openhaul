import { sqliteTable, text, integer, index, uniqueIndex, foreignKey } from 'drizzle-orm/sqlite-core';
import { bool, money, orgId, pk, timestamps } from '../columns';
import { organizations } from './auth';
import { invoices } from './billing';

/**
 * The carrier-owned layer of a document.
 *
 * Every document this application produces has two layers. One is fixed by
 * regulation or by the instrument itself: the terms on a bill of lading, the
 * non-negotiable declaration on its face, the three Part 370 letters, the
 * Notice of Assignment on a factored invoice. The other is the carrier's own —
 * their letterhead, their colour, the standing notes they put on their
 * paperwork, the accessorial charges they have names and rates for.
 *
 * A template holds the second layer and cannot reach the first. That boundary
 * is the whole point of the feature: carriers leave software that will not put
 * their logo on a bill of lading, but a bill of lading whose terms a user can
 * edit is not a bill of lading. So there is no field here that removes,
 * replaces or reorders regulatory content — only ones that sit around it.
 */

/**
 * Which documents a template applies to.
 *
 * `all` is the house style everything inherits; a scoped row overrides only
 * the fields it sets, because a carrier wants one logo everywhere and a
 * different footer on an invoice than on a bill of lading.
 */
export const TEMPLATE_SCOPES = [
  'all',
  'bol',
  'pod',
  'invoice',
  'credit_note',
  'statement',
  'settlement',
  'claim',
] as const;
export type TemplateScope = (typeof TEMPLATE_SCOPES)[number];

export const documentTemplates = sqliteTable(
  'document_templates',
  {
    id: pk(),
    orgId: orgId(),
    scope: text('scope', { enum: TEMPLATE_SCOPES }).notNull().default('all'),

    /**
     * The name printed on the letterhead. Null falls back to the legal name.
     *
     * A carrier trading as one name under a legal entity with another wants
     * the trading name at the top of the page — but the legal name and the
     * authority numbers still appear in the party block below, because that is
     * what identifies the motor carrier on the document.
     */
    letterheadName: text('letterhead_name'),
    tagline: text('tagline'),

    /** Six hex digits, no leading hash. Validated and contrast-checked on use. */
    accentHex: text('accent_hex'),

    /**
     * Logo bytes live in the blob store like any other upload. PNG only: the
     * PDF writer embeds PNG and JPEG, and a logo with a transparent ground has
     * to be PNG to stay transparent, so uploads are converted on the way in.
     */
    logoStorageKey: text('logo_storage_key'),
    logoSha256: text('logo_sha256'),
    logoWidth: integer('logo_width'),
    logoHeight: integer('logo_height'),
    /**
     * Nullable on purpose: null means inherit. Every field here resolves the
     * same way, so a per-document row can turn the logo off without a
     * not-null default silently turning it back on for a scope the carrier
     * never edited.
     */
    showLogo: bool('show_logo'),

    /** Replaces the default bottom-left footer line, not the page numbers. */
    footerNote: text('footer_note'),

    /**
     * Extra terms, printed after the fixed ones under a heading that says
     * whose they are. Appended, never merged: a reader has to be able to tell
     * which sentences came from the regulation and which came from the
     * carrier.
     */
    addendum: text('addendum'),

    /** Where to send the money. Invoices and credit notes only. */
    remitToText: text('remit_to_text'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('document_templates_org_id_uq').on(t.orgId, t.id),
    uniqueIndex('document_templates_org_scope_uq').on(t.orgId, t.scope),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'document_templates_org_fk',
    }).onDelete('cascade'),
  ],
);

export type DocumentTemplate = typeof documentTemplates.$inferSelect;

/**
 * How an accessorial is counted.
 *
 * The unit is what turns a disputed lump sum into a line an accounts
 * department can check: "Detention 3.5 hrs at $75.00" gets paid, "Accessorials
 * $262.50" gets a phone call.
 */
export const ACCESSORIAL_UNITS = ['flat', 'per_hour', 'per_day', 'per_mile', 'per_vehicle'] as const;
export type AccessorialUnit = (typeof ACCESSORIAL_UNITS)[number];

/**
 * A carrier's own named charges.
 *
 * A catalogue rather than free text on each invoice, because the same charge
 * billed as "detention" on one invoice and "waiting time" on the next is the
 * thing a broker's accounts department disputes. Editing a catalogue entry
 * never reaches an invoice that already cites it — the line copies the label
 * and rate at the moment it is added, so a rate rise does not rewrite history.
 */
export const accessorialRates = sqliteTable(
  'accessorial_rates',
  {
    id: pk(),
    orgId: orgId(),

    /** Short code the carrier uses on their own paperwork, e.g. DET. */
    code: text('code').notNull(),
    label: text('label').notNull(),
    unit: text('unit', { enum: ACCESSORIAL_UNITS }).notNull().default('flat'),
    defaultCents: money('default_cents').notNull().default(0),

    /** Printed under the line on the invoice when set. */
    note: text('note'),

    /** Retired entries stay for the invoices that already cite them. */
    active: bool('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('accessorial_rates_org_id_uq').on(t.orgId, t.id),
    uniqueIndex('accessorial_rates_org_code_uq').on(t.orgId, t.code),
    index('accessorial_rates_org_active_idx').on(t.orgId, t.active),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'accessorial_rates_org_fk',
    }).onDelete('cascade'),
  ],
);

export type AccessorialRate = typeof accessorialRates.$inferSelect;

/**
 * One itemised accessorial on one invoice.
 *
 * Quantity is stored in hundredths so a half hour of detention is exact; money
 * is integer cents as everywhere else. The extended amount is derived from the
 * two on every read rather than stored, so a corrected quantity cannot leave a
 * stale total behind it — which is the same rule the invoice total follows.
 */
export const invoiceAccessorials = sqliteTable(
  'invoice_accessorials',
  {
    id: pk(),
    orgId: orgId(),
    invoiceId: text('invoice_id').notNull(),

    /** Copied from the catalogue, or typed for a one-off. */
    rateId: text('rate_id'),
    code: text('code'),
    label: text('label').notNull(),
    unit: text('unit', { enum: ACCESSORIAL_UNITS }).notNull().default('flat'),

    /** Hundredths of a unit: 350 is 3.5 hours. */
    quantityHundredths: integer('quantity_hundredths').notNull().default(100),
    unitCents: money('unit_cents').notNull().default(0),

    note: text('note'),
    sortOrder: integer('sort_order').notNull().default(0),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('invoice_accessorials_org_id_uq').on(t.orgId, t.id),
    index('invoice_accessorials_invoice_idx').on(t.orgId, t.invoiceId),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'invoice_accessorials_org_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.invoiceId],
      foreignColumns: [invoices.orgId, invoices.id],
      name: 'invoice_accessorials_invoice_fk',
    }).onDelete('cascade'),
  ],
);

export type InvoiceAccessorial = typeof invoiceAccessorials.$inferSelect;
