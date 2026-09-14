import type { QcCarrier } from './qcmobile';

/**
 * Turning a census record into a decision.
 *
 * The question a dispatcher is actually asking is "can I tender this load to
 * them", or "will this broker still exist when the invoice comes due". The raw
 * record answers neither directly, so it is reduced to findings that say what
 * is wrong and why it matters.
 *
 * The reduction is deliberately conservative about what FMCSA data can prove.
 * Its biggest limitation for auto transport is that cargo insurance is only
 * filed for household goods — for everything else, including vehicles, there
 * is no filing requirement at all. "No cargo insurance on file" is therefore
 * the normal state of a perfectly well-insured car hauler, and reading it as a
 * red flag would reject the entire industry. It is reported as a limit of the
 * source rather than as a finding against the carrier.
 */

/* -------------------------------------------------------------------------
 * Normalising the census record
 * ---------------------------------------------------------------------- */

function text(value: unknown): string | null {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function number(value: unknown): number | null {
  const asText = text(value);
  if (asText === null) return null;
  const parsed = Number.parseFloat(asText);
  return Number.isFinite(parsed) ? parsed : null;
}

/** FMCSA writes booleans as "Y"/"N". Anything else is genuinely unknown. */
function yesNo(value: unknown): boolean | null {
  const asText = text(value)?.toUpperCase();
  if (asText === 'Y' || asText === 'YES') return true;
  if (asText === 'N' || asText === 'NO') return false;
  return null;
}

function date(value: unknown): Date | null {
  const asText = text(value);
  if (asText === null) return null;
  const parsed = new Date(asText);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export type AuthorityState = 'active' | 'inactive' | 'none' | 'unknown';

/** Authority statuses come back as "A", "I" or "N". */
function authority(value: unknown): AuthorityState {
  switch (text(value)?.toUpperCase()) {
    case 'A':
      return 'active';
    case 'I':
      return 'inactive';
    case 'N':
      return 'none';
    default:
      return 'unknown';
  }
}

export const AUTHORITY_LABEL: Record<AuthorityState, string> = {
  active: 'Active',
  inactive: 'Inactive',
  none: 'None',
  unknown: 'Not reported',
};

export interface CarrierProfile {
  dotNumber: string | null;
  legalName: string | null;
  dbaName: string | null;

  allowedToOperate: boolean | null;
  /** Census status: active or inactive registration. */
  active: boolean | null;
  outOfServiceAt: Date | null;

  address: string | null;
  telephone: string | null;

  powerUnits: number | null;
  drivers: number | null;

  safetyRating: string | null;
  safetyRatingAt: Date | null;

  commonAuthority: AuthorityState;
  contractAuthority: AuthorityState;
  brokerAuthority: AuthorityState;

  bipdOnFile: boolean | null;
  bipdRequired: boolean | null;
  cargoOnFile: boolean | null;
  cargoRequired: boolean | null;
  bondOnFile: boolean | null;
  bondRequired: boolean | null;

  mcs150At: Date | null;
  mcs150Outdated: boolean | null;

  crashesTotal: number | null;
  crashesFatal: number | null;
  crashesInjury: number | null;

  driverInspections: number | null;
  driverOosRate: number | null;
  driverOosNationalAverage: number | null;
  vehicleInspections: number | null;
  vehicleOosRate: number | null;
  vehicleOosNationalAverage: number | null;
}

export function toProfile(carrier: QcCarrier): CarrierProfile {
  const address = [
    text(carrier.phyStreet),
    [text(carrier.phyCity), text(carrier.phyState), text(carrier.phyZipcode)]
      .filter(Boolean)
      .join(' '),
  ]
    .filter(Boolean)
    .join(', ');

  return {
    dotNumber: text(carrier.dotNumber),
    legalName: text(carrier.legalName),
    dbaName: text(carrier.dbaName),

    allowedToOperate: yesNo(carrier.allowedToOperate),
    active: text(carrier.statusCode)?.toUpperCase() === 'A'
      ? true
      : text(carrier.statusCode)?.toUpperCase() === 'I'
        ? false
        : null,
    outOfServiceAt: date(carrier.oosDate),

    address: address || null,
    telephone: text(carrier.telephone),

    powerUnits: number(carrier.totalPowerUnits),
    drivers: number(carrier.totalDrivers),

    safetyRating: text(carrier.safetyRating),
    safetyRatingAt: date(carrier.safetyRatingDate),

    commonAuthority: authority(carrier.commonAuthorityStatus),
    contractAuthority: authority(carrier.contractAuthorityStatus),
    brokerAuthority: authority(carrier.brokerAuthorityStatus),

    bipdOnFile: yesNo(carrier.bipdInsuranceOnFile),
    bipdRequired: yesNo(carrier.bipdInsuranceRequired),
    cargoOnFile: yesNo(carrier.cargoInsuranceOnFile),
    cargoRequired: yesNo(carrier.cargoInsuranceRequired),
    bondOnFile: yesNo(carrier.bondInsuranceOnFile),
    bondRequired: yesNo(carrier.bondInsuranceRequired),

    mcs150At: date(carrier.mcs150Date),
    mcs150Outdated: yesNo(carrier.mcs150Outdated),

    crashesTotal: number(carrier.crashTotal),
    crashesFatal: number(carrier.fatalCrash),
    crashesInjury: number(carrier.injCrash),

    driverInspections: number(carrier.driverInsp),
    driverOosRate: number(carrier.driverOosRate),
    driverOosNationalAverage: number(carrier.driverOosRateNationalAverage),
    vehicleInspections: number(carrier.vehicleInsp),
    vehicleOosRate: number(carrier.vehicleOosRate),
    vehicleOosNationalAverage: number(carrier.vehicleOosRateNationalAverage),
  };
}

/* -------------------------------------------------------------------------
 * Findings
 * ---------------------------------------------------------------------- */

export type Severity = 'blocking' | 'warning' | 'note';

export interface Finding {
  severity: Severity;
  title: string;
  detail: string;
}

/** What the record is being read for. The answer differs. */
export type Role = 'carrier' | 'broker';

/**
 * How stale an MCS-150 has to be before it is worth mentioning.
 *
 * FMCSA requires the census update biennially, and a registration that is not
 * updated is eventually deactivated — so an old one is a sign the operation
 * may be winding down, or already gone.
 */
const MCS150_STALE_DAYS = 730;

export function assess(
  profile: CarrierProfile,
  role: Role,
  now: Date = new Date(),
): Finding[] {
  const findings: Finding[] = [];

  /* --- Can they operate at all --------------------------------------- */

  if (profile.allowedToOperate === false) {
    findings.push({
      severity: 'blocking',
      title: 'Not allowed to operate',
      detail:
        'FMCSA records this operation as not permitted to operate. Tendering freight to them, or ' +
        'hauling for them, is not something to do on a phone call.',
    });
  }

  if (profile.outOfServiceAt) {
    findings.push({
      severity: 'blocking',
      title: 'Out of service',
      detail: `Placed out of service on ${profile.outOfServiceAt.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC',
      })}. An out-of-service order is not advisory.`,
    });
  }

  if (profile.active === false && profile.allowedToOperate !== false) {
    findings.push({
      severity: 'warning',
      title: 'Registration is inactive',
      detail:
        'The USDOT registration is marked inactive. That usually means the operation stopped ' +
        'filing, which is worth a conversation before the load moves.',
    });
  }

  /* --- The right authority for the role -------------------------------- */

  if (role === 'broker') {
    if (profile.brokerAuthority === 'active') {
      // Nothing to say; this is what it should look like.
    } else if (profile.brokerAuthority === 'none') {
      findings.push({
        severity: 'blocking',
        title: 'No broker authority',
        detail:
          'FMCSA records no broker authority for this number. Somebody arranging transport ' +
          'without it is not a broker, whatever the rate confirmation says.',
      });
    } else if (profile.brokerAuthority === 'inactive') {
      findings.push({
        severity: 'blocking',
        title: 'Broker authority is inactive',
        detail:
          'The broker authority exists but is not active. Freight arranged under inactive ' +
          'authority is a problem for both parties.',
      });
    }

    /*
     * The bond is the only thing standing between a small carrier and an
     * unpaid invoice when a broker fails. A broker must maintain a $75,000
     * BMC-84 surety bond or BMC-85 trust fund, and it is filed with FMCSA —
     * unlike cargo cover, so here an absence really does mean something.
     */
    if (profile.bondOnFile === false) {
      findings.push({
        severity: 'blocking',
        title: 'No surety bond or trust fund on file',
        detail:
          'A broker has to keep a $75,000 BMC-84 bond or BMC-85 trust fund on file. Without one ' +
          'there is nothing to claim against if they stop paying, and they are not entitled to ' +
          'broker in the first place.',
      });
    } else if (profile.bondOnFile === null && profile.bondRequired === true) {
      findings.push({
        severity: 'warning',
        title: 'Bond status not reported',
        detail:
          'A bond is required for this operation but FMCSA did not report whether one is on ' +
          'file. Check the licensing and insurance record directly before relying on it.',
      });
    }
  }

  if (role === 'carrier') {
    const hasOperatingAuthority =
      profile.commonAuthority === 'active' || profile.contractAuthority === 'active';

    if (!hasOperatingAuthority) {
      findings.push({
        severity: 'warning',
        title: 'No active for-hire operating authority',
        detail:
          'Neither common nor contract authority is active. That is expected for a private ' +
          'fleet moving its own vehicles, and a problem for anybody hauling for hire.',
      });
    }

    if (profile.bipdOnFile === false && profile.bipdRequired === true) {
      findings.push({
        severity: 'blocking',
        title: 'No liability insurance on file',
        detail:
          'Public liability cover is required for this operation and FMCSA has no filing for it. ' +
          'Unlike cargo cover, this one is genuinely supposed to be on file.',
      });
    }
  }

  /* --- Safety ---------------------------------------------------------- */

  const rating = profile.safetyRating?.toLowerCase() ?? null;

  if (rating === 'unsatisfactory') {
    findings.push({
      severity: 'blocking',
      title: 'Unsatisfactory safety rating',
      detail:
        'An unsatisfactory rating prohibits for-hire operation once it takes effect. Do not ' +
        'tender freight against it.',
    });
  } else if (rating === 'conditional') {
    findings.push({
      severity: 'warning',
      title: 'Conditional safety rating',
      detail:
        'A conditional rating means FMCSA found deficiencies at a compliance review. Operation ' +
        'is still permitted, but many shippers and insurers will not accept it.',
    });
  } else if ((!rating || rating === 'none' || rating === 'not rated') && role === 'carrier') {
    /*
     * Only said of a carrier. A safety rating follows a compliance review of a
     * motor carrier's operation; a broker has no trucks and no drivers to
     * review, so noting the absence of a rating against one is noise dressed
     * up as a finding.
     */
    findings.push({
      severity: 'note',
      title: 'No safety rating',
      detail:
        'Most carriers are unrated: a rating only follows a compliance review, and the majority ' +
        'have never had one. This is not a mark against them and not a clean bill of health.',
    });
  }

  /* --- Inspection history ---------------------------------------------- */

  const oosFinding = (
    label: string,
    rate: number | null,
    average: number | null,
    inspections: number | null,
  ) => {
    if (rate === null || average === null || !inspections || inspections < 5) return;
    if (rate <= average * 2) return;

    findings.push({
      severity: 'warning',
      title: `${label} out-of-service rate is high`,
      detail:
        `${rate.toFixed(1)}% across ${inspections} inspections, against a national average of ` +
        `${average.toFixed(1)}%. Comparison is FMCSA's own figure, not one assumed here.`,
    });
  };

  oosFinding('Driver', profile.driverOosRate, profile.driverOosNationalAverage, profile.driverInspections);
  oosFinding(
    'Vehicle',
    profile.vehicleOosRate,
    profile.vehicleOosNationalAverage,
    profile.vehicleInspections,
  );

  if (profile.crashesFatal && profile.crashesFatal > 0) {
    findings.push({
      severity: 'warning',
      title: `${profile.crashesFatal} fatal crash${profile.crashesFatal === 1 ? '' : 'es'} on record`,
      detail:
        'Recorded in the last 24 months. Crash counts include those where the carrier was not at ' +
        'fault, so this is a prompt to ask rather than a conclusion.',
    });
  }

  /* --- Staleness -------------------------------------------------------- */

  if (profile.mcs150Outdated === true) {
    findings.push({
      severity: 'warning',
      title: 'Census filing is out of date',
      detail:
        'FMCSA flags the MCS-150 as outdated. The biennial update is a condition of keeping the ' +
        'registration, and a registration nobody is maintaining can be deactivated.',
    });
  } else if (profile.mcs150At) {
    const ageDays = Math.floor((now.getTime() - profile.mcs150At.getTime()) / 86_400_000);
    if (ageDays > MCS150_STALE_DAYS) {
      findings.push({
        severity: 'note',
        title: 'Census filing is over two years old',
        detail:
          `Last updated ${Math.floor(ageDays / 365)} years ago. The update is due every two ` +
          'years, so the figures below may not describe the operation as it is now.',
      });
    }
  }

  return findings;
}

/* -------------------------------------------------------------------------
 * The verdict
 * ---------------------------------------------------------------------- */

export type Verdict = 'blocked' | 'caution' | 'clear';

export function verdictFrom(findings: readonly Finding[]): Verdict {
  if (findings.some((finding) => finding.severity === 'blocking')) return 'blocked';
  if (findings.some((finding) => finding.severity === 'warning')) return 'caution';
  return 'clear';
}

export const VERDICT_HEADLINE: Record<Verdict, string> = {
  blocked: 'Do not move freight on this',
  caution: 'Registered, with things worth asking about',
  clear: 'Registered and permitted to operate',
};

/**
 * What this check cannot tell you.
 *
 * Shown every time, including on a clean result, because the most dangerous
 * outcome of a verification tool is the belief that a green tick means covered.
 */
export function limitations(role: Role): string[] {
  const common = [
    'FMCSA publishes a snapshot of its census, not a live feed. A status can change between ' +
      'their update and yours.',
    'Registration is not a credit check. A carrier or broker can be perfectly authorised and ' +
      'still not pay, or not show up.',
  ];

  if (role === 'carrier') {
    return [
      'Cargo insurance for general freight — which includes vehicles — is not filed with FMCSA ' +
        'at all. No cargo filing here is the normal state of a fully insured car hauler, and the ' +
        'only way to verify cover is a certificate from their insurer naming you.',
      ...common,
    ];
  }

  return [
    'A bond on file says the bond exists, not that it is untouched. A broker in trouble can have ' +
      'claims against the bond already exceeding it.',
    ...common,
  ];
}
