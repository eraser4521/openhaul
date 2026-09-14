'use client';

import { useState } from 'react';
import { AlertCircle, Ban, Download, Minus } from 'lucide-react';
import { raiseCreditAction, voidCreditAction } from '@/app/(app)/invoices/actions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { CREDIT_REASONS } from '@/lib/db/schema';
import { CREDIT_REASON_LABEL } from '@/lib/invoices/display';
import { money, relativeTime } from '@/lib/utils/format';

/**
 * Credits against an invoice.
 *
 * Shown beneath the payments rather than mixed into them, because "they paid"
 * and "we decided not to collect" are different facts and an accounts
 * conversation turns on which one happened.
 */

export interface CreditNoteRow {
  id: string;
  number: string;
  reason: string;
  detail: string;
  amountCents: number;
  createdAt: Date;
  voidedAt: Date | null;
  voidReason: string | null;
  documentId: string | null;
  claimNumber: string | null;
}

export interface ClaimOption {
  id: string;
  number: string;
  claimantName: string;
}

export interface CreditNotesProps {
  invoiceId: string;
  notes: CreditNoteRow[];
  /** Zero when the invoice is fully credited or cannot be credited at all. */
  creditableCents: number;
  /** Why crediting is unavailable, when it is. */
  blockedReason: string | null;
  claims: ClaimOption[];
  canWrite: boolean;
}

export function CreditNotes({
  invoiceId,
  notes,
  creditableCents,
  blockedReason,
  claims,
  canWrite,
}: CreditNotesProps) {
  const [open, setOpen] = useState(false);
  const [voiding, setVoiding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const raise = async (formData: FormData) => {
    setBusy(true);
    setError(null);
    try {
      const result = await raiseCreditAction(invoiceId, formData);
      if (result.ok) setOpen(false);
      else setError(result.error ?? 'The credit note could not be raised.');
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (creditNoteId: string, formData: FormData) => {
    setBusy(true);
    setError(null);
    try {
      const result = await voidCreditAction(invoiceId, creditNoteId, formData);
      if (result.ok) setVoiding(null);
      else setError(result.error ?? 'The credit note could not be withdrawn.');
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">Credit notes</h2>
        {canWrite && !blockedReason && !open && (
          <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
            <Minus aria-hidden />
            Raise a credit
          </Button>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm leading-relaxed text-danger"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}

      {blockedReason && notes.length === 0 && (
        <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs leading-relaxed text-ink-muted">
          {blockedReason}
        </p>
      )}

      {open && (
        <Card>
          <div className="border-b border-line px-5 py-4">
            <h3 className="text-sm font-semibold text-ink">Raise a credit note</h3>
            <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
              Reduces what is owed without changing what the invoice says. The customer keeps the
              invoice they were sent and gets a second document explaining the reduction.
            </p>
          </div>

          <form action={raise}>
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="reason" className="text-sm font-medium text-ink">
                  Reason
                </label>
                <select
                  id="reason"
                  name="reason"
                  defaultValue="rate_adjustment"
                  className="h-10 rounded-lg border border-line bg-raised px-3 text-sm text-ink focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
                >
                  {CREDIT_REASONS.map((reason) => (
                    <option key={reason} value={reason}>
                      {CREDIT_REASON_LABEL[reason]}
                    </option>
                  ))}
                </select>
              </div>

              <Input
                name="amount"
                label="Amount to credit"
                required
                inputMode="decimal"
                leading={<span className="text-sm">$</span>}
                hint={`${money(creditableCents)} of this invoice is left to credit.`}
              />

              {claims.length > 0 && (
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <label htmlFor="claimId" className="text-sm font-medium text-ink">
                    Settles a claim
                  </label>
                  <select
                    id="claimId"
                    name="claimId"
                    defaultValue=""
                    className="h-10 rounded-lg border border-line bg-raised px-3 text-sm text-ink focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
                  >
                    <option value="">Not settling a claim</option>
                    {claims.map((claim) => (
                      <option key={claim.id} value={claim.id}>
                        {claim.number} — {claim.claimantName}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs leading-relaxed text-ink-muted">
                    For a cargo claim taken off the freight bill instead of paid out. The claim
                    number goes on the face of the credit note.
                  </p>
                </div>
              )}

              <div className="sm:col-span-2">
                <label htmlFor="detail" className="text-sm font-medium text-ink">
                  What is being credited
                </label>
                <textarea
                  id="detail"
                  name="detail"
                  rows={3}
                  required
                  placeholder="Detention at pickup withdrawn after reviewing the gate log."
                  className="mt-2 w-full rounded-lg border border-line bg-raised px-3 py-2.5 text-sm text-ink placeholder:text-ink-muted focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
                />
                <p className="mt-1.5 text-xs text-ink-muted">
                  Printed on the credit note. The customer&rsquo;s accounts department will read it
                  before applying anything.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" loading={busy}>
                Raise the credit note
              </Button>
            </div>
          </form>
        </Card>
      )}

      {notes.length > 0 && (
        <ul className="space-y-2">
          {notes.map((note) => (
            <li
              key={note.id}
              className="rounded-lg border border-line bg-raised p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm text-ink">{note.number}</span>
                    <Badge tone={note.voidedAt ? 'neutral' : 'info'} size="sm">
                      {note.voidedAt ? 'Withdrawn' : CREDIT_REASON_LABEL[note.reason as never]}
                    </Badge>
                    {note.claimNumber && (
                      <Badge tone="neutral" size="sm">
                        {note.claimNumber}
                      </Badge>
                    )}
                  </p>
                  <p className="mt-1 text-sm leading-relaxed text-ink-secondary">{note.detail}</p>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    Raised {relativeTime(note.createdAt)}
                    {note.voidedAt ? ` · withdrawn: ${note.voidReason}` : ''}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <span
                    className={
                      'text-sm tabular-nums ' + (note.voidedAt ? 'text-ink-muted line-through' : 'text-ink')
                    }
                  >
                    ({money(note.amountCents)})
                  </span>
                  {note.documentId && (
                    <a
                      href={`/api/documents/${note.documentId}?download=1`}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs text-ink-secondary transition-colors hover:border-line-strong hover:text-ink"
                    >
                      <Download className="size-3.5" aria-hidden />
                      PDF
                    </a>
                  )}
                </div>
              </div>

              {canWrite && !note.voidedAt && (
                <div className="mt-3 border-t border-line pt-3">
                  {voiding === note.id ? (
                    <form action={(formData) => void withdraw(note.id, formData)} className="space-y-2">
                      <Input
                        name="reason"
                        label="Why is this credit being withdrawn?"
                        required
                        placeholder="Raised against the wrong invoice."
                        hint="Puts the money back onto the customer’s balance, and stays on the record."
                      />
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setVoiding(null)}
                        >
                          Cancel
                        </Button>
                        <Button type="submit" variant="secondary" size="sm" loading={busy}>
                          Withdraw it
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setVoiding(note.id)}
                    >
                      <Ban aria-hidden />
                      Withdraw this credit
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
