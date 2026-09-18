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
 * Cost: every route must render per request, so static optimisation and PPR
 * are off. For a per-user load board and inspection app that is no loss.
 *
 * That cost is not paid automatically. This comment used to claim nonces
 * "force dynamic rendering", and they do not: Next happily prerendered `/`,
 * `/login` and `/register`, baking HTML with no nonce on any script, which
 * this policy then blocked in full. It is `export const dynamic` in
 * `src/app/layout.tsx` that actually holds the two halves together — do not
 * remove it without removing the nonce here too.
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
    /*
     * Deliberately no nonce on style-src.
     *
     * A nonce causes the browser to IGNORE 'unsafe-inline' entirely, and the
     * animation library sets inline style attributes on elements it animates —
     * which a nonce cannot cover, because there is no <style> tag to tag.
     * Including both silently blocks every inline style and breaks the UI.
     *
     * The trade is acceptable: inline CSS cannot execute script, so the risk
     * here is far lower than the equivalent on script-src, which does carry a
     * nonce and 'strict-dynamic' above.
     */
    `style-src 'self' 'unsafe-inline'`,
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
