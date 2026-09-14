'use client';

import { useState } from 'react';
import { AlertCircle, Ban, Check, Mail, Scale, Unlock } from 'lucide-react';
import {
  acknowledgeClaimAction,
  disposeClaimAction,
  releaseHoldAction,
  sendStatusLetterAction,
  withdrawClaimAction,
} from '@/app/(app)/claims/actions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { money } from '@/lib/utils/format';

/**
 * The moves available on an open claim.
 *
 * Each one produces the letter the regulation asks for and records the date it
 * was produced. Nothing here sends email — the carrier does that — so the
 * wording is about what was written, not what was delivered.
 */

export interface ClaimActionsProps {
  claimId: string;
  status: string;
  acknowledged: boolean;
  closed: boolean;
  demandAmountCents: number | null;
  legalHold: boolean;
  canWrite: boolean;
}

type Panel = 'status' | 'dispose' | 'withdraw' | null;

export function ClaimActions({
  claimId,
  status,
  acknowledged,
  closed,
  demandAmountCents,
  legalHold,
  canWrite,
}: ClaimActionsProps) {
  const [panel, setPanel] = useState<Panel>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [disposition, setDisposition] = useState<'paid' | 'offered' | 'declined'>('declined');

  if (!canWrite) {
    return (
      <p className="text-xs text-ink-muted">
        Your role can read claims but not act on them.
      </p>
    );
  }

  const run = async (key: string, work: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(key);
    setError(null);
    try {
      const result = await work();
      if (result.ok) setPanel(null);
      else setError(result.error ?? 'That did not go through.');
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}

      {!closed && (
        <div className="flex flex-wrap gap-2">
          {!acknowledged && (
            <Button
              type="button"
              onClick={() => void run('ack', () => acknowledgeClaimAction(claimId))}
              loading={busy === 'ack'}
              disabled={busy !== null}
            >
              <Mail aria-hidden />
              Write the acknowledgement
            </Button>
          )}

          {acknowledged && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => setPanel(panel === 'status' ? null : 'status')}
              disabled={busy !== null}
            >
              <Mail aria-hidden />
              Send a status letter
            </Button>
          )}

          <Button
            type="button"
            variant={acknowledged ? undefined : 'secondary'}
            onClick={() => setPanel(panel === 'dispose' ? null : 'dispose')}
            disabled={busy !== null}
          >
            <Scale aria-hidden />
            {status === 'offered' ? 'Close the claim' : 'Pay, offer or decline'}
          </Button>

          <Button
            type="button"
            variant="ghost"
            onClick={() => setPanel(panel === 'withdraw' ? null : 'withdraw')}
            disabled={busy !== null}
          >
            <Ban aria-hidden />
            Claimant withdrew it
          </Button>
        </div>
      )}

      {closed && legalHold && (
        <div className="space-y-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void run('hold', () => releaseHoldAction(claimId))}
            loading={busy === 'hold'}
          >
            <Unlock aria-hidden />
            Release the legal hold
          </Button>
          <p className="text-xs leading-relaxed text-ink-muted">
            The hold stops this load&rsquo;s records being aged out by retention. A declined claim can
            still become a lawsuit for two years and these records are the defence, so releasing it
            is a decision somebody makes rather than something that happens on its own.
          </p>
        </div>
      )}

      {panel === 'status' && (
        <Card>
          <form action={(formData) => void run('status', () => sendStatusLetterAction(claimId, formData))}>
            <div className="p-5">
              <Input
                name="delayReason"
                label="Why is the claim still open?"
                required
                placeholder="Awaiting the repair estimate from the claimant."
                hint="49 CFR 370.9 requires the reason for the delay, not just the fact of it."
              />
            </div>
            <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
              <Button type="button" variant="ghost" onClick={() => setPanel(null)}>
                Cancel
              </Button>
              <Button type="submit" loading={busy === 'status'}>
                Write the letter
              </Button>
            </div>
          </form>
        </Card>
      )}

      {panel === 'dispose' && (
        <Card>
          <form action={(formData) => void run('dispose', () => disposeClaimAction(claimId, formData))}>
            <div className="space-y-4 p-5">
              <fieldset>
                <legend className="text-sm font-medium text-ink">Decision</legend>
                <div className="mt-2 space-y-2">
                  {(
                    [
                      ['paid', 'Pay the claim', 'Allows it in full or in part and closes the file.'],
                      [
                        'offered',
                        'Make a firm compromise offer',
                        'Satisfies the 120-day deadline but leaves the claim open, so the 60-day letters keep running.',
                      ],
                      [
                        'declined',
                        'Decline the claim',
                        'Written notice of disallowance. Starts the claimant’s two-year window to sue.',
                      ],
                    ] as const
                  ).map(([value, label, hint]) => (
                    <label
                      key={value}
                      className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line p-3 transition-colors hover:border-line-strong"
                    >
                      <input
                        type="radio"
                        name="disposition"
                        value={value}
                        checked={disposition === value}
                        onChange={() => setDisposition(value)}
                        className="mt-0.5 size-4 accent-[var(--brand)]"
                      />
                      <span>
                        <span className="block text-sm text-ink">{label}</span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-ink-secondary">
                          {hint}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              {disposition !== 'declined' && (
                <Input
                  name="amount"
                  label={disposition === 'paid' ? 'Amount allowed' : 'Amount offered'}
                  inputMode="decimal"
                  required
                  leading={<span className="text-sm">$</span>}
                  defaultValue={
                    demandAmountCents ? (demandAmountCents / 100).toFixed(2) : undefined
                  }
                  hint={
                    demandAmountCents
                      ? `The claimant asked for ${money(demandAmountCents)}.`
                      : 'No amount was demanded.'
                  }
                />
              )}

              <div>
                <label htmlFor="reason" className="text-sm font-medium text-ink">
                  {disposition === 'declined' ? 'Reason for declining' : 'Basis for the decision'}
                </label>
                <textarea
                  id="reason"
                  name="reason"
                  rows={3}
                  required={disposition === 'declined'}
                  placeholder="The damage claimed appears on the sealed pickup inspection, so it pre-dates carriage."
                  className="mt-2 w-full rounded-lg border border-line bg-raised px-3 py-2.5 text-sm text-ink placeholder:text-ink-muted focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
                />
                {disposition === 'declined' && (
                  <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
                    This goes on the face of the declination letter. It is the document the
                    claimant&rsquo;s two-year window runs from, so a reason nobody wrote down is one
                    nobody can defend.
                  </p>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
              <Button type="button" variant="ghost" onClick={() => setPanel(null)}>
                Cancel
              </Button>
              <Button type="submit" loading={busy === 'dispose'}>
                <Check aria-hidden />
                Write the disposition
              </Button>
            </div>
          </form>
        </Card>
      )}

      {panel === 'withdraw' && (
        <Card>
          <form action={(formData) => void run('withdraw', () => withdrawClaimAction(claimId, formData))}>
            <div className="p-5">
              <Input
                name="reason"
                label="What did the claimant say?"
                required
                placeholder="Claimant withdrew by email after reviewing the pickup photographs."
                hint="Closes the file without a decision on the merits, so the record has to say why."
              />
            </div>
            <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
              <Button type="button" variant="ghost" onClick={() => setPanel(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="secondary" loading={busy === 'withdraw'}>
                Record the withdrawal
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
