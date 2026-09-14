import { classifyVin, normalizeVin } from '@/lib/vin';
import { parseMoney } from '@/lib/invoices/compute';
import { VEHICLE_TYPES, type TransportType, type VehicleType } from '@/lib/db/schema';
import { cell, type CsvRow, type CsvTable } from './csv';
import type { ColumnMapping } from './columns';

/**
 * Turning a mapped grid into loads nobody has saved yet.
 *
 * This is the part that has to be pessimistic. An import that half-works is
 * worse than one that refuses: two hundred loads with the month and day
 * swapped, or with a broker's price recorded as the driver's pay, take longer
 * to find and unpick than they ever took to create. So every value that
 * cannot be read confidently is left unset and *said out loud*, and nothing
 * here writes anything — the caller shows this to a person first.
 *
 * Problems come in two weights. An `error` stops that load importing, because
 * what is wrong with it cannot be filled in later from anywhere. A `warning`
 * lets it through with a gap, because a load with no delivery date is a
 * normal load and a load that never got imported is lost work.
 */

export interface Problem {
  /** Line in the original file, or null for something about the load as a whole. */
  line: number | null;
  severity: 'error' | 'warning';
  message: string;
}

export interface ParsedVehicle {
  line: number;
  vin: string;
  /** Null for a legacy VIN, which has no check digit to verify. */
  vinCheckDigitValid: boolean | null;
  year: number | null;
  make: string | null;
  model: string | null;
  color: string | null;
  vehicleType: VehicleType | null;
  lotNumber: string | null;
  isInoperable: boolean;
}

export interface ParsedStop {
  name: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  contactName: string | null;
  contactPhone: string | null;
  scheduledAt: Date | null;
}

export interface ParsedCustomer {
  name: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
}

export interface ParsedLoad {
  /** The key rows were grouped on, uppercased. Null when the file has no load number. */
  key: string | null;
  /** As spelled in the file. Null means one is assigned on import. */
  number: string | null;
  lines: number[];
  customer: ParsedCustomer;
  rateCents: number | null;
  tariffCents: number | null;
  distanceMiles: number | null;
  transportType: TransportType | null;
  instructions: string | null;
  pickup: ParsedStop;
  delivery: ParsedStop;
  vehicles: ParsedVehicle[];
  problems: Problem[];
}

/* -------------------------------------------------------------------------
 * Reading single values
 * ---------------------------------------------------------------------- */

const MAX_VEHICLES_PER_LOAD = 12;

/** Nothing in a spreadsheet cell means nothing, however the exporter spelled it. */
const BLANKS = new Set(['', '-', '--', 'n/a', 'na', 'none', 'null', 'tbd', 'unknown', '#n/a']);

function text(value: string | null, max: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (BLANKS.has(trimmed.toLowerCase())) return null;
  return trimmed.slice(0, max);
}

const TRUE_WORDS = new Set(['y', 'yes', 'true', '1', 'x', 'inop', 'inoperable', 'non-runner']);
const FALSE_WORDS = new Set(['n', 'no', 'false', '0', 'runs', 'operable', 'running']);

/** Null rather than false for anything unrecognised — an unread flag is not a "no". */
export function parseFlag(value: string | null): boolean | null {
  const raw = text(value, 40)?.toLowerCase();
  if (!raw) return null;
  if (TRUE_WORDS.has(raw)) return true;
  if (FALSE_WORDS.has(raw)) return false;
  return null;
}

export function parseCount(value: string | null, max: number): number | null {
  const raw = text(value, 20);
  if (!raw) return null;
  const digits = raw.replace(/[,\s]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  const parsed = Number.parseInt(digits, 10);
  return parsed > max ? null : parsed;
}

/**
 * Model year, bounded by what a VIN can mean.
 *
 * Two digits are read as 19xx or 20xx around a 30-year window, the same
 * convention a title clerk uses. Outside 1900-2100 it is a typo or a row
 * number that landed in the wrong column, and guessing there is worse than
 * leaving the year blank.
 */
export function parseYear(value: string | null, now = new Date()): number | null {
  const raw = text(value, 10);
  if (!raw) return null;
  if (!/^\d{2}$|^\d{4}$/.test(raw)) return null;

  const parsed = Number.parseInt(raw, 10);
  if (raw.length === 2) {
    const century = Math.floor(now.getFullYear() / 100) * 100;
    const candidate = century + parsed;
    return candidate > now.getFullYear() + 1 ? candidate - 100 : candidate;
  }

  return parsed >= 1900 && parsed <= 2100 ? parsed : null;
}

const ENCLOSED = /enclos|cover|hard\s*side|box/i;
const OPEN = /open|flat|soft\s*side/i;

export function parseTransportType(value: string | null): TransportType | null {
  const raw = text(value, 60);
  if (!raw) return null;
  if (ENCLOSED.test(raw)) return 'enclosed';
  if (OPEN.test(raw)) return 'open';
  return null;
}

/**
 * Body type, mapped conservatively.
 *
 * Only shapes that change how a vehicle is loaded are worth recognising, and
 * only where the word is unambiguous. Anything else stays null and the load
 * takes the schema default, because a wrong body type on a bill of lading is
 * a discrepancy a receiving dealer can refuse over.
 */
export function parseVehicleType(value: string | null): VehicleType | null {
  const raw = text(value, 60)?.toLowerCase();
  if (!raw) return null;

  const direct = raw.replace(/[\s-]+/g, '_');
  const exact = VEHICLE_TYPES.find((type) => type === direct);
  if (exact) return exact;

  if (/motorcycle|motorbike/.test(raw)) return 'motorcycle';
  if (/\bsuv\b|sport\s*utility|crossover/.test(raw)) return 'suv';
  if (/pick\s*-?\s*up|\butes?\b/.test(raw)) return 'pickup';
  if (/minivan|\bvan\b|cargo\s*van/.test(raw)) return 'van';
  if (/\brv\b|motorhome|camper/.test(raw)) return 'rv';
  if (/\batv\b|utv|quad/.test(raw)) return 'atv';
  if (/\bboat\b|vessel/.test(raw)) return 'boat';
  if (/trailer/.test(raw)) return 'trailer_bumper_pull';
  if (/excavator|bobcat|skid\s*steer|tractor|forklift|machinery/.test(raw)) return 'heavy_machinery';
  if (/coupe|2\s*-?\s*door/.test(raw)) return '2_door_coupe';
  if (/sedan|car\b|saloon|hatch|wagon/.test(raw)) return 'sedan';

  return null;
}

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})/;
const US_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/;
const TIME = /(\d{1,2}):(\d{2})\s*(am|pm)?/i;

export type DateReading =
  | { ok: true; date: Date | null }
  | { ok: false; reason: 'ambiguous' | 'unreadable' };

/**
 * Reads a date the American way, and refuses rather than guess.
 *
 * `03/04/2026` is March 4th here, because these files come from US dispatch
 * boards. `25/12/2026` cannot be read that way at all — and rather than
 * silently switch conventions for one cell in a file read month-first
 * everywhere else, it is reported. A day-first file should be exported as
 * ISO; that is a five-second fix in a spreadsheet and the alternative is a
 * whole import off by months in places nobody will check.
 */
export function parseDate(value: string | null): DateReading {
  const raw = text(value, 60);
  if (!raw) return { ok: true, date: null };

  // A window like "3/4/2026 - 3/6/2026" commits to the first date: that is
  // when the vehicle is ready, which is what a stop time means here.
  const head = raw.split(/\s+(?:-|–|to|through|thru)\s+/i)[0] ?? raw;

  let year: number;
  let month: number;
  let day: number;

  const iso = ISO_DATE.exec(head);
  const us = iso ? null : US_DATE.exec(head);

  if (iso) {
    year = Number.parseInt(iso[1]!, 10);
    month = Number.parseInt(iso[2]!, 10);
    day = Number.parseInt(iso[3]!, 10);
  } else if (us) {
    month = Number.parseInt(us[1]!, 10);
    day = Number.parseInt(us[2]!, 10);
    const rawYear = us[3]!;
    year = Number.parseInt(rawYear, 10);
    if (rawYear.length === 2) year += 2000;
    if (month > 12 && day <= 12) return { ok: false, reason: 'ambiguous' };
  } else {
    return { ok: false, reason: 'unreadable' };
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return { ok: false, reason: 'unreadable' };
  if (year < 1900 || year > 2100) return { ok: false, reason: 'unreadable' };

  let hours = 0;
  let minutes = 0;
  // Only within the first date of a window: "3/4 08:00 - 3/6 17:00" opens at
  // eight, and taking the far end's time would invent a later appointment.
  const time = TIME.exec(head);
  if (time) {
    hours = Number.parseInt(time[1]!, 10);
    minutes = Number.parseInt(time[2]!, 10);
    const meridiem = time[3]?.toLowerCase();
    if (meridiem === 'pm' && hours < 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
    if (hours > 23 || minutes > 59) {
      hours = 0;
      minutes = 0;
    }
  }

  const date = new Date(year, month - 1, day, hours, minutes);
  // Rejects the 31st of a 30-day month rather than rolling it into the next.
  if (date.getMonth() !== month - 1 || date.getDate() !== day) {
    return { ok: false, reason: 'unreadable' };
  }

  return { ok: true, date };
}

const STATES = /^[A-Za-z]{2}$/;

/**
 * Two-letter codes, plus the full names people type instead.
 *
 * `venues.state` is two characters, so truncating "Texas" would store `TE` —
 * a state that does not exist, on a bill of lading, silently. Anything not on
 * this list is left blank instead.
 */
const STATE_NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', districtofcolumbia: 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
  minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', newhampshire: 'NH', newjersey: 'NJ',
  newmexico: 'NM', newyork: 'NY', northcarolina: 'NC', northdakota: 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  puertorico: 'PR', rhodeisland: 'RI', southcarolina: 'SC', southdakota: 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA',
  washington: 'WA', westvirginia: 'WV', wisconsin: 'WI', wyoming: 'WY',
  // Cross-border moves are rare but real, and a province code is still two
  // characters — reading one is better than storing half its name.
  alberta: 'AB', britishcolumbia: 'BC', manitoba: 'MB', newbrunswick: 'NB',
  newfoundland: 'NL', novascotia: 'NS', ontario: 'ON', princeedwardisland: 'PE',
  quebec: 'QC', saskatchewan: 'SK',
};

export function parseState(value: string | null): string | null {
  const raw = text(value, 60);
  if (!raw) return null;
  if (STATES.test(raw)) return raw.toUpperCase();
  return STATE_NAMES[raw.toLowerCase().replace(/[^a-z]/g, '')] ?? null;
}

/**
 * Splits a single "Dallas, TX 75201" cell.
 *
 * Load boards publish origin and destination as one string far more often
 * than as three columns, and throwing that away leaves an imported load with
 * no idea where it goes.
 */
export function parseLocation(value: string | null): {
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
} {
  const raw = text(value, 200);
  if (!raw) return { addressLine1: null, city: null, state: null, postalCode: null };

  let rest = raw;
  let postalCode: string | null = null;

  const zip = /\b(\d{5})(?:-\d{4})?\s*$/.exec(rest);
  if (zip) {
    postalCode = zip[1]!;
    rest = rest.slice(0, zip.index).trim();
  }

  rest = rest.replace(/[,\s]+$/, '');

  const parts = rest
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    const state = parseState(parts[parts.length - 1]!);
    if (state) {
      /*
       * Everything before the city is street. A board that publishes origin
       * as one string often includes the yard's address, and folding that
       * into the city gives a load whose city is "4550 Blue Mound Rd" —
       * wrong on the screen, wrong in a search, and wrong on a document.
       */
      return {
        addressLine1: parts.length >= 3 ? parts.slice(0, -2).join(', ') : null,
        city: parts[parts.length - 2] ?? null,
        state,
        postalCode,
      };
    }
    return { addressLine1: null, city: rest || null, state: null, postalCode };
  }

  // No comma: "Dallas TX" is still the common shape.
  const trailing = /^(.*?)\s+([A-Za-z]{2})$/.exec(rest);
  if (trailing && trailing[1]!.trim()) {
    return {
      addressLine1: null,
      city: trailing[1]!.trim(),
      state: trailing[2]!.toUpperCase(),
      postalCode,
    };
  }

  return { addressLine1: null, city: rest || null, state: null, postalCode };
}

/**
 * One cell, possibly several VINs.
 *
 * Brokers write "VINs: 1HG…, 5YJ…" in one column constantly. Splitting on
 * separators a VIN cannot contain is safe; whitespace is deliberately not one
 * of them, because `normalizeVin` already repairs a VIN typed with a space in
 * the middle and splitting there would turn one vehicle into two fragments.
 */
export function splitVins(value: string | null): string[] {
  const raw = text(value, 1000);
  if (!raw) return [];
  return raw
    .split(/[,;|/\n\r]+/)
    .map((part) => normalizeVin(part))
    .filter((part) => part.length > 0 && !isPlaceholderVin(part));
}

/**
 * Words that occupy a VIN column while somebody waits for the real one.
 *
 * A pre-1981 VIN is five to sixteen characters of letters and digits, and so
 * is `PENDING`. Length cannot separate them, so the placeholders are named —
 * and a string of one repeated character is added, because `XXXXXXXXXXXXXXXXX`
 * is the other way people fill the column in.
 */
const PLACEHOLDER_VINS = new Set([
  'PENDING',
  'VINPENDING',
  'TBD',
  'TBA',
  'NOVIN',
  'NONE',
  'UNKNOWN',
  'NA',
  'VIN',
  'TEST',
  'SAMPLE',
]);

export function isPlaceholderVin(vin: string): boolean {
  return PLACEHOLDER_VINS.has(vin) || /^(.)\1+$/.test(vin);
}

/* -------------------------------------------------------------------------
 * Reading a whole file
 * ---------------------------------------------------------------------- */

function blankStop(): ParsedStop {
  return {
    name: null,
    addressLine1: null,
    city: null,
    state: null,
    postalCode: null,
    contactName: null,
    contactPhone: null,
    scheduledAt: null,
  };
}

/** True once a stop carries anything at all. */
export function stopHasAnything(stop: ParsedStop): boolean {
  return Object.values(stop).some((value) => value !== null);
}

/**
 * What to call this place.
 *
 * A residential pickup has no business name and never will — the person is
 * the venue. Using the contact there is not a substitution, it is what the
 * bill of lading says anyway.
 */
export function venueName(stop: ParsedStop): string | null {
  return stop.name ?? stop.contactName;
}

/**
 * What a venue row still needs. The schema requires all five.
 *
 * Named rather than counted, because "incomplete" sends somebody back to the
 * file to work out what is missing and "needs a business name and a ZIP" does
 * not.
 */
export function missingForVenue(stop: ParsedStop): string[] {
  const required: Array<[string | null, string]> = [
    [venueName(stop), 'a business or contact name'],
    [stop.addressLine1, 'a street address'],
    [stop.city, 'a city'],
    [stop.state, 'a state'],
    [stop.postalCode, 'a ZIP'],
  ];
  return required.filter(([value]) => !value).map(([, label]) => label);
}

/** True when the stop can become a venue row. */
export function stopIsComplete(stop: ParsedStop): boolean {
  return missingForVenue(stop).length === 0;
}

/** A one-line description of a stop that is known but not addressable. */
export function describeStop(stop: ParsedStop): string {
  const place = [stop.city, stop.state].filter(Boolean).join(', ');
  return [venueName(stop), stop.addressLine1, place, stop.postalCode].filter(Boolean).join(' · ');
}

/** Fills gaps in `into` from a later row; the first row to say something wins. */
function mergeStop(into: ParsedStop, from: ParsedStop): void {
  into.name ??= from.name;
  into.addressLine1 ??= from.addressLine1;
  into.city ??= from.city;
  into.state ??= from.state;
  into.postalCode ??= from.postalCode;
  into.contactName ??= from.contactName;
  into.contactPhone ??= from.contactPhone;
  into.scheduledAt ??= from.scheduledAt;
}

interface Draft extends ParsedLoad {
  /** Carried per load so a disagreement is only reported once. */
  conflicts: Set<string>;
}

function firstWins<T>(
  draft: Draft,
  label: string,
  current: T | null,
  incoming: T | null,
  line: number,
): T | null {
  if (incoming === null) return current;
  if (current === null) return incoming;
  if (current !== incoming && !draft.conflicts.has(label)) {
    draft.conflicts.add(label);
    draft.problems.push({
      line,
      severity: 'warning',
      message: `Rows in this load disagree about ${label}. The first one was kept.`,
    });
  }
  return current;
}

function readStop(
  row: CsvRow,
  mapping: ColumnMapping,
  prefix: 'pickup' | 'delivery',
  problems: Problem[],
): ParsedStop {
  const at = (suffix: string) =>
    cell(row, mapping[`${prefix}${suffix}` as keyof ColumnMapping] ?? null);

  const combined = parseLocation(at('Location'));

  const stop: ParsedStop = {
    name: text(at('Name'), 120),
    addressLine1: text(at('Address'), 160) ?? combined.addressLine1,
    city: text(at('City'), 80) ?? combined.city,
    state: parseState(at('State')) ?? combined.state,
    postalCode: text(at('Zip'), 12) ?? combined.postalCode,
    contactName: text(at('Contact'), 120),
    contactPhone: text(at('Phone'), 32),
    scheduledAt: null,
  };

  const reading = parseDate(at('Date'));
  if (reading.ok) {
    stop.scheduledAt = reading.date;
  } else {
    problems.push({
      line: row.line,
      severity: 'warning',
      message:
        reading.reason === 'ambiguous'
          ? `The ${prefix} date is day-first, and dates here are read month-first. It was left blank — export as YYYY-MM-DD to keep it.`
          : `The ${prefix} date could not be read. It was left blank.`,
    });
  }

  return stop;
}

function newDraft(key: string | null, number: string | null): Draft {
  return {
    key,
    number,
    lines: [],
    customer: { name: null, contactName: null, email: null, phone: null },
    rateCents: null,
    tariffCents: null,
    distanceMiles: null,
    transportType: null,
    instructions: null,
    pickup: blankStop(),
    delivery: blankStop(),
    vehicles: [],
    problems: [],
    conflicts: new Set(),
  };
}

/**
 * Reads the whole table into loads.
 *
 * Rows sharing a load number become one load with several vehicles, which is
 * how every board exports a multi-car order. Without a load-number column
 * each row is its own load — the alternative, folding unrelated rows
 * together, would be silently destructive.
 */
export function readTable(table: CsvTable, mapping: ColumnMapping): ParsedLoad[] {
  const grouped = new Map<string, Draft>();
  const ordered: Draft[] = [];

  table.rows.forEach((row, index) => {
    const numberCell = text(cell(row, mapping.loadNumber ?? null), 60);
    const key = numberCell ? numberCell.toUpperCase() : `__row_${index}`;

    const existing = grouped.get(key);
    const draft = existing ?? newDraft(numberCell ? key : null, numberCell);
    if (!existing) {
      grouped.set(key, draft);
      ordered.push(draft);
    }

    draft.lines.push(row.line);

    const at = (field: keyof ColumnMapping) => cell(row, mapping[field] ?? null);
    const line = row.line;

    const keep = <T,>(label: string, current: T | null, incoming: T | null) =>
      firstWins(draft, label, current, incoming, line);

    draft.customer.name = keep('the customer', draft.customer.name, text(at('customerName'), 160));
    draft.customer.contactName ??= text(at('customerContact'), 120);
    draft.customer.email ??= text(at('customerEmail'), 160);
    draft.customer.phone ??= text(at('customerPhone'), 32);

    draft.rateCents = keep('the carrier pay', draft.rateCents, parseMoney(at('rate')));
    draft.tariffCents = keep('the customer price', draft.tariffCents, parseMoney(at('tariff')));
    draft.distanceMiles ??= parseCount(at('distanceMiles'), 20_000);
    draft.transportType = keep(
      'open or enclosed',
      draft.transportType,
      parseTransportType(at('transportType')),
    );

    const instructions = text(at('instructions'), 4000);
    if (instructions && !draft.instructions?.includes(instructions)) {
      draft.instructions = draft.instructions
        ? `${draft.instructions}\n${instructions}`.slice(0, 4000)
        : instructions;
    }

    for (const side of ['pickup', 'delivery'] as const) {
      mergeStop(draft[side], readStop(row, mapping, side, draft.problems));
    }

    const vins = splitVins(at('vin'));
    const inoperable = parseFlag(at('inoperable')) ?? false;

    if (vins.length === 0) {
      draft.problems.push({
        line,
        severity: 'error',
        message: 'No VIN on this row.',
      });
      return;
    }

    if (vins.length > 1) {
      draft.problems.push({
        line,
        severity: 'warning',
        message: `${vins.length} VINs in one cell became ${vins.length} vehicles. Year, make and model were left off — there was no way to tell which VIN each belonged to.`,
      });
    }

    const single = vins.length === 1;

    for (const candidate of vins) {
      const classified = classifyVin(candidate);

      if (classified.kind === 'invalid') {
        draft.problems.push({
          line,
          severity: 'error',
          message: `"${candidate}" is not a usable VIN — ${classified.reason.toLowerCase()}.`,
        });
        continue;
      }

      if (classified.kind === 'modern' && !classified.checkDigitValid) {
        draft.problems.push({
          line,
          severity: 'warning',
          message: `${candidate} fails its check digit, which usually means a character was mistyped. It will import as written.`,
        });
      }

      if (draft.vehicles.some((vehicle) => vehicle.vin === classified.vin)) {
        draft.problems.push({
          line,
          severity: 'warning',
          message: `${classified.vin} appears more than once on this load. The repeat was dropped.`,
        });
        continue;
      }

      draft.vehicles.push({
        line,
        vin: classified.vin,
        vinCheckDigitValid: classified.kind === 'modern' ? classified.checkDigitValid : null,
        year: single ? parseYear(at('year')) : null,
        make: single ? text(at('make'), 80) : null,
        model: single ? text(at('model'), 80) : null,
        color: single ? text(at('color'), 40) : null,
        vehicleType: single ? parseVehicleType(at('vehicleType')) : null,
        lotNumber: text(at('lotNumber'), 40),
        isInoperable: inoperable,
      });
    }
  });

  for (const draft of ordered) {
    // Only when nothing has already said why. A row that reported a missing
    // or unusable VIN has explained this, and saying it twice reads as two
    // separate faults to chase.
    const alreadyBlocked = draft.problems.some((problem) => problem.severity === 'error');
    if (draft.vehicles.length === 0 && !alreadyBlocked) {
      draft.problems.push({
        line: null,
        severity: 'error',
        message: 'No vehicle on this load, so there is nothing to haul.',
      });
    }

    if (draft.vehicles.length > MAX_VEHICLES_PER_LOAD) {
      draft.problems.push({
        line: null,
        severity: 'error',
        message: `${draft.vehicles.length} vehicles on one load. A trailer holds ${MAX_VEHICLES_PER_LOAD}, so this is more likely a load number reused for two orders.`,
      });
    }

    for (const side of ['pickup', 'delivery'] as const) {
      const stop = draft[side];
      if (!stopHasAnything(stop)) {
        draft.problems.push({
          line: null,
          severity: 'warning',
          message: `Nothing in the file says where this load ${side === 'pickup' ? 'picks up' : 'delivers'}.`,
        });
      } else {
        const missing = missingForVenue(stop);
        if (missing.length > 0) {
          draft.problems.push({
            line: null,
            severity: 'warning',
            message: `The ${side} still needs ${missing.join(', ')}, so no address is saved — "${describeStop(stop)}" is kept as a note on the stop instead. A bill of lading needs the full address.`,
          });
        }
      }
    }
  }

  return ordered.map(({ conflicts: _conflicts, ...load }) => load);
}

/** Loads with nothing blocking them. */
export function importable(loads: ParsedLoad[]): ParsedLoad[] {
  return loads.filter((load) => !load.problems.some((problem) => problem.severity === 'error'));
}

export function countProblems(loads: ParsedLoad[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const load of loads) {
    for (const problem of load.problems) {
      if (problem.severity === 'error') errors += 1;
      else warnings += 1;
    }
  }
  return { errors, warnings };
}
