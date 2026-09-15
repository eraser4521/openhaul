/**
 * What is in the account, and how much that figure can still be trusted.
 *
 * The timeline says what moves. It cannot say whether there will be enough,
 * because nothing in this application is connected to a bank. The only way to
 * close that gap without one is for somebody to read the balance off their
 * banking app and type it in — which works, and stops working quietly, and the
 * quiet part is the whole problem.
 *
 * So the reading is stored with the day it was true rather than as a figure
 * somebody overwrites, and everything downstream carries its age. A balance
 * from this morning and a balance from a fortnight ago are not the same kind
 * of input, and a projection that treats them alike is worse than no
 * projection: it is confidently wrong on exactly the week somebody is relying
 * on it.
 *
 * What is done with a stale reading is deliberately not "refuse". A carrier
 * who typed a figure last Tuesday still has better information than one who
 * typed nothing, and a screen that goes blank to protest its inputs teaches
 * people to stop using it. It is shown, aged in plain words, with what has
 * moved since it was taken set out beside it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
}

/** Same day or yesterday. Anything within a working day of the truth. */
export const FRESH_DAYS = 1;
/** Beyond a fortnight the reading is history, and is described as history. */
export const STALE_DAYS = 14;

export type BalanceAge = 'fresh' | 'aging' | 'stale';

export interface Reading {
  amountCents: number;
  asOf: Date;
}

export interface Aged {
  days: number;
  state: BalanceAge;
}

/**
 * How old the reading is, by the calendar rather than by the clock.
 *
 * Day comparison, so a balance entered at nine in the morning is still "today"
 * at five in the afternoon. Counting in hours would have the label flip while
 * somebody was looking at it.
 */
export function ageOf(reading: Reading, now: Date): Aged {
  const days = Math.max(
    0,
    Math.round((startOfDay(now).getTime() - startOfDay(reading.asOf).getTime()) / DAY_MS),
  );

  if (days <= FRESH_DAYS) return { days, state: 'fresh' };
  return { days, state: days >= STALE_DAYS ? 'stale' : 'aging' };
}

export const AGE_NOTE: Record<BalanceAge, string> = {
  fresh: 'Current enough to plan on.',
  aging:
    'Old enough that things have moved. What this application recorded since is set out below; ' +
    'what it does not record has moved too.',
  stale:
    'Too old to plan on. Everything below still starts from it, so read the weeks as a shape ' +
    'rather than as figures until somebody enters a fresh balance.',
};

/* -------------------------------------------------------------------------
 * The gap between the reading and today
 * ---------------------------------------------------------------------- */

export interface Movements {
  /** Customer payments banked since the reading. */
  receivedCents: number;
  /** Driver settlements marked paid since the reading. */
  settlementsPaidCents: number;
  /** Money sent back to customers since the reading. */
  refundsPaidCents: number;
  /** Standing commitments that fell due in the gap. Expected, not confirmed. */
  recurringCents: number;
}

export const NO_MOVEMENTS: Movements = {
  receivedCents: 0,
  settlementsPaidCents: 0,
  refundsPaidCents: 0,
  recurringCents: 0,
};

export function netMovement(moved: Movements): number {
  return (
    moved.receivedCents - moved.settlementsPaidCents - moved.refundsPaidCents - moved.recurringCents
  );
}

export function anyMovement(moved: Movements): boolean {
  return (
    moved.receivedCents > 0 ||
    moved.settlementsPaidCents > 0 ||
    moved.refundsPaidCents > 0 ||
    moved.recurringCents > 0
  );
}

/**
 * Whether a recorded event falls in the gap between the reading and now.
 *
 * Strictly after the reading's own day. A balance is read off a bank at the
 * end of a day, so everything that happened during that day is already in it —
 * counting it again would show money arriving twice. The field that collects
 * the date says "at the end of" for the same reason.
 */
export function movedAfter(reading: Reading, at: Date, now: Date): boolean {
  const day = startOfDay(at).getTime();
  return day > startOfDay(reading.asOf).getTime() && day <= startOfDay(now).getTime();
}

/**
 * Where the money probably is now: the reading, plus what has moved since.
 *
 * "Probably" is doing real work in that sentence and the screen says so. The
 * recorded half is solid; the rest of a carrier's account — the fuel card, the
 * card machine, whatever was paid in cash — moved too, and nothing here saw it.
 */
export function positionNow(reading: Reading, moved: Movements): number {
  return reading.amountCents + netMovement(moved);
}

/* -------------------------------------------------------------------------
 * The running balance
 * ---------------------------------------------------------------------- */

export interface WindowFlow {
  index: number;
  from: Date;
  to: Date;
  promisedCents: number;
  dueCents: number;
  outCents: number;
}

export interface ProjectedWindow {
  index: number;
  from: Date;
  to: Date;
  /** Closing balance if promised money and due invoices both arrive. */
  ifAllLandsCents: number;
  /** Closing balance if only what somebody actually promised arrives. */
  ifOnlyPromisedCents: number;
}

export interface Shortfall {
  index: number;
  from: Date;
  to: Date;
  cents: number;
}

export interface Projection {
  openingCents: number;
  windows: ProjectedWindow[];
  /** First week the cautious line goes under. Common, and not by itself alarming. */
  onPromises: Shortfall | null;
  /** First week it goes under even if every invoice pays on its terms. */
  onEverything: Shortfall | null;
}

/**
 * The balance carried week by week, on both readings.
 *
 * This is the only thing on the cash screens that answers the question
 * actually being asked, which is not "what is outstanding" but "is Friday
 * going to work". It is also the easiest thing here to make dishonest, so the
 * two lines are carried separately the whole way down rather than being
 * averaged into a single expected figure. An average would sit between a
 * number somebody committed to and a number nobody did, and would be neither.
 *
 * The cautious line going under is ordinary — few carriers have promises
 * covering a month of costs. The optimistic one going under is not: it means
 * that even with every invoice paid exactly on its terms, the account does not
 * reach the end of the month. They are reported separately for that reason.
 */
export function project(openingCents: number, windows: readonly WindowFlow[]): Projection {
  let optimistic = openingCents;
  let cautious = openingCents;

  const rows: ProjectedWindow[] = [];
  let onPromises: Shortfall | null = null;
  let onEverything: Shortfall | null = null;

  for (const window of windows) {
    optimistic += window.promisedCents + window.dueCents - window.outCents;
    cautious += window.promisedCents - window.outCents;

    rows.push({
      index: window.index,
      from: window.from,
      to: window.to,
      ifAllLandsCents: optimistic,
      ifOnlyPromisedCents: cautious,
    });

    if (!onPromises && cautious < 0) {
      onPromises = { index: window.index, from: window.from, to: window.to, cents: cautious };
    }

    if (!onEverything && optimistic < 0) {
      onEverything = { index: window.index, from: window.from, to: window.to, cents: optimistic };
    }
  }

  return { openingCents, windows: rows, onPromises, onEverything };
}
