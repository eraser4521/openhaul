import { cn } from '@/lib/utils/cn';

/**
 * The OpenHaul mark: a stylised car-hauler deck seen in profile — two loading
 * ramps rising to the right, with a vehicle silhouette on the upper deck.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={cn('size-8', className)}
      role="img"
      aria-label="OpenHaul"
    >
      <defs>
        <linearGradient id="oh-mark" x1="2" y1="28" x2="30" y2="4" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--brand)" />
          <stop offset="1" stopColor="var(--accent)" />
        </linearGradient>
      </defs>

      <rect width="32" height="32" rx="8" fill="url(#oh-mark)" />

      {/* Upper deck, angled like a loaded top rack. */}
      <path
        d="M6 13.5 L14 9 L26 9"
        stroke="var(--brand-contrast)"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.92"
      />
      {/* Lower deck. */}
      <path
        d="M6 22 L20 22 L26 18"
        stroke="var(--brand-contrast)"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.92"
      />
      {/* Wheels. */}
      <circle cx="10.5" cy="25.5" r="1.9" fill="var(--brand-contrast)" opacity="0.92" />
      <circle cx="21" cy="25.5" r="1.9" fill="var(--brand-contrast)" opacity="0.92" />
    </svg>
  );
}

export function Logo({
  className,
  showWordmark = true,
}: {
  className?: string;
  showWordmark?: boolean;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark />
      {showWordmark && (
        <span className="text-[1.0625rem] font-semibold tracking-tight text-ink">
          Open<span className="text-brand">Haul</span>
        </span>
      )}
    </span>
  );
}
