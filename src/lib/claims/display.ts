import type { ClaimStatus } from '../db/schema';
import type { DeadlineState } from './deadlines';

/** Presentation for claims, shared by the list and the detail screen. */

export type Tone = 'neutral' | 'brand' | 'ok' | 'warn' | 'info' | 'danger';

export const CLAIM_STATUS_TONE: Record<ClaimStatus, Tone> = {
  filed: 'warn',
  acknowledged: 'info',
  investigating: 'info',
  offered: 'brand',
  paid: 'ok',
  declined: 'neutral',
  withdrawn: 'neutral',
};

export function claimStatusLabel(status: ClaimStatus): string {
  return status.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export const DEADLINE_TONE: Record<DeadlineState, Tone> = {
  met: 'ok',
  overdue: 'danger',
  due_soon: 'warn',
  pending: 'neutral',
  not_applicable: 'neutral',
};

export const DEADLINE_SUMMARY: Record<DeadlineState, string> = {
  met: 'On top of it',
  overdue: 'Deadline missed',
  due_soon: 'Due this week',
  pending: 'On track',
  not_applicable: 'Nothing outstanding',
};
