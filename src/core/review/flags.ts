/**
 * A25 US-A25.1, `flagEntry`: mark an entry as questioned, without changing the books.
 *
 * A flag appends one `entry_review` event whose status is `flagged`, with the reason as the row's
 * comment. Flagging is metadata: the posted rows are untouched (§H-AUDIT, the sidecar boundary in
 * `shared.ts`), and the answer to a justified flag is a correcting reversal (A02), never an edit.
 * `source` distinguishes a person's flag (`manual`) from `preparePeriod`'s machine flags
 * (`prepare`), which is what lets a prepare re-run refresh its own flags without duplicating them
 * and lets the review surface label the two differently.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { appendReviewEvent, mapReviewEvent, postedEntry } from './shared.js';

export interface FlagEntryInput {
  entryId: string;
  reason: string;
  idempotencyKey: string;
}

export function flagEntry(ctx: WorkspaceContext, input: FlagEntryInput): Result {
  if (typeof input?.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const entry = postedEntry(ctx, input.entryId);
  if (entry === undefined) return err('not_found', { entryId: input.entryId });
  if (entry.status !== 'posted') return err('not_posted', { entryId: entry.id, status: entry.status });
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
    return err('invalid_input', { field: 'reason' });
  }

  const run = (): Result => {
    const row = appendReviewEvent(ctx, {
      entryId: entry.id,
      kind: 'flag',
      status: 'flagged',
      comment: input.reason,
    });
    return ok({ reviewId: row.id, entryId: entry.id, status: 'flagged', review: mapReviewEvent(row) });
  };
  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'flag_entry', run);
}
