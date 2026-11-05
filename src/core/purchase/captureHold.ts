/**
 * N02 (D183, critic F1): a Beleg ohne Buchung that a BOOKING took.
 *
 * A31's queue holds a receipt as a capture whose document is an unlinked E00 file. When an act's
 * `attach` (or a drop) resolves a receipt to that very file, two things used to go wrong at once: the
 * capture stayed in the queue as if nothing had booked it, and a later `capture_commit` re-linked its
 * document to a new vendor bill, which MOVES the Beleg off the posted entry (a file has one primary
 * link) and books the same receipt a second time.
 *
 * So the document of a capture still under review counts as HELD by that capture: the booking links a
 * second filing row over the same bytes (the attach seam), and, under `files.capture_on_attach = close`
 * (the default), the capture is closed as booked here: `committed`, with no A31 target of its own, and
 * one `capture_settlement` row naming the record that booked it. `capture_commit` then refuses it
 * (`invalid_state`), and it leaves "Belege ohne Buchung". `keep` leaves it waiting.
 *
 * A LEAF: it imports nothing from `../files/`, so the attach seam can reach it without a module cycle
 * (`capture.ts` imports the files barrel).
 */

import type { WorkspaceContext } from '../context.js';

// R1 (the re-cut after critic round 3): whether a receipt is already BOOKED, and what a second booking
// needs, is decided by the one receipt guard (`../files/receiptGuard.ts`) at every door, `capture_commit`
// included. This module keeps only the capture hold itself.

/** The capture still under review whose document is this file, if any. */
export function liveCaptureOfDocument(ctx: WorkspaceContext, fileId: string): { id: string } | undefined {
  return ctx.store.db
    .prepare("SELECT id FROM captures WHERE workspace_id = ? AND document_id = ? AND status = 'needs_review' ORDER BY created_at ASC, rowid ASC LIMIT 1")
    .get(ctx.workspaceId, fileId) as { id: string } | undefined;
}

/**
 * Close a capture under review as booked by another record (inside the booking's transaction). Answers
 * false when the capture is no longer under review (nothing changes then).
 */
export function settleCaptureByBooking(
  ctx: WorkspaceContext,
  captureId: string,
  booked: { entityKind: string; entityId: string; fileId: string },
): boolean {
  const at = ctx.clock.now();
  const changed = ctx.store.db
    .prepare(
      `UPDATE captures SET status = 'committed', committed_by = ?, committed_at = ?, updated_at = ?
        WHERE workspace_id = ? AND id = ? AND status = 'needs_review'`,
    )
    .run(ctx.actor, at, at, ctx.workspaceId, captureId).changes;
  if (changed !== 1) return false;
  ctx.store.db
    .prepare(
      `INSERT INTO capture_settlement (id, workspace_id, capture_id, entity_kind, entity_id, file_id, actor, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ctx.ids.next('capset'), ctx.workspaceId, captureId, booked.entityKind, booked.entityId, booked.fileId, ctx.actor, at);
  ctx.audit.record({ entityKind: 'capture', entityId: captureId, action: 'commit', actor: ctx.actor, at });
  return true;
}
