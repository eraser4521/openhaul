'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertCircle,
  AlertTriangle,
  Ban,
  Building2,
  CircleCheck,
  Info,
  RefreshCw,
  Search,
} from 'lucide-react';
import { lookupCarrierAction, type LookupResult } from '@/app/(app)/customers/actions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { relativeTime, num } from '@/lib/utils/format';
import {
  AUTHORITY_LABEL,
  limitations,
  VERDICT_HEADLINE,
  type CarrierProfile,
  type Finding,
  type Role,
  type Verdict,
} from '@/lib/fmcsa/assess';

/**
 * Checking who you are about to do business with.
 *
 * Deliberately does not render a green tick and the word "verified". FMCSA can
 * say a company is registered and permitted to operate; it cannot say they are
 * insured for your vehicles, solvent, or going to turn up. The limitations sit
 * under every result, including the clean ones, because a check that leaves
 * somebody more confident than the data warrants is worse than no check.
 */

const VERDICT_TONE: Record<Verdict, 'ok' | 'warn' | 'danger'> = {
  clear: 'ok',
  caution: 'warn',
  blocked: 'danger',
};

const VERDICT_ICON: Record<Verdict, typeof CircleCheck> = {
  clear: CircleCheck,
  caution: AlertTriangle,
  blocked: Ban,
};

const SEVERITY_TONE: Record<Finding['severity'], 'danger' | 'warn' | 'neutral'> = {
  blocking: 'danger',
  warning: 'warn',
  note: 'neutral',
};

export interface CarrierLookupProps {
  /** Prefilled when opened from a customer record. */
  defaultNumber?: string | null;
  defaultRole?: Role;
  customerId?: string | null;
  customerName?: string | null;
  /** False when FMCSA_WEB_KEY is unset, so the panel can say why up front. */
  configured: boolean;
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium tracking-wide text-ink-muted uppercase">{label}</dt>
      <dd className="mt-1 text-sm text-ink">{value}</dd>
    </div>
  );
}

function Authority({ profile }: { profile: CarrierProfile }) {
  const rows: Array<[string, string]> = [
    ['Common', AUTHORITY_LABEL[profile.commonAuthority]],
    ['Contract', AUTHORITY_LABEL[profile.contractAuthority]],
    ['Broker', AUTHORITY_LABEL[profile.brokerAuthority]],
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {rows.map(([label, value]) => (
        <div key={label} className="rounded-lg border border-line p-3">
          <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
            {label} authority
          </p>
          <p
            className={
              'mt-1 text-sm ' + (value === 'Active' ? 'font-medium text-ok' : 'text-ink-secondary')
            }
          >
            {value}
          </p>
        </div>
      ))}
    </div>
  );
}

export function CarrierLookup({
  defaultNumber,
  defaultRole = 'carrier',
  customerId,
  customerName,
  configured,
}: CarrierLookupProps) {
  const [result, setResult] = useState<LookupResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState<Role>(defaultRole);

  const run = async (formData: FormData) => {
    setBusy(true);
    try {
      setResult(await lookupCarrierAction(formData));
    } catch {
      setResult({ ok: false, error: 'The lookup did not go through. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  const lookup = result?.ok ? result.lookup : undefined;
  const profile = lookup?.profile;
  const Icon = lookup ? VERDICT_ICON[lookup.verdict] : Search;

  return (
    <Card>
      <div className="border-b border-line px-5 py-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Building2 className="size-4 text-ink-muted" aria-hidden />
          {customerName ? `Check ${customerName} with FMCSA` : 'Check a carrier or broker'}
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
          Looks the number up in FMCSA&rsquo;s registration census and records what came back, so
          the check can be produced later.
        </p>
      </div>

      {!configured && (
        <p className="flex items-start gap-2 border-b border-line bg-warn-soft px-5 py-3 text-xs leading-relaxed text-warn">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            No FMCSA key is set, so live lookups are off. A key is free and issued immediately at{' '}
            <a
              href="https://mobile.fmcsa.dot.gov/QCDevsite/home/register"
              target="_blank"
              rel="noreferrer noopener"
              className="underline"
            >
              mobile.fmcsa.dot.gov
            </a>
            ; put it in <code className="font-mono">FMCSA_WEB_KEY</code>. Checks already recorded
            are still shown.
          </span>
        </p>
      )}

      <form action={run}>
        {customerId && <input type="hidden" name="customerId" value={customerId} />}

        <div className="grid gap-4 p-5 sm:grid-cols-3">
          <div className="sm:col-span-1">
            <Input
              name="number"
              label="Number"
              required
              defaultValue={defaultNumber ?? ''}
              placeholder="3312907"
              hint="Digits only; the prefix is ignored."
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="kind" className="text-sm font-medium text-ink">
              Number type
            </label>
            <select
              id="kind"
              name="kind"
              defaultValue="usdot"
              className="h-10 rounded-lg border border-line bg-raised px-3 text-sm text-ink focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
            >
              <option value="usdot">USDOT</option>
              <option value="docket">MC / docket</option>
            </select>
            <p className="text-xs text-ink-muted">USDOT is the one that is unique.</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="role" className="text-sm font-medium text-ink">
              Checking them as
            </label>
            <select
              id="role"
              name="role"
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
              className="h-10 rounded-lg border border-line bg-raised px-3 text-sm text-ink focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
            >
              <option value="carrier">A carrier who will haul</option>
              <option value="broker">A broker who will pay me</option>
            </select>
            <p className="text-xs text-ink-muted">
              {role === 'broker'
                ? 'Checks broker authority and the surety bond.'
                : 'Checks operating authority and liability filings.'}
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
          {lookup && (
            <Button
              type="submit"
              variant="ghost"
              name="force"
              value="1"
              loading={busy}
              disabled={busy}
            >
              <RefreshCw aria-hidden />
              Check again now
            </Button>
          )}
          <Button type="submit" loading={busy} disabled={busy}>
            <Search aria-hidden />
            Check
          </Button>
        </div>
      </form>

      {result && !result.ok && (
        <div className="border-t border-line px-5 py-4">
          <p
            role="alert"
            className="flex items-start gap-2 text-sm leading-relaxed text-warn"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {result.error}
          </p>

          {result.candidates && result.candidates.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {result.candidates.map((candidate) => (
                <li key={candidate.dotNumber ?? candidate.legalName} className="text-xs text-ink-secondary">
                  · <span className="font-mono">USDOT {candidate.dotNumber ?? '—'}</span>{' '}
                  {candidate.legalName}
                  {candidate.location ? ` — ${candidate.location}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {lookup && profile && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="border-t border-line">
          <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2">
                <Icon
                  className={
                    'size-4 shrink-0 ' +
                    (lookup.verdict === 'clear'
                      ? 'text-ok'
                      : lookup.verdict === 'caution'
                        ? 'text-warn'
                        : 'text-danger')
                  }
                  aria-hidden
                />
                <span className="text-sm font-semibold text-ink">
                  {VERDICT_HEADLINE[lookup.verdict]}
                </span>
                <Badge tone={VERDICT_TONE[lookup.verdict]} size="sm">
                  {lookup.role === 'broker' ? 'As a broker' : 'As a carrier'}
                </Badge>
              </p>
              <p className="mt-1 text-sm text-ink">
                {profile.legalName ?? 'Name not reported'}
                {profile.dbaName ? ` (dba ${profile.dbaName})` : ''}
              </p>
              <p className="mt-0.5 text-xs text-ink-muted">
                USDOT {profile.dotNumber ?? '—'}
                {profile.address ? ` · ${profile.address}` : ''}
              </p>
            </div>

            <p className="text-xs text-ink-muted">
              {lookup.cached ? 'From the last check, ' : 'Checked '}
              {relativeTime(lookup.checkedAt)}
            </p>
          </div>

          <div className="border-t border-line px-5 py-4">
            <Authority profile={profile} />
          </div>

          <dl className="grid gap-4 border-t border-line px-5 py-4 sm:grid-cols-4">
            <Detail
              label="Allowed to operate"
              value={
                profile.allowedToOperate === null
                  ? 'Not reported'
                  : profile.allowedToOperate
                    ? 'Yes'
                    : 'No'
              }
            />
            <Detail label="Safety rating" value={profile.safetyRating ?? 'Unrated'} />
            <Detail label="Power units" value={profile.powerUnits === null ? '—' : num(profile.powerUnits)} />
            <Detail label="Drivers" value={profile.drivers === null ? '—' : num(profile.drivers)} />
          </dl>

          {lookup.findings.length > 0 && (
            <ul className="divide-y divide-line border-t border-line">
              {lookup.findings.map((finding) => (
                <li key={finding.title} className="px-5 py-3.5">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge tone={SEVERITY_TONE[finding.severity]} size="sm">
                      {finding.severity === 'blocking'
                        ? 'Stop'
                        : finding.severity === 'warning'
                          ? 'Ask'
                          : 'Note'}
                    </Badge>
                    <span className="text-sm font-medium text-ink">{finding.title}</span>
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
                    {finding.detail}
                  </p>
                </li>
              ))}
            </ul>
          )}

          <div className="border-t border-line bg-raised px-5 py-4">
            <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
              What this does not tell you
            </p>
            <ul className="mt-2 space-y-1.5">
              {limitations(lookup.role).map((limit) => (
                <li key={limit} className="text-xs leading-relaxed text-ink-secondary">
                  · {limit}
                </li>
              ))}
            </ul>
          </div>
        </motion.div>
      )}
    </Card>
  );
}
