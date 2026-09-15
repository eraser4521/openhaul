import type { OrgRole } from '../db/schema';

/**
 * The role capability matrix.
 *
 * Kept free of server-only imports so navigation and other client components
 * can hide what a role cannot use. Hiding is presentation, not enforcement:
 * every action and route handler still calls `requireCapability` on the
 * server, because a hidden button is not a permission check.
 */
export const CAPABILITIES = {
  'load.read': ['owner', 'dispatcher', 'driver', 'accounting'],
  'load.write': ['owner', 'dispatcher'],
  'load.dispatch': ['owner', 'dispatcher'],
  'load.void': ['owner', 'dispatcher'],
  'inspection.read': ['owner', 'dispatcher', 'driver', 'accounting'],
  'inspection.write': ['owner', 'dispatcher', 'driver'],
  'invoice.read': ['owner', 'dispatcher', 'accounting'],
  'invoice.write': ['owner', 'accounting'],
  'payment.write': ['owner', 'accounting'],
  'customer.read': ['owner', 'dispatcher', 'accounting'],
  'customer.write': ['owner', 'dispatcher'],
  'driver.read': ['owner', 'dispatcher', 'accounting'],
  'driver.write': ['owner'],
  // Running a settlement is accounting work; approving who drives is not.
  'settlement.read': ['owner', 'dispatcher', 'accounting'],
  'settlement.write': ['owner', 'accounting'],
  'equipment.write': ['owner', 'dispatcher'],
  // A driver records what they spent; they do not decide what comes back.
  // Approving is effectively an instruction to pay, so it sits with the people
  // who run the settlements rather than with the person being paid.
  'expense.read': ['owner', 'dispatcher', 'driver', 'accounting'],
  'expense.write': ['owner', 'dispatcher', 'driver'],
  'expense.approve': ['owner', 'dispatcher', 'accounting'],
  'claim.read': ['owner', 'dispatcher', 'accounting'],
  'claim.write': ['owner', 'dispatcher'],
  'pii.read': ['owner'],
  // Separate from reading because it is irreversible. Same role today; the
  // point is that a future change to who may read cannot silently hand out
  // the ability to destroy.
  'pii.erase': ['owner'],
  // Destroying records the business may still need is a different act from
  // configuring how long they are kept, so it is a different capability.
  'retention.purge': ['owner'],
  // The bank balance specifically, and the standing costs screen that sets up
  // what runs against it. Narrower than `invoice.read` because a balance is
  // the one figure that says whether the business is solvent this morning,
  // which is not a dispatcher's to know — the cash timeline shows them the
  // movements without the line those movements run against.
  //
  // It does not fence off the carrier's costs in general: a dispatcher who can
  // already read every driver's settlement is not being protected from the
  // yard rent, so standing costs still appear on the timeline as movements.
  'cash.read': ['owner', 'accounting'],
  'cash.write': ['owner', 'accounting'],
  'settings.write': ['owner'],
  'audit.read': ['owner'],
  'member.manage': ['owner'],
} as const satisfies Record<string, readonly OrgRole[]>;

export type Capability = keyof typeof CAPABILITIES;

export function can(role: OrgRole, capability: Capability): boolean {
  return (CAPABILITIES[capability] as readonly OrgRole[]).includes(role);
}
