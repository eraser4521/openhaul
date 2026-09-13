'use client';

import { useId, useMemo, useState } from 'react';
import { AlertTriangle, Check, Info } from 'lucide-react';
import { classifyVin, decodeModelYear, VIN_LENGTH } from '@/lib/vin';
import { cn } from '@/lib/utils/cn';

/**
 * Manual VIN entry with live validation.
 *
 * This is deliberately the primary input, not a fallback. With check-digit
 * validation, typing a VIN is fast and reliable, and a driver in rain at night
 * needs it to work. Scanning is an accelerator on top.
 */

export interface VinInputProps {
  value: string;
  onChange: (value: string) => void;
  onValid?: (vin: string) => void;
  label?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  className?: string;
}

export function VinInput({
  value,
  onChange,
  onValid,
  label = 'VIN',
  autoFocus,
  disabled,
  className,
}: VinInputProps) {
  const inputId = useId();
  const [touched, setTouched] = useState(false);

  const state = useMemo(() => {
    if (value.length === 0) return null;
    const classification = classifyVin(value);
    const year =
      classification.kind === 'modern' ? decodeModelYear(classification.vin).year : null;
    return { classification, year };
  }, [value]);

  const handleChange = (raw: string) => {
    // Strip anything that cannot appear in a VIN as the user types, so a
    // pasted label with spaces or dashes just works.
    const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, VIN_LENGTH + 1);
    onChange(cleaned);

    const classification = classifyVin(cleaned);
    if (classification.kind === 'modern' && classification.checkDigitValid) {
      onValid?.(classification.vin);
    }
  };

  const kind = state?.classification.kind;
  const checkDigitValid =
    state?.classification.kind === 'modern' ? state.classification.checkDigitValid : null;

  const tone =
    kind === undefined
      ? 'idle'
      : kind === 'modern'
        ? checkDigitValid
          ? 'valid'
          : 'warn'
        : kind === 'legacy'
          ? 'info'
          : touched
            ? 'error'
            : 'idle';

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={inputId} className="text-sm font-medium text-ink">
          {label}
        </label>
        <span
          className={cn(
            'font-mono text-xs tabular-nums',
            value.length === VIN_LENGTH ? 'text-ink-secondary' : 'text-ink-muted',
          )}
        >
          {value.length}/{VIN_LENGTH}
        </span>
      </div>

      <input
        id={inputId}
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={() => setTouched(true)}
        autoFocus={autoFocus}
        disabled={disabled}
        inputMode="text"
        autoCapitalize="characters"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        placeholder="1HGCM82633A004352"
        aria-describedby={`${inputId}-status`}
        aria-invalid={tone === 'error'}
        className={cn(
          'h-14 w-full rounded-xl border bg-raised px-4',
          // Tracking makes a 17-character string far easier to proofread
          // against a door jamb.
          'font-mono text-lg tracking-[0.12em] text-ink uppercase',
          'placeholder:tracking-normal placeholder:text-ink-muted',
          'transition-[border-color,box-shadow] duration-200 focus:outline-none',
          tone === 'valid' && 'border-ok focus:ring-2 focus:ring-[var(--ok)]/25',
          tone === 'warn' && 'border-warn focus:ring-2 focus:ring-[var(--warn)]/25',
          tone === 'error' && 'border-danger focus:ring-2 focus:ring-[var(--danger)]/25',
          (tone === 'idle' || tone === 'info') &&
            'border-line focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20',
          'disabled:cursor-not-allowed disabled:opacity-60',
        )}
      />

      <p id={`${inputId}-status`} className="min-h-5 text-xs leading-relaxed">
        {state === null && (
          <span className="text-ink-muted">
            17 characters. The letters I, O and Q never appear in a VIN.
          </span>
        )}

        {kind === 'modern' && checkDigitValid && (
          <span className="inline-flex items-center gap-1.5 text-ok">
            <Check className="size-3.5 shrink-0" aria-hidden />
            Check digit valid{state?.year ? ` · ${state.year} model year` : ''}
          </span>
        )}

        {kind === 'modern' && !checkDigitValid && (
          <span className="inline-flex items-start gap-1.5 text-warn">
            <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>
              Check digit does not match — expected{' '}
              <strong className="font-mono">
                {state?.classification.kind === 'modern'
                  ? state.classification.expectedCheckDigit
                  : '?'}
              </strong>{' '}
              at position 9. Double-check the plate, but you can save it anyway: mis-stamped and
              imported VINs do occur.
            </span>
          </span>
        )}

        {kind === 'legacy' && (
          <span className="inline-flex items-start gap-1.5 text-info">
            <Info className="mt-px size-3.5 shrink-0" aria-hidden />
            Pre-1981 VIN — no check digit to verify. It will be saved as entered.
          </span>
        )}

        {kind === 'invalid' && touched && (
          <span className="inline-flex items-start gap-1.5 text-danger">
            <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
            {state?.classification.kind === 'invalid' ? state.classification.reason : ''}
          </span>
        )}
      </p>
    </div>
  );
}
