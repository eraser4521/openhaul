import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

const button = cva(
  [
    'relative inline-flex items-center justify-center gap-2 whitespace-nowrap',
    'font-medium transition-all duration-200 ease-out',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]',
    'disabled:pointer-events-none disabled:opacity-50',
    'active:scale-[0.97]',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        primary: [
          'bg-brand text-brand-contrast shadow-sm',
          'hover:bg-brand-hover hover:shadow-glow',
        ],
        secondary: [
          'bg-raised text-ink border border-line shadow-xs',
          'hover:border-line-strong hover:bg-sunken',
        ],
        ghost: 'text-ink-secondary hover:bg-sunken hover:text-ink',
        outline: [
          'border border-line-strong bg-transparent text-ink',
          'hover:border-brand hover:text-brand',
        ],
        danger: 'bg-danger text-white shadow-sm hover:brightness-110',
        subtle: 'bg-brand-soft text-brand hover:brightness-105',
        link: 'text-brand underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 rounded-lg px-3 text-xs [&_svg]:size-3.5',
        md: 'h-10 rounded-lg px-4 text-sm [&_svg]:size-4',
        lg: 'h-12 rounded-xl px-6 text-[0.9375rem] [&_svg]:size-[1.125rem]',
        // Field-sized: drivers tapping with gloves on a bouncing truck.
        xl: 'h-14 rounded-xl px-8 text-base [&_svg]:size-5',
        icon: 'size-10 rounded-lg [&_svg]:size-4',
        'icon-sm': 'size-8 rounded-lg [&_svg]:size-3.5',
        'icon-lg': 'size-12 rounded-xl [&_svg]:size-5',
      },
      block: {
        true: 'w-full',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  loading?: boolean;
}

export function Button({
  className,
  variant,
  size,
  block,
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(button({ variant, size, block }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Loader2 className="animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export { button as buttonVariants };
