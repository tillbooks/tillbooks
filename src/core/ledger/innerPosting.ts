/**
 * A composite verb's INNER posting (K1, 04.10.2026): `postEntryInternal` under the composite's own
 * idempotency scope, read back before anyone is told it happened.
 *
 * A composite (the wage journal, the MWST-Saldierung, an accrual, an opening balance, ...) posts with a
 * key it DERIVES, from its own key or from a row id a caller can read before the composite runs. Called
 * bare, that inner `postEntry` memoised under `post_entry`, the scope of the public verb, so a
 * `post_entry` made first under the derived key was replayed in place of the composite's posting and
 * the composite answered ok over a foreign entry. This is the one door those postings go through:
 *
 *  1. SCOPE. `postEntryInternal` (the shape `close_year` uses, critic R6-1 on cl-periods) posts under an
 *     `InternalPostScope`, a closed literal union no public verb writes and no wire input can name: the
 *     scope is a parameter, never a field of the caller-shaped `PostEntryInput`.
 *  2. READ-BACK. The entry that came back is read from `journal_entry` and must be the composite's own:
 *     posted, in this workspace, under the source and the key this call posted with. Anything else is
 *     refused `inner_write_not_own` (naming what was expected and what was found), so the composite
 *     aborts instead of recording a foreign entry as its own. A scope is a defence; the read-back is the
 *     proof, and it still holds if a future change re-derives a key or shares a scope again.
 *
 * Not on the ledger index (the P3 guard pins that list): an owning module imports it by path, the way
 * `reverseOwnedEntry` is imported.
 */

import type { WorkspaceContext } from '../context.js';
import { err } from '../result.js';
import type { Result } from '../result.js';
import { postEntryInternal } from './postEntry.js';
import type { InternalPostScope, PostEntryInput, PostEntryOk } from './postEntry.js';

/** The refusal a composite answers when an inner write's result is not its own. */
export const INNER_WRITE_NOT_OWN = 'inner_write_not_own';

/** `postEntryInternal`, and the posted entry read back as this composite's own. */
export function postEntryInternalChecked(ctx: WorkspaceContext, input: PostEntryInput, scope: InternalPostScope): Result<PostEntryOk> {
  const posted = postEntryInternal(ctx, input, scope);
  if (!posted.ok) return posted;
  const row = ctx.store.db
    .prepare('SELECT status, source, idempotency_key FROM journal_entry WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, posted.entryId) as { status: string; source: string; idempotency_key: string | null } | undefined;
  if (row === undefined || row.status !== 'posted' || row.source !== input.source || row.idempotency_key !== input.idempotencyKey) {
    return err(INNER_WRITE_NOT_OWN, {
      scope,
      inner: 'post_entry',
      entryId: posted.entryId,
      expected: { status: 'posted', source: input.source, idempotencyKey: input.idempotencyKey },
      found: row === undefined ? null : { status: row.status, source: row.source, idempotencyKey: row.idempotency_key },
    });
  }
  return posted;
}
