import { money } from '../utils/format';
import { paymentDueBy } from '../settlements/compute';
import { CADENCE_LABEL, occurrencesBetween, type Outgoing } from './recurring';

/**
 * What moves, and when.
 *
 * A cash forecast is easy to build and easy to make worthless. It goes wrong
 * the same way every time: it fills the gaps in what it knows with something
 * plausible, somebody spots one invented figure, and after that none of the
 * real ones are believed either.
 *
 * So nothing here is estimated. Every dated row traces to a date already on a
 * record — a day somebody said they would pay, an invoice's own due date, the
 * fifteen days a settlement gets under 49 CFR 376.12(f). Nothing is averaged,
 * nothing is extrapolated from what happened last quarter, and nothing is put
 * on a date it does not have.
 *
 * Three rules follow from that, and they are the whole design:
 *
 *  - **Money already late is not on the timeline.** It has no future date.
 *    "Ninety days overdue" and "due next Tuesday" are not the same kind of
 *    thing, and a column that adds them produces a number meaning neither. It
 *    goes in its own list instead, with why it is there.
 *  - **A promise and a due date are never added together.** One is a person's
 *    word and the other is a payment term. They are shown as separate figures
 *    in every window, so a carrier can read the cautious line and the hopeful
 *    line and see how far apart they are.
 *  - **The same money is never counted twice.** Where a customer has promised
 *    to pay an invoice, that part of the balance is promised and the rest of
 *    it falls due — never both.
 *
 * And what this cannot see is printed on the page rather than left to be
 * discovered, because the distance between "this is everything" and "this is
 * everything I was told about" is exactly where a forecast stops being useful.
 */

export const HORIZON_WEEKS = 4;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function startOfDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
}

/** Whole days between two days, by the calendar rather than by the clock. */
function daysApart(from: Date, to: Date): number {
  return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / DAY_MS);
}

/* -------------------------------------------------------------------------
 * What is on the timeline
 * ---------------------------------------------------------------------- */

/** Where a dated figure came from, which decides the column it sits in. */
export type MovementKind = 'promised' | 'due' | 'settlement' | 'recurring';

export interface Movement {
  key: string;
  kind: MovementKind;
  /** The day it is expected to move. Always off a record, never guessed. */
  on: Date;
  /** Always positive; `kind` says which way it goes. */
  amountCents: number;
  reference: string;
  counterparty: string;
  /**
   * Why this figure sits on this day, in a few words.
   *
   * Short on purpose. It repeats down the list the way a status column does,
   * and a full sentence restated thirty times stops being read — including
   * the one on the settlement rows, which is the only date on this page a
   * reader would otherwise reasonably suspect of being made up.
   */
  because: string;
}

export interface Outflow {
  /** Driver settlements reaching their statutory payment deadline. */
  settlementCents: number;
  /** Standing commitments: notes, premiums, rent, tax. */
  recurringCents: number;
  /** The two together, which is what the account actually sees leave. */
  outCents: number;
}

export interface Window extends Outflow {
  index: number;
  from: Date;
  /** Exclusive. */
  to: Date;
  promisedCents: number;
  dueCents: number;
  movements: Movement[];
}

export interface Totals extends Outflow {
  promisedCents: number;
  dueCents: number;
}

export interface Timeline {
  windows: Window[];
  /** Dated past the horizon. Carried so nothing is silently dropped. */
  later: Totals;
  totals: Totals;
}

/**
 * Rolling seven-day windows from today.
 *
 * Rolling rather than calendar weeks. The question is "the next fortnight",
 * not "which side of Sunday", and a calendar grid would have to decide what
 * day a week starts on — which differs by country, by carrier, and by whether
 * the person asking runs payroll.
 */
export function windowsFrom(now: Date, weeks = HORIZON_WEEKS): Array<{ from: Date; to: Date }> {
  const start = startOfDay(now);

  return Array.from({ length: weeks }, (_, index) => ({
    from: new Date(start.getTime() + index * WEEK_MS),
    to: new Date(start.getTime() + (index + 1) * WEEK_MS),
  }));
}

/**
 * Sorts dated movements into windows.
 *
 * Anything already past is dropped rather than swept into the first window. A
 * settlement that went past its deadline last month is not "due this week",
 * and putting it there would bury the one fact somebody most needs to see.
 * Callers are expected to have sent those to {@link Standing} instead.
 */
export function buildTimeline(
  movements: readonly Movement[],
  now: Date,
  weeks = HORIZON_WEEKS,
): Timeline {
  const spans = windowsFrom(now, weeks);
  const horizonEnd = spans[spans.length - 1]?.to ?? startOfDay(now);

  const windows = spans.map((span, index) => {
    const inside = movements
      .filter(
        (row) =>
          row.on.getTime() >= span.from.getTime() && row.on.getTime() < span.to.getTime(),
      )
      .sort((a, b) => a.on.getTime() - b.on.getTime());

    const sum = (kind: MovementKind) =>
      inside.filter((row) => row.kind === kind).reduce((total, row) => total + row.amountCents, 0);

    const settlementCents = sum('settlement');
    const recurringCents = sum('recurring');

    return {
      index,
      from: span.from,
      to: span.to,
      promisedCents: sum('promised'),
      dueCents: sum('due'),
      settlementCents,
      recurringCents,
      outCents: settlementCents + recurringCents,
      movements: inside,
    };
  });

  const beyond = (kind: MovementKind) =>
    movements
      .filter((row) => row.kind === kind && row.on.getTime() >= horizonEnd.getTime())
      .reduce((total, row) => total + row.amountCents, 0);

  const laterSettlement = beyond('settlement');
  const laterRecurring = beyond('recurring');
  const add = (pick: (w: Window) => number) => windows.reduce((total, w) => total + pick(w), 0);

  return {
    windows,
    later: {
      promisedCents: beyond('promised'),
      dueCents: beyond('due'),
      settlementCents: laterSettlement,
      recurringCents: laterRecurring,
      outCents: laterSettlement + laterRecurring,
    },
    totals: {
      promisedCents: add((w) => w.promisedCents),
      dueCents: add((w) => w.dueCents),
      settlementCents: add((w) => w.settlementCents),
      recurringCents: add((w) => w.recurringCents),
      outCents: add((w) => w.outCents),
    },
  };
}

/**
 * A standing commitment, as the payments it makes inside the horizon.
 *
 * The only figures on this page the carrier wrote down themselves rather than
 * a counterparty. That makes them the most certain thing here and the easiest
 * to forget to record, which is why the page counts how many there are and
 * says so when the answer is none.
 */
export function recurringMovements(outgoing: Outgoing, from: Date, to: Date): Movement[] {
  /*
   * Named by the commitment, with the cadence as its detail — which is what
   * explains why the same name appears in four consecutive weeks. Labelling
   * the row "Standing cost" and relegating the name would have made every one
   * of them look alike in a list read at a glance.
   */
  return occurrencesBetween(outgoing, from, to).map((on) => ({
    key: `outgoing:${outgoing.id}:${on.getTime()}`,
    kind: 'recurring' as const,
    on,
    amountCents: outgoing.amountCents,
    reference: CADENCE_LABEL[outgoing.cadence].toLowerCase(),
    counterparty: outgoing.name,
    because: 'a standing cost you recorded',
  }));
}

/**
 * Net movement in a window, read two ways.
 *
 * Two numbers rather than one, because the gap between them is the actual
 * information. A week that clears on everything and drowns on promises alone
 * is a week that depends entirely on invoices nobody has committed to paying,
 * and a single "net" figure would hide which of the two it was.
 */
export function netOf(window: {
  promisedCents: number;
  dueCents: number;
  outCents: number;
}): { ifAllLands: number; ifOnlyPromised: number } {
  return {
    ifAllLands: window.promisedCents + window.dueCents - window.outCents,
    ifOnlyPromised: window.promisedCents - window.outCents,
  };
}

/* -------------------------------------------------------------------------
 * What is not on the timeline, and why
 * ---------------------------------------------------------------------- */

export const STANDING_REASONS = [
  'overdue',
  'promise_late',
  'no_due_date',
  'settlement_late',
  'payroll_undated',
  'unreimbursed',
  'refund_owed',
] as const;
export type StandingReason = (typeof STANDING_REASONS)[number];

export const STANDING_DIRECTION: Record<StandingReason, 'in' | 'out'> = {
  overdue: 'in',
  promise_late: 'in',
  no_due_date: 'in',
  settlement_late: 'out',
  payroll_undated: 'out',
  unreimbursed: 'out',
  refund_owed: 'out',
};

export const STANDING_LABEL: Record<StandingReason, string> = {
  overdue: 'Past due, with nobody committed to a date',
  promise_late: 'Promised for a day already gone',
  no_due_date: 'No due date on the invoice',
  settlement_late: 'Settlement past its fifteen days',
  payroll_undated: 'Company driver pay, with no date on file',
  unreimbursed: 'Approved expenses with no settlement drawn',
  refund_owed: 'Overpayments still held',
};

export const STANDING_NOTE: Record<StandingReason, string> = {
  overdue:
    'Could arrive any day, or never. Putting it in a week would be inventing a date the ' +
    'customer has not given.',
  promise_late:
    'The day they named has passed. It may still be in the post, but the date it had is no ' +
    'longer a future date.',
  no_due_date:
    'Nothing on the invoice says when this is payable, so nothing here can say either. Setting ' +
    'payment terms puts it on the timeline.',
  settlement_late:
    '49 CFR 376.12(f) allows fifteen days from the paperwork for a leased driver. These are ' +
    'past that.',
  payroll_undated:
    'Owed, but on no date this application knows. The fifteen days in 49 CFR 376.12(f) govern a ' +
    'lease with an owner-operator; a company driver is paid under wage law, which is not ' +
    'modelled here — so guessing a date would mean applying the wrong rule.',
  unreimbursed:
    'Money the driver has already spent and is owed back. It has no date until somebody draws ' +
    'the settlement that carries it.',
  refund_owed:
    'Customer money sitting in the account. Whether it leaves depends on whether they ask for ' +
    'it back or let it go against the next load.',
};

export interface Standing {
  key: string;
  reason: StandingReason;
  amountCents: number;
  reference: string;
  counterparty: string;
  /** How long it has been sitting there, where the record can say. */
  daysWaiting: number | null;
}

export interface StandingGroup {
  reason: StandingReason;
  direction: 'in' | 'out';
  amountCents: number;
  rows: Standing[];
}

/** Groups the undated items by why they are undated, worst waits first. */
export function groupStanding(rows: readonly Standing[]): StandingGroup[] {
  return STANDING_REASONS.map((reason) => {
    const inside = rows
      .filter((row) => row.reason === reason)
      .sort((a, b) => (b.daysWaiting ?? 0) - (a.daysWaiting ?? 0));

    return {
      reason,
      direction: STANDING_DIRECTION[reason],
      amountCents: inside.reduce((total, row) => total + row.amountCents, 0),
      rows: inside,
    };
  }).filter((group) => group.rows.length > 0);
}

/* -------------------------------------------------------------------------
 * Splitting a receivable between promised, falling due, and neither
 * ---------------------------------------------------------------------- */

export interface Receivable {
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  /** What is still owed today, net of everything. Expected positive. */
  balanceCents: number;
  dueAt: Date | null;
  /**
   * The open promise against this invoice, if there is one. Already resolved
   * elsewhere — this module does not decide whether somebody kept their word,
   * it only decides which day the money belongs to.
   */
  promise: { promisedFor: Date; outstandingCents: number } | null;
  /**
   * Whether the promise standing against this invoice was not kept.
   *
   * A broken promise is not money coming, so it never reaches the promised
   * column — but it does not make the due date go away either, and a row that
   * read as a plain payment term would be this page flattering the one
   * receivable it has the most reason to doubt.
   */
  promiseBroken?: boolean;
}

/**
 * One receivable, apportioned.
 *
 * The promised part comes off the balance first and the remainder falls due,
 * so the same dollar never appears in both columns. Capped at the balance,
 * because a promise made before a part-payment landed would otherwise put
 * more on the timeline than the customer still owes.
 *
 * A promise for a day that has passed is *not* rolled forward to today. The
 * carrier would be inventing a commitment nobody made, and the whole value of
 * the promised column is that every figure in it is something somebody
 * actually said.
 */
export function splitReceivable(
  row: Receivable,
  now: Date,
): { movements: Movement[]; standing: Standing[] } {
  const movements: Movement[] = [];
  const standing: Standing[] = [];

  if (row.balanceCents <= 0) return { movements, standing };

  const today = startOfDay(now);
  const promised = row.promise ? Math.min(row.promise.outstandingCents, row.balanceCents) : 0;
  const remainder = row.balanceCents - promised;

  if (row.promise && promised > 0) {
    const on = row.promise.promisedFor;

    if (startOfDay(on).getTime() >= today.getTime()) {
      movements.push({
        key: `promise:${row.invoiceId}`,
        kind: 'promised',
        on,
        amountCents: promised,
        reference: row.invoiceNumber,
        counterparty: row.customerName,
        because: 'they named this day',
      });
    } else {
      standing.push({
        key: `promise:${row.invoiceId}`,
        reason: 'promise_late',
        amountCents: promised,
        reference: row.invoiceNumber,
        counterparty: row.customerName,
        daysWaiting: daysApart(on, now),
      });
    }
  }

  if (remainder > 0) {
    if (row.dueAt === null) {
      standing.push({
        key: `invoice:${row.invoiceId}`,
        reason: 'no_due_date',
        amountCents: remainder,
        reference: row.invoiceNumber,
        counterparty: row.customerName,
        daysWaiting: null,
      });
    } else if (startOfDay(row.dueAt).getTime() >= today.getTime()) {
      movements.push({
        key: `invoice:${row.invoiceId}`,
        kind: 'due',
        on: row.dueAt,
        amountCents: remainder,
        reference: row.invoiceNumber,
        counterparty: row.customerName,
        because: row.promiseBroken
          ? 'payment terms — but a promise on this one was broken'
          : 'payment terms',
      });
    } else {
      standing.push({
        key: `invoice:${row.invoiceId}`,
        reason: 'overdue',
        amountCents: remainder,
        reference: row.invoiceNumber,
        counterparty: row.customerName,
        daysWaiting: daysApart(row.dueAt, now),
      });
    }
  }

  return { movements, standing };
}

/* -------------------------------------------------------------------------
 * Money going out
 * ---------------------------------------------------------------------- */

export interface Payable {
  settlementId: string;
  driverName: string;
  periodEnd: Date;
  netPayCents: number;
  /** Still a draft. It counts, and the row says so. */
  draft: boolean;
  /**
   * Whether 49 CFR Part 376 governs this settlement at all.
   *
   * Only a lease with an owner-operator. A company driver on payroll is paid
   * under wage law, which this application does not model — so their pay has
   * no date here, and dating it by the fifteen days would be citing a
   * regulation at somebody it does not bind.
   */
  leased: boolean;
}

/**
 * A settlement that has not been paid, dated by the law rather than by intent.
 *
 * 49 CFR 376.12(f) gives a carrier fifteen days from the driver's paperwork,
 * so an unpaid settlement has a deadline whether or not anybody has diarised
 * one. That is what makes this the only outflow here that can honestly be
 * dated: the carrier did not choose the date and cannot move it.
 *
 * Drafts are included deliberately. The fifteen days run from the paperwork,
 * not from the day somebody gets round to drawing the statement — so leaving
 * drafts off would let a carrier make Friday look survivable by not
 * finalising, which is precisely the week they most need the truth.
 */
export function splitPayable(
  row: Payable,
  now: Date,
): { movements: Movement[]; standing: Standing[] } {
  if (row.netPayCents <= 0) return { movements: [], standing: [] };

  const detail = row.draft ? 'Settlement still in draft' : 'Settlement ready to pay';

  /*
   * Without a lease there is no statutory clock, so there is no date — and
   * this page does not invent one. It goes to the undated pile with the
   * reason, which is the same treatment an invoice with no payment terms gets.
   */
  if (!row.leased) {
    return {
      movements: [],
      standing: [
        {
          key: `settlement:${row.settlementId}`,
          reason: 'payroll_undated',
          amountCents: row.netPayCents,
          reference: detail,
          counterparty: row.driverName,
          daysWaiting: daysApart(row.periodEnd, now),
        },
      ],
    };
  }

  const due = paymentDueBy(row.periodEnd);

  if (startOfDay(due).getTime() >= startOfDay(now).getTime()) {
    return {
      movements: [
        {
          key: `settlement:${row.settlementId}`,
          kind: 'settlement',
          on: due,
          amountCents: row.netPayCents,
          reference: detail,
          counterparty: row.driverName,
          because: 'fifteen days from period end, 49 CFR 376.12(f)',
        },
      ],
      standing: [],
    };
  }

  return {
    movements: [],
    standing: [
      {
        key: `settlement:${row.settlementId}`,
        reason: 'settlement_late',
        amountCents: row.netPayCents,
        reference: detail,
        counterparty: row.driverName,
        daysWaiting: daysApart(due, now),
      },
    ],
  };
}

/* -------------------------------------------------------------------------
 * What it cannot see
 * ---------------------------------------------------------------------- */

export interface Unknown {
  what: string;
  why: string;
}

/**
 * The gaps, written down.
 *
 * A forecast that does not say what it is missing gets believed about things
 * it knows nothing about, which is worse than not having one at all. The bank
 * balance is the important one: without it this shows movement and not whether
 * there will be enough, and those are different questions.
 *
 * Accrued pay is given as a figure rather than as a category, because a
 * carrier who can see the number can decide whether it matters to them. One
 * who is only told that a category exists cannot.
 */
export function unknowns(input: {
  accruedPayCents: number;
  accruedLoadCount: number;
  hasBalance: boolean;
  recurringCount: number;
}): Unknown[] {
  const rows: Unknown[] = [];

  /*
   * Only claimed while it is true. Once somebody has entered a balance the
   * weeks run against it, and a page still saying it cannot see the account
   * would be reciting a caveat it has outgrown — which is how a reader learns
   * to skip this section.
   */
  if (!input.hasBalance) {
    rows.push({
      what: 'What is actually in the account',
      why:
        'Nothing here is connected to a bank, and nobody has entered a balance. This says what ' +
        'moves, not what you have, so a week that nets positive can still be a week you cannot ' +
        'cover. Enter one and these weeks become a running balance.',
    });
  }

  if (input.accruedPayCents > 0) {
    const loads =
      input.accruedLoadCount === 1
        ? 'one delivered load'
        : `${input.accruedLoadCount} delivered loads`;

    rows.push({
      what: 'Driver pay earned but not yet settled',
      why:
        `${money(input.accruedPayCents)} on ${loads} that no settlement has been drawn for. ` +
        'It is owed, it has no date until somebody draws it, and it is in no figure above.',
    });
  }

  rows.push(
    input.recurringCount === 0
      ? {
          what: 'Everything that leaves whether or not a wheel turns',
          why:
            'Truck and trailer payments, insurance premiums, yard rent, permits, tax. None of ' +
            'it is recorded here, so none of it is in these figures — which is the single ' +
            'largest thing missing from them. Recording a standing cost puts it on the timeline.',
        }
      : {
          what: 'Standing costs you have not recorded',
          why:
            `The ${input.recurringCount === 1 ? 'one standing cost' : `${input.recurringCount} standing costs`} on file ` +
            'are counted in the weeks above. Anything else that leaves on its own — a fuel card, ' +
            'a card machine, cash, a premium nobody has entered — is not.',
        },
  );

  rows.push({
    what: 'Whether a due date means a payment',
    why:
      'An invoice falling due is a payment term, not a commitment. That is why it is kept in ' +
      'its own column, apart from what somebody actually promised, and never added to it.',
  });

  return rows;
}

/* -------------------------------------------------------------------------
 * Wording
 * ---------------------------------------------------------------------- */

/** "Sep 15 – Sep 21", which needs no agreement about when a week begins. */
export function describeWindow(window: { from: Date; to: Date }): string {
  const format = (date: Date) =>
    date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

  return `${format(window.from)} – ${format(new Date(window.to.getTime() - DAY_MS))}`;
}

/** "Starting today", "In 2 weeks" — the relative sense the dates do not give. */
export function describeOffset(index: number): string {
  if (index === 0) return 'Starting today';
  if (index === 1) return 'The week after';
  return `${index} weeks out`;
}

/** "11 days", "1 day" — for how long something has been sitting. */
export function describeWait(days: number | null): string | null {
  if (days === null || days <= 0) return null;
  return days === 1 ? '1 day' : `${days} days`;
}
