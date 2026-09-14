'use client';

import { useState } from 'react';
import { AlertCircle, FileText, Trash2 } from 'lucide-react';
import { removeExpenseAction, reviewExpenseAction } from '@/app/(app)/expenses/actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/app/page-header';
import { money } from '@/lib/utils/format';
import { CATEGORY_LABEL, REVIEW_LABEL, REVIEW_TONE } from '@/lib/expenses/categories';
import type { ExpenseReview } from '@/lib/expenses/categories';
import { Wallet } from 'lucide-react';

/**
 * Expenses that have reached the server.
 *
 * The same list for a driver and for whoever approves — what changes is the
 * buttons. A driver sees their own and can withdraw one nobody has looked at
 * yet; an approver sees everyone's and decides.
 */

export interface ExpenseView {
  id: string;
  category: string;
  amountCents: number;
  incurredAt: string;
  vendor: string | null;
  notes: string | null;
  loadNumber: string | null;
  driverName: string | null;
  hasReceipt: boolean;
  review: ExpenseReview;
  reimbursedAt: string | null;
}

export function ExpenseList({
  expenses,
  canApprove,
  showDriver,
}: {
  expenses: ExpenseView[];
  canApprove: boolean;
  /** True for an approver, where whose expense it is matters. */
  showDriver: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const review = async (id: string, reimbursable: boolean) => {
    setBusy(id);
    setError(null);
    try {
      const result = await reviewExpenseAction(id, reimbursable);
      if (!result.ok) setError(result.error ?? 'That could not be recorded.');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const result = await removeExpenseAction(id);
      if (!result.ok) setError(result.error ?? 'That could not be removed.');
    } finally {
      setBusy(null);
    }
  };

  if (expenses.length === 0) {
    return (
      <EmptyState
        icon={Wallet}
        title="Nothing recorded yet"
        description="Fuel, tolls, scales, a lumper at a terminal — anything you paid for out of pocket. Record it with the receipt and it goes to your dispatcher to approve for reimbursement."
      />
    );
  }

  const pending = expenses.filter((expense) => expense.review === 'pending');
  const total = expenses
    .filter((expense) => expense.review === 'approved' && !expense.reimbursedAt)
    .reduce((sum, expense) => sum + expense.amountCents, 0);

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-5 py-4">
        <h2 className="text-sm font-semibold text-ink">
          {expenses.length} expense{expenses.length === 1 ? '' : 's'}
        </h2>
        <p className="text-xs text-ink-secondary">
          {pending.length > 0 && `${pending.length} awaiting review · `}
          {money(total)} approved and not yet paid back
        </p>
      </div>

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 border-b border-line bg-danger-soft px-5 py-3 text-sm text-danger"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}

      <ul className="divide-y divide-line">
        {expenses.map((expense) => (
          <li key={expense.id} className="flex flex-wrap items-start gap-3 px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-ink">
                  {CATEGORY_LABEL[expense.category as keyof typeof CATEGORY_LABEL] ??
                    expense.category}
                </span>
                <span className="text-sm text-ink tabular-nums">{money(expense.amountCents)}</span>
                <Badge tone={REVIEW_TONE[expense.review]} size="sm">
                  {REVIEW_LABEL[expense.review]}
                </Badge>
                {expense.reimbursedAt && (
                  <Badge tone="ok" size="sm">
                    Paid back
                  </Badge>
                )}
              </p>
              <p className="mt-0.5 text-xs text-ink-secondary">
                {new Date(expense.incurredAt).toLocaleDateString('en-US')}
                {expense.vendor && ` · ${expense.vendor}`}
                {expense.loadNumber && ` · ${expense.loadNumber}`}
                {showDriver && expense.driverName && ` · ${expense.driverName}`}
              </p>
              {expense.notes && <p className="mt-0.5 text-xs text-ink-muted">{expense.notes}</p>}
              {!expense.hasReceipt && (
                <p className="mt-0.5 text-xs text-warn">No receipt on file</p>
              )}
            </div>

            <div className="flex shrink-0 flex-wrap gap-1.5">
              {expense.hasReceipt && (
                <a
                  href={`/api/expenses/${expense.id}/receipt`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs text-ink-secondary transition-colors hover:border-line-strong hover:text-ink"
                >
                  <FileText className="size-3.5" aria-hidden />
                  Receipt
                </a>
              )}

              {canApprove && !expense.reimbursedAt && (
                <>
                  {expense.review !== 'approved' && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      loading={busy === expense.id}
                      onClick={() => void review(expense.id, true)}
                    >
                      Reimburse
                    </Button>
                  )}
                  {expense.review !== 'declined' && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy === expense.id}
                      onClick={() => void review(expense.id, false)}
                    >
                      {expense.review === 'approved' ? 'Undo' : 'Decline'}
                    </Button>
                  )}
                </>
              )}

              {!expense.reimbursedAt && (canApprove || expense.review === 'pending') && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy === expense.id}
                  aria-label="Remove this expense"
                  onClick={() => void remove(expense.id)}
                >
                  <Trash2 aria-hidden />
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {canApprove && (
        <p className="border-t border-line px-5 py-3 text-xs leading-relaxed text-ink-muted">
          Anything marked for reimbursement is picked up automatically by the next settlement that
          covers the date it was incurred. Once paid it cannot be changed here — a correction goes
          on the following settlement.
        </p>
      )}
    </Card>
  );
}
