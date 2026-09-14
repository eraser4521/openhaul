import Link from 'next/link';
import { ScanLine, WifiOff } from 'lucide-react';
import { Logo } from '@/components/ui/logo';

export const metadata = { title: 'Offline' };

/**
 * Served by the service worker when a page is requested with no network and
 * no cached copy.
 *
 * Deliberately reassuring rather than apologetic: the work a driver is doing
 * is saved on the device, and the useful thing to tell them is which parts
 * still function.
 */
export default function OfflinePage() {
  return (
    <div className="grid min-h-dvh place-items-center px-5 py-10">
      <div className="w-full max-w-sm text-center">
        <Logo className="justify-center" />

        <span className="mx-auto mt-8 grid size-14 place-items-center rounded-2xl bg-warn-soft text-warn">
          <WifiOff className="size-6" aria-hidden />
        </span>

        <h1 className="mt-5 text-xl font-semibold text-ink">You are offline</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-secondary">
          Nothing has been lost. Anything captured on this device stays here and uploads by itself
          once you are back in coverage.
        </p>

        <ul className="mt-6 space-y-2 text-left text-xs leading-relaxed text-ink-secondary">
          {[
            'VIN scanning and check-digit validation still work — the decoder is on the device.',
            'Photos and signatures are captured locally and queued.',
            'Vehicle lookups you have done before are still available.',
          ].map((item) => (
            <li key={item} className="flex items-start gap-2 rounded-lg bg-sunken px-3 py-2.5">
              <ScanLine className="mt-px size-3.5 shrink-0 text-ok" aria-hidden />
              {item}
            </li>
          ))}
        </ul>

        <Link
          href="/dashboard"
          className="mt-8 inline-flex h-11 items-center justify-center rounded-xl border border-line bg-raised px-5 text-sm font-medium text-ink transition-colors hover:bg-sunken"
        >
          Try again
        </Link>
      </div>
    </div>
  );
}
