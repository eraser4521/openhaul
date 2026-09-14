import 'server-only';
import { and, eq, isNull } from 'drizzle-orm';
import { legalHolds, loads as loadsTable } from '../db/schema';
import type { ScopedDb } from '../db/scope';
import { appendAudit, AUDIT } from '../audit/chain';

/**
 * Legal holds, which stop retention from destroying evidence.
 *
 * A hold is the answer to "the dispute started in March and the sweep ran in
 * April". It names a subject — one load, one driver, or the whole
 * organisation — and nothing under it is ever counted as due.
 *
 * Several holds can sit on the same subject at once, because two claims on one
 * load are two independent reasons to keep it. Releasing one therefore has to
 * check whether any others are still live before it lets go, which is the bug
 * a single boolean flag invites.
 *
 * `loads.legalHold` remains, and is kept in step here. It is the flag the load
 * and dashboard screens read so they do not have to query this table on every
 * render; the table is what actually decides, and what records who placed the
 * hold, when and why.
 */

export type HoldSubject = `load:${string}` | `driver:${string}` | 'org';

export const ORG_HOLD: HoldSubject = 'org';

export const holdOnLoad = (loadId: string): HoldSubject => `load:${loadId}`;
export const holdOnDriver = (driverId: string): HoldSubject => `driver:${driverId}`;

export interface Actor {
  userId: string | null;
  role: string | null;
}

export async function activeHolds(scoped: ScopedDb) {
  return scoped.select('legalHolds', isNull(legalHolds.releasedAt));
}

/**
 * Every subject currently under hold, as a set the engine can test against.
 *
 * Returned as strings rather than objects because the only question asked of
 * it is membership, thousands of times per report.
 */
export async function heldSubjects(scoped: ScopedDb): Promise<Set<string>> {
  const holds = await activeHolds(scoped);
  return new Set(holds.map((hold) => hold.subject));
}

export async function placeHold(
  scoped: ScopedDb,
  subject: HoldSubject,
  reason: string,
  actor: Actor,
): Promise<{ ok: boolean; error?: string; holdId?: string }> {
  if (reason.trim().length < 3) {
    return { ok: false, error: 'Say why the hold is being placed. It goes on the record.' };
  }

  const [row] = await scoped.insert('legalHolds', {
    subject,
    reason: reason.trim(),
    placedByUserId: actor.userId,
    placedAt: new Date(),
  });

  if (!row) return { ok: false, error: 'The hold could not be placed.' };

  if (subject.startsWith('load:')) {
    await scoped.update('loads', eq(loadsTable.id, subject.slice(5)), { legalHold: true });
  }

  await appendAudit({
    orgId: scoped.orgId,
    actorId: actor.userId,
    actorRole: actor.role,
    action: AUDIT.legalHoldPlaced,
    subject,
    detail: { reason: reason.trim(), holdId: row.id },
  });

  return { ok: true, holdId: row.id };
}

/**
 * Releases every live hold on a subject.
 *
 * The flag is only cleared once nothing else is holding the same load, so a
 * closed claim does not release a load that a second, still-open claim is
 * keeping.
 */
export async function releaseHolds(
  scoped: ScopedDb,
  subject: HoldSubject,
  actor: Actor,
): Promise<{ ok: boolean; released: number }> {
  const live = await scoped.select(
    'legalHolds',
    and(eq(legalHolds.subject, subject), isNull(legalHolds.releasedAt)),
  );

  if (live.length === 0) return { ok: true, released: 0 };

  const releasedAt = new Date();
  for (const hold of live) {
    await scoped.update('legalHolds', eq(legalHolds.id, hold.id), {
      releasedAt,
      releasedByUserId: actor.userId,
    });
  }

  if (subject.startsWith('load:')) {
    const remaining = await scoped.select(
      'legalHolds',
      and(eq(legalHolds.subject, subject), isNull(legalHolds.releasedAt)),
    );
    if (remaining.length === 0) {
      await scoped.update('loads', eq(loadsTable.id, subject.slice(5)), { legalHold: false });
    }
  }

  await appendAudit({
    orgId: scoped.orgId,
    actorId: actor.userId,
    actorRole: actor.role,
    action: AUDIT.legalHoldReleased,
    subject,
    detail: { released: live.length },
  });

  return { ok: true, released: live.length };
}

/**
 * Whether a record is protected, given the subjects it belongs to.
 *
 * An organisation-wide hold covers everything, which is what gets placed when
 * a carrier is served with discovery and nobody yet knows which loads matter.
 */
export function isHeld(
  held: Set<string>,
  record: { loadId?: string | null; driverId?: string | null },
): boolean {
  if (held.has(ORG_HOLD)) return true;
  if (record.loadId && held.has(holdOnLoad(record.loadId))) return true;
  if (record.driverId && held.has(holdOnDriver(record.driverId))) return true;
  return false;
}
