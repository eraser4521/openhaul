import { requireSessionOrRedirect } from '@/lib/auth/guard';
import { logoutAction } from '../(auth)/actions';
import { AppMobileNav, AppSidebar } from '@/components/app/app-nav';
import { ServiceWorkerManager } from '@/components/app/service-worker';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Checked here for convenience, but every action and route handler below
  // re-verifies: a layout cannot stop a route segment from rendering, and
  // Server Actions are reachable without going through it at all.
  const { session } = await requireSessionOrRedirect();

  const signOut = async () => {
    'use server';
    await logoutAction();
  };

  const navProps = {
    role: session.role,
    displayName: session.displayName,
    orgName: session.orgName,
    onSignOut: signOut,
  };

  return (
    <div className="flex min-h-dvh">
      <AppSidebar {...navProps} />

      <div className="flex min-w-0 flex-1 flex-col">
        <AppMobileNav {...navProps} />

        {/* Bottom padding clears the mobile navigation bar. */}
        <main id="main" className="flex-1 pb-20 lg:pb-0">
          {children}
        </main>

        <ServiceWorkerManager />
      </div>
    </div>
  );
}
