/**
 * The raw-db twin of `remintEpoch` (./outbox.ts): force the egress publish dial OFF and re-mint the
 * stream epoch on every workspace a COPY produced. Two copy paths need it, and both hold a raw database
 * handle rather than a `WorkspaceContext`, which is why this is SQL on the db and not the ctx seam:
 *
 *  - N00 `env_copy` (`landscape/copy.ts`, its FINDING #2), over the whole copy scope;
 *  - G04 `restoreBackup` (`data/portability.ts`, critic R1-M2), over its one new workspace, inside the
 *    restore transaction.
 *
 * `sync_publish_state` is workspace-scoped state, not a reference, so a copy carried `publishing = 1`
 * and the SAME `epoch` verbatim: it would be primed to egress the source's ledger facts under the LIVE
 * epoch. Egress is CONSENT, so a copy never inherits an ON dial; re-minting the epoch makes any consumer
 * that had been following the source see a fork (`cursor_reset_required`) rather than silently replay
 * mismatched history, the `remintEpoch` contract.
 *
 * It lives here, beside `remintEpoch`, so neither copy path imports the other (the restore reused it
 * from `landscape/copy.ts` first, which made `data` and `landscape` import each other).
 */

import type Database from 'better-sqlite3';

export interface PublishResetSummary {
  /** Workspaces whose `sync_publish_state.publishing` was forced to 0 (in scope). */
  readonly workspacesReset: number;
  /** Workspaces whose stream `epoch` was re-minted (those that had a non-null epoch, i.e. a live stream). */
  readonly epochsReminted: number;
}

/**
 * Apply the reset to `wsIds` (empty = every workspace in the db, the whole-instance copy; otherwise
 * exactly those workspaces, §H-TENANT for a mandate copy or a restore). A db without the sync table
 * has nothing to reset.
 */
export function resetPublishDial(db: Database.Database, ids: { next(prefix: string): string }, wsIds: readonly string[]): PublishResetSummary {
  const has = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_publish_state'")
    .get();
  if (has === undefined) return { workspacesReset: 0, epochsReminted: 0 };

  const idList = wsIds.length > 0 ? wsIds.map(() => '?').join(', ') : null;
  const whereScope = idList !== null ? ` WHERE workspace_id IN (${idList})` : '';
  const params = idList !== null ? [...wsIds] : [];

  // Re-mint the epoch only where a stream actually exists (epoch not null), mirroring remintEpoch.
  const streams = db
    .prepare(`SELECT workspace_id AS wid FROM sync_publish_state${whereScope}${whereScope ? ' AND' : ' WHERE'} epoch IS NOT NULL`)
    .all(...params) as { wid: string }[];
  const remint = db.prepare('UPDATE sync_publish_state SET epoch = ? WHERE workspace_id = ?');
  for (const s of streams) remint.run(ids.next('epoch'), s.wid);

  // Force publishing OFF unconditionally across the scope (a copy is never primed to egress).
  const off = db.prepare(`UPDATE sync_publish_state SET publishing = 0${whereScope}`).run(...params);

  return { workspacesReset: off.changes, epochsReminted: streams.length };
}
