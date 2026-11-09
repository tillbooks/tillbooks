/**
 * A41.3 re-cut v3 (one holder truth), THE ENFORCEMENT: `holdPlan` decides, read-only, what an act that writes a
 * receipt's bytes onto a record (or moves a file off its record) may do when an ACTIVE assignment holds them on
 * another bank line; `applyHoldPlan` writes the plan FIRST, before the act's own link.
 *
 * WHO HOLDS is answered by the one holder read (`receiptHolders`, `files/receiptGuard.ts`), in which an active
 * assignment is a holder of kind `beleg_assignment`. A HOLDER IS A RECORD THE RECEIPT EVIDENCES: the plan judges an
 * act only when its target is a booking kind (`RECEIPT_BOOKING_KINDS`, drafts included), or when it moves an
 * ASSIGNED FILE ROW off its line (`act: 'version'` or a re-link of that very row). A twin of the bytes on a
 * non-booking record (a contact, a template, a report, a GL archive entry) is no move and passes.
 *
 * THE RULE, per holding assignment (spec "A41.3 re-cut v3", revision 4):
 *  - a MACHINE act (`isMachineAct`: a governed seat, a plugin call, the system, or a person approving a governed
 *    seat's draft) is refused `receipt_assigned { holders: [{ bankTxnId, assignmentId, source }] }`;
 *  - a PERSON's `capture_commit` (`act: 'commit'`) always releases it, person or engine row, `capture_committed`;
 *  - a PERSON act on an ENGINE row always releases it, `person_overrode` (I-B: a person always wins);
 *  - a PERSON act on a PERSON row follows the human-only `belege.assigned_move`: `refuse` (default) refuses
 *    `receipt_assigned`, `move` releases it `person_moved`.
 * Every release goes through `closeAssignment` and unfiles the whole released group from its old line, so that
 * line is open, holds no receipt and is re-pairable. None of these reasons blocks the engine (`personBlocked`).
 *
 * THE WRITE-ORDER RULE (every door): the act decides every refusal first, read-only (this plan, then the receipt
 * guard with `exceptAssignmentIds`, then its own checks); only then does it write, `applyHoldPlan` first. A refusal
 * met after the first write is THROWN (`ReceiptGuardAbort`), so the transaction rolls back whole.
 *
 * §H-TENANT on every query.
 */

import type { WorkspaceContext } from '../context.js';
import { err } from '../result.js';
import type { Err } from '../result.js';
import { getSetting } from '../settings/settings.js';
import { assignmentHoldersOf, holdersForSeat, isReceiptBookingKind, receiptHolders } from '../files/receiptGuard.js';
import { isMachineAct } from '../purchase/intakeSeat.js';
import { closeAssignment } from './belegAssignmentStore.js';
import type { BelegAssignmentReleaseReason } from './belegAssignmentSchema.js';

/** The human-only setting that decides a person's act over a PERSON row (refuse by default). */
export const ASSIGNED_MOVE_SETTING = 'belege.assigned_move';

/** What the act is: a link (any `linkFile`), a capture commit, or a new version of a filed file. */
export type HoldAct = 'link' | 'commit' | 'version';

export interface HoldRelease {
  assignmentId: string;
  bankTxnId: string;
  reason: BelegAssignmentReleaseReason;
}

/** A plan: the releases to write first, and the assignments the act's own receipt guard must then not count. */
export interface HoldPlan {
  releases: HoldRelease[];
  exceptAssignmentIds: string[];
}

const NOTHING: HoldPlan = { releases: [], exceptAssignmentIds: [] };

/** The active assignment that holds this very file row, with its line, or undefined. */
function assignedRowOf(ctx: WorkspaceContext, fileId: string): { assignmentId: string; bankTxnId: string; source: 'engine_unique' | 'person' } | undefined {
  return ctx.store.db
    .prepare(
      `SELECT f.assignment_id AS assignmentId, f.bank_txn_id AS bankTxnId, a.source FROM beleg_assignment_file f
         JOIN beleg_assignment a ON a.workspace_id = f.workspace_id AND a.id = f.assignment_id
        WHERE f.workspace_id = ? AND f.file_id = ? AND f.active = 1 AND a.state = 'active' LIMIT 1`,
    )
    .get(ctx.workspaceId, fileId) as { assignmentId: string; bankTxnId: string; source: 'engine_unique' | 'person' } | undefined;
}

/**
 * The plan for one act (see the module note). `sha256` is the bytes the act puts on `target`; `fileId` the row it
 * links or versions (null for new bytes). Answers the refusal or the plan, writing nothing.
 */
export function holdPlan(
  ctx: WorkspaceContext,
  input: { sha256: string; fileId: string | null; target: { kind: string; id: string | null }; act: HoldAct },
): HoldPlan | Err {
  const holding = new Map<string, { assignmentId: string; bankTxnId: string; source: 'engine_unique' | 'person' }>();
  // The assigned row moved off its line (a re-link of that row, or a new version over it): judged for ANY target.
  const own = input.fileId === null ? undefined : assignedRowOf(ctx, input.fileId);
  // A new version of the assigned row changes the line's receipt even on its own line.
  if (own !== undefined && (input.act === 'version' || !(input.target.kind === 'bank_txn' && input.target.id === own.bankTxnId))) holding.set(own.assignmentId, own);
  // The bytes onto a booking-kind record (drafts included): every assignment holding them on another line.
  if (isReceiptBookingKind(input.target.kind) || input.act === 'commit') {
    for (const h of assignmentHoldersOf(receiptHolders(ctx, input.sha256, { target: input.target }))) holding.set(h.assignmentId, h);
  }
  if (holding.size === 0) return NOTHING;
  const holders = [...holding.values()];
  if (isMachineAct(ctx)) {
    return err('receipt_assigned', { holders: holdersForSeat(ctx, holders), reason: 'the receipt is assigned to a bank line; only a person releases it there (release_beleg)' }) as Err;
  }
  const releases: HoldRelease[] = [];
  for (const h of holders) {
    if (input.act === 'commit') {
      releases.push({ assignmentId: h.assignmentId, bankTxnId: h.bankTxnId, reason: 'capture_committed' });
    } else if (h.source === 'engine_unique') {
      releases.push({ assignmentId: h.assignmentId, bankTxnId: h.bankTxnId, reason: 'person_overrode' });
    } else if (getSetting<string>(ctx, ASSIGNED_MOVE_SETTING) === 'move') {
      releases.push({ assignmentId: h.assignmentId, bankTxnId: h.bankTxnId, reason: 'person_moved' });
    } else {
      return err('receipt_assigned', {
        holders: holdersForSeat(ctx, holders),
        setting: ASSIGNED_MOVE_SETTING,
        reason: 'a person assigned this receipt to a bank line; release it there first ("Lösen", release_beleg), then repeat the act',
      }) as Err;
    }
  }
  return { releases, exceptAssignmentIds: releases.map((r) => r.assignmentId) };
}

/**
 * Write a plan, FIRST in the act's transaction: each holding row released through `closeAssignment`, and every file
 * of its group unfiled from its old line (back to unlinked), so the line holds no receipt and is re-pairable.
 */
export function applyHoldPlan(ctx: WorkspaceContext, plan: HoldPlan): void {
  const at = ctx.clock.now();
  for (const r of plan.releases) {
    const shas = (
      ctx.store.db.prepare('SELECT sha256 FROM beleg_assignment_file WHERE workspace_id = ? AND assignment_id = ?').all(ctx.workspaceId, r.assignmentId) as { sha256: string }[]
    ).map((x) => x.sha256);
    closeAssignment(ctx, r.assignmentId, { state: 'released', reason: r.reason });
    if (shas.length === 0) continue;
    const marks = shas.map(() => '?').join(', ');
    ctx.store.db
      .prepare(
        `UPDATE stored_file SET entity_kind = NULL, entity_id = NULL, updated_at = ?, linked_by = ?, linked_by_seat = 'person'
          WHERE workspace_id = ? AND entity_kind = 'bank_txn' AND entity_id = ? AND sha256 IN (${marks})`,
      )
      .run(at, ctx.actor, ctx.workspaceId, r.bankTxnId, ...shas);
  }
}
