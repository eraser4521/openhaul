import 'server-only';
import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Outgoing mail over SMTP.
 *
 * SMTP rather than a vendor API on purpose. Every operator running this
 * already has a mailbox somewhere, and SMTP works with all of them — their own
 * server, their hosting provider, Google, Fastmail, an SES endpoint — with no
 * account to open and nothing to pay. A vendor SDK would be less code here and
 * a subscription for them, which is the thing this project exists to avoid.
 *
 * The most important thing in this file is what `send` does NOT claim. A 250
 * from the server means it accepted the message for delivery. It does not mean
 * the recipient got it, and it certainly does not mean they read it. That gap
 * matters: a carrier who believes "Sent ✓" is proof of delivery will rely on it
 * in a dispute about whether a claim letter went out on time, and be wrong. So
 * nothing here reports delivery, and no open tracking is attempted — which
 * would be both misleading and a pixel in somebody else's inbox.
 */

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string | undefined;
  pass?: string | undefined;
  from: string;
  replyTo?: string | undefined;
}

/**
 * Reads the SMTP settings from the environment.
 *
 * Returns null when nothing is configured, which is a supported state: the app
 * renders documents perfectly well without being able to send them, and says
 * so rather than failing at the moment somebody needs one.
 */
export function mailConfig(): MailConfig | null {
  const host = process.env.SMTP_HOST;
  const from = process.env.SMTP_FROM;

  if (!host || !from) return null;

  const port = Number.parseInt(process.env.SMTP_PORT ?? '587', 10);

  return {
    host,
    port: Number.isFinite(port) ? port : 587,
    /*
     * Implicit TLS on 465, STARTTLS everywhere else. Getting this backwards is
     * the single most common SMTP misconfiguration and produces a timeout
     * rather than a useful error, so it is derived from the port instead of
     * being another setting to get wrong.
     */
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
    from,
    replyTo: process.env.SMTP_REPLY_TO,
  };
}

export function mailConfigured(): boolean {
  return mailConfig() !== null;
}

let cached: Transporter | null = null;
let cachedFor: string | null = null;

function transporter(config: MailConfig): Transporter {
  const key = `${config.host}:${config.port}:${config.secure}:${config.user ?? ''}`;
  if (cached && cachedFor === key) return cached;

  cached = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
    // A dispatcher waiting on a page load is not going to wait a minute for a
    // mail server that is not answering.
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  cachedFor = key;

  return cached;
}

export interface Attachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface SendRequest {
  to: string[];
  cc?: string[];
  subject: string;
  /** Plain text only. No HTML, so nothing to inject and nothing to track. */
  text: string;
  attachments?: Attachment[];
}

export type SendOutcome =
  | { ok: true; messageId: string; accepted: string[]; rejected: string[] }
  | { ok: false; error: string };

/**
 * Hands a message to the configured mail server.
 *
 * Succeeding means the server took it. Anything after that — queuing,
 * greylisting, a bounce an hour later, a spam folder — happens where this
 * application cannot see it.
 */
export async function send(request: SendRequest): Promise<SendOutcome> {
  const config = mailConfig();
  if (!config) {
    return {
      ok: false,
      error: 'No mail server is configured. Set SMTP_HOST and SMTP_FROM to send documents.',
    };
  }

  if (request.to.length === 0) {
    return { ok: false, error: 'No recipient.' };
  }

  try {
    const info = await transporter(config).sendMail({
      from: config.from,
      replyTo: config.replyTo,
      to: request.to,
      cc: request.cc?.length ? request.cc : undefined,
      subject: request.subject,
      text: request.text,
      attachments: request.attachments,
    });

    const accepted = (info.accepted ?? []).map(String);
    const rejected = (info.rejected ?? []).map(String);

    /*
     * A server can accept a message while refusing some of its recipients.
     * Reporting that as a clean success would tell somebody their claim letter
     * reached a claimant it never went to.
     */
    if (accepted.length === 0) {
      return {
        ok: false,
        error: `The mail server rejected every recipient: ${rejected.join(', ') || 'no reason given'}.`,
      };
    }

    return { ok: true, messageId: info.messageId ?? '', accepted, rejected };
  } catch (error) {
    return { ok: false, error: describeSmtpError(error) };
  }
}

/**
 * Turns an SMTP failure into something an operator can act on.
 *
 * Exported and pure so the mapping can be tested against the shapes nodemailer
 * actually produces, which are not the ones the code names suggest. A refused
 * connection arrives as `ESOCKET` with `ECONNREFUSED` only in the message —
 * so matching on the top-level code alone sends somebody whose mail server is
 * simply down off to check their TLS port.
 */
export function describeSmtpError(error: unknown): string {
  if (!(error instanceof Error)) return 'The mail server could not be reached.';

  const code = (error as { code?: string }).code;
  const response = (error as { response?: string }).response;
  const message = error.message ?? '';

  if (code === 'EAUTH') {
    return `The mail server rejected the credentials in SMTP_USER and SMTP_PASSWORD. ${response ?? ''}`.trim();
  }

  if (code === 'EENVELOPE') {
    return `The mail server refused the addresses. ${response ?? ''}`.trim();
  }

  // The underlying cause is in the message, whatever the outer code says.
  if (message.includes('ECONNREFUSED')) {
    return 'Nothing is listening on that host and port. Check SMTP_HOST and SMTP_PORT, and that the server is running.';
  }

  if (message.includes('ENOTFOUND') || message.includes('EAI_AGAIN')) {
    return 'That hostname does not resolve. Check SMTP_HOST.';
  }

  if (message.includes('ECONNRESET')) {
    return (
      'The mail server closed the connection. This usually means a TLS mismatch: on port 465 ' +
      'SMTP_SECURE must be true, and on 587 it must be false.'
    );
  }

  if (
    message.includes('wrong version number') ||
    message.includes('SSL') ||
    message.includes('routines:')
  ) {
    return (
      'The TLS handshake failed. On port 465 SMTP_SECURE must be true; on 587 it must be false ' +
      'so the connection can upgrade with STARTTLS.'
    );
  }

  if (code === 'ETIMEDOUT' || message.includes('ETIMEDOUT') || message.includes('timeout')) {
    return 'The connection to the mail server timed out. Check SMTP_HOST and SMTP_PORT, and that a firewall is not blocking it.';
  }

  return response ? `${error.message} — ${response}` : error.message;
}

/**
 * Checks the settings without sending anything.
 *
 * Worth having on its own: SMTP misconfiguration surfaces as a failure at the
 * worst moment otherwise, which is the day somebody is trying to get a
 * delivery receipt to a broker.
 */
export async function verifyConnection(): Promise<{ ok: boolean; error?: string }> {
  const config = mailConfig();
  if (!config) {
    return { ok: false, error: 'No mail server is configured.' };
  }

  try {
    await transporter(config).verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeSmtpError(error) };
  }
}

/** Dropped between tests and after a settings change. */
export function resetTransport(): void {
  cached = null;
  cachedFor = null;
}
