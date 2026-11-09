/**
 * N01 US-N01.8, THE UNDO HINT: a write's answer names the call that undoes it, `undo: { tool, args }`, ONLY
 * where the inverse and its arguments are unambiguous. Two verbs qualify:
 *
 *  - `post_entry` -> `reverse_entry { entryId }`: a posted entry is corrected by its mirror (OR 957a).
 *  - `book_bank_line` -> `reopen_bank_line { bankTxnId }`: one verb undoes every kind of line decision
 *    (a booking reversed, a match or an ignore superseded).
 *
 * Every other write answers without a hint: a guessed inverse is worse than none. The hint names the verb
 * and the record; the caller adds its own `idempotencyKey` (and, for `reopen_bank_line`, its `reason`),
 * because a key is the caller's to choose and a reason is the person's to give. A drafted answer (nothing
 * ran yet) never carries one. Added at the transport seam (`runGoverned`), so the stored memo of the act is
 * unchanged and an internal invoke never sees it; the D172 setting `agent.undo_hints` (`on` default, `off`)
 * turns it off per workspace.
 */

import type { Result } from '../core/result.js';
import type { ActionInput } from './registry.js';

/** What the hint carries: the verb to call and the arguments that name the record. */
export interface UndoHint {
  tool: string;
  args: Record<string, unknown>;
}

/** The D172 setting and its two values. */
export const UNDO_HINTS_SETTING = 'agent.undo_hints';

/** The verbs that carry a hint, each with how its hint is read off the call and its answer. */
export const UNDO_HINTS: Readonly<Record<string, (input: ActionInput, result: Result) => UndoHint | undefined>> = {
  post_entry: (input, result) =>
    result.ok && typeof result.entryId === 'string'
      ? { tool: 'reverse_entry', args: { workspaceId: input.workspaceId, entryId: result.entryId } }
      : undefined,
  book_bank_line: (input, result) =>
    result.ok && typeof input.bankTxnId === 'string'
      ? { tool: 'reopen_bank_line', args: { workspaceId: input.workspaceId, bankTxnId: input.bankTxnId } }
      : undefined,
};

/** The hint for this call, or undefined (not a hinted verb, a refusal, or a draft that ran nothing). */
export function undoHintFor(verb: string, input: ActionInput, result: Result): UndoHint | undefined {
  if (!result.ok || result.drafted === true) return undefined;
  return UNDO_HINTS[verb]?.(input, result);
}
