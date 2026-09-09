/**
 * M02: the publish DIAL and the outbox backfill. The write half of the contract.
 *
 * `enableSyncPublish` / `disableSyncPublish` are the two owner-gated toggles (A24 `manage_sync`).
 * Enabling is the CONSENT act: publishing is default OFF (a local install publishes nothing), and a
 * workspace owner turning it on is what starts any egress at all. Both are on G01's `NOT_AUTOMATABLE`
 * denylist: a stored rule may not flip the switch that governs whether the ledger leaves the machine.
 *
 * THE OUTBOX IS FED TWO WAYS, and both stamp the SAME `epoch` (read from `sync_publish_state`):
 *  - FUTURE posts: the `sync_outbox_on_post` trigger (schema.ts), inside the fact's own transaction.
 *  - PAST posts, at the moment publishing turns on: `backfillJournal` here, so a workspace that
 *    enabled publishing after it already had history publishes a COMPLETE stream, not just the tail.
 *    The backfill is idempotent on rows (`NOT EXISTS` against the unique fact key), so re-enabling, or
 *    enabling a workspace some of whose entries are already published, adds each fact exactly once.
 *
 * `seq` is assigned MAX+1 per workspace, in `created_at, id` order, which is the same chronological
 * order the trigger appends future posts in, so the merged stream stays monotonic. Everything here
 * runs inside `rememberIdempotent`'s transaction (§H-IDEMPOTENT), so a crash mid-backfill leaves
 * neither the dial flipped nor a partial backfill.
 */

import type { WorkspaceContext } from '../context.js';
import { ok } from '../result.js';
import type { Result } from '../result.js';
import { requireString } from '../ledger/inputGuards.js';
import { CONTRACT_VERSION, STREAM_KINDS, PAYLOAD_SCHEMAS } from './contract.js';

export interface SyncDialInput {
  // The tenant is on the ctx (§H-TENANT), not the input, exactly as `PostEntryInput` omits it. The
  // registry passes the whole request object through, workspaceId included; the engine reads it off
  // the ctx it was handed.
  idempotencyKey: string;
}

interface StateRow {
  publishing: number;
  epoch: string | null;
  contract_version: string | null;
}

/** The workspace's publish state, or undefined when it has never been touched. */
export function readPublishState(ctx: WorkspaceContext): StateRow | undefined {
  return ctx.store.db
    .prepare('SELECT publishing, epoch, contract_version FROM sync_publish_state WHERE workspace_id = ?')
    .get(ctx.workspaceId) as StateRow | undefined;
}

/** The current head sequence for this workspace (0 when nothing has been published). */
export function headSeqOf(ctx: WorkspaceContext): number {
  const row = ctx.store.db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS head FROM sync_outbox WHERE workspace_id = ?')
    .get(ctx.workspaceId) as { head: number };
  return row.head;
}

/**
 * Publish every posted entry this workspace holds that is not already in the outbox, in chronological
 * order, each assigned the next gapless `seq`. Idempotent: `NOT EXISTS` skips facts already published,
 * so a second call adds nothing. §H-TENANT: fenced to `ctx.workspaceId` on both the source and the
 * outbox. The payload is NOT materialised here (it is projected from the immutable entry at read),
 * so this writes only the envelope index.
 */
function backfillJournal(ctx: WorkspaceContext, epoch: string): void {
  const { db } = ctx.store;
  const pending = db
    .prepare(
      `SELECT je.id AS id, je.created_at AS created_at, je.created_by AS created_by
         FROM journal_entry je
        WHERE je.workspace_id = ?
          AND je.status = 'posted'
          AND NOT EXISTS (
            SELECT 1 FROM sync_outbox o
             WHERE o.workspace_id = je.workspace_id
               AND o.kind = ?
               AND o.source_ref = je.id
          )
        ORDER BY je.created_at, je.id`,
    )
    .all(ctx.workspaceId, STREAM_KINDS.JOURNAL_POSTED) as {
    id: string;
    created_at: string;
    created_by: string | null;
  }[];

  const insert = db.prepare(
    `INSERT INTO sync_outbox
       (workspace_id, seq, epoch, occurred_at, actor, kind, source_ref, payload_schema, artifact_sha256, produced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  );
  let seq = headSeqOf(ctx) + 1;
  for (const row of pending) {
    insert.run(
      ctx.workspaceId,
      seq,
      epoch,
      row.created_at,
      row.created_by ?? 'system',
      STREAM_KINDS.JOURNAL_POSTED,
      row.id,
      PAYLOAD_SCHEMAS[STREAM_KINDS.JOURNAL_POSTED],
      row.created_at,
    );
    seq += 1;
  }
}

/**
 * Turn publishing ON. Mints the stream `epoch` the FIRST time (kept across later toggles), records
 * the consent stamp, and backfills the existing history so the stream is complete. Idempotent by
 * `idempotencyKey`; re-enabling is a safe no-op that re-asserts the ON state.
 */
export function enableSyncPublish(ctx: WorkspaceContext, input: SyncDialInput): Result {
  const guard = requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'sync_publish_enable', () => {
    const existing = readPublishState(ctx);
    // The epoch is minted once and then carried across enable/disable toggles unchanged: only a G04
    // restore (`remintEpoch`) ever changes it, which is what lets a consumer tell a toggle apart from
    // a forked history.
    const epoch = existing?.epoch ?? ctx.ids.next('epoch');
    const at = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO sync_publish_state (workspace_id, publishing, epoch, contract_version, enabled_at, enabled_by)
         VALUES (?, 1, ?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
           publishing = 1,
           epoch = COALESCE(sync_publish_state.epoch, excluded.epoch),
           contract_version = excluded.contract_version,
           enabled_at = excluded.enabled_at,
           enabled_by = excluded.enabled_by`,
      )
      .run(ctx.workspaceId, epoch, CONTRACT_VERSION, at, ctx.actor);

    backfillJournal(ctx, epoch);

    ctx.audit.record({
      entityKind: 'sync',
      entityId: ctx.workspaceId,
      action: 'enable',
      actor: ctx.actor,
      at,
    });

    return ok({
      publishing: true,
      contractVersion: CONTRACT_VERSION,
      epoch,
      headSeq: headSeqOf(ctx),
    });
  });
}

/**
 * Turn publishing OFF. Stops appends (the trigger's `WHEN` clause goes false) and revokes stream
 * visibility (`readSyncStream` refuses `publishing_disabled`), but the outbox rows REMAIN, append-only,
 * for audit: nothing here deletes a published fact. The epoch is untouched, so re-enabling resumes the
 * same stream. This is the stop button, so it is deliberately cheap.
 */
export function disableSyncPublish(ctx: WorkspaceContext, input: SyncDialInput): Result {
  const guard = requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'sync_publish_disable', () => {
    const at = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO sync_publish_state (workspace_id, publishing, epoch, contract_version, enabled_at, enabled_by)
         VALUES (?, 0, NULL, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET publishing = 0`,
      )
      .run(ctx.workspaceId, CONTRACT_VERSION, at, ctx.actor);

    ctx.audit.record({
      entityKind: 'sync',
      entityId: ctx.workspaceId,
      action: 'disable',
      actor: ctx.actor,
      at,
    });

    return ok({ publishing: false });
  });
}

/**
 * The G04-restore seam: re-mint the stream epoch. A restore re-mints ids and so forks the history a
 * consumer had been following; re-minting the epoch is what makes that fork VISIBLE, so a stale cursor
 * gets `cursor_reset_required` (with the new epoch) instead of silently reading mismatched history.
 *
 * It is deliberately NOT an MCP verb: it is an internal seam the restore path calls (like
 * `deriveStatutoryOnPost` on the posting path), not an agent-reachable action. Idempotent shape: it
 * always sets a fresh epoch on a publishing workspace and returns it; a workspace that never published
 * has no stream to re-mint and is left untouched.
 */
export function remintEpoch(ctx: WorkspaceContext): Result {
  const state = readPublishState(ctx);
  if (state === undefined || state.epoch === null) {
    return ok({ reminted: false });
  }
  const epoch = ctx.ids.next('epoch');
  ctx.store.db
    .prepare('UPDATE sync_publish_state SET epoch = ? WHERE workspace_id = ?')
    .run(epoch, ctx.workspaceId);
  return ok({ reminted: true, epoch });
}
