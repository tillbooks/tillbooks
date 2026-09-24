/**
 * G01's fire path: the one place an automation ever causes a write.
 *
 * G00 STORES DATA; G01 TAKES ACTIONS, UNATTENDED, ON AN APPEND-ONLY LEDGER. Every structural decision
 * in this file exists because of that sentence, so each one is written down beside the code rather
 * than left to be re-derived by whoever debugs it at 03:00.
 *
 * 1. THERE IS NO SECOND WRITE PATH. An action is invoked through the `ActionInvoker` the caller hands
 *    in, which resolves a name out of `ACTIONS` and calls the SAME `action.run` the MCP stdio server
 *    and the REST twins call. Nothing in this module imports a ledger verb, and nothing in it can
 *    reach one: the P3 guarantee is structural rather than a test. The tenant check, the boundary type
 *    check, the A24 capability gate and the throw guard therefore all apply to a fired action exactly
 *    as they apply to a human's call, because they are literally the same code.
 *
 * 2. A FIRING RUNS AS THE RULE'S AUTHOR AND THERE IS NO AUTOMATION IDENTITY. `invoke` takes the actor
 *    as an argument and `evaluateAndFire` always passes `rule.created_by`. The capability is resolved
 *    LIVE at that moment through the shared dispatch, never cached at save time, so a revoked or
 *    demoted author's rules begin failing `permission_denied` on their next fire with no further
 *    mechanism and nothing to remember to invalidate. D13 asks whether automation needs a third actor
 *    beside `studio` and `agent`: it must not have one. An `automation` actor would need capabilities
 *    of its own and `capabilityFor` would have to grant them, which is a hole straight through the
 *    permission system 74 specs depend on. Automation is not an identity, it is a REASON a known
 *    identity acted, and a reason belongs in the run log, which is where it is.
 *
 * 3. IDEMPOTENCY IS A ROW CONSTRAINT, NOT A CODE PATH. The run row is claimed by an INSERT that the
 *    `automation_run_once` UNIQUE index refuses on a redelivery, before any action is invoked. If
 *    every line below were wrong, a replayed event still could not fire twice. The derived
 *    `idempotencyKey` handed to the target verb is a SECOND, independent layer.
 *
 * 4. THE ENGINE IS AT-MOST-ONCE, DELIBERATELY. The row is claimed as `running` before the invocation
 *    and settled exactly once after it. A process that dies in between leaves a `running` row that
 *    never re-fires and that a human can see. On this ledger a missed follow-up is visible and
 *    repairable by hand; a double post is a correction entry in the books.
 *
 * 5. A DISPATCH FAILURE NEVER CHANGES THE EMITTING VERB'S RESULT. `dispatchAutomationEvent` returns
 *    void and swallows its own errors into run rows. An automation defect must not be able to turn a
 *    good post into a failed one.
 *
 * 6. LOOPS ARE REFUSED, DETECTED AND BOUNDED, AND EVERY SUPPRESSION IS LOGGED. See `CascadeFrame`
 *    below. A silent loop guard is a loop guard nobody can debug.
 */

import { createHash } from 'node:crypto';

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { automationEventDef, eventsEmittedBy, readPath } from './events.js';
import { conditionHolds, resolveTemplate } from './condition.js';
import { isNotAutomatable } from './denylist.js';

/** The run statuses (§H-ENUM). `running` is the claim; the other five are terminal. */
export const RUN_STATUSES: readonly string[] = [
  'running',
  'ok',
  'failed',
  'skipped_condition',
  'suppressed_loop',
  'suppressed_depth',
];

/**
 * How a fired action reaches the shared dispatch, without this module importing it.
 *
 * `asActor` is not optional and has no default on purpose. A default would be a system identity by
 * another name, and the one thing point 2 above forbids is exactly that.
 */
export type ActionInvoker = (
  tool: string,
  input: Record<string, unknown>,
  asActor: string,
) => Result;

export interface AutomationEvent {
  readonly event: string;
  readonly entityKind?: string | undefined;
  readonly entityId: string;
  /** What a condition and a template read: `{ input, result }` for a verb event. */
  readonly payload: Record<string, unknown>;
  /** The OCCURRENCE key. Two deliveries of one occurrence share it; two occurrences never do. */
  readonly eventRef: string;
}

export interface RuleRow {
  id: string;
  name: string;
  trigger_event: string;
  condition: string;
  action_tool: string;
  action_input: string;
  created_by: string;
}

/**
 * Beyond this many nested firings a cascade stops, whatever it is doing.
 *
 * Three, and the number is a judgement rather than a measurement: two is a rule reacting to a rule,
 * which is a legitimate and useful shape (post -> issue -> notify), and three leaves one step of
 * headroom over the deepest chain anyone has articulated a use for. A cascade that genuinely needs
 * four steps is a cascade whose author should be told, which is what `suppressed_depth` does.
 */
export const MAX_CASCADE_DEPTH = 3;

/**
 * The loop guard's state, module-scoped for the duration of ONE top-level dispatch.
 *
 * A MODULE-SCOPED FRAME IS SAFE HERE AND IS NOT A RACE, because the whole engine is synchronous:
 * `better-sqlite3` is a synchronous driver, every verb returns a value rather than a promise, and a
 * cascade therefore runs to completion before any other call can be dispatched. The alternative
 * (threading a frame through `ActionInvoker`, through `action.run`, through every verb signature, and
 * back out into the next dispatch) would put a G01 parameter on seventy-six verbs that have nothing
 * to do with automation. If the engine ever becomes asynchronous this is the first thing that must
 * move, and that is said here so it is found.
 */
interface CascadeFrame {
  depth: number;
  fired: Set<string>;
}

let frame: CascadeFrame | undefined;

/**
 * THE OCCURRENCE KEY, and why the entity id alone was not one.
 *
 * `event_ref` is supposed to key the OCCURRENCE, not the delivery: two deliveries of one write share
 * it, two occurrences never do. The entity id delivers the first half and, for three registry rows,
 * silently broke the second. `period.closed`, `period.reopened` and `vat.period_filed` all key on
 * `input.period`, which is `2026-03` every time that month is closed. Measured on 29.07.2026: a rule
 * on `period.closed` fired on the first close of 2026-03, and after a legitimate reopen the SECOND
 * real close produced no firing, no run row and no trace at all. A month-end automation stops working
 * after the first correction and nothing says so.
 *
 * THE DISCRIMINATOR IS THE EMITTING WRITE'S OWN IDEMPOTENCY KEY, which is exactly the thing that
 * already distinguishes a redelivery from a new call everywhere else in this engine. Two deliveries
 * of one write carry the same key (that is what makes them one write, and the second one is answered
 * from `rememberIdempotent`'s memo, which still reaches this dispatch because it returns ok), so they
 * still collapse onto one `event_ref`: the guard `events.ts` reasons about for `invoice.issued` is
 * preserved exactly, and preserving it is why the key is appended rather than substituted. Two
 * genuine closes of the same month carry different keys, so they are two occurrences, which they are.
 *
 * ALL THREE REPEATABLE EVENTS REQUIRE THE KEY, verified against the live registry rather than assumed:
 * `close_month`, `reopen_month` and `vat_mark_filed` all carry `idempotencyKey` in `required`. The
 * events whose key is optional (`contact.created`, `document.created`, `invoice.issued`,
 * `invoice.sent`) key on a freshly minted id or on an id their own state machine will not admit
 * twice, so they never needed a discriminator and adding one where it exists changes nothing for
 * them: a mint cannot produce the same id under two different keys.
 *
 * NO BRANCH ON AN EVENT NAME, which is the property `events.ts` says the whole design rests on. The
 * rule is uniform: append the caller's key when the caller supplied one.
 */
function occurrenceKey(event: string, rawId: string, input: Record<string, unknown>): string {
  const key = input.idempotencyKey;
  return typeof key === 'string' && key.length > 0
    ? `${event}:${rawId}:${key}`
    : `${event}:${rawId}`;
}

/** The derived key that makes the TARGET verb refuse a double-execute independently of our index. */
const DERIVED_KEY_PREFIX = 'auto:';
const DERIVED_KEY_DIGEST_LENGTH = 16;
function derivedIdempotencyKey(ruleId: string, eventRef: string): string {
  const digest = createHash('sha256').update(`${ruleId}::${eventRef}`).digest('hex');
  return `${DERIVED_KEY_PREFIX}${ruleId}:${digest.slice(0, DERIVED_KEY_DIGEST_LENGTH)}`;
}

/**
 * The rule id a derived idempotency key names, or undefined for any other key. The reader of the
 * shape `derivedIdempotencyKey` writes, kept beside it so the two cannot drift: G22's
 * `checklist_start` records the rule as the run's creator (spec §10.8) when the workspace carries it.
 * A rule id may itself contain colons (`builtin:checklist_autostart:month_close`), so the digest is
 * cut off the END, never split off the first colon.
 */
export function automationRuleIdOfKey(key: string): string | undefined {
  if (!key.startsWith(DERIVED_KEY_PREFIX)) return undefined;
  const body = key.slice(DERIVED_KEY_PREFIX.length);
  const cut = body.length - DERIVED_KEY_DIGEST_LENGTH - 1;
  if (cut <= 0 || body[cut] !== ':' || !/^[0-9a-f]+$/.test(body.slice(cut + 1))) return undefined;
  return body.slice(0, cut);
}

function enabledRulesFor(ctx: WorkspaceContext, event: string): RuleRow[] {
  return ctx.store.db
    .prepare(
      `SELECT id, name, trigger_event, condition, action_tool, action_input, created_by
         FROM automation_rule
        WHERE workspace_id = ? AND trigger_event = ? AND enabled = 1 AND archived = 0
        ORDER BY created_at`,
    )
    .all(ctx.workspaceId, event) as RuleRow[];
}

/**
 * Claim the run row, or report that this occurrence is already accounted for.
 *
 * The UNIQUE index is what decides, not a SELECT: D12 puts a second process on the same database
 * file, so a check-then-insert would have a window between the two. Catching the constraint is the
 * only formulation with no window at all.
 */
function claimRun(
  ctx: WorkspaceContext,
  rule: RuleRow,
  eventRef: string,
  actionInput: Record<string, unknown>,
): string | undefined {
  const runId = ctx.ids.next('arun');
  try {
    ctx.store.db
      .prepare(
        `INSERT INTO automation_run
           (id, workspace_id, rule_id, trigger_event, event_ref, status, action_tool, action_input, actor, started_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
      )
      .run(
        runId,
        ctx.workspaceId,
        rule.id,
        rule.trigger_event,
        eventRef,
        rule.action_tool,
        JSON.stringify(actionInput),
        rule.created_by,
        ctx.clock.now(),
      );
    return runId;
  } catch (e) {
    // ONLY a unique-constraint violation is a no-op. Swallowing every error here would turn a real
    // schema fault into "no automation ever runs", silently, which is the worst possible failure mode
    // for a subsystem nobody is watching. Anything else is rethrown and lands in the shared dispatch's
    // throw guard, where it becomes a diagnostics entry.
    //
    // AND A REFUSED CLAIM IS NO LONGER SILENT. The refusal is correct and stays correct: this
    // occurrence already has a row and must not get a second one. What it must not do is vanish. The
    // existing row's redelivery counter is bumped, so "delivered again, already accounted for" is a
    // durable fact an operator can read instead of an absence they would have to infer.
    if (isUniqueViolation(e)) {
      noteRedelivery(ctx, rule, eventRef);
      return undefined;
    }
    throw e;
  }
}

/**
 * Record that an accounted-for occurrence was delivered again.
 *
 * Scoped by the UNIQUE index's own three columns, so it can only ever touch the row that refused the
 * claim, and §H-TENANT is the first of them. It deliberately does not touch `status`, `finished_at`
 * or any other fact: a redelivery changes nothing about what happened, only how many times we were
 * told about it.
 */
function noteRedelivery(ctx: WorkspaceContext, rule: RuleRow, eventRef: string): void {
  ctx.store.db
    .prepare(
      `UPDATE automation_run
          SET redeliveries = redeliveries + 1
        WHERE workspace_id = ? AND rule_id = ? AND event_ref = ?`,
    )
    .run(ctx.workspaceId, rule.id, eventRef);
}

/** `automation_run_once` refused the claim: this occurrence already has a row. */
function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

/** Settle a claimed row exactly once. The WHERE clause is what makes "exactly once" true. */
function settleRun(
  ctx: WorkspaceContext,
  runId: string,
  status: string,
  errorCode: string | undefined,
): void {
  ctx.store.db
    .prepare(
      `UPDATE automation_run
          SET status = ?, error_code = ?, finished_at = ?
        WHERE id = ? AND status = 'running'`,
    )
    .run(status, errorCode ?? null, ctx.clock.now(), runId);
}

/**
 * Write a run row for a firing that never started: a suppression or a false condition.
 *
 * These claim and settle in one statement because there is no invocation in between for a crash to
 * land in, and because a suppression that failed to record itself is the exact failure mode point 6
 * exists to prevent.
 */
function recordWithoutFiring(
  ctx: WorkspaceContext,
  rule: RuleRow,
  eventRef: string,
  status: string,
): void {
  const runId = claimRun(ctx, rule, eventRef, {});
  if (runId !== undefined) settleRun(ctx, runId, status, undefined);
}

/**
 * What one evaluation did, so a caller can tell the four apart instead of inferring from silence.
 *
 * `already_accounted` is the one that was invisible: the claim was refused by the UNIQUE index
 * because this occurrence already has a row. It is a correct outcome and a completely different fact
 * from "the condition was false" or "it fired", and until now all three returned the same nothing.
 */
export type FireOutcome = 'fired' | 'already_accounted' | 'skipped' | 'suppressed' | 'refused';

/**
 * Evaluate ONE rule against ONE occurrence and, if it holds, fire it.
 *
 * Exported for the tick, which drives the same path from a cadence rather than from a verb, so there
 * is exactly one implementation of "what happens when a rule matches".
 */
export function evaluateAndFire(
  ctx: WorkspaceContext,
  invoke: ActionInvoker,
  rule: RuleRow,
  ev: AutomationEvent,
): FireOutcome {
  if (frame !== undefined && frame.fired.has(rule.id)) {
    recordWithoutFiring(ctx, rule, ev.eventRef, 'suppressed_loop');
    return 'suppressed';
  }
  if (frame !== undefined && frame.depth >= MAX_CASCADE_DEPTH) {
    recordWithoutFiring(ctx, rule, ev.eventRef, 'suppressed_depth');
    return 'suppressed';
  }

  // THE DENYLIST, AT FIRE TIME, and this line is F5-C1's whole repair. The save path has checked
  // `isNotAutomatable` since C00, but a STORED row predating a denylist entry carries whatever
  // `action_tool` was legal the day it was saved, and the critic fired `close_year`, `set_role`,
  // `unlock_period` and `create_workspace` from exactly such rows, all `status ok`. Migration
  // generation 6 disables those rules on the next open; this check is the layer that holds even for
  // a row that arrives by any other road (a restored backup, a hand-edited file, a denylist entry
  // added between open and fire). Recorded in the Verlauf as a FAILED run carrying the same stable
  // code the save-time refusal uses, never silently skipped: a rule that stopped firing must say
  // why where the operator looks.
  if (isNotAutomatable(rule.action_tool)) {
    const runId = claimRun(ctx, rule, ev.eventRef, {});
    if (runId !== undefined) settleRun(ctx, runId, 'failed', 'action_not_automatable');
    return 'refused';
  }

  let condition: unknown = null;
  try {
    condition = JSON.parse(rule.condition) as unknown;
  } catch {
    // A stored condition that will not parse cannot be answered, and an unanswerable condition fails
    // CLOSED (see `conditionHolds`). Recorded rather than skipped so it is visible in the Verlauf.
    recordWithoutFiring(ctx, rule, ev.eventRef, 'skipped_condition');
    return 'skipped';
  }

  if (!conditionHolds(ctx, condition, ev.payload, { kind: ev.entityKind, id: ev.entityId })) {
    recordWithoutFiring(ctx, rule, ev.eventRef, 'skipped_condition');
    return 'skipped';
  }

  let template: Record<string, unknown> = {};
  try {
    template = JSON.parse(rule.action_input) as Record<string, unknown>;
  } catch {
    recordWithoutFiring(ctx, rule, ev.eventRef, 'skipped_condition');
    return 'skipped';
  }

  const resolved = resolveTemplate(template, ev.payload);
  // The tenant is never templatable: a rule may not aim an action at another workspace. This is the
  // §H-TENANT half of the fire path and it is an overwrite rather than a validation on purpose, so
  // there is no input a rule author could write that would even be considered.
  resolved.workspaceId = ctx.workspaceId;
  resolved.idempotencyKey = derivedIdempotencyKey(rule.id, ev.eventRef);

  const runId = claimRun(ctx, rule, ev.eventRef, resolved);
  // Already fired for this occurrence. The index said so, and `claimRun` has recorded the
  // redelivery on the row that refused the claim, so the caller can report it rather than say nothing.
  if (runId === undefined) return 'already_accounted';

  const outer = frame;
  frame = { depth: (outer?.depth ?? 0) + 1, fired: new Set(outer?.fired ?? []) };
  frame.fired.add(rule.id);
  let result: Result;
  try {
    result = invoke(rule.action_tool, resolved, rule.created_by);
  } catch (e) {
    result = { ok: false, error: 'unexpected_error', message: e instanceof Error ? e.message : String(e) };
  } finally {
    frame = outer;
  }

  settleRun(ctx, runId, result.ok ? 'ok' : 'failed', result.ok ? undefined : result.error);
  return 'fired';
}

/**
 * THE BUILD-ONCE HOOK, called from the shared action dispatch after a write verb returns ok.
 *
 * It is not an MCP tool and must never become one: a caller that could emit an arbitrary event could
 * fire any rule in the workspace under its author's capabilities without performing the act the rule
 * is supposed to react to. The only legitimate emitter is the verb that really did the thing.
 */
export function dispatchAutomationEvent(
  ctx: WorkspaceContext,
  invoke: ActionInvoker,
  actionName: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): void {
  const defs = eventsEmittedBy(actionName);
  if (defs.length === 0) return;

  const payload = { input, result };
  for (const def of defs) {
    const rules = enabledRulesFor(ctx, def.event);
    if (rules.length === 0) continue;
    const rawId = readPath(payload, def.entityIdPath);
    // An occurrence with no resolvable entity id has no stable key, and a fabricated one would
    // collapse every occurrence of the event onto a single `event_ref` so the rule fired exactly
    // once, ever. Skipping is the honest answer and the registry row is what is wrong.
    if (typeof rawId !== 'string' || rawId.length === 0) continue;
    const ev: AutomationEvent = {
      event: def.event,
      entityKind: def.entityKind,
      entityId: rawId,
      payload,
      eventRef: occurrenceKey(def.event, rawId, input),
    };
    for (const rule of rules) evaluateAndFire(ctx, invoke, rule, ev);
  }
}

/**
 * THE REPAIR PATH FOR A STUCK `running` ROW, and why at-most-once needed one to be finished.
 *
 * The claim-then-settle design is right and is untouched: the row is claimed before the invocation,
 * so a process that dies in between leaves a `running` row that never re-fires, and on an append-only
 * ledger a missed follow-up is better than a double post. What was missing is the other half of that
 * sentence. The design called such a row "visible and repairable by hand", and the critic enumerated
 * all ten G01 verbs and found no retry and no clear: the UNIQUE index permanently forbids re-claiming
 * that occurrence, so "by hand" meant editing the SQLite file. A safety property whose recovery path
 * is a hex editor is a safety property that will be worked around in production.
 *
 * A RETRY IS SAFE, AND IT IS THE DERIVED KEY THAT MAKES IT SO, which is the second layer point 3
 * above describes doing exactly the job it exists for. The retry re-sends the SAME stored input,
 * including `idempotencyKey: auto:<ruleId>:<hash(ruleId::eventRef)>`, which is deterministic. If the
 * lost invocation had in fact committed, the target verb answers from its own idempotency memo and
 * nothing happens twice. The verbs that carry no key are the 29 the conformance contract exempts
 * because they are ABSOLUTE state-setting writes, so a replay re-asserts the state it already
 * asserted. There is no third category, so there is no case where a retry can double-count.
 *
 * IT REUSES THE ROW RATHER THAN CLAIMING A NEW ONE, because the UNIQUE index would refuse a new one
 * and refusing is correct: this is the same occurrence, being finished, not a second one. The settle
 * still runs `WHERE status = 'running'`, so two concurrent retries cannot both settle it.
 *
 * IT RUNS AS THE ACTOR ON THE ROW, which is the rule's author restated on the row so the log stands
 * alone. That keeps the live-capability property exactly as it is for a normal firing: an author
 * demoted since the crash is refused now, and the retry records `permission_denied` like any other
 * firing. It also means a retry works after the rule has been archived, which is right, because the
 * occurrence happened while the rule was live and this only finishes it.
 *
 * WHO MAY USE IT: `manage_automations` (see `actionCapabilities.ts`). Deliberately not the tick's
 * question and not a read. A retry CAUSES a write that the engine had already declined to make.
 */
export function retryAutomationRun(
  ctx: WorkspaceContext,
  invoke: ActionInvoker,
  input: { runId: string; idempotencyKey?: string },
): Result {
  const run = (): Result => {
    const row = ctx.store.db
      .prepare(
        `SELECT id, rule_id, status, action_tool, action_input, actor
           FROM automation_run
          WHERE workspace_id = ? AND id = ?`,
      )
      .get(ctx.workspaceId, input.runId) as
      | { id: string; rule_id: string; status: string; action_tool: string; action_input: string; actor: string }
      | undefined;
    if (row === undefined) return err('not_found', { runId: input.runId });
    // ONLY a stuck claim is retryable. A settled row is history, and re-running a firing that already
    // reported `ok` or `failed` would be a second occurrence wearing the first one's id.
    if (row.status !== 'running') {
      return err('run_not_stuck', { runId: input.runId, status: row.status });
    }
    // The retry is the fire path's second door and consults the SAME denylist (F5-C1): a stuck row
    // whose `action_tool` has since been denied must not be re-driven. The row is settled as failed
    // rather than left `running` forever, because a stuck row nobody can finish is the hex-editor
    // problem this verb exists to solve, and the code names the reason where the Verlauf shows it.
    if (isNotAutomatable(row.action_tool)) {
      settleRun(ctx, row.id, 'failed', 'action_not_automatable');
      return err('action_not_automatable', { runId: input.runId, tool: row.action_tool });
    }

    let resolved: Record<string, unknown>;
    try {
      resolved = JSON.parse(row.action_input) as Record<string, unknown>;
    } catch {
      // Nothing can be re-sent, so nothing is invented. The row is settled as failed with a code that
      // says which of the two things went wrong, rather than being left stuck for ever.
      settleRun(ctx, row.id, 'failed', 'unreadable_action_input');
      return err('unreadable_action_input', { runId: input.runId });
    }
    // §H-TENANT, restated on the way out exactly as `evaluateAndFire` restates it: a stored row may
    // not aim an action at another workspace, whatever it holds.
    resolved.workspaceId = ctx.workspaceId;

    let result: Result;
    try {
      result = invoke(row.action_tool, resolved, row.actor);
    } catch (e) {
      result = { ok: false, error: 'unexpected_error', message: e instanceof Error ? e.message : String(e) };
    }
    settleRun(ctx, row.id, result.ok ? 'ok' : 'failed', result.ok ? undefined : result.error);
    return ok({ runId: row.id, status: result.ok ? 'ok' : 'failed', errorCode: result.ok ? null : result.error });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'retry_automation_run', run);
  }
  return run();
}

/**
 * Is this rule's action the very verb that emits its own trigger? The one loop a static check can see.
 *
 * Refusing it at save time is worth doing even though the runtime guard would also catch it: an error
 * in the editor, next to the field, beats a `suppressed_loop` row somebody finds a week later.
 */
export function isSelfTriggering(triggerEvent: string, actionTool: string): boolean {
  const def = automationEventDef(triggerEvent);
  return def !== undefined && def.emittedBy.length > 0 && def.emittedBy === actionTool;
}
