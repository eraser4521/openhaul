'use client';

import { localDb, type LocalExpense, type LocalPhoto } from './db';

/**
 * Upload queue for captured inspection work.
 *
 * Everything is already safe on the device by the time this runs, so its only
 * job is getting it to the server without losing anything, without duplicating
 * anything, and without hammering a weak connection.
 */

/** Three, not six. The browser's per-host budget is shared with the app's own
 *  requests, and on LTE more parallelism mostly buys more packet loss. */
const CONCURRENCY = 3;

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 5 * 60_000;
const MAX_ATTEMPTS = 8;

/** A request that has been in flight this long is assumed dead. */
const INFLIGHT_TIMEOUT_MS = 2 * 60_000;

/**
 * Full jitter, not a fixed step.
 *
 * Forty photos failing in a tunnel means forty retries the instant signal
 * returns — a thundering herd the client inflicted on itself. Spreading them
 * randomly across the window costs nothing and avoids it.
 */
function backoffDelay(attempt: number): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.random() * ceiling;
}

/**
 * `navigator.onLine` reports that an interface is up, not that the internet is
 * reachable — a truck-stop captive portal looks online and is not. A cheap
 * request against our own origin settles it.
 */
export async function isReachable(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
  try {
    const response = await fetch('/api/health', {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok && response.headers.get('x-openhaul') === 'ok';
  } catch {
    return false;
  }
}

async function uploadPhoto(photo: LocalPhoto): Promise<void> {
  const body = new FormData();
  body.set('photo', photo.blob, `${photo.sha256}.jpg`);
  body.set('photoId', photo.id);
  if (photo.slot) body.set('slot', photo.slot);
  if (photo.damageId) body.set('damageId', photo.damageId);
  if (photo.latitude) body.set('latitude', photo.latitude);
  if (photo.longitude) body.set('longitude', photo.longitude);
  body.set('capturedAt', String(photo.capturedAt));
  body.set('sha256', photo.sha256);

  const response = await fetch(`/api/inspections/${photo.inspectionId}/photos`, {
    method: 'POST',
    body,
    // The photo id doubles as the idempotency key: a retry after a response
    // was lost resolves to the same row rather than a duplicate.
    headers: { 'idempotency-key': photo.id },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${response.status} ${detail.slice(0, 200)}`);
  }
}

export interface FlushResult {
  uploaded: number;
  failed: number;
  remaining: number;
}

let flushing = false;

/**
 * Pushes pending photos to the server.
 *
 * Safe to call repeatedly — concurrent calls collapse into one pass.
 */
export async function flushOutbox(): Promise<FlushResult> {
  if (flushing) return { uploaded: 0, failed: 0, remaining: 0 };
  flushing = true;

  try {
    if (!(await isReachable())) {
      const [photosLeft, expensesLeft] = await Promise.all([
        localDb.photos.where('uploadState').anyOf('pending', 'failed').count(),
        localDb.expenses.where('uploadState').anyOf('pending', 'failed').count(),
      ]);
      return { uploaded: 0, failed: 0, remaining: photosLeft + expensesLeft };
    }

    await reclaimStalledUploads();

    let uploaded = 0;
    let failed = 0;

    for (;;) {
      const now = Date.now();
      const batch = await localDb.photos
        .where('uploadState')
        .anyOf('pending', 'failed')
        .filter((p) => p.nextAttemptAt <= now && p.attempts < MAX_ATTEMPTS)
        .limit(CONCURRENCY)
        .toArray();

      if (batch.length === 0) break;

      await Promise.all(
        batch.map(async (photo) => {
          await localDb.photos.update(photo.id, { uploadState: 'uploading' });

          try {
            await uploadPhoto(photo);

            /*
             * Drop the local copy the moment the server confirms it. Holding
             * it longer only widens the window in which a browser evicting
             * storage could take something that has not been backed up —
             * and by this point it has.
             */
            await localDb.photos.update(photo.id, {
              uploadState: 'uploaded',
              lastError: null,
              blob: new Blob([]),
            });
            uploaded += 1;
          } catch (error) {
            const attempts = photo.attempts + 1;
            await localDb.photos.update(photo.id, {
              uploadState: 'failed',
              attempts,
              nextAttemptAt: Date.now() + backoffDelay(attempts),
              lastError: error instanceof Error ? error.message : 'upload failed',
            });
            failed += 1;
          }
        }),
      );
    }

    const expenses = await flushExpenses();
    uploaded += expenses.uploaded;
    failed += expenses.failed;

    const [photosLeft, expensesLeft] = await Promise.all([
      localDb.photos.where('uploadState').anyOf('pending', 'failed').count(),
      localDb.expenses.where('uploadState').anyOf('pending', 'failed').count(),
    ]);

    return { uploaded, failed, remaining: photosLeft + expensesLeft };
  } finally {
    flushing = false;
  }
}

/**
 * Sends one expense, with its receipt if there is one.
 *
 * The expense id is the idempotency key, exactly as the photo id is. A
 * response lost after the server committed must resolve to the same row on
 * retry: the failure being prevented here is one tank of fuel becoming two
 * reimbursements.
 */
async function uploadExpense(expense: LocalExpense): Promise<void> {
  const body = new FormData();
  body.set('expenseId', expense.id);
  body.set('category', expense.category);
  body.set('amount', expense.amount);
  body.set('incurredAt', expense.incurredAt);
  if (expense.loadId) body.set('loadId', expense.loadId);
  if (expense.vendor) body.set('vendor', expense.vendor);
  if (expense.notes) body.set('notes', expense.notes);
  if (expense.receipt) body.set('receipt', expense.receipt, `${expense.id}.jpg`);

  const response = await fetch('/api/expenses', { method: 'POST', body });

  if (!response.ok) {
    /*
     * A 4xx will fail the same way forever, so retrying it only burns battery
     * and keeps a row in the queue that nothing will ever clear. Marked as
     * exhausted immediately instead, which surfaces it to the driver.
     */
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new PermanentUploadError(body?.error ?? `rejected (${response.status})`);
    }
    throw new Error(`upload failed (${response.status})`);
  }
}

/** A failure that will not come right on its own. */
class PermanentUploadError extends Error {
  readonly permanent = true;
}

/**
 * Pushes queued expenses.
 *
 * Kept separate from the photo pass rather than merged into it: a receipt is
 * one small image against an inspection's twelve, and a driver who has just
 * entered fuel wants it gone before a backlog of photos from this morning.
 */
async function flushExpenses(): Promise<{ uploaded: number; failed: number }> {
  let uploaded = 0;
  let failed = 0;

  for (;;) {
    const now = Date.now();
    const batch = await localDb.expenses
      .where('uploadState')
      .anyOf('pending', 'failed')
      .filter((e) => e.nextAttemptAt <= now && e.attempts < MAX_ATTEMPTS)
      .limit(CONCURRENCY)
      .toArray();

    if (batch.length === 0) break;

    await Promise.all(
      batch.map(async (expense) => {
        await localDb.expenses.update(expense.id, { uploadState: 'uploading' });

        try {
          await uploadExpense(expense);
          // Drop the receipt the moment the server has it, for the same reason
          // a photo is dropped: holding it only widens the window in which the
          // browser could evict something not yet backed up.
          await localDb.expenses.update(expense.id, {
            uploadState: 'uploaded',
            lastError: null,
            receipt: null,
          });
          uploaded += 1;
        } catch (error) {
          const permanent = error instanceof PermanentUploadError;
          const attempts = permanent ? MAX_ATTEMPTS : expense.attempts + 1;

          await localDb.expenses.update(expense.id, {
            uploadState: 'failed',
            attempts,
            nextAttemptAt: permanent ? 0 : Date.now() + backoffDelay(attempts),
            lastError: error instanceof Error ? error.message : 'upload failed',
          });
          failed += 1;
        }
      }),
    );
  }

  return { uploaded, failed };
}

/** Expenses still on the device, for the screen to show a queue depth. */
export async function pendingExpenses(): Promise<LocalExpense[]> {
  const rows = await localDb.expenses
    .where('uploadState')
    .anyOf('pending', 'failed', 'uploading')
    .toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

/** Clears the retry budget on expenses, so the driver can try again by hand. */
export async function retryFailedExpenses(): Promise<void> {
  const failed = await localDb.expenses.where('uploadState').equals('failed').toArray();
  await Promise.all(
    failed.map((e) =>
      localDb.expenses.update(e.id, { uploadState: 'pending', attempts: 0, nextAttemptAt: 0 }),
    ),
  );
}

/** Forgets one the driver no longer wants to send. */
export async function discardLocalExpense(id: string): Promise<void> {
  await localDb.expenses.delete(id);
}

/**
 * Returns photos abandoned mid-upload to the queue.
 *
 * A tab closed during an upload leaves a row marked `uploading` forever. This
 * is only safe because the photo id is the idempotency key and storage is
 * content-addressed, so re-sending cannot duplicate anything.
 */
export async function reclaimStalledUploads(): Promise<number> {
  const cutoff = Date.now() - INFLIGHT_TIMEOUT_MS;
  const stalled = await localDb.photos.where('uploadState').equals('uploading').toArray();

  const reclaimable = stalled.filter((p) => p.capturedAt < cutoff || p.nextAttemptAt < cutoff);
  await Promise.all(
    reclaimable.map((p) =>
      localDb.photos.update(p.id, { uploadState: 'pending', nextAttemptAt: 0 }),
    ),
  );

  return reclaimable.length;
}

/** Photos that exhausted their retries and need the driver to decide. */
export async function permanentlyFailedPhotos(): Promise<LocalPhoto[]> {
  return localDb.photos
    .where('uploadState')
    .equals('failed')
    .filter((p) => p.attempts >= MAX_ATTEMPTS)
    .toArray();
}

/** Clears the retry budget so the driver can try again by hand. */
export async function retryFailedPhotos(): Promise<void> {
  const failed = await localDb.photos.where('uploadState').equals('failed').toArray();
  await Promise.all(
    failed.map((p) =>
      localDb.photos.update(p.id, { uploadState: 'pending', attempts: 0, nextAttemptAt: 0 }),
    ),
  );
}

/**
 * Flushes on reconnect and periodically.
 *
 * Background Sync would be tidier but is absent on iOS, so a plain listener
 * plus a slow interval is what actually works on both platforms.
 */
export function startOutbox(): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;

  const flush = () => {
    void flushOutbox();
  };

  window.addEventListener('online', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') flush();
  });

  timer = setInterval(flush, 60_000);
  flush();

  return () => {
    window.removeEventListener('online', flush);
    if (timer) clearInterval(timer);
  };
}
