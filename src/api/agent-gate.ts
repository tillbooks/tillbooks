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

import { ok } from '../core/result.js';
import type { Result } from '../core/result.js';
import { makeContext } from '../core/context.js';
import type { WorkspaceContext } from '../core/context.js';
import { capabilityPort, isGovernedSeat, requiredCapabilitiesFor } from '../core/access/index.js';
import {
  dialCapabilityForCall,
  decideAction,
  dialCapabilityIsForceAsk,
  effectiveDialLevel,
  enqueueDraftedAction,
  entityRefOf,
  recordAgentCall,
} from '../core/agent/index.js';
import type { ActionDef, ActionInput, ApiDeps } from './registry.js';
import { actionInputTypeMismatch } from './registry.js';

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
 * error handler. An input that fails this screen is NOT rejected here: it FALLS THROUGH to
 * `action.run`, so the verb's own boundary answers with the verb's own code and the wire faces stay
 * byte-identical with the direct registry face (rule 7). The screen only decides whether drafting is
 * on the table at all: type mismatches and absent/blank required fields never draft.
 */
function isDraftable(action: ActionDef, input: ActionInput): boolean {
  if (actionInputTypeMismatch(action.inputSchema, input) !== undefined) return false;
  for (const field of action.inputSchema.required) {
    const value = input[field];
    if (value === undefined || value === null) return false;
    const declared = (action.inputSchema.properties[field] as { type?: unknown } | undefined)?.type;
    if (declared === 'string' && typeof value !== 'string') return false;
    if (declared === 'string' && (value as string).length === 0) return false;
  }
  return true;
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
    const argsJson =
      entry.verb === 'agent_ask'
        ? JSON.stringify({ ...entry.input, text: undefined, textOmitted: true })
        : JSON.stringify(entry.input);
    recordAgentCall(contextFor(deps, workspaceId), {
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
    });
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
 * Dispatch one transport call. For every non-agent actor this IS `action.run`, byte for byte. For
 * the agent seat it records the call, and for a dial-governed write it routes execute/draft/deny.
 */
export function runGoverned(deps: ApiDeps, action: ActionDef, input: ActionInput): Result {
  if (!isAgentSeat(deps)) return action.run(deps, input);

  const workspaceId = typeof input.workspaceId === 'string' && input.workspaceId.length > 0 ? input.workspaceId : undefined;
  if (workspaceId === undefined) {
    // Pre-workspace verbs (and a missing tenant) have no tenant to record under AT CALL TIME
    // (§H-TENANT). Critic F8: for the tenant-MINTING verbs the tenant exists the moment the call
    // returns, and the Result names it, so the agent's FIRST act on a set of books (create_workspace,
    // bootstrap_workspace, onboard_client, restore_backup, ...) is recorded after the fact into the
    // workspace it minted. A no-tenant verb whose Result names no workspace (the residue, listed in
    // the spec §4) stays unrecorded, stated rather than silently claimed.
    const started = Date.now();
    const outcome = action.run(deps, input);
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
  }
  const exists = deps.store.db.prepare('SELECT archived FROM workspace WHERE id = ?').get(workspaceId) as
    | { archived: number }
    | undefined;
  if (exists === undefined) return action.run(deps, input);

  const started = Date.now();
  // The name-keyed map, then the input-keyed rules (G22: the ePortal attestation input of
  // checklist_item_complete is governed under vat-file, the rest of the verb is not).
  const dialCapability = action.kind === 'write' ? dialCapabilityForCall(action.name, input) : undefined;

  if (dialCapability !== undefined && isDraftable(action, input)) {
    // The registry's own order: the A24 gate, then the dial. A denial lands BEFORE any write; an
    // input that failed the draftable screen skipped this branch entirely and runs below, so the
    // verb's own boundary rejects it with the verb's own code, identically on every face.
    const port = capabilityPort(deps.store, workspaceId, deps.actor, deps.identitySource);
    for (const capability of requiredCapabilitiesFor(action.name, input)) {
      const allowed = port.assert(capability);
      if (!allowed.ok) {
        record(deps, workspaceId, {
          verb: action.name, kind: action.kind, input, mode: 'deny', reason: 'permission_denied',
          dialCapability, result: allowed, durationMs: Date.now() - started,
        });
        return allowed;
      }
    }
    const ctx = contextFor(deps, workspaceId);
    const decision = decideAction({
      isRead: false,
      permitted: true,
      level: effectiveDialLevel(ctx, dialCapability).effective,
      forceAsk: dialCapabilityIsForceAsk(ctx, dialCapability),
    });
    if (decision.mode === 'draft') {
      const drafted = enqueueDraftedAction(ctx, {
        actionTool: action.name,
        payload: input,
        dialCapability,
      });
      if (!drafted.ok) return drafted;
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
        return stored;
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
      });
      record(deps, workspaceId, {
        verb: action.name, kind: action.kind, input, mode: 'draft', reason: replayed ? 'replayed' : decision.reason,
        dialCapability, result, durationMs: Date.now() - started,
        agentActionId: actionId,
      });
      return result;
    }
    const outcome = action.run(deps, input);
    record(deps, workspaceId, {
      verb: action.name, kind: action.kind, input, mode: 'execute', reason: decision.reason,
      dialCapability, result: outcome, durationMs: Date.now() - started,
    });
    return outcome;
  }

  const outcome = action.run(deps, input);
  record(deps, workspaceId, {
    verb: action.name, kind: action.kind, input,
    mode: 'execute', reason: action.kind === 'read' ? 'read' : 'ungoverned',
    result: outcome, durationMs: Date.now() - started,
  });
  return outcome;
}
