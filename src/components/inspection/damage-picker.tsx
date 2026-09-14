'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, Check, Search, X } from 'lucide-react';
import {
  AIAG_DAMAGE_AREAS,
  AIAG_DAMAGE_TYPES,
  AIAG_SEVERITIES,
  composeDamageCode,
  describeDamageCode,
  NON_TRANSPORTATION_DAMAGE,
  requiresHold,
} from '@/lib/aiag/codes';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils/cn';

export interface DamageSelection {
  areaCode: string;
  typeCode: string;
  severityCode: string;
  description: string;
  nonTransportation: boolean;
  code: string;
}

export interface DamagePickerProps {
  onConfirm: (selection: DamageSelection) => void;
  onCancel: () => void;
}

/**
 * Builds an AIAG M-22 damage code.
 *
 * Three lists rather than one flat search, because the standard is three
 * independent axes — area, type, severity — and collapsing them would produce
 * a couple of thousand combinations nobody can scan.
 */
export function DamagePicker({ onConfirm, onCancel }: DamagePickerProps) {
  const [areaQuery, setAreaQuery] = useState('');
  const [areaCode, setAreaCode] = useState<string | null>(null);
  const [typeCode, setTypeCode] = useState<string | null>(null);
  const [severityCode, setSeverityCode] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [nonTransportation, setNonTransportation] = useState(false);

  const areas = useMemo(() => {
    const query = areaQuery.trim().toLowerCase();
    const usable = AIAG_DAMAGE_AREAS.filter((a) => !a.open);
    if (query.length === 0) return usable;
    return usable.filter(
      (a) => a.label.toLowerCase().includes(query) || a.code.includes(query),
    );
  }, [areaQuery]);

  const grouped = useMemo(() => {
    const map = new Map<string, typeof AIAG_DAMAGE_AREAS>();
    for (const area of areas) {
      const key = area.group ?? 'Other';
      map.set(key, [...(map.get(key) ?? []), area]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [areas]);

  const code =
    areaCode && typeCode && severityCode
      ? composeDamageCode(areaCode, typeCode, severityCode)
      : null;

  const summary = code ? describeDamageCode(code) : null;
  const holdRequired = code ? requiresHold(code) : false;

  return (
    <div className="space-y-5">
      {/* Area */}
      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-ink">
            1. Where is it?
            {areaCode && <span className="ml-2 font-mono text-xs text-brand">{areaCode}</span>}
          </h3>
          <div className="relative w-40">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-muted"
              aria-hidden
            />
            <input
              value={areaQuery}
              onChange={(e) => setAreaQuery(e.target.value)}
              placeholder="Search areas"
              aria-label="Search damage areas"
              className="h-8 w-full rounded-lg border border-line bg-raised pr-2 pl-8 text-xs text-ink placeholder:text-ink-muted focus:border-brand focus:outline-none"
            />
          </div>
        </div>

        <div className="max-h-56 overflow-y-auto rounded-lg border border-line">
          {grouped.map(([group, items]) => (
            <div key={group}>
              <p className="sticky top-0 bg-sunken px-3 py-1.5 text-[0.6875rem] font-medium tracking-wide text-ink-muted uppercase">
                {group}
              </p>
              <ul className="divide-y divide-line">
                {items.map((area) => (
                  <li key={area.code}>
                    <button
                      type="button"
                      onClick={() => setAreaCode(area.code)}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors',
                        areaCode === area.code
                          ? 'bg-brand-soft text-brand'
                          : 'text-ink-secondary hover:bg-sunken hover:text-ink',
                      )}
                    >
                      <span className="w-6 shrink-0 font-mono text-xs opacity-60">{area.code}</span>
                      {area.label}
                      {areaCode === area.code && <Check className="ml-auto size-3.5" aria-hidden />}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {areas.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-ink-muted">No area matches that.</p>
          )}
        </div>
      </section>

      {/* Type */}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-ink">
          2. What is it?
          {typeCode && <span className="ml-2 font-mono text-xs text-brand">{typeCode}</span>}
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {AIAG_DAMAGE_TYPES.map((type) => (
            <button
              key={type.code}
              type="button"
              onClick={() => setTypeCode(type.code)}
              className={cn(
                'rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
                typeCode === type.code
                  ? 'border-brand bg-brand-soft text-brand'
                  : 'border-line text-ink-secondary hover:border-line-strong hover:text-ink',
              )}
            >
              {type.label}
            </button>
          ))}
        </div>
      </section>

      {/* Severity */}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-ink">
          3. How big?
          {severityCode && <span className="ml-2 font-mono text-xs text-brand">{severityCode}</span>}
        </h3>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {AIAG_SEVERITIES.map((severity) => (
            <button
              key={severity.code}
              type="button"
              onClick={() => setSeverityCode(severity.code)}
              className={cn(
                'rounded-lg border px-3 py-2 text-left transition-colors',
                severityCode === severity.code
                  ? 'border-brand bg-brand-soft'
                  : 'border-line hover:border-line-strong',
              )}
            >
              <span
                className={cn(
                  'block text-xs font-medium',
                  severityCode === severity.code ? 'text-brand' : 'text-ink',
                )}
              >
                {severity.imperial}
              </span>
              <span className="block text-[0.6875rem] text-ink-muted">{severity.metric}</span>
            </button>
          ))}
        </div>
      </section>

      {/* Description */}
      <section>
        <label htmlFor="damage-description" className="mb-2 block text-sm font-semibold text-ink">
          4. Describe it
        </label>
        <textarea
          id="damage-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="Six-inch scratch on the driver's door, below the handle"
          className="w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm text-ink placeholder:text-ink-muted focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20 focus:outline-none"
        />
        <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
          A code alone is weak evidence. What holds up in a claim is a sentence anyone can match to
          the photograph.
        </p>
      </section>

      {/* Non-transportation damage */}
      <section className="rounded-lg border border-line bg-sunken/50 p-3">
        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={nonTransportation}
            onChange={(e) => setNonTransportation(e.target.checked)}
            className="mt-0.5 size-4 shrink-0 rounded border-line accent-[var(--brand)]"
          />
          <span>
            <span className="block text-xs font-medium text-ink">
              This is not transport damage
            </span>
            <span className="mt-1 block text-[0.6875rem] leading-relaxed text-ink-secondary">
              The standard lists conditions a carrier is not liable for. Marking one as carrier
              damage opens a claim against your own company.
            </span>
          </span>
        </label>

        {nonTransportation && (
          <ul className="mt-2.5 space-y-1 border-t border-line pt-2.5 text-[0.6875rem] text-ink-muted">
            {NON_TRANSPORTATION_DAMAGE.slice(0, 5).map((item) => (
              <li key={item}>· {item}</li>
            ))}
          </ul>
        )}
      </section>

      {/* Summary and confirm */}
      {summary && (
        <div
          className={cn(
            'rounded-lg px-3 py-2.5',
            holdRequired ? 'bg-warn-soft' : 'bg-ok-soft',
          )}
        >
          <p className="flex items-center gap-2 font-mono text-sm font-medium">
            <span className={holdRequired ? 'text-warn' : 'text-ok'}>{code}</span>
            <Badge tone={holdRequired ? 'warn' : 'ok'} size="sm">
              {holdRequired ? 'Hold required' : 'Coded'}
            </Badge>
          </p>
          <p className={cn('mt-1 text-xs', holdRequired ? 'text-warn' : 'text-ok')}>{summary}</p>
          {holdRequired && (
            <p className="mt-1.5 flex items-start gap-1.5 text-[0.6875rem] leading-relaxed text-warn">
              <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
              Severity 3 or above. The standard holds the vehicle in place for one business day
              from notification.
            </p>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <Button type="button" variant="secondary" block onClick={onCancel}>
          <X aria-hidden />
          Cancel
        </Button>
        <Button
          type="button"
          block
          disabled={!code}
          onClick={() => {
            if (!code || !areaCode || !typeCode || !severityCode) return;
            onConfirm({
              areaCode,
              typeCode,
              severityCode,
              description: description.trim(),
              nonTransportation,
              code,
            });
          }}
        >
          Add this damage
        </Button>
      </div>
    </div>
  );
}
