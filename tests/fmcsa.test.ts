import { describe, expect, it } from 'vitest';
import {
  assess,
  AUTHORITY_LABEL,
  limitations,
  toProfile,
  verdictFrom,
  VERDICT_HEADLINE,
  type Finding,
} from '@/lib/fmcsa/assess';
import { FAILURE_MESSAGE, type QcCarrier } from '@/lib/fmcsa/qcmobile';

/**
 * FMCSA's census answers a narrower question than people assume it does, so
 * these tests care as much about what the assessment refuses to conclude as
 * about what it flags.
 */

/** A clean, ordinary interstate car hauler, as the census reports one. */
function carrier(overrides: Partial<QcCarrier> = {}): QcCarrier {
  return {
    dotNumber: 3312907,
    legalName: 'RIDGELINE AUTO TRANSPORT LLC',
    dbaName: null,
    allowedToOperate: 'Y',
    statusCode: 'A',
    phyStreet: '4400 MEACHAM BLVD',
    phyCity: 'FORT WORTH',
    phyState: 'TX',
    phyZipcode: '76106',
    telephone: '2145550118',
    totalPowerUnits: 3,
    totalDrivers: 4,
    safetyRating: null,
    oosDate: null,
    commonAuthorityStatus: 'A',
    contractAuthorityStatus: 'N',
    brokerAuthorityStatus: 'N',
    bipdInsuranceOnFile: 'Y',
    bipdInsuranceRequired: 'Y',
    // The normal state for a car hauler: general freight cargo cover is not
    // filed with FMCSA at all.
    cargoInsuranceOnFile: 'N',
    cargoInsuranceRequired: 'N',
    bondInsuranceOnFile: 'N',
    bondInsuranceRequired: 'N',
    mcs150Date: new Date().toISOString(),
    mcs150Outdated: 'N',
    crashTotal: 0,
    fatalCrash: 0,
    injCrash: 0,
    driverInsp: 12,
    driverOosInsp: 0,
    driverOosRate: 0,
    driverOosRateNationalAverage: 5.51,
    vehicleInsp: 20,
    vehicleOosInsp: 3,
    vehicleOosRate: 15,
    vehicleOosRateNationalAverage: 21.37,
    ...overrides,
  };
}

function titles(findings: readonly Finding[]): string[] {
  return findings.map((finding) => finding.title);
}

/* -------------------------------------------------------------------------
 * Normalising the record
 * ---------------------------------------------------------------------- */

describe('toProfile', () => {
  it('reads the fields a dispatcher actually looks at', () => {
    const profile = toProfile(carrier());

    expect(profile.dotNumber).toBe('3312907');
    expect(profile.legalName).toBe('RIDGELINE AUTO TRANSPORT LLC');
    expect(profile.allowedToOperate).toBe(true);
    expect(profile.active).toBe(true);
    expect(profile.powerUnits).toBe(3);
    expect(profile.address).toBe('4400 MEACHAM BLVD, FORT WORTH TX 76106');
  });

  it('reads FMCSA’s Y/N strings as booleans', () => {
    expect(toProfile(carrier({ allowedToOperate: 'N' })).allowedToOperate).toBe(false);
    expect(toProfile(carrier({ bipdInsuranceOnFile: 'Y' })).bipdOnFile).toBe(true);
  });

  it('keeps “unknown” distinct from “no”', () => {
    /*
     * An absent field means FMCSA did not report it, which is not the same as
     * reporting a negative — and treating it as one would invent findings.
     */
    const profile = toProfile(carrier({ allowedToOperate: undefined, bipdInsuranceOnFile: '' }));
    expect(profile.allowedToOperate).toBeNull();
    expect(profile.bipdOnFile).toBeNull();
  });

  it('reads authority codes', () => {
    const profile = toProfile(
      carrier({
        commonAuthorityStatus: 'A',
        contractAuthorityStatus: 'I',
        brokerAuthorityStatus: 'N',
      }),
    );

    expect(profile.commonAuthority).toBe('active');
    expect(profile.contractAuthority).toBe('inactive');
    expect(profile.brokerAuthority).toBe('none');
  });

  it('treats an unrecognised authority code as unreported rather than guessing', () => {
    expect(toProfile(carrier({ brokerAuthorityStatus: 'X' })).brokerAuthority).toBe('unknown');
    expect(AUTHORITY_LABEL.unknown).toBe('Not reported');
  });

  it('accepts numbers arriving as strings, which this API does inconsistently', () => {
    const profile = toProfile(carrier({ totalPowerUnits: '14', driverOosRate: '6.5' }));
    expect(profile.powerUnits).toBe(14);
    expect(profile.driverOosRate).toBe(6.5);
  });

  it('survives a record that is almost entirely empty', () => {
    const profile = toProfile({});
    expect(profile.legalName).toBeNull();
    expect(profile.allowedToOperate).toBeNull();
    expect(profile.address).toBeNull();
    expect(profile.commonAuthority).toBe('unknown');
  });

  it('ignores an unparseable date rather than inventing one', () => {
    expect(toProfile(carrier({ oosDate: 'not a date' })).outOfServiceAt).toBeNull();
  });
});

/* -------------------------------------------------------------------------
 * Assessing a carrier
 * ---------------------------------------------------------------------- */

describe('assess, as a carrier', () => {
  it('clears an ordinary authorised car hauler', () => {
    const findings = assess(toProfile(carrier()), 'carrier');

    expect(findings.filter((f) => f.severity === 'blocking')).toEqual([]);
    expect(findings.filter((f) => f.severity === 'warning')).toEqual([]);
    // Unrated is the normal state and is reported as a note, not a problem.
    expect(titles(findings)).toContain('No safety rating');
    expect(verdictFrom(findings)).toBe('clear');
  });

  it('does not treat a missing cargo filing as a finding', () => {
    /*
     * The single most important judgement here. Cargo insurance for general
     * freight — which includes vehicles — is not filed with FMCSA, so flagging
     * its absence would mark every legitimate car hauler in the country as a
     * risk.
     */
    const findings = assess(toProfile(carrier({ cargoInsuranceOnFile: 'N' })), 'carrier');
    expect(titles(findings).join(' ')).not.toContain('argo');
  });

  it('says so in the limitations instead', () => {
    expect(limitations('carrier').join(' ')).toContain('not filed with FMCSA');
  });

  it('blocks a carrier not allowed to operate', () => {
    const findings = assess(toProfile(carrier({ allowedToOperate: 'N' })), 'carrier');
    expect(titles(findings)).toContain('Not allowed to operate');
    expect(verdictFrom(findings)).toBe('blocked');
  });

  it('blocks a carrier under an out-of-service order', () => {
    const findings = assess(
      toProfile(carrier({ oosDate: '2026-03-11T00:00:00Z' })),
      'carrier',
    );

    const oos = findings.find((f) => f.title === 'Out of service');
    expect(oos?.severity).toBe('blocking');
    expect(oos?.detail).toContain('March 11, 2026');
  });

  it('blocks an unsatisfactory safety rating', () => {
    const findings = assess(toProfile(carrier({ safetyRating: 'Unsatisfactory' })), 'carrier');
    expect(titles(findings)).toContain('Unsatisfactory safety rating');
    expect(verdictFrom(findings)).toBe('blocked');
  });

  it('warns on a conditional rating without blocking it', () => {
    const findings = assess(toProfile(carrier({ safetyRating: 'Conditional' })), 'carrier');
    expect(verdictFrom(findings)).toBe('caution');
  });

  it('leaves a satisfactory rating alone', () => {
    const findings = assess(toProfile(carrier({ safetyRating: 'Satisfactory' })), 'carrier');
    expect(titles(findings)).not.toContain('No safety rating');
    expect(verdictFrom(findings)).toBe('clear');
  });

  it('blocks a required liability filing that is missing', () => {
    const findings = assess(
      toProfile(carrier({ bipdInsuranceOnFile: 'N', bipdInsuranceRequired: 'Y' })),
      'carrier',
    );
    expect(titles(findings)).toContain('No liability insurance on file');
  });

  it('warns when no for-hire authority is active', () => {
    const findings = assess(
      toProfile(carrier({ commonAuthorityStatus: 'N', contractAuthorityStatus: 'N' })),
      'carrier',
    );
    const finding = findings.find((f) => f.title.includes('for-hire operating authority'));
    expect(finding?.severity).toBe('warning');
    // Stated as a question, since a private fleet legitimately has none.
    expect(finding?.detail).toContain('private fleet');
  });

  it('flags an inactive registration', () => {
    const findings = assess(toProfile(carrier({ statusCode: 'I' })), 'carrier');
    expect(titles(findings)).toContain('Registration is inactive');
  });

  it('does not repeat itself when a carrier is both barred and inactive', () => {
    const findings = assess(
      toProfile(carrier({ statusCode: 'I', allowedToOperate: 'N' })),
      'carrier',
    );
    expect(titles(findings)).toContain('Not allowed to operate');
    expect(titles(findings)).not.toContain('Registration is inactive');
  });
});

/* -------------------------------------------------------------------------
 * Inspection history
 * ---------------------------------------------------------------------- */

describe('assess, on inspection history', () => {
  it('flags an out-of-service rate well over the national average', () => {
    const findings = assess(
      toProfile(carrier({ vehicleOosRate: 55, vehicleInsp: 40, vehicleOosRateNationalAverage: 21.37 })),
      'carrier',
    );

    const finding = findings.find((f) => f.title.includes('Vehicle out-of-service'));
    expect(finding?.severity).toBe('warning');
    expect(finding?.detail).toContain('21.4%');
  });

  it('leaves a rate merely above average alone', () => {
    // Above average is ordinary. Only a rate far out of line is worth stopping for.
    const findings = assess(
      toProfile(carrier({ vehicleOosRate: 25, vehicleInsp: 40 })),
      'carrier',
    );
    expect(titles(findings).join(' ')).not.toContain('out-of-service rate');
  });

  it('says nothing about a rate drawn from a handful of inspections', () => {
    /*
     * One failed inspection out of two is a 50% rate and means nothing. A
     * sample that small would generate a scary number for a new carrier who
     * has done nothing wrong.
     */
    const findings = assess(
      toProfile(carrier({ vehicleOosRate: 50, vehicleInsp: 2, vehicleOosInsp: 1 })),
      'carrier',
    );
    expect(titles(findings).join(' ')).not.toContain('out-of-service rate');
  });

  it('makes no comparison when FMCSA did not supply the average', () => {
    // The average is theirs to publish; inventing one here would be a guess
    // dressed up as a federal figure.
    const findings = assess(
      toProfile(
        carrier({
          vehicleOosRate: 60,
          vehicleInsp: 40,
          vehicleOosRateNationalAverage: null,
        }),
      ),
      'carrier',
    );
    expect(titles(findings).join(' ')).not.toContain('out-of-service rate');
  });

  it('raises fatal crashes as a question, not a conclusion', () => {
    const findings = assess(toProfile(carrier({ fatalCrash: 2 })), 'carrier');
    const finding = findings.find((f) => f.title.includes('fatal crash'));
    expect(finding?.title).toContain('2 fatal crashes');
    expect(finding?.detail).toContain('not at');
  });

  it('says nothing when there are none', () => {
    expect(titles(assess(toProfile(carrier()), 'carrier')).join(' ')).not.toContain('fatal');
  });
});

/* -------------------------------------------------------------------------
 * Assessing a broker
 * ---------------------------------------------------------------------- */

describe('assess, as a broker', () => {
  function broker(overrides: Partial<QcCarrier> = {}): QcCarrier {
    return carrier({
      brokerAuthorityStatus: 'A',
      commonAuthorityStatus: 'N',
      bondInsuranceOnFile: 'Y',
      bondInsuranceRequired: 'Y',
      bipdInsuranceRequired: 'N',
      bipdInsuranceOnFile: 'N',
      ...overrides,
    });
  }

  it('clears a broker with active authority and a bond on file', () => {
    const findings = assess(toProfile(broker()), 'broker');
    expect(findings.filter((f) => f.severity === 'blocking')).toEqual([]);
    expect(verdictFrom(findings)).toBe('clear');
  });

  it('blocks a broker with no broker authority', () => {
    const findings = assess(toProfile(broker({ brokerAuthorityStatus: 'N' })), 'broker');
    expect(titles(findings)).toContain('No broker authority');
    expect(verdictFrom(findings)).toBe('blocked');
  });

  it('blocks a broker whose authority is inactive', () => {
    const findings = assess(toProfile(broker({ brokerAuthorityStatus: 'I' })), 'broker');
    expect(titles(findings)).toContain('Broker authority is inactive');
  });

  it('blocks a broker with no surety bond on file', () => {
    /*
     * Unlike cargo cover, the bond genuinely is filed — so its absence is real
     * information, and it is the only thing a small carrier can claim against
     * when a broker stops paying.
     */
    const findings = assess(toProfile(broker({ bondInsuranceOnFile: 'N' })), 'broker');
    const finding = findings.find((f) => f.title.includes('surety bond'));
    expect(finding?.severity).toBe('blocking');
    expect(finding?.detail).toContain('$75,000');
  });

  it('warns rather than blocks when the bond status was not reported', () => {
    const findings = assess(
      toProfile(broker({ bondInsuranceOnFile: '', bondInsuranceRequired: 'Y' })),
      'broker',
    );
    const finding = findings.find((f) => f.title.includes('Bond status'));
    expect(finding?.severity).toBe('warning');
  });

  it('does not note a missing safety rating against a broker', () => {
    // A rating follows a compliance review of a motor carrier's operation. A
    // broker has no trucks to review, so the absence of one says nothing.
    const findings = assess(toProfile(broker()), 'broker');
    expect(titles(findings)).not.toContain('No safety rating');
  });

  it('still blocks a broker entity carrying an unsatisfactory rating', () => {
    // Rare, but it happens when one company holds both authorities.
    const findings = assess(toProfile(broker({ safetyRating: 'Unsatisfactory' })), 'broker');
    expect(titles(findings)).toContain('Unsatisfactory safety rating');
  });

  it('does not demand for-hire operating authority of a broker', () => {
    // A broker arranges transport; it does not need common or contract
    // authority of its own, and asking for it would flag every real broker.
    const findings = assess(toProfile(broker()), 'broker');
    expect(titles(findings).join(' ')).not.toContain('for-hire operating authority');
  });

  it('warns that a bond on file is not a bond with money left in it', () => {
    expect(limitations('broker').join(' ')).toContain('claims against the bond');
  });
});

/* -------------------------------------------------------------------------
 * Staleness
 * ---------------------------------------------------------------------- */

describe('assess, on stale registrations', () => {
  const now = new Date('2026-09-14T00:00:00Z');

  it('flags a census filing FMCSA itself marks outdated', () => {
    const findings = assess(toProfile(carrier({ mcs150Outdated: 'Y' })), 'carrier', now);
    const finding = findings.find((f) => f.title.includes('out of date'));
    expect(finding?.severity).toBe('warning');
  });

  it('notes a filing over two years old even when the flag is not set', () => {
    const findings = assess(
      toProfile(carrier({ mcs150Date: '2023-01-01T00:00:00Z', mcs150Outdated: 'N' })),
      'carrier',
      now,
    );
    const finding = findings.find((f) => f.title.includes('over two years old'));
    expect(finding?.severity).toBe('note');
  });

  it('says nothing about a recent filing', () => {
    const findings = assess(
      toProfile(carrier({ mcs150Date: '2026-06-01T00:00:00Z' })),
      'carrier',
      now,
    );
    expect(titles(findings).join(' ')).not.toContain('two years');
  });
});

/* -------------------------------------------------------------------------
 * The verdict
 * ---------------------------------------------------------------------- */

describe('verdictFrom', () => {
  it('lets one blocking finding outrank any number of warnings', () => {
    expect(
      verdictFrom([
        { severity: 'warning', title: 'a', detail: '' },
        { severity: 'blocking', title: 'b', detail: '' },
        { severity: 'note', title: 'c', detail: '' },
      ]),
    ).toBe('blocked');
  });

  it('is clear when only notes remain', () => {
    expect(verdictFrom([{ severity: 'note', title: 'a', detail: '' }])).toBe('clear');
  });

  it('is clear on an empty assessment', () => {
    expect(verdictFrom([])).toBe('clear');
  });

  it('never says “verified” or “approved”', () => {
    /*
     * The wording matters more than it looks. A green tick reading "verified"
     * invites the belief that the carrier is covered, which this data cannot
     * establish — it only says they are registered and permitted.
     */
    for (const headline of Object.values(VERDICT_HEADLINE)) {
      expect(headline.toLowerCase()).not.toContain('verified');
      expect(headline.toLowerCase()).not.toContain('approved');
    }
    expect(VERDICT_HEADLINE.clear).toBe('Registered and permitted to operate');
  });

  it('always states the limits, including on a clean result', () => {
    expect(limitations('carrier').length).toBeGreaterThan(0);
    expect(limitations('broker').length).toBeGreaterThan(0);
    for (const role of ['carrier', 'broker'] as const) {
      expect(limitations(role).join(' ')).toContain('snapshot');
      expect(limitations(role).join(' ')).toContain('not a credit check');
    }
  });
});

/* -------------------------------------------------------------------------
 * Failure messages
 * ---------------------------------------------------------------------- */

describe('failure messages', () => {
  it('distinguishes a bad key from an unknown carrier', () => {
    /*
     * FMCSA answers both with HTTP 404, so this distinction is the client's to
     * make. Conflating them would report every carrier as unregistered the
     * moment a key expired — the worst possible failure for a check whose job
     * is to say who can be trusted.
     */
    expect(FAILURE_MESSAGE.bad_key).toContain('FMCSA_WEB_KEY');
    expect(FAILURE_MESSAGE.not_found).toContain('no record');
    expect(FAILURE_MESSAGE.bad_key).not.toBe(FAILURE_MESSAGE.not_found);
  });

  it('does not blame the operator for an FMCSA outage', () => {
    expect(FAILURE_MESSAGE.unavailable).toContain('their service');
  });

  it('says how to fix a missing key', () => {
    expect(FAILURE_MESSAGE.no_key).toContain('FMCSA_WEB_KEY');
  });
});
