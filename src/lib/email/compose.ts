import type { DocumentKind } from '../db/schema';

/**
 * What the covering email says.
 *
 * Every one of these is short and plain. The document is the thing; the email
 * exists to get it in front of the right person with enough context that they
 * do not have to open the attachment to know what it is and what it wants from
 * them. A subject line that says only "Document attached" costs somebody a
 * click and gets filed in the wrong place.
 *
 * Written as defaults, not templates — every field is editable before sending,
 * because the one line that matters is usually the one nobody anticipated.
 */

export interface ComposeContext {
  carrierName: string;
  /** The document's own reference: BOL-OH-1001, INV-OH-1001, CLM-2026-0001. */
  reference: string;
  loadNumber?: string | null;
  recipientName?: string | null;

  /** Invoices and credit notes. */
  amountCents?: number | null;
  dueDate?: string | null;
  balanceCents?: number | null;
  /** When the invoice is assigned, payment goes to the factor. */
  factoringCompanyName?: string | null;

  /** Claim letters. */
  claimNumber?: string | null;

  /** Settlement statements. */
  periodLabel?: string | null;
  netPayCents?: number | null;

  /** Statements of account. */
  heldCents?: number | null;
  openItemCount?: number | null;

  /** Overdue notices. */
  daysPastDue?: number | null;
  stageLabel?: string | null;
}

export interface ComposedMessage {
  subject: string;
  body: string;
}

function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  return `${sign}$${Math.floor(absolute / 100).toLocaleString('en-US')}.${String(absolute % 100).padStart(2, '0')}`;
}

function greeting(name: string | null | undefined): string {
  return name ? `${name},` : 'Hello,';
}

function signOff(carrierName: string): string {
  return `\n\nThanks,\n${carrierName}`;
}

/**
 * The default subject and body for a document.
 *
 * The subject carries the reference and, where there is one, the number that
 * decides what happens next — the amount due, the balance, the net pay. An
 * accounts department sorting fifty emails should be able to work from the
 * list view alone.
 */
export function compose(kind: DocumentKind, context: ComposeContext): ComposedMessage {
  const { carrierName, reference, loadNumber } = context;
  const load = loadNumber ? ` for load ${loadNumber}` : '';

  switch (kind) {
    case 'bol':
      return {
        subject: `Bill of lading ${reference}${loadNumber ? ` — load ${loadNumber}` : ''}`,
        body:
          `${greeting(context.recipientName)}\n\n` +
          `The bill of lading${load} is attached. It records the condition of the vehicles as ` +
          'they were collected, with photographs, and is the document a cargo claim would be ' +
          'decided against.\n\n' +
          'Please check the condition report and tell us straight away if anything on it does not ' +
          'match what you have.' +
          signOff(carrierName),
      };

    case 'pod':
      return {
        subject: `Delivery receipt ${reference}${loadNumber ? ` — load ${loadNumber}` : ''}`,
        body:
          `${greeting(context.recipientName)}\n\n` +
          `The signed delivery receipt${load} is attached, with the condition of the vehicles at ` +
          'delivery and the photographs taken at the time.\n\n' +
          'Damage not noted on delivery may not be recoverable, so if something is missing from ' +
          'this receipt please tell us now rather than later.' +
          signOff(carrierName),
      };

    case 'invoice': {
      const amount = money(context.amountCents);
      const due = context.dueDate ? `, due ${context.dueDate}` : '';
      const remit = context.factoringCompanyName
        ? `\n\nThis invoice is assigned to ${context.factoringCompanyName}. Payment must go to ` +
          'them, not to us — the notice of assignment is on the face of the invoice.'
        : '';

      return {
        subject: `Invoice ${reference}${amount ? ` — ${amount}` : ''}${due}`,
        body:
          `${greeting(context.recipientName)}\n\n` +
          `Invoice ${reference}${load} is attached${amount ? `, for ${amount}` : ''}` +
          `${context.dueDate ? ` and due ${context.dueDate}` : ''}.\n\n` +
          'The bill of lading and delivery receipt are named on it with the hash each was sealed ' +
          'under, so your copies can be checked against ours.' +
          remit +
          signOff(carrierName),
      };
    }

    case 'credit_note':
      return {
        subject: `Credit note ${reference} — ${money(context.amountCents)}`,
        body:
          `${greeting(context.recipientName)}\n\n` +
          `Credit note ${reference} is attached${context.amountCents ? `, for ${money(context.amountCents)}` : ''}. ` +
          'It is not a bill and nothing is payable on it — it reduces what is owed on the invoice ' +
          'it names.\n\n' +
          (context.balanceCents !== null && context.balanceCents !== undefined
            ? context.balanceCents < 0
              ? `That leaves ${money(-context.balanceCents)} owing back to you. Let us know whether ` +
                'you would like it applied against your next invoice or refunded.\n\n'
              : context.balanceCents === 0
                ? 'That settles the invoice in full. Nothing further is due.\n\n'
                : `The balance now due on that invoice is ${money(context.balanceCents)}.\n\n`
            : '') +
          'Please pass it to whoever handles your accounts payable so it is applied rather than ' +
          'paid.' +
          signOff(carrierName),
      };

    case 'claim_acknowledgement':
      return {
        subject: `Acknowledgement of claim ${context.claimNumber ?? reference}`,
        body:
          `${greeting(context.recipientName)}\n\n` +
          `We have received your claim and assigned it ${context.claimNumber ?? reference}. The ` +
          'written acknowledgement is attached.\n\n' +
          'Please quote that number on anything further. We will write again with our decision, ' +
          'or with the status and the reason for any delay, within the times set out in the ' +
          'letter.' +
          signOff(carrierName),
      };

    case 'claim_status':
      return {
        subject: `Claim ${context.claimNumber ?? reference} — status update`,
        body:
          `${greeting(context.recipientName)}\n\n` +
          `An update on claim ${context.claimNumber ?? reference} is attached. It is still open, ` +
          'and the letter sets out where it has reached and why.\n\n' +
          'If anything has changed at your end that we should know about, tell us and it goes into ' +
          'the file.' +
          signOff(carrierName),
      };

    case 'claim_disposition':
      return {
        subject: `Claim ${context.claimNumber ?? reference} — our decision`,
        body:
          `${greeting(context.recipientName)}\n\n` +
          `Our decision on claim ${context.claimNumber ?? reference} is attached. Please read it ` +
          'in full: it states what we have decided, the reason, and the time limits that follow ' +
          'from the date on the letter.' +
          signOff(carrierName),
      };

    case 'settlement':
      return {
        subject:
          `Settlement ${reference}` +
          (context.periodLabel ? ` — ${context.periodLabel}` : '') +
          (context.netPayCents !== null && context.netPayCents !== undefined
            ? ` — ${money(context.netPayCents)}`
            : ''),
        body:
          `${greeting(context.recipientName)}\n\n` +
          `Your settlement statement${context.periodLabel ? ` for ${context.periodLabel}` : ''} is ` +
          `attached${context.netPayCents !== null && context.netPayCents !== undefined ? `, net ${money(context.netPayCents)}` : ''}.\n\n` +
          'Every load, every deduction and the escrow balance are itemised on it. If any line is ' +
          'wrong, tell us before it is paid — a correction afterwards has to go on the next one.' +
          signOff(carrierName),
      };

    case 'statement': {
      const owed = context.balanceCents ?? 0;
      const held = context.heldCents ?? 0;
      const items = context.openItemCount ?? 0;

      return {
        subject:
          `Statement of account${context.periodLabel ? ` — ${context.periodLabel}` : ''}` +
          (owed > 0 ? ` — ${money(owed)} outstanding` : ' — nothing outstanding'),
        body:
          `${greeting(context.recipientName)}\n\n` +
          'Your statement of account is attached. It is not an invoice and nothing on it is a ' +
          'new charge — every amount is already on an invoice you hold.\n\n' +
          (owed > 0
            ? `${money(owed)} is outstanding across ${items} invoice${items === 1 ? '' : 's'}, ` +
              'itemised on the statement with how late each one is.\n\n'
            : 'Nothing is outstanding. Thank you.\n\n') +
          (held > 0
            ? `We are also holding ${money(held)} of yours from an overpayment you asked us to ` +
              'carry rather than refund. Tell us which invoice to put it against, or ask for it ' +
              'back at any time.\n\n'
            : '') +
          'If anything on it does not match your records, tell us which line and we will go ' +
          'through it.' +
          signOff(carrierName),
      };
    }

    case 'dunning_notice': {
      const days = context.daysPastDue ?? 0;

      /*
       * Factual, and quiet. A subject line shouting OVERDUE reaches whoever
       * happens to be covering the accounts inbox that week, and the reader
       * it embarrasses is rarely the person who decided not to pay.
       */
      return {
        subject:
          `Invoice ${reference}` +
          (context.balanceCents ? ` — ${money(context.balanceCents)} outstanding` : '') +
          (days > 0 ? ` — ${days} days past due` : ''),
        body:
          `${greeting(context.recipientName)}\n\n` +
          `${context.stageLabel ?? 'A reminder'} about invoice ${reference}${load} is ` +
          'attached.\n\n' +
          (context.balanceCents
            ? `${money(context.balanceCents)} is outstanding on it` +
              (days > 0 ? `, ${days} days after it was due` : '') +
              '.\n\n'
            : '') +
          'If this has crossed with your payment, please accept our thanks and ignore it. If ' +
          'any part of the invoice is wrong, tell us which line and we will look at it.' +
          signOff(carrierName),
      };
    }

    default:
      return {
        subject: `${reference} from ${carrierName}`,
        body: `${greeting(context.recipientName)}\n\nPlease find ${reference} attached.${signOff(carrierName)}`,
      };
  }
}

/**
 * A filename a recipient can save without renaming.
 *
 * Their downloads folder will hold a hundred of these, so the reference goes in
 * the name rather than only in the body.
 */
export function attachmentName(title: string, reference: string): string {
  const base = title.trim() || reference;
  return `${base.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')}.pdf`;
}

/**
 * A permissive address check.
 *
 * Deliberately not an RFC 5322 parser. The only job is to catch a typed mistake
 * before a send attempt burns a round trip; the mail server is the authority on
 * whether an address exists, and a regex that rejects ordinary addresses is
 * worse than one that lets a doomed one through.
 *
 * Whitespace is the one hard rejection, which does rule out the quoted local
 * parts RFC 5321 permits — `"odd name"@example.test`. That is a deliberate
 * trade: callers split on whitespace first, so anything still containing it is
 * a second address pasted into the field rather than an exotic mailbox, and
 * nobody in freight has one of those.
 */
export function looksLikeEmail(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 254) return false;
  if (/\s/.test(trimmed)) return false;

  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return false;

  const domain = trimmed.slice(at + 1);
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

/** Splits a typed recipient list on commas, semicolons or whitespace. */
export function parseAddresses(input: string): string[] {
  return input
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
