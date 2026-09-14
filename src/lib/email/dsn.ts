/**
 * Reading a delivery status notification.
 *
 * When a message cannot be delivered, the receiving server sends a bounce back
 * to the envelope sender. RFC 3464 describes what that should look like — a
 * multipart/report carrying a machine-readable `message/delivery-status` part
 * and a copy of the original message — and a good proportion of real bounces
 * follow it. The rest are prose, because plenty of mail servers were written
 * before the RFC or by somebody who had not read it.
 *
 * So this parses the structured form when it is there and falls back to
 * reading the text when it is not. Both paths have to find the same two
 * things: which message came back, and whether it is coming back for good.
 *
 * The distinction that matters most is permanent against transient. A 5.x.x
 * status means the message is never arriving. A 4.x.x means the receiving
 * server is still trying and will tell you again if it gives up — treating one
 * as a bounce would have somebody re-sending a document that is about to be
 * delivered, and worse, doubting a delivery that is going to happen.
 */

export type BounceType = 'permanent' | 'transient';

export interface DeliveryReport {
  /** The Message-ID of the message that bounced, when it can be recovered. */
  originalMessageId: string | null;
  /** A VERP token from the envelope recipient, when the sender used one. */
  verpToken: string | null;
  recipient: string | null;
  /** The enhanced status code, e.g. 5.1.1. */
  status: string | null;
  type: BounceType;
  /** What the receiving server actually said. */
  diagnostic: string | null;
}

/** Splits raw headers from the body, tolerating both line ending styles. */
function splitHeaders(raw: string): { headers: string; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n');
  const separator = normalized.indexOf('\n\n');
  if (separator === -1) return { headers: normalized, body: '' };
  return {
    headers: normalized.slice(0, separator),
    body: normalized.slice(separator + 2),
  };
}

/**
 * Reads one header, joining folded continuation lines.
 *
 * Long headers are wrapped across lines with leading whitespace, and a
 * Message-ID split over two lines is still one Message-ID — missing that would
 * fail to match exactly the bounces most worth matching.
 */
function header(headers: string, name: string): string | null {
  const lines = headers.split('\n');
  const wanted = name.toLowerCase();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== wanted) continue;

    let value = line.slice(colon + 1).trim();
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? '';
      if (!/^[ \t]/.test(next)) break;
      value += ` ${next.trim()}`;
    }

    return value;
  }

  return null;
}

/** Message-IDs are written `<id@host>`; the brackets are not part of it. */
export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /<([^<>]+)>/.exec(value);
  const id = (match?.[1] ?? value).trim();
  return id.length > 0 ? id : null;
}

/**
 * Classifies an enhanced status code.
 *
 * Unknown or missing codes are treated as transient rather than permanent,
 * deliberately: wrongly calling something permanent tells somebody a document
 * never arrived when it may well have, and that is the more expensive mistake.
 */
export function classify(status: string | null): BounceType {
  if (!status) return 'transient';
  return status.trim().startsWith('5') ? 'permanent' : 'transient';
}

/** The enhanced status code, if the text contains one. */
function findStatusCode(text: string): string | null {
  const enhanced = /\b([45]\.\d{1,3}\.\d{1,3})\b/.exec(text);
  if (enhanced?.[1]) return enhanced[1];

  // Fall back to a bare SMTP reply code, mapped to its enhanced equivalent.
  const basic = /\b([45])\d{2}\b[ -]/.exec(text);
  return basic?.[1] ? `${basic[1]}.0.0` : null;
}

/**
 * Pulls a VERP token out of an address.
 *
 * Sending sets the envelope sender to `bounces+<token>@domain`, so a bounce
 * addressed back to it carries the token and identifies the send even when the
 * original headers did not survive the round trip.
 */
export function verpTokenFrom(address: string | null | undefined): string | null {
  if (!address) return null;
  const match = /\+([A-Za-z0-9_-]{6,})@/.exec(address);
  return match?.[1] ?? null;
}

/**
 * Reads a delivery status notification, however it is shaped.
 *
 * Returns null when the message does not look like a bounce at all, which is
 * most of what sits in a mailbox.
 */
export function parseDeliveryReport(raw: string): DeliveryReport | null {
  const { headers, body } = splitHeaders(raw);

  const contentType = header(headers, 'content-type') ?? '';
  const from = header(headers, 'from') ?? '';
  const subject = header(headers, 'subject') ?? '';
  const deliveredTo = header(headers, 'delivered-to') ?? header(headers, 'x-original-to') ?? '';
  const returnPath = header(headers, 'return-path') ?? '';

  const looksLikeReport =
    contentType.toLowerCase().includes('report-type=delivery-status') ||
    body.toLowerCase().includes('content-type: message/delivery-status');

  /*
   * A bounce is normally From: MAILER-DAEMON or postmaster with an empty
   * return path. Subject text is the weakest signal and only used when
   * nothing better is present, because plenty of ordinary mail says
   * "undelivered" in passing.
   */
  const looksLikeBounce =
    looksLikeReport ||
    /mailer-daemon|postmaster/i.test(from) ||
    returnPath.trim() === '<>' ||
    /^(undeliverable|undelivered|delivery status notification|returned mail|mail delivery failed)/i.test(
      subject,
    );

  if (!looksLikeBounce) return null;

  const verpToken =
    verpTokenFrom(deliveredTo) ?? verpTokenFrom(returnPath) ?? verpTokenFrom(header(headers, 'to'));

  /* --- The structured report, when there is one ------------------------- */

  const statusBlock = extractDeliveryStatus(body);

  let recipient: string | null = null;
  let status: string | null = null;
  let diagnostic: string | null = null;

  if (statusBlock) {
    const finalRecipient = header(statusBlock, 'final-recipient');
    const originalRecipient = header(statusBlock, 'original-recipient');
    recipient = stripAddressType(finalRecipient ?? originalRecipient);
    status = header(statusBlock, 'status');

    const action = header(statusBlock, 'action')?.toLowerCase();
    diagnostic = stripAddressType(header(statusBlock, 'diagnostic-code'));

    /*
     * `Action: delivered` or `relayed` in a report means this is a success or
     * progress notification, not a bounce. Reading one as a failure would mark
     * a delivered document as never arriving.
     */
    if (action === 'delivered' || action === 'relayed' || action === 'expanded') return null;
  }

  // Original headers come back in the message/rfc822 part; the Message-ID is
  // the strongest thing to match a send on.
  const originalMessageId = normalizeMessageId(
    findOriginalMessageId(body) ?? header(headers, 'in-reply-to') ?? header(headers, 'references'),
  );

  if (!status) status = findStatusCode(diagnostic ?? body);
  if (!diagnostic) diagnostic = summarise(body);
  if (!recipient) recipient = findRecipient(body);

  return {
    originalMessageId,
    verpToken,
    recipient,
    status,
    type: classify(status),
    diagnostic,
  };
}

/** The `message/delivery-status` part, which is a block of its own headers. */
function extractDeliveryStatus(body: string): string | null {
  const marker = /content-type:\s*message\/delivery-status/i.exec(body);
  if (!marker) return null;

  const after = body.slice(marker.index + marker[0].length);
  const start = after.indexOf('\n\n');
  if (start === -1) return null;

  const block = after.slice(start + 2);
  // Ends at the next MIME boundary.
  const end = block.search(/\n--/);
  return end === -1 ? block : block.slice(0, end);
}

/** Finds the bounced message's own Message-ID in the returned copy. */
function findOriginalMessageId(body: string): string | null {
  const returned = /content-type:\s*(?:message\/rfc822|text\/rfc822-headers)/i.exec(body);
  const search = returned ? body.slice(returned.index) : body;

  const match = /^\s*message-id:\s*(<[^>]+>)/im.exec(search);
  if (match?.[1]) return match[1];

  // Some servers return only a handful of headers with no content type at all.
  const anywhere = /message-id:\s*(<[^>]+>)/i.exec(body);
  return anywhere?.[1] ?? null;
}

/** `rfc822; someone@example.com` — the type prefix is not part of the value. */
function stripAddressType(value: string | null): string | null {
  if (!value) return null;
  const semicolon = value.indexOf(';');
  const stripped = semicolon === -1 ? value : value.slice(semicolon + 1);
  return stripped.trim() || null;
}

function findRecipient(body: string): string | null {
  const match = /<([^<>@\s]+@[^<>\s]+)>/.exec(body);
  return match?.[1] ?? null;
}

/**
 * A short, readable reason from a prose bounce.
 *
 * Picks the line carrying the status code where possible, since that is the
 * one a person would quote back to the recipient's IT department.
 */
function summarise(body: string): string | null {
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('--'));

  const withCode = lines.find((line) => /\b[45]\.\d{1,3}\.\d{1,3}\b/.test(line));
  if (withCode) return withCode.slice(0, 500);

  const reason = lines.find((line) =>
    /(unknown|does not exist|no such|rejected|refused|mailbox full|over quota|blocked|not found)/i.test(
      line,
    ),
  );

  return reason ? reason.slice(0, 500) : null;
}

/**
 * A plain-English explanation of an enhanced status code.
 *
 * Shown next to the code because "5.1.1" means nothing to a dispatcher, and
 * the difference between "that address does not exist" and "their mailbox is
 * full" decides whether to fix the record or just try again tomorrow.
 */
export function explainStatus(status: string | null, type: BounceType): string {
  const code = status?.trim() ?? '';

  if (code.startsWith('5.1.1') || code.startsWith('5.1.0')) {
    return 'That address does not exist. Check it against their records before trying again.';
  }
  if (code.startsWith('5.1.2')) return 'That domain does not exist. The address is probably mistyped.';
  if (code.startsWith('5.2.2') || code.startsWith('4.2.2')) {
    return 'Their mailbox is full.';
  }
  if (code.startsWith('5.7')) {
    return 'The receiving server refused it on policy grounds — spam filtering, or sender checks it did not like.';
  }
  if (code.startsWith('4.4') || code.startsWith('4.2') || code.startsWith('4.3')) {
    return 'The receiving server is having trouble and is still trying. Nothing to do yet.';
  }
  if (code.startsWith('5.3')) return 'The message was too large for their mailbox.';

  return type === 'permanent'
    ? 'The receiving server refused it permanently.'
    : 'A temporary problem. The sending server is still trying.';
}
