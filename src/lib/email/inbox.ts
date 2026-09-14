import 'server-only';
import { ImapFlow } from 'imapflow';

/**
 * Reading bounces back out of a mailbox.
 *
 * There is no webhook to subscribe to when you send over plain SMTP, so the
 * only way to learn that a message failed downstream is to look in the mailbox
 * the failure was returned to. That is a poll, not a stream: it runs when
 * somebody presses the button or when a cron line hits the endpoint.
 *
 * Messages that have been examined are marked seen rather than deleted. This
 * is the operator's mailbox, not ours, and silently destroying mail in it
 * would be an unpleasant surprise — particularly since some of what lands
 * there will not be a bounce at all.
 */

export interface InboxConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  mailbox: string;
}

/**
 * Reads the IMAP settings.
 *
 * Credentials fall back to the SMTP ones, because for most operators it is the
 * same mailbox and asking them to write the same password twice invites one of
 * the two going stale.
 */
export function inboxConfig(): InboxConfig | null {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER ?? process.env.SMTP_USER;
  const pass = process.env.IMAP_PASSWORD ?? process.env.SMTP_PASSWORD;

  if (!host || !user || !pass) return null;

  const port = Number.parseInt(process.env.IMAP_PORT ?? '993', 10);

  return {
    host,
    port: Number.isFinite(port) ? port : 993,
    // 993 is implicit TLS, which is what almost everyone uses for IMAP.
    secure: process.env.IMAP_SECURE ? process.env.IMAP_SECURE === 'true' : port !== 143,
    user,
    pass,
    mailbox: process.env.IMAP_MAILBOX ?? 'INBOX',
  };
}

export function inboxConfigured(): boolean {
  return inboxConfig() !== null;
}

export interface FetchedMessage {
  uid: number;
  raw: string;
}

export type FetchOutcome =
  | { ok: true; messages: FetchedMessage[] }
  | { ok: false; error: string };

/**
 * Fetches unread messages from the bounce mailbox.
 *
 * Capped rather than unbounded: a mailbox nobody has checked in a year should
 * not turn one button press into a ten-minute request, and the next run picks
 * up where this one stopped.
 */
export async function fetchUnread(limit = 200): Promise<FetchOutcome> {
  const config = inboxConfig();
  if (!config) {
    return {
      ok: false,
      error: 'No bounce mailbox is configured. Set IMAP_HOST to check for bounces.',
    };
  }

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  });

  try {
    await client.connect();
  } catch (error) {
    return { ok: false, error: describeImapError(error) };
  }

  // Typed explicitly so the compiler can see it is definitely assigned by the
  // time the finally block releases it — the catch below returns.
  let lock: { release: () => void };
  try {
    lock = await client.getMailboxLock(config.mailbox);
  } catch (error) {
    await client.logout().catch(() => {});
    return {
      ok: false,
      error: `Could not open the mailbox "${config.mailbox}". ${describeImapError(error)}`,
    };
  }

  const messages: FetchedMessage[] = [];

  try {
    // search() answers false when the mailbox is empty rather than an array.
    const unseen = await client.search({ seen: false });
    const uids = (Array.isArray(unseen) ? unseen : []).slice(-limit);

    for (const uid of uids) {
      const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (message && message.source) {
        messages.push({ uid, raw: message.source.toString('utf8') });
      }
    }

    return { ok: true, messages };
  } catch (error) {
    return { ok: false, error: describeImapError(error) };
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

/**
 * Marks messages as read once they have been looked at.
 *
 * Seen rather than deleted, deliberately: this is the operator's mailbox and
 * some of what arrives in it will not be a bounce at all.
 */
export async function markSeen(uids: number[]): Promise<void> {
  if (uids.length === 0) return;

  const config = inboxConfig();
  if (!config) return;

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock(config.mailbox);
    try {
      await client.messageFlagsAdd(uids.map(String).join(','), ['\\Seen'], { uid: true });
    } finally {
      lock.release();
    }
  } catch {
    /*
     * Swallowed on purpose. Failing to mark a message read means it is examined
     * again next time, which is harmless — matching is idempotent. Failing the
     * whole check over it would not be.
     */
  } finally {
    await client.logout().catch(() => {});
  }
}

export function describeImapError(error: unknown): string {
  if (!(error instanceof Error)) return 'The mailbox could not be reached.';

  const message = error.message ?? '';

  if (/authenticat|invalid credentials|login failed/i.test(message)) {
    return 'The mail server rejected the credentials. Check IMAP_USER and IMAP_PASSWORD.';
  }
  if (message.includes('ECONNREFUSED')) {
    return 'Nothing is listening on that host and port. Check IMAP_HOST and IMAP_PORT.';
  }
  if (message.includes('ENOTFOUND')) {
    return 'That hostname does not resolve. Check IMAP_HOST.';
  }
  if (/does not exist|NONEXISTENT/i.test(message)) {
    return 'That mailbox does not exist on the server. Check IMAP_MAILBOX.';
  }
  if (message.includes('ETIMEDOUT') || /timed? ?out/i.test(message)) {
    return 'The connection to the mailbox timed out.';
  }

  return message;
}

/** Tests the settings without processing anything. */
export async function verifyInbox(): Promise<{ ok: boolean; error?: string }> {
  const config = inboxConfig();
  if (!config) return { ok: false, error: 'No bounce mailbox is configured.' };

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock(config.mailbox);
    lock.release();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeImapError(error) };
  } finally {
    await client.logout().catch(() => {});
  }
}
