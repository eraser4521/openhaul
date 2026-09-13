import { cn } from '@/lib/utils/cn';

/**
 * Decorative layered gradient wash behind the hero.
 *
 * Three blurred blobs drift on long, offset cycles so the loop never reads as
 * periodic. Rendered with CSS only — no canvas, no JS on the main thread — and
 * the whole layer is inert to assistive tech and pointer events.
 */
export function Aurora({ className }: { className?: string }) {
  return (
    <div
      className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}
      aria-hidden
    >
      {/* Blueprint grid, faded toward the edges. */}
      <div className="bg-grid mask-fade absolute inset-0 opacity-[0.55]" />

      {/* Warm brand blob, upper left of centre. */}
      <div
        className="animate-drift absolute -top-[18%] left-[8%] size-[42rem] rounded-full opacity-[0.28] blur-[110px] will-change-transform dark:opacity-[0.34]"
        style={{ background: 'radial-gradient(circle, var(--brand) 0%, transparent 68%)' }}
      />

      {/* Cool accent blob, right. */}
      <div
        className="animate-drift-slow absolute top-[6%] right-[2%] size-[36rem] rounded-full opacity-[0.22] blur-[120px] will-change-transform dark:opacity-[0.3]"
        style={{ background: 'radial-gradient(circle, var(--accent) 0%, transparent 68%)' }}
      />

      {/* Low, wide blob that grounds the composition. */}
      <div
        className="animate-float absolute -bottom-[22%] left-1/2 size-[48rem] -translate-x-1/2 rounded-full opacity-[0.16] blur-[130px] will-change-transform dark:opacity-[0.22]"
        style={{
          background:
            'radial-gradient(circle, color-mix(in oklch, var(--brand) 60%, var(--accent)) 0%, transparent 70%)',
        }}
      />

      {/* Bottom fade into the page background, so the section has no hard seam. */}
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-[var(--surface-base)]" />
    </div>
  );
}
