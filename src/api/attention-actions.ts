/**
 * G15's two verbs, defined here and spread into `ACTIONS` as one line (the `dashboardActions`
 * precedent), so several agents appending to the append-only registry at once collide over a line
 * rather than a block.
 *
 * TWO READS AND NOT ONE WRITE, the F00/B03 shape: the attention hub owns no table and posts nothing
 * (pure P5), so both tools carry `readOnlyHint` on MCP, neither carries an `idempotency_key`, and
 * there is no conformance WRITE scenario to write. Both opt into `READ_SCENARIOS` instead, and the
 * whole-database snapshot there proves they mutate nothing.
 *
 * RBAC IS THE UNION OF THE PROVIDERS' READ GATES, asserted PER QUEUE in the engine, exactly as F00's
 * dashboards assert per-tile. So the boundary declaration in `actionCapabilities.ts` is
 * `ungated('asserted_in_engine', ...)`: gating the whole verb on any one read domain would either
 * deny a role a queue it may read or leak one it may not, and inventing a `read_attention` capability
 * would create a right grantable while every underlying right is denied.
 *
 * The descriptions name the German hub word (Pendenzen) so an agent asked "was steht an?" can find
 * the verb, and they state the honesty contract an agent will quote: a queue the actor may not read is
 * ABSENT from the payload (not a zero), a failed provider is NAMED and carries no count, and `total`
 * is `null` (never `0`) when the actor may read no queue at all.
 *
 * As with every sibling module, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { attentionSummary, attentionList } from '../core/attention/index.js';
import type { ActionKind } from './actionKind.js';

export interface AttentionActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The G15 verbs, in append order. */
export function attentionActions(h: AttentionActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT } = h;

  return [
    ctxAction(
      'attention_summary',
      'read',
      `Pendenzen (the attention hub): everything waiting for a decision from the caller, in ONE call, composed live from the module queues the product already owns and never cached (pure read, G15 posts nothing and owns no tables). Returns { computedAt, visibleQueues, total, incomplete, queues:[{queueId, area, count, topUrgency}], top:[AttentionItem], failed:[queueId] }. 'top' is the ranked, same-entity-collapsed leading rows the human screen shows (urgency overdue>due>open, then a fixed queue rank, then since), so an agent and the screen read one payload. Each queue's 'count' is a true COUNT, never a truncated list length. HONESTY CONTRACT an agent may quote: a queue whose read capability the caller lacks is ABSENT from queues[] and top[] entirely (not a zero); a provider that throws is NAMED in failed[] with incomplete:true and contributes no count and no row; and 'total' is null (never 0) when visibleQueues is 0, because an actor told nothing was not told a total. topLimit defaults to 5. Each queues[] row also names its kind ('approve' | 'do' | 'note', D178). Registered queues: agent_action_bank (D178: pending Vorschläge whose drafted verb belongs to the bank, e.g. book_bank_line, ignore_bank_line, the payment and statement verbs -> /agent, area bank), agent_action (every other pending Vorschlag -> /agent, area system), qr_match (A21 unmatched incoming credits -> /reconciliation), review_flag (A25 flagged postings -> /journal), dunning_run (A15 proposed Mahnläufe -> /dunning), checklist_items_due (G22 checklist items due -> /checklisten), bank_activation (EBICS steps before the bank is ready: send INI/HIA, sign the INI letter -> /bank-accounts) bank_keys_review (D143, the bank answered HPB: compare and confirm the bank keys -> /bank-accounts), bank_fetch_failed (D150, the latest automatic statement fetch failed and will not be retried that day, with the bank's code -> /bank-accounts), bank_statement_gap (D150, day-end statements are missing between two in the books, or a downloaded one waits behind a gap; the item names the numbers, the days and whether money is missing -> /bank-accounts) and bank_lines_waiting (D150, bank lines that need a person, per Bankkonto, without those a pending Vorschlag already names -> /bank). THE ROW CARRIES ITS DECISION (F-01): each AttentionItem names the exits its owning surface offers as decisionOptions[] ({id, verb, labelKey, role, input, humanConfirm?, reasonField?, capability?, deepLink?}), where verb is an EXISTING write (apply_qr_match, override_qr_match, approve_drafted_action, reject_drafted_action, issue_dunning_run, approve_entry, confirm_statement_gap) and input is the whole fixed input beyond workspaceId incl. a deterministic per-item idempotencyKey (replay-safe: call it twice, it writes once); plus suggestedInvoiceId (A21's live-scored invoice, null when none), reasonCode/reasonKey (why it is pending), consequenceKey/consequence (the D118 C4 sentence of the write from the dial map; null when the verb is not dial-governed) and proposedBy (the raw actor id of the proposer or reviewer, for the self-approve check) with proposedByKind ('agent' | 'studio' | 'member' | 'unknown') and proposedByName (a member's display name, else null), so a surface names the actor in words and never prints an id. The hub mints no verb and clears nothing itself: an agent acts by calling the option's verb with its input, under that verb's own gate and dial.`,
      ctxSchema({ topLimit: INT }),
      (ctx, input) => attentionSummary(ctx, as(input)),
    ),
    ctxAction(
      'attention_list',
      'read',
      `Page one queue or one area of Pendenzen: the same providers, the same capability filter and the same collapse and ranking as attention_summary, so the two faces never describe a queue differently. Returns { computedAt, items:[AttentionItem], nextCursor?, failed:[queueId] }. Filter by queueId (a single queue), area ('bank' | 'sales' | ...), or urgency ('overdue' | 'due' | 'open'); page with limit (default 20) and the opaque cursor from a prior nextCursor. A denied queue is absent, a thrown provider is named in failed[], and nothing here clears, dismisses or approves anything: every AttentionItem carries its decisionOptions[] (the owning surface's exits as existing write verbs with their fixed input and per-item idempotencyKey, see attention_summary), its suggestedInvoiceId, reasonCode/reasonKey and consequenceKey/consequence, and a deepLink descriptor into its owning surface for the hard case. Reads only. THE WHOLE LIST IN SECTIONS (D178): pass grouping ('by_area' | 'by_kind') and the answer is instead { computedAt, grouping, visibleQueues, total, incomplete, failed, approvalBatchMode, sections:[{ key, count, queues, items, nextCursor? }] } over EVERY item (never a top-n): by_area sections bank, accounting, sales, system (bank first; inside bank the Vorschläge, then the waiting bank lines, then the rest by urgency); by_kind sections approve (Vorschläge), do (work a person carries out), note (to look at). Every item carries count (the units it stands for: 1, or N for an aggregate row such as one bank account's waiting lines), area and kind; a section's count is the units of all its rows; total is the sum of the sections and equals attention_summary.total for the same caller. limit is the page size per section (default 25); a section with more rows carries nextCursor, and { grouping, section, cursor } answers that one section from there. approvalBatchMode is the workspace setting attention.approval_batch_mode (tick | single | all_with_confirm), how the Studio approves several bank Vorschläge: each approval is still one approve_drafted_action call, and only a row with batchable: true (a decision on a bank line: book_bank_line, ignore_bank_line, confirm_match; never a changed one) is ever batched. A Vorschlag that names a bank line carries that line's signed amountMinor (credit positive, debit negative), its currency and subtitleParams.date/counterparty/target/targetKind, but only for a caller who may read the bank (read_sales); a batchable one carries posts: true when approving it mints a journal entry (a booking to accounts or by a Buchungsregel, a settlement, an unpaid payment run) and posts: false when it books nothing (a line set aside, a match to an existing entry). A Vorschlag whose records changed since the proposal cannot be approved: it carries changedSinceProposal and kind do, and a stale one (voided by an approval attempt) stays listed with stale: true while its bank line is still open, its one exit the link to that line.`,
      ctxSchema({ queueId: STR, area: STR, urgency: STR, limit: INT, cursor: STR, grouping: STR, section: STR }),
      (ctx, input) => attentionList(ctx, as(input)),
    ),
  ];
}
