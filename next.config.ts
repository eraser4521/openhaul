import type { NextConfig } from 'next';

const securityHeaders = [
  // Defaults to one year for this host only. A self-hoster running OpenHaul on
  // a subdomain alongside other services must not have includeSubDomains or
  // preload forced on them, so both are opt-in.
  {
    key: 'Strict-Transport-Security',
    value: process.env.HSTS_HEADER ?? 'max-age=31536000',
  },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  {
    // `camera=(self)` is required for in-browser VIN barcode scanning.
    // `geolocation=(self)` stamps inspections for evidentiary value.
    key: 'Permissions-Policy',
    value: [
      'camera=(self)',
      'geolocation=(self)',
      'microphone=()',
      'payment=()',
      'usb=()',
      'magnetometer=()',
      'accelerometer=()',
      'gyroscope=()',
      'interest-cohort=()',
    ].join(', '),
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Never leak stack traces or framework version to clients.
  poweredByHeader: false,

  experimental: {
    // Server Actions are same-origin only. Set ALLOWED_ORIGINS when deploying
    // behind a proxy that rewrites the Host header.
    serverActions: {
      allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',').map((s) => s.trim()) ?? undefined,
      bodySizeLimit: '12mb',
    },
  },

  // Native modules that must not be bundled into the server build.
  serverExternalPackages: ['@node-rs/argon2', 'sharp', '@libsql/client'],

  images: {
    // Inspection photos are served from our own origin only.
    remotePatterns: [],
    formats: ['image/avif', 'image/webp'],
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
      {
        // The service worker must never be cached, or clients pin an old build.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      {
        // The barcode decoder WASM is content-hashed and immutable.
        source: '/wasm/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ];
  },
};

export default nextConfig;
