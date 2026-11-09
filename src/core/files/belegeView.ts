/**
 * N02 (D183, critic round 2): WHICH Belege a Vorschlag will link when it is approved, so the person who
 * decides sees them first. Approving `attach` locks a receipt for ten years (OR 958f); approving it blind
 * was the defect.
 *
 * A Vorschlag's Belege are: the files its payload names (`attach: [{fileId}]`), pending or already
 * filed, in payload order; then every file DROPPED onto it through a drop link (pending, bound to it).
 * Metadata only, no bytes: the bytes are `files_pending_preview`, which only a seat that may decide the
 * Vorschlag can read.
 *
 * A LEAF: plain SQL over the store, no Node imports, so the agent module (`draftedActions.ts`) can carry
 * the list on every Vorschlag it lists.
 */

import type { WorkspaceContext } from '../context.js';

export interface VorschlagBeleg {
  fileId: string;
  filename: string;
  mime: string;
  bytes: number;
  sha256: string;
  /** `draft`: stored when the agent proposed; `drop`: a person dropped it; `filed`: an existing file it names. */
  source: 'draft' | 'drop' | 'filed';
  /** Still waiting (not a filed `stored_file` row until the approval releases it). */
  pending: boolean;
}

interface PendingMeta {
  id: string;
  filename: string;
  mime: string;
  bytes: number;
  sha256: string;
  source: 'draft' | 'drop';
  action_id: string | null;
}

function attachIds(attach: unknown): string[] {
  if (!Array.isArray(attach)) return [];
  const out: string[] = [];
  for (const entry of attach) {
    const id = typeof entry === 'object' && entry !== null ? (entry as { fileId?: unknown }).fileId : undefined;
    if (typeof id === 'string' && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The Belege the approval of `actionId` will link (see the module note). Tenant-scoped. */
export function vorschlagBelege(ctx: WorkspaceContext, actionId: string, payloadAttach: unknown): VorschlagBeleg[] {
  const out: VorschlagBeleg[] = [];
  const seen = new Set<string>();
  const pendingStmt = ctx.store.db.prepare('SELECT id, filename, mime, bytes, sha256, source, action_id FROM stored_file_pending WHERE workspace_id = ? AND id = ?');
  const filedStmt = ctx.store.db.prepare('SELECT id, filename, mime, bytes, sha256 FROM stored_file WHERE workspace_id = ? AND id = ?');
  for (const id of attachIds(payloadAttach)) {
    const pending = pendingStmt.get(ctx.workspaceId, id) as PendingMeta | undefined;
    if (pending !== undefined) {
      // Only this Vorschlag's own pending file; another's reads as nothing.
      if (pending.action_id !== actionId) continue;
      out.push({ fileId: pending.id, filename: pending.filename, mime: pending.mime, bytes: pending.bytes, sha256: pending.sha256, source: pending.source, pending: true });
      seen.add(pending.id);
      continue;
    }
    const filed = filedStmt.get(ctx.workspaceId, id) as Omit<PendingMeta, 'source' | 'action_id'> | undefined;
    if (filed !== undefined) {
      out.push({ fileId: filed.id, filename: filed.filename, mime: filed.mime, bytes: filed.bytes, sha256: filed.sha256, source: 'filed', pending: false });
      seen.add(filed.id);
    }
  }
  const dropped = ctx.store.db
    .prepare('SELECT id, filename, mime, bytes, sha256, source, action_id FROM stored_file_pending WHERE workspace_id = ? AND action_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(ctx.workspaceId, actionId) as PendingMeta[];
  for (const p of dropped) {
    if (seen.has(p.id)) continue;
    out.push({ fileId: p.id, filename: p.filename, mime: p.mime, bytes: p.bytes, sha256: p.sha256, source: p.source, pending: true });
  }
  return out;
}
