import Link from 'next/link';
import { Logo } from '@/components/ui/logo';
import { ThemeToggle } from '@/components/ui/theme-toggle';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-col">
      {/* Decorative wash, faded out toward the edges so it never fights the form. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="bg-grid mask-fade absolute inset-0 opacity-40" />
        <div
          className="animate-drift absolute -top-40 left-1/2 size-[38rem] -translate-x-1/2 rounded-full opacity-25 blur-[120px] dark:opacity-30"
          style={{ background: 'radial-gradient(circle, var(--brand) 0%, transparent 70%)' }}
        />
      </div>

      <header className="relative flex items-center justify-between px-5 py-5">
        <Link href="/" className="rounded-lg" aria-label="OpenHaul home">
          <Logo />
        </Link>
        <ThemeToggle />
      </header>

      <main id="main" className="relative flex flex-1 items-center justify-center px-5 py-8">
        {children}
      </main>

      <footer className="relative px-5 py-6 text-center text-xs text-ink-muted">
        Your data stays on your server. OpenHaul never phones home.
      </footer>
    </div>
  );
}
