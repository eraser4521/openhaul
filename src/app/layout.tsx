import type { Metadata, Viewport } from 'next';
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable}`}
    >
      <body className="min-h-dvh bg-base font-sans text-ink antialiased">
        <ThemeProvider>
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
