'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Download, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Registers the service worker and surfaces two things a driver needs to see:
 * whether they are offline, and whether an update is waiting.
 *
 * The worker never activates itself. Taking an update mid-inspection would
 * swap precached chunks under a running page, so the decision is the user's.
 */
export function ServiceWorkerManager() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    setOffline(!navigator.onLine);
    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);

    if (!('serviceWorker' in navigator)) {
      return () => {
        window.removeEventListener('offline', goOffline);
        window.removeEventListener('online', goOnline);
      };
    }

    let cancelled = false;

    void navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        if (cancelled) return;

        if (registration.waiting) setWaiting(registration.waiting);

        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            // 'installed' with an existing controller means an update is ready
            // but held back; without one it is the very first install.
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              setWaiting(installing);
            }
          });
        });
      })
      .catch(() => {
        // Registration failing is not fatal — the app works online regardless.
      });

    // Reload once the new worker takes control, so the page and its chunks
    // come from the same build.
    let reloading = false;
    const onControllerChange = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    return () => {
      cancelled = true;
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);

  return (
    <AnimatePresence>
      {offline && (
        <motion.div
          key="offline"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          className="fixed inset-x-0 bottom-16 z-50 mx-auto w-fit lg:bottom-4"
          role="status"
        >
          <p className="flex items-center gap-2 rounded-full border border-line bg-overlay px-4 py-2 text-xs font-medium text-ink shadow-lg backdrop-blur-xl">
            <WifiOff className="size-3.5 shrink-0 text-warn" aria-hidden />
            Offline — scanning and inspections still work. Changes sync when you reconnect.
          </p>
        </motion.div>
      )}

      {waiting && !offline && (
        <motion.div
          key="update"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          className="fixed inset-x-0 bottom-16 z-50 mx-auto w-fit lg:bottom-4"
          role="status"
        >
          <div className="flex items-center gap-3 rounded-full border border-line bg-overlay py-2 pr-2 pl-4 shadow-lg backdrop-blur-xl">
            <span className="flex items-center gap-2 text-xs font-medium text-ink">
              <Download className="size-3.5 shrink-0 text-brand" aria-hidden />
              An update is ready
            </span>
            <Button size="sm" onClick={() => waiting.postMessage('SKIP_WAITING')}>
              Apply
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
