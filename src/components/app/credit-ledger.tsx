'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowDownLeft, ArrowRightLeft, ChevronDown } from 'lucide-react';
import { money, relativeTime } from '@/lib/utils/format';
import type { CreditMovementView } from '@/components/app/customer-credit';

/**
 * What a customer is holding with the carrier, on the customers screen.
 *
 * A balance with no history is a figure nobody can defend, so the movements
 * are one click away and each one names the invoice it came off or went on.
 * The question this answers is the one asked months later: "you kept $500 of
 * ours in March — where did it go?"
 *
 * Read-only here. Undoing a movement changes an invoice's position, so it
 * happens on that invoice where the consequence is visible.
 */

export function CreditLedger({
  balanceCents,
  movements,
}: {
  balanceCents: number;
  movements: CreditMovementView[];
}) {
  const [open, setOpen] = useState(false);

  if (balanceCents === 0 && movements.length === 0) {
    return <p className="text-xs text-ink-muted">No credit on account.</p>;
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="min-w-0">
          <span className="text-xs font-medium tracking-wide text-ink-muted uppercase">
            On account
          </span>
          <span
            className={
              'mt-0.5 block text-sm font-semibold tabular-nums ' +
              (balanceCents > 0 ? 'text-brand' : 'text-ink-secondary')
            }
          >
            {money(balanceCents)}
          </span>
        </span>
        <ChevronDown
          className={'size-4 shrink-0 text-ink-muted transition-transform ' + (open ? 'rotate-180' : '')}
          aria-hidden
        />
      </button>

      {open && (
        <ul className="mt-2 space-y-1.5">
          {movements.map((movement) => (
            <li key={movement.id} className="flex items-start gap-2">
              {movement.direction === 'in' ? (
                <ArrowRightLeft className="mt-0.5 size-3 shrink-0 text-ink-muted" aria-hidden />
              ) : (
                <ArrowDownLeft className="mt-0.5 size-3 shrink-0 text-ink-muted" aria-hidden />
              )}
              <span className="min-w-0 text-xs leading-relaxed text-ink-secondary">
                {movement.direction === 'in' ? '+' : '−'}
                {money(movement.amountCents)}{' '}
                {movement.direction === 'in' ? 'off' : 'onto'}{' '}
                <Link
                  href={`/invoices/${movement.invoiceId}`}
                  className="text-ink underline-offset-2 hover:underline"
                >
                  {movement.invoiceNumber ?? 'an invoice'}
                </Link>
                <span className="text-ink-muted">
                  {' '}
                  · {relativeTime(new Date(movement.occurredAt))}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
