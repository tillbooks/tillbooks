/**
 * N01, agent ergonomics: the BATCH verbs and the one DISPATCHER, defined here and spread into `ACTIONS` as
 * one line (the `fxActions` / `agentActions` precedent), so several agents appending to the append-only
 * registry at once collide over a line rather than a block. Five writes:
 *
 *  - `book_bank_lines` (US-N01.6): many bank lines in one call, each item ONE `book_bank_line` under the
 *    derived key `<batchKey>:<bankTxnId>`.
 *  - `post_entries` (US-N01.6): many journal entries in one call, each item ONE `post_entry` under its own
 *    `idempotencyKey`.
 *  - `approve_drafted_actions` (US-N01.7): many Vorschläge approved in one call, each id ONE
 *    `approve_drafted_action`.
 *  - `reject_drafted_actions` (D196 item 9): many Vorschläge rejected in one call, each id ONE
 *    `reject_drafted_action`, with one reason for all.
 *  - `call_tool` (US-N01.9): any registered verb by name, for an MCP connection that lists only the
 *    essentials profile.
 *
 * THE ONE RULE ALL FIVE KEEP: AN ITEM IS A SINGLE CALL. Every item is dispatched through the SAME transport
 * seam a single call takes (`runGoverned`, bound late through `governedRun`, `registry.ts`), under the
 * caller's own seat: the input boundary (account numbers, unknown fields), the A24 gate, the agent dial
 * (under a draft dial each item is its own Vorschlag, D182 §4), the trace and the idempotency claim all hold
 * per item, exactly as for the call the item stands for. A batch is never all-or-nothing: 37 items booked
 * and 3 refused leaves the 3 untouched and the 37 booked, and the answer says which is which. More items
 * than the workspace's `agent.batch_max_items` refuses `batch_too_large` before ANY item runs.
 *
 * The helpers arrive as a parameter (the module graph stays acyclic: `registry.ts` imports this file).
 */

import type { ActionDef, ActionInput, ApiDeps, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { ok, err } from '../core/result.js';
import { isGovernedSeat } from '../core/access/index.js';
import { agentDecisionGrantFor, carriesOwnerWord, ownerCanGrantHint, ownerWordGrantFor, ownerWordHint } from '../core/agent/decisionGrant.js';
import { INSTANCE_WIDE_DIAL_ACTIONS } from '../core/agent/index.js';
import { hasSecretArgs } from '../core/agent/secretArgs.js';
import { getSetting } from '../core/settings/settings.js';
import { BATCHABLE_VERBS } from '../core/attention/vorschlaege.js';
import { REJECT_REASON_MAX_LENGTH } from '../core/agent/draftedActions.js';

/** The workspace's `attention.approval_batch_mode`, or its default (`tick`) when it cannot be read. */
function approvalBatchMode(ctx: WorkspaceContext): string {
  try {
    return getSetting<string>(ctx, 'attention.approval_batch_mode');
  } catch {
    return 'tick';
  }
}
import type { ActionKind } from './actionKind.js';

export interface BatchActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput, deps: ApiDeps) => Result,
  ): ActionDef;
  depsAction(name: string, kind: ActionKind, summary: string, inputSchema: JsonSchema, call: (deps: ApiDeps, input: ActionInput) => Result): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  depsSchema(props: Record<string, unknown>, required: string[]): JsonSchema;
  /** One item through the governed transport seam, under `deps`' seat. */
  governedRun(deps: ApiDeps, tool: string, input: ActionInput): Result;
  getAction(name: string): ActionDef | undefined;
  STR: { readonly type: 'string' };
}

/** The D172 setting that bounds a batch, and its default. */
export const BATCH_MAX_ITEMS_SETTING = 'agent.batch_max_items';
const BATCH_MAX_ITEMS_DEFAULT = 200;

/** The workspace's `agent.batch_max_items`, or its default when it cannot be read. */
export function batchMaxItems(ctx: WorkspaceContext): number {
  try {
    return getSetting<number>(ctx, BATCH_MAX_ITEMS_SETTING);
  } catch {
    return BATCH_MAX_ITEMS_DEFAULT;
  }
}

/** One item's answer: its position, whether it passed, and its own Result. */
export type BatchItemAnswer = { index: number; ok: true; result: Result } | { index: number; ok: false; refusal: Result };

/** The batch's answer: one answer per item, in order, and the two counts. */
function batchAnswer(items: BatchItemAnswer[], extra: Record<string, unknown> = {}): Result {
  const okCount = items.filter((i) => i.ok).length;
  const drafted = items.filter((i) => i.ok && (i.result as { drafted?: unknown }).drafted === true).length;
  return ok({ items, count: items.length, okCount, refusedCount: items.length - okCount, draftedCount: drafted, ...extra });
}

function answerOf(index: number, result: Result, extra: Record<string, unknown> = {}): BatchItemAnswer {
  return result.ok ? { index, ...extra, ok: true, result } : { index, ...extra, ok: false, refusal: result };
}

/**
 * D196 item 9: what one id of `reject_drafted_actions` came to. MAPPED from the single verb's own answer,
 * never decided here (paper critic L1): the single verb says `alreadyRejected` when it rejected nothing.
 */
export type RejectOutcome =
  | 'rejected'
  | 'already_rejected'
  | 'already_executed'
  | 'stale'
  | 'not_found'
  | 'offer_human_only'
  | 'not_permitted'
  | 'reason_required'
  | 'duplicate_in_batch'
  | 'invalid'
  | 'refused';

type RejectItemAnswer =
  | { index: number; actionId?: string; outcome: RejectOutcome; ok: true; result: Result }
  | { index: number; actionId?: string; outcome: RejectOutcome; ok: false; refusal: Result };

export function rejectOutcomeOf(result: Result): RejectOutcome {
  const body = result as Record<string, unknown>;
  if (result.ok) return body.alreadyRejected === true ? 'already_rejected' : 'rejected';
  switch (body.error) {
    case 'already_executed':
      return 'already_executed';
    case 'vorschlag_stale':
      return 'stale';
    case 'not_found':
      return 'not_found';
    case 'duplicate_in_batch':
      return 'duplicate_in_batch';
    case 'permission_denied':
      return body.reason === 'outside_grant' && body.grantExclusion === 'system_offer' ? 'offer_human_only' : 'not_permitted';
    case 'invalid_input':
      return body.reason === 'reason_required' ? 'reason_required' : 'invalid';
    default:
      return 'refused';
  }
}

function rejectAnswerOf(index: number, actionId: string | undefined, result: Result): RejectItemAnswer {
  const outcome = rejectOutcomeOf(result);
  const id = actionId !== undefined ? { actionId } : {};
  return result.ok ? { index, ...id, outcome, ok: true, result } : { index, ...id, outcome, ok: false, refusal: result };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

/**
 * The list check every batch shares: a non-empty array within the workspace's bound. `batch_too_large`
 * answers before any item runs.
 */
function checkItems(ctx: WorkspaceContext, value: unknown, field: string): Result | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return err('invalid_input', { field, reason: `${field} is a non-empty list` });
  }
  const max = batchMaxItems(ctx);
  if (value.length > max) return err('batch_too_large', { field, count: value.length, max, setting: BATCH_MAX_ITEMS_SETTING });
  return undefined;
}

/**
 * Verbs `call_tool` refuses, each keeping its own door: one that runs off the main thread (`runAsync`,
 * `bank_sync`), one that authenticates by a portal TOKEN rather than the caller's seat, one whose dial reads
 * the whole instance (`env_reset`, `env_delete`, `env_copy`), and `call_tool` itself (no recursion).
 * D198 re-cut R7 (critic r3 M1): a HUMAN-ONLY verb and a verb with a SECRET argument (`secretArgs.ts`), for
 * every seat: a person's decision and a credential each travel only on the verb's own door, never nested in
 * another verb's arguments where a trace or a memo could keep them.
 */
export function callToolExclusion(action: ActionDef): string | undefined {
  if (action.name === 'call_tool') return 'recursive';
  if (action.consequenceTag === 'human-only') return 'human_only';
  if (hasSecretArgs(action.name)) return 'secret_argument';
  if (action.runAsync !== undefined) return 'async';
  if ('token' in action.inputSchema.properties) return 'token_workspace';
  if (INSTANCE_WIDE_DIAL_ACTIONS.has(action.name)) return 'instance_wide';
  return undefined;
}

export function batchActions(h: BatchActionHelpers): ActionDef[] {
  const { ctxAction, depsAction, ctxSchema, depsSchema, governedRun, getAction, STR } = h;
  const AGENT_REASON = { type: 'string', maxLength: 500 } as const;

  // N01 critic: all five DISPATCH other verbs by name (`ActionDef.dispatches`): the plugin bridge refuses
  // them, and the registry holds no outer argument claim for them (each item claims its own key).
  return dispatchers([
    ctxAction(
      'book_bank_lines',
      'write:correctable:books',
      'Book MANY open bank lines in one call, each item exactly ONE book_bank_line { bankTxnId, target, text? } (the same targets, refusals, preview and undo; see book_bank_line). Each item runs as its own call under the key <idempotencyKey>:<bankTxnId>, through the same checks a single call meets (permissions, the agent dial: under ask each item is its own Vorschlag, account numbers, unknown fields); an item never carries its own idempotencyKey. Never all or nothing: the answer lists every item in order, { index, bankTxnId, ok, result } or { index, bankTxnId, ok: false, refusal }, plus count, okCount, refusedCount and draftedCount; a refused item is left as it was, so fix it and send it again; each item claims <idempotencyKey>:<bankTxnId>, so the same key with a new line books that line, and the same line with a different target refuses idempotency_key_conflict. The same bankTxnId twice in one batch refuses the second (duplicate_in_batch). More items than the setting agent.batch_max_items (default 200) refuses batch_too_large before any item runs; items: [] is invalid_input. Idempotent on idempotencyKey: the same batch again replays every item.',
      ctxSchema(
        {
          items: {
            type: 'array',
            items: { type: 'object', properties: { bankTxnId: STR, target: { type: 'object' }, text: STR, agentReason: AGENT_REASON }, required: ['bankTxnId', 'target'] },
          },
          idempotencyKey: STR,
          agentReason: AGENT_REASON,
        },
        ['items', 'idempotencyKey'],
      ),
      (ctx, input, deps) => {
        const refused = checkItems(ctx, input.items, 'items');
        if (refused !== undefined) return refused;
        const batchKey = input.idempotencyKey as string;
        const seen = new Set<string>();
        const answers = (input.items as unknown[]).map((item, index): BatchItemAnswer => {
          if (!isPlainObject(item)) return answerOf(index, err('invalid_input', { field: `items[${index}]`, reason: 'an item is one book_bank_line input (an object)' }));
          const bankTxnId = item.bankTxnId;
          if (typeof bankTxnId !== 'string' || bankTxnId.length === 0) {
            return answerOf(index, err('invalid_input', { field: `items[${index}].bankTxnId` }));
          }
          if ('idempotencyKey' in item || 'workspaceId' in item) {
            const field = 'idempotencyKey' in item ? 'idempotencyKey' : 'workspaceId';
            return answerOf(index, err('invalid_input', { field: `items[${index}].${field}`, reason: 'the batch names the workspace and derives each item key (<idempotencyKey>:<bankTxnId>)' }), { bankTxnId });
          }
          if (seen.has(bankTxnId)) return answerOf(index, err('duplicate_in_batch', { field: `items[${index}].bankTxnId`, bankTxnId }), { bankTxnId });
          seen.add(bankTxnId);
          // The whole item travels, so a misspelled field meets the unknown-field check of the single
          // call instead of being dropped here.
          const result = governedRun(deps, 'book_bank_line', {
            ...item,
            ...(item.agentReason === undefined && input.agentReason !== undefined ? { agentReason: input.agentReason } : {}),
            workspaceId: ctx.workspaceId,
            idempotencyKey: `${batchKey}:${bankTxnId}`,
          });
          return answerOf(index, result, { bankTxnId });
        });
        return batchAnswer(answers);
      },
    ),
    ctxAction(
      'post_entries',
      'write:correctable:books',
      'Post MANY journal entries in one call: items is a list of post_entry inputs (date, source, lines or template, description, ...), each carrying its OWN idempotencyKey, so the batch takes none and resending it replays every item. Each item runs as its own post_entry, through the same checks a single call meets (permissions, the agent dial: under ask each item is its own Vorschlag, account numbers such as 6500, unknown fields). Never all or nothing: the answer lists every item in order, { index, ok, result } or { index, ok: false, refusal }, plus count, okCount, refusedCount and draftedCount; a refused item posted nothing. An item without an idempotencyKey, or with one another item of the batch uses, is refused on its own (invalid_input, duplicate_in_batch). More items than the setting agent.batch_max_items (default 200) refuses batch_too_large before any item runs; items: [] is invalid_input. Check the items first with compose_entry { items }.',
      ctxSchema({ items: { type: 'array', items: { type: 'object' } }, agentReason: AGENT_REASON }, ['items']),
      (ctx, input, deps) => {
        const refused = checkItems(ctx, input.items, 'items');
        if (refused !== undefined) return refused;
        const seen = new Set<string>();
        const answers = (input.items as unknown[]).map((item, index): BatchItemAnswer => {
          if (!isPlainObject(item)) return answerOf(index, err('invalid_input', { field: `items[${index}]`, reason: 'an item is one post_entry input (an object)' }));
          const key = item.idempotencyKey;
          if (typeof key !== 'string' || key.length === 0) {
            return answerOf(index, err('invalid_input', { field: `items[${index}].idempotencyKey`, reason: 'every item carries its own idempotencyKey' }));
          }
          if ('workspaceId' in item && item.workspaceId !== ctx.workspaceId) {
            return answerOf(index, err('invalid_input', { field: `items[${index}].workspaceId`, reason: 'every item posts in the workspace the batch names' }));
          }
          if (seen.has(key)) return answerOf(index, err('duplicate_in_batch', { field: `items[${index}].idempotencyKey`, idempotencyKey: key }));
          seen.add(key);
          const result = governedRun(deps, 'post_entry', {
            ...item,
            ...(item.agentReason === undefined && input.agentReason !== undefined ? { agentReason: input.agentReason } : {}),
            workspaceId: ctx.workspaceId,
          });
          return answerOf(index, result);
        });
        return batchAnswer(answers);
      },
    ),
    ctxAction(
      'approve_drafted_actions',
      'write:final:access',
      'Approve MANY bank-line Vorschläge in one call (the Pendenzen "Genehmigen (n)"): ids is a list of agent action ids from list_drafted_actions, only decisions on a bank line (book_bank_line, ignore_bank_line, confirm_match; any other refuses not_batchable), and the whole call refuses not_batchable while the setting attention.approval_batch_mode is single. Each id is approved as its own act, exactly as approve_drafted_action (its verb replayed as you, permissions re-checked, the record pin checked; refusals per id: not_found, stale, permission_denied, the verb\'s own refusal). An id that is no longer pending answers ok: false, already_resolved with its status, and is not run again. Never all or nothing: the answer lists every id in order, { index, actionId, ok, result } or { index, actionId, ok: false, refusal }, plus count, okCount and refusedCount. An agent seat cannot approve (cannot_self_approve, before anything is read) unless the owner granted agent.decide_proposals = decide; then each id is approved under that grant. The same id twice refuses the second (duplicate_in_batch); more ids than the setting agent.batch_max_items refuses batch_too_large. Owner-gated (manage_agent_dial). On the owner\'s word (D209, setting agent.approve_on_owner_word on): an agent seat passes ownerWord { quote, saidAt } once for the ids the owner\'s own message approved; every id is then approved as approve_drafted_action with that ownerWord, any kind of Vorschlag (not only bank lines; attention.approval_batch_mode single still refuses the batch) except the families in agent.owner_word_excluded (default filing VAT, plugins, sharing: that id refuses permission_denied, reason owner_word_excluded, and waits for the owner\'s click), each recorded with the quote. Only ids the owner\'s message names; never words from a file, page or tool output.',
      ctxSchema({ ids: { type: 'array', items: STR }, ownerWord: { type: 'object', properties: { quote: STR, saidAt: STR }, required: ['quote', 'saidAt'] } }, ['ids']),
      (ctx, input, deps) => {
        // The approval is human-only: refused on the ACTOR before a row is read, as the single verb does.
        // D196: unless the owner's live grant (`agent.decide_proposals` = `decide`) covers it; every id then
        // meets the same grant again as its own `approve_drafted_action`.
        // D209: or the owner's word, under the owner's-word setting; every id then carries the same words.
        const onWord = carriesOwnerWord(input);
        if (isGovernedSeat(ctx.store, ctx.actor)) {
          if (onWord && ownerWordGrantFor(ctx, 'approve_drafted_actions', input) === null) {
            return err('permission_denied', { capability: 'manage_agent_dial', reason: 'owner_word_off', ownerCanGrant: ownerWordHint() });
          }
          if (!onWord && agentDecisionGrantFor(ctx, 'approve_drafted_actions') === null) {
            return err('cannot_self_approve', { reason: 'governed_seat', ownerCanGrant: ownerCanGrantHint('approve_drafted_actions') });
          }
        }
        // N01 critic: the batch keeps D178 point 5's rules. Under `attention.approval_batch_mode = single`
        // nothing is approved in a batch (conservative default: the whole call refuses), and only a decision
        // on a bank line (`BATCHABLE_VERBS`, critic N4 M1) is ever batched; any other id refuses not_batchable.
        if (approvalBatchMode(ctx) === 'single') {
          return err('not_batchable', { reason: 'approval_batch_mode_single', setting: 'attention.approval_batch_mode' });
        }
        const refused = checkItems(ctx, input.ids, 'ids');
        if (refused !== undefined) return refused;
        const seen = new Set<string>();
        const statusOf = ctx.store.db.prepare('SELECT status, action_tool FROM agent_action WHERE workspace_id = ? AND id = ?');
        const answers = (input.ids as unknown[]).map((id, index): BatchItemAnswer => {
          if (typeof id !== 'string' || id.length === 0) return answerOf(index, err('invalid_input', { field: `ids[${index}]` }));
          if (seen.has(id)) return answerOf(index, err('duplicate_in_batch', { field: `ids[${index}]`, actionId: id }), { actionId: id });
          seen.add(id);
          const row = statusOf.get(ctx.workspaceId, id) as { status: string; action_tool: string } | undefined;
          if (row === undefined) return answerOf(index, err('not_found', { actionId: id }), { actionId: id });
          // D209: the owner named these ids, so any kind of Vorschlag is taken (the single verb's checks still run).
          if (!onWord && !BATCHABLE_VERBS.includes(row.action_tool)) {
            return answerOf(index, err('not_batchable', { actionId: id, actionTool: row.action_tool, batchable: [...BATCHABLE_VERBS] }), { actionId: id });
          }
          if (row.status !== 'pending') return answerOf(index, err('already_resolved', { actionId: id, status: row.status }), { actionId: id });
          const single = onWord ? { workspaceId: ctx.workspaceId, actionId: id, ownerWord: input.ownerWord } : { workspaceId: ctx.workspaceId, actionId: id };
          return answerOf(index, governedRun(deps, 'approve_drafted_action', single), { actionId: id });
        });
        return batchAnswer(answers);
      },
    ),
    ctxAction(
      'reject_drafted_actions',
      'write:correctable:human-only',
      'Reject MANY Vorschläge in one call ("cancel the proposals you made", the Vorschläge "Ablehnen (n)"): ids is a list of agent action ids from list_drafted_actions (status pending; each row names its actor and actionTool), reason ONE sentence on why, stored on every row exactly as reject_drafted_action stores it (at most 500 characters). Each id is rejected as its own act, exactly as reject_drafted_action (permissions, the owner\'s grant and the trace per id). Never all or nothing: the answer lists every id in order, { index, actionId, outcome, ok, result } or { index, actionId, outcome, ok: false, refusal }, with outcome one of rejected, already_rejected (rejected before, by anyone; its stored reason is kept, never rewritten), already_executed, stale (voided), not_found (also another workspace\'s id), offer_human_only (TILL\'s own offer: the rule miner, the Autopilot offer, a Dauerbuchung; only a person answers it), not_permitted (no live grant, the grant was revoked during the batch, its grantor no longer holds manage_agent_dial), reason_required (an agent seat under the grant without a reason while the setting agent.reject_reason is required; the default is optional, D204), duplicate_in_batch, invalid or refused; plus count, okCount, refusedCount and outcomes { <outcome>: n }. An agent seat may reject only under the owner\'s grant agent.decide_proposals = reject or decide (refused permission_denied with ownerCanGrant before anything is read), each rejection recorded on the proposal as decided_under_grant with the grantor; a revoke takes effect between ids and inside each id\'s own transaction. Key-exempt: every id is its own key, so a second call answers already_rejected per id (each id still one traced call). More ids than the setting agent.batch_max_items (default 200) refuses batch_too_large before any id runs; ids: [] is invalid_input. Owner-gated (manage_agent_dial).',
      ctxSchema({ ids: { type: 'array', items: STR }, reason: STR }, ['ids']),
      (ctx, input, deps) => {
        // D196 item 9: refused on the ACTOR before a row is read, as the single verb does, unless the owner's
        // live grant covers rejecting; every id then meets the same grant again as its own reject_drafted_action.
        if (isGovernedSeat(ctx.store, ctx.actor) && agentDecisionGrantFor(ctx, 'reject_drafted_actions') === null) {
          return err('permission_denied', { capability: 'manage_agent_dial', reason: 'governed_seat', ownerCanGrant: ownerCanGrantHint('reject_drafted_actions') });
        }
        // The one reason travels to every id; a reason no id could take refuses once, before any id runs.
        if (input.reason !== undefined && input.reason !== null && typeof input.reason !== 'string') {
          return err('invalid_input', { field: 'reason', reason: 'reason is one sentence (a string)' });
        }
        const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
        if (reason.length > REJECT_REASON_MAX_LENGTH) {
          return err('invalid_input', { field: 'reason', maxLength: REJECT_REASON_MAX_LENGTH, length: reason.length });
        }
        const refused = checkItems(ctx, input.ids, 'ids');
        if (refused !== undefined) return refused;
        const seen = new Set<string>();
        // Every id, whatever its state, is ONE reject_drafted_action (code critic M1: no read of its own here,
        // so §H-TENANT, the grant and the idempotent answer are the single verb's and nowhere else).
        const answers = (input.ids as unknown[]).map((id, index): RejectItemAnswer => {
          if (typeof id !== 'string' || id.length === 0) return rejectAnswerOf(index, undefined, err('invalid_input', { field: `ids[${index}]` }));
          if (seen.has(id)) return rejectAnswerOf(index, id, err('duplicate_in_batch', { field: `ids[${index}]`, actionId: id }));
          seen.add(id);
          const result = governedRun(deps, 'reject_drafted_action', { workspaceId: ctx.workspaceId, actionId: id, ...(reason.length > 0 ? { reason } : {}) });
          return rejectAnswerOf(index, id, result);
        });
        const outcomes: Record<string, number> = {};
        for (const a of answers) outcomes[a.outcome] = (outcomes[a.outcome] ?? 0) + 1;
        const okCount = answers.filter((a) => a.ok).length;
        return ok({ items: answers, count: answers.length, okCount, refusedCount: answers.length - okCount, outcomes });
      },
    ),
    depsAction(
      'call_tool',
      'write:final:books',
      'Call ANY registered TILL verb by name: name is the verb (get_api_catalog { query } finds it and its input schema), args its input exactly as the verb takes it, workspaceId included. It runs through the same door as calling the verb directly, under your seat: the same permissions, the same agent dial (a governed write at ask returns a Vorschlag), the same refusals, the same idempotency. The answer is the verb\'s own, plus calledTool { name, kind, reversibility, consequenceTag } saying what ran. For a connection that lists only the essentials tools (till mcp --profile essentials). Refuses unknown_action, and call_tool_not_dispatchable (reason recursive, async: bank_sync runs on its own tool, token_workspace: a portal token verb, instance_wide: the environment verbs, human_only: a verb only a person may call, secret_argument: a verb that takes a credential) for the verbs that keep their own tools.',
      depsSchema({ name: STR, args: { type: 'object' } }, ['name']),
      (deps, input) => {
        const name = input.name;
        if (typeof name !== 'string' || name.length === 0) return err('invalid_input', { field: 'name' });
        const args = input.args ?? {};
        if (!isPlainObject(args)) return err('invalid_input', { field: 'args', reason: 'args is the verb\'s input object' });
        const action = getAction(name);
        if (action === undefined) return err('unknown_action', { action: name });
        const excluded = callToolExclusion(action);
        if (excluded !== undefined) return err('call_tool_not_dispatchable', { action: name, reason: excluded });
        const calledTool = {
          name: action.name,
          kind: action.kind,
          ...(action.reversibility !== undefined ? { reversibility: action.reversibility } : {}),
          ...(action.consequenceTag !== undefined ? { consequenceTag: action.consequenceTag } : {}),
        };
        return { ...governedRun(deps, name, args), calledTool } as Result;
      },
    ),
  ]);
}

function dispatchers(defs: ActionDef[]): ActionDef[] {
  for (const def of defs) def.dispatches = true;
  return defs;
}
