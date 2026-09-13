/**
 * AIAG / ECG M-22 finished-vehicle transport damage coding.
 *
 * A damage code is five digits, optionally six:
 *   digits 1-2  area
 *   digits 3-4  type
 *   digit  5    severity
 *   digit  6    grid location within the panel (optional, OEM-specific)
 *
 * Example: left front door, scratched, four inches => "10" + "12" + "3" = 10123
 *
 * Left and right are determined as if sitting in the driver's seat.
 *
 * The tables are versioned because the standard revises them — the 2019 and
 * later editions renumbered several areas and added EV-specific codes — and a
 * condition report written in 2026 must still render correctly in 2033.
 */

export const AIAG_CODE_VERSION = '2023';

export interface AiagCode {
  code: string;
  label: string;
  /** Grouping used to lay out the inspection UI. */
  group?: string;
  /** Reserved for an organisation's internal use by the standard. */
  open?: boolean;
}

/* -------------------------------------------------------------------------
 * Severity (digit 5)
 * ---------------------------------------------------------------------- */

export interface AiagSeverity {
  code: string;
  label: string;
  imperial: string;
  metric: string;
}

export const AIAG_SEVERITIES: readonly AiagSeverity[] = [
  { code: '1', label: 'Up to 1 inch', imperial: '≤ 1"', metric: '< 3 cm' },
  { code: '2', label: '1 to 3 inches', imperial: '> 1" to 3"', metric: '3–8 cm' },
  { code: '3', label: '3 to 6 inches', imperial: '> 3" to 6"', metric: '8–15 cm' },
  { code: '4', label: '6 to 12 inches', imperial: '> 6" to 12"', metric: '15–30 cm' },
  { code: '5', label: 'Over 12 inches', imperial: '> 12"', metric: '30 cm+' },
  { code: '6', label: 'Missing or major damage', imperial: '—', metric: '—' },
];

/**
 * Severity 3 and above triggers a hold: the vehicle stays in place or moves
 * to a sick bay for one business day from notification.
 */
export const SEVERITY_REQUIRING_HOLD = 3;

/* -------------------------------------------------------------------------
 * Damage type (digits 3-4)
 * ---------------------------------------------------------------------- */

export const AIAG_DAMAGE_TYPES: readonly AiagCode[] = [
  { code: '01', label: 'Bent', group: 'Deformation' },
  { code: '02', label: 'Broken / major damage', group: 'Deformation' },
  { code: '03', label: 'Cut', group: 'Surface' },
  { code: '04', label: 'Dented — paint or chrome damaged', group: 'Deformation' },
  { code: '05', label: 'Chipped (except glass and panel edge)', group: 'Surface' },
  { code: '06', label: 'Cracked (except glass)', group: 'Surface' },
  { code: '07', label: 'Gouged', group: 'Surface' },
  { code: '08', label: 'Missing (except moulding or emblem)', group: 'Missing' },
  { code: '09', label: 'Scuffed', group: 'Surface' },
  { code: '10', label: 'Stained or soiled — interior', group: 'Interior' },
  { code: '11', label: 'Punctured', group: 'Deformation' },
  { code: '12', label: 'Scratched (except glass)', group: 'Surface' },
  { code: '13', label: 'Torn', group: 'Surface' },
  { code: '14', label: 'Dented — paint and chrome NOT damaged', group: 'Deformation' },
  { code: '15', label: 'Body cover / wrap present or damaged', group: 'Other' },
  { code: '16', label: 'Thermal event or fire', group: 'Other' },
  { code: '18', label: 'Moulding, emblem or weatherstrip damaged', group: 'Trim' },
  { code: '19', label: 'Moulding, emblem or weatherstrip loose', group: 'Trim' },
  { code: '20', label: 'Glass cracked', group: 'Glass' },
  { code: '21', label: 'Glass broken', group: 'Glass' },
  { code: '22', label: 'Glass chipped', group: 'Glass' },
  { code: '23', label: 'Glass scratched', group: 'Glass' },
  { code: '24', label: 'Marker or additional turn light damaged', group: 'Lighting' },
  { code: '25', label: 'Decal or paint stripe damaged', group: 'Surface' },
  { code: '29', label: 'Contamination — exterior', group: 'Other' },
  { code: '30', label: 'Fluid spillage — exterior', group: 'Other' },
  { code: '31', label: 'Theft or vandalism', group: 'Other' },
  { code: '34', label: 'Chipped panel edge', group: 'Surface' },
  { code: '36', label: 'Incorrect part or option not as invoiced', group: 'Other' },
  { code: '37', label: 'Hardware damaged', group: 'Trim' },
  { code: '38', label: 'Hardware loose or missing', group: 'Trim' },
  { code: '39', label: 'Exterior trim loose or missing', group: 'Trim' },
  { code: '40', label: 'Thermal event', group: 'Other' },
  { code: '41', label: 'Gap issues', group: 'Other' },
  { code: '42', label: 'End-door gaps', group: 'Other' },
];

/* -------------------------------------------------------------------------
 * Damage area (digits 1-2)
 * ---------------------------------------------------------------------- */

export const AIAG_DAMAGE_AREAS: readonly AiagCode[] = [
  { code: '01', label: 'Antenna or antenna base', group: 'Exterior' },
  { code: '02', label: 'Battery (small / low voltage)', group: 'Mechanical' },
  { code: '03', label: 'Bumper, cover or extension — front', group: 'Front' },
  { code: '04', label: 'Bumper, cover or extension — rear', group: 'Rear' },
  { code: '05', label: 'Bumper guard or strip — front', group: 'Front' },
  { code: '06', label: 'Bumper guard or strip — rear', group: 'Rear' },
  { code: '07', label: 'Door, back cargo — right', group: 'Doors' },
  { code: '08', label: 'Door, back cargo — left', group: 'Doors' },
  { code: '09', label: 'Door, cargo (sliding), left or right', group: 'Doors' },
  { code: '10', label: 'Door — left front', group: 'Doors' },
  { code: '11', label: 'Door — left rear', group: 'Doors' },
  { code: '12', label: 'Door — right front', group: 'Doors' },
  { code: '13', label: 'Door — right rear', group: 'Doors' },
  { code: '14', label: 'Fender — left front', group: 'Body' },
  { code: '15', label: 'Quarter panel or pickup box — left', group: 'Body' },
  { code: '16', label: 'Fender — right front', group: 'Body' },
  { code: '17', label: 'Quarter panel or pickup box — right', group: 'Body' },
  { code: '18', label: 'Front floor mats', group: 'Interior' },
  { code: '19', label: 'Rear floor mats', group: 'Interior' },
  { code: '20', label: 'Glass — windshield', group: 'Glass' },
  { code: '21', label: 'Glass — rear', group: 'Glass' },
  { code: '22', label: 'Grille', group: 'Front' },
  { code: '23', label: 'Throw-ins / loose items', group: 'Interior' },
  { code: '24', label: 'Headlight, cover or turn signal', group: 'Lighting' },
  { code: '25', label: 'Fog, driving or spot lamps', group: 'Lighting' },
  { code: '26', label: 'Headliner', group: 'Interior' },
  { code: '27', label: 'Hood', group: 'Front' },
  { code: '28', label: 'Keys', group: 'Accessories' },
  { code: '29', label: 'Keyless remote or key fobs', group: 'Accessories' },
  { code: '30', label: 'Mirror, outside — left', group: 'Exterior' },
  { code: '31', label: 'Mirror, outside — right', group: 'Exterior' },
  { code: '32', label: 'Major damage (do not use)', group: 'Other' },
  { code: '33', label: 'Front multimedia or speakers', group: 'Interior' },
  { code: '34', label: 'Rear multimedia or speakers', group: 'Interior' },
  { code: '35', label: 'Rocker panel or sill — left', group: 'Body' },
  { code: '36', label: 'Rocker panel or sill — right', group: 'Body' },
  { code: '37', label: 'Roof', group: 'Body' },
  { code: '38', label: 'Running board or step — left', group: 'Body' },
  { code: '39', label: 'Running board or step — right', group: 'Body' },
  { code: '40', label: 'Spare tire', group: 'Wheels' },
  { code: '41', label: 'EV charging cable', group: 'Accessories' },
  { code: '42', label: 'Splash panel or spoiler — front', group: 'Front' },
  { code: '43', label: 'Reserved', group: 'Other', open: true },
  { code: '44', label: 'Gas tank', group: 'Mechanical' },
  { code: '45', label: 'Tail light or hardware', group: 'Lighting' },
  { code: '46', label: 'Truck cab — rear', group: 'Body', open: true },
  { code: '47', label: 'Corner post or pillar — rear right', group: 'Body', open: true },
  { code: '48', label: 'Interior trim panel — left front', group: 'Interior' },
  { code: '49', label: 'Battery (large / high voltage)', group: 'Mechanical' },
  { code: '50', label: 'Interior trim panel — right front', group: 'Interior' },
  { code: '51', label: 'Tonneau cover', group: 'Exterior', open: true },
  { code: '52', label: 'Deck lid, tailgate or hatchback', group: 'Rear' },
  { code: '53', label: 'Sunroof or glass roof', group: 'Glass' },
  { code: '54', label: 'Undercarriage or other', group: 'Mechanical' },
  { code: '55', label: 'Cargo area', group: 'Interior' },
  { code: '56', label: 'Convertible top', group: 'Body' },
  { code: '57', label: 'Wheel covers or caps', group: 'Wheels' },
  { code: '58', label: 'Reserved', group: 'Other', open: true },
  { code: '59', label: 'Wipers — all', group: 'Exterior' },
  { code: '60', label: 'Jumped chocks', group: 'Securement' },
  { code: '61', label: 'Box interior — pickup', group: 'Body' },
  { code: '62', label: 'Entire vehicle', group: 'Other', open: true },
  { code: '63', label: 'Rails, truck bed or light bar', group: 'Body' },
  { code: '64', label: 'Deflector or spoiler — rear', group: 'Rear' },
  { code: '65', label: 'Luggage rack, strips or drip rail', group: 'Exterior' },
  { code: '66', label: 'Dash or instrument panel', group: 'Interior' },
  { code: '67', label: 'Reserved', group: 'Other', open: true },
  { code: '68', label: 'Carpet — front', group: 'Interior' },
  { code: '69', label: 'Centre post — right', group: 'Body' },
  { code: '70', label: 'Centre post — left', group: 'Body' },
  { code: '71', label: 'Corner post or pillar — rear left', group: 'Body' },
  { code: '72', label: 'Left front tire', group: 'Wheels' },
  { code: '73', label: 'Left front wheel or rim', group: 'Wheels' },
  { code: '74', label: 'Left rear tire', group: 'Wheels' },
  { code: '75', label: 'Left rear wheel or rim', group: 'Wheels' },
  { code: '76', label: 'Right rear tire', group: 'Wheels' },
  { code: '77', label: 'Right rear wheel or rim', group: 'Wheels' },
  { code: '78', label: 'Right front tire', group: 'Wheels' },
  { code: '79', label: 'Right front wheel or rim', group: 'Wheels' },
  { code: '80', label: 'Cowl', group: 'Body' },
  { code: '81', label: 'Gas or battery door, fuel cap', group: 'Exterior' },
  { code: '82', label: 'Fender — left rear', group: 'Body' },
  { code: '83', label: 'Fender — right rear', group: 'Body' },
  { code: '84', label: 'Tools, jacks or spare mount', group: 'Accessories' },
  { code: '85', label: 'Improper chock securement', group: 'Securement' },
  { code: '86', label: 'Parking sonar system', group: 'Exterior' },
  { code: '87', label: 'A-pillar or corner post — front left', group: 'Body', open: true },
  { code: '88', label: 'A-pillar or corner post — front right', group: 'Body', open: true },
  { code: '89', label: 'Trailer hitch, wiring or tow hooks', group: 'Rear' },
  { code: '90', label: 'Frame', group: 'Mechanical' },
  { code: '91', label: 'Exhaust system', group: 'Mechanical' },
  { code: '92', label: 'License bracket', group: 'Exterior' },
  { code: '93', label: 'Steering wheel or airbag', group: 'Interior' },
  { code: '94', label: 'Seat — left front', group: 'Interior' },
  { code: '95', label: 'Seat — right front', group: 'Interior' },
  { code: '96', label: 'Seat — rear', group: 'Interior' },
  { code: '97', label: 'Carpet — rear', group: 'Interior' },
  { code: '98', label: 'Interior', group: 'Interior' },
  { code: '99', label: 'Engine compartment, other', group: 'Mechanical' },
];

/* -------------------------------------------------------------------------
 * Inspection location codes
 * ---------------------------------------------------------------------- */

export const AIAG_INSPECTION_LOCATIONS: readonly AiagCode[] = [
  { code: '01', label: 'Origin rail' },
  { code: '02', label: 'Interchange' },
  { code: '03', label: 'Railroad interchange' },
  { code: '04', label: 'Destination ramp' },
  { code: '05', label: 'Dealer' },
  { code: '06', label: 'Factory gate' },
  { code: '07', label: 'Origin cursory — rail' },
  { code: '08', label: 'Destination cursory — rail' },
  { code: '09', label: 'Marine discharge' },
  { code: '90', label: 'Delivery with notification' },
  { code: '98', label: 'Dealer receipt' },
  { code: '99', label: 'Letter of notification' },
];

/* -------------------------------------------------------------------------
 * Lookup and composition
 * ---------------------------------------------------------------------- */

const AREA_BY_CODE = new Map(AIAG_DAMAGE_AREAS.map((a) => [a.code, a]));
const TYPE_BY_CODE = new Map(AIAG_DAMAGE_TYPES.map((t) => [t.code, t]));
const SEVERITY_BY_CODE = new Map(AIAG_SEVERITIES.map((s) => [s.code, s]));

export interface ParsedDamageCode {
  area: AiagCode;
  type: AiagCode;
  severity: AiagSeverity;
  /** Panel subdivision 1-9, reading like a phone keypad. Optional. */
  grid: string | null;
}

/** Builds a 5- or 6-digit code. Returns null if any component is unknown. */
export function composeDamageCode(
  area: string,
  type: string,
  severity: string,
  grid?: string | null,
): string | null {
  if (!AREA_BY_CODE.has(area) || !TYPE_BY_CODE.has(type) || !SEVERITY_BY_CODE.has(severity)) {
    return null;
  }
  const base = `${area}${type}${severity}`;
  if (grid && /^[1-9]$/.test(grid)) return `${base}${grid}`;
  return base;
}

/** Parses a 5- or 6-digit code back into its labelled components. */
export function parseDamageCode(code: string): ParsedDamageCode | null {
  if (!/^\d{5,6}$/.test(code)) return null;

  const area = AREA_BY_CODE.get(code.slice(0, 2));
  const type = TYPE_BY_CODE.get(code.slice(2, 4));
  const severity = SEVERITY_BY_CODE.get(code.slice(4, 5));
  if (!area || !type || !severity) return null;

  const grid = code.length === 6 ? (code.slice(5, 6) ?? null) : null;
  return { area, type, severity, grid };
}

/** Renders a code as a sentence for the condition report and BOL. */
export function describeDamageCode(code: string): string | null {
  const parsed = parseDamageCode(code);
  if (!parsed) return null;
  const grid = parsed.grid ? `, zone ${parsed.grid}` : '';
  return `${parsed.area.label} — ${parsed.type.label} (${parsed.severity.label}${grid})`;
}

/** True when this damage requires the vehicle to be held. */
export function requiresHold(code: string): boolean {
  const parsed = parseDamageCode(code);
  if (!parsed) return false;
  return Number(parsed.severity.code) >= SEVERITY_REQUIRING_HOLD;
}

/* -------------------------------------------------------------------------
 * Non-transportation damage
 * ---------------------------------------------------------------------- */

/**
 * Conditions the standard treats as not caused by transport, and therefore
 * not the carrier's liability.
 *
 * Surfacing these at inspection time is the point: a driver who tags a paint
 * run as carrier damage has created a claim against their own company.
 */
export const NON_TRANSPORTATION_DAMAGE: readonly string[] = [
  'Paint runs, sags, blisters, orange peel or other finish defects',
  'Severity-1 dents with no paint damage, except on the left front door',
  'Missing emblems where no installation holes are present',
  'Stress cracks originating from under a moulding',
  'Mis-built vehicles or incorrect factory options',
  'Manufacturing weld or seam-sealer irregularities',
  'Underbody surface rust on unpainted components',
  'Tire flat-spotting from storage',
  'Wheel or rim corrosion without impact damage',
  'Wear consistent with the vehicle already being in service',
];

/**
 * Conditions explicitly NOT treated as concealed damage, so they cannot be
 * raised after delivery has been signed clean.
 */
export const NOT_CONCEALED_DAMAGE: readonly string[] = [
  'Cracked windshield',
  'Damaged bumper',
  'Damage that went undetected because the vehicle was dirty or snow-covered',
  'Damage beneath undisturbed transit wrap',
];

/** Window for reporting genuinely concealed damage, in business days. */
export const CONCEALED_DAMAGE_WINDOW_DAYS = 2;

/**
 * Photo minimums by inspection tier.
 *
 * The advanced tier's twelve-photo floor is what the paid platforms enforce
 * for payment-guaranteed loads, and it is the evidentiary bar a Carmack
 * defence actually needs.
 */
export const PHOTO_REQUIREMENTS = {
  standard: { perStage: 0, perDamage: 0, requiresSignature: false },
  advanced: { perStage: 6, perDamage: 1, requiresSignature: true },
  aiag: { perStage: 6, perDamage: 2, requiresSignature: true },
} as const;

/**
 * The walk-around order the standard prescribes: rear, then each side back to
 * front, then front, then interior — each ending by stepping back to view the
 * whole face. Three minutes per vehicle.
 */
export const INSPECTION_SEQUENCE = [
  { slot: 'rear', label: 'Rear', hint: 'Step back far enough to see the whole rear face' },
  { slot: 'left_rear', label: 'Left rear 3/4', hint: 'Corner view showing rear and left side' },
  { slot: 'left', label: 'Left side', hint: 'Perpendicular, full length in frame' },
  { slot: 'left_front', label: 'Left front 3/4', hint: 'Corner view showing front and left side' },
  { slot: 'front', label: 'Front', hint: 'Square to the grille' },
  { slot: 'right_front', label: 'Right front 3/4', hint: 'Corner view showing front and right side' },
  { slot: 'right', label: 'Right side', hint: 'Perpendicular, full length in frame' },
  { slot: 'right_rear', label: 'Right rear 3/4', hint: 'Corner view showing rear and right side' },
  { slot: 'roof', label: 'Roof', hint: 'Hail and overhead damage' },
  { slot: 'odometer', label: 'Odometer', hint: 'Reading must be legible' },
  { slot: 'vin_plate', label: 'VIN plate', hint: 'Door jamb or dash plate' },
  { slot: 'interior', label: 'Interior', hint: 'Seats, dash and carpet' },
] as const;

export type PhotoSlot = (typeof INSPECTION_SEQUENCE)[number]['slot'];
