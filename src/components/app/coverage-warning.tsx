import { AlertTriangle, Info, ShieldCheck } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { money } from '@/lib/utils/format';
import type { LoadCoverage } from '@/lib/insurance/certificates';

/**
 * Whether the cargo policy covers what is on the deck.
 *
 * The number that bankrupts a small carrier. A seven-car load of new vehicles
 * clears $350,000 without being unusual; $100,000 is the cargo limit brokers
 * ask for and therefore the one most carriers buy, and the difference is the
 * carrier's personally. Nobody works that out in the yard, so it is worked out
 * here, before the load moves.
 *
 * A vehicle with no declared value makes this unknown rather than fine. The
 * quiet failure would be reporting full cover on the one load nobody valued.
 */
export function CoverageWarning({ coverage }: { coverage: LoadCoverage }) {
  if (coverage.status === 'covered' && coverage.exposureCents === 0) return null;

  const body = () => {
    switch (coverage.status) {
      case 'short':
        return {
          tone: 'danger' as const,
          icon: AlertTriangle,
          title: `This load is worth ${money(coverage.shortfallCents)} more than your cargo cover`,
          detail:
            `${money(coverage.exposureCents ?? 0)} of declared value against a ` +
            `${money(coverage.limitCents ?? 0)} limit on ${coverage.policyNumber}. The difference ` +
            'is yours if the truck goes over. Raising the limit for a single load is usually a ' +
            'call to your agent rather than a new policy.',
        };

      case 'unknown':
        return {
          tone: 'warn' as const,
          icon: Info,
          title: `${coverage.undeclared} vehicle${coverage.undeclared === 1 ? ' has' : 's have'} no declared value`,
          detail:
            'Cover cannot be checked against a load that has not been valued. Record what the ' +
            'vehicles are worth and this will say whether the policy reaches.',
        };

      case 'no_cover':
        return {
          tone: 'warn' as const,
          icon: AlertTriangle,
          title: 'No cargo certificate on file',
          detail:
            'Nothing here says what happens if a vehicle is damaged. Cargo cover for general ' +
            'freight is not filed with FMCSA, so a certificate recorded in settings is the only ' +
            'record of it this app can hold.',
        };

      case 'covered':
        return {
          tone: 'ok' as const,
          icon: ShieldCheck,
          title: `Covered: ${money(coverage.exposureCents ?? 0)} on a ${money(coverage.limitCents ?? 0)} policy`,
          detail:
            `${coverage.insurerName} ${coverage.policyNumber}. The limit shown is the one on the ` +
            'certificate; sublimits, exclusions and the deductible are in the policy and a ' +
            'certificate does not show them.',
        };
    }
  };

  const { tone, icon: Icon, title, detail } = body();
  const wrapper =
    tone === 'danger'
      ? 'border-danger/40'
      : tone === 'warn'
        ? 'border-warn/40'
        : 'border-line';
  const text = tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-ok';

  return (
    <Card className={`p-5 ${wrapper}`}>
      <p className={`flex items-start gap-2 text-sm font-medium ${text}`}>
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
        {title}
      </p>
      <p className="mt-1 pl-6 text-xs leading-relaxed text-ink-secondary">{detail}</p>
    </Card>
  );
}
