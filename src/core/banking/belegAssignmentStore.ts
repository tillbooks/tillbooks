/**
 * A41.3 re-cut v2 (D184): the assignment rows, read and moved, and the LIFECYCLE every door that decides a
 * line runs (I-D). A LEAF (it imports only types and the figures leaf), so the one decision writer
 * (`bankLines.ts#writeLineLink`), the reopen (`supersedeActiveLink`), `capture_commit` and `capture_extract`
 * can reach it without a module cycle.
 *
 * THE LIFECYCLE, AT THE CHOKEPOINTS, NOT AT THE VERBS. A line is decided only through `writeLineLink` and
 * undone only through `supersedeActiveLink`, so binding the assignment's fate there covers `book_bank_line`
 * (every target: accounts, rule, existing_entry, open_item, contact, run, Spesen), `ignore_bank_line`, the
 * A20 wrappers and `reopen_bank_line` without enumerating them:
 *   - booked or matched: CONSUMED (with the entry) when the booking carries the assignment's receipt (the
 *     autobook step binds it, `withAssignmentConsumption`; or every file of the group is on the line or in
 *     this booking's `attach`), else RELEASED `line_decided` (a person booked it otherwise);
 *   - ignored: RELEASED `line_ignored`;
 *   - reopened: a consumed or active row of the line is RELEASED `line_reopened` (the capture comes back
 *     through `captureHold.ts#reopenCapturesSettledBy`);
 *   - `capture_commit` (a vendor bill or an expense line): RELEASED `capture_committed`;
 *   - a figure change on the capture: an `engine_unique` row is RELEASED `figures_changed`; a `person` row only
 *     when a PERSON changed the figures (a governed seat's edit is ignored while a person's row stands).
 * Only a person's release blocks the engine from re-creating the pair (`personBlocked`).
 *
 * §H-TENANT on every query.
 */

import type { WorkspaceContext } from '../context.js';
import type { BelegAssignmentReleaseReason } from './belegAssignmentSchema.js';
import type { ReceiptFigures } from './belegFigures.js';
import { engineSnapshotOf, parseFieldRows, receiptFigures, sameFigures } from './belegFigures.js';
import { err } from '../result.js';
import type { Err } from '../result.js';
import { isMachineAct } from '../purchase/intakeSeat.js';
import { ReceiptGuardAbort } from '../files/receiptGuard.js';

export type BelegAssignmentSource = 'engine_unique' | 'person';
export type BelegAssignmentState = 'active' | 'consumed' | 'released';

/** One file of an assignment with the figures it was assigned on. */
export interface BelegAssignmentFile {
  fileId: string;
  captureId: string;
  sha256: string;
  amountMinor: number;
  currency: string;
  vatMinor: number | null;
  /** The capture's engine fields (figures and match keys) when the row was made (`engineSnapshotOf`). */
  matchJson: string | null;
}

/** One assignment row. */
export interface BelegAssignment {
  id: string;
  bankTxnId: string;
  source: BelegAssignmentSource;
  seat: string;
  createdAt: string;
  state: BelegAssignmentState;
  releaseReason: BelegAssignmentReleaseReason | null;
  entryId: string | null;
  closedAt: string | null;
  closedBy: string | null;
  files: BelegAssignmentFile[];
}

interface AssignmentDbRow {
  id: string;
  bank_txn_id: string;
  source: BelegAssignmentSource;
  seat: string;
  created_at: string;
  state: BelegAssignmentState;
  release_reason: BelegAssignmentReleaseReason | null;
  entry_id: string | null;
  closed_at: string | null;
  closed_by: string | null;
}

function filesOf(ctx: WorkspaceContext, assignmentId: string): BelegAssignmentFile[] {
  return (
    ctx.store.db
      .prepare(
        `SELECT file_id, capture_id, sha256, amount_minor, currency, vat_minor, match_json FROM beleg_assignment_file
          WHERE workspace_id = ? AND assignment_id = ? ORDER BY file_id`,
      )
      .all(ctx.workspaceId, assignmentId) as { file_id: string; capture_id: string; sha256: string; amount_minor: number; currency: string; vat_minor: number | null; match_json: string | null }[]
  ).map((f) => ({ fileId: f.file_id, captureId: f.capture_id, sha256: f.sha256, amountMinor: f.amount_minor, currency: f.currency, vatMinor: f.vat_minor, matchJson: f.match_json }));
}

function hydrate(ctx: WorkspaceContext, r: AssignmentDbRow): BelegAssignment {
  return {
    id: r.id,
    bankTxnId: r.bank_txn_id,
    source: r.source,
    seat: r.seat,
    createdAt: r.created_at,
    state: r.state,
    releaseReason: r.release_reason,
    entryId: r.entry_id,
    closedAt: r.closed_at,
    closedBy: r.closed_by,
    files: filesOf(ctx, r.id),
  };
}

/** The line's ACTIVE assignment (at most one, by the partial unique index), or undefined. */
export function activeAssignmentOf(ctx: WorkspaceContext, bankTxnId: string): BelegAssignment | undefined {
  const r = ctx.store.db
    .prepare("SELECT * FROM beleg_assignment WHERE workspace_id = ? AND bank_txn_id = ? AND state = 'active'")
    .get(ctx.workspaceId, bankTxnId) as AssignmentDbRow | undefined;
  return r === undefined ? undefined : hydrate(ctx, r);
}

/**
 * A41.3 follow-ups ("Neue Version, bitte zuordnen"): the head file filed on this line, with no capture under review,
 * whose version chain reaches back to a file of an assignment of THIS line that a person's new version released
 * (`person_moved`, `files_new_version` under `belege.assigned_move = move`), or null. Pure read, tenant-scoped.
 */
export function newVersionAwaitingAssignment(ctx: WorkspaceContext, bankTxnId: string): string | null {
  const r = ctx.store.db
    .prepare(
      `WITH RECURSIVE chain(head, ancestor, depth) AS (
         SELECT f.id, f.supersedes_id, 1 FROM stored_file f
          WHERE f.workspace_id = ? AND f.entity_kind = 'bank_txn' AND f.entity_id = ? AND f.pending_delete = 0
            AND f.supersedes_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM stored_file s WHERE s.workspace_id = f.workspace_id AND s.supersedes_id = f.id)
            AND NOT EXISTS (SELECT 1 FROM captures c WHERE c.workspace_id = f.workspace_id AND c.document_id = f.id AND c.status = 'needs_review')
         UNION ALL
         SELECT chain.head, p.supersedes_id, chain.depth + 1 FROM chain
           JOIN stored_file p ON p.workspace_id = ? AND p.id = chain.ancestor
          WHERE p.supersedes_id IS NOT NULL AND chain.depth < 50
       )
       SELECT chain.head AS head FROM chain
        WHERE EXISTS (SELECT 1 FROM beleg_assignment_file af
                        JOIN beleg_assignment a ON a.workspace_id = af.workspace_id AND a.id = af.assignment_id
                       WHERE af.workspace_id = ? AND af.file_id = chain.ancestor AND a.bank_txn_id = ?
                         AND a.state = 'released' AND a.release_reason = 'person_moved')
        ORDER BY chain.head LIMIT 1`,
    )
    .get(ctx.workspaceId, bankTxnId, ctx.workspaceId, ctx.workspaceId, bankTxnId) as { head: string } | undefined;
  return r?.head ?? null;
}

/** Every active assignment of the workspace, oldest first. */
export function activeAssignments(ctx: WorkspaceContext): BelegAssignment[] {
  return (
    ctx.store.db.prepare("SELECT * FROM beleg_assignment WHERE workspace_id = ? AND state = 'active' ORDER BY created_at, rowid").all(ctx.workspaceId) as AssignmentDbRow[]
  ).map((r) => hydrate(ctx, r));
}

/** Every assignment of one line, oldest first (the history). */
export function assignmentsOfLine(ctx: WorkspaceContext, bankTxnId: string): BelegAssignment[] {
  return (
    ctx.store.db
      .prepare('SELECT * FROM beleg_assignment WHERE workspace_id = ? AND bank_txn_id = ? ORDER BY created_at, rowid')
      .all(ctx.workspaceId, bankTxnId) as AssignmentDbRow[]
  ).map((r) => hydrate(ctx, r));
}

/** The lines holding an active assignment, or a consumed one whose booking stands (H6: no claimants). */
export function linesHoldingAssignment(ctx: WorkspaceContext): Map<string, BelegAssignmentSource> {
  const rows = ctx.store.db
    .prepare("SELECT bank_txn_id, source FROM beleg_assignment WHERE workspace_id = ? AND state IN ('active', 'consumed')")
    .all(ctx.workspaceId) as { bank_txn_id: string; source: BelegAssignmentSource }[];
  return new Map(rows.map((r) => [r.bank_txn_id, r.source]));
}

/** Insert an ACTIVE assignment in the caller's transaction. Answers its id. */
export function insertAssignment(
  ctx: WorkspaceContext,
  input: { bankTxnId: string; source: BelegAssignmentSource; files: readonly BelegAssignmentFile[] },
): string {
  const id = ctx.ids.next('basg');
  const at = ctx.clock.now();
  ctx.store.db
    .prepare('INSERT INTO beleg_assignment (id, workspace_id, bank_txn_id, source, seat, created_at, state) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, ctx.workspaceId, input.bankTxnId, input.source, ctx.actor, at, 'active');
  const file = ctx.store.db.prepare(
    `INSERT INTO beleg_assignment_file (assignment_id, workspace_id, bank_txn_id, file_id, capture_id, sha256, amount_minor, currency, vat_minor, match_json, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  for (const f of input.files) file.run(id, ctx.workspaceId, input.bankTxnId, f.fileId, f.captureId, f.sha256, f.amountMinor, f.currency, f.vatMinor, f.matchJson);
  ctx.audit.record({ entityKind: 'bank_txn', entityId: input.bankTxnId, action: 'beleg_assign', actor: ctx.actor, at });
  return id;
}

/**
 * Move one assignment out of `active` (or a consumed one to released on a reopen), in the caller's
 * transaction. Answers false when the row is not in a state that moves (nothing changes then).
 */
export function closeAssignment(
  ctx: WorkspaceContext,
  id: string,
  to: { state: 'consumed'; entryId: string | null } | { state: 'released'; reason: BelegAssignmentReleaseReason },
): boolean {
  // Critic A41.3 r2 M2/M3, THE CHOKEPOINT for I-D's "only a person ends a person's row": every release of an
  // assignment passes here, whichever door asked (a discard, a commit, a figure edit, a decision on the line, a
  // reopen). Releasing an ACTIVE `person` row is a person's act only (`isMachineAct`: a governed seat, a plugin
  // call, the system, or a person approving a governed seat's draft is a machine). A machine act that would is
  // refused as a WHOLE (`receipt_assigned`): the throw rolls its transaction back, and the registry (and the
  // capture and bank guards) answer the refusal. Consumption by a booking is no release and stays allowed.
  if (to.state === 'released') {
    const row = ctx.store.db.prepare('SELECT source, state FROM beleg_assignment WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, id) as
      | { source: BelegAssignmentSource; state: BelegAssignmentState }
      | undefined;
    if (row !== undefined && row.source === 'person' && row.state === 'active' && isMachineAct(ctx)) {
      throw new ReceiptGuardAbort(
        err('receipt_assigned', { assignmentId: id, reason: 'a person assigned this receipt to a bank line; only a person ends that (release_beleg), never a machine act' }) as Err,
      );
    }
  }
  const at = ctx.clock.now();
  const from = to.state === 'released' && to.reason === 'line_reopened' ? "state IN ('active', 'consumed')" : "state = 'active'";
  const changed =
    to.state === 'consumed'
      ? ctx.store.db
          .prepare(`UPDATE beleg_assignment SET state = 'consumed', entry_id = ?, closed_at = ?, closed_by = ? WHERE workspace_id = ? AND id = ? AND ${from}`)
          .run(to.entryId, at, ctx.actor, ctx.workspaceId, id).changes
      : ctx.store.db
          .prepare(`UPDATE beleg_assignment SET state = 'released', release_reason = ?, closed_at = ?, closed_by = ? WHERE workspace_id = ? AND id = ? AND ${from}`)
          .run(to.reason, at, ctx.actor, ctx.workspaceId, id).changes;
  if (changed !== 1) return false;
  const line = ctx.store.db.prepare('SELECT bank_txn_id FROM beleg_assignment WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, id) as { bank_txn_id: string };
  ctx.audit.record({ entityKind: 'bank_txn', entityId: line.bank_txn_id, action: to.state === 'consumed' ? 'beleg_consume' : 'beleg_release', actor: ctx.actor, at });
  return true;
}

/**
 * Only a person's release blocks re-creation (I-D): the engine never assigns `fileId` to `bankTxnId` again
 * while the NEWEST assignment over that pair was released by a person. A person's own re-assignment is newer
 * and lifts it.
 */
export function personBlocked(ctx: WorkspaceContext, bankTxnId: string, fileId: string): boolean {
  // A41.3 re-cut v3 (paper R4-1): matched by the file OR its bytes, so a rejected receipt discarded and re-dropped
  // (a new file id over the same sha256) stays blocked for that line.
  const sha = (ctx.store.db.prepare('SELECT sha256 FROM stored_file WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, fileId) as { sha256: string } | undefined)?.sha256 ?? null;
  const r = ctx.store.db
    .prepare(
      `SELECT a.state, a.release_reason FROM beleg_assignment_file f JOIN beleg_assignment a ON a.workspace_id = f.workspace_id AND a.id = f.assignment_id
        WHERE f.workspace_id = ? AND f.bank_txn_id = ? AND (f.file_id = ? OR f.sha256 = ?)
        ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, bankTxnId, fileId, sha ?? '') as { state: string; release_reason: string | null } | undefined;
  // The reason table: ONLY an explicit person statement blocks ("Lösen" or an assign_beleg replace).
  return r !== undefined && r.state === 'released' && (r.release_reason === 'person' || r.release_reason === 'person_rejected');
}

/** The release reasons that block the engine from re-creating a pair (the v3 reason table). */
export const BLOCKING_RELEASE_REASONS: readonly BelegAssignmentReleaseReason[] = ['person', 'person_rejected'];

// --- The current figures of a capture (the leaf's own read, no import of the matcher) -------------------

/** The capture's live figures, read the one way (`belegFigures.ts`). Null without a positive amount. */
export function currentFiguresOf(ctx: WorkspaceContext, captureId: string): ReceiptFigures | null {
  const rows = ctx.store.db
    .prepare('SELECT key, value FROM capture_fields WHERE workspace_id = ? AND capture_id = ? AND superseded = 0')
    .all(ctx.workspaceId, captureId) as { key: string; value: string }[];
  const base = (ctx.store.db.prepare('SELECT base_currency FROM workspace WHERE id = ?').get(ctx.workspaceId) as { base_currency: string } | undefined)?.base_currency ?? 'CHF';
  return receiptFigures(parseFieldRows(rows), base);
}

/** The capture's live engine fields, canonical (`engineSnapshotOf`): what a confirmation and a row snapshot. */
export function currentEngineSnapshotOf(ctx: WorkspaceContext, captureId: string): string {
  const rows = ctx.store.db
    .prepare('SELECT key, value FROM capture_fields WHERE workspace_id = ? AND capture_id = ? AND superseded = 0')
    .all(ctx.workspaceId, captureId) as { key: string; value: string }[];
  return engineSnapshotOf(rows);
}

/** The figures an assignment file was assigned on. */
export function snapshotOf(f: BelegAssignmentFile): ReceiptFigures {
  return { amountMinor: f.amountMinor, currency: f.currency, vatMinor: f.vatMinor };
}

// --- The binders the deciding doors read --------------------------------------------------------------

/** The assignment the running autobook booking consumes, bound for one line (`withAssignmentConsumption`). */
let boundConsumption: { workspaceId: string; bankTxnId: string; assignmentId: string } | null = null;

/**
 * The autobook step books ONE line with its assignment's receipt: run `body` with the assignment bound, so the
 * one decision writer consumes exactly that row as the decision is written. Scoped (restored on return and on
 * a throw), this workspace and this line only (the `withDecisionChannel` precedent).
 */
export function withAssignmentConsumption<T>(ctx: WorkspaceContext, bankTxnId: string, assignmentId: string, body: () => T): T {
  const outer = boundConsumption;
  boundConsumption = { workspaceId: ctx.workspaceId, bankTxnId, assignmentId };
  try {
    return body();
  } finally {
    boundConsumption = outer;
  }
}

/** The files a running `book_bank_line` attaches (its `attach`), bound for one line (`withLineAttachIntent`). */
let boundAttach: { workspaceId: string; bankTxnId: string; fileIds: readonly string[] } | null = null;

/**
 * `book_bank_line attach:[{fileId}]` links its receipts AFTER the decision is written (the attach seam runs
 * after the booking in the same transaction), so the decision writer is told which files this booking takes:
 * a booking that attaches exactly the assignment's receipt consumes it.
 */
export function withLineAttachIntent<T>(ctx: WorkspaceContext, bankTxnId: string, fileIds: readonly string[], body: () => T): T {
  const outer = boundAttach;
  boundAttach = { workspaceId: ctx.workspaceId, bankTxnId, fileIds };
  try {
    return body();
  } finally {
    boundAttach = outer;
  }
}

/** The sha256 of each head file filed on the line, plus the shas of the files this booking attaches. */
function receiptShasOfBooking(ctx: WorkspaceContext, bankTxnId: string): Set<string> {
  const filed = ctx.store.db
    .prepare(
      `SELECT f.sha256 FROM stored_file f
        WHERE f.workspace_id = ? AND f.entity_kind = 'bank_txn' AND f.entity_id = ? AND f.pending_delete = 0
          AND NOT EXISTS (SELECT 1 FROM stored_file s WHERE s.workspace_id = f.workspace_id AND s.supersedes_id = f.id)`,
    )
    .all(ctx.workspaceId, bankTxnId) as { sha256: string }[];
  const out = new Set(filed.map((f) => f.sha256));
  const attach = boundAttach;
  if (attach !== null && attach.workspaceId === ctx.workspaceId && attach.bankTxnId === bankTxnId && attach.fileIds.length > 0) {
    const marks = attach.fileIds.map(() => '?').join(', ');
    for (const r of ctx.store.db.prepare(`SELECT sha256 FROM stored_file WHERE workspace_id = ? AND id IN (${marks})`).all(ctx.workspaceId, ...attach.fileIds) as { sha256: string }[]) {
      out.add(r.sha256);
    }
  }
  return out;
}

// --- I-D, the lifecycle -------------------------------------------------------------------------------

/**
 * THE DECISION WRITER's hook (`writeLineLink`, after the decision row exists): the line's active assignment is
 * consumed by a booking that carries its receipt, released by any other decision. Answers the moved row's id.
 */
export function assignmentOnLineDecided(ctx: WorkspaceContext, bankTxnId: string, state: string, entryId: string | null): string | null {
  const active = activeAssignmentOf(ctx, bankTxnId);
  if (active === undefined) return null;
  if (state === 'ignored') return closeAssignment(ctx, active.id, { state: 'released', reason: 'line_ignored' }) ? active.id : null;
  const bound = boundConsumption;
  const consumedByStep = bound !== null && bound.workspaceId === ctx.workspaceId && bound.bankTxnId === bankTxnId && bound.assignmentId === active.id;
  const shas = consumedByStep ? null : receiptShasOfBooking(ctx, bankTxnId);
  const carries = consumedByStep || active.files.every((f) => shas!.has(f.sha256));
  const moved = carries
    ? closeAssignment(ctx, active.id, { state: 'consumed', entryId })
    : closeAssignment(ctx, active.id, { state: 'released', reason: 'line_decided' });
  return moved ? active.id : null;
}

/** THE REOPEN's hook (`supersedeActiveLink`): the line's consumed or active assignment is released. */
export function assignmentOnLineReopened(ctx: WorkspaceContext, bankTxnId: string): string[] {
  const rows = ctx.store.db
    .prepare("SELECT id FROM beleg_assignment WHERE workspace_id = ? AND bank_txn_id = ? AND state IN ('active', 'consumed') ORDER BY created_at, rowid")
    .all(ctx.workspaceId, bankTxnId) as { id: string }[];
  return rows.filter((r) => closeAssignment(ctx, r.id, { state: 'released', reason: 'line_reopened' })).map((r) => r.id);
}

/** The active assignments holding a capture. */
function activeHoldingCapture(ctx: WorkspaceContext, captureId: string): BelegAssignment[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT DISTINCT a.* FROM beleg_assignment a JOIN beleg_assignment_file f ON f.workspace_id = a.workspace_id AND f.assignment_id = a.id
        WHERE a.workspace_id = ? AND a.state = 'active' AND f.capture_id = ?`,
    )
    .all(ctx.workspaceId, captureId) as AssignmentDbRow[];
  return rows.map((r) => hydrate(ctx, r));
}

/** `capture_commit`'s hook: a capture committed into a vendor bill or an expense line releases its assignment. */
export function assignmentOnCaptureCommitted(ctx: WorkspaceContext, captureId: string): string[] {
  return activeHoldingCapture(ctx, captureId)
    .filter((a) => closeAssignment(ctx, a.id, { state: 'released', reason: 'capture_committed' }))
    .map((a) => a.id);
}

/**
 * `capture_extract`'s hook, after the capture's fields changed: an assignment whose snapshot no longer equals
 * the live figures is released `figures_changed`, an `engine_unique` one always (the engine re-evaluates), a
 * `person` one only when the change was a PERSON's (`byPerson`): while a person's assignment stands, a
 * governed seat's figure edit is ignored (I-D) and the verdict judges the person's snapshot.
 */
export function assignmentOnFiguresChanged(ctx: WorkspaceContext, captureId: string, byPerson: boolean): string[] {
  const now = currentFiguresOf(ctx, captureId);
  const engineNow = currentEngineSnapshotOf(ctx, captureId);
  const out: string[] = [];
  for (const a of activeHoldingCapture(ctx, captureId)) {
    const file = a.files.find((f) => f.captureId === captureId);
    if (file === undefined) continue;
    // Critic A41.3 r1 S1/S2: an ENGINE row stands on every engine field (a moved match key could steer the
    // receipt elsewhere); a PERSON row on the figures only (the person chose the line), and only a person's edit.
    const moved = a.source === 'engine_unique' ? !sameFigures(snapshotOf(file), now) || file.matchJson !== engineNow : !sameFigures(snapshotOf(file), now);
    if (!moved) continue;
    if (a.source === 'person' && !byPerson) continue;
    if (closeAssignment(ctx, a.id, { state: 'released', reason: 'figures_changed' })) out.push(a.id);
  }
  return out;
}

/** Is this capture's receipt held by a PERSON's active assignment? (Only a person may end that row, I-D.) */
export function heldByPersonAssignment(ctx: WorkspaceContext, captureId: string): boolean {
  return activeHoldingCapture(ctx, captureId).some((a) => a.source === 'person');
}

/**
 * Critic A41.3 r1 R2: `capture_discard`'s hook: a discarded receipt is no line's Beleg. The caller refuses a
 * machine seat's discard of a receipt a person's row holds BEFORE this runs (security review: only a person
 * releases a person row), so here a person's discard releases any row and anyone's discard an engine row.
 */
export function assignmentOnCaptureDiscarded(ctx: WorkspaceContext, captureId: string): string[] {
  return activeHoldingCapture(ctx, captureId)
    .filter((a) => closeAssignment(ctx, a.id, { state: 'released', reason: 'capture_discarded' }))
    .map((a) => a.id);
}
