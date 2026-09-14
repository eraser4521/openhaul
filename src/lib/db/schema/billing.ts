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
    /**
     * Credited by credit note, which reduces what is owed without altering
     * what the invoice says. Derived from the notes, never incremented.
     */
    creditedCents: money('credited_cents').notNull().default(0),
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

/**
 * A credit note against an issued invoice.
 *
 * Not an edit. Once an invoice has been sent, the customer holds a document
 * stating a figure, and that figure is what was claimed from them — so a
 * reduction is a second document that says so, referencing the first. Voiding
 * is only available while nothing has been paid; after that a credit is the
 * instrument, because voiding would erase money actually received.
 *
 * The balance owed becomes total less payments less credits. The invoice's own
 * total never moves.
 */
export const CREDIT_REASONS = [
  'rate_adjustment',
  'damage_offset',
  'service_failure',
  'billing_error',
  'goodwill',
  'other',
] as const;
export type CreditReason = (typeof CREDIT_REASONS)[number];

export const creditNotes = sqliteTable(
  'credit_notes',
  {
    id: pk(),
    orgId: orgId(),
    number: text('number').notNull(),

    invoiceId: text('invoice_id').notNull(),
    customerId: text('customer_id'),
    /**
     * The claim this credit settles, when a cargo claim is resolved by
     * deducting from the freight bill rather than by paying the claimant.
     */
    claimId: text('claim_id'),

    reason: text('reason', { enum: CREDIT_REASONS }).notNull(),
    detail: text('detail').notNull(),
    amountCents: money('amount_cents').notNull(),
    currency: currency(),

    /** Frozen on issue, like the invoice it credits. */
    issuedAt: ts('issued_at'),
    documentId: text('document_id'),
    voidedAt: ts('voided_at'),
    voidReason: text('void_reason'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('credit_notes_org_id_uq').on(t.orgId, t.id),
    uniqueIndex('credit_notes_org_number_uq').on(t.orgId, t.number),
    index('credit_notes_invoice_idx').on(t.invoiceId),
    foreignKey({
      columns: [t.orgId, t.invoiceId],
      foreignColumns: [invoices.orgId, invoices.id],
      name: 'credit_notes_invoice_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.customerId],
      foreignColumns: [customers.orgId, customers.id],
      name: 'credit_notes_customer_fk',
    }),
  ],
);

/**
 * Money going back to a customer.
 *
 * A separate table rather than a negative `payments` row. Every figure that
 * asks "what did this invoice collect" sums the payments, and a refund folded
 * in as a negative would quietly answer a different question — revenue would
 * drop, the aging report would move, and none of it would be wrong in a way
 * anybody could see. Money out is a different instrument from money in, and
 * the credit note is already the precedent: a reduction is a second document
 * rather than an edit to the first.
 *
 * What makes a refund owed is an invoice whose payments and credits together
 * exceed what was charged. The credit note that caused it is recorded where
 * there is one, because "why did we send $500 back" is the question asked
 * afterwards.
 */
export const refunds = sqliteTable(
  'refunds',
  {
    id: pk(),
    orgId: orgId(),
    invoiceId: text('invoice_id').notNull(),
    /** The credit that put the invoice into overpayment, where one did. */
    creditNoteId: text('credit_note_id'),

    amountCents: money('amount_cents').notNull(),
    currency: currency(),
    method: text('method', { enum: PAYMENT_METHODS }).notNull(),
    /** Cheque number, ACH trace, whatever proves it went. */
    reference: text('reference'),
    /** When the money actually left, which is not when the row was written. */
    issuedAt: ts('issued_at').notNull(),
    notes: text('notes'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('refunds_org_id_uq').on(t.orgId, t.id),
    index('refunds_invoice_idx').on(t.orgId, t.invoiceId),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'refunds_org_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.invoiceId],
      foreignColumns: [invoices.orgId, invoices.id],
      name: 'refunds_invoice_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.creditNoteId],
      foreignColumns: [creditNotes.orgId, creditNotes.id],
      name: 'refunds_credit_note_fk',
    }),
  ],
);

export type Refund = typeof refunds.$inferSelect;

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

    /** Frozen once finalised; the statement handed over is the record. */
    finalizedAt: ts('finalized_at'),
    documentId: text('document_id'),

    paidAt: ts('paid_at'),
    paymentReference: text('payment_reference'),
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

/**
 * Every line on a settlement statement.
 *
 * Totals alone do not make a settlement. For a leased owner-operator, 49 CFR
 * 376.12(g) requires the carrier to identify every item charged back and to
 * let the driver examine the documents behind it, and 376.12(d) requires the
 * rated revenue to be shown when pay is a percentage of it. A statement that
 * says "deductions: $412" satisfies neither, so each line stands on its own
 * with what it was for and where the proof is.
 *
 * Amounts are magnitudes and the kind decides the direction — a deduction of
 * 5000 takes $50.00 off. A negative amount within a kind is therefore a
 * reversal of that kind, which is how a mistaken chargeback is undone without
 * deleting the line somebody already saw.
 */
export const SETTLEMENT_LINE_KINDS = [
  'load_pay',
  'bonus',
  'reimbursement',
  'deduction',
  'escrow_deposit',
  'escrow_return',
  'advance',
] as const;
export type SettlementLineKind = (typeof SETTLEMENT_LINE_KINDS)[number];

export const settlementLines = sqliteTable(
  'settlement_lines',
  {
    id: pk(),
    orgId: orgId(),
    settlementId: text('settlement_id').notNull(),

    kind: text('kind', { enum: SETTLEMENT_LINE_KINDS }).notNull(),
    sequence: integer('sequence').notNull().default(0),

    description: text('description').notNull(),
    amountCents: money('amount_cents').notNull(),

    /** The load this line arose from, for pay and load-specific chargebacks. */
    loadId: text('load_id'),
    /** The driver expense being reimbursed, which carries the receipt. */
    expenseId: text('expense_id'),
    /** A stored document supporting a chargeback, per 376.12(g). */
    documentId: text('document_id'),

    /** How the figure was arrived at: "28% of $2,940.00", "1,074 mi @ $0.55". */
    basisNote: text('basis_note'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('settlement_lines_org_id_uq').on(t.orgId, t.id),
    index('settlement_lines_settlement_idx').on(t.settlementId),
    foreignKey({
      columns: [t.orgId, t.settlementId],
      foreignColumns: [settlements.orgId, settlements.id],
      name: 'settlement_lines_settlement_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.loadId],
      foreignColumns: [loads.orgId, loads.id],
      name: 'settlement_lines_load_fk',
    }),
  ],
);

export type Invoice = typeof invoices.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type CreditNote = typeof creditNotes.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
export type Settlement = typeof settlements.$inferSelect;
export type SettlementLine = typeof settlementLines.$inferSelect;
