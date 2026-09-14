import 'server-only';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  claims as claimsTable,
  creditNotes as creditNotesTable,
  customers as customersTable,
  documents as documentsTable,
  documentSends as sendsTable,
  drivers as driversTable,
  invoices as invoicesTable,
  loads as loadsTable,
  refunds as refundsTable,
  settlements as settlementsTable,
  type DocumentKind,
} from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { blobStore } from '../storage/blob-store';
import { getOrganization } from '../organization/profile';
import { compose, attachmentName, type ComposeContext } from '../email/compose';
import { send, type Attachment } from '../email/transport';
import { balanceCents, sumRefunds } from '../invoices/compute';

/**
 * Sending a stored document.
 *
 * The bytes are checked against the hash recorded when the document was frozen
 * before they are attached — the same check the serving route makes, for the
 * same reason. Emailing a file whose integrity is unknown is worse than
 * serving one, because it leaves your building and you cannot take it back.
 *
 * Every attempt is written down, successful or not, with the hash of what was
 * attached and who pressed the button.
 */

export interface SendDocumentInput {
  documentId: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  actorId?: string | null;
}

export interface SendDocumentResult {
  ok: boolean;
  sendId?: string;
  messageId?: string;
  /** Addresses the server took, which is not the same as addresses that got it. */
  accepted?: string[];
  rejected?: string[];
  error?: string;
}

export async function sendDocument(
  scoped: ScopedDb,
  input: SendDocumentInput,
): Promise<SendDocumentResult> {
  const document = await scoped.selectOne('documents', eq(documentsTable.id, input.documentId));
  if (!document) return { ok: false, error: 'No such document.' };

  if (input.to.length === 0) return { ok: false, error: 'Nobody to send it to.' };
  if (!input.subject.trim()) return { ok: false, error: 'The email needs a subject.' };

  const bytes = await blobStore().get(document.storageKey);
  if (!bytes) {
    return { ok: false, error: 'The stored file is missing. It cannot be sent.' };
  }

  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== document.sha256) {
    /*
     * Recorded as a failed attempt rather than thrown away. Somebody tried to
     * send a document whose bytes no longer match what was sealed, and that is
     * exactly the event worth being able to point at afterwards.
     */
    await recordAttempt(scoped, input, document.sha256, {
      status: 'failed',
      error: 'The stored file no longer matches the hash recorded when this document was sealed.',
    });

    return {
      ok: false,
      error:
        'The stored file no longer matches the hash recorded when this document was sealed. It ' +
        'has not been sent. Treat the copy on disk as suspect.',
    };
  }

  const attachment: Attachment = {
    filename: attachmentName(document.title, document.title),
    content: Buffer.from(bytes),
    contentType: document.contentType,
  };

  /*
   * The send row's id is minted before the message goes out so it can travel
   * in the envelope sender. A bounce coming back days later then identifies
   * this exact attempt even when the returning server kept none of the
   * original headers.
   */
  const sendId = uuidv7();

  const outcome = await send({
    to: input.to,
    cc: input.cc,
    subject: input.subject.trim(),
    text: input.body,
    attachments: [attachment],
    traceToken: sendId,
  });

  if (!outcome.ok) {
    const attempt = await recordAttempt(scoped, input, document.sha256, {
      status: 'failed',
      error: outcome.error,
      id: sendId,
    });
    return { ok: false, error: outcome.error, sendId: attempt };
  }

  const attempt = await recordAttempt(scoped, input, document.sha256, {
    status: 'sent',
    messageId: outcome.messageId,
    id: sendId,
  });

  return {
    ok: true,
    sendId: attempt,
    messageId: outcome.messageId,
    accepted: outcome.accepted,
    rejected: outcome.rejected,
  };
}

async function recordAttempt(
  scoped: ScopedDb,
  input: SendDocumentInput,
  documentSha256: string,
  outcome: { status: 'sent' | 'failed'; messageId?: string; error?: string; id?: string },
): Promise<string | undefined> {
  const [row] = await scoped.insert('documentSends', {
    ...(outcome.id ? { id: outcome.id } : {}),
    documentId: input.documentId,
    toAddresses: input.to,
    ccAddresses: input.cc?.length ? input.cc : null,
    subject: input.subject.trim(),
    body: input.body,
    status: outcome.status,
    messageId: outcome.messageId ?? null,
    error: outcome.error ?? null,
    documentSha256,
    actorId: input.actorId ?? null,
    attemptedAt: new Date(),
  });

  return row?.id;
}

/* -------------------------------------------------------------------------
 * Working out who it goes to and what it says
 * ---------------------------------------------------------------------- */

export interface SendDraft {
  to: string[];
  subject: string;
  body: string;
  /** Named so the screen can say whose address it guessed. */
  recipientLabel: string | null;
}

/**
 * Assembles a first draft of the email for a document.
 *
 * The recipient is derived from whoever the document concerns — the customer
 * for an invoice, the claimant for a claim letter, the driver for a settlement
 * — and left editable, because the right address is frequently somebody's
 * accounts inbox rather than the contact on file.
 */
export async function draftFor(scoped: ScopedDb, documentId: string): Promise<SendDraft | null> {
  const document = await scoped.selectOne('documents', eq(documentsTable.id, documentId));
  if (!document) return null;

  const org = await getOrganization(scoped.orgId);
  const carrierName = org?.legalName ?? 'your carrier';

  const load = document.loadId
    ? await scoped.selectOne('loads', eq(loadsTable.id, document.loadId))
    : null;

  const reference = document.title.replace(/^[A-Za-z ]+\s(?=[A-Z]{2,}-)/, '') || document.title;

  const context: ComposeContext = {
    carrierName,
    reference,
    loadNumber: load?.number ?? null,
  };

  let to: string[] = [];
  let recipientLabel: string | null = null;

  const customerContact = async (customerId: string | null) => {
    if (!customerId) return;
    const customer = await scoped.selectOne('customers', eq(customersTable.id, customerId));
    if (!customer) return;
    recipientLabel = customer.name;
    context.recipientName = customer.contactName ?? customer.name;
    if (customer.email) to = [customer.email];
  };

  switch (document.kind as DocumentKind) {
    case 'invoice': {
      const invoice = await findBySubject(scoped, 'invoices', document.subject, 'invoice');
      if (invoice) {
        context.amountCents = invoice.totalCents;
        context.factoringCompanyName = invoice.factoringCompanyName;
        context.dueDate = invoice.dueAt
          ? invoice.dueAt.toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
              timeZone: 'UTC',
            })
          : null;
        await customerContact(invoice.customerId);
      }
      break;
    }

    case 'credit_note': {
      const note = await findBySubject(scoped, 'creditNotes', document.subject, 'credit_note');
      if (note) {
        context.amountCents = note.amountCents;
        const invoice = await scoped.selectOne('invoices', eq(invoicesTable.id, note.invoiceId));
        if (invoice) {
          // The note tells the customer what is owed back and offers them the
          // choice between a refund and carrying it forward, so the figure has
          // to net off anything already settled either way.
          const refunded = sumRefunds(
            await scoped.select('refunds', eq(refundsTable.invoiceId, invoice.id)),
          );
          context.balanceCents = balanceCents({ ...invoice, refundedCents: refunded });
        }
        await customerContact(note.customerId);
      }
      break;
    }

    case 'claim_acknowledgement':
    case 'claim_status':
    case 'claim_disposition': {
      const claim = await findBySubject(scoped, 'claims', document.subject, 'claim');
      if (claim) {
        context.claimNumber = claim.number;
        context.recipientName = claim.claimantName;
        recipientLabel = claim.claimantName;
        if (claim.claimantEmail) to = [claim.claimantEmail];
      }
      break;
    }

    case 'settlement': {
      const settlement = await findBySubject(scoped, 'settlements', document.subject, 'settlement');
      if (settlement) {
        context.netPayCents = settlement.netPayCents;
        context.periodLabel = `${settlement.periodStart.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        })} to ${settlement.periodEnd.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        })}`;

        const driver = await scoped.selectOne('drivers', eq(driversTable.id, settlement.driverId));
        if (driver) {
          context.recipientName = driver.displayName;
          recipientLabel = driver.displayName;
        }
        // Drivers have no email column of their own; the address is typed.
      }
      break;
    }

    default:
      await customerContact(load?.customerId ?? null);
      break;
  }

  const { subject, body } = compose(document.kind as DocumentKind, context);
  return { to, subject, body, recipientLabel };
}

/**
 * Finds the record a document was produced for.
 *
 * Documents carry a `subject` like `invoice:<id>` rather than a column per
 * kind, so this unpacks it and looks the row up through the scoped client —
 * which means an id from another organisation simply does not resolve.
 */
async function findBySubject<T extends 'invoices' | 'creditNotes' | 'claims' | 'settlements'>(
  scoped: ScopedDb,
  table: T,
  subject: string | null,
  prefix: string,
) {
  if (!subject?.startsWith(`${prefix}:`)) return null;
  const id = subject.slice(prefix.length + 1);
  if (!id) return null;

  const column = {
    invoices: invoicesTable.id,
    creditNotes: creditNotesTable.id,
    claims: claimsTable.id,
    settlements: settlementsTable.id,
  }[table];

  return scoped.selectOne(table, eq(column, id));
}

/** Every attempt made on a document, newest first. */
export async function sendsFor(scoped: ScopedDb, documentId: string) {
  const rows = await scoped.select('documentSends', eq(sendsTable.documentId, documentId));
  return rows.slice().sort((a, b) => b.attemptedAt.getTime() - a.attemptedAt.getTime());
}

/** The latest attempt per document, for list screens. */
export async function latestSends(
  scoped: ScopedDb,
): Promise<Map<string, { attemptedAt: Date; status: string; to: string[] }>> {
  const rows = await scoped.select('documentSends', undefined, {
    orderBy: { column: sendsTable.attemptedAt, direction: 'desc' },
  });

  const latest = new Map<string, { attemptedAt: Date; status: string; to: string[] }>();
  for (const row of rows) {
    if (latest.has(row.documentId)) continue;
    latest.set(row.documentId, {
      attemptedAt: row.attemptedAt,
      status: row.status,
      to: row.toAddresses,
    });
  }

  return latest;
}
