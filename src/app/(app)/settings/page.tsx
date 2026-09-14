import { AlertCircle, CheckCircle2, Link2, ShieldAlert, ShieldCheck, Smartphone } from 'lucide-react';
import { requireSessionOrRedirect } from '@/lib/auth/guard';
import { chainHead } from '@/lib/audit/chain';
import { isMfaEnabled, remainingRecoveryCodes } from '@/lib/auth/mfa';
import { listSessions, SESSION_POLICY } from '@/lib/auth/session';
import { PageBody, PageHeader } from '@/components/app/page-header';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { relativeTime } from '@/lib/utils/format';
import { CompanyForm } from '@/components/app/company-form';
import { MailCheck } from '@/components/app/mail-check';
import { mailConfigured } from '@/lib/email/transport';
import { can } from '@/lib/auth/capabilities';
import { getOrganization } from '@/lib/organization/profile';
import { TemplateEditor, type TemplateValues } from '@/components/app/template-editor';
import { AccessorialCatalogue } from '@/components/app/accessorial-catalogue';
import { allTemplates } from '@/lib/branding/template';
import { listRates } from '@/lib/branding/accessorials';
import { RetentionPanel } from '@/components/app/retention-panel';
import { InsurancePanel } from '@/components/app/insurance-panel';
import { listCertificates } from '@/lib/insurance/certificates';
import { retentionReport } from '@/lib/retention/engine';
import { activeHolds } from '@/lib/retention/holds';
import { ANCHOR_LABEL } from '@/lib/retention/policy';
import type { TemplateScope } from '@/lib/db/schema';
import { VerifyChainButton } from './verify-chain';

/** The editable half of a stored template row. */
function templateValues(row: {
  letterheadName: string | null;
  tagline: string | null;
  accentHex: string | null;
  showLogo: boolean | null;
  footerNote: string | null;
  addendum: string | null;
  remitToText: string | null;
}): TemplateValues {
  return {
    letterheadName: row.letterheadName,
    tagline: row.tagline,
    accentHex: row.accentHex,
    showLogo: row.showLogo,
    footerNote: row.footerNote,
    addendum: row.addendum,
    remitToText: row.remitToText,
  };
}

export const metadata = { title: 'Settings' };

function hours(ms: number): string {
  const h = ms / 3_600_000;
  return h >= 24 ? `${Math.round(h / 24)} days` : `${Math.round(h)} hours`;
}

export default async function SettingsPage() {
  const { session, db } = await requireSessionOrRedirect();

  const [
    mfaEnabled,
    recoveryLeft,
    sessions,
    head,
    org,
    templates,
    rates,
    retention,
    holds,
    ownCover,
  ] =
    await Promise.all([
      isMfaEnabled(session.userId),
      remainingRecoveryCodes(session.userId),
      listSessions(session.userId),
      chainHead(),
      getOrganization(session.orgId),
      allTemplates(db),
      listRates(db, { includeRetired: true }),
      retentionReport(db),
      activeHolds(db),
      listCertificates(db, null),
    ]);

  const policy = SESSION_POLICY[session.role];

  const house = templates.find((row) => row.scope === 'all') ?? null;
  const overrides: Partial<Record<TemplateScope, TemplateValues>> = {};
  for (const row of templates) {
    if (row.scope !== 'all') overrides[row.scope] = templateValues(row);
  }

  return (
    <>
      <PageHeader title="Settings" description={`${session.orgName} · signed in as ${session.email}`} />

      <PageBody className="max-w-3xl space-y-6">
        {org && (
          <CompanyForm
            canEdit={can(session.role, 'settings.write')}
            values={{
              legalName: org.legalName,
              dbaName: org.dbaName,
              addressLine1: org.addressLine1,
              addressLine2: org.addressLine2,
              city: org.city,
              state: org.state,
              postalCode: org.postalCode,
              phone: org.phone,
              email: org.email,
              usdotNumber: org.usdotNumber,
              mcNumber: org.mcNumber,
            }}
          />
        )}

        {org && (
          <TemplateEditor
            canEdit={can(session.role, 'settings.write')}
            legalName={org.legalName}
            house={
              house
                ? templateValues(house)
                : {
                    letterheadName: null,
                    tagline: null,
                    accentHex: null,
                    showLogo: null,
                    footerNote: null,
                    addendum: null,
                    remitToText: null,
                  }
            }
            overrides={overrides}
            logo={
              house?.logoSha256
                ? {
                    width: house.logoWidth ?? 0,
                    height: house.logoHeight ?? 0,
                    sha256: house.logoSha256,
                  }
                : null
            }
          />
        )}

        <AccessorialCatalogue
          canEdit={can(session.role, 'settings.write')}
          entries={rates.map((rate) => ({
            id: rate.id,
            code: rate.code,
            label: rate.label,
            unit: rate.unit,
            defaultCents: rate.defaultCents,
            note: rate.note,
            active: rate.active,
          }))}
        />

        <InsurancePanel
          customerId={null}
          title="Your insurance"
          description="What a broker asks to see before tendering. Cargo cover for vehicles is not filed with FMCSA, so this certificate is the only proof of it there is."
          canEdit={can(session.role, 'settings.write')}
          certificates={ownCover.map((certificate) => ({
            id: certificate.id,
            kind: certificate.kind,
            insurerName: certificate.insurerName,
            policyNumber: certificate.policyNumber,
            coverageLimitCents: certificate.coverageLimitCents,
            deductibleCents: certificate.deductibleCents,
            effectiveAt: certificate.effectiveAt.toISOString(),
            expiresAt: certificate.expiresAt.toISOString(),
            documentId: certificate.documentId,
            verifiedAt: certificate.verifiedAt?.toISOString() ?? null,
          }))}
        />

        <RetentionPanel
          canEdit={can(session.role, 'settings.write')}
          canPurge={can(session.role, 'retention.purge')}
          rows={retention.map((report) => ({
            recordClass: report.recordClass,
            label: report.policy.label,
            covers: report.policy.covers,
            note: report.policy.note,
            citation: report.policy.citation,
            anchorLabel: ANCHOR_LABEL[report.policy.anchorType],
            disposition: report.policy.disposition,
            retentionDays: report.policy.retentionDays,
            floorDays: report.policy.floorDays,
            customised: report.policy.customised,
            total: report.total,
            due: report.due,
            held: report.held,
            pending: report.pending,
            keeping: report.keeping,
            bytes: report.bytes,
            unreachable: report.unreachable,
            oldestDueAt: report.oldestDueAt?.toISOString() ?? null,
          }))}
          holds={holds.map((hold) => ({
            id: hold.id,
            subject: hold.subject,
            reason: hold.reason,
            placedAt: hold.placedAt.toISOString(),
          }))}
        />

        <MailCheck configured={mailConfigured()} />

        <Card>
          <div className="border-b border-line px-5 py-4">
            <h2 className="text-sm font-semibold text-ink">Two-factor authentication</h2>
          </div>
          <div className="p-5">
            {mfaEnabled ? (
              <>
                <p className="flex items-center gap-2 text-sm text-ok">
                  <ShieldCheck className="size-4 shrink-0" aria-hidden />
                  Enabled
                </p>
                <p className="mt-2 text-xs leading-relaxed text-ink-secondary">
                  {recoveryLeft} recovery code{recoveryLeft === 1 ? '' : 's'} remaining.
                  {recoveryLeft < 3 && ' Generate a fresh set soon.'}
                </p>
              </>
            ) : (
              <>
                <p className="flex items-center gap-2 text-sm text-warn">
                  <ShieldAlert className="size-4 shrink-0" aria-hidden />
                  Not enabled
                </p>
                <p className="mt-2 text-xs leading-relaxed text-ink-secondary">
                  Two-factor is what makes long driver sessions safe. Without it, anything that
                  moves money or reveals personal data has no second check behind it.
                </p>
              </>
            )}
          </div>
        </Card>

        <Card>
          <div className="border-b border-line px-5 py-4">
            <h2 className="text-sm font-semibold text-ink">Active sessions</h2>
            <p className="mt-1 text-xs text-ink-secondary">
              Your role signs out after {hours(policy.idleMs)} idle, and always within{' '}
              {hours(policy.absoluteMs)}.
            </p>
          </div>
          <ul className="divide-y divide-line">
            {sessions.map((item) => (
              <li key={item.tokenHash} className="flex items-start gap-3 px-5 py-4">
                <Smartphone className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">{item.deviceLabel ?? 'Unnamed device'}</p>
                  <p className="mt-0.5 truncate text-xs text-ink-muted">
                    {item.ipCreated ?? 'unknown address'} · last seen{' '}
                    {relativeTime(item.lastSeenAt)}
                  </p>
                </div>
                {item.tokenHash === undefined && null}
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <div className="border-b border-line px-5 py-4">
            <h2 className="text-sm font-semibold text-ink">Audit log integrity</h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
              Every entry commits to the hash of the one before it, so a deleted or edited row
              breaks the chain at a point verification can name.
            </p>
          </div>
          <div className="space-y-4 p-5">
            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-ink-muted">Entries</dt>
                <dd className="mt-0.5 text-sm text-ink tabular-nums">{head.seq}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-ink-muted">Head hash</dt>
                <dd className="mt-0.5 truncate font-mono text-xs text-ink">
                  {head.hash.slice(0, 24)}…
                </dd>
              </div>
            </dl>

            <VerifyChainButton />

            <p className="flex items-start gap-1.5 text-xs leading-relaxed text-ink-muted">
              <Link2 className="mt-px size-3.5 shrink-0" aria-hidden />A chain that only exists
              inside the database it protects proves little. Export the head hash somewhere you do
              not control if you need it to stand up later.
            </p>
          </div>
        </Card>

        <Card>
          <div className="border-b border-line px-5 py-4">
            <h2 className="text-sm font-semibold text-ink">Your data</h2>
          </div>
          <div className="space-y-3 p-5 text-xs leading-relaxed text-ink-secondary">
            <p className="flex items-start gap-2">
              <CheckCircle2 className="mt-px size-3.5 shrink-0 text-ok" aria-hidden />
              This instance stores everything in its own database. Nothing is sent anywhere else
              except the VIN lookups you trigger, which go to NHTSA.
            </p>
            <p className="flex items-start gap-2">
              <CheckCircle2 className="mt-px size-3.5 shrink-0 text-ok" aria-hidden />
              A driver&rsquo;s licence number, date of birth and home address are sealed under a key
              belonging to that person alone, so an erasure request can destroy one key without
              touching the bills of lading you are required to keep.
            </p>
            <p className="flex items-start gap-2">
              <AlertCircle className="mt-px size-3.5 shrink-0 text-warn" aria-hidden />
              A backup taken before an erasure still holds that key. Erasure is only complete once
              those backups have aged out of your rotation.
            </p>
            <div className="flex flex-wrap gap-1.5 pt-1">
              <Badge tone="neutral" size="sm">
                AGPL-3.0
              </Badge>
              <Badge tone="neutral" size="sm">
                Self-hosted
              </Badge>
              <Badge tone="neutral" size="sm">
                No telemetry
              </Badge>
            </div>
          </div>
        </Card>
      </PageBody>
    </>
  );
}
