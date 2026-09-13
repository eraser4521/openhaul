import { Fingerprint, KeyRound, Lock, ScrollText, Users } from 'lucide-react';
import { Reveal } from '@/components/ui/reveal';

const CONTROLS = [
  {
    icon: KeyRound,
    title: 'Argon2id + TOTP',
    body:
      'Passwords hashed with Argon2id at OWASP-current parameters. Time-based two-factor with single-use recovery codes.',
  },
  {
    icon: Users,
    title: 'Org-scoped by construction',
    body:
      'Every query goes through a scoped client that cannot be called without an organisation ID, so cross-tenant reads fail to compile rather than leak.',
  },
  {
    icon: Lock,
    title: 'Encrypted PII at rest',
    body:
      'Driver licence numbers, dates of birth and contact details are sealed with AES-256-GCM under a rotatable key.',
  },
  {
    icon: ScrollText,
    title: 'Hash-chained audit log',
    body:
      'Every state change links to the hash of the one before it. Break a link and verification tells you exactly where.',
  },
  {
    icon: Fingerprint,
    title: 'Defensible signatures',
    body:
      'Each signature records the authentication method, the hash of the exact document shown, stroke timing, GPS, IP and both server and device clocks.',
  },
];

const COMPLIANCE = [
  ['49 CFR 373.101', 'Every required bill of lading field, enforced non-null'],
  ['49 CFR 390.32', 'Electronic documents and signatures, expressly permitted'],
  ['UCC Article 7', 'Non-negotiable straight bills, adopted in all 50 states'],
  ['15 U.S.C. 7001(c)', 'Versioned ESIGN consent captured for individual shippers'],
  ['49 CFR 370.9', 'Cargo claim timers at 30, 120, 180 and 240 days'],
  ['49 CFR 379 App. A', 'Retention defaults to 7 years, with legal hold'],
];

export function Security() {
  return (
    <section id="security" className="relative scroll-mt-20 py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-5">
        <div className="grid gap-14 lg:grid-cols-[1fr_1.1fr] lg:items-start lg:gap-20">
          <Reveal direction="right">
            <div className="lg:sticky lg:top-28">
              <p className="text-sm font-medium text-brand">Security &amp; compliance</p>
              <h2 className="mt-3 text-3xl font-semibold text-ink sm:text-4xl">
                Your BOL is evidence. Treat it that way.
              </h2>
              <p className="mt-4 text-base leading-relaxed text-ink-secondary">
                Under the Carmack Amendment a shipper makes its case by showing the vehicle went on
                the truck clean. The pickup inspection is the only thing that answers that — so the
                record has to be tamper-evident, attributable and reproducible years later.
              </p>

              <dl className="mt-8 space-y-3">
                {COMPLIANCE.map(([cite, note]) => (
                  <div key={cite} className="flex flex-col gap-0.5 border-l-2 border-brand/40 pl-4">
                    <dt className="font-mono text-xs text-brand">{cite}</dt>
                    <dd className="text-sm text-ink-secondary">{note}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </Reveal>

          <div className="space-y-3">
            {CONTROLS.map((control, i) => (
              <Reveal key={control.title} delay={i * 0.07} direction="left">
                <div className="flex gap-4 rounded-xl border border-line bg-raised p-5 transition-all duration-300 hover:border-line-strong hover:shadow-md">
                  <span className="mt-0.5 inline-grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
                    <control.icon className="size-[1.125rem]" aria-hidden />
                  </span>
                  <div>
                    <h3 className="text-[0.9375rem] font-semibold text-ink">{control.title}</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-ink-secondary">
                      {control.body}
                    </p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
