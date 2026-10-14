/**
 * A35, THE GOVERNED TRANSPORT DISPATCH: the one seam where an agent seat's calls meet the dial and
 * the trace.
 *
 * WHERE IT SITS, AND WHY EXACTLY THERE. Both transport doors, `callTool` (MCP stdio and MCP-over-HTTP
 * both funnel through it) and `handleRest`, call `runGoverned` instead of `action.run` directly. That
 * placement buys three structural facts at once:
 *
 *  1. THE TRACE IS COMPLETE for what it claims to cover: every call an agent seat makes over either
 *     transport lands exactly one `agent_call` row, all registry verbs, including verbs whose modules
 *     never call `ctx.audit.record` (design row 10.2).
 *  2. THE DIAL FINALLY ROUTES agent writes (A26 built `decideAction` and nothing ever called it): a
 *     governed write drafts at `ask`, executes at a granted `auto`, and is denied before any write
 *     when RBAC says no, in the registry's own check order.
 *  3. INTERNAL DISPATCH IS UNTOUCHED BY CONSTRUCTION: G01 firings and the approval replay go through
 *     `invokerFor`'s direct `action.run`, the suites drive `action.run`, and a human at the Studio
 *     arrives as `studio`. None of them opens a session, drafts, or lands in the trace, which is what
 *     keeps "what did the agent do" answerable (design §2a: humans via GUI do not open sessions).
 *
 * A RECORDER FAILURE NEVER CHANGES A VERB RESULT: recording is wrapped, and a throw becomes a
 * diagnostics entry (the `emitAutomationEvents` posture).
 */

import { createHash } from 'node:crypto';
import { ok, err } from '../core/result.js';
import type { Result } from '../core/result.js';
import { SCHEMA_NEWER_THAN_RUNTIME, SchemaNewerThanRuntimeError, refusalFields } from '../core/store/generation.js';
import { isBusyError } from '../core/store/sqlite-store.js';
import { makeContext } from '../core/context.js';
import type { WorkspaceContext } from '../core/context.js';
import { capabilityPort, isGovernedSeat, requiredCapabilitiesFor } from '../core/access/index.js';
import {
  governedDialCapability,
  dialCapabilitiesForVerb,
  readsStoredRule,
  decideAction,
  dialCapabilityIsForceAsk,
  effectiveDialLevel,
  instanceEffectiveDialLevel,
  INSTANCE_WIDE_DIAL_ACTIONS,
  enqueueDraftedAction,
  entityRefOf,
  recordAgentCall,
} from '../core/agent/index.js';
import type { ActionDef, ActionInput, ApiDeps } from './registry.js';
import { actionInputTypeMismatch, actionInputRequiredGap } from './registry.js';
import { approvalPointer, HUMAN_DECISION_CAPABILITY, type ApprovalPointer } from './approval-pointer.js';
import { isGrantLive, type PortalGrantRow } from '../core/portal/index.js';

/**
 * D161 (owner, via coordinator): the token verbs the seam governs although they take no
 * `workspaceId`. A CLOSED, named set, never a general pre-workspace bypass: the customer-portal accept
 * marks a customer's quote binding, a books and statutory consequence, so an agent seat holding a
 * live token proposes it in the grant's own workspace and a person approves.
 */
const TOKEN_WORKSPACE_VERBS: ReadonlySet<string> = new Set(['portal_quote_accept']);

/**
 * The workspace a token verb acts in, when its token names a LIVE customer grant: the same global
 * token-hash lookup `portal_resolve` and `portal_quote_accept` make (`grantByToken` in
 * `core/portal/grants.ts`: SHA-256 of the presented token against `portal_grant.token_hash`), and the
 * same FENCE 0 they apply (`isGrantLive`, `kind = 'customer'`). Anything else answers `undefined`, and
 * the seam then passes the call to the verb untouched, so an absent, unknown, expired, revoked, draft
 * or vendor token is refused exactly as before (`grant_denied`, audited by the verb), with no trace
 * row and no tenant learned: no oracle beyond what the token itself already proves.
 */
function liveTokenWorkspace(deps: ApiDeps, name: string, input: ActionInput): string | undefined {
  if (!TOKEN_WORKSPACE_VERBS.has(name)) return undefined;
  const token = input.token;
  if (typeof token !== 'string' || token.length === 0) return undefined;
  const row = deps.store.db
    .prepare('SELECT * FROM portal_grant WHERE token_hash = ?')
    .get(createHash('sha256').update(token).digest('hex')) as PortalGrantRow | undefined;
  if (row === undefined || row.kind !== 'customer') return undefined;
  if (!isGrantLive(row, deps.clock.now().slice(0, 10))) return undefined;
  return row.workspace_id;
}

/**
 * The governed seat (D13 + M01 US-M01.3): the local `agent` actor, OR a served member whose `user`
 * row is of kind `agent`. `studio` and every human member pass through ungoverned. The rule itself
 * is `isGovernedSeat` in core (one place, four consumers); until F-08 this read `actor === 'agent'`
 * and a served agent member (`member:<user_id>`) executed governed writes at `ask`, untraced.
 */
function isAgentSeat(deps: ApiDeps): boolean {
  return isGovernedSeat(deps.store, deps.actor);
}

/**
 * The pre-draft screen: a drafted action must be an input its verb could plausibly accept, because
 * the approval replays `payload_json` exactly and a queue of garbage would make the approver the
 * error handler. Type mismatches and absent/blank schema-required fields never draft.
 *
 * AND THEY NEVER RUN EITHER (D156 critic F1, 10.10.2026). Until then a governed call that failed this
 * screen FELL THROUGH to `action.run` so the verb's own boundary could answer it, on the premise that
 * the verb refuses what its schema requires. That premise was false: `contacts_anonymise` without an
 * `idempotencyKey` (or with `''`) erased a contact as the agent with no Vorschlag, because the engine
 * treated the key as optional. A dial-governed call that cannot be drafted is now refused HERE with
 * `invalid_input` naming the field, the same code the registry's type check answers, and nothing runs.
 * Returns the offending field, or undefined when the input is draftable.
 */
function undraftableField(action: ActionDef, input: ActionInput): string | undefined {
  // The registry face refuses the same gap with the same answer (`actionInputRequiredGap`), so the
  // agent's faces and the direct one agree on every incomplete call (conformance rule 7).
  return actionInputTypeMismatch(action.inputSchema, input) ?? actionInputRequiredGap(action.inputSchema, input);
}

/**
 * P0.5b: where a human approves, for the agent seat. It rides on every draft (`approveAt`) and on a
 * refusal to decide one (`permission_denied` naming `manage_agent_dial`), so an agent can tell its
 * human "approve it at <Studio URL>/agent" instead of retrying a verb it will never be allowed.
 */
function pointerFor(deps: ApiDeps): ApprovalPointer {
  const name = (deps.store.db as unknown as { name?: unknown }).name;
  return approvalPointer({ supportDir: deps.supportDir, ownDbPath: typeof name === 'string' ? name : null });
}

function withHumanDecisionPointer(deps: ApiDeps, outcome: Result): Result {
  if (outcome.ok || outcome.error !== 'permission_denied') return outcome;
  if ((outcome as { capability?: unknown }).capability !== HUMAN_DECISION_CAPABILITY) return outcome;
  return { ...outcome, approveAt: pointerFor(deps) };
}

function contextFor(deps: ApiDeps, workspaceId: string): WorkspaceContext {
  return makeContext(deps.store, {
    workspaceId,
    actor: deps.actor,
    clock: deps.clock,
    ids: deps.ids,
    capabilities: capabilityPort(deps.store, workspaceId, deps.actor, deps.identitySource),
  });
}

function record(
  deps: ApiDeps,
  workspaceId: string,
  entry: {
    verb: string;
    kind: 'read' | 'write';
    input: ActionInput;
    mode: 'execute' | 'draft' | 'deny';
    reason: string;
    dialCapability?: string | undefined;
    result: Result;
    durationMs: number;
    agentActionId?: string | undefined;
  },
): void {
  try {
    // Critic F2: the transport row must never become a third copy of the conversation. The
    // composer's sentence lives on the TURN (D-5, deletable there); recording it verbatim here
    // would put it in a row `agent_prose_delete` cannot reach by session. So the prose field is
    // stripped at the seam, with a marker so the Details disclosure stays honest about the omission.
    // D161: a portal token is a bearer secret TILL otherwise stores only hashed; the trace row keeps
    // the call without it (the drafted payload keeps it, because the approval replays it).
    const argsJson =
      entry.verb === 'agent_ask'
        ? JSON.stringify({ ...entry.input, text: undefined, textOmitted: true })
        : TOKEN_WORKSPACE_VERBS.has(entry.verb)
          ? JSON.stringify({ ...entry.input, token: undefined, tokenOmitted: true })
          : JSON.stringify(entry.input);
    // Inside `store.tx`, so the generation guard's first-statement check covers the trace rows too
    // (M3, critic R1 F1): the session, turn and call rows commit together or, in a book a newer TILL
    // migrated meanwhile, not at all. A refusal here is a recorder failure like any other (below).
    deps.store.tx(() => recordAgentCall(contextFor(deps, workspaceId), {
      verb: entry.verb,
      kind: entry.kind,
      argsJson,
      mode: entry.mode,
      decisionReason: entry.reason,
      dialCapability: entry.dialCapability,
      callOk: entry.result.ok,
      ...(entry.result.ok ? {} : { errorCode: entry.result.error }),
      ...(entry.mode === 'execute' ? { entityRef: entityRefOf(entry.result) } : {}),
      durationMs: entry.durationMs,
      agentActionId: entry.agentActionId,
      transportKey: deps.agentTransportKey,
      clientLabel: deps.agentClientLabel,
    }));
  } catch (e) {
    // The trace must never break the verb: a recorder defect is a diagnostics entry, not an outcome.
    deps.diagnostics?.record({
      kind: 'verb_error',
      at: new Date().toISOString(),
      code: 'agent_trace_failed',
      action: entry.verb,
      error: e,
    });
  }
}

/**
 * The generation guard at the transport seam: the typed refusal as a Result when the book has moved
 * on to a generation newer than this build since the store opened it, else undefined.
 */
function refuseMovedOnBook(deps: ApiDeps, name: string): Result | undefined {
  try {
    deps.store.assertGenerationKnown();
    return undefined;
  } catch (e) {
    if (e instanceof SchemaNewerThanRuntimeError) return err(SCHEMA_NEWER_THAN_RUNTIME, { action: name, ...refusalFields(e) });
    throw e;
  }
}

/**
 * What the governed seam decided BEFORE the verb runs: either a finished answer (a refusal, a denial, a
 * draft), or the verb is to run and `execute` records its outcome afterwards. Splitting the decision
 * from the run is what lets the SAME rules serve the synchronous door (`runGoverned`) and the awaiting
 * one (`runGovernedAsync`, D142), with not one rule written twice.
 */
type GovernedPlan = { done: Result } | { execute: (outcome: Result) => Result };

const PASS_THROUGH: GovernedPlan = { execute: (outcome) => outcome };

/**
 * Dispatch one transport call. For every non-agent actor this IS `action.run`, byte for byte. For
 * the agent seat it records the call, and for a dial-governed write it routes execute/draft/deny.
 */
export function runGoverned(deps: ApiDeps, action: ActionDef, input: ActionInput): Result {
  return withinStoredRuleTx(deps, action, () => {
    const plan = planGoverned(deps, action, input);
    if ('done' in plan) return plan.done;
    return plan.execute(action.run(deps, input));
  });
}

/**
 * Critic L2 (D141.5 R4-1): for a governed seat, a write whose dial tier is read from a STORED rule
 * (`enable_automation_rule`, `update_automation_rule`) runs its tier read, its draft-or-execute decision
 * and the verb's own write inside ONE write transaction (BEGIN IMMEDIATE). Without it a second process
 * on the same file (D12) could repoint the rule to `post_entry` between the read and the write, and the
 * enable would execute at the tier the rule HAD. Every other call is untouched. Neither verb emits an
 * automation event, so no firing runs inside the widened transaction; the writes inside it (the trace
 * row, the draft, the idempotency record) nest as savepoints.
 */
function withinStoredRuleTx(deps: ApiDeps, action: ActionDef, run: () => Result): Result {
  if (!readsStoredRule(action.name) || !isAgentSeat(deps)) return run();
  try {
    return deps.store.tx(run);
  } catch (e) {
    if (e instanceof SchemaNewerThanRuntimeError) return err(SCHEMA_NEWER_THAN_RUNTIME, { action: action.name, ...refusalFields(e) });
    // The write lock was not obtained within the busy timeout: nothing of this call ran.
    if (isBusyError(e)) {
      deps.diagnostics?.record({ kind: 'verb_error', at: new Date().toISOString(), code: 'store_busy', action: action.name, error: e });
      const message = e instanceof Error ? e.message : String(e);
      return err('store_busy', { action: action.name, retryable: true, partial: false, message });
    }
    throw e;
  }
}

/**
 * D142: the same dispatch for a door that can await. A verb with a `runAsync` (the host may run it off
 * the main thread, `bank_sync` under `till up`) is awaited; every other verb runs exactly as in
 * `runGoverned`. The trace, the dial and the refusals are the ones `planGoverned` decides for both.
 */
export async function runGovernedAsync(deps: ApiDeps, action: ActionDef, input: ActionInput): Promise<Result> {
  // A stored-rule write has no `runAsync`: it takes the synchronous door, so its read and its write
  // share one transaction there (critic L2).
  if (action.runAsync === undefined && readsStoredRule(action.name)) return runGoverned(deps, action, input);
  const plan = planGoverned(deps, action, input);
  if ('done' in plan) return plan.done;
  const outcome = action.runAsync !== undefined ? await action.runAsync(deps, input) : action.run(deps, input);
  return plan.execute(outcome);
}

function planGoverned(deps: ApiDeps, action: ActionDef, input: ActionInput): GovernedPlan {
  if (!isAgentSeat(deps)) return PASS_THROUGH;

  // D161: a token verb acts in the workspace of its LIVE customer grant (the closed set above) and in
  // no other: a `workspaceId` the caller adds is not its tenant (the verb ignores it), so it is ignored
  // here too, and a token that resolves to nothing passes to the verb exactly as before.
  const workspaceId = TOKEN_WORKSPACE_VERBS.has(action.name)
    ? liveTokenWorkspace(deps, action.name, input)
    : typeof input.workspaceId === 'string' && input.workspaceId.length > 0
      ? input.workspaceId
      : undefined;
  // M3 (critic R1 F1): a book a newer TILL migrated under this process is refused HERE, before the
  // trace records the call and before a dial-governed write is drafted, because both of those write
  // rows of their own that no verb's check sees. The scope is the registry's own: every workspace
  // call and every pre-workspace write (a pre-workspace read writes no trace row).
  if (workspaceId !== undefined || action.kind === 'write') {
    const refused = refuseMovedOnBook(deps, action.name);
    if (refused !== undefined) return { done: refused };
  }
  if (workspaceId === undefined) {
    // Pre-workspace verbs (and a missing tenant) have no tenant to record under AT CALL TIME
    // (§H-TENANT). Critic F8: for the tenant-MINTING verbs the tenant exists the moment the call
    // returns, and the Result names it, so the agent's FIRST act on a set of books (create_workspace,
    // bootstrap_workspace, onboard_client, restore_backup, ...) is recorded after the fact into the
    // workspace it minted. A no-tenant verb whose Result names no workspace (the residue, listed in
    // the spec §4) stays unrecorded, stated rather than silently claimed.
    const started = Date.now();
    return {
      execute: (outcome) => {
        if (outcome.ok && typeof outcome.workspaceId === 'string' && outcome.workspaceId.length > 0) {
          const minted = outcome.workspaceId;
          const exists = deps.store.db.prepare('SELECT 1 AS p FROM workspace WHERE id = ?').get(minted);
          if (exists !== undefined) {
            record(deps, minted, {
              verb: action.name, kind: action.kind, input,
              mode: 'execute', reason: action.kind === 'read' ? 'read' : 'ungoverned',
              result: outcome, durationMs: Date.now() - started,
            });
          }
        }
        return outcome;
      },
    };
  }
  const exists = deps.store.db.prepare('SELECT archived FROM workspace WHERE id = ?').get(workspaceId) as
    | { archived: number }
    | undefined;
  if (exists === undefined) return PASS_THROUGH;

  const started = Date.now();
  // THE ONE TIER PICK (D141.5, critic R4-1): the name-keyed map, then the input-keyed rules (G22: the
  // ePortal attestation input of checklist_item_complete is governed under vat-file, the rest of the
  // verb is not), and for a write that lets an automation rule fire, the tier of the verb the STORED
  // rule fires with `customize` as a floor (`src/core/agent/ruleTier.ts`).
  const dialCapability =
    action.kind === 'write' ? governedDialCapability(contextFor(deps, workspaceId), action.name, input) : undefined;

  // F1: a call that cannot be drafted is refused, never run (see `undraftableField`), when its verb
  // CAN be dial-governed: governed by name, or carrying an input-keyed rule whose match an incomplete
  // input could merely have dodged (`book_bank_line` without `bankTxnId`, a rule write without its id).
  const governable = action.kind === 'write' ? dialCapabilitiesForVerb(action.name) : [];
  const undraftable = dialCapability !== undefined || governable.length > 0 ? undraftableField(action, input) : undefined;
  if (undraftable !== undefined) {
    const refused = err('invalid_input', { field: undraftable });
    record(deps, workspaceId, {
      verb: action.name, kind: action.kind, input, mode: 'deny', reason: 'not_draftable',
      dialCapability: dialCapability ?? governable[0], result: refused, durationMs: Date.now() - started,
    });
    return { done: refused };
  }

  if (dialCapability !== undefined) {
    // The registry's own order: the A24 gate, then the dial. A denial lands BEFORE any write; an
    // input that failed the draftable screen was refused above and never reaches the verb.
    const port = capabilityPort(deps.store, workspaceId, deps.actor, deps.identitySource);
    for (const capability of requiredCapabilitiesFor(action.name, input)) {
      const allowed = port.assert(capability);
      if (!allowed.ok) {
        record(deps, workspaceId, {
          verb: action.name, kind: action.kind, input, mode: 'deny', reason: 'permission_denied',
          dialCapability, result: allowed, durationMs: Date.now() - started,
        });
        return { done: withHumanDecisionPointer(deps, allowed) };
      }
    }
    const ctx = contextFor(deps, workspaceId);
    const decision = decideAction({
      isRead: false,
      permitted: true,
      // D156 critic nit: an environment verb reads the most restrictive level on the instance.
      level: INSTANCE_WIDE_DIAL_ACTIONS.has(action.name)
        ? instanceEffectiveDialLevel(ctx, dialCapability)
        : effectiveDialLevel(ctx, dialCapability).effective,
      forceAsk: dialCapabilityIsForceAsk(ctx, dialCapability),
    });
    if (decision.mode === 'draft') {
      // D158: a verb that declares its own pure validation (`ActionDef.prevalidate`) runs it BEFORE a
      // draft is queued. An input the verb would refuse gets the verb's own Result here, the same one a
      // direct call answers, so drafting never turns a refusal into a 200 (A04's REST/MCP parity broke
      // that way for the opening position), and the approver is never handed a proposal that can only
      // fail. Generic by construction: no verb name is read here. Recorded as the not-draftable refusal.
      const invalid = action.prevalidate?.(deps, input);
      if (invalid !== undefined) {
        record(deps, workspaceId, {
          verb: action.name, kind: action.kind, input, mode: 'deny', reason: 'not_draftable',
          dialCapability, result: invalid, durationMs: Date.now() - started,
        });
        return { done: invalid };
      }
      // Inside `store.tx` (M3, critic R1 F1): a draft is a row too, and a pending Vorschlag queued
      // into a book a newer TILL migrated meanwhile would be replayed by the wrong build later.
      let drafted: Result;
      try {
        drafted = ctx.store.tx(() =>
          enqueueDraftedAction(ctx, {
            actionTool: action.name,
            payload: input,
            dialCapability,
          }),
        );
      } catch (e) {
        if (e instanceof SchemaNewerThanRuntimeError) return { done: err(SCHEMA_NEWER_THAN_RUNTIME, { action: action.name, ...refusalFields(e) }) };
        // D12 (critic R2-2): the draft's transaction waited out the busy timeout behind the other
        // process's write lock. This runs outside the registry's `guarded()`, so without this the
        // SQLITE_BUSY escaped `callTool` as a JSON-RPC internal error and `handleRest` as a bare 500;
        // it is the same retryable `store_busy` every verb answers, and nothing was queued.
        if (isBusyError(e)) {
          deps.diagnostics?.record({
            kind: 'verb_error',
            at: new Date().toISOString(),
            code: 'store_busy',
            action: action.name,
            error: e,
          });
          const message = e instanceof Error ? e.message : String(e);
          // `partial: false`: the seam wrote nothing of this call before the draft (see `guarded`).
          return { done: err('store_busy', { action: action.name, retryable: true, partial: false, message }) };
        }
        throw e;
      }
      if (!drafted.ok) return { done: drafted };
      const actionId = typeof drafted.actionId === 'string' ? drafted.actionId : undefined;
      const replayed = drafted.replayed === true;
      // F-08 (c): a same-key replay of a draft the human ALREADY APPROVED answers with the verb's own
      // stored result, which is exactly what the verb's idempotency would answer had the call executed:
      // one object, one result, recorded as an execute row that points at that object (`entityRef`)
      // and at the draft it settled through, with a reason that says nothing ran again.
      if (replayed && drafted.status === 'executed' && typeof drafted.result === 'object' && drafted.result !== null) {
        const stored = drafted.result as Result;
        record(deps, workspaceId, {
          verb: action.name, kind: action.kind, input, mode: 'execute', reason: 'idempotent_replay',
          dialCapability, result: stored, durationMs: Date.now() - started, agentActionId: actionId,
        });
        return { done: stored };
      }
      // A fresh draft, or a replay of a draft still pending (or already rejected): the SAME Vorschlag,
      // named by the id the key minted the first time, never a second one (J3.10).
      const result = ok({
        drafted: true,
        actionId: drafted.actionId,
        status: typeof drafted.status === 'string' ? drafted.status : 'pending',
        dialCapability,
        reason: decision.reason,
        replayed,
        approveAt: pointerFor(deps),
      });
      record(deps, workspaceId, {
        verb: action.name, kind: action.kind, input, mode: 'draft', reason: replayed ? 'replayed' : decision.reason,
        dialCapability, result, durationMs: Date.now() - started,
        agentActionId: actionId,
      });
      return { done: result };
    }
    return {
      execute: (outcome) => {
        record(deps, workspaceId, {
          verb: action.name, kind: action.kind, input, mode: 'execute', reason: decision.reason,
          dialCapability, result: outcome, durationMs: Date.now() - started,
        });
        return withHumanDecisionPointer(deps, outcome);
      },
    };
  }

  return {
    execute: (outcome) => {
      record(deps, workspaceId, {
        verb: action.name, kind: action.kind, input,
        mode: 'execute', reason: action.kind === 'read' ? 'read' : 'ungoverned',
        result: outcome, durationMs: Date.now() - started,
      });
      return withHumanDecisionPointer(deps, outcome);
    },
  };
}
