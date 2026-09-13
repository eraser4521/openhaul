import { sqliteTable, text, integer, index, uniqueIndex, foreignKey } from 'drizzle-orm/sqlite-core';
import { bool, currency, money, orgId, pk, timestamps, ts } from '../columns';
import { organizations } from './auth';
import { customers, loads, PAYMENT_METHODS, PAYMENT_TERMS } from './operations';

export const INVOICE_STATUSES = [
  'draft',
  'sent',
  'partially_paid',
  'paid',
  'overdue',
  'void',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const EXPENSE_CATEGORIES = [
  'fuel',
  'tolls',
  'car_pulling',
  'lumper',
  'scale',
  'parking',
  'maintenance',
  'lodging',
  'permit',
  'other',
] as const;

/**
 * An invoice raised against a load.
 *
 * The figures must match the rate confirmation exactly — a broker will hold
 * the whole invoice over a cent, so every component is stored discretely
 * rather than as a single total.
 */
export const invoices = sqliteTable(
  'invoices',
  {
    id: pk(),
    orgId: orgId(),
    number: text('number').notNull(),

    loadId: text('load_id'),
    customerId: text('customer_id'),

    status: text('status', { enum: INVOICE_STATUSES }).notNull().default('draft'),

    lineHaulCents: money('line_haul_cents').notNull().default(0),
    fuelSurchargeCents: money('fuel_surcharge_cents').notNull().default(0),
    accessorialCents: money('accessorial_cents').notNull().default(0),
    /** Already collected by the driver, credited against the balance. */
    codCollectedCents: money('cod_collected_cents').notNull().default(0),
    depositCents: money('deposit_cents').notNull().default(0),
    taxCents: money('tax_cents').notNull().default(0),
    totalCents: money('total_cents').notNull().default(0),
    paidCents: money('paid_cents').notNull().default(0),
    currency: currency(),

    terms: text('terms', { enum: PAYMENT_TERMS }),
    issuedAt: ts('issued_at'),
    dueAt: ts('due_at'),
    sentAt: ts('sent_at'),
    paidAt: ts('paid_at'),
    voidedAt: ts('voided_at'),
    voidReason: text('void_reason'),

    /**
     * Factoring companies require a Notice of Assignment on the invoice face
     * redirecting payment to them. Without it the broker pays the carrier and
     * the factor comes after the carrier for the money.
     */
    factoringCompanyName: text('factoring_company_name'),
    factoringNoticeText: text('factoring_notice_text'),

    notes: text('notes'),
    /** Frozen PDF bytes; regeneration is a fallback, never the record. */
    documentId: text('document_id'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('invoices_org_id_uq').on(t.orgId, t.id),
    uniqueIndex('invoices_org_number_uq').on(t.orgId, t.number),
    index('invoices_org_status_idx').on(t.orgId, t.status),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'invoices_org_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.loadId],
      foreignColumns: [loads.orgId, loads.id],
      name: 'invoices_load_fk',
    }),
    foreignKey({
      columns: [t.orgId, t.customerId],
      foreignColumns: [customers.orgId, customers.id],
      name: 'invoices_customer_fk',
    }),
  ],
);

export const payments = sqliteTable(
  'payments',
  {
    id: pk(),
    orgId: orgId(),
    invoiceId: text('invoice_id').notNull(),

    amountCents: money('amount_cents').notNull(),
    currency: currency(),
    method: text('method', { enum: PAYMENT_METHODS }).notNull(),
    reference: text('reference'),
    receivedAt: ts('received_at').notNull(),
    notes: text('notes'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('payments_org_id_uq').on(t.orgId, t.id),
    index('payments_invoice_idx').on(t.invoiceId),
    foreignKey({
      columns: [t.orgId, t.invoiceId],
      foreignColumns: [invoices.orgId, invoices.id],
      name: 'payments_invoice_fk',
    }).onDelete('cascade'),
  ],
);

/** Driver-incurred costs against a load, with a receipt photo. */
export const expenses = sqliteTable(
  'expenses',
  {
    id: pk(),
    orgId: orgId(),
    loadId: text('load_id'),
    driverId: text('driver_id'),

    category: text('category', { enum: EXPENSE_CATEGORIES }).notNull(),
    amountCents: money('amount_cents').notNull(),
    currency: currency(),
    incurredAt: ts('incurred_at').notNull(),
    vendor: text('vendor'),
    notes: text('notes'),

    receiptStorageKey: text('receipt_storage_key'),
    receiptSha256: text('receipt_sha256'),

    /** Passed through to the customer rather than absorbed by the carrier. */
    reimbursable: bool('reimbursable').notNull().default(false),
    reimbursedAt: ts('reimbursed_at'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('expenses_org_id_uq').on(t.orgId, t.id),
    index('expenses_org_load_idx').on(t.orgId, t.loadId),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'expenses_org_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Driver settlement: what the driver is paid for a period.
 *
 * Driver pay is a share of load revenue net of broker fees, so the components
 * are stored rather than a single figure.
 */
export const settlements = sqliteTable(
  'settlements',
  {
    id: pk(),
    orgId: orgId(),
    driverId: text('driver_id').notNull(),

    periodStart: ts('period_start').notNull(),
    periodEnd: ts('period_end').notNull(),

    grossRevenueCents: money('gross_revenue_cents').notNull().default(0),
    brokerFeesCents: money('broker_fees_cents').notNull().default(0),
    payRateBps: integer('pay_rate_bps'),
    driverPayCents: money('driver_pay_cents').notNull().default(0),
    reimbursementsCents: money('reimbursements_cents').notNull().default(0),
    deductionsCents: money('deductions_cents').notNull().default(0),
    netPayCents: money('net_pay_cents').notNull().default(0),
    currency: currency(),

    paidAt: ts('paid_at'),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('settlements_org_id_uq').on(t.orgId, t.id),
    index('settlements_org_driver_idx').on(t.orgId, t.driverId),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'settlements_org_fk',
    }).onDelete('cascade'),
  ],
);

export type Invoice = typeof invoices.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
export type Settlement = typeof settlements.$inferSelect;
