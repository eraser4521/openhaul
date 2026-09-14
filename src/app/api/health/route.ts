import { NextResponse } from 'next/server';

/**
 * Reachability probe for the offline outbox.
 *
 * `navigator.onLine` only reports that a network interface is up, so a
 * truck-stop captive portal looks online while intercepting every request.
 * The custom header is what distinguishes this instance from a portal's
 * cheerful 200.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'x-openhaul': 'ok',
      'cache-control': 'no-store',
    },
  });
}
