import { cn } from '@/lib/utils/cn';

export function Card({
  className,
  interactive = false,
  glass = false,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { interactive?: boolean; glass?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-xl border border-line',
        glass ? 'glass' : 'bg-raised',
        'shadow-xs',
        interactive &&
          'transition-all duration-300 ease-out hover:-translate-y-0.5 hover:border-line-strong hover:shadow-lg',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 p-5', className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-base font-semibold text-ink', className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm text-ink-secondary', className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5 pt-0', className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex items-center gap-3 border-t border-line px-5 py-4', className)}
      {...props}
    />
  );
}
