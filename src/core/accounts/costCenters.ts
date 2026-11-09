/**
 * A01 cost centres (Kostenstellen). Create, archive, and delete; a cost centre that any posted line
 * references is never deleted (it archives), mirroring account deletion.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { requireString } from '../ledger/inputGuards.js';
import { applySavedView } from '../customization/views.js';

interface CostCenterRow {
  id: string;
  workspace_id: string;
  code: string;
  name: string;
  archived: number;
}

function mapCostCenter(row: CostCenterRow) {
  return { id: row.id, workspaceId: row.workspace_id, code: row.code, name: row.name, archived: row.archived === 1 };
}

export function createCostCenter(
  ctx: WorkspaceContext,
  input: { code: string; name: string; idempotencyKey?: string },
): Result {
  const guard = requireString(input.code, 'code') ?? requireString(input.name, 'name');
  if (guard) return guard;

  // Replay a completed create BEFORE the duplicate guard (§H-IDEMPOTENT), the same order postEntry
  // uses. Without it the guard fires on the cost centre the first call wrote and a plain retry came
  // back as `duplicate_code`.
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'create_cost_center');
    if (replayed !== undefined) return replayed;
  }

  const existing = ctx.store.db
    .prepare('SELECT id FROM cost_center WHERE workspace_id = ? AND code = ?')
    .get(ctx.workspaceId, input.code) as { id: string } | undefined;
  if (existing !== undefined) return err('duplicate_code', { code: input.code });

  const run = (): Result => {
    const id = ctx.ids.next('cc');
    ctx.store.db
      .prepare('INSERT INTO cost_center (id, workspace_id, code, name) VALUES (?, ?, ?, ?)')
      .run(id, ctx.workspaceId, input.code, input.name);
    return ok({ costCenterId: id });
  };
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'create_cost_center', run);
  }
  return run();
}

export function archiveCostCenter(ctx: WorkspaceContext, input: { costCenterId: string }): Result {
  const guard = requireString(input.costCenterId, 'costCenterId');
  if (guard) return guard;
  const result = ctx.store.db
    .prepare('UPDATE cost_center SET archived = 1 WHERE workspace_id = ? AND id = ?')
    .run(ctx.workspaceId, input.costCenterId);
  if (result.changes === 0) return err('not_found', { costCenterId: input.costCenterId });
  return ok();
}

export function unarchiveCostCenter(ctx: WorkspaceContext, input: { costCenterId: string }): Result {
  const guard = requireString(input.costCenterId, 'costCenterId');
  if (guard) return guard;
  const result = ctx.store.db
    .prepare('UPDATE cost_center SET archived = 0 WHERE workspace_id = ? AND id = ?')
    .run(ctx.workspaceId, input.costCenterId);
  if (result.changes === 0) return err('not_found', { costCenterId: input.costCenterId });
  return ok();
}

export function deleteCostCenter(ctx: WorkspaceContext, input: { costCenterId: string }): Result {
  const guard = requireString(input.costCenterId, 'costCenterId');
  if (guard) return guard;

  const used = ctx.store.db
    .prepare('SELECT COUNT(*) AS c FROM journal_line WHERE cost_center_id = ?')
    .get(input.costCenterId) as { c: number };
  if (used.c > 0) return err('cost_center_in_use', { costCenterId: input.costCenterId });

  ctx.store.db.prepare('DELETE FROM cost_center WHERE workspace_id = ? AND id = ?').run(ctx.workspaceId, input.costCenterId);
  return ok();
}

export function listCostCenters(
  ctx: WorkspaceContext,
  filter: { includeArchived?: boolean; savedViewId?: string } = {},
): Result {
  // The G00 seam, one unconditional call, exactly as `listDocuments` makes it (F5 retrofit).
  const viewed = applySavedView(ctx, 'cost_center', filter);
  if (!viewed.ok) return viewed;
  filter = viewed.filter;
  const clauses = ['workspace_id = ?'];
  if (!filter.includeArchived) clauses.push('archived = 0');
  // `in_use` for the same reason as listAccounts: the GUI's Archive-XOR-Delete needs the truth
  // per row, and a missing flag silently selects the destructive path.
  const rows = ctx.store.db
    .prepare(
      `SELECT cost_center.*, EXISTS(SELECT 1 FROM journal_line WHERE journal_line.cost_center_id = cost_center.id) AS in_use
       FROM cost_center WHERE ${clauses.join(' AND ')} ORDER BY code`,
    )
    .all(ctx.workspaceId) as (CostCenterRow & { in_use: number })[];
  return ok({ costCenters: rows.map((row) => ({ ...mapCostCenter(row), inUse: row.in_use === 1 })) });
}
