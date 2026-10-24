/**
 * A26 THE INBOX: the drafted-action queue and its approve/reject transitions (US-A26.8).
 *
 * A write the dial (`decideAction`) resolved to `draft` lands here as an `agent_action` row and is
 * INERT until a human approves it. Approving REPLAYS the stored verb through the shared dispatch, so
 * it gets the same tenant, boundary, A24 gate and throw guard every other call gets, and it replays
 * with the stored idempotency key, so an approve-twice cannot double-post (§H-IDEMPOTENT). The row's
 * `status` walks pending -> executed, pending -> rejected or pending -> stale, never back (§6b Fixed:
 * one source of truth for the inbox state machine), with ONE exception (D177, A39 §16.1): a bank-line
 * Vorschlag the ENGINE closed because its line was decided ("Zeile entschieden", `closure_kind`
 * `line_decided`) returns to pending when, and only when, THAT decision is undone by `reopen_bank_line`
 * (`reviveLineDraftsOnReopen`, which re-checks pin and screen); a person's rejection and an "ersetzt"
 * never return. Every such closure and revive is kept in the row's history (`draftHistory.ts`). `stale` (critic N1) is a Vorschlag whose pinned
 * record changed after the proposal (`vorschlagPin.ts`): it never ran and can never be approved.
 *
 * THE AGENT CAN NEVER SELF-APPROVE (§5, §6b Fixed). It is an ACTOR-and-CAPABILITY rule enforced in the
 * verb, not a routing trick: `approve_drafted_action` is gated on `manage_agent_dial` (owner-only, so
 * no `agent` role can call it at all), AND the approving actor may never match the drafting actor. The
 * replay runs AS THE APPROVER, so RBAC is re-checked against the human who is taking responsibility
 * (P3): approving a post you could not make yourself is refused with the underlying verb's own
 * `permission_denied`.
 *
 * CRASH-SAFE WITHOUT AN OUTER TRANSACTION. The replay commits through the underlying verb's own
 * transactions; the status flip is a second, separate write. A process death between them leaves the
 * row `pending` and the verb committed, and a re-approve replays the verb (idempotent on its stored
 * key, so it returns the SAME result and writes nothing) and then flips the status. That is the
 * recurring-run-log shape: durability from the underlying key, never from a lock held across a
 * subprocess call.
 *
 * D165 (independent critic C, 13.10.2026): HOW the re-approve knows the act committed. The replay
 * runs under a COMMIT MARK (`SqliteStore.withCommitMark`): every transaction the act commits also
 * stamps this row, inside itself, with `committed_at` (the first such commit) and `committed_pin`, the
 * pin digest of the records AS THAT TRANSACTION LEAVES THEM. Until D165 the check looked for the act's
 * memo under (stored key, approved verb), which many verbs do not use (`issue_invoice` files under
 * `transition_document` with `[invoiceId, key]`, composite inner writes under a `>` scope, a migration
 * step under `migstep_`), and a committed act that moved its own pin was voided as `stale`.
 *
 * WHAT A MARK FORGIVES, AND WHAT IT DOES NOT (D165 round 2, critic finding 1). A mark says "some
 * transaction of the act committed", not "the act finished": a verb that commits step by step (a
 * dunning run sends and records one debtor at a time) is marked after its first step. So the mark
 * forgives exactly the act's OWN moves: a re-approve settles when the pin reads now what the act's
 * last committed transaction left (`committed_pin`), or what the person approved. Any other change
 * (a free verb rewrote a debtor's email while the run was half sent) voids the row `stale`, as an
 * unmarked row is, and the rest of the act never runs on records the person did not approve. The row
 * keeps its `committed_at`, so the record says the act ran in part before it was voided.
 *
 * WHAT MARKS AT ALL (D165 follow-up critic, 14.10.2026). Every write the replay commits marks, a
 * refusal's included: the default fails CLOSED, so a verb that answers a refusal after committing
 * business rows keeps its mark and is never recorded as rejected. What a refusal writes about itself
 * (degraded and failed dispatch rows, a migration check, a send intent and its retraction) runs under
 * `SqliteStore.withoutCommitMark` and marks nothing, so a refusal that wrote only that stays
 * rejectable. Nothing clears a mark once committed. A refusal record somebody forgot to scope keeps a
 * mark: the row stays approvable and only reject is refused, never the reverse.
 */

import type { WorkspaceContext } from '../context.js';
import type { Result } from '../result.js';
import { ok, err } from '../result.js';
import type { ActionInvoker } from '../automation/index.js';
import { requireString, optionalText } from '../ledger/inputGuards.js';
import { isGovernedSeat } from '../access/capability.js';
import { isDialCapability, writeDialLevel } from './dial.js';
import { APPROVAL_CONFIRMS_FIELD } from './dialMap.js';
import { backfillDraftingCall, entityRefOf } from './trace.js';
import { pinFor, VORSCHLAG_STALE_MESSAGE, type VorschlagFigures } from './vorschlagPin.js';
import { withApproving } from './approving.js';
import { appendDraftHistory, draftHistoryOf } from './draftHistory.js';

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
  pin_digest: string | null;
  pin_json: string | null;
  committed_at: string | null;
  committed_pin: string | null;
  closure_kind: string | null;
  history_json: string | null;
}

export interface EnqueueDraftedActionInput {
  actionTool?: unknown;
  payload?: unknown;
  dialCapability?: unknown;
  idempotencyKey?: unknown;
  /**
   * D177 (critic D177-C1): the transport seam passed this draft through the verb's FULL pre-draft screen
   * (`ActionDef.prevalidate` answered nothing). Only such a draft may supersede the line's older
   * Vorschläge: one that was never validated must not withdraw one that was.
   */
  screened?: unknown;
}

/**
 * Enqueue a drafted action into the inbox. This is the ENGINE seam the write dispatch calls at
 * integration when `decideAction` returns `draft`; there is deliberately no agent-facing "draft this"
 * tool (§5: the agent reaches the customization/financial surface through the same verbs a human does,
 * and the dial routes them, never a side door). The stored `payload` is the FULL input the underlying
 * verb will be replayed with, `workspaceId` included, so approval is a faithful re-execution.
 */
export function enqueueDraftedAction(ctx: WorkspaceContext, input: EnqueueDraftedActionInput): Result {
  return enqueueOnce(ctx, input, false);
}

function enqueueOnce(ctx: WorkspaceContext, input: EnqueueDraftedActionInput, retried: boolean): Result {
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
        `SELECT * FROM agent_action
          WHERE workspace_id = ? AND action_tool = ? AND idempotency_key = ? AND status <> 'stale'
          ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC, id DESC
          LIMIT 1`,
      )
      .get(ctx.workspaceId, actionTool, idempotencyKey) as
      | AgentActionRow
      | undefined;
    // Critic N1: a pending Vorschlag whose pinned record changed since it was drafted is VOID, and the
    // same-key proposal that arrives now is the "propose again" the refusal asks for. The old row goes
    // `stale` (never approvable again) and a fresh one is minted below with the record as it is now,
    // so the person decides on what will actually run. A stale row is never a replay target.
    // D165: a pending row whose replay already committed (a process died before its status flip) and
    // whose pin reads what its own act left is the replay target too (`settleable`), never voided over
    // the act's own move.
    if (existing !== undefined && existing.status === 'pending' && existing.pin_digest !== null) {
      if (!settleable(ctx, existing, payload)) {
        // D165 round 2 (critic finding 4): a void that lost its compare-and-set means another
        // process committed this row's act (or resolved it) since the read above. Never mint a
        // second pending row beside it: read again and answer from the row as it is now. The draft
        // seam runs this inside an IMMEDIATE transaction, where no other process can commit in
        // between; the engine seam holds without one too.
        if (!markStale(ctx, existing)) return lostRace(existing, () => enqueueOnce(ctx, input, true), retried);
      } else {
        return ok({ actionId: existing.id, status: existing.status, replayed: true });
      }
    } else if (existing !== undefined) {
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

  // WHAT YOU APPROVED IS WHAT RUNS (critic N1): pin the records this act will consume, so approval
  // can refuse when they changed after the proposal, and freeze the figures the card shows.
  const pin = pinFor(ctx, actionTool, payload);
  const id = ctx.ids.next('agent_action');
  ctx.store.db
    .prepare(
      `INSERT INTO agent_action
         (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, idempotency_key, created_at, pin_digest, pin_json)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    )
    .run(
      id,
      ctx.workspaceId,
      ctx.actor,
      dialCapability,
      actionTool,
      JSON.stringify(payload),
      idempotencyKey,
      ctx.clock.now(),
      pin?.digest ?? null,
      pin === undefined ? null : JSON.stringify(pin.figures),
    );
  const superseded = input.screened === true ? supersedeOlderLineDrafts(ctx, actionTool, payload, id) : [];
  return ok({ actionId: id, status: 'pending', replayed: false, ...(superseded.length > 0 ? { supersededActionIds: superseded } : {}) });
}

/** D177 (A39 §16.1): the bank-line verbs whose Vorschläge one line holds at most one of. */
export const LINE_DECISION_DRAFT_TOOLS: readonly string[] = ['book_bank_line', 'ignore_bank_line'];

/** D177: the reason an older Vorschlag of a line carries once a newer one replaced it. */
export const DRAFT_SUPERSEDED_REASON = 'ersetzt';

/**
 * D177 (A39 §16.1, D177 point 8): ONE PENDING VORSCHLAG PER BANK LINE. A new draft that decides a bank line
 * (`book_bank_line`, `ignore_bank_line`) and passed its verb's full pre-draft screen (`screened`, critic
 * D177-C1) resolves every OLDER pending draft of either verb naming the same line BY THE SAME ACTOR (critic
 * D177-C4, owner ruling: another seat's Vorschlag stays; `list_bank_inbox` names the newest) as `rejected`
 * with the reason "ersetzt", stamped by the drafting actor and moment. The drafting call of each one is
 * backfilled in the trace as `reject_drafted_action` records a rejection, with its `entity_ref` naming the
 * NEW draft's id (critic D177-C3: which Vorschlag replaced it). The defect this closes: one line held two
 * pending drafts, the older unbookable, and the Studio showed that one. A row whose approval already
 * committed (`committed_at`) is left alone: it can no longer be rejected (D165). Tenant-bound. Returns the
 * ids it resolved.
 */
function supersedeOlderLineDrafts(ctx: WorkspaceContext, actionTool: string, payload: Record<string, unknown>, newId: string): string[] {
  if (!LINE_DECISION_DRAFT_TOOLS.includes(actionTool)) return [];
  const bankTxnId = payload.bankTxnId;
  if (typeof bankTxnId !== 'string' || bankTxnId.length === 0) return [];
  const older = ctx.store.db
    .prepare(
      `SELECT id, payload_json FROM agent_action
        WHERE workspace_id = ? AND status = 'pending' AND committed_at IS NULL AND id <> ? AND actor = ?
          AND action_tool IN (${LINE_DECISION_DRAFT_TOOLS.map(() => '?').join(', ')})`,
    )
    .all(ctx.workspaceId, newId, ctx.actor, ...LINE_DECISION_DRAFT_TOOLS) as { id: string; payload_json: string }[];
  const resolve = ctx.store.db.prepare(
    `UPDATE agent_action
        SET status = 'rejected', resolved_at = ?, resolved_by = ?, reject_reason = ?, closure_kind = 'superseded'
      WHERE workspace_id = ? AND id = ? AND status = 'pending' AND committed_at IS NULL`,
  );
  const done: string[] = [];
  for (const row of older) {
    let named: unknown;
    try {
      named = (JSON.parse(row.payload_json) as { bankTxnId?: unknown }).bankTxnId;
    } catch {
      continue;
    }
    if (named !== bankTxnId) continue;
    const now = ctx.clock.now();
    if (resolve.run(now, ctx.actor, DRAFT_SUPERSEDED_REASON, ctx.workspaceId, row.id).changes === 0) continue;
    // Critic D177-R4-1: the row keeps the closure in its history.
    appendDraftHistory(ctx, row.id, { event: 'closed', kind: 'superseded', at: now, by: ctx.actor, reason: DRAFT_SUPERSEDED_REASON, replacedBy: newId });
    // Critic D177-C3: the trace names the Vorschlag that replaced it.
    backfillDraftingCall(ctx, row.id, newId);
    done.push(row.id);
  }
  return done;
}

/**
 * pending -> stale: the row can never be approved again, and its drafting call shows why. Only when the
 * row's commit mark is still what the caller judged (D165 critic finding 5): under D12 a second
 * process may be replaying this very row, and a commit of its act that lands between the caller's read
 * and this write must not be voided by a judgement made without it.
 */
function markStale(ctx: WorkspaceContext, row: AgentActionRow): boolean {
  const voided = ctx.store.db
    .prepare(
      `UPDATE agent_action
          SET status = 'stale', resolved_at = ?, resolved_by = ?
        WHERE workspace_id = ? AND id = ? AND status = 'pending'
          AND committed_at IS ? AND committed_pin IS ?`,
    )
    .run(ctx.clock.now(), ctx.actor, ctx.workspaceId, row.id, row.committed_at, row.committed_pin);
  if (voided.changes === 0) return false;
  backfillDraftingCall(ctx, row.id, undefined);
  return true;
}

/**
 * A `markStale` that did not void (D165 round 2, critic finding 4): the row moved under the caller (a
 * second process committed its act, which stamped a new mark, or resolved it). The caller's judgement
 * was made on the row as it WAS, so it is made again, once, on the row as it is now: the re-run reads
 * the row afresh and answers from it (executed, rejected, stale, or a pending row whose act committed
 * and now settles). Moving twice in a row means another process is replaying it right now: nothing
 * ran here, and the answer is the retryable `store_busy` every verb gives a lost race.
 */
function lostRace(row: AgentActionRow, again: () => Result, retried: boolean): Result {
  if (!retried) return again();
  return err('store_busy', {
    actionId: row.id,
    retryable: true,
    partial: false,
    message: 'the drafted action changed twice while it was being judged; nothing ran, try again',
  });
}

/** The `vorschlag_stale` refusal: the code, the action, and the sentence in both languages. */
function staleRefusal(row: AgentActionRow): Result {
  return err('vorschlag_stale', { actionId: row.id, actionTool: row.action_tool, message: VORSCHLAG_STALE_MESSAGE });
}

/**
 * True when the pinned records changed since the Vorschlag was drafted. A row with no pin (drafted
 * before the pin existed, or for a verb that needs none) is never stale.
 */
function pinChanged(ctx: WorkspaceContext, row: AgentActionRow, payload: Record<string, unknown>): boolean {
  if (row.pin_digest === null) return false;
  const current = pinFor(ctx, row.action_tool, payload)?.digest;
  if (current === row.pin_digest) return false;
  // D165: a row whose replay committed before a crash is unchanged when the pin reads what the act's
  // own last committed transaction left; only somebody else's change counts.
  return !(row.committed_pin !== null && current === row.committed_pin);
}

/**
 * Thrown by an approval's commit mark when the row was rejected or voided by another process after this
 * approval's checks. The throw rolls back the act's transaction it was to mark.
 */
class DraftedActionResolvedMeanwhile extends Error {
  constructor(actionId: string) {
    super(`drafted action ${actionId} was rejected or voided by another process while its approval ran; nothing of the act committed`);
    this.name = 'DraftedActionResolvedMeanwhile';
  }
}

/**
 * Whether a pending row may still be approved (or answered as the replay target): its pin reads what
 * the person approved, or (D165) what its own committed act left. One fallback, for a row that crashed
 * under a build from before the commit mark (critic finding 3): the verb's own completed memo under
 * (stored key, approved verb). That memo is written in the same transaction as the act it records, so
 * it is found only for an act that completed, and its replay writes nothing.
 */
function settleable(ctx: WorkspaceContext, row: AgentActionRow, payload: Record<string, unknown>): boolean {
  return !pinChanged(ctx, row, payload) || completedMemo(ctx, row, payload);
}

/** The verb's own completed memo under the stored key: the pre-D165 crash check, kept as a fallback. */
function completedMemo(ctx: WorkspaceContext, row: AgentActionRow, payload: Record<string, unknown>): boolean {
  const key = row.idempotency_key ?? (typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey : null);
  if (key === null) return false;
  return ctx.store.recallIdempotent<unknown>(ctx.workspaceId, key, row.action_tool) !== undefined;
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

const ACTION_STATUSES = new Set(['pending', 'executed', 'rejected', 'stale']);

/**
 * The queue's read face (design §5 finding 3: A26 §6 designed a queue no transport could list). The
 * payload is returned PARSED so every consumer (the Vorschläge tab, the dock card, G15's hub) renders
 * one shape; the raw stored string stays an implementation detail. Default: pending only, oldest
 * first, because the oldest pending draft is the one at risk of becoming stale (design row 9.3).
 */
/** The payload keys that name a contact, resolved to its name for the card (critic phase0-installable r2). */
const CONTACT_ID_KEYS: readonly string[] = ['vendorId', 'contactId', 'customerId', 'debtorId'];

/**
 * The human names behind the contact ids a payload carries, keyed by payload key. A drafted
 * `set_creditor_bank_profile` names its vendor by contact id only, so the approver could not see WHICH
 * vendor's IBAN was being redirected without opening the details (critic phase0-installable r2, UX).
 * Read-only, tenant-scoped, and additive: the payload itself stays exactly what the approval replays.
 * An id that resolves to no contact in THIS workspace is simply absent (the raw id still shows).
 */
function payloadLabelsOf(ctx: WorkspaceContext, payload: Record<string, unknown>): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const key of CONTACT_ID_KEYS) {
    const id = payload[key];
    if (typeof id !== 'string' || id.length === 0) continue;
    const row = ctx.store.db
      .prepare('SELECT name FROM contact WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, id) as { name: string | null } | undefined;
    if (row !== undefined && typeof row.name === 'string' && row.name.length > 0) labels[key] = row.name;
  }
  return labels;
}

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
      let figures: VorschlagFigures | null = null;
      try {
        figures = row.pin_json === null ? null : (JSON.parse(row.pin_json) as VorschlagFigures | null);
      } catch {
        figures = null;
      }
      return {
        actionId: row.id,
        actor: row.actor,
        dialCapability: row.dial_capability,
        actionTool: row.action_tool,
        payload,
        payloadLabels: payloadLabelsOf(ctx, payload),
        // Critic N1: the key figures of the record as it stood when the agent proposed this, and
        // whether it has changed since (a pending row only): the card shows what is being approved.
        figures,
        // D165: measured against what the act's own committed transactions left, when it ran in part.
        ...(row.status === 'pending' && row.pin_digest !== null ? { changedSinceProposal: pinChanged(ctx, row, payload) } : {}),
        // D165: the moment the replay first committed, on a row whose act ran (in whole or in part)
        // before a crash, or before it was voided.
        ...(row.committed_at !== null ? { committedAt: row.committed_at } : {}),
        status: row.status,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at,
        resolvedBy: row.resolved_by,
        rejectReason: row.reject_reason,
        // D177 (critic R4): a system closure's kind (null for a person's rejection) and the row's history of
        // closures and revives, oldest first.
        closureKind: row.closure_kind,
        history: draftHistoryOf(row.history_json),
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
 * The outcome codes of an act that may have left the building without the book knowing (D165 follow-up
 * critic, R2-2 and R3-2): `send_invoice` after its transport threw, and a managed-rail
 * `payment_batch_transmit` whose submit threw (`transmit_in_doubt`). A row an earlier attempt of the
 * approval MARKED, whose replay answers one of these before any write, settles `executed` with that
 * answer as its stored result: the act ran and its outcome is unknown. It never runs the act again (the
 * replay answered before any write and an executed row is never replayed), and the record never says it
 * was sent or paid; the person resolves the outcome with the recipient or the bank.
 */
const UNKNOWN_OUTCOME_CODES: ReadonlySet<string> = new Set(['send_outcome_unknown', 'transmit_in_doubt']);

/**
 * The answer of an approval that settled an unknown outcome (critic round 3, R3-1): `ok` with
 * `status: 'executed'` because the row is resolved, and `outcomeUnknown: true` with the verb's code at the
 * top, because nobody knows whether the mail left or the payment went. No standing grant rides it.
 */
export type ApprovedWithUnknownOutcome = {
  actionId: string;
  status: 'executed';
  result: Result;
  outcomeUnknown: true;
  outcomeCode: string;
};

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
  return approveOnce(ctx, invoke, input, false);
}

function approveOnce(ctx: WorkspaceContext, invoke: ActionInvoker, input: ResolveDraftedActionInput, retried: boolean): Result {
  const guard = requireString(input.actionId, 'actionId');
  if (guard) return guard;
  const actionId = input.actionId as string;

  // D161: approving is human-only. THE GOVERNED SEAT NEVER APPROVES ANY Vorschlag, its own or another
  // agent seat's, enforced on the ACTOR (the `setAgentDial` shape), so it holds even for an embedder
  // whose context bypasses A24's step-0 denial of `manage_agent_dial`. Before the row is read, so the
  // seat learns nothing about the queue either.
  if (isGovernedSeat(ctx.store, ctx.actor)) return err('cannot_self_approve', { actionId, reason: 'governed_seat' });

  const row = loadAction(ctx, actionId);
  if (row === undefined) return err('not_found', { actionId });
  if (row.status === 'executed') {
    // Already done: replay the stored result rather than re-running, so approve-twice is a no-op.
    return row.result_json !== undefined && row.result_json !== null
      ? (JSON.parse(row.result_json) as Result)
      : ok({ actionId, status: 'executed' });
  }
  if (row.status === 'rejected') return err('already_rejected', { actionId });
  if (row.status === 'stale') return staleRefusal(row);

  // The agent can never self-approve: a second, independent actor must review before the irreversible
  // step (§6b Fixed). Enforced on the ACTOR, beside the capability gate at the boundary.
  if (row.actor === ctx.actor) return err('cannot_self_approve', { actionId });

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    return err('corrupt_drafted_action', { actionId });
  }

  // WHAT YOU APPROVED IS WHAT RUNS (critic N1). The replay names a record, so it would act on whatever
  // that record holds NOW. Recompute the pin taken at proposal; on a mismatch run nothing, void the row
  // (`stale`, never approvable again) and ask for a new proposal. After the self-approve check, so the
  // drafting actor cannot use an approval attempt to void its own proposals.
  //
  // One exception keeps the approval crash-safe (the header's recurring-run-log shape): a process death
  // between the replay and the status flip leaves the row pending while the verb committed, and the
  // committed act itself changed the record (an issued invoice is not a draft). D165: the act's own
  // transactions stamped the pin they left (`committed_pin`), so the act's own move is forgiven and
  // nobody else's is (`settleable`); the replay below completes the act on the verb's own key.
  if (!settleable(ctx, row, payload)) {
    if (markStale(ctx, row)) return staleRefusal(row);
    // D165 round 2 (critic finding 4): the void lost its compare-and-set, so the row moved since it
    // was read (another process's approval committed the act, or resolved the row). Never answer
    // "nothing ran" over it: judge again on the row as it is now.
    return lostRace(row, () => approveOnce(ctx, invoke, input, true), retried);
  }

  // D156 point 5: approving IS the human confirmation a confirm-gated verb asks for (P8), so the
  // replay carries it (`APPROVAL_CONFIRMS_FIELD`). Without this an approved `env_delete` the agent
  // drafted without `confirmed` replayed as a plan and was marked executed while nothing happened.
  // Only the replayed input changes; the stored payload, which the card showed, stays as drafted.
  const confirmField = APPROVAL_CONFIRMS_FIELD[row.action_tool];
  const replayInput = confirmField === undefined ? payload : { ...payload, [confirmField]: true };

  // Replay AS THE APPROVER through the shared dispatch: the human vouches under their own authority
  // and RBAC is re-checked against them (P3). The underlying verb carries its stored idempotency key,
  // so even a re-approve after a crash cannot double-post.
  //
  // D165: under a COMMIT MARK, so every transaction the act commits stamps this row inside itself
  // (see the header): the first commit's moment, and the pin as each transaction leaves the records,
  // read inside that transaction. Nothing ever clears the mark (D165 follow-up critic, findings 1 to 3):
  // a not-ok answer keeps whatever this attempt committed, because a verb may refuse AFTER it wrote
  // business rows (`bank_sync` imports a waiting statement, then answers `channel_unreachable`). What a
  // refusal writes about ITSELF runs under `SqliteStore.withoutCommitMark` and leaves no mark, so a
  // refusal that wrote only that stays rejectable, and the next approval faces the pin like any other.
  const outcome = ctx.store.withCommitMark(
    (ran) => {
      let left: string | null = null;
      if (row.pin_digest !== null) {
        try {
          left = pinFor(ctx, row.action_tool, payload)?.digest ?? null;
        } catch {
          // A pin that cannot be read forgives nothing: the re-approve then faces the approved pin.
          left = null;
        }
      }
      // `ran` false: the transaction wrote only a refusal's own bookkeeping. The records it left are
      // still the act's own (a death after a migration check must not void the commit over its own
      // check), but the act did not run, so `committed_at` stays as it was and reject stays open.
      // Only while the row is still approvable (D165 follow-up, the security review's TOCTOU): under
      // D12 another process may REJECT or VOID this row after the checks above. The mark runs inside
      // the act's own transaction, under its write lock, so a row rejected or voided meanwhile makes it
      // throw and that transaction rolls back: nothing of the act commits over a "no" already taken.
      // `executed` passes: a second approval of the same row finished first, and this one is the same
      // decision, finishing the same act on the verb's own keys. Reject compares-and-sets on
      // `committed_at` for the other order.
      const stamped = ran
        ? ctx.store.db
            .prepare("UPDATE agent_action SET committed_at = COALESCE(committed_at, ?), committed_pin = ? WHERE workspace_id = ? AND id = ? AND status IN ('pending', 'executed')")
            .run(ctx.clock.now(), left, ctx.workspaceId, actionId)
        : ctx.store.db
            .prepare("UPDATE agent_action SET committed_pin = ? WHERE workspace_id = ? AND id = ? AND status IN ('pending', 'executed')")
            .run(left, ctx.workspaceId, actionId);
      if (stamped.changes === 0) throw new DraftedActionResolvedMeanwhile(actionId);
    },
    // D177 (critic D177-C6): marked as being approved, so the line decision it makes resolves the line's
    // OTHER pending Vorschläge and never this one (`approving.ts`).
    () => withApproving(actionId, () => invoke(row.action_tool, replayInput, ctx.actor)),
  );
  // D165 (critic round 2 on the follow-ups, R2-2; round 3, R3-2): an earlier attempt of THIS approval
  // marked the row because its transport threw, so the mail may have left (or the payment gone), and
  // every replay now answers `send_outcome_unknown` (or `transmit_in_doubt`) before any write: the row
  // could never execute, and reject is refused over a mark. It settles `executed` with that answer as
  // its stored result, as a dunning run whose letter is unknown does: the record says the act ran and
  // its outcome is unknown, never that it was sent or paid (`UNKNOWN_OUTCOME_CODES`). Only on a row
  // marked before this attempt: an unmarked row (another call left the attempt) stays a refusal and
  // rejectable.
  const unknownOutcome = !outcome.ok && UNKNOWN_OUTCOME_CODES.has(outcome.error) && row.committed_at !== null;
  if (!outcome.ok && !unknownOutcome) {
    // A row another process resolved while this replay ran (the mark refused, rolling the act's
    // transaction back): answer from the row, never with the error the refusal surfaced as.
    if (retried === false && loadAction(ctx, actionId)?.status !== 'pending') return approveOnce(ctx, invoke, input, true);
    return outcome;
  }

  const flipped = ctx.store.db
    .prepare(
      `UPDATE agent_action
          SET status = 'executed', result_json = ?, resolved_at = ?, resolved_by = ?
        WHERE workspace_id = ? AND id = ? AND status = 'pending'`,
    )
    .run(JSON.stringify(outcome), ctx.clock.now(), ctx.actor, ctx.workspaceId, actionId);
  // Resolved by another process in the meantime (an act that wrote nothing cannot have been stopped by
  // the mark): answer from the row as it is, never claim this approval executed it.
  if (flipped.changes === 0) {
    const now = loadAction(ctx, actionId);
    return lostRace(now ?? row, () => approveOnce(ctx, invoke, input, true), retried);
  }

  // A35 §5, THE BACKLINK'S DEFAULT PATH: the replay stamps the APPROVER into the created object's
  // `created_by`, so the drafting call row is the only place the object and the agent turn can meet.
  // Fill it here, at the one moment the created reference and the approver both exist.
  backfillDraftingCall(ctx, actionId, entityRefOf(outcome));

  // D103's grant arm ("Genehmigen und künftig automatisch"): the SAME single-row dial write
  // `set_agent_dial` performs, attributed to the approving actor, revocable the same way. It runs
  // only after a successful replay: a grant must never outlive a failed approve.
  let granted: { capability: string; level: 'auto' } | undefined;
  if (outcome.ok && input.allowFuture === true && row.dial_capability !== null && isDialCapability(row.dial_capability)) {
    writeDialLevel(ctx, row.dial_capability, 'auto', `approve:${actionId}`);
    granted = { capability: row.dial_capability, level: 'auto' };
  }

  // Critic round 3 (R3-1): a settled unknown outcome says so at the TOP of the answer, so neither the
  // person nor an agent reading `ok` takes it for a send or a payment that happened.
  if (unknownOutcome) {
    return ok<ApprovedWithUnknownOutcome>({ actionId, status: 'executed', result: outcome, outcomeUnknown: true, outcomeCode: outcome.error });
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
  if (row.status === 'stale') return staleRefusal(row);
  // D165 (critic finding 4): a pending row whose replay committed cannot be recorded as rejected, which
  // would contradict the book. Approving it completes the act, or voids it `stale` when somebody else
  // changed its records since. The reason keeps its name, `committed_before_crash`, and since the
  // follow-ups it also covers an act that ran in part and then answered a refusal or threw, with no
  // crash (`committedAt` is the moment its first transaction committed).
  if (row.committed_at !== null) {
    return err('already_executed', { actionId, committedAt: row.committed_at, reason: 'committed_before_crash' });
  }

  // Compare-and-set on the mark (D165 follow-up, the security review's TOCTOU): under D12 another
  // process's approval may commit this row's act between the read above and this write. Its mark then
  // stands, this write changes nothing, and the answer comes from the row as it is now. (The other
  // order is the mark's: a row rejected first rolls the act's transaction back.)
  const rejected = ctx.store.db
    .prepare(
      `UPDATE agent_action
          SET status = 'rejected', resolved_at = ?, resolved_by = ?, reject_reason = ?
        WHERE workspace_id = ? AND id = ? AND status = 'pending' AND committed_at IS NULL`,
    )
    .run(ctx.clock.now(), ctx.actor, reason, ctx.workspaceId, actionId);
  // A row only leaves `pending`, and a mark is never cleared, so one re-read settles the answer.
  if (rejected.changes === 0) return rejectDraftedAction(ctx, input);
  // The trace's backlink, on the reject path too: no object was created (entity_ref stays null), but
  // WHO resolved the draft and WHEN is what the conversation renders beside the drafting call.
  backfillDraftingCall(ctx, actionId, undefined);
  return ok({ actionId, status: 'rejected', ...(reason !== null ? { reason } : {}) });
}
