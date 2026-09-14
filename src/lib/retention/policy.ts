/**
 * How long each kind of record has to be kept, and from when.
 *
 * Retention is not one clock. The periods below run from different events —
 * the date a document was sealed, the date a vehicle was delivered, the date a
 * claim was disallowed, the date a driver left — and anything keyed off a
 * single `created_at` is wrong somewhere. Each class therefore carries its own
 * anchor, its own floor and the citation for that floor, so an operator
 * lengthening a period can see what they are lengthening and an auditor can
 * check the basis rather than take it on trust.
 *
 * Two kinds of number appear here and they are not the same thing. A **floor**
 * is a regulatory minimum and cannot be configured below. A **default** is this
 * project's opinion, always at or above the floor, and a carrier may raise it.
 * Where there is no federal floor for an artefact the floor is zero and the
 * note says why the default is what it is — a plausible-looking citation for a
 * period nobody actually mandates would be worse than admitting it is a
 * judgement call.
 *
 * No `server-only`: the settings screen renders this table.
 */

export const RECORD_CLASSES = [
  'bill_of_lading',
  'delivery_receipt',
  'freight_bill',
  'inspection_evidence',
  'cargo_claim',
  'settlement_record',
  'driver_record',
  'carrier_check',
  'document_send',
] as const;
export type RecordClass = (typeof RECORD_CLASSES)[number];

/** The event a period is measured from. */
export const ANCHORS = [
  'document_issued',
  'delivery',
  'invoice_issued',
  'claim_disposed',
  'settlement_paid',
  'driver_deactivated',
  'recorded',
] as const;
export type AnchorType = (typeof ANCHORS)[number];

export const ANCHOR_LABEL: Record<AnchorType, string> = {
  document_issued: 'the date the document was sealed',
  delivery: 'the date the vehicle was delivered',
  invoice_issued: 'the date the invoice was issued',
  claim_disposed: 'the date the claim was paid, declined or withdrawn',
  settlement_paid: 'the date the settlement was paid',
  driver_deactivated: 'the date the driver was deactivated',
  recorded: 'the date the record was made',
};

const YEAR = 365;
/** Seven years, matching `organizations.retentionDays`. */
const SEVEN_YEARS = 2557;

/**
 * What the engine may actually do once a period has run out.
 *
 * Keeping a record for long enough is a legal obligation. Destroying it
 * afterwards is usually not — so "past its retention period" and "should be
 * deleted" are different statements, and conflating them is how an accounting
 * history disappears because a timer went off.
 *
 * `purge`   the engine deletes these, with the blobs behind them. Chosen where
 *           the records cost real disk or hold personal data, and where
 *           nothing else in the database depends on them.
 * `erase`   the remedy is destroying the subject key, not deleting rows — the
 *           record stays, the personal data in it stops being readable.
 * `review`  reported and never touched. These are the financial and legal
 *           record; deleting an invoice because it turned seven would remove
 *           the answer to a question somebody may still ask, and the app is
 *           not well placed to decide that on a schedule.
 */
export type Disposition = 'purge' | 'erase' | 'review';

export const DISPOSITION_LABEL: Record<Disposition, string> = {
  purge: 'Deleted when you run a purge',
  erase: 'Erase the personal data instead',
  review: 'Reported only, never deleted automatically',
};

export interface PolicyDefinition {
  recordClass: RecordClass;
  label: string;
  /** What this class actually covers in this database. */
  covers: string;
  anchorType: AnchorType;
  disposition: Disposition;
  /** Regulatory minimum in days. Zero where no federal rule sets one. */
  floorDays: number;
  defaultDays: number;
  /** Empty where the floor is zero, because there is nothing to cite. */
  citation: string;
  note: string;
}

export const POLICY_DEFINITIONS: PolicyDefinition[] = [
  {
    recordClass: 'bill_of_lading',
    label: 'Bills of lading',
    covers: 'The sealed PDF of every bill of lading.',
    anchorType: 'document_issued',
    disposition: 'purge',
    floorDays: YEAR,
    defaultDays: SEVEN_YEARS,
    citation: '49 CFR 379 App. A',
    note:
      'The federal floor is one year. Seven is the default because Carmack allows a claim up to ' +
      'nine months after delivery and suit for two years after a denial, and state contract ' +
      'limitations run longer still.',
  },
  {
    recordClass: 'delivery_receipt',
    label: 'Delivery receipts',
    covers: 'The sealed PDF of every proof of delivery.',
    anchorType: 'document_issued',
    disposition: 'purge',
    floorDays: YEAR,
    defaultDays: SEVEN_YEARS,
    citation: '49 CFR 379 App. A',
    note:
      'Kept as long as the bill it completes. A delivery receipt on its own proves very little; ' +
      'the pair is what answers a claim.',
  },
  {
    recordClass: 'freight_bill',
    label: 'Invoices and credit notes',
    covers: 'Invoice rows, their payments and credit notes, and the PDFs issued for them.',
    anchorType: 'invoice_issued',
    disposition: 'review',
    floorDays: YEAR,
    defaultDays: SEVEN_YEARS,
    citation: '49 CFR 379 App. A',
    note:
      'One year federally. Tax and contract limitation periods are usually the binding constraint ' +
      'rather than 379, which is why the default is longer.',
  },
  {
    recordClass: 'inspection_evidence',
    label: 'Inspection photos and damage records',
    covers: 'Inspections, the damage noted on them, and the photographs — by far the largest thing on disk.',
    anchorType: 'delivery',
    disposition: 'purge',
    floorDays: 0,
    defaultDays: 1096,
    citation: '',
    note:
      'No federal rule sets a period for a carrier’s own photographs. Three years is chosen ' +
      'against the window they are evidence for: nine months to file a claim plus two years to ' +
      'sue after a denial is a little under thirty-three months. Keeping them longer costs disk ' +
      'for evidence nobody can still use, which is why this is the one default set below the ' +
      'seven-year mark.',
  },
  {
    recordClass: 'cargo_claim',
    label: 'Cargo claims',
    covers: 'Claim records and the Part 370 letters sent on them.',
    anchorType: 'claim_disposed',
    disposition: 'review',
    floorDays: 2 * YEAR,
    defaultDays: SEVEN_YEARS,
    citation: '49 U.S.C. 14706(e)',
    note:
      'Two years is the minimum window a carrier may allow for suit after giving written notice ' +
      'of disallowance, so the file cannot be destroyed inside it. An open claim is never due, ' +
      'whatever this is set to.',
  },
  {
    recordClass: 'settlement_record',
    label: 'Settlement statements',
    covers: 'Settlements, their lines, and the statements issued to drivers.',
    anchorType: 'settlement_paid',
    disposition: 'review',
    floorDays: YEAR,
    defaultDays: SEVEN_YEARS,
    citation: '49 CFR 376.11',
    note:
      'Lease records carry a one-year retention after the lease ends. A leased owner-operator may ' +
      'also question a chargeback long afterwards, and the statement is the carrier’s answer.',
  },
  {
    recordClass: 'driver_record',
    label: 'Driver records',
    covers: 'Deactivated drivers and the personal data sealed against them.',
    anchorType: 'driver_deactivated',
    disposition: 'erase',
    floorDays: 3 * YEAR,
    defaultDays: SEVEN_YEARS,
    citation: '49 CFR 391.51(c)',
    note:
      'A driver qualification file runs for the length of employment plus three years. This app ' +
      'does not hold a full qualification file — no road test, no enquiries to previous employers ' +
      '— so the same period is applied to what it does hold. Erasing a driver’s personal data is ' +
      'a separate act and is not blocked by this: the key can be destroyed while the record it ' +
      'belonged to is still retained.',
  },
  {
    recordClass: 'carrier_check',
    label: 'Carrier authority checks',
    covers: 'Cached FMCSA lookups of a carrier’s operating authority and insurance.',
    anchorType: 'recorded',
    disposition: 'purge',
    floorDays: 0,
    defaultDays: 3 * YEAR,
    citation: '',
    note:
      'Nothing federal requires keeping these. They are kept because "we checked their authority ' +
      'before we tendered" is a defence, and three years covers the span in which somebody is ' +
      'likely to need it.',
  },
  {
    recordClass: 'document_send',
    label: 'Send and bounce records',
    covers: 'Every attempt to email a document, with the hash of what was attached.',
    anchorType: 'recorded',
    disposition: 'purge',
    floorDays: 0,
    defaultDays: 3 * YEAR,
    citation: '',
    note:
      'No federal period. These support "the acknowledgement went out on the 14th", which matters ' +
      'for as long as the claim it belongs to could still be argued.',
  },
];

export const POLICY_BY_CLASS: Record<RecordClass, PolicyDefinition> = Object.fromEntries(
  POLICY_DEFINITIONS.map((definition) => [definition.recordClass, definition]),
) as Record<RecordClass, PolicyDefinition>;

/** A policy as it applies right now, after any override the carrier has saved. */
export interface EffectivePolicy extends PolicyDefinition {
  retentionDays: number;
  /** True when the carrier has changed it from the default. */
  customised: boolean;
}

/**
 * Resolves the period in force for a class.
 *
 * The carrier's saved override wins, otherwise the default above — and the
 * floor wins over both. A value below the floor is raised rather than
 * rejected: it can only arrive from a row written before a floor changed, and
 * refusing to answer would break the screen trying to point that out.
 *
 * There is deliberately no organisation-wide number in this calculation.
 * `organizations.retentionDays` predates this table and is not consulted:
 * applying one figure across every class is the mistake the whole feature
 * exists to correct, and in practice it only ever did harm — shipped at seven
 * years, it silently overrode the three-year period chosen for inspection
 * photographs, so the screen argued for three years while enforcing seven.
 */
export function effectivePolicy(
  recordClass: RecordClass,
  options: { savedDays?: number | null } = {},
): EffectivePolicy {
  const definition = POLICY_BY_CLASS[recordClass];
  const chosen = options.savedDays ?? definition.defaultDays;

  return {
    ...definition,
    retentionDays: Math.max(chosen, definition.floorDays),
    customised: options.savedDays != null && options.savedDays !== definition.defaultDays,
  };
}

/** The date a record anchored on `anchor` may be destroyed. */
export function dueAt(anchor: Date, retentionDays: number): Date {
  return new Date(anchor.getTime() + retentionDays * 86_400_000);
}

/**
 * Whether a record has outlived its period.
 *
 * A record with no anchor date is never due. That is the single most important
 * line here: an undelivered load, an open claim and a driver who still works
 * for the carrier all have a null anchor, and treating null as "long ago"
 * would destroy exactly the records that are still live.
 */
export function isDue(anchor: Date | null, retentionDays: number, now: Date): boolean {
  if (!anchor) return false;
  return dueAt(anchor, retentionDays).getTime() <= now.getTime();
}

/** Days as something an operator reads, for a table of periods. */
export function describeDays(days: number): string {
  if (days === 0) return 'no minimum';
  if (days % YEAR === 0) {
    const years = days / YEAR;
    return `${years} year${years === 1 ? '' : 's'}`;
  }
  if (days % 30 === 0) {
    const months = days / 30;
    return `${months} month${months === 1 ? '' : 's'}`;
  }
  // 2557 is seven years including the leap days, and reads better as such.
  const years = Math.round((days / YEAR) * 10) / 10;
  return `${years} years`;
}
