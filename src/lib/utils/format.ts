/** Formatting helpers. Money is stored as integer cents throughout the app. */

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

const USD_COMPACT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

/** Renders integer cents as currency. */
export function money(cents: number | null | undefined, compact = false): string {
  if (cents === null || cents === undefined) return '—';
  return compact ? USD_COMPACT.format(cents / 100) : USD.format(cents / 100);
}

/** Rate per mile, derived from integer cents and whole miles. */
export function ratePerMile(cents: number | null, miles: number | null): string {
  if (!cents || !miles) return '—';
  return `$${(cents / 100 / miles).toFixed(2)}/mi`;
}

const NUM = new Intl.NumberFormat('en-US');

export function num(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return NUM.format(value);
}

export function miles(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${NUM.format(value)} mi`;
}

/**
 * The finest unit this will report. Below it, the clock is a liability and the
 * exact figure is not information anybody wants.
 */
const FINEST_UNIT_SECONDS = 60;

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', FINEST_UNIT_SECONDS],
];

/**
 * Compact relative time, e.g. "3h ago", "in 2d", "just now".
 *
 * Nothing finer than a minute, for two reasons that happen to agree.
 *
 * The first is that no screen here wants it. Every caller is answering "how
 * long ago did this happen" at human scale — a load created, a notice sent, a
 * sweep run — and four seconds and forty seconds are the same answer to that
 * question.
 *
 * The second is that a second-granularity string cannot survive server
 * rendering. The server renders the HTML and the client hydrates a moment
 * later, by which time "5s ago" has become "7s ago", and React reports the
 * difference as a hydration failure. The sessions list on Settings was the
 * reliable case: the current session's last-seen time is rewritten on every
 * request, so it was always a few seconds old and the two renders essentially
 * never agreed.
 *
 * This is a floor rather than a guarantee, and worth being precise about. Any
 * text derived from the current clock can still differ across that boundary if
 * the two renders fall either side of a unit edge — fifty-nine minutes on the
 * server, an hour on the client. Minutes make that rare where seconds made it
 * certain. Making it impossible would mean not deriving the string from the
 * clock during render at all, which is a change at every call site rather than
 * a change here.
 */
export function relativeTime(date: Date | string | number): string {
  const then = new Date(date).getTime();
  const deltaSeconds = Math.round((then - Date.now()) / 1000);

  if (Math.abs(deltaSeconds) < FINEST_UNIT_SECONDS) {
    return deltaSeconds > 0 ? 'in a moment' : 'just now';
  }

  const rtf = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto', style: 'narrow' });
  for (const [unit, seconds] of RELATIVE_UNITS) {
    if (Math.abs(deltaSeconds) >= seconds) {
      return rtf.format(Math.round(deltaSeconds / seconds), unit);
    }
  }

  /* Unreachable: the sub-minute case returned above, and `minute` is the last
   * unit in the list. Present so the function has no implicit undefined. */
  return 'just now';
}

/** Formats a US phone number, leaving anything unexpected untouched. */
export function phone(value: string | null | undefined): string {
  if (!value) return '—';
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return value;
}

/** Splits a VIN into readable groups without changing its value. */
export function vinDisplay(vin: string): string {
  if (vin.length !== 17) return vin;
  return `${vin.slice(0, 3)} ${vin.slice(3, 8)} ${vin.slice(8, 9)} ${vin.slice(9, 11)} ${vin.slice(11)}`;
}

export function bytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
