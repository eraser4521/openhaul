import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { ThemeProvider } from '@/components/theme-provider';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'),
  title: {
    default: 'OpenHaul — Auto transport dispatch without the subscription',
    template: '%s · OpenHaul',
  },
  description:
    'Free, self-hostable load management for car haulers. VIN barcode scanning, electronic BOLs, photo condition reports and invoicing — your data, your server, no per-truck fees.',
  applicationName: 'OpenHaul',
  keywords: [
    'auto transport software',
    'car hauler dispatch',
    'vehicle transport TMS',
    'electronic bill of lading',
    'VIN scanner',
    'open source TMS',
  ],
  authors: [{ name: 'OpenHaul contributors' }],
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'OpenHaul',
    statusBarStyle: 'black-translucent',
  },
  formatDetection: { telephone: false },
  openGraph: {
    type: 'website',
    siteName: 'OpenHaul',
    title: 'OpenHaul — Auto transport dispatch without the subscription',
    description:
      'Free, self-hostable load management for car haulers. Scan VINs, sign BOLs, prove condition with photos, get paid.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'OpenHaul — Auto transport dispatch without the subscription',
    description: 'Free, self-hostable load management for car haulers.',
  },
  robots: { index: true, follow: true },
};

/**
 * Every route renders per request, because the CSP is nonce-based.
 *
 * `src/proxy.ts` mints a fresh nonce for each response and sends it in a
 * `script-src` that also carries 'strict-dynamic', which tells the browser to
 * trust nonce-tagged scripts and nothing else. Next can only stamp that nonce
 * onto its <script> tags while rendering a request that carries it.
 *
 * A prerendered page has no request to read, so its HTML is baked at build
 * time with no nonce on anything — and then the proxy serves it under a header
 * demanding one. The browser does exactly as instructed and blocks every
 * script on the page. The HTML still renders, which is what makes this so
 * unpleasant to catch: the page looks perfect and nothing hydrates.
 *
 * It bit `/`, `/login` and `/register` — precisely the pages a signed-out
 * visitor sees, so a deployed instance could not be logged into at all, while
 * the dev server was fine throughout because dev renders every request.
 *
 * The cost is static optimisation and PPR, which an authenticated dispatch
 * tool has no use for. Setting it on the root layout covers every route
 * beneath it, so a page added later cannot quietly reintroduce this.
 */
export const dynamic = 'force-dynamic';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Drivers wear gloves and work in sunlight; let them pinch-zoom.
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfbfc' },
    { media: '(prefers-color-scheme: dark)', color: '#16171c' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Minted by src/proxy.ts and put in the CSP. next-themes needs it by hand
  // for its pre-paint script; everything Next emits itself is stamped for us.
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable}`}
    >
      <body className="min-h-dvh bg-base font-sans text-ink antialiased">
        <ThemeProvider nonce={nonce}>
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:rounded-lg focus:bg-brand focus:px-4 focus:py-2 focus:font-medium focus:text-brand-contrast"
          >
            Skip to content
          </a>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
