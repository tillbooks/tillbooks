/**
 * D177 (A39 §16.1, critic D177-R4-1 and the R4 INFO): the history of a bank-line Vorschlag's SYSTEM
 * closures. Two closures are made by the engine, not by a person's "no":
 *
 * - `superseded`: a newer Vorschlag of the same seat for the same line replaced it (reason "ersetzt");
 * - `line_decided`: the line was decided by anyone (reason "Zeile entschieden").
 *
 * A `line_decided` closure is the ONE rejection that can return to `pending`, and only through the reopen
 * of the very decision that made it (`reviveLineDraftsOnReopen`). So that a revived row never reads as
 * never touched, every closure, revive and failed revive appends one entry to `agent_action.history_json`
 * (append-only by construction: entries are only ever added), and `closure_kind` marks a row whose CURRENT
 * rejection is a system closure, which the trust read model does not count against the agent (a person's
 * rejection is the evidence there, `trust.ts`).
 *
 * No A03 chain row: `agent_action` is governance state, `reject_drafted_action` writes none either, and a
 * new chain entity kind needs the Studio's audit vocabulary (Studio-owned). No imports beyond the context
 * type, so the banking module writes it without a cycle.
 */

import type { WorkspaceContext } from '../context.js';

/** Why the engine (not a person) closed a Vorschlag. */
export const SYSTEM_CLOSURE_KINDS = ['superseded', 'line_decided'] as const;
export type SystemClosureKind = (typeof SYSTEM_CLOSURE_KINDS)[number];

/** One entry of a Vorschlag's history. */
export type DraftHistoryEntry =
  | { event: 'closed'; kind: SystemClosureKind; at: string; by: string; reason: string; linkId?: string; replacedBy?: string }
  | { event: 'revived'; at: string; by: string; undoneLinkId: string }
  | { event: 'not_revived'; at: string; by: string; undoneLinkId: string; reason: string };

/** Append one entry to the row's history (tenant-bound). */
export function appendDraftHistory(ctx: WorkspaceContext, actionId: string, entry: DraftHistoryEntry): void {
  ctx.store.db
    .prepare("UPDATE agent_action SET history_json = json_insert(COALESCE(history_json, '[]'), '$[#]', json(?)) WHERE workspace_id = ? AND id = ?")
    .run(JSON.stringify(entry), ctx.workspaceId, actionId);
}

/** The row's history, oldest first (an unreadable or absent one reads as empty). */
export function draftHistoryOf(raw: string | null): DraftHistoryEntry[] {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as DraftHistoryEntry[]) : [];
  } catch {
    return [];
  }
}
