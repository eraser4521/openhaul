import { describe, expect, it } from 'vitest';
import {
  classify,
  explainStatus,
  normalizeMessageId,
  parseDeliveryReport,
  verpTokenFrom,
} from '@/lib/email/dsn';

/**
 * Bounce parsing, against the shapes real mail servers produce.
 *
 * The fixtures below are modelled on what Postfix, Exchange and Google
 * actually send, including the ones that ignore RFC 3464 and just write prose.
 * The two things every case has to get right are which message came back and
 * whether it is coming back for good.
 */

/** Postfix, by the book: multipart/report with a delivery-status part. */
const POSTFIX_HARD = [
  'Return-Path: <>',
  'From: MAILER-DAEMON@mail.example.com (Mail Delivery System)',
  'To: bounces+snd_01a09e2d@ridgeline.test',
  'Delivered-To: bounces+snd_01a09e2d@ridgeline.test',
  'Subject: Undelivered Mail Returned to Sender',
  'Content-Type: multipart/report; report-type=delivery-status; boundary="XYZ"',
  '',
  '--XYZ',
  'Content-Type: text/plain; charset=us-ascii',
  '',
  'This is the mail system at host mail.example.com.',
  '',
  'I\'m sorry to have to inform you that your message could not be delivered.',
  '',
  '--XYZ',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns; mail.example.com',
  '',
  'Final-Recipient: rfc822; ap@cardinallogistics.test',
  'Original-Recipient: rfc822;ap@cardinallogistics.test',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 <ap@cardinallogistics.test>: Recipient address rejected: User unknown',
  '',
  '--XYZ',
  'Content-Type: message/rfc822',
  '',
  'From: dispatch@ridgeline.test',
  'To: ap@cardinallogistics.test',
  'Subject: Invoice INV-OH-1001',
  'Message-ID: <dcdaa3e4-bbf9-9704-90e1-dd4ca8e631ff@ridgeline.test>',
  '',
  '--XYZ--',
].join('\r\n');

/** The same server saying it is still trying. */
const POSTFIX_SOFT = POSTFIX_HARD.replace('Status: 5.1.1', 'Status: 4.4.7')
  .replace('Action: failed', 'Action: delayed')
  .replace(
    'Diagnostic-Code: smtp; 550 5.1.1 <ap@cardinallogistics.test>: Recipient address rejected: User unknown',
    'Diagnostic-Code: smtp; 451 4.4.7 Delivery time expired',
  );

/** A prose bounce with no structured part at all. */
const PLAIN_TEXT_BOUNCE = [
  'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
  'To: dispatch@ridgeline.test',
  'Subject: Delivery Status Notification (Failure)',
  'Content-Type: text/plain; charset=UTF-8',
  '',
  'Your message was not delivered to claims@desertmotors.test because the',
  'address could not be found, or is unable to receive mail.',
  '',
  'The response was:',
  '550 5.1.1 The email account that you tried to reach does not exist.',
  '',
  '----- Original message -----',
  'Message-ID: <7b1c5f00-1111-2222-3333-444455556666@ridgeline.test>',
  'Subject: Acknowledgement of claim CLM-2026-0001',
].join('\r\n');

/** A successful delivery notification, which is not a bounce. */
const DELIVERY_RECEIPT = POSTFIX_HARD.replace('Action: failed', 'Action: delivered').replace(
  'Status: 5.1.1',
  'Status: 2.0.0',
);

/** An ordinary reply that happens to mention the word undelivered. */
const NOT_A_BOUNCE = [
  'From: Renata Dowd <ap@cardinallogistics.test>',
  'To: dispatch@ridgeline.test',
  'Subject: Re: Invoice INV-OH-1001',
  'Message-ID: <reply-1@cardinallogistics.test>',
  '',
  'Thanks — we had one undelivered last month but this one is fine. Paying Friday.',
].join('\r\n');

describe('parseDeliveryReport, on a standards-compliant bounce', () => {
  const report = parseDeliveryReport(POSTFIX_HARD);

  it('recognises it as a bounce', () => {
    expect(report).not.toBeNull();
  });

  it('recovers the Message-ID of the message that came back', () => {
    // The strongest thing to match a send on, and the reason the original
    // headers are worth digging out of the returned copy.
    expect(report?.originalMessageId).toBe('dcdaa3e4-bbf9-9704-90e1-dd4ca8e631ff@ridgeline.test');
  });

  it('reads the recipient without the address-type prefix', () => {
    expect(report?.recipient).toBe('ap@cardinallogistics.test');
  });

  it('reads the status and calls it permanent', () => {
    expect(report?.status).toBe('5.1.1');
    expect(report?.type).toBe('permanent');
  });

  it('keeps what the server actually said', () => {
    expect(report?.diagnostic).toContain('User unknown');
  });

  it('picks up the VERP token from the envelope recipient', () => {
    expect(report?.verpToken).toBe('snd_01a09e2d');
  });
});

describe('parseDeliveryReport, on a delay notice', () => {
  const report = parseDeliveryReport(POSTFIX_SOFT);

  it('calls it transient, not a bounce', () => {
    /*
     * The receiving server is still trying. Marking this as a bounce would
     * have somebody re-sending a document that is about to be delivered, and
     * doubting a delivery that is going to happen.
     */
    expect(report?.type).toBe('transient');
    expect(report?.status).toBe('4.4.7');
  });

  it('still identifies which message it concerns', () => {
    expect(report?.originalMessageId).toBe('dcdaa3e4-bbf9-9704-90e1-dd4ca8e631ff@ridgeline.test');
  });
});

describe('parseDeliveryReport, on a prose bounce', () => {
  const report = parseDeliveryReport(PLAIN_TEXT_BOUNCE);

  it('recognises one with no structured part', () => {
    // Plenty of servers predate the RFC or ignore it.
    expect(report).not.toBeNull();
    expect(report?.type).toBe('permanent');
  });

  it('finds the status code in the text', () => {
    expect(report?.status).toBe('5.1.1');
  });

  it('finds the original Message-ID in the quoted copy', () => {
    expect(report?.originalMessageId).toBe('7b1c5f00-1111-2222-3333-444455556666@ridgeline.test');
  });

  it('summarises a reason worth showing somebody', () => {
    expect(report?.diagnostic).toContain('does not exist');
  });
});

describe('parseDeliveryReport, on what is not a bounce', () => {
  it('ignores a successful delivery notification', () => {
    /*
     * A report with Action: delivered is the opposite of a bounce. Reading one
     * as a failure would mark a delivered document as never having arrived.
     */
    expect(parseDeliveryReport(DELIVERY_RECEIPT)).toBeNull();
  });

  it('ignores an ordinary reply that mentions the word', () => {
    expect(parseDeliveryReport(NOT_A_BOUNCE)).toBeNull();
  });

  it('ignores an empty message', () => {
    expect(parseDeliveryReport('')).toBeNull();
  });

  it('does not fall over on something that is not a message at all', () => {
    expect(parseDeliveryReport('not a message')).toBeNull();
  });
});

describe('parseDeliveryReport, on awkward real-world shapes', () => {
  it('joins a Message-ID folded across two lines', () => {
    // Long headers wrap with leading whitespace, and a split Message-ID is
    // still one Message-ID.
    const folded = POSTFIX_HARD.replace(
      'Message-ID: <dcdaa3e4-bbf9-9704-90e1-dd4ca8e631ff@ridgeline.test>',
      'Message-ID:\r\n <dcdaa3e4-bbf9-9704-90e1-dd4ca8e631ff@ridgeline.test>',
    );
    expect(parseDeliveryReport(folded)?.originalMessageId).toBe(
      'dcdaa3e4-bbf9-9704-90e1-dd4ca8e631ff@ridgeline.test',
    );
  });

  it('reads a message using bare newlines', () => {
    expect(parseDeliveryReport(POSTFIX_HARD.replace(/\r\n/g, '\n'))?.status).toBe('5.1.1');
  });

  it('copes with a report carrying no status code', () => {
    const noStatus = POSTFIX_HARD.replace('Status: 5.1.1\r\n', '').replace(
      'Diagnostic-Code: smtp; 550 5.1.1 <ap@cardinallogistics.test>: Recipient address rejected: User unknown',
      'Diagnostic-Code: smtp; mailbox unavailable',
    );

    const report = parseDeliveryReport(noStatus);
    expect(report).not.toBeNull();
    // Unknown is treated as transient: wrongly calling something permanent
    // tells somebody a document never arrived when it may well have.
    expect(report?.type).toBe('transient');
  });

  it('recognises a bounce by an empty return path alone', () => {
    const minimal = [
      'Return-Path: <>',
      'From: some-relay@example.com',
      'To: dispatch@ridgeline.test',
      'Subject: mail problem',
      '',
      '550 5.1.1 user unknown',
      'Message-ID: <abc@ridgeline.test>',
    ].join('\r\n');

    expect(parseDeliveryReport(minimal)?.type).toBe('permanent');
  });
});

/* -------------------------------------------------------------------------
 * The pieces
 * ---------------------------------------------------------------------- */

describe('classify', () => {
  it('treats 5.x.x as permanent', () => {
    expect(classify('5.1.1')).toBe('permanent');
    expect(classify('5.7.1')).toBe('permanent');
  });

  it('treats 4.x.x as transient', () => {
    expect(classify('4.4.7')).toBe('transient');
  });

  it('treats an unknown code as transient rather than permanent', () => {
    // The cheaper mistake of the two.
    expect(classify(null)).toBe('transient');
    expect(classify('')).toBe('transient');
    expect(classify('nonsense')).toBe('transient');
  });
});

describe('normalizeMessageId', () => {
  it('strips the angle brackets', () => {
    expect(normalizeMessageId('<abc@example.test>')).toBe('abc@example.test');
  });

  it('accepts one without brackets', () => {
    expect(normalizeMessageId('abc@example.test')).toBe('abc@example.test');
  });

  it('is null for nothing', () => {
    expect(normalizeMessageId(null)).toBeNull();
    expect(normalizeMessageId('  ')).toBeNull();
  });
});

describe('verpTokenFrom', () => {
  it('reads the token out of a plus-addressed envelope recipient', () => {
    expect(verpTokenFrom('bounces+snd_01a09e2d@ridgeline.test')).toBe('snd_01a09e2d');
  });

  it('is null for an ordinary address', () => {
    expect(verpTokenFrom('dispatch@ridgeline.test')).toBeNull();
    expect(verpTokenFrom(null)).toBeNull();
  });

  it('ignores a plus tag too short to be one of ours', () => {
    expect(verpTokenFrom('sales+x@ridgeline.test')).toBeNull();
  });
});

describe('explainStatus', () => {
  it('says plainly that an address does not exist', () => {
    // "5.1.1" means nothing to a dispatcher.
    expect(explainStatus('5.1.1', 'permanent')).toContain('does not exist');
  });

  it('separates a full mailbox from a wrong address', () => {
    expect(explainStatus('5.2.2', 'permanent')).toContain('mailbox is full');
  });

  it('names a policy rejection as spam filtering rather than a bad address', () => {
    expect(explainStatus('5.7.1', 'permanent')).toContain('policy');
  });

  it('tells somebody a transient problem needs nothing from them', () => {
    expect(explainStatus('4.4.7', 'transient')).toContain('Nothing to do yet');
  });

  it('still says something useful for an unknown code', () => {
    expect(explainStatus(null, 'permanent')).toContain('refused it permanently');
    expect(explainStatus(null, 'transient')).toContain('still trying');
  });
});
