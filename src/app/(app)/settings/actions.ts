'use server';

import { requireCapability } from '@/lib/auth/guard';
import { verifyChain } from '@/lib/audit/chain';

export interface ChainCheckResult {
  ok: boolean;
  message: string;
}

/**
 * Recomputes the audit chain end to end.
 *
 * Owner-only: the result tells you whether anyone has tampered with the
 * record, which is not information a driver account needs.
 */
export async function verifyChainAction(): Promise<ChainCheckResult> {
  try {
    await requireCapability('audit.read');
  } catch {
    return { ok: false, message: 'Only an owner can verify the audit log.' };
  }

  const verdict = await verifyChain();

  if (verdict.ok) {
    return {
      ok: true,
      message:
        verdict.entries === 0
          ? 'The audit log is empty, so there is nothing to verify yet.'
          : `Verified ${verdict.entries} entries. Every one links correctly to the one before it.`,
    };
  }

  return {
    ok: false,
    message:
      `The chain breaks at entry ${verdict.brokenAtSeq}: ${verdict.detail}. ` +
      'Entries before that point are still trustworthy; everything after should be treated as suspect.',
  };
}
