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
import { capabilityFor, capabilityPort, isGovernedSeat, requiredCapabilitiesFor } from '../core/access/index.js';
import { agentDecisionGrantFor } from '../core/agent/decisionGrant.js';
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
import { actionInputTypeMismatch, actionInputRequiredGap, normalizeActionInput, bindGovernedDispatch, getAction } from './registry.js';
import { unknownFields, unknownFieldsMode, unknownFieldRefusal, type UnknownFieldWarning } from './input-boundary.js';
import { undoHintFor, UNDO_HINTS_SETTING } from './undo-hints.js';
import { getSetting } from '../core/settings/settings.js';
import { assertCapability } from '../core/access/index.js';
import { planAgentSettingsCall, refuseTooManyProposals, SETTINGS_WRITE_VERBS, type AgentSettingsPlan } from '../core/settings/agentAccess.js';
import { dialCapabilityForSetting } from '../core/settings/registry.js';
import { approvalPointer, HUMAN_DECISION_CAPABILITY, type ApprovalPointer } from './approval-pointer.js';
import { isGrantLive, type PortalGrantRow } from '../core/portal/index.js';
import type { DraftAttachPrep } from '../core/files/index.js';
import { addVorschlagHolders, draftReceiptHolders, isProposeInstead, type ReceiptHolder } from '../core/files/receiptGuard.js';
import { refuseReservedIdempotencyKey } from '../core/store/idempotencyArgs.js';
import { stripSecretsDeep } from '../core/agent/secretArgs.js';

/**
 * D161 (owner, via coordinator): the token verbs the seam governs although they take no
 * `workspaceId`. A CLOSED, named set, never a general pre-workspace bypass: the customer-portal accept
 * marks a customer's quote binding, a books and statutory consequence, so an agent seat holding a
 * live token proposes it in the grant's own workspace and a person approves.
 */
const TOKEN_WORKSPACE_VERBS: ReadonlySet<string> = new Set(['portal_quote_accept']);

/*
 * A42: the trace keeps no payer of a settlement document. That is enforced at the SINK, `insertCall`
 * (`core/agent/tracePrivacy.ts`), for every branch below, never here (re-cut after three critic FAILs: a guard run
 * where a caller remembers to run it missed a position each round).
 */

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
          : // D198 re-cut R7 (critic r3 M1): a credential TILL keeps only in the OS secret store never reaches
            // the trace, WHEREVER it sits (a `call_tool { args: { feedToken } }` included): every field the
            // one secret-argument registry names is stripped at any depth (`stripSecretsDeep`).
            JSON.stringify(stripSecretsDeep(entry.input));
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

/** The one verb that still answers while the adopted book is unavailable: it is how the Studio learns it. */
export const ADOPTED_BOOK_UNAVAILABLE_ALLOWED: ReadonlySet<string> = new Set(['delivery_status']);
export const ADOPTED_BOOK_UNAVAILABLE = 'adopted_book_unavailable';

/**
 * D166 point 8 (critic N1), THE CHOKEPOINT: while `till up` runs on an in-memory stand-in for an
 * adopted book it could not open, EVERY transport call (MCP and REST, every seat, every verb a later
 * capability adds) is refused here, before the trace, the dial or the verb, except `delivery_status`.
 * A per-verb list would miss the next verb; this cannot.
 */
function refuseUnavailableBook(deps: ApiDeps, name: string): Result | undefined {
  const unavailable = deps.adoptedBookUnavailable;
  if (unavailable === undefined || ADOPTED_BOOK_UNAVAILABLE_ALLOWED.has(name)) return undefined;
  return err(ADOPTED_BOOK_UNAVAILABLE, {
    action: name,
    path: unavailable.path,
    reason: unavailable.reason,
    message: `The TILL book you adopted is not reachable: ${unavailable.path}. Nothing was done. Open TILL to try again, choose another book or forget it.`,
  });
}

/**
 * What the governed seam decided BEFORE the verb runs: either a finished answer (a refusal, a denial, a
 * draft), or the verb is to run and `execute` records its outcome afterwards. Splitting the decision
 * from the run is what lets the SAME rules serve the synchronous door (`runGoverned`) and the awaiting
 * one (`runGovernedAsync`, D142), with not one rule written twice.
 */
type GovernedPlan = { done: Result } | { execute: (outcome: Result) => Result };

const PASS_THROUGH: GovernedPlan = { execute: (outcome) => outcome };

/** N02 (D183): a preparation (`ActionDef.prepareDraft`) rather than a refusal or nothing. */
function isDraftPrep(value: unknown): value is DraftAttachPrep {
  return typeof value === 'object' && value !== null && typeof (value as { stage?: unknown }).stage === 'function';
}

/** N02 (D183): a draft's staging refused (or its enqueue did); thrown inside the draft transaction to roll it back. */
class DraftStagingRefused extends Error {
  /** `recorded`: a staging refusal is traced as not_draftable; an enqueue that failed answers as it always did. */
  constructor(
    public readonly result: Result,
    public readonly recorded: boolean,
  ) {
    super(result.ok ? 'draft_staging_refused' : result.error);
  }
}

/**
 * Dispatch one transport call. For every non-agent actor this IS `action.run`, byte for byte. For
 * the agent seat it records the call, and for a dial-governed write it routes execute/draft/deny.
 */
export function runGoverned(deps: ApiDeps, action: ActionDef, input: ActionInput): Result {
  const unavailable = refuseUnavailableBook(deps, action.name);
  if (unavailable !== undefined) return unavailable;
  // N01 security review: a key only the system mints is refused at the door, for every face and actor.
  const reserved = refuseReservedIdempotencyKey(input);
  if (reserved !== undefined) return reserved;
  const screened = screenTransportInput(deps, action, input);
  if ('refused' in screened) return screened.refused;
  const outcome = withinStoredRuleTx(deps, action, () => {
    const plan = planGoverned(deps, action, input);
    if ('done' in plan) return plan.done;
    return plan.execute(action.run(deps, input));
  });
  return finishTransport(deps, action, input, screened.warnings, outcome);
}

// N01: the batch verbs and `call_tool` dispatch their items through THIS door (a binding, so the module
// graph stays acyclic: the registry cannot import the gate, which imports the registry).
bindGovernedDispatch(runGoverned);

/** N01 US-N01.8: the longest `agentReason` a governed write stores on its Vorschlag. */
export const AGENT_REASON_MAX_LENGTH = 500;

/**
 * N01, the transport half of the input boundary (US-N01.4, US-N01.8), run for EVERY seat at both doors and
 * never for an internal invoke (those call `action.run` directly). `agentReason` must be a string of at most
 * 500 characters. An unknown top-level field is a warning, a refusal or nothing, by the seat's setting
 * (`mcp.unknown_fields_agent` for a governed agent seat, `mcp.unknown_fields_studio` for every other seat).
 * A refusal waits for the A24 gate: a caller the verb would deny is told `permission_denied` by the verb, and
 * never learns how a workspace it may not read is set.
 */
function screenTransportInput(
  deps: ApiDeps,
  action: ActionDef,
  input: ActionInput,
): { refused: Result } | { warnings: UnknownFieldWarning[] } {
  const reason = input.agentReason;
  if (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.length > AGENT_REASON_MAX_LENGTH)) {
    return { refused: err('invalid_input', { field: 'agentReason', maxLength: AGENT_REASON_MAX_LENGTH, reason: 'agentReason is one sentence of at most 500 characters' }) };
  }
  const unknown = unknownFields(action.inputSchema, input);
  if (unknown.length === 0) return { warnings: [] };
  const workspaceId = typeof input.workspaceId === 'string' && input.workspaceId.length > 0 ? input.workspaceId : undefined;
  const known = workspaceId !== undefined && deps.store.db.prepare('SELECT 1 AS p FROM workspace WHERE id = ?').get(workspaceId) !== undefined;
  const ctx = known && workspaceId !== undefined ? contextFor(deps, workspaceId) : undefined;
  // N01 critic: the workspace's setting is read only for a caller the verb's own A24 rule admits; anyone
  // else gets the default (warn) and meets the verb's own denial, learning nothing of how the book is set.
  let admitted = ctx !== undefined && workspaceId !== undefined;
  if (admitted && workspaceId !== undefined) {
    const port = capabilityPort(deps.store, workspaceId, deps.actor, deps.identitySource);
    admitted = requiredCapabilitiesFor(action.name, input).every((capability) => port.assert(capability).ok);
  }
  const mode = admitted ? unknownFieldsMode(ctx, isAgentSeat(deps)) : 'warn';
  if (mode === 'ignore') return { warnings: [] };
  if (mode === 'warn') return { warnings: unknown };
  return { refused: unknownFieldRefusal(action.name, unknown) };
}

/**
 * N01: what the transport adds to an answer, never to the stored act: the unknown-field warnings (appended
 * to a verb's own `warnings` when it has them) and, for an executed write that has an unambiguous inverse,
 * the undo hint (`src/api/undo-hints.ts`, setting `agent.undo_hints`).
 */
function finishTransport(deps: ApiDeps, action: ActionDef, input: ActionInput, warnings: readonly UnknownFieldWarning[], outcome: Result): Result {
  let result = outcome;
  if (warnings.length > 0) {
    const own = (result as { warnings?: unknown }).warnings;
    result = { ...result, warnings: [...(Array.isArray(own) ? own : []), ...warnings] } as Result;
  }
  const hint = action.kind === 'write' ? undoHintFor(action.name, input, result) : undefined;
  if (hint !== undefined && undoHintsOn(deps, input)) result = { ...result, undo: hint } as Result;
  return result;
}

function undoHintsOn(deps: ApiDeps, input: ActionInput): boolean {
  const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId : '';
  try {
    return getSetting<string>(contextFor(deps, workspaceId), UNDO_HINTS_SETTING) !== 'off';
  } catch {
    return true;
  }
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
  const unavailable = refuseUnavailableBook(deps, action.name);
  if (unavailable !== undefined) return unavailable;
  const reserved = refuseReservedIdempotencyKey(input);
  if (reserved !== undefined) return reserved;
  // A stored-rule write has no `runAsync`: it takes the synchronous door, so its read and its write
  // share one transaction there (critic L2).
  if (action.runAsync === undefined && readsStoredRule(action.name)) return runGoverned(deps, action, input);
  const screened = screenTransportInput(deps, action, input);
  if ('refused' in screened) return screened.refused;
  const plan = planGoverned(deps, action, input);
  if ('done' in plan) return finishTransport(deps, action, input, screened.warnings, plan.done);
  const outcome = action.runAsync !== undefined ? await action.runAsync(deps, input) : action.run(deps, input);
  return finishTransport(deps, action, input, screened.warnings, plan.execute(outcome));
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
  // R1 (N02, `receiptGuard.ts`): only a PERSON confirms a second booking of a receipt. An agent that
  // passes `bookAgain` is refused here, before anything is drafted, so no Vorschlag ever carries an
  // agent's confirmation into an approval.
  if (action.kind === 'write' && input.bookAgain !== undefined && input.bookAgain !== false) {
    const refused = err('human_only', { field: 'bookAgain', reason: 'only a person confirms a second booking of a receipt; an agent proposes it' });
    record(deps, workspaceId, {
      verb: action.name, kind: action.kind, input, mode: 'deny', reason: 'human_only', result: refused, durationMs: Date.now() - started,
    });
    return { done: refused };
  }
  // THE ONE TIER PICK (D141.5, critic R4-1): the name-keyed map, then the input-keyed rules (G22: the
  // ePortal attestation input of checklist_item_complete is governed under vat-file, the rest of the
  // verb is not), and for a write that lets an automation rule fire, the tier of the verb the STORED
  // rule fires with `customize` as a floor (`src/core/agent/ruleTier.ts`).
  // D202 points 4 and 5: the agent seat's settings write takes its own route before the dial
  // (`core/settings/agentAccess.ts`): a protected key is a person-only Vorschlag, a key in an area the owner
  // opened applies at once, any other key keeps the dial of its family (named here, so the reason the verb no
  // longer requires can never make the call slip past the dial's input-keyed rule).
  let settingsDial: string | undefined;
  if (action.kind === 'write') {
    // An input too incomplete to draft is refused by the generic screen below (D156 F1), as for every verb.
    const settingsPlan = undraftableField(action, input) === undefined ? planAgentSettingsCall(contextFor(deps, workspaceId), action.name, input) : null;
    if (settingsPlan !== null) {
      if (settingsPlan.route !== 'dial') return planSettingsRoute(deps, action, input, workspaceId, settingsPlan, started);
      settingsDial = settingsPlan.dialCapability;
    } else if (SETTINGS_WRITE_VERBS.has(action.name) && typeof input.key === 'string' && input.key.length > 0) {
      // Every other governed seat (a plugin call): the key's own family, whatever the input holds beside the
      // key, so no settings write of a governed seat is ever ungoverned (D202 security review).
      settingsDial = dialCapabilityForSetting(input.key);
    }
  }
  const dialCapability =
    action.kind === 'write' ? (settingsDial ?? governedDialCapability(contextFor(deps, workspaceId), action.name, input)) : undefined;

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
      // N01 US-N01.1: an account NUMBER becomes its id before the screen and the draft (the input
      // boundary `run` applies too), so a Vorschlag stores what the verb will see, and a number that names
      // no account is refused here exactly as a direct call refuses it, with nothing drafted.
      const normalized = normalizeActionInput(deps, action, input);
      if (!normalized.ok) {
        record(deps, workspaceId, {
          verb: action.name, kind: action.kind, input, mode: 'deny', reason: 'not_draftable',
          dialCapability, result: normalized.error, durationMs: Date.now() - started,
        });
        return { done: normalized.error };
      }
      input = normalized.input;
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
      const drafted = draftCall(deps, action, input, ctx, workspaceId, dialCapability, decision.reason, started);
      // D196 item 8: only the dial's own draft (never a receipt-holder draft, never `force_ask`).
      return { done: decision.reason === 'dial_ask' ? decideInOneCall(deps, action, ctx, workspaceId, drafted) : drafted };
    }
    return {
      execute: (outcome) => {
        // R1: the act met a receipt that already evidences another live booking. An agent never books
        // it a second time, at any dial: the call becomes a Vorschlag whose card shows the holders.
        if (isProposeInstead(outcome)) return draftCall(deps, action, input, ctx, workspaceId, dialCapability, 'receipt_already_booked', started, outcome.holders);
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
      // R1: an ungoverned door that met a receipt holder is proposed too, so a person decides on the
      // second booking (filed under the verb's own dial family, else `RECEIPT_DIAL_FALLBACK`).
      if (isProposeInstead(outcome)) {
        return draftCall(deps, action, input, contextFor(deps, workspaceId), workspaceId, governable[0] ?? RECEIPT_DIAL_FALLBACK, 'receipt_already_booked', started, outcome.holders);
      }
      record(deps, workspaceId, {
        verb: action.name, kind: action.kind, input,
        mode: 'execute', reason: action.kind === 'read' ? 'read' : 'ungoverned',
        result: outcome, durationMs: Date.now() - started,
      });
      return withHumanDecisionPointer(deps, outcome);
    },
  };
}

/**
 * D202 points 4 and 5: the agent seat's settings write on a route of its own (G00 §11.5). Never reached for
 * the dial route, which continues in `planGoverned` with the key's family.
 *  - `refuse`: the pure screen failed (or an ask-first key): nothing is drafted, the trace says why.
 *  - `propose`: a protected key. The seat's ROLE must hold the owning capability (A24 step 0 lifted for this
 *    check only: proposing `agent.decide_proposals` is what D202 point 5 allows, approving it stays a
 *    person's), the open cap holds (I8), the verb's own pre-draft screen runs (it claims the idempotency
 *    arguments), and the call is drafted under every dial: a person-only Vorschlag (I1, I5).
 *  - `standing`: a non-protected key in an area the owner opened. The A24 gate as for any write, then the
 *    verb runs; its history row says `standing` and names the area.
 */
function planSettingsRoute(
  deps: ApiDeps,
  action: ActionDef,
  input: ActionInput,
  workspaceId: string,
  plan: Exclude<AgentSettingsPlan, { route: 'dial' }>,
  started: number,
): GovernedPlan {
  // Security review (no value oracle): a refusal of the screen and an `unchanged` answer come only after the
  // A24 check the call's own route runs (step 0 lifted for a proposal, exactly as below), so a seat without the
  // right is told `permission_denied` whatever the value or the setting's state.
  if (plan.route === 'refuse' || plan.route === 'unchanged') {
    for (const capability of requiredCapabilitiesFor(action.name, input)) {
      const allowed = assertCapability(deps.store, workspaceId, deps.actor, capability, deps.identitySource, plan.delegated);
      if (!allowed.ok) {
        record(deps, workspaceId, {
          verb: action.name, kind: action.kind, input, mode: 'deny', reason: 'permission_denied',
          dialCapability: typeof input.key === 'string' ? dialCapabilityForSetting(input.key) : undefined,
          result: allowed, durationMs: Date.now() - started,
        });
        return { done: withHumanDecisionPointer(deps, allowed) };
      }
    }
  }
  if (plan.route === 'refuse') {
    record(deps, workspaceId, {
      verb: action.name, kind: action.kind, input, mode: 'deny',
      reason: plan.result.error === 'human_only' ? 'human_only' : 'not_draftable',
      dialCapability: typeof input.key === 'string' ? dialCapabilityForSetting(input.key) : undefined,
      result: plan.result, durationMs: Date.now() - started,
    });
    return { done: plan.result };
  }
  if (plan.route === 'unchanged') {
    const result = ok(plan.result) as Result;
    record(deps, workspaceId, {
      verb: action.name, kind: action.kind, input, mode: 'execute', reason: 'unchanged', result, durationMs: Date.now() - started,
    });
    return { done: result };
  }
  const deny = (result: Result, dialCapability?: string): GovernedPlan => {
    record(deps, workspaceId, {
      verb: action.name, kind: action.kind, input, mode: 'deny', reason: result.ok ? 'not_draftable' : result.error === 'permission_denied' ? 'permission_denied' : 'not_draftable',
      dialCapability, result, durationMs: Date.now() - started,
    });
    return { done: withHumanDecisionPointer(deps, result) };
  };
  if (plan.route === 'standing') {
    const port = capabilityPort(deps.store, workspaceId, deps.actor, deps.identitySource);
    for (const capability of requiredCapabilitiesFor(action.name, input)) {
      const allowed = port.assert(capability);
      if (!allowed.ok) return deny(allowed);
    }
    return {
      execute: (outcome) => {
        record(deps, workspaceId, {
          verb: action.name, kind: action.kind, input, mode: 'execute', reason: 'standing_permission',
          result: outcome, durationMs: Date.now() - started,
        });
        return withHumanDecisionPointer(deps, outcome);
      },
    };
  }
  // A person-only Vorschlag.
  for (const capability of requiredCapabilitiesFor(action.name, input)) {
    const allowed = assertCapability(deps.store, workspaceId, deps.actor, capability, deps.identitySource, true);
    if (!allowed.ok) return deny(allowed, plan.dialCapability);
  }
  const ctx = contextFor(deps, workspaceId);
  const crowded = refuseTooManyProposals(ctx, action.name, input);
  if (crowded !== null) return deny(crowded, plan.dialCapability);
  const invalid = action.prevalidate?.(deps, input);
  if (invalid !== undefined) return deny(invalid, plan.dialCapability);
  // The cap again, inside the draft's own transaction (critic L2): the check above answers early, this one
  // holds against a second process that drafted meanwhile.
  return {
    done: draftCall(deps, action, input, ctx, workspaceId, plan.dialCapability, plan.reason, started, [], () => refuseTooManyProposals(ctx, action.name, input)),
  };
}

/**
 * D196 item 8 (owner, 12.11.2026): THE AGENT'S ONE-CALL IGNORIEREN. The verbs whose dial draft the agent seat's
 * OWN call also approves under the owner's grant: a closed set of one. Nothing new is approvable: the approval
 * is the registry's own `approve_drafted_action`, run as the same seat, with every check of the two-call path
 * (the A24 boundary with step 0 lifted only for the decision verbs, the engine's grant re-check,
 * `grantExclusionFor`, the record pin, the in-transaction re-read of the grant, `decided_under_grant`).
 * `resolve_possible_duplicate`, which also ignores a line, is not in it. A widening adds ONE verb with its own
 * critic review (D196 item 4b).
 */
export const ONE_CALL_UNDER_GRANT_VERBS: ReadonlySet<string> = new Set(['ignore_bank_line']);

/** The D172 setting that carries it, and the value that turns it on (the default). */
export const ONE_CALL_SETTING = 'agent.ignore_under_grant';

/**
 * D196 item 8: after the dial drafted an agent seat's `ignore_bank_line`, approve that draft in the same call
 * when ALL hold: the setting is `one_call`; the owner's live grant answers `decide` for this seat
 * (`agentDecisionGrantFor`: an agent seat, never a plugin call); the seat's ROLE carries `manage_agent_dial`
 * with step 0 lifted (paper critic L7: else the registry refuses it every time, so it is not tried); the draft
 * is pending; and the Vorschlag is THIS seat's own (paper critic L6: a same-key replay may answer another
 * seat's row). Otherwise the draft answer stands, exactly as before.
 *
 * The approval's trace row names the Vorschlag in its arguments and entity, never in `agent_action_id`, which
 * marks the DRAFTING call (paper critic M3). The answer is honest either way (paper critic M1): on success the
 * verb's own result with the Vorschlag, the grant, the Vorschläge the draft replaced and the ones the decision
 * closed; on a refusal the Vorschlag's ACTUAL status (pending, rejected with its closure, stale) and the
 * refusal as `notDecided`.
 */
function decideInOneCall(deps: ApiDeps, action: ActionDef, ctx: WorkspaceContext, workspaceId: string, drafted: Result): Result {
  if (!ONE_CALL_UNDER_GRANT_VERBS.has(action.name)) return drafted;
  if (!drafted.ok || drafted.drafted !== true || drafted.status !== 'pending' || typeof drafted.actionId !== 'string') return drafted;
  let mode: string;
  try {
    mode = getSetting<string>(ctx, ONE_CALL_SETTING);
  } catch {
    return drafted;
  }
  if (mode !== 'one_call') return drafted;
  if (agentDecisionGrantFor(ctx, 'approve_drafted_action') === null) return drafted;
  if (!capabilityFor(deps.store, workspaceId, deps.actor, 'manage_agent_dial', deps.identitySource, true)) return drafted;
  const actionId = drafted.actionId;
  const own = deps.store.db.prepare('SELECT actor FROM agent_action WHERE workspace_id = ? AND id = ?').get(workspaceId, actionId) as { actor: string } | undefined;
  if (own === undefined || own.actor !== deps.actor) return drafted;

  const approve = getAction('approve_drafted_action');
  if (approve === undefined) return drafted;
  const approveInput: ActionInput = { workspaceId, actionId };
  const started = Date.now();
  const approval = approve.run(deps, approveInput);
  record(deps, workspaceId, {
    verb: approve.name, kind: approve.kind, input: approveInput, mode: 'execute', reason: 'one_call_under_grant',
    result: approval, durationMs: Date.now() - started,
  });
  const superseded = Array.isArray(drafted.supersededActionIds) ? { supersededActionIds: drafted.supersededActionIds } : {};
  const row = deps.store.db
    .prepare('SELECT status, closure_kind, history_json FROM agent_action WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, actionId) as { status: string; closure_kind: string | null; history_json: string | null } | undefined;
  if (approval.ok && row?.status === 'executed') {
    // An executed row answers its stored verb result on a replay, a fresh approval wraps it.
    const verbResult = (approval.status === 'executed' && typeof approval.result === 'object' && approval.result !== null ? approval.result : approval) as Result;
    if (verbResult.ok) return ok({ ...verbResult, ...oneCallFacts(deps, workspaceId, actionId, verbResult, row.history_json), ...superseded });
  }
  // Not decided: say where the Vorschlag actually stands, and why.
  const refusal = approval.ok ? { error: 'not_executed' } : { error: approval.error, ...pick(approval, ['reason', 'grantExclusion', 'replayRefusal', 'ownerCanGrant']) };
  return ok({
    ...drafted,
    status: row?.status ?? drafted.status,
    ...(row?.closure_kind ? { closureKind: row.closure_kind } : {}),
    notDecided: refusal,
  });
}

/**
 * D196 item 8: what a one-call decision adds to the verb's own answer: the Vorschlag, the grant it rode, and the
 * Vorschläge of other seats THIS decision closed as "Zeile entschieden". An ignore that found the line already
 * ignored decided nothing (code critic M1): it closed nothing, whatever that earlier decision closed.
 */
function oneCallFacts(deps: ApiDeps, workspaceId: string, actionId: string, verbResult: Result, historyJson: string | null): Record<string, unknown> {
  const linkId = typeof verbResult.linkId === 'string' && verbResult.alreadyIgnored !== true ? verbResult.linkId : null;
  const closed = linkId === null
    ? []
    : (deps.store.db
        .prepare("SELECT id FROM agent_action WHERE workspace_id = ? AND closed_by_link_id = ? AND closure_kind = 'line_decided' ORDER BY id")
        .all(workspaceId, linkId) as { id: string }[]).map((r) => r.id);
  return { actionId, decidedUnderGrant: grantOnRow(historyJson), closedActionIds: closed };
}

/**
 * D196 item 8 (code critic L2): a same-key retry of a one-call decision answers like the first call did, so an
 * agent that lost the first answer still learns the Vorschlag and the grant.
 */
function withOneCallFacts(deps: ApiDeps, action: ActionDef, workspaceId: string, actionId: string | undefined, stored: Result): Result {
  if (!ONE_CALL_UNDER_GRANT_VERBS.has(action.name) || actionId === undefined || !stored.ok) return stored;
  const row = deps.store.db.prepare('SELECT history_json FROM agent_action WHERE workspace_id = ? AND id = ?').get(workspaceId, actionId) as { history_json: string | null } | undefined;
  if (row === undefined) return stored;
  return ok({ ...stored, ...oneCallFacts(deps, workspaceId, actionId, stored, row.history_json) });
}

/** The `decided_under_grant` entry on a Vorschlag's history (scope, grantor, moment), or null. */
function grantOnRow(historyJson: string | null): { scope: unknown; grantedBy: unknown; grantedAt: unknown } | null {
  try {
    const history = JSON.parse(historyJson ?? '[]') as unknown;
    if (!Array.isArray(history)) return null;
    for (const e of history as Record<string, unknown>[]) {
      if (e !== null && typeof e === 'object' && e.event === 'decided_under_grant') return { scope: e.scope, grantedBy: e.grantedBy, grantedAt: e.grantedAt };
    }
  } catch {
    return null;
  }
  return null;
}

/** The named fields of a refusal that are present. */
function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (source[k] !== undefined) out[k] = source[k];
  return out;
}

/**
 * R1: the dial capability a Vorschlag is filed under when an UNGOVERNED door met a receipt holder (no
 * dial names the verb): `close-period`, the one `files_link` takes to a booking record (`dialMap.ts`).
 */
const RECEIPT_DIAL_FALLBACK = 'close-period';

/**
 * The draft half of a governed call (D141, N02): store what the draft needs (`ActionDef.prepareDraft`),
 * queue the Vorschlag, record it. Shared by a call the dial drafts and by a call whose execution met a
 * receipt holder (R1, `metHolders`): an agent's second booking of a receipt is always a proposal.
 */
function draftCall(
  deps: ApiDeps,
  action: ActionDef,
  input: ActionInput,
  ctx: WorkspaceContext,
  workspaceId: string,
  dialCapability: string,
  reason: string,
  started: number,
  metHolders: readonly ReceiptHolder[] = [],
  /**
   * D202 critic L2: a check that must hold INSIDE the draft's own write transaction (BEGIN IMMEDIATE), so a
   * second process cannot slip a row in between a check outside and the draft (the open-proposal cap).
   */
  guardInTx?: () => Result | null,
): Result {
  const decision = { reason };
  // N02 (D183): what the draft must store BEFORE it queues (a `sourcePath` receipt, read once and kept
  // pending), and the payload the Vorschlag then carries. Its I/O runs here, outside the transaction;
  // a refusal queues nothing, exactly like the `prevalidate` above.
  const prepared = action.prepareDraft?.(deps, ctx, input);
  if (prepared !== undefined && !isDraftPrep(prepared) && prepared.ok === false) {
    record(deps, workspaceId, {
      verb: action.name, kind: action.kind, input, mode: 'deny', reason: 'not_draftable',
      dialCapability, result: prepared, durationMs: Date.now() - started,
    });
    return prepared;
  }
  const staging = isDraftPrep(prepared) ? prepared : undefined;
  // Inside `store.tx` (M3, critic R1 F1): a draft is a row too, and a pending Vorschlag queued
  // into a book a newer TILL migrated meanwhile would be replayed by the wrong build later.
  let drafted: Result;
  try {
    drafted = ctx.store.tx(() => {
      const guarded = guardInTx?.() ?? null;
      if (guarded !== null) throw new DraftStagingRefused(guarded, true);
      const staged = staging?.stage();
      if (staged !== undefined && 'refusal' in staged) throw new DraftStagingRefused(staged.refusal, true);
      const queued = enqueueDraftedAction(ctx, {
        actionTool: action.name,
        payload: staged?.payload ?? input,
        dialCapability,
        // D177 (critic D177-C1): a draft supersedes older Vorschläge only after the verb's own full
        // pre-draft screen passed (the `prevalidate` above answered nothing).
        screened: action.prevalidate !== undefined,
      });
      // A draft that did not queue keeps nothing it staged: the throw rolls the staging back.
      if (staging !== undefined && !queued.ok) throw new DraftStagingRefused(queued, false);
      staging?.settle(queued);
      // R1: the receipt holders the act would meet, stored on a FRESH Vorschlag for its card (the
      // attach staging's, the door's own, and a refusal's that turned the call into this draft).
      if (queued.ok && queued.replayed !== true && typeof queued.actionId === 'string') {
        addVorschlagHolders(ctx, queued.actionId, [...(staging?.holders?.() ?? []), ...draftReceiptHolders(ctx, action.name, staged?.payload ?? input), ...metHolders]);
      }
      return queued;
    });
  } catch (e) {
    if (e instanceof DraftStagingRefused) {
      if (e.recorded) {
        record(deps, workspaceId, {
          verb: action.name, kind: action.kind, input, mode: 'deny', reason: 'not_draftable',
          dialCapability, result: e.result, durationMs: Date.now() - started,
        });
      }
      return e.result;
    }
    if (e instanceof SchemaNewerThanRuntimeError) return err(SCHEMA_NEWER_THAN_RUNTIME, { action: action.name, ...refusalFields(e) });
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
      return err('store_busy', { action: action.name, retryable: true, partial: false, message });
    }
    throw e;
  }
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
    return withOneCallFacts(deps, action, workspaceId, actionId, stored);
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
    // D177 (critic D177-C3): the drafting agent learns which of its Vorschläge this one replaced.
    ...(Array.isArray(drafted.supersededActionIds) ? { supersededActionIds: drafted.supersededActionIds } : {}),
  });
  record(deps, workspaceId, {
    verb: action.name, kind: action.kind, input, mode: 'draft', reason: replayed ? 'replayed' : decision.reason,
    dialCapability, result, durationMs: Date.now() - started,
    agentActionId: actionId,
  });
  return result;
}
