import { cn } from '@/lib/utils/cn';

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-4 border-b border-line px-5 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-8',
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-ink sm:text-2xl">{title}</h1>
        {description && (
          <p className="mt-1 text-sm leading-relaxed text-ink-secondary">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn('px-5 py-6 sm:px-8', className)}>{children}</div>;
}

/** Shown when a list has nothing in it yet. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="bg-dots relative overflow-hidden rounded-xl border border-dashed border-line px-6 py-16 text-center">
      <div className="relative">
        <span className="mx-auto grid size-12 place-items-center rounded-xl bg-brand-soft text-brand">
          <Icon className="size-5" aria-hidden />
        </span>
        <h2 className="mt-4 text-base font-semibold text-ink">{title}</h2>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-ink-secondary">
          {description}
        </p>
        {action && <div className="mt-6 flex justify-center">{action}</div>}
      </div>
    </div>
  );
}
