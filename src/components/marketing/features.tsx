import {
  CameraOff,
  ClipboardCheck,
  FileSignature,
  Gauge,
  Receipt,
  ScanLine,
  ShieldCheck,
  WifiOff,
} from 'lucide-react';
import { Reveal } from '@/components/ui/reveal';
import { cn } from '@/lib/utils/cn';

interface Feature {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
  /** Column span at the `lg` breakpoint. */
  span?: 1 | 2;
  detail?: React.ReactNode;
}

const FEATURES: Feature[] = [
  {
    icon: ScanLine,
    title: 'VIN scanning that actually works in a yard',
    span: 2,
    body:
      'Point the camera at the door jamb or windshield label. Reads Code 39, Code 128, Data Matrix and QR, strips the AIAG import prefix, and only accepts a scan once the mod-11 check digit validates — so a misread never becomes a wrong VIN on a legal document.',
    detail: (
      <div className="mt-5 rounded-lg border border-line bg-sunken/60 p-3 font-mono text-xs">
        <div className="flex items-center justify-between gap-3">
          <span className="text-ink-muted">scanned</span>
          <span className="text-ink-muted">Code 39</span>
        </div>
        <p className="mt-1.5 break-all text-ink">
          <span className="text-ink-muted line-through">I</span>1HGCM82633A004352
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem]">
          <span className="text-ok">✓ check digit 3</span>
          <span className="text-ink-secondary">2003 Honda Accord</span>
          <span className="text-ink-muted">via NHTSA vPIC</span>
        </div>
      </div>
    ),
  },
  {
    icon: FileSignature,
    title: 'Electronic BOLs that hold up',
    body:
      'Non-negotiable straight bills with every field 49 CFR 373.101 requires. Signatures capture the auth method, document hash, GPS, IP and device — the attribution evidence courts have found missing elsewhere.',
  },
  {
    icon: ClipboardCheck,
    title: 'Condition reports that win claims',
    body:
      'Guided photo capture at pickup and delivery with standard damage and area codes. Originals are hashed and kept immutable; only stripped derivatives are ever served.',
  },
  {
    icon: WifiOff,
    title: 'Built for no signal',
    span: 2,
    body:
      'Inspections, photos and signatures are captured straight to the device and queue for upload. Drivers finish the job in a dead zone and it syncs when they roll back into coverage — no lost work, no "please try again".',
    detail: (
      <div className="mt-5 flex flex-wrap gap-2">
        {[
          { label: 'VIN validation', state: 'offline' },
          { label: 'Photo capture', state: 'offline' },
          { label: 'Signatures', state: 'offline' },
          { label: 'Damage marking', state: 'offline' },
          { label: 'NHTSA decode', state: 'queued' },
        ].map((chip) => (
          <span
            key={chip.label}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.6875rem] font-medium',
              chip.state === 'offline' ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn',
            )}
          >
            {chip.state === 'offline' ? (
              <CameraOff className="size-3" aria-hidden />
            ) : (
              <WifiOff className="size-3" aria-hidden />
            )}
            {chip.label}
          </span>
        ))}
      </div>
    ),
  },
  {
    icon: Gauge,
    title: 'Dispatch and capacity',
    body:
      'Plan multi-stop runs across a 7-to-10 car deck, sequence pickups and deliveries, and flag inoperables before the driver finds out on site.',
  },
  {
    icon: Receipt,
    title: 'Invoicing and broker margin',
    body:
      'Rate, deadhead and per-mile figures on every load, with the structured broker transaction record 49 CFR 371.3 already requires exportable in one click.',
  },
  {
    icon: ShieldCheck,
    title: 'Security that is not an afterthought',
    body:
      'Argon2id password hashing, TOTP two-factor, per-organisation row scoping, encrypted PII columns and a hash-chained audit log you can verify.',
  },
];

export function Features() {
  return (
    <section id="features" className="relative scroll-mt-20 py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-5">
        <Reveal className="mx-auto max-w-2xl text-center">
          <div>
            <p className="text-sm font-medium text-brand">Everything the paid tools charge for</p>
            <h2 className="mt-3 text-3xl font-semibold text-ink sm:text-4xl">
              The whole job, end to end
            </h2>
            <p className="mt-4 text-base leading-relaxed text-ink-secondary">
              Built from how the work actually runs — load booked, dispatched, inspected, hauled,
              delivered, invoiced — not from a feature list.
            </p>
          </div>
        </Reveal>

        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature, i) => (
            <Reveal
              key={feature.title}
              delay={i * 0.06}
              className={cn(feature.span === 2 && 'lg:col-span-2')}
            >
              <article className="group ring-gradient relative h-full overflow-hidden rounded-xl border border-line bg-raised p-6 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg">
                {/* Radial highlight that warms the card on hover. */}
                <div
                  className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
                  style={{
                    background:
                      'radial-gradient(ellipse 80% 60% at 50% 0%, color-mix(in oklch, var(--brand) 12%, transparent), transparent 70%)',
                  }}
                  aria-hidden
                />

                <div className="relative">
                  <span className="inline-grid size-10 place-items-center rounded-lg bg-brand-soft text-brand">
                    <feature.icon className="size-5" aria-hidden />
                  </span>

                  <h3 className="mt-4 text-base font-semibold text-ink">{feature.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-secondary">{feature.body}</p>

                  {feature.detail}
                </div>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
