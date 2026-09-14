import type { CreditReason, InvoiceStatus } from '../db/schema';

/** Presentation for invoice status, shared by the list and the detail screen. */

export const INVOICE_STATUS_TONE: Record<
  InvoiceStatus,
  'neutral' | 'ok' | 'warn' | 'info' | 'danger'
> = {
  draft: 'neutral',
  sent: 'info',
  partially_paid: 'warn',
  paid: 'ok',
  overdue: 'danger',
  void: 'neutral',
};

export function invoiceStatusLabel(status: InvoiceStatus): string {
  return status.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  cash: 'Cash',
  check: 'Check',
  cashiers_check: "Cashier's check",
  money_order: 'Money order',
  comchek: 'Comchek',
  ach: 'ACH',
  direct_deposit: 'Direct deposit',
  credit_card: 'Credit card',
  zelle: 'Zelle',
  venmo: 'Venmo',
  cashapp: 'Cash App',
  other: 'Other',
};

export function paymentMethodLabel(method: string): string {
  return PAYMENT_METHOD_LABEL[method] ?? method.replace(/_/g, ' ');
}

/**
 * Why an invoice was credited.
 *
 * Here rather than beside the credit lifecycle because that module is
 * server-only — it holds a database handle — and the reason labels are needed
 * by the form a person fills in.
 */
export const CREDIT_REASON_LABEL: Record<CreditReason, string> = {
  rate_adjustment: 'Rate adjustment',
  damage_offset: 'Damage offset against the freight bill',
  service_failure: 'Service failure',
  billing_error: 'Billing error',
  goodwill: 'Goodwill',
  other: 'Other',
};
