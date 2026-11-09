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
import { getSetting } from '../settings/settings.js';

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

/**
 * Critic A41 r1 P4: when a record is BOOKED (inside its own transaction), close every capture under review whose
 * document (or a filing row over the same bytes: the attach seam's sibling, r2 R2) was already filed on it (a
 * person linked the receipt to the open bank line first, or a reopen left it pending there), under
 * `files.capture_on_attach = close`. Answers the closed capture ids. `IS_HEAD` is inlined (a leaf module).
 */
export function settleCapturesLinkedTo(ctx: WorkspaceContext, entityKind: string, entityId: string): string[] {
  if (getSetting<string>(ctx, 'files.capture_on_attach') !== 'close') return [];
  const rows = ctx.store.db
    .prepare(
      `SELECT c.id AS capture_id, f.id AS file_id FROM captures c
         JOIN stored_file f ON f.workspace_id = c.workspace_id AND (f.id = c.document_id OR f.sha256 = c.sha256)
        WHERE c.workspace_id = ? AND c.status = 'needs_review' AND f.entity_kind = ? AND f.entity_id = ?
          AND NOT EXISTS (SELECT 1 FROM stored_file s WHERE s.workspace_id = f.workspace_id AND s.supersedes_id = f.id)
        ORDER BY c.created_at, c.rowid, (f.id = c.document_id) DESC`,
    )
    .all(ctx.workspaceId, entityKind, entityId) as { capture_id: string; file_id: string }[];
  const out: string[] = [];
  // settleCaptureByBooking closes a capture once; a second row of the same capture changes nothing.
  for (const r of rows) if (settleCaptureByBooking(ctx, r.capture_id, { entityKind, entityId, fileId: r.file_id })) out.push(r.capture_id);
  return out;
}

/**
 * Critic A41 r2 R2, THE ONE INVARIANT for both seams (the attach seam and `settleCapturesLinkedTo`): a closed
 * capture implies a posting holds it. When `reopen_bank_line` takes back the booking that closed a capture
 * (the line, or an entry it reverses, is what the capture's NEWEST settlement names), the capture goes back
 * under review: attached and pending on the reopened line (its filing row stays there). A later booking
 * closes it again (a new settlement row); an ignore leaves it in Belege ohne Buchung. Only a capture closed by
 * a booking (no A31 target of its own) is reopened; one committed into its own vendor bill or claim is not.
 * The settlement rows stay as history; the audit chain records the reopen. Answers the reopened capture ids.
 */
export function reopenCapturesSettledBy(ctx: WorkspaceContext, holders: readonly { entityKind: string; entityId: string }[]): string[] {
  if (holders.length === 0) return [];
  const rows = ctx.store.db
    .prepare(
      `SELECT c.id AS capture_id, s.entity_kind, s.entity_id FROM captures c
         JOIN capture_settlement s ON s.workspace_id = c.workspace_id AND s.capture_id = c.id
        WHERE c.workspace_id = ? AND c.status = 'committed' AND c.target_kind IS NULL AND s.kind = 'closed'
          AND NOT EXISTS (
            SELECT 1 FROM capture_settlement n WHERE n.workspace_id = s.workspace_id AND n.capture_id = s.capture_id
               AND (n.at > s.at OR (n.at = s.at AND n.rowid > s.rowid)))
        ORDER BY c.created_at, c.rowid`,
    )
    .all(ctx.workspaceId) as { capture_id: string; entity_kind: string; entity_id: string }[];
  const wanted = new Set(holders.map((h) => `${h.entityKind}|${h.entityId}`));
  const at = ctx.clock.now();
  const out: string[] = [];
  for (const r of rows) {
    if (!wanted.has(`${r.entity_kind}|${r.entity_id}`)) continue;
    const changed = ctx.store.db
      .prepare(
        `UPDATE captures SET status = 'needs_review', committed_by = NULL, committed_at = NULL, updated_at = ?
          WHERE workspace_id = ? AND id = ? AND status = 'committed' AND target_kind IS NULL`,
      )
      .run(at, ctx.workspaceId, r.capture_id).changes;
    if (changed !== 1) continue;
    ctx.audit.record({ entityKind: 'capture', entityId: r.capture_id, action: 'reopen', actor: ctx.actor, at });
    out.push(r.capture_id);
  }
  return out;
}
