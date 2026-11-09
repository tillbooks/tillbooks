/**
 * A25 US-A25.2, `approveEntry`: the Treuhänder's sign-off on one checked entry.
 *
 * Approval is METADATA: it appends one `entry_review` event whose status is `approved`, and it
 * neither locks nor alters the entry (§H-AUDIT; locking a whole reviewed period is A03's
 * `lock_period`, invoked by the review surface, never minted here). Approving an already-reversed
 * entry is allowed but NOTED (`alreadyReversed: true` on the payload and on the row's comment):
 * a reversal pair nets to zero, so signing one off is legitimate, but the reviewer should see that
 * the story continued after the entry was written.
 *
 * A sign-off is a human act: `approve_entry` is on G01's `NOT_AUTOMATABLE` denylist and is gated on
 * the `review` capability (A24), which the `agent` built-in does not hold.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { appendReviewEvent, isReversed, mapReviewEvent, postedEntry } from './shared.js';

export interface ApproveEntryInput {
  entryId: string;
  /** An optional sign-off note, kept on the approval row itself. */
  note?: string;
  idempotencyKey: string;
}

export function approveEntry(ctx: WorkspaceContext, input: ApproveEntryInput): Result {
  if (typeof input?.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const entry = postedEntry(ctx, input.entryId);
  if (entry === undefined) return err('not_found', { entryId: input.entryId });
  if (entry.status !== 'posted') return err('not_posted', { entryId: entry.id, status: entry.status });
  if (input.note !== undefined && typeof input.note !== 'string') {
    return err('invalid_input', { field: 'note' });
  }

  const run = (): Result => {
    const alreadyReversed = isReversed(ctx, entry.id);
    const note = typeof input.note === 'string' && input.note.trim().length > 0 ? input.note : null;
    const comment = alreadyReversed
      ? `${note === null ? '' : `${note} `}(approved after reversal)`.trim()
      : note;
    const row = appendReviewEvent(ctx, {
      entryId: entry.id,
      kind: 'approve',
      status: 'approved',
      comment,
    });
    return ok({
      reviewId: row.id,
      entryId: entry.id,
      status: 'approved',
      alreadyReversed,
      review: mapReviewEvent(row),
    });
  };
  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'approve_entry', run);
}
