/**
 * M02's six §I contract verbs, defined here and spread into `ACTIONS` as ONE line (the `fxActions` /
 * `deliveryActions` precedent), so several agents appending to the append-only registry at once
 * collide over a line rather than a block.
 *
 * TWO WRITES, the owner dials: `sync_publish_enable` / `sync_publish_disable`, gated `manage_sync`,
 * on G01's `NOT_AUTOMATABLE` denylist (a stored rule may not flip egress). FOUR READS: `get_sync_contract`
 * (visible to any member, it reports the posture the Settings panel + E07 trust line show),
 * `sync_stream_read` / `sync_artifact_read` / `sync_stream_status` (the integration surface, gated
 * `sync.read`, so a plain member does not see the raw stream by default).
 *
 * The inbound lane is NOT here: cloud-originated facts land through EXISTING verbs (record_payment,
 * mirrorEbillPartnerStatus, bank_sync), reached exactly as any other caller reaches them. This module
 * mints no posting path and no second writer, which is the whole point of the contract.
 *
 * The helpers arrive as a parameter rather than an import, so the module graph stays acyclic:
 * `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  getSyncContract,
  enableSyncPublish,
  disableSyncPublish,
  readSyncStream,
  readSyncArtifact,
  syncStreamStatus,
} from '../core/sync/index.js';

export interface SyncActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
}

/** The A24 capability gating the two publish dials (owner). */
export const MANAGE_SYNC = 'manage_sync';
/** The A24 capability gating the raw stream reads (an integration surface, not a reporting one). */
export const SYNC_READ = 'sync.read';

export function syncActions(h: SyncActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT } = h;
  const CURSOR = { type: 'object' } as const;

  return [
    ctxAction(
      'get_sync_contract',
      'read',
      'Describe the till-sync publish contract for this workspace: the contract majors this build speaks, whether publishing is on, the current stream head and epoch, and the §I sole-writer / one-file-per-tenant posture. Pass contractVersion to negotiate: an unknown major is refused (unsupported_contract) rather than best-effort parsed.',
      ctxSchema({ contractVersion: STR }),
      (ctx, input) => getSyncContract(ctx, input as never),
    ),
    ctxAction(
      'sync_publish_enable',
      'write',
      'Turn the till-sync publish stream ON for this workspace (owner dial, default OFF: a local install publishes nothing). Enabling is the consent act for any egress; it mints the stream epoch once and backfills existing posted history so the stream is complete. Reversible with sync_publish_disable.',
      ctxSchema({ idempotencyKey: STR }, ['idempotencyKey']),
      (ctx, input) => enableSyncPublish(ctx, input as never),
    ),
    ctxAction(
      'sync_publish_disable',
      'write',
      'Turn the till-sync publish stream OFF for this workspace. Stops new appends and refuses stream reads (publishing_disabled), but the already-published outbox rows remain, append-only, for audit; the epoch is kept so re-enabling resumes the same stream. The stop button.',
      ctxSchema({ idempotencyKey: STR }, ['idempotencyKey']),
      (ctx, input) => disableSyncPublish(ctx, input as never),
    ),
    ctxAction(
      'sync_stream_read',
      'read',
      'Read the append-only publish stream from a consumer-held cursor {seq, epoch}, up to limit events, with the current headSeq so you know your lag. At-least-once: a re-read from the same cursor is always safe. A cursor beyond the head is invalid_cursor; a cursor from a superseded epoch (after a restore) is cursor_reset_required. Requires publishing to be on and the sync.read capability.',
      ctxSchema({ cursor: CURSOR, limit: INT, contractVersion: STR }),
      (ctx, input) => readSyncStream(ctx, input as never),
    ),
    ctxAction(
      'sync_artifact_read',
      'read',
      'Resolve a published artifact.* handle by its content hash (sha256), returning the stable reference the blob is addressed by. The stream carries handles, never inline bytes; the blob itself is fetched from the content store the runtime binds. A hash that is not a published handle in this workspace is artifact_not_found. Requires the sync.read capability.',
      ctxSchema({ sha256: STR }, ['sha256']),
      (ctx, input) => readSyncArtifact(ctx, input as never),
    ),
    ctxAction(
      'sync_stream_status',
      'read',
      'The monitoring read: whether publishing is on, the stream head and epoch, and (when you pass your cursor) the lag = head - cursor.seq. Operational metadata only, no tenant rows. Requires the sync.read capability.',
      ctxSchema({ cursor: { type: 'object' } }),
      (ctx, input) => syncStreamStatus(ctx, input as never),
    ),
  ];
}
