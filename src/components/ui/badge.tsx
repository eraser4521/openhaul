import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils/cn';

const badge = cva(
  'inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: 'bg-sunken text-ink-secondary border border-line',
        brand: 'bg-brand-soft text-brand',
        ok: 'bg-ok-soft text-ok',
        warn: 'bg-warn-soft text-warn',
        danger: 'bg-danger-soft text-danger',
        info: 'bg-info-soft text-info',
        accent: 'bg-accent-soft text-accent',
      },
      size: {
        sm: 'px-2 py-0.5 text-[0.6875rem]',
        md: 'px-2.5 py-1 text-xs',
      },
    },
    defaultVariants: { tone: 'neutral', size: 'md' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badge> {
  /** Renders a small leading status dot, with a pulse for live states. */
  dot?: boolean;
  pulse?: boolean;
}

export function Badge({ className, tone, size, dot, pulse, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badge({ tone, size }), className)} {...props}>
      {dot && (
        <span
          className={cn('size-1.5 rounded-full bg-current', pulse && 'animate-pulse-ring')}
          aria-hidden
        />
      )}
      {children}
    </span>
  );
}
