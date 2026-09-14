'use client';

import { useSyncExternalStore } from 'react';
import { useTheme } from 'next-themes';
import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

const OPTIONS = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'dark', label: 'Dark', Icon: Moon },
] as const;

/**
 * Three-way theme switch.
 *
 * Renders a placeholder until mounted: the resolved theme is only known on the
 * client, and rendering the wrong icon during hydration causes a visible flip.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();

  // The resolved theme is only known on the client, and rendering the wrong
  // one during hydration causes a visible flip. Two snapshots with no
  // subscription: false on the server, true once mounted.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  return (
    <div
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full border border-line bg-raised p-0.5',
        className,
      )}
      role="radiogroup"
      aria-label="Colour theme"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = mounted && theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => setTheme(value)}
            className={cn(
              'grid size-7 place-items-center rounded-full transition-colors duration-200',
              active
                ? 'bg-brand text-brand-contrast'
                : 'text-ink-muted hover:bg-sunken hover:text-ink',
            )}
          >
            <Icon className="size-3.5" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
