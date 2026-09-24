/**
 * H05, the Asset Transfer & Location engine: a workspace-scoped location master (create / update /
 * soft-archive / list / get) and the non-posting transfer that moves one or many assets between
 * locations and/or responsible persons, recording an append-only history row per asset.
 *
 * NON-POSTING BY DESIGN (spec §1/§4). A transfer changes only the sub-ledger: the asset's
 * `location_id` / `responsible_user_id` convenience columns and one immutable `asset_transfer` row per
 * asset. It NEVER touches a financial field (cost, accumulated depreciation, NBV, the three GL
 * accounts) and NEVER posts a General-Ledger journal. The "no journal" guarantee is structural: the
 * `asset_transfer` table has no `journal_entry_id` column (transferSchema.ts), and this module imports
 * neither `postEntry` nor any A02 verb, so no call path can create one. The DoD tripwire asserts the
 * journal-entry and asset_transaction row counts are unchanged across a transfer.
 *
 * Every read and write is scoped to `ctx.workspaceId` (§H-TENANT): a foreign asset or location id
 * resolves to undefined, never to its row, so a cross-workspace read is a `not_found` and a
 * cross-workspace write is impossible. Validation runs BEFORE any write and returns a structured `err`
 * (P9); only the write itself is wrapped in `rememberIdempotent`, so a rejected transfer writes
 * nothing and a replay of the same idempotency key returns the original result and adds no rows
 * (§H-IDEMPOTENT, idempotent on ROWS).
 *
 * FILE OWNERSHIP: H05 owns this module and `transferSchema.ts`. It UPDATEs the H01 `asset` table's two
 * descriptive tracking columns (which H01 declares editable on any non-terminal asset) but never edits
 * `master.ts` / `masterSchema.ts`: writing those columns from here is the H02 acquisition precedent
 * (acquisition.ts UPDATEs the asset from its own file), not a change to H01's engine.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';

/** An ISO calendar date `YYYY-MM-DD`, the shape the asset dates already use. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The asset statuses a transfer is allowed on. `disposed` / `archived` are terminal and refused. */
const TRANSFERABLE_STATUSES: ReadonlySet<string> = new Set(['draft', 'active', 'fully_depreciated']);

const MAX_CODE_LEN = 30;

interface LocationRow {
  id: string;
  workspace_id: string;
  code: string;
  name: string;
  description: string | null;
  parent_id: string | null;
  active: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

interface TransferRow {
  id: string;
  workspace_id: string;
  asset_id: string;
  date: string;
  from_location_id: string | null;
  to_location_id: string | null;
  from_responsible_user_id: string | null;
  to_responsible_user_id: string | null;
  description: string | null;
  bulk_id: string | null;
  created_at: string;
  created_by: string | null;
  idempotency_key: string | null;
}

interface AssetTrackingRow {
  id: string;
  status: string;
  location_id: string | null;
  responsible_user_id: string | null;
}

function mapLocation(row: LocationRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    code: row.code,
    name: row.name,
    description: row.description,
    parentId: row.parent_id,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

function mapTransfer(row: TransferRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    assetId: row.asset_id,
    date: row.date,
    fromLocationId: row.from_location_id,
    toLocationId: row.to_location_id,
    fromResponsibleUserId: row.from_responsible_user_id,
    toResponsibleUserId: row.to_responsible_user_id,
    description: row.description,
    bulkId: row.bulk_id,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function readLocation(ctx: WorkspaceContext, id: string): LocationRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM asset_location WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as LocationRow | undefined;
}

/** A location whose lower(code) already exists in this workspace, other than `exceptId`. The friendly
 * half of the case-insensitive uniqueness the DB index enforces underneath. */
function codeTaken(ctx: WorkspaceContext, code: string, exceptId?: string): boolean {
  const row = ctx.store.db
    .prepare(
      'SELECT id FROM asset_location WHERE workspace_id = ? AND lower(code) = lower(?) AND id != ? LIMIT 1',
    )
    .get(ctx.workspaceId, code, exceptId ?? '') as { id: string } | undefined;
  return row !== undefined;
}

/**
 * Would setting `candidateParent` as the parent of `id` create a cycle? Walks the ancestor chain from
 * the candidate upward: if it ever reaches `id`, the link would close a loop. Also stops on a broken
 * chain (a missing ancestor) so a corrupt row can never spin forever. `id` is undefined at create time
 * (a brand-new location cannot yet be its own ancestor), so only update needs the self-check.
 */
function wouldCycle(ctx: WorkspaceContext, id: string | undefined, candidateParent: string): boolean {
  let cursor: string | undefined = candidateParent;
  const seen = new Set<string>();
  while (cursor !== undefined) {
    if (cursor === id) return true;
    if (seen.has(cursor)) return true; // a pre-existing loop upstream: refuse rather than hang.
    seen.add(cursor);
    const row = ctx.store.db
      .prepare('SELECT parent_id FROM asset_location WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, cursor) as { parent_id: string | null } | undefined;
    if (row === undefined) return false;
    cursor = row.parent_id ?? undefined;
  }
  return false;
}

/** Count of non-disposed assets still pointing at a location: the in-use guard before archive. A
 * disposed asset keeps its historical location but no longer blocks the archive (§2/US-H05.5). */
function locationReferencedByLiveAsset(ctx: WorkspaceContext, locationId: string): boolean {
  const row = ctx.store.db
    .prepare(
      "SELECT id FROM asset WHERE workspace_id = ? AND location_id = ? AND status != 'disposed' LIMIT 1",
    )
    .get(ctx.workspaceId, locationId) as { id: string } | undefined;
  return row !== undefined;
}

// ── Location master ──────────────────────────────────────────────────────────────────────────────

export interface CreateAssetLocationInput {
  code?: string;
  name?: string;
  description?: string | null;
  parentId?: string | null;
  idempotencyKey?: string;
}

export function createAssetLocation(ctx: WorkspaceContext, input: CreateAssetLocationInput): Result {
  // Replay a completed create BEFORE the duplicate-code guard (§H-IDEMPOTENT), the H00 order.
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'asset_location_create');
    if (replayed !== undefined) return replayed;
  }

  const code = typeof input.code === 'string' ? input.code.trim() : '';
  if (code.length === 0 || code.length > MAX_CODE_LEN) return err('invalid_input', { field: 'code' });
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0) return err('invalid_input', { field: 'name' });
  if (codeTaken(ctx, code)) return err('duplicate_code', { code });

  let parentId: string | null = null;
  if (typeof input.parentId === 'string' && input.parentId.length > 0) {
    const parent = readLocation(ctx, input.parentId);
    if (parent === undefined) return err('not_found', { parentId: input.parentId });
    parentId = parent.id;
  }

  const run = (): Result => {
    // Re-check inside the transaction: the DB UNIQUE index over lower(code) is the honest race guard;
    // this narrows the window and keeps the friendly error.
    if (codeTaken(ctx, code)) return err('duplicate_code', { code });
    const id = ctx.ids.next('aloc');
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO asset_location (id, workspace_id, code, name, description, parent_id, active, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(id, ctx.workspaceId, code, name, input.description === '' ? null : input.description ?? null, parentId, now, now, ctx.actor);
    return ok({ location: mapLocation(readLocation(ctx, id) as LocationRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'asset_location_create', run);
  }
  return run();
}

export interface UpdateAssetLocationInput {
  locationId?: string;
  patch?: { name?: string; description?: string | null; parentId?: string | null };
  idempotencyKey?: string;
}

export function updateAssetLocation(ctx: WorkspaceContext, input: UpdateAssetLocationInput): Result {
  if (typeof input.locationId !== 'string' || input.locationId.length === 0) {
    return err('invalid_input', { field: 'locationId' });
  }
  const current = readLocation(ctx, input.locationId);
  if (current === undefined) return err('not_found', { locationId: input.locationId });
  const patch = input.patch ?? {};

  const name = patch.name !== undefined ? String(patch.name).trim() : current.name;
  if (name.length === 0) return err('invalid_input', { field: 'name' });

  // parentId: undefined leaves it, null/'' clears to root, an id sets it (with cycle + tenant checks).
  let parentId: string | null = current.parent_id;
  if (patch.parentId !== undefined) {
    if (patch.parentId === null || patch.parentId === '') {
      parentId = null;
    } else {
      const wanted = String(patch.parentId);
      if (wanted === current.id) return err('location_cycle', { locationId: current.id });
      const parent = readLocation(ctx, wanted);
      if (parent === undefined) return err('not_found', { parentId: wanted });
      if (wouldCycle(ctx, current.id, wanted)) return err('location_cycle', { locationId: current.id, parentId: wanted });
      parentId = parent.id;
    }
  }

  const description =
    patch.description === undefined
      ? current.description
      : patch.description === '' || patch.description === null
        ? null
        : String(patch.description);

  const run = (): Result => {
    ctx.store.db
      .prepare(
        `UPDATE asset_location SET name = ?, description = ?, parent_id = ?, updated_at = ?
           WHERE workspace_id = ? AND id = ?`,
      )
      .run(name, description, parentId, ctx.clock.now(), ctx.workspaceId, input.locationId);
    return ok({ location: mapLocation(readLocation(ctx, input.locationId as string) as LocationRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'asset_location_update', run);
  }
  return run();
}

export function archiveAssetLocation(
  ctx: WorkspaceContext,
  input: { locationId?: string; idempotencyKey?: string },
): Result {
  if (typeof input.locationId !== 'string' || input.locationId.length === 0) {
    return err('invalid_input', { field: 'locationId' });
  }
  const run = (): Result => {
    const current = readLocation(ctx, input.locationId as string);
    if (current === undefined) return err('not_found', { locationId: input.locationId });
    // A location still referenced by a non-disposed asset cannot be archived (§2/US-H05.5): archiving
    // it would strand assets pointing at a location that has left the picker.
    if (current.active === 1 && locationReferencedByLiveAsset(ctx, current.id)) {
      return err('location_in_use', { locationId: current.id });
    }
    if (current.active !== 0) {
      ctx.store.db
        .prepare('UPDATE asset_location SET active = 0, updated_at = ? WHERE workspace_id = ? AND id = ?')
        .run(ctx.clock.now(), ctx.workspaceId, input.locationId);
    }
    return ok({ location: mapLocation(readLocation(ctx, input.locationId as string) as LocationRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'asset_location_archive', run);
  }
  return run();
}

export interface ListAssetLocationInput {
  active?: boolean;
  parentId?: string | null;
  search?: string;
  /** G00 saved-view seam: accepted so a saved view can carry the location list's filters. */
  savedViewId?: string;
}

export function listAssetLocation(ctx: WorkspaceContext, input: ListAssetLocationInput = {}): Result {
  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (input.active === true) clauses.push('active = 1');
  else if (input.active === false) clauses.push('active = 0');
  if (input.parentId === null) {
    clauses.push('parent_id IS NULL');
  } else if (typeof input.parentId === 'string' && input.parentId.length > 0) {
    clauses.push('parent_id = ?');
    params.push(input.parentId);
  }
  if (typeof input.search === 'string' && input.search.trim().length > 0) {
    clauses.push('(lower(code) LIKE ? OR lower(name) LIKE ?)');
    const like = `%${input.search.trim().toLowerCase()}%`;
    params.push(like, like);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM asset_location WHERE ${clauses.join(' AND ')} ORDER BY code`)
    .all(...params) as LocationRow[];
  return ok({ locations: rows.map(mapLocation), total: rows.length });
}

export function getAssetLocation(ctx: WorkspaceContext, input: { locationId?: string }): Result {
  if (typeof input.locationId !== 'string' || input.locationId.length === 0) {
    return err('invalid_input', { field: 'locationId' });
  }
  const row = readLocation(ctx, input.locationId);
  if (row === undefined) return err('not_found', { locationId: input.locationId });
  return ok({ location: mapLocation(row) });
}

// ── Transfer ───────────────────────────────────────────────────────────────────────────────────

export interface AssetTransferInput {
  assetIds?: string[];
  toLocationId?: string | null;
  toResponsibleUserId?: string | null;
  effectiveDate?: string;
  reason?: string | null;
  idempotencyKey?: string;
}

/**
 * Transfer one or many assets to a new location and/or responsible person. Non-posting: it writes one
 * append-only `asset_transfer` row per asset and updates each asset's two tracking columns, and NOTHING
 * else. All-or-nothing (§2/US-H05.3): every asset is validated first, and if any is not transferable
 * the whole request is refused with `asset_not_transferable` naming the offenders, so a bulk move never
 * half-applies.
 */
export function assetTransfer(ctx: WorkspaceContext, input: AssetTransferInput): Result {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  // Replay a completed transfer BEFORE any state-dependent guard (§H-IDEMPOTENT), so a retry returns
  // the original result rather than re-validating against the state it itself produced.
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'asset_transfer');
  if (replayed !== undefined) return replayed;

  const assetIds = Array.isArray(input.assetIds) ? input.assetIds.filter((x) => typeof x === 'string' && x.length > 0) : [];
  if (assetIds.length === 0) return err('invalid_input', { field: 'assetIds' });
  // De-duplicate while preserving order: the same asset named twice is one move, not two history rows.
  const uniqueIds = [...new Set(assetIds)];

  const date = typeof input.effectiveDate === 'string' ? input.effectiveDate.trim() : '';
  if (date.length === 0 || !ISO_DATE.test(date)) return err('invalid_input', { field: 'effectiveDate' });

  const wantsLocation = typeof input.toLocationId === 'string' && input.toLocationId.length > 0;
  const wantsResponsible = typeof input.toResponsibleUserId === 'string' && input.toResponsibleUserId.length > 0;
  if (!wantsLocation && !wantsResponsible) return err('nothing_to_transfer', {});

  let toLocationId: string | null = null;
  if (wantsLocation) {
    const loc = readLocation(ctx, input.toLocationId as string);
    if (loc === undefined) return err('not_found', { toLocationId: input.toLocationId });
    if (loc.active !== 1) return err('location_inactive', { toLocationId: loc.id });
    toLocationId = loc.id;
  }
  const toResponsibleUserId: string | null = wantsResponsible ? (input.toResponsibleUserId as string) : null;

  // Validate every asset FIRST (all-or-nothing). A foreign id is not_found (§H-TENANT), a disposed or
  // archived asset is asset_not_transferable; both collect their offenders so the caller sees them all.
  const assets: AssetTrackingRow[] = [];
  const missing: string[] = [];
  const notTransferable: { assetId: string; status: string }[] = [];
  for (const id of uniqueIds) {
    const row = ctx.store.db
      .prepare('SELECT id, status, location_id, responsible_user_id FROM asset WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, id) as AssetTrackingRow | undefined;
    if (row === undefined) {
      missing.push(id);
      continue;
    }
    if (!TRANSFERABLE_STATUSES.has(row.status)) {
      notTransferable.push({ assetId: row.id, status: row.status });
      continue;
    }
    assets.push(row);
  }
  if (missing.length > 0) return err('not_found', { assetIds: missing });
  if (notTransferable.length > 0) return err('asset_not_transferable', { assets: notTransferable });

  const isBulk = assets.length > 1;

  const run = (): Result => {
    const now = ctx.clock.now();
    const bulkId = isBulk ? ctx.ids.next('abulk') : null;
    const reason = typeof input.reason === 'string' && input.reason.trim() !== '' ? input.reason.trim() : null;
    const transfers: ReturnType<typeof mapTransfer>[] = [];
    const updatedAssetIds: string[] = [];

    for (const asset of assets) {
      const transferId = ctx.ids.next('atrf');
      // Capture the OLD values before the master is updated: the history row is self-contained.
      ctx.store.db
        .prepare(
          `INSERT INTO asset_transfer (
             id, workspace_id, asset_id, date, from_location_id, to_location_id,
             from_responsible_user_id, to_responsible_user_id, description, bulk_id,
             created_at, created_by, idempotency_key
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          transferId,
          ctx.workspaceId,
          asset.id,
          date,
          asset.location_id,
          wantsLocation ? toLocationId : asset.location_id,
          asset.responsible_user_id,
          wantsResponsible ? toResponsibleUserId : asset.responsible_user_id,
          reason,
          bulkId,
          now,
          ctx.actor,
          input.idempotencyKey,
        );

      // Update ONLY the two tracking columns. Every financial field is left exactly as it was: a
      // transfer moves zero Rappen (§4). `updated_at` moves because the row changed.
      const nextLocation = wantsLocation ? toLocationId : asset.location_id;
      const nextResponsible = wantsResponsible ? toResponsibleUserId : asset.responsible_user_id;
      ctx.store.db
        .prepare('UPDATE asset SET location_id = ?, responsible_user_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
        .run(nextLocation, nextResponsible, now, ctx.workspaceId, asset.id);

      transfers.push(mapTransfer(readTransfer(ctx, transferId) as TransferRow));
      updatedAssetIds.push(asset.id);
    }

    // Return the updated asset snapshots so an agent (or the GUI) sees the result without a re-read.
    const updatedAssets = updatedAssetIds.map((id) => {
      const row = ctx.store.db
        .prepare(
          'SELECT id, number, name, status, location_id, responsible_user_id FROM asset WHERE workspace_id = ? AND id = ?',
        )
        .get(ctx.workspaceId, id) as {
        id: string;
        number: string;
        name: string;
        status: string;
        location_id: string | null;
        responsible_user_id: string | null;
      };
      return {
        id: row.id,
        number: row.number,
        name: row.name,
        status: row.status,
        locationId: row.location_id,
        responsibleUserId: row.responsible_user_id,
      };
    });

    return ok({
      transactions: transfers,
      assets: updatedAssets,
      summary: { transferred: transfers.length, failed: 0 },
    });
  };

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'asset_transfer', run);
}

function readTransfer(ctx: WorkspaceContext, id: string): TransferRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM asset_transfer WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as TransferRow | undefined;
}

export function assetTransferHistory(ctx: WorkspaceContext, input: { assetId?: string }): Result {
  if (typeof input.assetId !== 'string' || input.assetId.length === 0) {
    return err('invalid_input', { field: 'assetId' });
  }
  const rows = ctx.store.db
    .prepare('SELECT * FROM asset_transfer WHERE workspace_id = ? AND asset_id = ? ORDER BY date, created_at, id')
    .all(ctx.workspaceId, input.assetId) as TransferRow[];
  return ok({ transfers: rows.map(mapTransfer), total: rows.length });
}
