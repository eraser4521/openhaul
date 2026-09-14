/**
 * What counts as a claim.
 *
 * 49 CFR 370.3(b) sets three minimum requirements. A written communication is
 * a claim only if it identifies the shipment, asserts the carrier is liable,
 * and demands a specified or determinable amount of money. Miss one and the
 * nine-month clock under Carmack never stopped — which cuts both ways, and is
 * why this is reported rather than quietly assumed either direction.
 *
 * 370.3(c) is the other half and the one that surprises people: a damage
 * notation on a delivery receipt, a bad order report, or an appraisal is NOT a
 * claim. Drivers and dispatchers routinely believe the signed condition report
 * started the clock. It did not.
 */

export interface ClaimRequirement {
  element: 'identification' | 'liability' | 'amount';
  message: string;
  citation: string;
}

export interface ClaimValidityInput {
  /** The shipment this concerns — a load reference, a VIN, or both. */
  loadNumber?: string | null;
  vin?: string | null;
  /** Whether the claimant asserted the carrier is liable, not merely that damage exists. */
  assertsLiability: boolean;
  /** A specified amount, in cents. */
  demandAmountCents?: number | null;
  /**
   * Set when the claimant demanded a determinable amount instead of a figure —
   * "the cost of repair per the attached estimate" satisfies 370.3(b)(3) even
   * with no total on the page.
   */
  amountDeterminable?: boolean;
  /** The claim has to be in writing; a phone call is not one. */
  inWriting: boolean;
}

const CITATION = '49 CFR 370.3';

/**
 * The requirements this communication does not yet meet.
 *
 * An empty array means it qualifies as a filed claim and the statutory clocks
 * start from the date it was received.
 */
export function checkClaimValidity(input: ClaimValidityInput): ClaimRequirement[] {
  const missing: ClaimRequirement[] = [];

  if (!input.inWriting) {
    missing.push({
      element: 'identification',
      message:
        'A claim has to be in writing. A phone call does not start the clock, however clear it was.',
      citation: CITATION,
    });
  }

  const identifies = Boolean(input.loadNumber?.trim()) || Boolean(input.vin?.trim());
  if (!identifies) {
    missing.push({
      element: 'identification',
      message:
        'Nothing here identifies the shipment. Record the load reference or the VIN the claim concerns.',
      citation: CITATION,
    });
  }

  if (!input.assertsLiability) {
    missing.push({
      element: 'liability',
      message:
        'The claimant has to assert the carrier is liable, not only that the vehicle is damaged.',
      citation: CITATION,
    });
  }

  const hasAmount =
    (input.demandAmountCents !== null &&
      input.demandAmountCents !== undefined &&
      input.demandAmountCents > 0) ||
    input.amountDeterminable === true;

  if (!hasAmount) {
    missing.push({
      element: 'amount',
      message:
        'No amount is demanded. A specified figure, or a determinable one such as “cost of repair per the attached estimate”, is required.',
      citation: CITATION,
    });
  }

  return missing;
}

export function isValidClaim(input: ClaimValidityInput): boolean {
  return checkClaimValidity(input).length === 0;
}

/** Things people file believing they are claims, and are not. */
export const NOT_A_CLAIM = [
  'A damage notation on the delivery receipt',
  'A bad order report',
  'An appraisal or repair estimate on its own',
  'A phone call or voicemail',
] as const;

/* -------------------------------------------------------------------------
 * The Carmack prima facie case
 * ---------------------------------------------------------------------- */

/**
 * What a shipper has to show, and therefore what the carrier's file has to
 * answer: that the vehicle was in good condition at origin, that it arrived
 * damaged, and the amount of damages. The inspection record is built to
 * produce exactly those three things, so the claim screen assembles them
 * rather than asking anyone to go looking.
 */
export const PRIMA_FACIE_ELEMENTS = [
  {
    key: 'origin' as const,
    label: 'Condition at origin',
    question: 'What did the vehicle look like when it was collected?',
  },
  {
    key: 'destination' as const,
    label: 'Condition at destination',
    question: 'What did it look like when it was delivered?',
  },
  {
    key: 'amount' as const,
    label: 'Amount of damages',
    question: 'What is the claimant asking for, and on what basis?',
  },
];

export interface DamageRecord {
  code: string;
  /** Nullable on the stored row — a code alone is a valid damage record. */
  description: string | null;
  preExisting: boolean;
  nonTransportation: boolean;
}

export interface PrimaFacieInput {
  originDamages: readonly DamageRecord[];
  destinationDamages: readonly DamageRecord[];
  originPhotoCount: number;
  destinationPhotoCount: number;
  originSealed: boolean;
  destinationSealed: boolean;
}

export interface PrimaFacieAssessment {
  /** Damage recorded at delivery with no matching code at pickup. */
  newAtDestination: DamageRecord[];
  /** Damage already there when the carrier took the vehicle. */
  preExistingAtOrigin: DamageRecord[];
  /** Recorded at delivery and already noted at pickup — the carrier's defence. */
  documentedAtBoth: DamageRecord[];
  /** What is missing before this file can answer the shipper's case. */
  gaps: string[];
}

/**
 * Compares the two inspections.
 *
 * Matching is by AIAG code, which encodes area, type and severity — so the
 * same dent reported at both ends matches, and a new dent on a different panel
 * does not. Descriptions are deliberately not compared: two people describing
 * the same scratch never write the same sentence.
 */
export function assessPrimaFacie(input: PrimaFacieInput): PrimaFacieAssessment {
  const originCodes = new Set(input.originDamages.map((damage) => damage.code));

  const newAtDestination = input.destinationDamages.filter(
    (damage) => !originCodes.has(damage.code) && !damage.nonTransportation,
  );

  const documentedAtBoth = input.destinationDamages.filter((damage) =>
    originCodes.has(damage.code),
  );

  const gaps: string[] = [];

  if (!input.originSealed) {
    gaps.push(
      'There is no sealed pickup inspection. Without it the carrier cannot show what the ' +
        'vehicle looked like when it was collected, which is the shipper’s first element.',
    );
  }
  if (!input.destinationSealed) {
    gaps.push(
      'There is no sealed delivery inspection, so the record does not establish the condition ' +
        'the vehicle arrived in.',
    );
  }
  if (input.originPhotoCount === 0) {
    gaps.push('No photographs were taken at pickup. Written notes alone are weak evidence.');
  }
  if (input.destinationPhotoCount === 0) {
    gaps.push('No photographs were taken at delivery.');
  }

  return {
    newAtDestination,
    preExistingAtOrigin: input.originDamages.filter((damage) => damage.preExisting),
    documentedAtBoth,
    gaps,
  };
}
