/**
 * `runDueAutomations`: the tick for triggers no write path emits synchronously.
 *
 * A SCHEDULE FIRES AT MOST ONCE PER TICK, HOWEVER FAR BEHIND ITS BOOKMARK HAS FALLEN. The authored
 * spec advanced through every missed instant, which means a laptop opened after a month offline fires
 * a daily rule thirty times, in one burst, unattended, against the ledger. That is the worst thing
 * this capability could do and it would happen on an ordinary Monday. The bookmark jumps to the LATEST
 * due instant instead and one run row is written. "Remind me daily" means daily, not "owe me a backlog".
 *
 * `TICK_SOURCES` IS THE EXTENSION POINT E03 AND A16 ATTACH TO WITH ONE ROW EACH. The spec promised
 * `task.due` and `debtor.aging_bucket_crossed` in v1 and neither is buildable today: E03 does not
 * exist anywhere in the tree, and A16's aging read model has no "crossed since" query (its own §6b
 * deferred exactly that). The interface they will implement ships here, proven by the one source that
 * does exist, rather than being designed later against whichever of the two lands first.
 *
 * `asOf` MAY NOT RUN AHEAD OF THE INJECTED CLOCK, and this is the correction of a real hole rather
 * than a hardening. The tick used to take the caller's word for what time it was, which made "nothing
 * fires before its due instant" a statement about the CALLER rather than about the world: a caller
 * naming tomorrow made tomorrow due, the bookmark advanced to it, and the next call naming the day
 * after fired again. Five calls with a walking `asOf` drove five entries into an append-only ledger,
 * measured through `callTool` on 29.07.2026 by an actor holding nothing in the workspace at all.
 * `src/core/clock.ts` is this repo's answer to "what time is it", it is injected, and it is therefore
 * the only thing entitled to answer here. A past `asOf` stays legal (it can only ever produce FEWER
 * occurrences, and the bookmark never moves backwards because a past instant is never due), and the
 * comparison is at DAY granularity because that is the granularity every cadence works at.
 *
 * THE TICK IS GATED, on `manage_automations` (see `actionCapabilities.ts`). The old exemption argued
 * that the tick "confers nothing" because each firing is separately gated against its rule's author.
 * That was never an argument about the TICK: the actor a firing runs as is the rule's author and not
 * the caller, so "separately gated" gates somebody else entirely. The tick is what makes a schedule
 * rule write unattended, which is the same act `enable_automation_rule` is administration for, so it
 * takes the same capability.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { ActionInvoker, AutomationEvent, FireOutcome, RuleRow } from './fire.js';
import { evaluateAndFire } from './fire.js';
// E03's `task.due` source: the row this file reserved for it by name (see TICK_SOURCES below).
// The tasks module imports only TYPES back from here, so the runtime graph stays acyclic.
import { taskDueTickSource } from '../tasks/tickSource.js';

/**
 * One source of occurrences the tick can produce.
 *
 * A future capability adds ONE row. Nothing in this file switches on an event name, a table or a
 * capability, and the schedule source below is an implementation of this interface rather than a
 * special case built into the loop.
 */
export interface TickSource {
  /** The events this source can produce. The tick asks the store for rules on exactly these. */
  readonly events: readonly string[];
  /**
   * The occurrences due for one rule at `asOf`, newest last. Returning more than one is legal; the
   * tick fires each in order and each gets its own run row and its own `event_ref`.
   */
  due(ctx: WorkspaceContext, rule: RuleRow, lastFiredAt: string | null, asOf: string): AutomationEvent[];
}

/** The cadences (§H-ENUM), and the whole of what `schedule.*` means. */
const CADENCE_DAYS: ReadonlyMap<string, number> = new Map([
  ['schedule.daily', 1],
  ['schedule.weekly', 7],
]);

const DAY_MS = 86_400_000;

/** An ISO instant truncated to its UTC date, which is the granularity every cadence here works at. */
function dayOf(iso: string): number {
  const parsed = Date.parse(iso.length > 10 ? iso : `${iso}T00:00:00Z`);
  return Number.isNaN(parsed) ? Number.NaN : Math.floor(parsed / DAY_MS);
}

function isoOfDay(day: number): string {
  return `${new Date(day * DAY_MS).toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/**
 * The one shipped source: fixed cadences over the rule's own bookmark.
 *
 * A rule that has never fired takes its FIRST occurrence at `asOf` rather than at the epoch. Starting
 * from the bookmark's absence would make "monthly" mean "every month since 1970", which is the
 * catch-up burst above wearing a different hat.
 */
const scheduleSource: TickSource = {
  events: ['schedule.daily', 'schedule.weekly', 'schedule.monthly'],

  due(_ctx, rule, lastFiredAt, asOf) {
    const today = dayOf(asOf);
    if (Number.isNaN(today)) return [];

    if (lastFiredAt === null) {
      return [occurrence(rule, isoOfDay(today))];
    }
    const last = dayOf(lastFiredAt);
    if (Number.isNaN(last)) return [occurrence(rule, isoOfDay(today))];

    if (rule.trigger_event === 'schedule.monthly') {
      // Month granularity, so the comparison is on the calendar month rather than on a day count: a
      // 28-day month and a 31-day month are both one month, and 30 days is not.
      const lastMonth = new Date(last * DAY_MS).toISOString().slice(0, 7);
      const thisMonth = new Date(today * DAY_MS).toISOString().slice(0, 7);
      return lastMonth < thisMonth ? [occurrence(rule, isoOfDay(today))] : [];
    }

    const period = CADENCE_DAYS.get(rule.trigger_event);
    if (period === undefined) return [];
    return today - last >= period ? [occurrence(rule, isoOfDay(today))] : [];
  },
};

/** The occurrence key for a cadence is the due INSTANT, so a repeated tick computes the same one. */
function occurrence(rule: RuleRow, dueInstant: string): AutomationEvent {
  return {
    event: rule.trigger_event,
    entityId: dueInstant,
    payload: { input: {}, result: {}, schedule: { dueAt: dueInstant, ruleId: rule.id } },
    eventRef: `${rule.trigger_event}:${dueInstant}`,
  };
}

/**
 * Every source the tick drives. One row per read-model-derived trigger.
 *
 * E03's `task.due` row landed exactly as reserved (`src/core/tasks/tickSource.ts`); A16 adds
 * `{ events: ['debtor.aging_bucket_crossed'], due(...) { ... } }` the same way. Neither touches a
 * line below.
 */
export const TICK_SOURCES: readonly TickSource[] = [scheduleSource, taskDueTickSource];

interface TickRuleRow extends RuleRow {
  last_fired_at: string | null;
}

/**
 * Ask every source what is due, fire it, and advance the bookmark.
 *
 * The bookmark advances only for a rule that actually produced an occurrence, and it advances to the
 * LATEST occurrence rather than to `asOf`, so a source that hands back a past instant does not have
 * its own next occurrence skipped by the tick that fired this one.
 */
export function runDueAutomations(
  ctx: WorkspaceContext,
  invoke: ActionInvoker,
  input: { asOf?: string } = {},
): Result {
  const now = ctx.clock.now();
  const asOf = typeof input.asOf === 'string' && input.asOf.length > 0 ? input.asOf : now;

  // AN UNPARSEABLE `asOf` IS REFUSED RATHER THAN ABSORBED. `dayOf` answers NaN, every source then
  // hands back no occurrence, and the tick used to report a serene `{ occurrences: 0 }` that a caller
  // cannot tell apart from "nothing was due". Two different facts must not share one answer.
  const asOfDay = dayOf(asOf);
  if (Number.isNaN(asOfDay)) return err('invalid_input', { field: 'asOf' });

  // THE CLAMP, and it is a refusal rather than a silent clamp for the same reason. Rounding a future
  // `asOf` back to today would answer `{ occurrences: 0 }` to a caller that asked a question this
  // engine will not answer, and a caller that passed tomorrow by mistake would never learn of it.
  const nowDay = dayOf(now);
  if (!Number.isNaN(nowDay) && asOfDay > nowDay) {
    return err('as_of_in_future', { asOf, now });
  }

  // FOUR COUNTS RATHER THAN ONE, and the missing distinction is the other half of the G3 finding.
  // `occurrences` counted what the SOURCES produced, which is not what happened to them: a tick whose
  // every occurrence was already accounted for reported the same number as one that fired them all.
  // "Fired nothing and said nothing" is the property that kept the `event_ref` collapse invisible, so
  // the answer now says which of the four each occurrence was. `occurrences` is kept, with its old
  // meaning intact, because it is what the Studio reads today.
  // `refused` joined with F5-C1: an occurrence whose rule names a denied verb is neither fired nor
  // skipped-by-condition, and folding it into `suppressed` would hide the one count an operator
  // needs to notice a rule the denylist has since overtaken.
  const counts = { fired: 0, alreadyAccounted: 0, skipped: 0, suppressed: 0, refused: 0 };
  const record = (outcome: FireOutcome): void => {
    if (outcome === 'fired') counts.fired += 1;
    else if (outcome === 'refused') counts.refused += 1;
    else if (outcome === 'already_accounted') counts.alreadyAccounted += 1;
    else if (outcome === 'skipped') counts.skipped += 1;
    else counts.suppressed += 1;
  };
  let fired = 0;

  for (const source of TICK_SOURCES) {
    if (source.events.length === 0) continue;
    const placeholders = source.events.map(() => '?').join(', ');
    const rules = ctx.store.db
      .prepare(
        `SELECT id, name, trigger_event, condition, action_tool, action_input, created_by, last_fired_at
           FROM automation_rule
          WHERE workspace_id = ? AND enabled = 1 AND archived = 0 AND trigger_event IN (${placeholders})
          ORDER BY created_at`,
      )
      .all(ctx.workspaceId, ...source.events) as TickRuleRow[];

    for (const rule of rules) {
      const occurrences = source.due(ctx, rule, rule.last_fired_at, asOf);
      if (occurrences.length === 0) continue;
      for (const ev of occurrences) record(evaluateAndFire(ctx, invoke, rule, ev));
      fired += occurrences.length;
      const latest = occurrences[occurrences.length - 1];
      if (latest !== undefined) {
        ctx.store.db
          .prepare('UPDATE automation_rule SET last_fired_at = ? WHERE workspace_id = ? AND id = ?')
          .run(latest.entityId, ctx.workspaceId, rule.id);
      }
    }
  }

  return ok({ asOf, occurrences: fired, ...counts });
}
