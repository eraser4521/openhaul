'use client';

import { useState } from 'react';
import { AlertCircle, ArrowDownLeft, ArrowRightLeft, Info, PiggyBank, Trash2 } from 'lucide-react';
import {
  applyCreditAction,
  carryForwardAction,
  removeMovementAction,
} from '@/app/(app)/invoices/credit-actions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { money, relativeTime } from '@/lib/utils/format';

/**
 * The customer's balance, from the invoice screen.
 *
 * The credit note a customer receives offers them two ways to settle an
 * overpayment — refunded, or carried against their next invoice — so both
 * have to exist here. The refund card next to this one is the first; this is
 * the second.
 *
 * Deliberately not automatic. Applying a balance to an invoice the moment one
 * is raised would be a reduction nobody chose, on a document about to go to a
 * customer, and the first anyone would know is a query about the figure. So
 * the balance is stated where it cannot be missed and somebody clicks.
 */

export interface CreditMovementView {
  id: string;
  direction: 'in' | 'out';
  amountCents: number;
  occurredAt: string;
  note: string | null;
  /** The invoice this movement is against, for the ledger on a customer. */
  invoiceId: string;
  invoiceNumber: string | null;
  creditNoteNumber: string | null;
}

export function CustomerCredit({
  invoiceId,
  customerName,
  /** Owed back on this invoice and not yet refunded or carried. */
  carryableCents,
  /** The most of the balance that can go on this invoice. */
  applicableCents,
  /** What the customer holds in total. */
  balanceCents,
  movements,
  canWrite,
  today,
  creditNotes,
}: {
  invoiceId: string;
  customerName: string | null;
  carryableCents: number;
  applicableCents: number;
  balanceCents: number;
  movements: CreditMovementView[];
  canWrite: boolean;
  today: string;
  creditNotes: Array<{ id: string; number: string; amountCents: number }>;
}) {
  const [open, setOpen] = useState<'carry' | 'apply' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Nothing to offer and nothing to show: a credit panel on an ordinary
  // invoice is an invitation to a mistake.
  if (carryableCents === 0 && applicableCents === 0 && movements.length === 0) return null;

  const who = customerName ?? 'This customer';

  const submit = (action: typeof carryForwardAction) => async (formData: FormData) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action(invoiceId, formData);
      if (result.ok) setOpen(null);
      else setError(result.error ?? 'That could not be recorded.');
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (movementId: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await removeMovementAction(invoiceId, movementId);
      if (!result.ok) setError(result.error ?? 'That could not be removed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <PiggyBank className="size-4 text-ink-muted" aria-hidden />
            Customer credit
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
            {carryableCents > 0
              ? `${money(carryableCents)} is owed back. Send it, or keep it on account against their next invoice.`
              : applicableCents > 0
                ? `${who} has ${money(balanceCents)} on account with you.`
                : balanceCents > 0
                  ? `${who} has ${money(balanceCents)} left on account.`
                  : 'Nothing left on account.'}
          </p>
        </div>

        {canWrite && !open && carryableCents > 0 && (
          <Button type="button" variant="secondary" size="sm" onClick={() => setOpen('carry')}>
            <ArrowRightLeft aria-hidden />
            Keep it on account
          </Button>
        )}
        {canWrite && !open && carryableCents === 0 && applicableCents > 0 && (
          <Button type="button" variant="secondary" size="sm" onClick={() => setOpen('apply')}>
            <ArrowDownLeft aria-hidden />
            Apply {money(applicableCents)}
          </Button>
        )}
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

      {open === 'carry' && (
        <form action={submit(carryForwardAction)} className="border-b border-line bg-surface px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-6">
            <div className="sm:col-span-2">
              <Input
                name="amount"
                label="Amount"
                required
                inputMode="decimal"
                leading={<span className="text-sm">$</span>}
                defaultValue={(carryableCents / 100).toFixed(2)}
                hint={`${money(carryableCents)} is owed back.`}
              />
            </div>

            <div className="sm:col-span-2">
              <Input name="occurredAt" label="Agreed on" type="date" defaultValue={today} />
            </div>

            {creditNotes.length > 0 && (
              <div className="sm:col-span-2">
                <label htmlFor="carryCreditNoteId" className="text-sm font-medium text-ink">
                  Against which credit
                </label>
                <select
                  id="carryCreditNoteId"
                  name="creditNoteId"
                  defaultValue=""
                  className="mt-1.5 h-10 w-full rounded-lg border border-line bg-raised px-2 text-sm text-ink focus:border-brand focus:outline-none"
                >
                  <option value="">Not against a credit note</option>
                  {creditNotes.map((note) => (
                    <option key={note.id} value={note.id}>
                      {note.number} — {money(note.amountCents)}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="sm:col-span-6">
              <Input name="note" label="Note" placeholder="Optional — who agreed to it" />
            </div>
          </div>

          <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-ink-muted">
            <Info className="mt-px size-3.5 shrink-0" aria-hidden />
            The money stays with you and this invoice settles, the same as if it had been sent
            back. It is not a refund and will not appear as one — nothing leaves the bank.
          </p>

          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(null)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={busy}>
              Keep it on account
            </Button>
          </div>
        </form>
      )}

      {open === 'apply' && (
        <form action={submit(applyCreditAction)} className="border-b border-line bg-surface px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-6">
            <div className="sm:col-span-2">
              <Input
                name="amount"
                label="Amount"
                required
                inputMode="decimal"
                leading={<span className="text-sm">$</span>}
                defaultValue={(applicableCents / 100).toFixed(2)}
                hint={`${money(applicableCents)} can go on this invoice.`}
              />
            </div>

            <div className="sm:col-span-2">
              <Input name="occurredAt" label="Applied on" type="date" defaultValue={today} />
            </div>

            <div className="sm:col-span-6">
              <Input name="note" label="Note" placeholder="Optional" />
            </div>
          </div>

          <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-ink-muted">
            <Info className="mt-px size-3.5 shrink-0" aria-hidden />
            Recorded separately from payments, because no money arrives today — it arrived
            earlier, on another invoice. The received figure stays what was banked.
          </p>

          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(null)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={busy}>
              Apply it
            </Button>
          </div>
        </form>
      )}

      {movements.length > 0 && (
        <ul className="divide-y divide-line">
          {movements.map((movement) => (
            <li key={movement.id} className="flex flex-wrap items-start gap-3 px-5 py-3.5">
              {movement.direction === 'in' ? (
                <ArrowRightLeft className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
              ) : (
                <ArrowDownLeft className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink">
                  {movement.direction === 'in'
                    ? `${money(movement.amountCents)} kept on account`
                    : `${money(movement.amountCents)} applied from the account`}
                </p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {relativeTime(new Date(movement.occurredAt))}
                  {movement.creditNoteNumber && ` · against ${movement.creditNoteNumber}`}
                </p>
                {movement.note && (
                  <p className="mt-0.5 text-xs text-ink-secondary">{movement.note}</p>
                )}
              </div>
              {canWrite && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label="Undo this movement"
                  title="Recorded in error"
                  onClick={() => void remove(movement.id)}
                >
                  <Trash2 aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
