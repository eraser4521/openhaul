import type { AccessorialUnit } from '../db/schema';

/**
 * Arithmetic for itemised accessorials.
 *
 * The point of itemising at all is that the customer can check the figure
 * without a phone call, so every line has to show its own working: the
 * quantity, the unit rate and the product, each derived from the two stored
 * integers rather than carried as a third. A quantity corrected from 4 hours
 * to 3.5 then cannot leave a stale extension behind it.
 *
 * Quantity is hundredths of a unit because detention is billed in half hours
 * and storage in part days. Floats are not used here for the same reason they
 * are not used for money.
 */

export interface AccessorialLine {
  label: string;
  code: string | null;
  unit: AccessorialUnit;
  quantityHundredths: number;
  unitCents: number;
  note?: string | null;
}

/**
 * Quantity times rate, in cents.
 *
 * Rounds half away from zero rather than using `Math.round`, which rounds
 * -0.5 up to 0 and would make a reversal and its original disagree by a cent.
 */
export function extendedCents(line: { quantityHundredths: number; unitCents: number }): number {
  const product = line.quantityHundredths * line.unitCents;
  const sign = product < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(product) / 100);
}

export function sumAccessorials(
  lines: Array<{ quantityHundredths: number; unitCents: number }>,
): number {
  return lines.reduce((total, line) => total + extendedCents(line), 0);
}

export const UNIT_LABEL: Record<AccessorialUnit, string> = {
  flat: 'flat',
  per_hour: 'per hour',
  per_day: 'per day',
  per_mile: 'per mile',
  per_vehicle: 'per vehicle',
};

/** What the quantity is counting, singular or plural to match it. */
export function unitNoun(unit: AccessorialUnit, quantityHundredths: number): string {
  const one = quantityHundredths === 100;
  switch (unit) {
    case 'per_hour':
      return one ? 'hr' : 'hrs';
    case 'per_day':
      return one ? 'day' : 'days';
    case 'per_mile':
      return one ? 'mile' : 'miles';
    case 'per_vehicle':
      return one ? 'vehicle' : 'vehicles';
    case 'flat':
      return '';
  }
}

/** Trims the decimals a whole quantity does not need: 3.5, but 2 rather than 2.00. */
export function formatQuantity(hundredths: number): string {
  const whole = Math.trunc(hundredths / 100);
  const fraction = Math.abs(hundredths % 100);
  if (fraction === 0) return String(whole);
  const decimals = fraction % 10 === 0 ? String(fraction / 10) : String(fraction).padStart(2, '0');
  return `${whole}.${decimals}`;
}

function moneyText(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  return `${sign}$${Math.floor(absolute / 100).toLocaleString('en-US')}.${String(absolute % 100).padStart(2, '0')}`;
}

/**
 * The line's working, in the form an accounts department reads without
 * asking: "3.5 hrs at $75.00". A flat charge has no working to show, so it
 * returns null rather than the noise of "1 at $150.00".
 */
export function basisText(line: AccessorialLine): string | null {
  if (line.unit === 'flat' && line.quantityHundredths === 100) return null;

  const noun = unitNoun(line.unit, line.quantityHundredths);
  const quantity = formatQuantity(line.quantityHundredths);
  const counted = noun ? `${quantity} ${noun}` : `${quantity}`;
  return `${counted} at ${moneyText(line.unitCents)}`;
}

/**
 * Reads a typed quantity into hundredths.
 *
 * Accepts "3", "3.5", "3.25" and rejects everything else rather than guessing.
 * More than two decimal places is refused instead of being rounded away: a
 * carrier typing 3.333 hours means something the invoice cannot express, and
 * silently billing 3.33 is a figure nobody chose.
 */
export function parseQuantity(input: string): number | null {
  const text = input.trim();
  if (!/^[0-9]+(\.[0-9]{1,2})?$/.test(text)) return null;

  const [whole, fraction = ''] = text.split('.');
  const hundredths = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(hundredths) ? hundredths : null;
}
