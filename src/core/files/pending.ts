/**
 * N02 (D183), PENDING FILES: a receipt stored for a Vorschlag that is still waiting.
 *
 * WHY A FILE IS STORED BEFORE THE ACT IS APPROVED. A drafted act replays its stored payload exactly, and
 * the path the agent named (`sourcePath`) may be gone by the time a person approves (a chat client
 * cleans its uploads), so the bytes are taken ONCE, at draft time, and the payload is rewritten to the
 * pending file's id.
 *
 * WHY IT IS NOT A `stored_file` ROW (critic F2). A pending file must be inert until its approval: the
 * first build made it a `stored_file` row and filtered it out of E00's own reads, and the critic found
 * the doors that read `stored_file` raw (a sign request, an expense receipt, a portal grant) accepting
 * it, after which the sweep met a foreign key and every later draft failed with it. A filter every
 * reader must remember is an enumeration; this is a chokepoint instead. The bytes sit in the blob store,
 * the metadata in `stored_file_pending`, and the `stored_file` row is born only at release
 * (`releasePendingFile`, inside the approved act). Nothing can name a pending file by id before that,
 * so nothing can hold a reference the sweep would trip over.
 *
 * WHY A SWEEP. A Vorschlag that is rejected, replaced (`ersetzt`) or voided as stale never runs, and its
 * file would otherwise be a blob nobody can reach. `sweepPendingFiles` deletes every pending file whose
 * Vorschlag is no longer pending, on the scheduler tick and opportunistically before each new draft. A
 * row it cannot erase is skipped and reported, never thrown into the caller's transaction.
 */

import type { WorkspaceContext } from '../context.js';
import { erasePendingFile, storePendingFile, type PendingFileRow } from './files.js';

export type PendingRow = PendingFileRow;

/** The pending row of an id, or undefined when it is not a pending file of this workspace. */
export function pendingRowOf(ctx: WorkspaceContext, fileId: string): PendingRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM stored_file_pending WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, fileId) as PendingRow | undefined;
}

/** Every file waiting on one Vorschlag, oldest first. */
export function pendingFilesOf(ctx: WorkspaceContext, actionId: string): PendingRow[] {
  return ctx.store.db
    .prepare('SELECT * FROM stored_file_pending WHERE workspace_id = ? AND action_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(ctx.workspaceId, actionId) as PendingRow[];
}

/**
 * Store bytes as a PENDING file (inside the caller's transaction). `actionId` may be null only while the
 * draft's own transaction has not minted its Vorschlag yet (`bindPending` follows).
 */
export function storePendingBytes(
  ctx: WorkspaceContext,
  bytes: Buffer,
  meta: { filename: string; title: string; mime: string },
  binding: { actionId: string | null; source: 'draft' | 'drop' },
): ReturnType<typeof storePendingFile> {
  return storePendingFile(ctx, bytes, meta, binding);
}

/** Bind pending files to the Vorschlag the draft minted (or re-minted after a stale void). */
export function bindPending(ctx: WorkspaceContext, fileIds: readonly string[], actionId: string): void {
  const stmt = ctx.store.db.prepare('UPDATE stored_file_pending SET action_id = ? WHERE workspace_id = ? AND id = ?');
  for (const fileId of fileIds) stmt.run(actionId, ctx.workspaceId, fileId);
}

/**
 * Critic F8: the files DROPPED onto a Vorschlag follow it when it is replaced: a stale re-mint of the same
 * key, or a D177 successor for the same bank line. Without this they stay bound to the dead Vorschlag and
 * the sweep deletes the receipt the person dropped.
 */
export function rebindDropped(ctx: WorkspaceContext, fromActionIds: readonly string[], toActionId: string): number {
  let moved = 0;
  const stmt = ctx.store.db.prepare("UPDATE stored_file_pending SET action_id = ? WHERE workspace_id = ? AND action_id = ? AND source = 'drop'");
  for (const from of fromActionIds) {
    if (from === toActionId) continue;
    moved += stmt.run(toActionId, ctx.workspaceId, from).changes;
  }
  return moved;
}

/** What one sweep did. `skipped` names a row it could not erase (reported, never thrown). */
export interface SweepReport {
  erased: number;
  skipped: { fileId: string; reason: string }[];
}

/**
 * Delete every pending file of this workspace whose Vorschlag is no longer pending (rejected, replaced,
 * stale, executed without consuming it, or gone), and any row left unbound by a draft that never
 * committed. Each erasure runs in its own savepoint: a row that fails is skipped and reported, and the
 * sweep NEVER throws into its caller (it runs inside every attach draft). Idempotent.
 */
export function sweepPendingFiles(ctx: WorkspaceContext): SweepReport {
  const report: SweepReport = { erased: 0, skipped: [] };
  let orphans: { id: string }[];
  try {
    orphans = ctx.store.db
      .prepare(
        `SELECT p.id FROM stored_file_pending p
          WHERE p.workspace_id = ?
            AND (p.action_id IS NULL
                 OR NOT EXISTS (SELECT 1 FROM agent_action a
                                 WHERE a.workspace_id = p.workspace_id AND a.id = p.action_id AND a.status = 'pending'))`,
      )
      .all(ctx.workspaceId) as { id: string }[];
  } catch (e) {
    report.skipped.push({ fileId: '*', reason: e instanceof Error ? e.message : String(e) });
    return report;
  }
  for (const { id } of orphans) {
    try {
      if (ctx.store.tx(() => erasePendingFile(ctx, id))) report.erased += 1;
    } catch (e) {
      report.skipped.push({ fileId: id, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}
