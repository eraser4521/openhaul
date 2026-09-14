import 'server-only';
import { eq } from 'drizzle-orm';
import { documentSends as sendsTable } from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { fetchUnread, markSeen } from '../email/inbox';
import { normalizeMessageId, parseDeliveryReport, type DeliveryReport } from '../email/dsn';

/**
 * Matching returned mail back to the send it came from.
 *
 * Two ways in, because neither works on its own. The Message-ID is the
 * strongest match and is present whenever the bounce returns the original
 * headers, which the standard asks for and most servers do. The VERP token in
 * the envelope recipient covers the rest — the servers that return a fragment,
 * or nothing but their own prose.
 *
 * Everything here is idempotent. A message examined twice produces the same
 * result, which is what lets the reader mark mail seen on a best-effort basis
 * rather than needing that to be reliable.
 */

export interface BounceCheckResult {
  ok: boolean;
  error?: string;
  /** Messages read out of the mailbox. */
  examined: number;
  /** Those that looked like a delivery report. */
  reports: number;
  /** Reports matched to a send and recorded. */
  matched: number;
  /** Permanent failures, which are the ones worth acting on. */
  permanent: number;
  /** Delay notices, recorded but not treated as failures. */
  transient: number;
  /** Reports that looked like bounces but matched nothing we sent. */
  unmatched: number;
}

/**
 * Reads the bounce mailbox and updates the sends it can identify.
 *
 * Returns counts rather than throwing on a partial result: a mailbox with one
 * unparseable message in it should still yield the other ninety-nine.
 */
export async function checkBounces(scoped: ScopedDb): Promise<BounceCheckResult> {
  const empty = {
    examined: 0,
    reports: 0,
    matched: 0,
    permanent: 0,
    transient: 0,
    unmatched: 0,
  };

  const fetched = await fetchUnread();
  if (!fetched.ok) return { ok: false, error: fetched.error, ...empty };

  const result: BounceCheckResult = { ok: true, ...empty, examined: fetched.messages.length };

  // Loaded once: matching by Message-ID against a few hundred sends in memory
  // beats a query per message, and the set is small by nature.
  const sends = await scoped.select('documentSends');
  const byMessageId = new Map<string, (typeof sends)[number]>();
  const byId = new Map<string, (typeof sends)[number]>();

  for (const send of sends) {
    byId.set(send.id, send);
    const id = normalizeMessageId(send.messageId);
    if (id) byMessageId.set(id, send);
  }

  const seen: number[] = [];

  for (const message of fetched.messages) {
    seen.push(message.uid);

    let report: DeliveryReport | null;
    try {
      report = parseDeliveryReport(message.raw);
    } catch {
      // One malformed message must not stop the other ninety-nine.
      continue;
    }

    if (!report) continue;
    result.reports += 1;

    const send =
      (report.originalMessageId ? byMessageId.get(report.originalMessageId) : undefined) ??
      (report.verpToken ? byId.get(report.verpToken) : undefined);

    if (!send) {
      result.unmatched += 1;
      continue;
    }

    const recorded = await recordBounce(scoped, send.id, report);
    if (recorded) {
      result.matched += 1;
      if (report.type === 'permanent') result.permanent += 1;
      else result.transient += 1;
    }
  }

  await markSeen(seen);

  return result;
}

/**
 * Writes a bounce onto its send.
 *
 * A permanent failure changes the status, because "accepted by the mail
 * server" stops being the useful thing to say once the message has come back.
 * A transient one is recorded without touching the status: the receiving
 * server is still trying, and calling that a failure would have somebody
 * re-sending a document that is about to arrive.
 *
 * Returns false when the send already carries a bounce at least as serious,
 * which keeps re-reading the mailbox harmless.
 */
export async function recordBounce(
  scoped: ScopedDb,
  sendId: string,
  report: DeliveryReport,
): Promise<boolean> {
  const send = await scoped.selectOne('documentSends', eq(sendsTable.id, sendId));
  if (!send) return false;

  // A delay notice arriving after a hard bounce tells us nothing new.
  if (send.bounceType === 'permanent' && report.type === 'transient') return false;
  if (send.bounceType === report.type && send.bounceCode === report.status) return false;

  await scoped.update('documentSends', eq(sendsTable.id, sendId), {
    bouncedAt: new Date(),
    bounceType: report.type,
    bounceCode: report.status,
    bounceRecipient: report.recipient,
    bounceDiagnostic: report.diagnostic?.slice(0, 1000) ?? null,
    // Only a permanent failure overturns what the send said about itself.
    status: report.type === 'permanent' ? 'bounced' : send.status,
  });

  return true;
}

/**
 * Sends that came back and nobody has dealt with.
 *
 * Permanent only. A delay notice needs no action, and putting one in front of
 * somebody as a problem trains them to ignore the list.
 */
export async function bouncedSends(scoped: ScopedDb) {
  const rows = await scoped.select('documentSends', eq(sendsTable.status, 'bounced'));
  return rows.slice().sort((a, b) => (b.bouncedAt?.getTime() ?? 0) - (a.bouncedAt?.getTime() ?? 0));
}
