'use client';

import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Check, Minus } from 'lucide-react';
import { Reveal } from '@/components/ui/reveal';
import { cn } from '@/lib/utils/cn';

/**
 * Advertised entry pricing for the incumbent products, as published by each
 * vendor. Shown with a "verify current pricing" note because list prices move
 * and several tiers are quote-only.
 */
const INCUMBENTS = [
  { name: 'Super Dispatch', perSeat: 50, firstSeat: 55, base: 0, note: 'Carrier Pro, per seat' },
  { name: 'Ship.Cars SmartHaul', perSeat: 49, firstSeat: 49, base: 0, note: 'Unlimited tier, per driver' },
  { name: 'Central Dispatch', perSeat: 0, firstSeat: 0, base: 139.95, note: 'Core load board, per company' },
] as const;

function annualCost(seats: number, plan: (typeof INCUMBENTS)[number]): number {
  const seatCost = plan.perSeat === 0 ? 0 : plan.firstSeat + Math.max(0, seats - 1) * plan.perSeat;
  return (plan.base + seatCost) * 12;
}

const COMPARISON: Array<{ label: string; openhaul: boolean | string; paid: boolean | string }> = [
  { label: 'Unlimited drivers and dispatchers', openhaul: true, paid: 'Per seat' },
  { label: 'VIN barcode scanning', openhaul: true, paid: true },
  { label: 'Electronic BOL and POD', openhaul: true, paid: true },
  { label: 'Offline inspections with photo queue', openhaul: true, paid: true },
  { label: 'AIAG M-22 damage coding', openhaul: true, paid: 'Higher tiers' },
  { label: 'API access', openhaul: true, paid: 'Paid add-on' },
  { label: 'Accounting export', openhaul: true, paid: 'Paid add-on' },
  { label: 'Full data export, any time', openhaul: true, paid: 'Limited' },
  { label: 'Self-hosting on your own server', openhaul: true, paid: false },
  { label: 'Account cannot be terminated by a vendor', openhaul: true, paid: false },
  { label: 'Source code you can audit and change', openhaul: true, paid: false },
];

function Cell({ value }: { value: boolean | string }) {
  if (value === true) {
    return (
      <span className="inline-flex items-center gap-1.5 text-ok">
        <Check className="size-4 shrink-0" aria-hidden />
        <span className="sr-only">Included</span>
      </span>
    );
  }
  if (value === false) {
    return (
      <span className="inline-flex items-center gap-1.5 text-ink-muted">
        <Minus className="size-4 shrink-0" aria-hidden />
        <span className="sr-only">Not available</span>
      </span>
    );
  }
  return <span className="text-xs text-ink-muted">{value}</span>;
}

export function Pricing() {
  const [seats, setSeats] = useState(3);

  const costs = useMemo(
    () =>
      INCUMBENTS.map((plan) => ({ ...plan, annual: annualCost(seats, plan) })).sort(
        (a, b) => b.annual - a.annual,
      ),
    [seats],
  );

  const highest = costs[0]?.annual ?? 1;

  return (
    <section id="pricing" className="relative scroll-mt-20 border-t border-line py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-5">
        <Reveal className="mx-auto max-w-2xl text-center">
          <div>
            <p className="text-sm font-medium text-brand">Pricing</p>
            <h2 className="mt-3 text-3xl font-semibold text-ink sm:text-4xl">
              It costs nothing, because it is yours
            </h2>
            <p className="mt-4 text-base leading-relaxed text-ink-secondary">
              OpenHaul has no plans, no seats and no trial. Run it on a $5 VPS or an old laptop in
              the office. The only thing you pay for is hosting.
            </p>
          </div>
        </Reveal>

        {/* Cost calculator */}
        <Reveal delay={0.1} className="mt-14">
          <div className="ring-gradient overflow-hidden rounded-2xl border border-line bg-raised">
            <div className="border-b border-line p-6 sm:p-8">
              <label htmlFor="seats" className="text-sm font-medium text-ink">
                How many drivers and dispatchers do you have?
              </label>

              <div className="mt-4 flex items-center gap-4">
                <input
                  id="seats"
                  type="range"
                  min={1}
                  max={25}
                  value={seats}
                  onChange={(e) => setSeats(Number(e.target.value))}
                  className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-sunken accent-[var(--brand)]"
                  aria-describedby="seats-value"
                />
                <output
                  id="seats-value"
                  className="w-16 shrink-0 text-right text-2xl font-semibold text-ink tabular-nums"
                >
                  {seats}
                </output>
              </div>
            </div>

            <div className="space-y-4 p-6 sm:p-8">
              <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
                Estimated cost per year
              </p>

              {costs.map((plan, i) => (
                <div key={plan.name} className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="text-sm text-ink">
                      {plan.name}
                      <span className="ml-2 text-xs text-ink-muted">{plan.note}</span>
                    </span>
                    <span className="shrink-0 text-sm font-semibold text-ink tabular-nums">
                      ${plan.annual.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-sunken">
                    <motion.div
                      className="h-full rounded-full bg-ink-muted/40"
                      initial={{ width: 0 }}
                      animate={{ width: `${(plan.annual / highest) * 100}%` }}
                      transition={{ duration: 0.6, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] }}
                    />
                  </div>
                </div>
              ))}

              <div className="space-y-1.5 pt-2">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-sm font-medium text-brand">OpenHaul</span>
                  <span className="shrink-0 text-sm font-semibold text-brand tabular-nums">$0</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-sunken">
                  <div className="h-full w-1.5 rounded-full bg-brand" />
                </div>
              </div>

              <p className="pt-3 text-xs leading-relaxed text-ink-muted">
                Based on each vendor&rsquo;s advertised entry pricing. Several tiers are quote-only
                and list prices change — check current pricing before relying on these figures. Not
                every product above is a like-for-like replacement: Central Dispatch is a load
                board, and OpenHaul does not replace access to one.
              </p>
            </div>
          </div>
        </Reveal>

        {/* Feature comparison */}
        <Reveal delay={0.15} className="mt-10">
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[34rem] border-collapse text-left">
              <caption className="sr-only">
                Feature comparison between OpenHaul and typical subscription products
              </caption>
              <thead>
                <tr className="border-b border-line bg-sunken/60">
                  <th scope="col" className="px-5 py-3 text-xs font-medium text-ink-secondary">
                    Capability
                  </th>
                  <th scope="col" className="w-32 px-5 py-3 text-xs font-medium text-brand">
                    OpenHaul
                  </th>
                  <th scope="col" className="w-36 px-5 py-3 text-xs font-medium text-ink-secondary">
                    Typical paid TMS
                  </th>
                </tr>
              </thead>
              <tbody>
                {COMPARISON.map((row, i) => (
                  <tr
                    key={row.label}
                    className={cn('border-b border-line last:border-0', i % 2 === 1 && 'bg-sunken/30')}
                  >
                    <th scope="row" className="px-5 py-3 text-sm font-normal text-ink">
                      {row.label}
                    </th>
                    <td className="px-5 py-3">
                      <Cell value={row.openhaul} />
                    </td>
                    <td className="px-5 py-3">
                      <Cell value={row.paid} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
