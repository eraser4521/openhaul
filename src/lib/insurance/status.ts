import type { InsuranceCertificate } from '../db/schema';

/**
 * Certificates of insurance, and what they can honestly tell you.
 *
 * Cargo cover for general freight — which includes vehicles — has no FMCSA
 * filing requirement, so the authority lookup is silent on the one policy that
 * actually pays when a car is damaged. A certificate is the only evidence
 * there is, which makes it worth tracking properly and worth being precise
 * about its limits.
 *
 * A certificate is a **snapshot**, not a feed. It says a policy existed on the
 * day it was issued, with those limits. It does not say the policy is still in
 * force: cover can be cancelled the day after a certificate is printed and
 * nothing about the paper changes. Only being named as a certificate holder
 * with a notice-of-cancellation endorsement, or ringing the insurer, tells you
 * that. The app says so rather than letting a file full of certificates read
 * as proof of anything.
 *
 * No `server-only`: the screens render these states.
 */

export const CERTIFICATE_KINDS = ['cargo', 'liability', 'physical_damage', 'workers_comp'] as const;
export type CertificateKind = (typeof CERTIFICATE_KINDS)[number];

export const KIND_LABEL: Record<CertificateKind, string> = {
  cargo: 'Cargo',
  liability: 'Auto liability',
  physical_damage: 'Physical damage',
  workers_comp: "Workers' compensation",
};

export const KIND_NOTE: Record<CertificateKind, string> = {
  cargo:
    'Pays for damage to the vehicles you are carrying. Not filed with FMCSA for general freight, ' +
    'so this certificate is the only proof it exists. Brokers commonly require $100,000 and will ' +
    'not tender a load without seeing it.',
  liability:
    'Bodily injury and property damage you cause to others. Filed with FMCSA as a BMC-91, so the ' +
    'authority lookup can confirm a filing exists — the certificate is what shows the limit.',
  physical_damage:
    'Damage to your own truck and trailer. No regulator requires it. Whoever financed the ' +
    'equipment almost certainly does.',
  workers_comp:
    'Injury to your own employees. Required by most states for a company driver, and a broker may ' +
    'ask for it even where a leased owner-operator is exempt.',
};

/** Where a certificate sits against the clock. */
export type ExpiryState = 'expired' | 'expiring' | 'current' | 'future';

/**
 * How long before expiry the screens start warning.
 *
 * Thirty days is not decoration: an insurer wants notice to renew, and a
 * carrier who finds out on the day has a week of loads they cannot legally
 * accept.
 */
export const WARN_DAYS = 30;
export const URGENT_DAYS = 7;

const DAY = 86_400_000;

/** Whole days from now until expiry. Negative once it has passed. */
export function daysUntil(expiresAt: Date, now: Date): number {
  return Math.floor((expiresAt.getTime() - now.getTime()) / DAY);
}

/**
 * The state of one certificate.
 *
 * Derived from the clock on every read and never stored, for the same reason
 * an overdue invoice is not a stored status: nothing happens on the day a
 * policy lapses, so a column would only ever be as fresh as the last job that
 * touched it.
 */
export function expiryState(
  certificate: { effectiveAt: Date; expiresAt: Date },
  now: Date,
): ExpiryState {
  if (now.getTime() < certificate.effectiveAt.getTime()) return 'future';
  if (now.getTime() > certificate.expiresAt.getTime()) return 'expired';
  return daysUntil(certificate.expiresAt, now) <= WARN_DAYS ? 'expiring' : 'current';
}

export const STATE_TONE: Record<ExpiryState, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  current: 'ok',
  expiring: 'warn',
  expired: 'danger',
  future: 'neutral',
};

export function describeState(
  certificate: { effectiveAt: Date; expiresAt: Date },
  now: Date,
): string {
  const state = expiryState(certificate, now);
  const days = daysUntil(certificate.expiresAt, now);

  switch (state) {
    case 'expired':
      return `Expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`;
    case 'expiring':
      return days <= 0 ? 'Expires today' : `Expires in ${days} day${days === 1 ? '' : 's'}`;
    case 'future':
      return 'Not in force yet';
    case 'current':
      return `In force for another ${days} days`;
  }
}

/**
 * The certificate that counts for a kind of cover.
 *
 * Current beats expiring beats everything else, and the latest expiry wins
 * within that — a carrier who has uploaded next year's renewal alongside this
 * year's policy should see the one that keeps them covered longest, not
 * whichever was typed in last.
 */
export function currentCertificate<T extends { effectiveAt: Date; expiresAt: Date }>(
  certificates: T[],
  now: Date,
): T | null {
  const live = certificates
    .filter((certificate) => expiryState(certificate, now) !== 'expired')
    .filter((certificate) => now.getTime() >= certificate.effectiveAt.getTime());

  if (live.length === 0) return null;
  return live.reduce((a, b) => (a.expiresAt > b.expiresAt ? a : b));
}

/* -------------------------------------------------------------------------
 * Cover against what is actually on the truck
 * ---------------------------------------------------------------------- */

export type CoverageStatus = 'covered' | 'short' | 'unknown' | 'no_cover';

export interface CoverageCheck {
  status: CoverageStatus;
  /** Sum of declared values, or null when any of them is missing. */
  exposureCents: number | null;
  limitCents: number | null;
  shortfallCents: number;
  /** Vehicles with no declared value, which is why exposure can be null. */
  undeclared: number;
}

/**
 * Whether the cargo policy covers what is on the deck.
 *
 * The check that matters to a small carrier. A seven-car load of new vehicles
 * clears $350,000 without being remarkable, and a $100,000 cargo policy — the
 * figure brokers ask for and most carriers therefore buy — leaves the
 * difference with the carrier personally.
 *
 * A vehicle with no declared value makes the answer **unknown**, never zero.
 * Treating a missing figure as nothing would report full cover on exactly the
 * load nobody has valued.
 */
export function coverageCheck(
  limitCents: number | null,
  vehicles: Array<{ declaredValueCents: number | null }>,
): CoverageCheck {
  const undeclared = vehicles.filter((v) => v.declaredValueCents == null).length;
  const declared = vehicles
    .map((v) => v.declaredValueCents)
    .filter((value): value is number => value != null);

  const exposureCents = undeclared > 0 ? null : declared.reduce((sum, value) => sum + value, 0);

  if (limitCents == null) {
    return { status: 'no_cover', exposureCents, limitCents: null, shortfallCents: 0, undeclared };
  }

  if (exposureCents == null) {
    return { status: 'unknown', exposureCents: null, limitCents, shortfallCents: 0, undeclared };
  }

  const shortfallCents = Math.max(0, exposureCents - limitCents);
  return {
    status: shortfallCents > 0 ? 'short' : 'covered',
    exposureCents,
    limitCents,
    shortfallCents,
    undeclared,
  };
}

/**
 * What a certificate does not establish.
 *
 * Shown wherever one is presented as evidence, because the gap between "we
 * hold a certificate" and "they are insured" is where the loss falls.
 */
export const CERTIFICATE_LIMITS = [
  'A certificate records cover on the day it was issued. It is not notice that the policy is still ' +
    'in force — ask to be named as a certificate holder if you need to hear about a cancellation.',
  'The limit recorded here is the one on the certificate. Sublimits, exclusions and the deductible ' +
    'live in the policy, and a certificate does not show them.',
] as const;

export type CertificateRow = InsuranceCertificate;
