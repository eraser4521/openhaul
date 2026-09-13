import {
  CheckCircle2,
  Circle,
  Clock,
  MapPin,
  ScanLine,
  Truck,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';

/**
 * A hand-built mock of the dispatch board, used as the hero visual.
 *
 * This is real markup rather than a screenshot so it stays crisp at any DPI,
 * themes correctly in light and dark, and never goes stale relative to the
 * product. Every number here is illustrative.
 */

const LOADS = [
  {
    id: 'OH-4471',
    from: 'Dallas, TX',
    to: 'Phoenix, AZ',
    units: 7,
    rate: '$2,940',
    rpm: '$2.74/mi',
    status: 'In transit',
    tone: 'info' as const,
    progress: 62,
  },
  {
    id: 'OH-4468',
    from: 'Atlanta, GA',
    to: 'Tampa, FL',
    units: 9,
    rate: '$1,820',
    rpm: '$3.41/mi',
    status: 'Loading',
    tone: 'warn' as const,
    progress: 18,
  },
  {
    id: 'OH-4463',
    from: 'Reno, NV',
    to: 'Denver, CO',
    units: 6,
    rate: '$3,150',
    rpm: '$2.55/mi',
    status: 'Delivered',
    tone: 'ok' as const,
    progress: 100,
  },
];

const TONE_CLASSES = {
  info: 'bg-info-soft text-info',
  warn: 'bg-warn-soft text-warn',
  ok: 'bg-ok-soft text-ok',
} as const;

function Stat({ label, value, delta }: { label: string; value: string; delta?: string }) {
  return (
    <div className="rounded-lg border border-line bg-base/60 p-3">
      <p className="text-[0.6875rem] font-medium tracking-wide text-ink-muted uppercase">{label}</p>
      <p className="mt-1 flex items-baseline gap-1.5">
        <span className="text-lg font-semibold text-ink tabular-nums">{value}</span>
        {delta && <span className="text-[0.6875rem] font-medium text-ok">{delta}</span>}
      </p>
    </div>
  );
}

export function AppPreview({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'ring-gradient overflow-hidden rounded-2xl border border-line bg-raised shadow-xl',
        className,
      )}
      role="img"
      aria-label="Screenshot of the OpenHaul dispatch board showing three active loads, fleet statistics and a VIN scan in progress."
    >
      {/* Window chrome */}
      <div className="flex items-center gap-2 border-b border-line bg-sunken px-4 py-3">
        <span className="flex gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-[oklch(0.72_0.17_25)]" />
          <span className="size-2.5 rounded-full bg-[oklch(0.82_0.15_85)]" />
          <span className="size-2.5 rounded-full bg-[oklch(0.75_0.15_150)]" />
        </span>
        <div className="ml-2 flex-1 truncate rounded-md bg-base px-2.5 py-1 font-mono text-[0.6875rem] text-ink-muted">
          openhaul.local/dispatch
        </div>
      </div>

      <div className="grid gap-4 p-4 sm:grid-cols-[1fr_15rem] sm:p-5">
        {/* Load board */}
        <div className="min-w-0 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Truck className="size-4 text-brand" aria-hidden />
              Active loads
            </h3>
            <span className="text-[0.6875rem] text-ink-muted tabular-nums">3 of 12</span>
          </div>

          <ul className="space-y-2">
            {LOADS.map((load) => (
              <li
                key={load.id}
                className="rounded-lg border border-line bg-base/60 p-3 transition-colors hover:border-line-strong"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2">
                      <span className="font-mono text-xs font-medium text-ink">{load.id}</span>
                      <span
                        className={cn(
                          'rounded-full px-1.5 py-0.5 text-[0.625rem] font-medium',
                          TONE_CLASSES[load.tone],
                        )}
                      >
                        {load.status}
                      </span>
                    </p>
                    <p className="mt-1.5 flex items-center gap-1.5 truncate text-xs text-ink-secondary">
                      <MapPin className="size-3 shrink-0 text-ink-muted" aria-hidden />
                      {load.from}
                      <span className="text-ink-muted">→</span>
                      {load.to}
                    </p>
                  </div>

                  <div className="shrink-0 text-right">
                    <p className="text-sm font-semibold text-ink tabular-nums">{load.rate}</p>
                    <p className="text-[0.6875rem] text-ink-muted tabular-nums">{load.rpm}</p>
                  </div>
                </div>

                <div className="mt-2.5 flex items-center gap-2">
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-sunken">
                    <div
                      className="h-full rounded-full bg-brand transition-[width] duration-700"
                      style={{ width: `${load.progress}%` }}
                    />
                  </div>
                  <span className="text-[0.625rem] text-ink-muted tabular-nums">
                    {load.units} units
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* Right rail */}
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-1">
            <Stat label="Revenue, MTD" value="$48.2k" delta="+12%" />
            <Stat label="Avg. RPM" value="$2.91" delta="+$0.14" />
          </div>

          {/* VIN scan panel with an animated sweep line. */}
          <div className="relative overflow-hidden rounded-lg border border-brand/30 bg-brand-soft/40 p-3">
            <div
              className="animate-sweep absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[var(--brand)] to-transparent"
              aria-hidden
            />
            <p className="flex items-center gap-1.5 text-[0.6875rem] font-medium text-brand">
              <ScanLine className="size-3.5" aria-hidden />
              VIN captured
            </p>
            <p className="mt-1.5 font-mono text-[0.6875rem] leading-relaxed break-all text-ink">
              1HGCM82633A004352
            </p>
            <p className="mt-1 text-[0.625rem] text-ink-secondary">2003 Honda Accord · Coupe</p>
            <p className="mt-1.5 flex items-center gap-1 text-[0.625rem] text-ok">
              <CheckCircle2 className="size-3" aria-hidden />
              Check digit valid
            </p>
          </div>

          {/* Inspection checklist */}
          <div className="rounded-lg border border-line bg-base/60 p-3">
            <p className="text-[0.6875rem] font-medium tracking-wide text-ink-muted uppercase">
              Pickup inspection
            </p>
            <ul className="mt-2 space-y-1.5 text-[0.6875rem]">
              {[
                { label: '12 photos captured', done: true },
                { label: 'Damage marked (2)', done: true },
                { label: 'Shipper signature', done: false },
              ].map((item) => (
                <li key={item.label} className="flex items-center gap-1.5">
                  {item.done ? (
                    <CheckCircle2 className="size-3 shrink-0 text-ok" aria-hidden />
                  ) : (
                    <Circle className="size-3 shrink-0 text-ink-muted" aria-hidden />
                  )}
                  <span className={item.done ? 'text-ink-secondary' : 'text-ink-muted'}>
                    {item.label}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <p className="flex items-center gap-1.5 text-[0.625rem] text-ink-muted">
            <Clock className="size-3" aria-hidden />
            Synced 2 min ago · 3 queued offline
          </p>
        </div>
      </div>
    </div>
  );
}
