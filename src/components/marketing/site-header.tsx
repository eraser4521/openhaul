'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Menu, X } from 'lucide-react';
import { GithubIcon } from '@/components/ui/icons';
import { Logo } from '@/components/ui/logo';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { REPO_URL } from '@/lib/constants';

const NAV = [
  { href: '#features', label: 'Features' },
  { href: '#workflow', label: 'How it works' },
  { href: '#security', label: 'Security' },
  { href: '#pricing', label: 'Pricing' },
];

export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Lock body scroll while the mobile sheet is open.
  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [menuOpen]);

  return (
    <header
      className={cn(
        'fixed inset-x-0 top-0 z-50 transition-all duration-300',
        scrolled ? 'border-b border-line bg-overlay backdrop-blur-xl' : 'border-b border-transparent',
      )}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-5">
        <Link href="/" className="shrink-0 rounded-lg" aria-label="OpenHaul home">
          <Logo />
        </Link>

        <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-lg px-3 py-2 text-sm text-ink-secondary transition-colors hover:bg-sunken hover:text-ink"
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <ThemeToggle className="hidden sm:inline-flex" />

          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="hidden size-9 place-items-center rounded-lg text-ink-secondary transition-colors hover:bg-sunken hover:text-ink sm:grid"
            aria-label="Source on GitHub"
          >
            <GithubIcon className="size-[1.125rem]" aria-hidden />
          </a>

          <Link
            href="/login"
            className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'hidden sm:inline-flex')}
          >
            Sign in
          </Link>

          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="grid size-9 place-items-center rounded-lg text-ink transition-colors hover:bg-sunken md:hidden"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
          >
            {menuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {menuOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden border-t border-line bg-overlay backdrop-blur-xl md:hidden"
          >
            <nav className="flex flex-col gap-1 p-5" aria-label="Mobile">
              {NAV.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  onClick={() => setMenuOpen(false)}
                  className="rounded-lg px-3 py-2.5 text-[0.9375rem] text-ink-secondary transition-colors hover:bg-sunken hover:text-ink"
                >
                  {item.label}
                </a>
              ))}

              <div className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-4">
                <ThemeToggle />
                <Link
                  href="/login"
                  onClick={() => setMenuOpen(false)}
                  className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-contrast"
                >
                  Sign in
                </Link>
              </div>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
