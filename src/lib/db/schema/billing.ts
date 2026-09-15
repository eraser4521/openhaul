import { sqliteTable, text, integer, index, uniqueIndex, foreignKey } from 'drizzle-orm/sqlite-core';
import { bool, currency, money, orgId, pk, timestamps, ts } from '../columns';
import { organizations, users } from './auth';
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

/**
 * Which way money moved between an invoice and a customer's credit balance.
 *
 * Positive amounts either way; the direction says what happened. Signing the
 * column instead would let a mistyped minus turn a grant into a spend.
 */
export const CREDIT_DIRECTIONS = ['in', 'out'] as const;
export type CreditDirection = (typeof CREDIT_DIRECTIONS)[number];

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
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

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
    /**
     * Settled out of a balance the customer already had with the carrier.
     *
     * Its own column rather than folded into `paid_cents`, because no money
     * arrived — saying it did would overstate what was banked this period —
     * and not into `credited_cents` either, because the charge was not
     * reduced and no document says it was. Derived from `customer_credits`.
     */
    appliedCreditCents: money('applied_credit_cents').notNull().default(0),
    /**
     * An overpayment on this invoice moved into the customer's balance rather
     * than sent back. Settles this invoice the way a refund does, except the
     * carrier is still holding the money. Derived from `customer_credits`.
     */
    carriedForwardCents: money('carried_forward_cents').notNull().default(0),
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
    /**
     * Leave this invoice alone until then.
     *
     * The dispatcher knows things the ladder does not — that they rang, that
     * payment is coming on Friday, that the PO number was wrong and is being
     * reissued. Without somewhere to put that, the only way to stop a notice
     * is to turn dunning off for everybody.
     */
    dunningPausedUntil: ts('dunning_paused_until'),
    dunningPauseReason: text('dunning_pause_reason'),
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

/**
 * A movement between an invoice and a customer's credit balance.
 *
 * The balance itself is not stored anywhere. It is the sum of these rows, for
 * the same reason `paid_cents` is rebuilt from payments: a running total on
 * the customer record drifts the first time a movement is corrected, and a
 * customer's balance drifting is the carrier quietly keeping or giving away
 * money nobody can account for.
 *
 * Every movement names an invoice, which is what makes the ledger answer the
 * question actually asked a year later — "you kept $500 of ours in March,
 * where did it go?". `in` is an overpayment carried off that invoice; `out`
 * is the balance spent against one.
 */
export const customerCredits = sqliteTable(
  'customer_credits',
  {
    id: pk(),
    orgId: orgId(),
    customerId: text('customer_id').notNull(),

    direction: text('direction', { enum: CREDIT_DIRECTIONS }).notNull(),
    /** Always positive. `direction` carries the sign. */
    amountCents: money('amount_cents').notNull(),
    currency: currency(),

    /**
     * For `in`, the overpaid invoice the money came off. For `out`, the
     * invoice it settled. Never null: a movement with no invoice is money
     * with no account of where it came from or went.
     */
    invoiceId: text('invoice_id').notNull(),
    /** The credit note that put the invoice into overpayment, where one did. */
    creditNoteId: text('credit_note_id'),

    /** When the carrier decided, which is not when the row was written. */
    occurredAt: ts('occurred_at').notNull(),
    note: text('note'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('customer_credits_org_id_uq').on(t.orgId, t.id),
    index('customer_credits_customer_idx').on(t.orgId, t.customerId),
    index('customer_credits_invoice_idx').on(t.orgId, t.invoiceId),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'customer_credits_org_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.customerId],
      foreignColumns: [customers.orgId, customers.id],
      name: 'customer_credits_customer_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.invoiceId],
      foreignColumns: [invoices.orgId, invoices.id],
      name: 'customer_credits_invoice_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.creditNoteId],
      foreignColumns: [creditNotes.orgId, creditNotes.id],
      name: 'customer_credits_credit_note_fk',
    }),
  ],
);

export type CustomerCredit = typeof customerCredits.$inferSelect;

/**
 * A statement of account that was produced for a customer.
 *
 * The frozen PDF is the artefact; this row is the record that it was made,
 * what it said, and what period it covered. Kept because three questions need
 * it and none of them can be answered by a file: when did we last statement
 * this customer, what did that statement claim was owed, and what should the
 * covering email say about the document already attached to it.
 *
 * The figures are a snapshot on purpose. An email that recomputed the balance
 * would describe the account as it stands now while the attachment describes
 * it as it stood then, and the customer would be reading two different numbers
 * for the same thing.
 */
export const statements = sqliteTable(
  'statements',
  {
    id: pk(),
    orgId: orgId(),
    customerId: text('customer_id').notNull(),
    documentId: text('document_id'),

    /** Balances are as at this moment; movements are listed from `periodFrom`. */
    issuedAt: ts('issued_at').notNull(),
    periodFrom: ts('period_from').notNull(),
    windowDays: integer('window_days').notNull(),

    /** What the customer owed, as the statement stated it. */
    balanceCents: money('balance_cents').notNull().default(0),
    /** What the carrier was holding for them. */
    heldCents: money('held_cents').notNull().default(0),
    currency: currency(),

    openItemCount: integer('open_item_count').notNull().default(0),
    entryCount: integer('entry_count').notNull().default(0),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('statements_org_id_uq').on(t.orgId, t.id),
    index('statements_customer_idx').on(t.orgId, t.customerId),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'statements_org_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.customerId],
      foreignColumns: [customers.orgId, customers.id],
      name: 'statements_customer_fk',
    }).onDelete('cascade'),
  ],
);

export type Statement = typeof statements.$inferSelect;

export const STATEMENT_CADENCES = ['off', 'weekly', 'monthly'] as const;
export type StatementCadence = (typeof STATEMENT_CADENCES)[number];

/**
 * When statements go out, for one organisation.
 *
 * One row per organisation rather than one per customer. A carrier sends
 * statements on a day of the month, to everybody, or not at all — a per
 * customer cadence is a screen nobody would fill in, and the one real
 * exception is "not this one", which is a flag on the customer.
 */
export const statementSchedules = sqliteTable(
  'statement_schedules',
  {
    id: pk(),
    orgId: orgId(),

    cadence: text('cadence', { enum: STATEMENT_CADENCES }).notNull().default('off'),
    /**
     * Capped at 28 by validation, not by convention. A schedule set to the
     * 31st would skip February entirely and fire on different days of the
     * month for the rest of the year, which is not what anybody meant.
     */
    dayOfMonth: integer('day_of_month').notNull().default(1),
    /** 0 is Sunday, matching `Date.getUTCDay`. */
    dayOfWeek: integer('day_of_week').notNull().default(1),

    /** How far back each statement lists movements. */
    windowDays: integer('window_days').notNull().default(90),
    /** Below this, chasing costs more than the debt. */
    minimumBalanceCents: money('minimum_balance_cents').notNull().default(0),
    /**
     * Statement a customer who owes nothing but is holding credit with the
     * carrier. Telling them is the entire reason the balance is visible.
     */
    includeCreditHolders: bool('include_credit_holders').notNull().default(true),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('statement_schedules_org_id_uq').on(t.orgId, t.id),
    uniqueIndex('statement_schedules_org_uq').on(t.orgId),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'statement_schedules_org_fk',
    }).onDelete('cascade'),
  ],
);

export type StatementSchedule = typeof statementSchedules.$inferSelect;

export const RUN_TRIGGERS = ['schedule', 'manual'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/**
 * One occurrence of the schedule, run once.
 *
 * `due_on` is unique per organisation and that is the whole concurrency
 * design: whoever inserts the row owns the run, and a second trigger for the
 * same occurrence finds it taken and stops. A cron line that fires twice, a
 * retry after a timeout, and somebody pressing the button by hand all
 * converge on one run.
 *
 * A missed occurrence is never made up. If the machine was off for two
 * months, the next run covers it — balances are always as at today, so
 * sending a statement dated now for a period that closed six weeks ago would
 * say nothing the current one does not.
 */
export const statementRuns = sqliteTable(
  'statement_runs',
  {
    id: pk(),
    orgId: orgId(),

    /** Midnight UTC of the scheduled day this run covers. */
    dueOn: ts('due_on').notNull(),
    trigger: text('trigger', { enum: RUN_TRIGGERS }).notNull(),

    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at'),

    /** Customers examined, including those with nothing to say. */
    consideredCount: integer('considered_count').notNull().default(0),
    sentCount: integer('sent_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),

    /** Set when the run itself could not proceed, not when one customer failed. */
    error: text('error'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('statement_runs_org_id_uq').on(t.orgId, t.id),
    uniqueIndex('statement_runs_org_due_uq').on(t.orgId, t.dueOn),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'statement_runs_org_fk',
    }).onDelete('cascade'),
  ],
);

export type StatementRun = typeof statementRuns.$inferSelect;

export const RUN_OUTCOMES = ['sent', 'failed', 'skipped'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/**
 * What happened to one customer in one run.
 *
 * Only customers the run tried to act on get a row. Somebody with nothing
 * outstanding and nothing on account is counted and forgotten; somebody who
 * should have received one and could not — no address on file, a statement
 * that would not reconcile — is a row with the reason, because that is a thing
 * a person has to go and fix.
 */
export const statementRunItems = sqliteTable(
  'statement_run_items',
  {
    id: pk(),
    orgId: orgId(),
    runId: text('run_id').notNull(),
    customerId: text('customer_id').notNull(),
    /** Null when nothing was produced, which is every skip. */
    statementId: text('statement_id'),

    outcome: text('outcome', { enum: RUN_OUTCOMES }).notNull(),
    /** Why it failed or was skipped. Null on success. */
    detail: text('detail'),

    balanceCents: money('balance_cents').notNull().default(0),
    heldCents: money('held_cents').notNull().default(0),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('statement_run_items_org_id_uq').on(t.orgId, t.id),
    index('statement_run_items_run_idx').on(t.orgId, t.runId),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'statement_run_items_org_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.runId],
      foreignColumns: [statementRuns.orgId, statementRuns.id],
      name: 'statement_run_items_run_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.customerId],
      foreignColumns: [customers.orgId, customers.id],
      name: 'statement_run_items_customer_fk',
    }).onDelete('cascade'),
  ],
);

export type StatementRunItem = typeof statementRunItems.$inferSelect;

/**
 * How firmly, and how often, an unpaid invoice is chased.
 *
 * One row per organisation. Off by default and deliberately so: a ladder that
 * starts sending the moment it is deployed would chase debts the carrier had
 * already settled by telephone.
 */
export const dunningSettings = sqliteTable(
  'dunning_settings',
  {
    id: pk(),
    orgId: orgId(),

    enabled: bool('enabled').notNull().default(false),
    /** Below this, chasing costs more than the debt and annoys more than it collects. */
    minimumBalanceCents: money('minimum_balance_cents').notNull().default(0),
    /**
     * The shortest time between two notices about the same invoice.
     *
     * Independent of the stage thresholds, because a run that has not happened
     * for a month would otherwise find three stages all due at once and send
     * them together. One notice, then silence for this long, whatever the
     * ladder says.
     */
    minimumGapDays: integer('minimum_gap_days').notNull().default(10),
    /**
     * Silence after money arrives.
     *
     * Somebody paying in instalments is not somebody to escalate. A payment
     * restarts the clock rather than the ladder — the next stage still comes
     * next, but not until they have had this long.
     */
    pauseAfterPaymentDays: integer('pause_after_payment_days').notNull().default(14),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('dunning_settings_org_id_uq').on(t.orgId, t.id),
    uniqueIndex('dunning_settings_org_uq').on(t.orgId),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'dunning_settings_org_fk',
    }).onDelete('cascade'),
  ],
);

export type DunningSettings = typeof dunningSettings.$inferSelect;

/**
 * One rung of the ladder.
 *
 * The carrier writes the sentence; the document supplies the figures. There
 * is no template language and no merge fields, because a reminder that goes
 * out saying "Invoice {{number}}" is worse than one that says nothing at all,
 * and the facts are printed in their own panel where they cannot be broken by
 * an edit to the prose.
 */
export const dunningStages = sqliteTable(
  'dunning_stages',
  {
    id: pk(),
    orgId: orgId(),

    /** 1, 2, 3 — the order they go in. A stage never skips the one before it. */
    sequence: integer('sequence').notNull(),
    label: text('label').notNull(),
    /** Days past the due date before this rung becomes available. */
    daysPastDue: integer('days_past_due').notNull(),
    /** The carrier's own words. */
    message: text('message').notNull(),
    enabled: bool('enabled').notNull().default(true),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('dunning_stages_org_id_uq').on(t.orgId, t.id),
    uniqueIndex('dunning_stages_org_sequence_uq').on(t.orgId, t.sequence),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'dunning_stages_org_fk',
    }).onDelete('cascade'),
  ],
);

export type DunningStage = typeof dunningStages.$inferSelect;

/**
 * One sweep of the ladder across every overdue invoice.
 *
 * Same shape as a statement run and for the same reason: `(org_id, due_on)`
 * is unique, so whoever writes the row owns the sweep and a second trigger
 * finds it taken. Dunning runs daily, so the occurrence is simply the date.
 */
export const dunningRuns = sqliteTable(
  'dunning_runs',
  {
    id: pk(),
    orgId: orgId(),

    dueOn: ts('due_on').notNull(),
    trigger: text('trigger', { enum: RUN_TRIGGERS }).notNull(),

    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at'),

    /** Overdue invoices examined, including every one that was held back. */
    consideredCount: integer('considered_count').notNull().default(0),
    sentCount: integer('sent_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    /** Held back by one of the rules. The reason is on each notice row. */
    heldCount: integer('held_count').notNull().default(0),

    error: text('error'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('dunning_runs_org_id_uq').on(t.orgId, t.id),
    uniqueIndex('dunning_runs_org_due_uq').on(t.orgId, t.dueOn),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'dunning_runs_org_fk',
    }).onDelete('cascade'),
  ],
);

export type DunningRun = typeof dunningRuns.$inferSelect;

export const DUNNING_OUTCOMES = ['sent', 'failed'] as const;
export type DunningOutcome = (typeof DUNNING_OUTCOMES)[number];

/**
 * A notice that was sent, or tried.
 *
 * A failed attempt is kept rather than discarded, so the next sweep can try
 * the same rung again and a person can see that it was attempted. What
 * decides whether a rung has been climbed is a `sent` row, not a row.
 *
 * `balanceCents` and `daysPastDue` are frozen at the moment the notice went,
 * because the question afterwards is what the customer was told, not what
 * they owe today.
 */
export const dunningNotices = sqliteTable(
  'dunning_notices',
  {
    id: pk(),
    orgId: orgId(),

    invoiceId: text('invoice_id').notNull(),
    runId: text('run_id'),
    stageSequence: integer('stage_sequence').notNull(),
    stageLabel: text('stage_label').notNull(),

    outcome: text('outcome', { enum: DUNNING_OUTCOMES }).notNull(),
    /** Why the send failed. Null when it went. */
    detail: text('detail'),

    sentAt: ts('sent_at').notNull(),
    documentId: text('document_id'),

    balanceCents: money('balance_cents').notNull().default(0),
    daysPastDue: integer('days_past_due').notNull().default(0),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('dunning_notices_org_id_uq').on(t.orgId, t.id),
    index('dunning_notices_invoice_idx').on(t.orgId, t.invoiceId),
    index('dunning_notices_run_idx').on(t.orgId, t.runId),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'dunning_notices_org_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.invoiceId],
      foreignColumns: [invoices.orgId, invoices.id],
      name: 'dunning_notices_invoice_fk',
    }).onDelete('cascade'),
  ],
);

export type DunningNotice = typeof dunningNotices.$inferSelect;

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

    /**
     * Whether the carrier pays this back to the driver.
     *
     * Not the driver's decision. A driver who could mark their own fuel
     * reimbursable on a percentage lease would be authorising their own
     * repayment, and the settlement sweeps this flag up automatically — so a
     * driver records the expense and somebody else decides.
     */
    reimbursable: bool('reimbursable').notNull().default(false),
    /**
     * When that decision was made. Null means nobody has looked yet, which is
     * a different thing from "decided no" and has to be visible as one.
     */
    reviewedAt: ts('reviewed_at'),
    reviewedByUserId: text('reviewed_by_user_id').references(() => users.id),
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
