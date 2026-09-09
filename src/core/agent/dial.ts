/**
 * A26 THE DIAL: `decideAction` (the execute-vs-draft policy), and the `agent_dial` read/write pair.
 *
 * The dial is the safety valve the whole agent story rests on (§6b): every agent WRITE is routed
 * through `decideAction`, which returns `execute` ONLY when the actor holds the capability AND the
 * dial level is `auto` AND the action is not force-ask. Anything else drafts, and a drafted action is
 * inert until a human approves it. The dial can only ever make a write MORE restrictive, never bypass
 * RBAC or any §H check (those are re-evaluated at execution time, §7), so a permissive dial setting is
 * a convenience and never a second authorisation path.
 *
 * `decideAction` is deliberately a PURE function over four booleans/enums rather than a database read,
 * so its truth table is unit-testable in isolation (§8) and so the caller (the write dispatch, at
 * integration) supplies the RBAC outcome and the resolved level it already holds. The dial LEVEL is
 * resolved separately by `readDialLevel`, and the RBAC outcome by A24's own port: keeping the two
 * facts out of this function is what keeps it honest under test.
 */

import type { WorkspaceContext } from '../context.js';
import type { Result } from '../result.js';
import { ok, err } from '../result.js';
import { requireString } from '../ledger/inputGuards.js';
import { isGovernedSeat } from '../access/capability.js';

/** The closed set of dial-governed capabilities (§4/§6b: a fixed list, an unknown value is rejected). */
export const DIAL_CAPABILITIES: readonly string[] = [
  'post',
  'issue',
  'send',
  'dun',
  'pay',
  'vat-file',
  'customize',
  'plugin-install',
  // close-period: sealing an accounting period (close_year, lock_period). A hard seal is irreversible.
  'close-period',
  // go-live: the migration cutover into the real books (go_productive, import_open_items).
  'go-live',
];
const DIAL_CAPABILITY_SET = new Set(DIAL_CAPABILITIES);

/**
 * The capabilities whose dial default is a STRONG default rather than an ordinary one (D103,
 * 2026-08-17, supersedes the FORCE-ASK hard bar). `vat-file` files with the ESTV (externally
 * irreversible) and `plugin-install` brings third-party code into the workspace, so both ship at
 * `ask` and are NEVER flipped by any bulk act (none exists: `set_agent_dial` writes exactly one row).
 * But no capability is permanently un-automatable any more: an explicit, attributed, per-capability
 * grant by an actor holding `manage_agent_dial` sets either to `auto`. The grant is revocable
 * (`set_agent_dial` back to `ask`) and FAIL-CLOSED: a stored `auto` row on this pair whose
 * attribution is missing (`updated_by` null, a row no attributed act wrote) resolves EFFECTIVE `ask`,
 * which is exactly the stored-versus-effective disagreement the Vertrauen table renders (row 8.3).
 * RBAC is still the backstop under both (US-A26.9).
 */
export const STRONG_DEFAULT_ASK_CAPABILITIES: ReadonlySet<string> = new Set(['vat-file', 'plugin-install']);

export type DialLevel = 'ask' | 'auto';
const DIAL_LEVELS: readonly string[] = ['ask', 'auto'];

export function isDialCapability(value: unknown): value is string {
  return typeof value === 'string' && DIAL_CAPABILITY_SET.has(value);
}

export type DecideMode = 'execute' | 'draft' | 'deny';

export interface DecideInput {
  /** A read is always allowed and never drafts (readOnlyHint verbs). */
  readonly isRead: boolean;
  /** Whether the actor holds the underlying verb's A24 capability (resolved by the caller). */
  readonly permitted: boolean;
  /** The resolved dial level for the governing capability (`readDialLevel`). */
  readonly level: DialLevel;
  /** Whether the governing dial capability is force-ask (`dialCapabilityIsForceAsk`). */
  readonly forceAsk: boolean;
}

export interface Decision {
  readonly mode: DecideMode;
  readonly reason: string;
}

/**
 * THE DIAL, as a pure truth table (§8):
 *  - read                              -> execute (always allowed, never mutates)
 *  - write + role-denied               -> deny    (permission_denied, before any write)
 *  - write + force-ask                 -> draft   (D103: a strong-default capability with no
 *                                                  attributed grant; a GRANTED one is not force-ask)
 *  - write + dial=auto + permitted     -> execute
 *  - write + dial=ask  + permitted     -> draft
 */
export function decideAction(input: DecideInput): Decision {
  if (input.isRead) return { mode: 'execute', reason: 'read' };
  if (!input.permitted) return { mode: 'deny', reason: 'permission_denied' };
  if (input.forceAsk) return { mode: 'draft', reason: 'force_ask' };
  if (input.level === 'auto') return { mode: 'execute', reason: 'dial_auto' };
  return { mode: 'draft', reason: 'dial_ask' };
}

/**
 * Whether a capability's dial FORCES a draft for this workspace right now. Under D103 this is no
 * longer a property of the capability alone: it is "strong default AND not explicitly granted", so a
 * granted `vat-file` executes at `auto` while an ungranted (or unattributed) one drafts with the
 * reason `force_ask`.
 */
export function dialCapabilityIsForceAsk(ctx: WorkspaceContext, dialCapability: string): boolean {
  if (!STRONG_DEFAULT_ASK_CAPABILITIES.has(dialCapability)) return false;
  return effectiveDialLevel(ctx, dialCapability).effective !== 'auto';
}

/** Resolve the STORED dial level for one capability. An absent row means the safe `ask`. */
export function readDialLevel(ctx: WorkspaceContext, dialCapability: string): DialLevel {
  const row = ctx.store.db
    .prepare('SELECT level FROM agent_dial WHERE workspace_id = ? AND capability = ?')
    .get(ctx.workspaceId, dialCapability) as { level: string } | undefined;
  return row?.level === 'auto' ? 'auto' : 'ask';
}

/** One capability's stored and effective level, with the attribution that separates them (D103). */
export interface DialResolution {
  stored: DialLevel;
  effective: DialLevel;
  strongDefault: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

/**
 * D103's one resolution rule, in one place, HARDENED per the A35 critic's F1 (18.08.2026).
 * `effective` is `auto` only when a stored `auto` row exists AND the row is attributed to a
 * NON-AGENT actor, on EVERY governed capability and not only the strong-default pair. A grant is an
 * act by a HUMAN holding `manage_agent_dial`; a row nobody signed, a row the agent seat wrote
 * (pre-hardening data, or any future path that slips), and a row carried into a tenant by a restore
 * all fail CLOSED to `ask` and render as the stored-versus-effective disagreement (row 8.3).
 */
export function effectiveDialLevel(ctx: WorkspaceContext, dialCapability: string): DialResolution {
  const row = ctx.store.db
    .prepare('SELECT level, updated_by, updated_at FROM agent_dial WHERE workspace_id = ? AND capability = ?')
    .get(ctx.workspaceId, dialCapability) as { level: string; updated_by: string | null; updated_at: string | null } | undefined;
  const strongDefault = STRONG_DEFAULT_ASK_CAPABILITIES.has(dialCapability);
  const stored: DialLevel = row?.level === 'auto' ? 'auto' : 'ask';
  // F-08 (d): "a non-agent actor" is the governed-seat rule, so a row a served agent member signed
  // (`member:<user_id>` of kind `agent`) is as unattributed as one the local `agent` signed.
  const attributed =
    typeof row?.updated_by === 'string' && row.updated_by.length > 0 && !isGovernedSeat(ctx.store, row.updated_by);
  const effective: DialLevel = stored === 'auto' && attributed ? 'auto' : 'ask';
  return { stored, effective, strongDefault, updatedBy: row?.updated_by ?? null, updatedAt: row?.updated_at ?? null };
}

/**
 * The ONE dial writer, shared by `set_agent_dial` and the D103 grant arm of `approve_drafted_action`
 * ("approve and allow in future"): one store, one attribution, one revocation path. Writes exactly
 * one row, which is the structural fact behind "never flipped by any bulk act".
 */
export function writeDialLevel(ctx: WorkspaceContext, capability: string, level: DialLevel, idempotencyKey: string): void {
  // The last line of the F1 defence: both callers already refuse the agent seat (`cannot_self_grant`
  // in setAgentDial, `cannot_self_approve` plus the A24 step-0 denial on the allowFuture arm), so
  // reaching here as the agent is a wiring defect, and a wiring defect in a safety rail crashes
  // rather than writes.
  if (isGovernedSeat(ctx.store, ctx.actor)) {
    throw new Error('writeDialLevel: the governed agent seat must never write a dial row.');
  }
  ctx.store.db
    .prepare(
      `INSERT INTO agent_dial (workspace_id, capability, level, idempotency_key, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, capability) DO UPDATE SET
         level           = excluded.level,
         idempotency_key = excluded.idempotency_key,
         updated_by      = excluded.updated_by,
         updated_at      = excluded.updated_at`,
    )
    .run(ctx.workspaceId, capability, level, idempotencyKey, ctx.actor, ctx.clock.now());
}

/**
 * The owner-facing raw view of every dial level (US-A26.8, `get_agent_dial`). Every governed
 * capability is reported, defaulting to `ask` for any without a stored row, so the caller sees the
 * whole closed set and not only the ones that were touched.
 */
export function getAgentDial(ctx: WorkspaceContext): Result {
  const levels: Record<string, DialLevel> = {};
  const rows = DIAL_CAPABILITIES.map((capability) => {
    const r = effectiveDialLevel(ctx, capability);
    levels[capability] = r.stored;
    return { capability, ...r };
  });
  // `levels` keeps the pre-D103 payload shape (stored levels); `rows` adds the D103 resolution so
  // every face can render stored and effective separately whenever they disagree (row 8.3).
  return ok({ levels, rows });
}

export interface SetAgentDialInput {
  capability?: unknown;
  level?: unknown;
  idempotencyKey?: unknown;
}

/**
 * Set one dial level (US-A26.8, `set_agent_dial`). Gated on `manage_agent_dial` at the boundary
 * (A24); an unknown capability or level is rejected STRUCTURALLY (the `defineRole` shape) rather than
 * silently accepted, because a typo in a safety rail must fail loudly. Idempotent per key through the
 * store's side-table.
 */
export function setAgentDial(ctx: WorkspaceContext, input: SetAgentDialInput): Result {
  // A35 critic F1, the writer half of the fix (the A24 step-0 denial is the other, and either alone
  // is escapable): THE GOVERNED SEAT NEVER WRITES ITS OWN DIAL. Enforced on the ACTOR, the
  // self-approve ban's shape, so it holds even for an embedder whose context bypasses A24's port.
  if (isGovernedSeat(ctx.store, ctx.actor)) return err('cannot_self_grant', {});
  const guard =
    requireString(input.capability, 'capability') ??
    requireString(input.level, 'level') ??
    requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const capability = input.capability as string;
  const level = input.level as string;
  const key = input.idempotencyKey as string;

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'set_agent_dial');
  if (replayed !== undefined) return replayed;

  if (!DIAL_CAPABILITY_SET.has(capability)) {
    return err('unknown_capability', { capability, allowed: [...DIAL_CAPABILITIES] });
  }
  if (!DIAL_LEVELS.includes(level)) {
    return err('invalid_input', { field: 'level', allowed: [...DIAL_LEVELS] });
  }

  return ctx.store.rememberIdempotent(ctx.workspaceId, key, 'set_agent_dial', () => {
    writeDialLevel(ctx, capability, level as DialLevel, key);
    return ok({ capability, level });
  });
}
