import { NextResponse, type NextRequest } from 'next/server';

/**
 * Per-request Content Security Policy.
 *
 * This lives here rather than in `next.config.ts` because the policy needs a
 * fresh nonce per response. Next.js App Router streams the RSC payload through
 * inline `<script>` tags, so a static `script-src 'self'` policy blocks
 * hydration entirely — the page renders and then never becomes interactive.
 *
 * `'strict-dynamic'` makes browsers ignore host allowlists and `'self'` in
 * script-src, trusting only nonce-tagged scripts and whatever they load.
 * Keyword sources are still honoured, which is why `'wasm-unsafe-eval'`
 * continues to work for the ZXing barcode decoder.
 *
 * Cost: nonces force dynamic rendering, so static optimisation and PPR are off.
 * For a per-user load board and inspection app that is no loss.
 */
export function proxy(request: NextRequest) {
  const isDev = process.env.NODE_ENV === 'development';
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  const csp = [
    `default-src 'self'`,
    // 'wasm-unsafe-eval' permits WebAssembly compilation only, not eval() of JS.
    // 'unsafe-eval' is dev-only, for React Refresh and the error overlay.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${
      isDev ? " 'unsafe-eval'" : ''
    }`,
    // Tailwind and Next both inject inline <style>; browsers that honour the
    // nonce use it, and 'unsafe-inline' is the fallback they then ignore.
    `style-src 'self' 'nonce-${nonce}' 'unsafe-inline'`,
    // blob: backs captured inspection photos before they are uploaded.
    `img-src 'self' data: blob:`,
    // blob: backs the live camera preview during VIN scanning.
    `media-src 'self' blob:`,
    `font-src 'self' data:`,
    `connect-src 'self' https://vpic.nhtsa.dot.gov https://mobile.fmcsa.dot.gov https://data.transportation.gov${
      isDev ? ' ws: wss:' : ''
    }`,
    // blob: backs the barcode decode worker.
    `worker-src 'self' blob:`,
    `manifest-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');

  // Next.js reads the CSP off the *request* headers to know which nonce to
  // stamp onto the scripts it generates.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Static assets, the service worker and the manifest are served without
      // a nonce; they contain no inline script and gain nothing from one.
      source:
        '/((?!api|_next/static|_next/image|favicon.ico|icon.svg|sw.js|manifest.webmanifest|icons/).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
