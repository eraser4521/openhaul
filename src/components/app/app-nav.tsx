'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ClipboardCheck,
  FileText,
  LayoutDashboard,
  LogOut,
  Menu,
  Receipt,
  ScanLine,
  Settings,
  ShieldAlert,
  Truck,
  Users,
  X,
} from 'lucide-react';
import { Logo, LogoMark } from '@/components/ui/logo';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { cn } from '@/lib/utils/cn';
import type { OrgRole } from '@/lib/db/schema';
// From the pure capability module, not the guard: the guard pulls in
// server-only database access that cannot cross into a client bundle.
import { can, type Capability } from '@/lib/auth/capabilities';

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  capability?: Capability;
  /** Shown in the mobile bar, which only has room for the essentials. */
  primary?: boolean;
}

const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, primary: true },
  { href: '/loads', label: 'Loads', icon: Truck, capability: 'load.read', primary: true },
  { href: '/scan', label: 'Scan VIN', icon: ScanLine, primary: true },
  {
    href: '/inspections',
    label: 'Inspections',
    icon: ClipboardCheck,
    capability: 'inspection.read',
    primary: true,
  },
  { href: '/customers', label: 'Customers', icon: Users, capability: 'customer.read' },
  { href: '/invoices', label: 'Invoices', icon: Receipt, capability: 'invoice.read' },
  { href: '/claims', label: 'Claims', icon: ShieldAlert, capability: 'claim.read' },
  { href: '/documents', label: 'Documents', icon: FileText, capability: 'load.read' },
  { href: '/settings', label: 'Settings', icon: Settings },
];

function visibleTo(role: OrgRole): NavItem[] {
  return NAV.filter((item) => !item.capability || can(role, item.capability));
}

function useIsActive() {
  const pathname = usePathname();
  return (href: string) => pathname === href || pathname.startsWith(`${href}/`);
}

export interface AppNavProps {
  role: OrgRole;
  displayName: string;
  orgName: string;
  onSignOut: () => void;
}

/** Desktop sidebar. */
export function AppSidebar({ role, displayName, orgName, onSignOut }: AppNavProps) {
  const isActive = useIsActive();
  const items = visibleTo(role);

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-sunken/40 lg:flex">
      <div className="px-5 py-5">
        <Link href="/dashboard" className="rounded-lg" aria-label="OpenHaul dashboard">
          <Logo />
        </Link>
      </div>

      <nav className="flex-1 space-y-0.5 px-3" aria-label="Main">
        {items.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                active ? 'text-ink' : 'text-ink-secondary hover:bg-raised hover:text-ink',
              )}
            >
              {active && (
                <motion.span
                  layoutId="nav-active"
                  className="absolute inset-0 rounded-lg bg-raised shadow-xs"
                  transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                />
              )}
              <item.icon
                className={cn('relative size-4 shrink-0', active && 'text-brand')}
                aria-hidden
              />
              <span className="relative">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-line p-3">
        <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-soft text-xs font-semibold text-brand">
            {displayName.slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-ink">{displayName}</p>
            <p className="truncate text-[0.6875rem] text-ink-muted capitalize">
              {role} · {orgName}
            </p>
          </div>
        </div>

        <div className="mt-2 flex items-center justify-between gap-2">
          <ThemeToggle />
          <button
            type="button"
            onClick={onSignOut}
            className="grid size-8 place-items-center rounded-lg text-ink-muted transition-colors hover:bg-raised hover:text-ink"
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut className="size-4" aria-hidden />
          </button>
        </div>
      </div>
    </aside>
  );
}

/** Mobile header plus a bottom bar sized for a gloved thumb. */
export function AppMobileNav({ role, displayName, orgName, onSignOut }: AppNavProps) {
  const isActive = useIsActive();
  const [open, setOpen] = useState(false);
  const items = visibleTo(role);
  const primary = items.filter((item) => item.primary).slice(0, 4);

  return (
    <>
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between gap-3 border-b border-line bg-overlay px-4 backdrop-blur-xl lg:hidden">
        <Link href="/dashboard" className="rounded-lg" aria-label="OpenHaul dashboard">
          <LogoMark />
        </Link>
        <p className="truncate text-sm font-medium text-ink">{orgName}</p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="grid size-9 place-items-center rounded-lg text-ink"
          aria-label="Open menu"
        >
          <Menu className="size-5" aria-hidden />
        </button>
      </header>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-50 bg-black/50 lg:hidden"
            />
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', stiffness: 380, damping: 38 }}
              className="fixed inset-y-0 right-0 z-50 flex w-72 flex-col border-l border-line bg-base lg:hidden"
            >
              <div className="flex items-center justify-between px-4 py-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{displayName}</p>
                  <p className="truncate text-xs text-ink-muted capitalize">{role}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="grid size-9 place-items-center rounded-lg text-ink"
                  aria-label="Close menu"
                >
                  <X className="size-5" aria-hidden />
                </button>
              </div>

              <nav className="flex-1 space-y-0.5 px-3" aria-label="Mobile">
                {items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    aria-current={isActive(item.href) ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors',
                      isActive(item.href)
                        ? 'bg-raised text-ink'
                        : 'text-ink-secondary hover:bg-raised hover:text-ink',
                    )}
                  >
                    <item.icon
                      className={cn('size-4 shrink-0', isActive(item.href) && 'text-brand')}
                      aria-hidden
                    />
                    {item.label}
                  </Link>
                ))}
              </nav>

              <div className="flex items-center justify-between gap-2 border-t border-line p-4">
                <ThemeToggle />
                <button
                  type="button"
                  onClick={onSignOut}
                  className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-ink-secondary hover:text-ink"
                >
                  <LogOut className="size-4" aria-hidden />
                  Sign out
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/*
        Bottom bar rather than a top one: this is where a thumb actually
        reaches on a phone held one-handed in a truck cab. The safe-area
        padding keeps it clear of the iOS home indicator.
      */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-line bg-overlay pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden"
        aria-label="Primary"
      >
        {primary.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex min-h-14 flex-col items-center justify-center gap-1 text-[0.6875rem] transition-colors',
                active ? 'text-brand' : 'text-ink-muted',
              )}
            >
              <item.icon className="size-5" aria-hidden />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </>
  );
}
