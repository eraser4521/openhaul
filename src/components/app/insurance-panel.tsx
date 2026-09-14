'use client';

import { useRef, useState } from 'react';
import { AlertCircle, BadgeCheck, FileText, Info, Paperclip, Plus, Trash2 } from 'lucide-react';
import {
  removeCertificateAction,
  saveCertificateAction,
  verifyCertificateAction,
} from '@/app/(app)/insurance-actions';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { money, relativeTime } from '@/lib/utils/format';
import {
  CERTIFICATE_KINDS,
  CERTIFICATE_LIMITS,
  KIND_LABEL,
  KIND_NOTE,
  STATE_TONE,
  describeState,
  expiryState,
  type CertificateKind,
} from '@/lib/insurance/status';

/**
 * Certificates of insurance, for the carrier's own cover or a customer's.
 *
 * The same panel serves both, because they are the same record with a
 * different owner. What changes is the framing: your own certificate is the
 * thing a broker will ask to see before tendering, and a customer's is the
 * thing you asked for before you moved their freight.
 *
 * The limits of a certificate are printed under the list rather than tucked
 * into a tooltip. A file full of certificates reads as proof of cover, and it
 * is not: cancellation is silent unless you are a named certificate holder.
 */

export interface CertificateView {
  id: string;
  kind: CertificateKind;
  insurerName: string;
  policyNumber: string;
  coverageLimitCents: number | null;
  deductibleCents: number | null;
  effectiveAt: string;
  expiresAt: string;
  documentId: string | null;
  verifiedAt: string | null;
}

export function InsurancePanel({
  customerId,
  title,
  description,
  certificates,
  canEdit,
  compact = false,
  framed = true,
}: {
  /** Null for the carrier's own cover. */
  customerId: string | null;
  title: string;
  description: string;
  certificates: CertificateView[];
  canEdit: boolean;
  /** Drops the explanatory notes, for use inside a customer card. */
  compact?: boolean;
  /** False when this sits inside a card already, so it does not nest one. */
  framed?: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = new Date();

  const save = async (certificateId: string | null, formData: FormData) => {
    setBusy(true);
    setError(null);
    try {
      const result = await saveCertificateAction(customerId, certificateId, formData);
      if (result.ok) {
        setAdding(false);
        setEditing(null);
      } else {
        setError(result.error ?? 'That could not be saved.');
      }
    } catch {
      setError('That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async (certificateId: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await verifyCertificateAction(certificateId);
      if (!result.ok) setError(result.error ?? 'That could not be recorded.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (certificateId: string) => {
    setBusy(true);
    try {
      await removeCertificateAction(certificateId);
    } finally {
      setBusy(false);
    }
  };

  const Frame = framed ? Card : 'div';
  const pad = framed ? 'px-5' : 'px-0';

  return (
    <Frame>
      <div
        className={`flex flex-wrap items-start justify-between gap-3 ${framed ? 'border-b border-line px-5 py-4' : 'pb-3'}`}
      >
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-secondary">{description}</p>
        </div>
        {canEdit && !adding && (
          <Button type="button" variant="secondary" size="sm" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            Add
          </Button>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className={`flex items-start gap-2 bg-danger-soft ${pad} py-3 text-sm text-danger`}
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}

      {adding && (
        <CertificateForm busy={busy} onCancel={() => setAdding(false)} onSubmit={(f) => save(null, f)} />
      )}

      {certificates.length === 0 && !adding ? (
        <p className={`${pad} py-6 text-xs leading-relaxed text-ink-muted`}>
          {customerId
            ? 'Nothing on file. Cargo cover is never filed with FMCSA, so a certificate from their insurer is the only way to verify it.'
            : 'Nothing on file. A broker will ask for a certificate before tendering, and cargo cover is not something the FMCSA lookup can confirm.'}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {certificates.map((certificate) => {
            const dates = {
              effectiveAt: new Date(certificate.effectiveAt),
              expiresAt: new Date(certificate.expiresAt),
            };
            const state = expiryState(dates, now);

            return (
              <li key={certificate.id} className={`${pad} py-3.5`}>
                {editing === certificate.id ? (
                  <CertificateForm
                    certificate={certificate}
                    busy={busy}
                    onCancel={() => setEditing(null)}
                    onSubmit={(f) => save(certificate.id, f)}
                  />
                ) : (
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-ink">
                          {KIND_LABEL[certificate.kind]}
                        </span>
                        <Badge tone={STATE_TONE[state]} size="sm">
                          {describeState(dates, now)}
                        </Badge>
                        {certificate.verifiedAt && (
                          <Badge tone="ok" size="sm">
                            <BadgeCheck className="size-3" aria-hidden />
                            Checked
                          </Badge>
                        )}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-secondary">
                        {certificate.insurerName} · {certificate.policyNumber}
                        {certificate.coverageLimitCents != null &&
                          ` · ${money(certificate.coverageLimitCents)} limit`}
                        {certificate.deductibleCents != null &&
                          ` · ${money(certificate.deductibleCents)} deductible`}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-muted">
                        {dates.effectiveAt.toLocaleDateString('en-US')} –{' '}
                        {dates.expiresAt.toLocaleDateString('en-US')}
                        {certificate.verifiedAt &&
                          ` · checked ${relativeTime(new Date(certificate.verifiedAt))}`}
                      </p>
                    </div>

                    <div className="flex shrink-0 flex-wrap gap-1.5">
                      {certificate.documentId ? (
                        <a
                          href={`/api/documents/${certificate.documentId}`}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs text-ink-secondary transition-colors hover:border-line-strong hover:text-ink"
                        >
                          <FileText className="size-3.5" aria-hidden />
                          Certificate
                        </a>
                      ) : (
                        canEdit && <UploadCertificate certificateId={certificate.id} />
                      )}

                      {canEdit && !certificate.verifiedAt && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => void verify(certificate.id)}
                        >
                          I checked it
                        </Button>
                      )}
                      {canEdit && (
                        <>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditing(certificate.id)}
                          >
                            Edit
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            aria-label={`Remove ${KIND_LABEL[certificate.kind]} certificate`}
                            onClick={() => void remove(certificate.id)}
                          >
                            <Trash2 aria-hidden />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!compact && certificates.length > 0 && (
        <div className="space-y-1.5 border-t border-line px-5 py-3">
          {CERTIFICATE_LIMITS.map((limit) => (
            <p key={limit} className="flex items-start gap-1.5 text-xs leading-relaxed text-ink-muted">
              <Info className="mt-px size-3.5 shrink-0" aria-hidden />
              {limit}
            </p>
          ))}
        </div>
      )}
    </Frame>
  );
}

function CertificateForm({
  certificate,
  busy,
  onCancel,
  onSubmit,
}: {
  certificate?: CertificateView;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (formData: FormData) => void;
}) {
  const [kind, setKind] = useState<CertificateKind>(certificate?.kind ?? 'cargo');

  const dollars = (cents: number | null | undefined) =>
    cents == null ? '' : (cents / 100).toFixed(2);
  const day = (iso: string | undefined) => (iso ? iso.slice(0, 10) : '');

  return (
    <form action={onSubmit} className="rounded-lg bg-surface p-4">
      <div className="grid gap-4 sm:grid-cols-6">
        <div className="sm:col-span-2">
          <label htmlFor="kind" className="text-sm font-medium text-ink">
            Cover
          </label>
          <select
            id="kind"
            name="kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as CertificateKind)}
            className="mt-1.5 h-10 w-full rounded-lg border border-line bg-raised px-2 text-sm text-ink focus:border-brand focus:outline-none"
          >
            {CERTIFICATE_KINDS.map((option) => (
              <option key={option} value={option}>
                {KIND_LABEL[option]}
              </option>
            ))}
          </select>
        </div>

        <div className="sm:col-span-4">
          <Input
            name="insurerName"
            label="Insurer"
            required
            defaultValue={certificate?.insurerName ?? ''}
            placeholder="Great West Casualty"
          />
        </div>

        <div className="sm:col-span-3">
          <Input
            name="policyNumber"
            label="Policy number"
            required
            defaultValue={certificate?.policyNumber ?? ''}
          />
        </div>
        <div className="sm:col-span-3" />

        <div className="sm:col-span-3">
          <Input
            name="coverageLimit"
            label="Limit"
            inputMode="decimal"
            leading={<span className="text-sm">$</span>}
            defaultValue={dollars(certificate?.coverageLimitCents)}
            hint="Per occurrence, as printed on the certificate."
          />
        </div>
        <div className="sm:col-span-3">
          <Input
            name="deductible"
            label="Deductible"
            inputMode="decimal"
            leading={<span className="text-sm">$</span>}
            defaultValue={dollars(certificate?.deductibleCents)}
          />
        </div>

        <div className="sm:col-span-3">
          <Input
            name="effectiveAt"
            label="Effective"
            type="date"
            required
            defaultValue={day(certificate?.effectiveAt)}
          />
        </div>
        <div className="sm:col-span-3">
          <Input
            name="expiresAt"
            label="Expires"
            type="date"
            required
            defaultValue={day(certificate?.expiresAt)}
          />
        </div>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-ink-muted">{KIND_NOTE[kind]}</p>

      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" size="sm" loading={busy}>
          {certificate ? 'Save changes' : 'Add it'}
        </Button>
      </div>
    </form>
  );
}

/**
 * Attaches the certificate PDF.
 *
 * Its own uncontrolled file input rather than part of the form above, because
 * it goes to a route instead of a server action — a scanned certificate is
 * routinely larger than the 1 MB body limit actions run under.
 */
function UploadCertificate({ certificateId }: { certificateId: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append('certificate', file);
      const response = await fetch(`/api/insurance/${certificateId}/document`, {
        method: 'POST',
        body,
      });
      const result = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) setError(result?.error ?? 'That file could not be attached.');
      else window.location.reload();
    } catch {
      setError('That upload did not go through.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        loading={busy}
        onClick={() => input.current?.click()}
        title={error ?? 'Attach the certificate PDF'}
      >
        <Paperclip aria-hidden />
        {error ? 'Failed' : 'Attach'}
      </Button>
    </>
  );
}
