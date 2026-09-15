import { balanceCents, type Settled } from './compute';
import { daysBetween } from './terms';

/**
 * Chasing an unpaid invoice, and the many reasons not to.
 *
 * Almost everything here is a refusal. Sending a firmer and firmer letter is
 * trivial; the work is in the cases where doing so is wrong, and those are
 * the cases that lose a customer rather than collect a debt.
 *
 * The rules that follow each exist because of a specific way this goes badly.
 * Chasing somebody whose money the carrier is already sitting on. Escalating
 * on an invoice that is under dispute. Sending three rungs at once because the
 * machine was off for a month. Demanding payment from somebody who is paying.
 * A ladder without these is not a collections process, it is harassment with
 * a cron line.
 */

export interface LadderStage {
  sequence: number;
  label: string;
  daysPastDue: number;
  message: string;
  enabled: boolean;
}

export interface DunningRule {
  enabled: boolean;
  minimumBalanceCents: number;
  minimumGapDays: number;
  pauseAfterPaymentDays: number;
  /** Days after a promised date before it counts as not kept. */
  promiseGraceDays: number;
}

export const DEFAULT_RULE: DunningRule = {
  enabled: false,
  minimumBalanceCents: 0,
  minimumGapDays: 10,
  pauseAfterPaymentDays: 14,
  promiseGraceDays: 3,
};

/**
 * The ladder a carrier gets before they write their own.
 *
 * Firmer at each rung, and threatening at none of them. A default that
 * promised to pass a debt to collections would put words in the carrier's
 * mouth about a step they may have no intention of taking — and a threat not
 * followed through costs more than the debt, because the next one is ignored.
 */
export const DEFAULT_LADDER: LadderStage[] = [
  {
    sequence: 1,
    label: 'Reminder',
    daysPastDue: 7,
    enabled: true,
    message:
      'This is a reminder that the invoice below has passed its due date and we have not seen ' +
      'payment against it. If it has already gone out, thank you — please ignore this. If not, ' +
      'could you let us know when to expect it?',
  },
  {
    sequence: 2,
    label: 'Second reminder',
    daysPastDue: 21,
    enabled: true,
    message:
      'We wrote to you about the invoice below and have not heard back. Please let us know when ' +
      'payment will be made. If something on the invoice is wrong, or it is waiting on a purchase ' +
      'order or paperwork from us, tell us which and we will sort it out.',
  },
  {
    sequence: 3,
    label: 'Final notice',
    daysPastDue: 45,
    enabled: true,
    message:
      'The invoice below is now well past due and we have had no reply to our earlier reminders. ' +
      'We need to hear from you about it. We would much rather settle this with you directly than ' +
      'take it any further, so please call or write and tell us where it stands.',
  },
];

/* -------------------------------------------------------------------------
 * Whether to chase at all
 * ---------------------------------------------------------------------- */

export const HOLD_REASONS = [
  'not_due',
  'nothing_owed',
  'under_minimum',
  'covered_by_credit',
  'customer_opted_out',
  'promised',
  'paused',
  'disputed',
  'legal_hold',
  'recently_paid',
  'too_soon',
  'ladder_finished',
  'no_email',
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

export const HOLD_LABEL: Record<HoldReason, string> = {
  not_due: 'Not past its due date',
  nothing_owed: 'Nothing outstanding',
  under_minimum: 'Below the minimum balance',
  covered_by_credit: 'Covered by credit the customer holds with you',
  customer_opted_out: 'Chasing turned off for this customer',
  promised: 'They have promised to pay',
  paused: 'Paused by hand',
  disputed: 'A claim is open on this load',
  legal_hold: 'The load is under legal hold',
  recently_paid: 'Money has arrived recently',
  too_soon: 'Too soon after the last notice',
  ladder_finished: 'Every rung has been sent',
  no_email: 'No email address on file',
};

export interface InvoicePosition extends Settled {
  id: string;
  number: string;
  status: string;
  dueAt: Date | null;
  /** Null means nothing has been paused. */
  dunningPausedUntil: Date | null;
}

export interface ChaseContext {
  invoice: InvoicePosition;
  /** What the carrier is holding for this customer, across all their invoices. */
  customerCreditCents: number;
  customerDunningEnabled: boolean;
  customerHasEmail: boolean;
  /** An open cargo claim on the load this invoice bills. */
  hasOpenClaim: boolean;
  loadOnLegalHold: boolean;
  /** When money last arrived against this invoice. */
  lastPaymentAt: Date | null;
  /** The highest rung already sent, and when. */
  lastNoticeAt: Date | null;
  lastStageSent: number;
  /**
   * Whether an unresolved promise is standing on this invoice.
   *
   * Worked out by `promise.ts` from what was said and what arrived, and
   * passed in rather than recomputed here so the screen and the sweep cannot
   * reach different answers about the same conversation.
   */
  promiseHolds: boolean;
}

export type ChaseDecision =
  | { chase: true; stage: LadderStage; daysPastDue: number; balanceCents: number }
  | { chase: false; reason: HoldReason; daysPastDue: number; balanceCents: number };

/**
 * Whether this invoice gets the next rung today, and which.
 *
 * Every refusal is named rather than folded into a boolean, because the
 * screen has to be able to say why a visibly overdue invoice was left alone —
 * otherwise the only way to trust the ladder is to watch what it sends.
 */
export function decideChase(
  context: ChaseContext,
  rule: DunningRule,
  ladder: readonly LadderStage[],
  now: Date,
): ChaseDecision {
  const { invoice } = context;
  const balance = balanceCents(invoice);
  const daysPastDue = invoice.dueAt ? daysBetween(invoice.dueAt, now) : 0;
  const base = { daysPastDue, balanceCents: balance };

  const held = (reason: HoldReason): ChaseDecision => ({ chase: false, reason, ...base });

  if (balance <= 0) return held('nothing_owed');
  if (!invoice.dueAt || daysPastDue <= 0) return held('not_due');

  /*
   * The one that would be indefensible. Chasing somebody for money while
   * holding money of theirs — from an overpayment they asked us to keep — is
   * a letter the carrier cannot defend when it is read back to them.
   */
  if (context.customerCreditCents >= balance) return held('covered_by_credit');

  if (!context.customerDunningEnabled) return held('customer_opted_out');

  /*
   * Somebody who has said when they will pay has earned the wait. Chasing
   * through a promise that has not fallen due yet is the fastest way to teach
   * a customer that telling you anything is pointless.
   */
  if (context.promiseHolds) return held('promised');

  if (invoice.dunningPausedUntil && invoice.dunningPausedUntil.getTime() > now.getTime()) {
    return held('paused');
  }

  // An invoice under dispute is a conversation, not a debt to escalate.
  if (context.hasOpenClaim) return held('disputed');
  if (context.loadOnLegalHold) return held('legal_hold');

  if (balance < rule.minimumBalanceCents) return held('under_minimum');
  if (!context.customerHasEmail) return held('no_email');

  /*
   * Money arriving restarts the clock but not the ladder. Somebody paying in
   * instalments should not be escalated for it, and somebody who pays a
   * pound a month should still reach the end eventually.
   */
  if (
    context.lastPaymentAt &&
    daysBetween(context.lastPaymentAt, now) < rule.pauseAfterPaymentDays
  ) {
    return held('recently_paid');
  }

  if (context.lastNoticeAt && daysBetween(context.lastNoticeAt, now) < rule.minimumGapDays) {
    return held('too_soon');
  }

  const next = nextStage(ladder, context.lastStageSent, daysPastDue);
  if (!next) return held('ladder_finished');

  return { chase: true, stage: next, ...base };
}

/**
 * The next rung that is both unclimbed and earned.
 *
 * Strictly in order. A run that has not happened for a month finds an invoice
 * fifty days overdue with three rungs all qualifying, and sends the first —
 * because a customer receiving a final notice as the first thing they ever
 * hear has been ambushed, however late they are.
 */
export function nextStage(
  ladder: readonly LadderStage[],
  lastSent: number,
  daysPastDue: number,
): LadderStage | null {
  const remaining = ladder
    .filter((stage) => stage.enabled && stage.sequence > lastSent)
    .sort((a, b) => a.sequence - b.sequence);

  const next = remaining[0];
  if (!next) return null;

  return daysPastDue >= next.daysPastDue ? next : null;
}

/** Every rung in order, with any gaps in the sequence closed up. */
export function normalizeLadder(stages: readonly LadderStage[]): LadderStage[] {
  return stages
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((stage, index) => ({ ...stage, sequence: index + 1 }));
}

/**
 * What is wrong with a ladder, as sentences.
 *
 * Checked rather than trusted because the thresholds are typed by a person
 * and two rungs on the same day is the classic way to send two letters in one
 * morning.
 */
export function ladderProblems(stages: readonly LadderStage[], rule: DunningRule): string[] {
  const problems: string[] = [];
  const active = stages.filter((stage) => stage.enabled).sort((a, b) => a.sequence - b.sequence);

  if (rule.enabled && active.length === 0) {
    problems.push('Chasing is on but every rung is turned off, so nothing would ever be sent.');
  }

  for (const stage of active) {
    if (!stage.message.trim()) {
      problems.push(`"${stage.label}" has no message, so there would be nothing to say.`);
    }
    if (stage.daysPastDue < 1) {
      problems.push(
        `"${stage.label}" would go out on the due date itself. Give people a few days.`,
      );
    }
  }

  for (let index = 1; index < active.length; index += 1) {
    const previous = active[index - 1]!;
    const stage = active[index]!;

    if (stage.daysPastDue <= previous.daysPastDue) {
      problems.push(
        `"${stage.label}" is not later than "${previous.label}", so the ladder does not escalate.`,
      );
    } else if (stage.daysPastDue - previous.daysPastDue < rule.minimumGapDays) {
      const apart = stage.daysPastDue - previous.daysPastDue;
      problems.push(
        `"${stage.label}" is only ${days(apart)} after "${previous.label}". The minimum gap of ` +
          `${days(rule.minimumGapDays)} would delay it anyway — space them out or lower the gap.`,
      );
    }
  }

  return problems;
}

/** "1 day", "10 days" — said in a sentence, so it has to agree. */
function days(count: number): string {
  return count === 1 ? '1 day' : `${count} days`;
}

/** How late, in the words a person would use. */
export function describeLateness(daysPastDue: number): string {
  if (daysPastDue <= 0) return 'not yet due';
  if (daysPastDue === 1) return '1 day past due';
  return `${daysPastDue} days past due`;
}
