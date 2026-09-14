import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { carrierByDot, carriersByDocket, carriersByName } from '@/lib/fmcsa/qcmobile';

/**
 * The QCMobile client, against the envelopes the service actually returns.
 *
 * The error bodies here are verbatim from a live request made while building
 * this: FMCSA answers a missing or invalid key with HTTP 404 and a plain
 * string in `content`, which is the same status an unknown USDOT number
 * produces. Everything in this file exists to keep those two apart.
 */

const KEY = 'test-key';

function envelope(content: unknown, status = 200): Response {
  return new Response(JSON.stringify({ content, retrievalDate: '2026-09-14T03:24:07.016+0000' }), {
    status,
    headers: { 'content-type': 'application/hal+json' },
  });
}

/** Verbatim from mobile.fmcsa.dot.gov with no key supplied. */
const NO_KEY_BODY = envelope('Must provide Webkey', 404);
/** Verbatim from the same endpoint with a key it does not recognise. */
const BAD_KEY_BODY = envelope('Webkey not found', 404);

const CARRIER = {
  carrier: {
    dotNumber: 76830,
    legalName: 'A REAL CARRIER INC',
    allowedToOperate: 'Y',
    statusCode: 'A',
    phyCity: 'FORT WORTH',
    phyState: 'TX',
  },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('carrierByDot', () => {
  it('returns the carrier record and the retrieval date', async () => {
    fetchMock.mockResolvedValue(envelope(CARRIER));

    const result = await carrierByDot('76830', { webKey: KEY });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.legalName).toBe('A REAL CARRIER INC');
    // The census is a snapshot, so when it was taken is part of the answer.
    expect(result.retrievalDate?.toISOString()).toBe('2026-09-14T03:24:07.016Z');
  });

  it('sends the key as a query parameter, which is how this API authenticates', async () => {
    fetchMock.mockResolvedValue(envelope(CARRIER));
    await carrierByDot('76830', { webKey: KEY });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe('https://mobile.fmcsa.dot.gov/qc/services/carriers/76830?webKey=test-key');
  });

  it('never serves a cached HTTP response for an authority check', async () => {
    fetchMock.mockResolvedValue(envelope(CARRIER));
    await carrierByDot('76830', { webKey: KEY });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store' });
  });

  it('reports a missing key as a key problem, not as an unknown carrier', async () => {
    /*
     * The whole point. Both come back as HTTP 404, and conflating them would
     * report every carrier as unregistered the moment a key expired — telling
     * a dispatcher to refuse loads from companies that are perfectly fine.
     */
    fetchMock.mockResolvedValue(NO_KEY_BODY.clone());

    const result = await carrierByDot('76830', { webKey: KEY });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('bad_key');
    expect(result.message).toContain('FMCSA_WEB_KEY');
  });

  it('reports an unrecognised key the same way', async () => {
    fetchMock.mockResolvedValue(BAD_KEY_BODY.clone());

    const result = await carrierByDot('76830', { webKey: KEY });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('bad_key');
  });

  it('reports a genuinely unknown number as not found', async () => {
    fetchMock.mockResolvedValue(envelope(null, 200));

    const result = await carrierByDot('999999999', { webKey: KEY });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_found');
  });

  it('refuses to call out at all with no key configured', async () => {
    vi.stubEnv('FMCSA_WEB_KEY', '');

    const result = await carrierByDot('76830', {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a timeout as a timeout', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    const result = await carrierByDot('76830', { webKey: KEY, timeoutMs: 5 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('timeout');
  });

  it('does not blame the operator when FMCSA is down', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await carrierByDot('76830', { webKey: KEY });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unavailable');
    expect(result.message).toContain('their service');
  });

  it('reports rate limiting distinctly, so the fix is obvious', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 429 }));

    const result = await carrierByDot('76830', { webKey: KEY });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('rate_limited');
  });

  it('survives a body that is not JSON at all', async () => {
    // A proxy or a captive portal returning an HTML error page.
    fetchMock.mockResolvedValue(new Response('<html>504</html>', { status: 504 }));

    const result = await carrierByDot('76830', { webKey: KEY });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unavailable');
  });

  it('strips a typed prefix rather than failing on it', async () => {
    fetchMock.mockResolvedValue(envelope(CARRIER));
    await carrierByDot('USDOT 76830', { webKey: KEY });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/carriers/76830?');
  });

  it('rejects input with no digits without calling out', async () => {
    const result = await carrierByDot('not a number', { webKey: KEY });
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a record returned without the carrier wrapper', async () => {
    fetchMock.mockResolvedValue(envelope({ dotNumber: 76830, legalName: 'UNWRAPPED INC' }));

    const result = await carrierByDot('76830', { webKey: KEY });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.legalName).toBe('UNWRAPPED INC');
  });
});

describe('carriersByDocket', () => {
  it('returns every match, because a docket number is not unique', async () => {
    /*
     * The same digits can exist under MC, FF and MX prefixes. Returning one of
     * them would clear the wrong company.
     */
    fetchMock.mockResolvedValue(
      envelope([CARRIER, { carrier: { dotNumber: 99999, legalName: 'ANOTHER CO' } }]),
    );

    const result = await carriersByDocket('MC-1084422', { webKey: KEY });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(2);
  });

  it('drops the prefix, which FMCSA does not index on', async () => {
    fetchMock.mockResolvedValue(envelope([CARRIER]));
    await carriersByDocket('MC-1084422', { webKey: KEY });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/carriers/docket-number/1084422?');
  });

  it('handles a single match returned unwrapped in an array', async () => {
    fetchMock.mockResolvedValue(envelope(CARRIER));

    const result = await carriersByDocket('1084422', { webKey: KEY });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
  });

  it('reports an empty list as not found rather than an empty success', async () => {
    fetchMock.mockResolvedValue(envelope([]));

    const result = await carriersByDocket('1084422', { webKey: KEY });
    expect(result.ok).toBe(false);
  });
});

describe('carriersByName', () => {
  it('searches on a name', async () => {
    fetchMock.mockResolvedValue(envelope([CARRIER]));

    const result = await carriersByName('Ridgeline Auto', { webKey: KEY });
    expect(result.ok).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('Ridgeline%20Auto');
  });

  it('refuses a fragment too short to mean anything', async () => {
    const result = await carriersByName('ab', { webKey: KEY });
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
