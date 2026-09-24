/**
 * A26 THE INBOX: the drafted-action queue and its approve/reject transitions (US-A26.8).
 *
 * A write the dial (`decideAction`) resolved to `draft` lands here as an `agent_action` row and is
 * INERT until a human approves it. Approving REPLAYS the stored verb through the shared dispatch, so
 * it gets the same tenant, boundary, A24 gate and throw guard every other call gets, and it replays
 * with the stored idempotency key, so an approve-twice cannot double-post (§H-IDEMPOTENT). The row's
 * `status` walks pending -> executed or pending -> rejected, never back (§6b Fixed: one source of
 * truth for the inbox state machine).
 *
 * THE AGENT CAN NEVER SELF-APPROVE (§5, §6b Fixed). It is an ACTOR-and-CAPABILITY rule enforced in the
 * verb, not a routing trick: `approve_drafted_action` is gated on `manage_agent_dial` (owner-only, so
 * no `agent` role can call it at all), AND the approving actor may never match the drafting actor. The
 * replay runs AS THE APPROVER, so RBAC is re-checked against the human who is taking responsibility
 * (P3): approving a post you could not make yourself is refused with the underlying verb's own
 * `permission_denied`.
 *
 * CRASH-SAFE WITHOUT AN OUTER TRANSACTION. The replay commits through the underlying verb's own
 * idempotency transaction; the status flip is a second, separate write. A process death between them
 * leaves the row `pending` and the verb committed, and a re-approve replays the verb (idempotent on
 * its stored key, so it returns the SAME result and writes nothing) and then flips the status. That is
 * the recurring-run-log shape: durability from the underlying key, never from a lock held across a
 * subprocess call.
 */

import type { WorkspaceContext } from '../context.js';
import type { Result } from '../result.js';
import { ok, err } from '../result.js';
import type { ActionInvoker } from '../automation/index.js';
import { requireString, optionalText } from '../ledger/inputGuards.js';
import { isDialCapability, writeDialLevel } from './dial.js';
import { backfillDraftingCall, entityRefOf } from './trace.js';

/**
 * The longest `reject_drafted_action.reason` the engine stores (governance critic F4, 2026-09-05).
 * J5.6 asked for a sentence the next session reads; 500 characters is a sentence with room, and the
 * one figure the Studio's textarea (`maxLength`) and the refusal payload (`maxLength`) both quote.
 */
export const REJECT_REASON_MAX_LENGTH = 500;

interface AgentActionRow {
  id: string;
  workspace_id: string;
  actor: string;
  dial_capability: string | null;
  action_tool: string;
  payload_json: string;
  status: string;
  idempotency_key: string | null;
  result_json: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  reject_reason: string | null;
}

export interface EnqueueDraftedActionInput {
  actionTool?: unknown;
  payload?: unknown;
  dialCapability?: unknown;
  idempotencyKey?: unknown;
}

/**
 * Enqueue a drafted action into the inbox. This is the ENGINE seam the write dispatch calls at
 * integration when `decideAction` returns `draft`; there is deliberately no agent-facing "draft this"
 * tool (§5: the agent reaches the customization/financial surface through the same verbs a human does,
 * and the dial routes them, never a side door). The stored `payload` is the FULL input the underlying
 * verb will be replayed with, `workspaceId` included, so approval is a faithful re-execution.
 */
export function enqueueDraftedAction(ctx: WorkspaceContext, input: EnqueueDraftedActionInput): Result {
  const guard = requireString(input.actionTool, 'actionTool');
  if (guard) return guard;
  const actionTool = input.actionTool as string;
  if (typeof input.payload !== 'object' || input.payload === null || Array.isArray(input.payload)) {
    return err('invalid_input', { field: 'payload' });
  }
  const payload = input.payload as Record<string, unknown>;
  const dialCapability = typeof input.dialCapability === 'string' ? input.dialCapability : null;
  const idempotencyKey =
    typeof input.idempotencyKey === 'string'
      ? input.idempotencyKey
      : typeof payload.idempotencyKey === 'string'
        ? (payload.idempotencyKey as string)
        : null;

  // §H-IDEMPOTENT ON THE DRAFT ITSELF (F-08 c). The underlying verb is idempotent on its key, and until
  // 2026-09-05 the draft in front of it was not: a same-key replay at `ask` minted a second Vorschlag
  // (J3.10), so the human saw two proposals for one booking and had to clear both. A replay now answers
  // with the row the key already minted: a pending one (the natural case: the agent retried while the
  // human had not yet decided), an executed one (the verb's own key would return the same result), or
  // a rejected one (the human already said no; a second proposal with the SAME payload is not a new
  // question). Pending wins over a resolved row so the queue never gains a duplicate. Read-then-insert
  // is atomic enough here: one synchronous connection, no second writer inside the process.
  if (idempotencyKey !== null) {
    const existing = ctx.store.db
      .prepare(
        `SELECT id, status, result_json, reject_reason FROM agent_action
          WHERE workspace_id = ? AND action_tool = ? AND idempotency_key = ?
          ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC, id DESC
          LIMIT 1`,
      )
      .get(ctx.workspaceId, actionTool, idempotencyKey) as
      | { id: string; status: string; result_json: string | null; reject_reason: string | null }
      | undefined;
    if (existing !== undefined) {
      let result: Result | undefined;
      if (existing.status === 'executed' && existing.result_json !== null) {
        try {
          result = JSON.parse(existing.result_json) as Result;
        } catch {
          result = undefined;
        }
      }
      return ok({
        actionId: existing.id,
        status: existing.status,
        replayed: true,
        ...(result !== undefined ? { result } : {}),
        ...(existing.reject_reason !== null ? { rejectReason: existing.reject_reason } : {}),
      });
    }
  }

  const id = ctx.ids.next('agent_action');
  ctx.store.db
    .prepare(
      `INSERT INTO agent_action
         (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(id, ctx.workspaceId, ctx.actor, dialCapability, actionTool, JSON.stringify(payload), idempotencyKey, ctx.clock.now());
  return ok({ actionId: id, status: 'pending', replayed: false });
}

function loadAction(ctx: WorkspaceContext, actionId: string): AgentActionRow | undefined {
  // §H-TENANT: the workspace is part of the lookup key, so an action id from another workspace reads
  // as not-found rather than leaking or acting across tenants.
  return ctx.store.db
    .prepare('SELECT * FROM agent_action WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, actionId) as AgentActionRow | undefined;
}

export interface ListDraftedActionsInput {
  status?: unknown;
}

const ACTION_STATUSES = new Set(['pending', 'executed', 'rejected']);

/**
 * The queue's read face (design §5 finding 3: A26 §6 designed a queue no transport could list). The
 * payload is returned PARSED so every consumer (the Vorschläge tab, the dock card, G15's hub) renders
 * one shape; the raw stored string stays an implementation detail. Default: pending only, oldest
 * first, because the oldest pending draft is the one at risk of becoming stale (design row 9.3).
 */
export function listDraftedActions(ctx: WorkspaceContext, input: ListDraftedActionsInput): Result {
  const status = typeof input.status === 'string' ? input.status : 'pending';
  if (!ACTION_STATUSES.has(status)) {
    return err('invalid_input', { field: 'status', allowed: [...ACTION_STATUSES] });
  }
  const rows = ctx.store.db
    .prepare('SELECT * FROM agent_action WHERE workspace_id = ? AND status = ? ORDER BY created_at ASC, id ASC')
    .all(ctx.workspaceId, status) as AgentActionRow[];
  return ok({
    actions: rows.map((row) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      } catch {
        // A corrupt payload still lists (the row exists and a human must be able to reject it).
      }
      return {
        actionId: row.id,
        actor: row.actor,
        dialCapability: row.dial_capability,
        actionTool: row.action_tool,
        payload,
        status: row.status,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at,
        resolvedBy: row.resolved_by,
        rejectReason: row.reject_reason,
      };
    }),
  });
}

export interface ResolveDraftedActionInput {
  actionId?: unknown;
  /**
   * D103's grant arm: `true` approves AND records the standing per-capability grant ("künftig
   * automatisch") as the SAME single-row dial write `set_agent_dial` performs, with the same
   * attribution and the same revocation path. Absent or false is a plain approve.
   */
  allowFuture?: unknown;
  /**
   * Reject only (F-08, J5.6): the human's optional sentence on WHY. Stored on the row, shown in the
   * queue's rejected list and in the trace beside the drafting call, so the next session reads it.
   */
  reason?: unknown;
}

/**
 * Approve a drafted action: replay its verb and mark it executed (US-A26.8). Idempotent by
 * construction on `actionId` (the id IS the key): a second approve of an executed row replays the
 * stored result and writes nothing, which is the "settle" the double-call gate asserts.
 */
export function approveDraftedAction(
  ctx: WorkspaceContext,
  invoke: ActionInvoker,
  input: ResolveDraftedActionInput,
): Result {
  const guard = requireString(input.actionId, 'actionId');
  if (guard) return guard;
  const actionId = input.actionId as string;

  const row = loadAction(ctx, actionId);
  if (row === undefined) return err('not_found', { actionId });
  if (row.status === 'executed') {
    // Already done: replay the stored result rather than re-running, so approve-twice is a no-op.
    return row.result_json !== undefined && row.result_json !== null
      ? (JSON.parse(row.result_json) as Result)
      : ok({ actionId, status: 'executed' });
  }
  if (row.status === 'rejected') return err('already_rejected', { actionId });

  // The agent can never self-approve: a second, independent actor must review before the irreversible
  // step (§6b Fixed). Enforced on the ACTOR, beside the capability gate at the boundary.
  if (row.actor === ctx.actor) return err('cannot_self_approve', { actionId });

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    return err('corrupt_drafted_action', { actionId });
  }

  // Replay AS THE APPROVER through the shared dispatch: the human vouches under their own authority
  // and RBAC is re-checked against them (P3). The underlying verb carries its stored idempotency key,
  // so even a re-approve after a crash cannot double-post.
  const outcome = invoke(row.action_tool, payload, ctx.actor);
  if (!outcome.ok) return outcome;

  ctx.store.db
    .prepare(
      `UPDATE agent_action
          SET status = 'executed', result_json = ?, resolved_at = ?, resolved_by = ?
        WHERE workspace_id = ? AND id = ? AND status = 'pending'`,
    )
    .run(JSON.stringify(outcome), ctx.clock.now(), ctx.actor, ctx.workspaceId, actionId);

  // A35 §5, THE BACKLINK'S DEFAULT PATH: the replay stamps the APPROVER into the created object's
  // `created_by`, so the drafting call row is the only place the object and the agent turn can meet.
  // Fill it here, at the one moment the created reference and the approver both exist.
  backfillDraftingCall(ctx, actionId, entityRefOf(outcome));

  // D103's grant arm ("Genehmigen und künftig automatisch"): the SAME single-row dial write
  // `set_agent_dial` performs, attributed to the approving actor, revocable the same way. It runs
  // only after a successful replay: a grant must never outlive a failed approve.
  let granted: { capability: string; level: 'auto' } | undefined;
  if (input.allowFuture === true && row.dial_capability !== null && isDialCapability(row.dial_capability)) {
    writeDialLevel(ctx, row.dial_capability, 'auto', `approve:${actionId}`);
    granted = { capability: row.dial_capability, level: 'auto' };
  }

  return ok({ actionId, status: 'executed', result: outcome, ...(granted !== undefined ? { granted } : {}) });
}

/**
 * Reject a drafted action: drop it, unexecuted (US-A26.8). Idempotent on `actionId`: a second reject
 * of a rejected row settles to the same answer (carrying the reason the FIRST one stored: a replay
 * never rewrites why); an executed row refuses (`already_executed`).
 *
 * "No, and tell it why" (F-08, J5.6): `reason` is optional prose from the human. It lands on the row,
 * and the drafting call in the trace gains the resolver and the moment, the same backlink the approve
 * path writes, so a rejection is as visible in the conversation as an approval is.
 */
export function rejectDraftedAction(ctx: WorkspaceContext, input: ResolveDraftedActionInput): Result {
  const guard = requireString(input.actionId, 'actionId') ?? optionalText(input.reason, 'reason');
  if (guard) return guard;
  const actionId = input.actionId as string;
  const trimmed = typeof input.reason === 'string' ? input.reason.trim() : '';
  // Governance critic F4 (2026-09-05): the reason is a sentence the next session reads and the card
  // and the trace render, not a document. Unbounded, a 2 MB reason was stored and rendered in full.
  if (trimmed.length > REJECT_REASON_MAX_LENGTH) {
    return err('invalid_input', { field: 'reason', maxLength: REJECT_REASON_MAX_LENGTH, length: trimmed.length });
  }
  const reason = trimmed.length > 0 ? trimmed : null;

  const row = loadAction(ctx, actionId);
  if (row === undefined) return err('not_found', { actionId });
  if (row.status === 'rejected') {
    return ok({ actionId, status: 'rejected', ...(row.reject_reason !== null ? { reason: row.reject_reason } : {}) });
  }
  if (row.status === 'executed') return err('already_executed', { actionId });

  ctx.store.db
    .prepare(
      `UPDATE agent_action
          SET status = 'rejected', resolved_at = ?, resolved_by = ?, reject_reason = ?
        WHERE workspace_id = ? AND id = ? AND status = 'pending'`,
    )
    .run(ctx.clock.now(), ctx.actor, reason, ctx.workspaceId, actionId);
  // The trace's backlink, on the reject path too: no object was created (entity_ref stays null), but
  // WHO resolved the draft and WHEN is what the conversation renders beside the drafting call.
  backfillDraftingCall(ctx, actionId, undefined);
  return ok({ actionId, status: 'rejected', ...(reason !== null ? { reason } : {}) });
}
