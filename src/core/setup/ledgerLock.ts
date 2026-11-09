/**
 * The A00 fiscal lock, in ONE place.
 *
 * `base_currency` and `fiscal_year_start` freeze once the workspace has a posted entry (§H-FX): the
 * first protects the base amounts already stored on every posted line, the second protects A03's
 * period math. `setFiscalConfig` enforces it on the write and `getCompanyProfile` reports it on the
 * read, and the two MUST agree. When the read had its own notion of the lock (it had none, so the
 * Studio's lock UI never engaged) the operator could edit both fields freely and only learn at save
 * time that they were frozen. So the predicate lives here and both callers ask it, rather than each
 * counting rows its own way.
 *
 * A draft entry does not lock: nothing is committed to the base currency until it posts.
 */

import type { WorkspaceContext } from '../context.js';

/** True once at least one POSTED journal entry exists in this workspace. */
export function isLedgerLocked(ctx: WorkspaceContext): boolean {
  const posted = ctx.store.db
    .prepare("SELECT COUNT(*) AS c FROM journal_entry WHERE workspace_id = ? AND status = 'posted'")
    .get(ctx.workspaceId) as { c: number };
  return posted.c > 0;
}
