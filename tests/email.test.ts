import { describe, expect, it } from 'vitest';
import {
  attachmentName,
  compose,
  looksLikeEmail,
  parseAddresses,
  type ComposeContext,
} from '@/lib/email/compose';
import { describeSmtpError } from '@/lib/email/transport';

/**
 * The covering email is short, so what these tests care about is that it says
 * the one thing the recipient needs before opening the attachment — and that
 * it never says something the document contradicts.
 */

function context(overrides: Partial<ComposeContext> = {}): ComposeContext {
  return {
    carrierName: 'Ridgeline Auto Transport LLC',
    reference: 'INV-OH-1001',
    loadNumber: 'OH-1001',
    recipientName: 'Renata Dowd',
    ...overrides,
  };
}

describe('compose, for a bill of lading', () => {
  it('names the document and the load in the subject', () => {
    const message = compose('bol', context({ reference: 'BOL-OH-1001' }));
    expect(message.subject).toBe('Bill of lading BOL-OH-1001 — load OH-1001');
  });

  it('asks the recipient to check the condition report', () => {
    // The point of sending it: a disagreement is cheap now and expensive later.
    const message = compose('bol', context({ reference: 'BOL-OH-1001' }));
    expect(message.body).toContain('condition report');
    expect(message.body).toContain('Ridgeline Auto Transport LLC');
  });

  it('drops the load reference when there is not one', () => {
    const message = compose('bol', context({ reference: 'BOL-1', loadNumber: null }));
    expect(message.subject).toBe('Bill of lading BOL-1');
    expect(message.body).not.toContain('for load');
  });
});

describe('compose, for a delivery receipt', () => {
  it('warns that unnoted damage may not be recoverable', () => {
    const message = compose('pod', context({ reference: 'POD-OH-1001' }));
    expect(message.subject).toContain('Delivery receipt POD-OH-1001');
    expect(message.body).toContain('may not be recoverable');
  });
});

describe('compose, for an invoice', () => {
  it('puts the amount and the due date in the subject', () => {
    /*
     * An accounts department sorting fifty emails should be able to work from
     * the list view without opening anything.
     */
    const message = compose(
      'invoice',
      context({ amountCents: 347_500, dueDate: 'October 14, 2026' }),
    );

    expect(message.subject).toBe('Invoice INV-OH-1001 — $3,475.00, due October 14, 2026');
  });

  it('mentions the sealed paperwork the invoice cites', () => {
    const message = compose('invoice', context({ amountCents: 347_500 }));
    expect(message.body).toContain('bill of lading and delivery receipt');
    expect(message.body).toContain('hash');
  });

  it('redirects payment when the invoice is factored', () => {
    // Getting this wrong costs the carrier the money twice over.
    const message = compose(
      'invoice',
      context({ amountCents: 347_500, factoringCompanyName: 'Apex Capital' }),
    );

    expect(message.body).toContain('assigned to Apex Capital');
    expect(message.body).toContain('not to us');
  });

  it('says nothing about assignment when there is none', () => {
    const message = compose('invoice', context({ amountCents: 347_500 }));
    expect(message.body).not.toContain('assigned');
  });

  it('copes with an invoice carrying no amount', () => {
    const message = compose('invoice', context({ amountCents: null, dueDate: null }));
    expect(message.subject).toBe('Invoice INV-OH-1001');
  });
});

describe('compose, for a credit note', () => {
  const credit = context({ reference: 'CN-INV-OH-1001', amountCents: 27_500 });

  it('says immediately that nothing is payable on it', () => {
    /*
     * The same failure the document itself guards against: a credit processed
     * as a bill gets paid, and the customer then chases a payment nobody owed.
     */
    const message = compose('credit_note', credit);
    expect(message.body).toContain('not a bill');
    expect(message.body).toContain('nothing is payable');
  });

  it('states the balance the credit leaves', () => {
    const message = compose('credit_note', { ...credit, balanceCents: 320_000 });
    expect(message.body).toContain('$3,200.00');
  });

  it('asks how a refund should be settled', () => {
    const message = compose('credit_note', { ...credit, balanceCents: -27_500 });
    expect(message.body).toContain('$275.00 owing back to you');
    expect(message.body).toContain('refunded');
  });

  it('says the invoice is settled when the credit clears it', () => {
    const message = compose('credit_note', { ...credit, balanceCents: 0 });
    expect(message.body).toContain('settles the invoice in full');
  });

  it('asks for it to be applied rather than paid', () => {
    expect(compose('credit_note', credit).body).toContain('applied rather than paid');
  });
});

describe('compose, for claim letters', () => {
  const claim = context({ reference: 'CLM-2026-0001', claimNumber: 'CLM-2026-0001' });

  it('acknowledges receipt and asks for the number to be quoted', () => {
    const message = compose('claim_acknowledgement', claim);
    expect(message.subject).toBe('Acknowledgement of claim CLM-2026-0001');
    expect(message.body).toContain('quote that number');
  });

  it('says a status letter means the claim is still open', () => {
    const message = compose('claim_status', claim);
    expect(message.subject).toContain('status update');
    expect(message.body).toContain('still open');
  });

  it('points a disposition at the time limits on the letter', () => {
    // The date on that letter starts the claimant's two-year window.
    const message = compose('claim_disposition', claim);
    expect(message.subject).toContain('our decision');
    expect(message.body).toContain('time limits');
    expect(message.body).toContain('Please read it');
  });

  it('falls back to the document reference when the claim number is missing', () => {
    const message = compose('claim_acknowledgement', context({ reference: 'CLM-X', claimNumber: null }));
    expect(message.subject).toContain('CLM-X');
  });
});

describe('compose, for a settlement statement', () => {
  it('carries the period and the net pay in the subject', () => {
    const message = compose(
      'settlement',
      context({
        reference: 'STL-MW-20260914',
        periodLabel: 'Sep 1 to Sep 14',
        netPayCents: 177_420,
        recipientName: 'Marcus Webb',
      }),
    );

    expect(message.subject).toBe('Settlement STL-MW-20260914 — Sep 1 to Sep 14 — $1,774.20');
    expect(message.body).toContain('Marcus Webb,');
  });

  it('tells the driver to raise a wrong line before it is paid', () => {
    const message = compose('settlement', context({ reference: 'STL-1', netPayCents: 1_000 }));
    expect(message.body).toContain('before it is paid');
  });
});

describe('compose, generally', () => {
  it('greets an unknown recipient without inventing a name', () => {
    const message = compose('invoice', context({ recipientName: null }));
    expect(message.body.startsWith('Hello,')).toBe(true);
  });

  it('signs off as the carrier every time', () => {
    for (const kind of [
      'bol',
      'pod',
      'invoice',
      'credit_note',
      'claim_acknowledgement',
      'claim_status',
      'claim_disposition',
      'settlement',
    ] as const) {
      expect(compose(kind, context()).body).toContain('Ridgeline Auto Transport LLC');
      expect(compose(kind, context()).subject.length).toBeGreaterThan(5);
    }
  });

  it('still produces something usable for a document kind with no template', () => {
    const message = compose('gate_pass', context({ reference: 'GP-1' }));
    expect(message.subject).toContain('GP-1');
    expect(message.body).toContain('attached');
  });
});

/* -------------------------------------------------------------------------
 * Addresses and attachments
 * ---------------------------------------------------------------------- */

describe('parseAddresses', () => {
  it('splits on commas, semicolons and whitespace', () => {
    expect(parseAddresses('a@x.test, b@x.test; c@x.test  d@x.test')).toEqual([
      'a@x.test',
      'b@x.test',
      'c@x.test',
      'd@x.test',
    ]);
  });

  it('is empty for an empty field', () => {
    expect(parseAddresses('   ')).toEqual([]);
  });
});

describe('looksLikeEmail', () => {
  it('accepts ordinary addresses', () => {
    expect(looksLikeEmail('ap@cardinallogistics.test')).toBe(true);
    expect(looksLikeEmail('claims+cargo@example.co.uk')).toBe(true);
  });

  it('rejects what is obviously a typo', () => {
    expect(looksLikeEmail('ap@cardinallogistics')).toBe(false);
    expect(looksLikeEmail('apcardinallogistics.test')).toBe(false);
    expect(looksLikeEmail('@example.test')).toBe(false);
    expect(looksLikeEmail('ap@')).toBe(false);
    expect(looksLikeEmail('ap@.test')).toBe(false);
    expect(looksLikeEmail('two addresses@x.test')).toBe(false);
  });

  it('does not try to out-parse the mail server', () => {
    /*
     * Permissive on everything except whitespace. The server is the authority
     * on whether an address exists, and rejecting ordinary ones here is worse
     * than letting a doomed one through.
     */
    expect(looksLikeEmail('a@sub.domain.example.test')).toBe(true);
    expect(looksLikeEmail('dispatch@ridgeline-auto-transport.example')).toBe(true);
    expect(looksLikeEmail("o'brien@example.test")).toBe(true);
  });

  it('rejects a quoted local part, which the whitespace rule rules out', () => {
    // RFC 5321 allows it; callers split on whitespace first, so anything still
    // containing a space is a second address pasted in rather than a mailbox.
    expect(looksLikeEmail('"odd name"@example.test')).toBe(false);
  });
});

describe('attachmentName', () => {
  it('makes a filename somebody can save without renaming', () => {
    expect(attachmentName('Invoice INV-OH-1001', 'INV-OH-1001')).toBe('Invoice-INV-OH-1001.pdf');
  });

  it('strips characters a filesystem would refuse', () => {
    expect(attachmentName('Bill of lading BOL/OH:1001', 'BOL')).toBe('Bill-of-lading-BOL-OH-1001.pdf');
  });

  it('falls back to the reference when the title is blank', () => {
    expect(attachmentName('   ', 'CN-INV-OH-1001')).toBe('CN-INV-OH-1001.pdf');
  });
});

/* -------------------------------------------------------------------------
 * SMTP failures
 * ---------------------------------------------------------------------- */

describe('describeSmtpError', () => {
  /** The shapes nodemailer actually produces, not the ones the codes suggest. */
  function smtpError(code: string, message: string, response?: string): Error {
    return Object.assign(new Error(message), { code, response });
  }

  it('names a refused connection instead of blaming TLS', () => {
    /*
     * Verified against nodemailer: a refused connection arrives as ESOCKET
     * with ECONNREFUSED only in the message. Matching on the outer code alone
     * sent somebody whose mail server was simply down off to check their port.
     */
    const message = describeSmtpError(
      smtpError('ESOCKET', 'connect ECONNREFUSED 127.0.0.1:2525'),
    );

    expect(message).toContain('Nothing is listening');
    expect(message).not.toContain('SMTP_SECURE');
  });

  it('names a hostname that does not resolve', () => {
    expect(describeSmtpError(smtpError('ESOCKET', 'getaddrinfo ENOTFOUND smtp.exmaple.com'))).toContain(
      'does not resolve',
    );
  });

  it('points a TLS mismatch at the port', () => {
    const message = describeSmtpError(
      smtpError('ESOCKET', '140736: error:1408F10B:SSL routines:wrong version number'),
    );
    expect(message).toContain('SMTP_SECURE');
    expect(message).toContain('465');
  });

  it('names the credentials on an auth failure', () => {
    const message = describeSmtpError(
      smtpError('EAUTH', 'Invalid login', '535 5.7.8 Username and Password not accepted'),
    );
    expect(message).toContain('SMTP_USER');
    expect(message).toContain('535');
  });

  it('names the addresses when the envelope is refused', () => {
    const message = describeSmtpError(
      smtpError('EENVELOPE', 'Recipient refused', '550 5.1.1 No such user'),
    );
    expect(message).toContain('refused the addresses');
    expect(message).toContain('550');
  });

  it('reports a timeout as a timeout', () => {
    expect(describeSmtpError(smtpError('ETIMEDOUT', 'Connection timeout'))).toContain('timed out');
  });

  it('falls back to what the server said rather than inventing a cause', () => {
    const message = describeSmtpError(
      smtpError('EMESSAGE', 'Message failed', '552 5.3.4 Message too large'),
    );
    expect(message).toContain('552');
  });

  it('copes with something that is not an Error at all', () => {
    expect(describeSmtpError('nope')).toContain('could not be reached');
  });
});
