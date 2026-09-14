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
  'claim.read': ['owner', 'dispatcher', 'accounting'],
  'claim.write': ['owner', 'dispatcher'],
  'pii.read': ['owner'],
  'settings.write': ['owner'],
  'audit.read': ['owner'],
  'member.manage': ['owner'],
} as const satisfies Record<string, readonly OrgRole[]>;

export type Capability = keyof typeof CAPABILITIES;

export function can(role: OrgRole, capability: Capability): boolean {
  return (CAPABILITIES[capability] as readonly OrgRole[]).includes(role);
}
