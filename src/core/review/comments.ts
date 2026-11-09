/**
 * A25 US-A25.1, `commentEntry`: query an entry without changing the books.
 *
 * A comment appends one `entry_review` event carrying the status it found in force, so the thread
 * stays chronological and a comment can never move an entry's review state. The posted
 * `journal_entry`/`journal_line` rows are untouched by construction (§H-AUDIT: the sidecar boundary,
 * see `shared.ts`); the client answers a queried posting with a correcting reversal (A02), never an
 * edit.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { appendReviewEvent, currentReviewStatus, mapReviewEvent, postedEntry } from './shared.js';
import type { ReviewEventRow } from './shared.js';

export interface CommentEntryInput {
  entryId: string;
  text: string;
  idempotencyKey: string;
}

export function commentEntry(ctx: WorkspaceContext, input: CommentEntryInput): Result {
  if (typeof input?.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const entry = postedEntry(ctx, input.entryId);
  if (entry === undefined) return err('not_found', { entryId: input.entryId });
  // Review annotates the BOOKS, and a draft is not the books yet: it mutates freely, so a thread
  // hung on it would describe rows that can silently change under the comments.
  if (entry.status !== 'posted') return err('not_posted', { entryId: entry.id, status: entry.status });
  if (typeof input.text !== 'string' || input.text.trim().length === 0) {
    return err('invalid_input', { field: 'text' });
  }

  const run = (): Result => {
    const status = currentReviewStatus(ctx, entry.id);
    const row = appendReviewEvent(ctx, { entryId: entry.id, kind: 'comment', status, comment: input.text });
    return ok({ reviewId: row.id, entryId: entry.id, status, review: mapReviewEvent(row) });
  };
  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'comment_entry', run);
}

/**
 * The comment/flag/approve thread of one entry, oldest first: the drawer's read model (P5), and the
 * seam A26's month-end checklist reads a queried entry's conversation through. Engine-level only
 * today; `review_status` is the registered MCP read.
 */
export function reviewThread(ctx: WorkspaceContext, input: { entryId: string }): Result {
  const entry = postedEntry(ctx, input?.entryId);
  if (entry === undefined) return err('not_found', { entryId: input?.entryId });
  const rows = ctx.store.db
    .prepare(
      `SELECT * FROM entry_review WHERE workspace_id = ? AND entry_id = ?
        ORDER BY created_at ASC, rowid ASC`,
    )
    .all(ctx.workspaceId, entry.id) as ReviewEventRow[];
  const last = rows.at(-1);
  return ok({
    entryId: entry.id,
    status: last === undefined ? 'open' : last.status,
    events: rows.map(mapReviewEvent),
  });
}
