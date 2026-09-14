import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { applyMigrations } from './helpers/temp-db';

/**
 * Matching returned mail back to the send it came from, against a real
 * database.
 *
 * The mailbox itself is stubbed — an IMAP server is not the thing worth
 * testing here, and the parser has its own suite. What needs a database is the
 * matching: that a bounce finds the right send by either route, that a delay
 * notice does not get treated as a failure, and that reading the same message
 * twice changes nothing.
 */

const fetchUnread = vi.hoisted(() => vi.fn());
const markSeen = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/lib/email/inbox', () => ({
  fetchUnread,
  markSeen,
  inboxConfig: () => null,
  inboxConfigured: () => true,
  verifyInbox: async () => ({ ok: true }),
  describeImapError: (error: unknown) => String(error),
}));

let workspace: string;
let scoped: Awaited<ReturnType<typeof import('@/lib/db/scope')['forOrg']>>;
let bounces: typeof import('@/lib/documents/bounces');
let dbModule: typeof import('@/lib/db/client');
let schema: typeof import('@/lib/db/schema');

let documentId: string;

const MESSAGE_ID = 'dcdaa3e4-bbf9-9704-90e1-dd4ca8e631ff@ridgeline.test';

/** A Postfix-shaped bounce for a given message and status. */
function bounceFor(options: {
  messageId?: string | null;
  verp?: string | null;
  status?: string;
  action?: string;
}): { uid: number; raw: string } {
  const lines = [
    'Return-Path: <>',
    'From: MAILER-DAEMON@mail.example.com (Mail Delivery System)',
    `Delivered-To: ${options.verp ? `bounces+${options.verp}@ridgeline.test` : 'bounces@ridgeline.test'}`,
    'Subject: Undelivered Mail Returned to Sender',
    'Content-Type: multipart/report; report-type=delivery-status; boundary="XYZ"',
    '',
    '--XYZ',
    'Content-Type: message/delivery-status',
    '',
    'Final-Recipient: rfc822; ap@cardinallogistics.test',
    `Action: ${options.action ?? 'failed'}`,
    `Status: ${options.status ?? '5.1.1'}`,
    'Diagnostic-Code: smtp; 550 5.1.1 Recipient address rejected: User unknown',
    '',
    '--XYZ',
    'Content-Type: message/rfc822',
    '',
    'From: dispatch@ridgeline.test',
    ...(options.messageId === null ? [] : [`Message-ID: <${options.messageId ?? MESSAGE_ID}>`]),
    '',
    '--XYZ--',
  ];

  return { uid: Math.floor(Math.random() * 100_000), raw: lines.join('\r\n') };
}

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'openhaul-bounce-'));
  process.env.DATABASE_URL = `file:${path.join(workspace, 'test.db')}`;
  delete process.env.DATABASE_ENCRYPTION_KEY;
  process.env.BLOB_STORAGE_PATH = path.join(workspace, 'uploads');

  dbModule = await import('@/lib/db/client');
  schema = await import('@/lib/db/schema');
  await dbModule.ready();
  await applyMigrations(dbModule.rawClient);

  const { asOrgId, forOrg } = await import('@/lib/db/scope');
  bounces = await import('@/lib/documents/bounces');

  const [org] = await dbModule.db
    .insert(schema.organizations)
    .values({ legalName: 'Ridgeline Auto Transport LLC' })
    .returning();
  scoped = forOrg(asOrgId(org!.id));

  const [document] = await scoped.insert('documents', {
    kind: 'invoice',
    subject: 'invoice:fixture',
    title: 'Invoice INV-OH-1001',
    storageKey: 'fixture/invoice',
    sha256: 'a'.repeat(64),
    byteSize: 1,
    contentType: 'application/pdf',
    version: 1,
    finalizedAt: new Date(),
  });
  documentId = document!.id;
});

afterAll(async () => {
  dbModule.rawClient.close();
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
});

afterEach(() => {
  fetchUnread.mockReset();
  markSeen.mockClear();
});

/** A send as the sending path would leave it. */
async function recordSend(messageId: string | null, id?: string) {
  const [send] = await scoped.insert('documentSends', {
    ...(id ? { id } : {}),
    documentId,
    toAddresses: ['ap@cardinallogistics.test'],
    ccAddresses: null,
    subject: 'Invoice INV-OH-1001',
    body: 'Attached.',
    status: 'sent',
    messageId,
    documentSha256: 'a'.repeat(64),
    attemptedAt: new Date(),
  });
  return send!.id;
}

describe('matching a bounce to a send', () => {
  it('finds it by the returned Message-ID', async () => {
    const sendId = await recordSend(`<${MESSAGE_ID}>`);
    fetchUnread.mockResolvedValue({ ok: true, messages: [bounceFor({})] });

    const result = await bounces.checkBounces(scoped);

    expect(result.ok).toBe(true);
    expect(result.reports).toBe(1);
    expect(result.matched).toBe(1);
    expect(result.permanent).toBe(1);

    const send = await scoped.selectOne('documentSends', eq(schema.documentSends.id, sendId));
    expect(send?.status).toBe('bounced');
    expect(send?.bounceType).toBe('permanent');
    expect(send?.bounceCode).toBe('5.1.1');
    expect(send?.bounceRecipient).toBe('ap@cardinallogistics.test');
    expect(send?.bounceDiagnostic).toContain('User unknown');
  });

  it('finds it by the VERP token when no original headers came back', async () => {
    /*
     * Plenty of servers return their own prose and nothing else. The token in
     * the envelope sender is what covers those, which is the whole reason
     * sending mints the send id before the message goes out.
     */
    const sendId = 'aaaaaaaa-1111-2222-3333-444444444444';
    await recordSend(null, sendId);

    fetchUnread.mockResolvedValue({
      ok: true,
      messages: [bounceFor({ messageId: null, verp: sendId })],
    });

    const result = await bounces.checkBounces(scoped);
    expect(result.matched).toBe(1);

    const send = await scoped.selectOne('documentSends', eq(schema.documentSends.id, sendId));
    expect(send?.status).toBe('bounced');
  });

  it('leaves a send alone when a delay notice arrives', async () => {
    /*
     * The receiving server is still trying. Flipping the status here would
     * have somebody re-sending a document that is about to be delivered.
     */
    const sendId = await recordSend('<delayed@ridgeline.test>');
    fetchUnread.mockResolvedValue({
      ok: true,
      messages: [
        bounceFor({ messageId: 'delayed@ridgeline.test', status: '4.4.7', action: 'delayed' }),
      ],
    });

    const result = await bounces.checkBounces(scoped);
    expect(result.transient).toBe(1);
    expect(result.permanent).toBe(0);

    const send = await scoped.selectOne('documentSends', eq(schema.documentSends.id, sendId));
    expect(send?.status).toBe('sent');
    // Recorded, so the screen can say delivery is delayed.
    expect(send?.bounceType).toBe('transient');
    expect(send?.bounceCode).toBe('4.4.7');
  });

  it('upgrades a delayed send to bounced when the server finally gives up', async () => {
    const sendId = await recordSend('<gaveup@ridgeline.test>');

    fetchUnread.mockResolvedValue({
      ok: true,
      messages: [
        bounceFor({ messageId: 'gaveup@ridgeline.test', status: '4.4.7', action: 'delayed' }),
      ],
    });
    await bounces.checkBounces(scoped);

    fetchUnread.mockResolvedValue({
      ok: true,
      messages: [bounceFor({ messageId: 'gaveup@ridgeline.test', status: '5.4.7' })],
    });
    await bounces.checkBounces(scoped);

    const send = await scoped.selectOne('documentSends', eq(schema.documentSends.id, sendId));
    expect(send?.status).toBe('bounced');
    expect(send?.bounceCode).toBe('5.4.7');
  });

  it('does not let a later delay notice undo a hard bounce', async () => {
    const sendId = await recordSend('<hard@ridgeline.test>');

    fetchUnread.mockResolvedValue({
      ok: true,
      messages: [bounceFor({ messageId: 'hard@ridgeline.test', status: '5.1.1' })],
    });
    await bounces.checkBounces(scoped);

    fetchUnread.mockResolvedValue({
      ok: true,
      messages: [
        bounceFor({ messageId: 'hard@ridgeline.test', status: '4.4.7', action: 'delayed' }),
      ],
    });
    const second = await bounces.checkBounces(scoped);

    expect(second.matched).toBe(0);
    const send = await scoped.selectOne('documentSends', eq(schema.documentSends.id, sendId));
    expect(send?.status).toBe('bounced');
    expect(send?.bounceCode).toBe('5.1.1');
  });

  it('is idempotent, so re-reading the mailbox changes nothing', async () => {
    // Marking mail seen is best effort, so the same message will be examined
    // again sooner or later.
    const sendId = await recordSend('<twice@ridgeline.test>');
    const message = bounceFor({ messageId: 'twice@ridgeline.test' });

    fetchUnread.mockResolvedValue({ ok: true, messages: [message] });
    const first = await bounces.checkBounces(scoped);
    const second = await bounces.checkBounces(scoped);

    expect(first.matched).toBe(1);
    expect(second.matched).toBe(0);

    const send = await scoped.selectOne('documentSends', eq(schema.documentSends.id, sendId));
    expect(send?.status).toBe('bounced');
  });

  it('counts a bounce for a message it never sent without touching anything', async () => {
    fetchUnread.mockResolvedValue({
      ok: true,
      messages: [bounceFor({ messageId: 'somebody-else@example.test' })],
    });

    const result = await bounces.checkBounces(scoped);
    expect(result.reports).toBe(1);
    expect(result.matched).toBe(0);
    expect(result.unmatched).toBe(1);
  });

  it('ignores ordinary mail sitting in the same mailbox', async () => {
    fetchUnread.mockResolvedValue({
      ok: true,
      messages: [
        {
          uid: 1,
          raw: [
            'From: Renata Dowd <ap@cardinallogistics.test>',
            'Subject: Re: Invoice INV-OH-1001',
            '',
            'Paying Friday.',
          ].join('\r\n'),
        },
      ],
    });

    const result = await bounces.checkBounces(scoped);
    expect(result.examined).toBe(1);
    expect(result.reports).toBe(0);
  });

  it('marks what it read as seen rather than deleting it', async () => {
    // The operator's mailbox, not ours, and not everything in it is a bounce.
    fetchUnread.mockResolvedValue({ ok: true, messages: [bounceFor({ messageId: 'x@y.test' })] });
    await bounces.checkBounces(scoped);
    expect(markSeen).toHaveBeenCalledOnce();
  });

  it('keeps going when one message in the batch is malformed', async () => {
    const sendId = await recordSend('<survivor@ridgeline.test>');

    fetchUnread.mockResolvedValue({
      ok: true,
      messages: [
        { uid: 1, raw: '   not a message at all' },
        bounceFor({ messageId: 'survivor@ridgeline.test' }),
      ],
    });

    const result = await bounces.checkBounces(scoped);
    expect(result.matched).toBe(1);

    const send = await scoped.selectOne('documentSends', eq(schema.documentSends.id, sendId));
    expect(send?.status).toBe('bounced');
  });

  it('reports a mailbox it could not reach rather than pretending there was nothing', async () => {
    fetchUnread.mockResolvedValue({ ok: false, error: 'The mailbox could not be reached.' });

    const result = await bounces.checkBounces(scoped);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('could not be reached');
    expect(result.examined).toBe(0);
  });
});

describe('bouncedSends', () => {
  it('lists only the permanent failures', async () => {
    /*
     * A delay notice needs nothing from anybody. Putting one in front of
     * somebody as a problem trains them to ignore the list.
     */
    const bounced = await bounces.bouncedSends(scoped);
    expect(bounced.length).toBeGreaterThan(0);
    for (const send of bounced) expect(send.status).toBe('bounced');
  });
});
