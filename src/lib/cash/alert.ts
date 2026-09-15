import { money } from '../utils/format';
import { describeWindow } from './cashflow';
import type { BalanceAge, Projection, Shortfall } from './balance';
import type { AlertKind, AlertReason } from '../db/schema';

/**
 * Telling somebody who is not looking at the screen.
 *
 * The cash timeline can name the week the account goes under. That is worth
 * nothing to a carrier who is driving and will next open a browser on Friday,
 * so it has to leave the building — and the moment it does, the problem stops
 * being one of plumbing. The mail transport and the scheduled endpoint already
 * exist. What does not exist is a rule for when a message is worth somebody's
 * attention, and that rule is the entire feature.
 *
 * Three decisions carry it:
 *
 *  - **Only one thing is ever pushed.** The account going under *even if every
 *    invoice is paid exactly on its terms*. The cautious reading — going under
 *    on promises alone — is ordinary, because few carriers have promises
 *    covering a month of costs, and a channel that fires on ordinary is a
 *    channel that gets filtered. It stays on the page, where somebody has
 *    chosen to look.
 *  - **Nothing is sent twice.** A warning repeated unchanged is not news, and
 *    the second identical message teaches somebody to stop opening the first.
 *    So a warning goes when something about it has actually changed: it is now
 *    inside the next seven days, or the week has moved earlier, or it has got
 *    materially deeper. Otherwise, silence — the situation has not changed and
 *    saying so again adds nothing.
 *  - **The loop is closed.** When a warning was outstanding and the projection
 *    recovers, that is said once. Without it, somebody who fixed the problem
 *    is left wondering whether it is still there, and the next warning arrives
 *    into a channel they have learned to distrust.
 *
 * And the trap: a warning is only worth reading if the projection is
 * trustworthy, which it only is if the balance is fresh. That could have been
 * solved by refusing to send on a stale balance — which would go silent
 * exactly when nobody has been in the application, which is exactly when
 * things are going wrong. So it sends anyway and states the age in the
 * message, letting the reader discount it rather than discounting it for them.
 * With no balance at all nothing is sent, ever: there is nothing to project
 * from, and a message saying so would be a nag about data entry that arrived
 * forever and told nobody anything.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / DAY_MS);
}

/**
 * How much deeper a shortfall has to get before it is news again.
 *
 * Both conditions, not either. A quarter alone would fire on a shortfall
 * going from four dollars to five; a flat floor alone would fire on a large
 * one drifting by a rounding error. Together they mean "noticeably worse, and
 * worth an interruption".
 */
export const MATERIAL_FRACTION = 0.25;
export const MATERIAL_CENTS = 25_000;

export type AlertSilence =
  | 'disabled'
  | 'no_recipient'
  | 'no_balance'
  | 'sound'
  | 'no_change'
  | 'too_soon';

export const SILENCE_LABEL: Record<AlertSilence, string> = {
  disabled: 'Cash warnings are switched off.',
  no_recipient: 'Nobody would receive it — no address on the organisation or in the settings.',
  no_balance: 'No balance has been entered, so there is nothing to project from.',
  sound: 'The account holds up across the horizon, with nothing outstanding to retract.',
  no_change: 'The same warning already went out and nothing about it has changed.',
  too_soon: 'Something changed, but the last message was too recent to follow so soon.',
};

export const REASON_LABEL: Record<AlertReason, string> = {
  first: 'First warning about this',
  imminent: 'Now inside the next seven days',
  sooner: 'Moved to an earlier week',
  deeper: 'Materially deeper than last said',
  recovered: 'No longer projected short',
};

export interface AlertRule {
  enabled: boolean;
  recipients: string[];
  minimumGapDays: number;
}

export interface BalanceContext {
  amountCents: number;
  asOf: Date;
  days: number;
  state: BalanceAge;
}

export interface Previous {
  kind: AlertKind;
  reason: AlertReason;
  sentAt: Date;
  /**
   * The week that was named, as a date.
   *
   * The date rather than the index, and this is the subtle one. Windows roll
   * from whatever day the sweep runs, so the same calendar week is index 2
   * today and index 1 next Tuesday. Comparing yesterday's index against
   * today's would have the channel announce that the trouble had moved closer
   * every single week, when all that moved was the calendar.
   */
  windowFrom: Date | null;
  shortfallCents: number | null;
}

export type AlertDecision =
  | { send: false; why: AlertSilence }
  | { send: true; kind: 'shortfall'; reason: AlertReason; shortfall: Shortfall }
  | { send: true; kind: 'all_clear'; reason: 'recovered' };

function materiallyDeeper(before: number | null, now: number): boolean {
  if (before === null) return true;

  const was = Math.abs(before);
  const is = Math.abs(now);

  return is > was * (1 + MATERIAL_FRACTION) && is - was >= MATERIAL_CENTS;
}

/**
 * What, if anything, has changed since the last warning.
 *
 * Note what is deliberately not here: a shortfall that has got *better* but
 * not gone, or one that has moved to a later week. Both are improvements and
 * neither is worth an interruption, because the thing somebody was told is
 * still true and still on the page. Only the all-clear reports good news, and
 * only when there is no longer any news at all.
 */
function whatChanged(previous: Previous, shortfall: Shortfall): AlertReason | null {
  if (shortfall.index === 0 && previous.reason !== 'imminent') return 'imminent';

  if (previous.windowFrom && shortfall.from.getTime() < previous.windowFrom.getTime()) {
    return 'sooner';
  }

  if (materiallyDeeper(previous.shortfallCents, shortfall.cents)) return 'deeper';

  return null;
}

/**
 * Whether to say anything at all today.
 *
 * Reads only the optimistic line of the projection. See the note at the top of
 * this file: the cautious line going under is ordinary and belongs on a screen
 * somebody chose to open, not in their pocket.
 */
export function decideAlert(
  rule: AlertRule,
  position: { projection: Projection | null; balance: BalanceContext | null },
  previous: Previous | null,
  now: Date,
): AlertDecision {
  if (!rule.enabled) return { send: false, why: 'disabled' };
  if (rule.recipients.length === 0) return { send: false, why: 'no_recipient' };
  if (!position.balance || !position.projection) return { send: false, why: 'no_balance' };

  const shortfall = position.projection.onEverything;

  if (!shortfall) {
    return previous?.kind === 'shortfall'
      ? { send: true, kind: 'all_clear', reason: 'recovered' }
      : { send: false, why: 'sound' };
  }

  /*
   * "Nothing changed" is decided before the gap, so a settings screen can say
   * the situation is unchanged rather than that a message is being held back.
   * They are different facts and only one of them means somebody should wait.
   */
  let reason: AlertReason = 'first';

  if (previous && previous.kind === 'shortfall') {
    const changed = whatChanged(previous, shortfall);
    if (changed === null) return { send: false, why: 'no_change' };
    reason = changed;
  }

  if (previous && daysBetween(previous.sentAt, now) < rule.minimumGapDays) {
    return { send: false, why: 'too_soon' };
  }

  return { send: true, kind: 'shortfall', reason, shortfall };
}

/* -------------------------------------------------------------------------
 * What it says
 * ---------------------------------------------------------------------- */

export interface MessageInput {
  kind: AlertKind;
  carrierName: string;
  shortfall: Shortfall | null;
  balance: BalanceContext;
  positionCents: number;
  horizonWeeks: number;
  totals: {
    promisedCents: number;
    dueCents: number;
    settlementCents: number;
    recurringCents: number;
    outCents: number;
  };
  /** Money already past due, which is the largest lever most carriers have. */
  overdueInCents: number;
  url: string | null;
}

export interface ComposedAlert {
  subject: string;
  text: string;
}

function ageText(balance: BalanceContext): string {
  if (balance.days === 0) return 'entered today';
  if (balance.days === 1) return 'entered yesterday';
  return `${balance.days} days old`;
}

/**
 * The reading, and where it leaves the account once recorded movement is
 * applied — unless nothing has moved, in which case the second figure is the
 * first one again and printing both reads like an error.
 */
function basisText(balance: BalanceContext, positionCents: number): string[] {
  const opening = `Based on a balance of ${money(balance.amountCents)} ${ageText(balance)}`;

  return positionCents === balance.amountCents
    ? [`${opening}, with nothing recorded`, 'since then.']
    : [`${opening}, which puts the account`, `at about ${money(positionCents)} today.`];
}

/**
 * The message itself.
 *
 * Plain text, because the transport sends nothing else and because a warning
 * about somebody's solvency does not need a header image. Short enough to be
 * read on a phone at a fuel stop: what, when, on what basis, and the one thing
 * that would most change it.
 *
 * The basis is stated before the detail rather than in a footnote. A carrier
 * whose balance is a fortnight old should know that before they decide what to
 * do about the figure, not after.
 */
export function composeAlert(input: MessageInput): ComposedAlert {
  const lines: string[] = [];

  if (input.kind === 'all_clear' || !input.shortfall) {
    return {
      subject: 'Cash: no longer projected short',
      text: [
        `The account is no longer projected to go under at any point in the next ${input.horizonWeeks} weeks,`,
        'counting every promise and every invoice paid on its terms.',
        '',
        ...basisText(input.balance, input.positionCents),
        '',
        'Nothing further will be sent unless it goes under again.',
        ...(input.url ? ['', input.url] : []),
      ].join('\n'),
    };
  }

  const week = describeWindow(input.shortfall);

  lines.push(
    `Even if every invoice is paid exactly on its terms and every promise is kept, the`,
    `account is projected to reach ${money(input.shortfall.cents)} in the week of ${week}.`,
    '',
  );

  /*
   * The caveat is sized to the staleness rather than being a fixed sentence.
   * A figure entered this morning does not need three lines of apology, and a
   * figure from a fortnight ago needs more than a parenthesis.
   */
  if (input.balance.state === 'stale') {
    lines.push(
      `This rests on a balance of ${money(input.balance.amountCents)} that is ${input.balance.days} days old.`,
      'Nothing here is connected to a bank, so if that figure has moved then so has',
      'everything above. Entering a current balance is the one thing that would make',
      'this worth acting on either way.',
      '',
    );
  } else {
    lines.push(...basisText(input.balance, input.positionCents), '');
  }

  lines.push(`Between now and then, over ${input.horizonWeeks} weeks:`);
  lines.push(`  in    ${money(input.totals.dueCents)} falls due from customers`);
  lines.push(`  in    ${money(input.totals.promisedCents)} has been promised`);
  lines.push(`  out   ${money(input.totals.settlementCents)} in driver settlements`);
  lines.push(`  out   ${money(input.totals.recurringCents)} in standing costs`);
  lines.push('');

  if (input.overdueInCents > 0) {
    lines.push(
      `${money(input.overdueInCents)} is already past due and is not counted above, because`,
      'nothing on file says which day it would arrive. Collecting it is the largest',
      'lever here.',
      '',
    );
  }

  lines.push(
    'Not counted at all: anything that leaves without being recorded here — fuel',
    'cards, cash, a premium nobody has entered.',
  );

  if (input.url) lines.push('', input.url);

  return { subject: `Cash short in the week of ${week}`, text: lines.join('\n') };
}
