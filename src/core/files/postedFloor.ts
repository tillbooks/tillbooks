/**
 * The D63 posting-time hook: the moment a record becomes POSTED evidence, every file already linked
 * to it gets the OR 958f floor a link to a posted record would have derived.
 *
 * A LEAF MODULE ON PURPOSE, and the boundary is measured rather than aesthetic. The posting paths
 * import this file, and `test/style/studio-sees-payloads.test.mjs` holds `postEntry`'s runtime
 * closure free of Node-only code so the Studio can keep importing the engine's types without ever
 * being one careless import away from bundling SQLite or `node:crypto`. `files.ts` hashes uploads
 * with `node:crypto`, so the hook cannot live there without dragging that builtin into every
 * posting path's closure: it lives here, over `retention.ts`'s pure arithmetic, instead.
 *
 * CALLED FROM THE POSTING PATHS, inside their own transaction: A02's status flip in
 * `src/core/ledger/postEntry.ts` (which covers a direct post, a draft promoted in place, a reversal
 * and every poster-delegate post), and A10's issue transition in `src/core/sales/document.ts` (the
 * same write that stamps `issue_date` and consumes the gap-free number). A payment needs no hook:
 * `record_payment` posts in the same call, so a payment row never exists un-posted and `linkFile`
 * derives immediately.
 *
 * EVERY LINKED ROW, not only heads: a superseded version carries its own link columns and its own
 * retention (OR 958f retains the trail), and `deleteFile` guards each row by its own columns.
 *
 * IDEMPOTENT ON ROWS by construction: both dates only ever move through `later`, so a second run
 * computes exactly the values the first one wrote and the early-out writes nothing at all. The same
 * monotone rules as `linkFile`, deliberately: the statutory column never goes down, `retention_until`
 * is raised to it, and a manual date already above the floor is left exactly as the operator set it.
 * No audit row of its own: the posting that triggered it is stamped by its own path, and the
 * derivation is a consequence, exactly as it is on `files_link`.
 *
 * QUIET ON A TARGET THAT IS NOT POSTED EVIDENCE, so a mis-placed call cannot derive a floor D63 says
 * must not exist yet. Returns the number of rows it raised, for the caller that is a test.
 */

import type { WorkspaceContext } from '../context.js';
import type { StoredFileRow } from './files.js';
import {
  RETENTION_SOURCES,
  accountingRecordDate,
  isAccountingEntityKind,
  isPostedAccountingRecord,
  later,
  statutoryRetentionUntil,
} from './retention.js';

export function deriveStatutoryOnPost(ctx: WorkspaceContext, entityKind: string, entityId: string): number {
  if (!isAccountingEntityKind(entityKind)) return 0;
  if (!isPostedAccountingRecord(ctx, entityKind, entityId)) return 0;
  const rows = ctx.store.db
    .prepare('SELECT * FROM stored_file WHERE workspace_id = ? AND entity_kind = ? AND entity_id = ?')
    .all(ctx.workspaceId, entityKind, entityId) as StoredFileRow[];
  if (rows.length === 0) return 0;
  const recordDate = accountingRecordDate(ctx, entityKind, entityId);
  const at = ctx.clock.now();
  let raised = 0;
  for (const row of rows) {
    const anchor = recordDate ?? row.created_at.slice(0, 10);
    const statutoryUntil = later(row.retention_statutory_until, statutoryRetentionUntil(ctx, anchor));
    const retentionUntil = later(row.retention_until, statutoryUntil);
    if (statutoryUntil === row.retention_statutory_until && retentionUntil === row.retention_until) continue;
    const raisedRetention = retentionUntil !== row.retention_until;
    ctx.store.db
      .prepare(
        `UPDATE stored_file
            SET retention_until = ?, retention_source = ?, retention_statutory_until = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        retentionUntil,
        raisedRetention ? RETENTION_SOURCES[1] : row.retention_source,
        statutoryUntil,
        at,
        ctx.workspaceId,
        row.id,
      );
    raised += 1;
  }
  return raised;
}
