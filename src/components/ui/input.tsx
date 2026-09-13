'use client';

import { useId } from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string | null;
  /** Rendered inside the field, before the text. */
  leading?: React.ReactNode;
  /** Rendered inside the field, after the text. */
  trailing?: React.ReactNode;
}

export function Input({
  className,
  label,
  hint,
  error,
  leading,
  trailing,
  id,
  ...props
}: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-ink">
          {label}
          {props.required && (
            <span className="ml-0.5 text-danger" aria-hidden>
              *
            </span>
          )}
        </label>
      )}

      <div className="relative">
        {leading && (
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-muted [&_svg]:size-4">
            {leading}
          </span>
        )}

        <input
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            'h-10 w-full rounded-lg border bg-raised px-3 text-sm text-ink',
            'placeholder:text-ink-muted',
            'transition-[border-color,box-shadow] duration-200',
            'focus:outline-none focus-visible:outline-none',
            error
              ? 'border-danger focus:ring-2 focus:ring-[var(--danger)]/25'
              : 'border-line focus:border-brand focus:ring-2 focus:ring-[var(--brand)]/20',
            'disabled:cursor-not-allowed disabled:opacity-60',
            leading && 'pl-9',
            trailing && 'pr-9',
            className,
          )}
          {...props}
        />

        {trailing && (
          <span className="absolute top-1/2 right-3 -translate-y-1/2 text-ink-muted [&_svg]:size-4">
            {trailing}
          </span>
        )}
      </div>

      {error ? (
        <p id={`${inputId}-error`} className="flex items-center gap-1.5 text-xs text-danger">
          <AlertCircle className="size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
