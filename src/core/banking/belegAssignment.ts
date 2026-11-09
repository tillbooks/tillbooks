/**
 * A41.3 re-cut v2 (D184, I-B, I-F): THE TWO WRITERS of a receipt assignment, and the person's confirmation of
 * a capture's figures.
 *
 * EXACTLY TWO CODE PATHS CREATE AN ASSIGNMENT (I-B), and `files_link` is neither:
 *  1. THE ENGINE, `reconcileEngineAssignments`, during the autobook tick, under the write lock (one
 *     transaction over the whole pass). Declarative: it computes the pairs that SHOULD stand and moves the
 *     table to them. A pair (L, G) stands when receipt group G fits exactly one claimant line, L, and L exactly
 *     one group, G, over the WHOLE pool (an untrusted receipt still makes a line ambiguous); L is open; every
 *     capture of G has figures that back an unattended booking (`belegTrust.ts`, I-F); and no person released
 *     that pair (`personBlocked`). Files held by a person's active assignment leave the pool. Lines holding a
 *     person's active assignment, or a consumed one, are no claimants (H6). An engine row that no longer
 *     stands is released (`figures_changed`, `receipt_changed`, `no_longer_unique`); the engine never touches
 *     a person's row (H5).
 *  2. A PERSON, `assign_beleg {bankTxnId, fileIds}`: human-only in the engine (`assignHumanOnly`, the
 *     `refuseHumanOnly` precedent: a governed seat, a plugin call included, is refused before a Vorschlag is
 *     drafted and at execution alike), on the G01 denylist, needs BOTH read rights (the receipt and the bank
 *     line, I-E) and the line's edit right, checks the workspace of the line and of every file, and needs a
 *     capture under review WITH an amount behind every file. It files each document on the open line WITHOUT
 *     closing its capture (r1 P4: the booking closes it). A person always wins: an assignment of the same line
 *     or of the same receipt is released (`person`) in the same transaction, an engine row or the person's
 *     own earlier one.
 *
 * `release_beleg` is a person's "Lösen": the line's active assignment is released (`person`), which blocks
 * the engine from re-creating that pair until a person assigns it again (I-D), and a document the
 * assignment filed on the open line goes back to Belege ohne Buchung.
 *
 * `confirm_capture_figures` is the one-click "Zahlen bestätigen" (I-F, bulk-confirmable): human-only, one
 * append-only row per capture naming the figures and bytes the person confirmed.
 *
 * §H-TENANT on every query.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { isGovernedSeat } from '../access/capability.js';
import { isMachineAct } from '../purchase/intakeSeat.js';
import { requireString } from '../ledger/inputGuards.js';
import { editCapabilityForKind } from '../customization/entities.js';
import { linkFile } from '../files/files.js';
import { ASSIGNMENT_HOLDER_KIND, ReceiptGuardAbort, receiptHolderGuard, receiptHolders } from '../files/receiptGuard.js';
import type { GuardPass } from '../files/receiptGuard.js';
import { captureStoredDocument, isFreshPersonDrop, liveCaptureOfBytes, statePersonFigures, storedBytesSeat } from '../purchase/capture.js';
import { CAPTURE_ACCEPTED_MIMES, isCaptureAcceptedMime } from '../purchase/captureEnums.js';
import { applyHoldPlan, holdPlan } from './belegHold.js';
import type { HoldPlan } from './belegHold.js';
import { readBankTxn, lineStateOf } from './bankLines.js';
import { BANK_LINE_READ_CAPABILITY, BELEG_READ_CAPABILITY, bankLineCandidatesForPool, belegMatchContext, holdsRead, undatedClaimantLines, vendorPrefixModeOf } from './belegMatch.js';
import { getSetting } from '../settings/settings.js';
import type { PoolBeleg } from './belegMatch.js';
import {
  activeAssignmentOf,
  activeAssignments,
  closeAssignment,
  currentEngineSnapshotOf,
  currentFiguresOf,
  insertAssignment,
  newVersionAwaitingAssignment,
  personBlocked,
  snapshotOf,
} from './belegAssignmentStore.js';
import type { BelegAssignment, BelegAssignmentFile } from './belegAssignmentStore.js';
import type { BelegAssignmentReleaseReason } from './belegAssignmentSchema.js';
import { engineFieldValuesOf, engineFieldsMatch, sameFigures } from './belegFigures.js';
import { figureTrustMode, figuresBackEngine, newestConfirmation } from './belegTrust.js';
import { receiptStands } from './belegVerdict.js';

/** The seat the engine writes its assignments as. */
export const BELEG_ENGINE_ACTOR = 'system';

/** The most files one assignment groups (an invoice, its receipt, a delivery note). */
export const MAX_ASSIGNMENT_FILES = 10;

/** Critic A41.3 r2 F3: how far back an undated receipt must be unique among the receipt-less lines. */
export const UNDATED_LOOKBACK_SETTING = 'belege.undated_lookback_days';

/** The most captures one confirmation takes (the list's bulk "Zahlen bestätigen"). */
export const MAX_CONFIRM_CAPTURES = 100;

// --- The engine writer (I-B.1) -----------------------------------------------------------------------

export interface EngineAssignReport {
  created: { assignmentId: string; bankTxnId: string }[];
  released: { assignmentId: string; bankTxnId: string; reason: BelegAssignmentReleaseReason }[];
  /**
   * Critic A41.3 r1 R2: a line whose assignment could not be written (a constraint the pass did not foresee):
   * that line alone is skipped, recorded here with the error, and every other line of the pass goes on. Optional
   * only for fixtures written before it.
   */
  refused?: { bankTxnId: string; error: string }[];
}

/** Why a standing engine row no longer stands. */
function releaseReasonOf(ctx: WorkspaceContext, a: BelegAssignment): BelegAssignmentReleaseReason {
  if (!receiptStands(ctx, a)) return 'receipt_changed';
  if (
    a.files.some(
      (f) => !sameFigures(snapshotOf(f), currentFiguresOf(ctx, f.captureId)) || f.matchJson !== currentEngineSnapshotOf(ctx, f.captureId) || !figuresBackEngine(ctx, f.captureId),
    )
  ) {
    return 'figures_changed';
  }
  return 'no_longer_unique';
}

/**
 * THE ENGINE'S PASS (see the module note), in ONE transaction: under the write lock nothing moves between
 * what it reads and what it writes. Answers what it created and released. Writes as `system`. `coversSql`
 * is the inbox's `STATEMENT_COVERS_SQL` (the "Ohne Beleg" claimants), passed in so this module does not
 * import the inbox, which reads this module's view.
 */
export function reconcileEngineAssignments(
  ctx: WorkspaceContext,
  coversSql: (entryExpr: string, bankAccountExpr: string, wsExpr: string) => string,
): EngineAssignReport {
  const system: WorkspaceContext = { ...ctx, actor: BELEG_ENGINE_ACTOR };
  return ctx.store.tx(() => {
    const report: EngineAssignReport = { created: [], released: [], refused: [] };
    const active = activeAssignments(ctx);
    const engineRows = active.filter((a) => a.source === 'engine_unique');
    // H6: a line holding a person's active assignment, or a consumed one, claims no receipt.
    const notClaimants = new Set(
      (
        ctx.store.db
          .prepare("SELECT bank_txn_id FROM beleg_assignment WHERE workspace_id = ? AND (state = 'consumed' OR (state = 'active' AND source = 'person'))")
          .all(ctx.workspaceId) as { bank_txn_id: string }[]
      ).map((r) => r.bank_txn_id),
    );
    const desired = new Map<string, PoolBeleg[]>();
    // A41.3 re-cut v3 (D15/D18): the pool reads the ONE holder read (`receiptHolders`): a receipt any active
    // assignment holds is no candidate, except a capture's OWN engine row, which this pass re-validates.
    const mc = belegMatchContext(ctx, { forEnginePass: true });
    if (mc !== null) {
      const poolOf = new Map(mc.pool.map((b) => [b.file.captureId, b]));
      const mode = figureTrustMode(ctx);
      const lineGroups = new Map<string, { state: string; groups: Map<string, Set<string>>; prefixOnly: boolean }>();
      const captureLines = new Map<string, Set<string>>();
      // D188 (A39 §21): a sender matched only by the start of a word (`name_prefix`, "MongoDB" in "MONGODBCLOUD")
      // is a candidate a PERSON confirms; the engine pairs it unattended only under `belege.match_vendor_prefix`
      // = `engine`. It still counts for "fits this line only" both ways, so it can block a pairing, never make one.
      const prefixPairs = vendorPrefixModeOf(ctx) === 'engine';
      for (const [captureId, cands] of bankLineCandidatesForPool(ctx, mc, coversSql)) {
        const b = poolOf.get(captureId);
        if (b === undefined) continue;
        for (const c of cands) {
          if (notClaimants.has(c.bankTxnId)) continue;
          // A person said this receipt is not this line's: the pair is gone for the engine, in both directions.
          if (personBlocked(ctx, c.bankTxnId, b.file.fileId)) continue;
          const lines = captureLines.get(captureId) ?? new Set<string>();
          lines.add(c.bankTxnId);
          captureLines.set(captureId, lines);
          const lg = lineGroups.get(c.bankTxnId) ?? { state: c.state, groups: new Map<string, Set<string>>(), prefixOnly: false };
          const g = lg.groups.get(c.groupKey) ?? new Set<string>();
          g.add(captureId);
          lg.groups.set(c.groupKey, g);
          if (c.counterpartyMatch === 'name_prefix' && !prefixPairs) lg.prefixOnly = true;
          lineGroups.set(c.bankTxnId, lg);
        }
      }
      for (const [lineId, lg] of lineGroups) {
        // Exactly one group fits the line, and only an OPEN line is assigned (a booked one is a person's files_link).
        if (lg.state !== 'open' || lg.groups.size !== 1) continue;
        if (lg.prefixOnly) continue;
        const captures = [...[...lg.groups.values()][0]!];
        // ...and the group fits this line only (both directions, over the whole pool).
        if (!captures.every((c) => captureLines.get(c)?.size === 1)) continue;
        // I-F: only trusted figures back an unattended booking.
        if (!captures.every((c) => figuresBackEngine(ctx, c, mode))) continue;
        desired.set(lineId, captures.map((c) => poolOf.get(c)!));
      }
      // Critic A41.3 r2 F3 (orchestrator decision, a conservative default): an UNDATED receipt (no invoice or due
      // date of its own; a QR bill states none, and its intake day is no evidence of the period it pays) pairs
      // unattended only (a) on an exact match of its QR/SCOR reference with the line's structured reference, or
      // (b) when it fits exactly ONE receipt-less line of its sender and amount, open or booked "Ohne Beleg",
      // within `belege.undated_lookback_days` (0: never). Otherwise it waits for a person.
      const lookback = getSetting<number>(ctx, UNDATED_LOOKBACK_SETTING);
      const today = ctx.clock.now().slice(0, 10);
      const shift = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
      const lineRef = ctx.store.db.prepare('SELECT reference_value FROM bank_txn WHERE workspace_id = ? AND id = ?');
      for (const [lineId, belege] of [...desired]) {
        const undated = belege.filter((b) => !b.dated);
        if (undated.length === 0) continue;
        const raw = (lineRef.get(ctx.workspaceId, lineId) as { reference_value: string | null } | undefined)?.reference_value ?? null;
        const ref = raw === null ? null : raw.replace(/\s+/g, '');
        if (ref !== null && ref !== '' && undated.every((b) => b.reference === ref)) continue;
        if (lookback <= 0) {
          desired.delete(lineId);
          continue;
        }
        const from = shift(today, -lookback);
        const to = shift(today, mc.cfg.windowDays);
        const unique = undated.every((b) => {
          const lines = undatedClaimantLines(ctx, mc, b, from, to, coversSql).filter((l) => !notClaimants.has(l) && !personBlocked(ctx, l, b.file.fileId));
          return lines.length === 1 && lines[0] === lineId;
        });
        if (!unique) desired.delete(lineId);
      }
    }
    for (const a of engineRows) {
      const want = desired.get(a.bankTxnId);
      const stands =
        want !== undefined &&
        want.length === a.files.length &&
        a.files.every((f) => {
          const b = want.find((w) => w.file.fileId === f.fileId);
          return (
            b !== undefined &&
            b.sha256 === f.sha256 &&
            sameFigures(snapshotOf(f), { amountMinor: b.file.amountMinor, currency: b.file.currency, vatMinor: b.file.vatAmountMinor }) &&
            f.matchJson === currentEngineSnapshotOf(ctx, f.captureId)
          );
        });
      if (stands) {
        desired.delete(a.bankTxnId);
        continue;
      }
      const reason = releaseReasonOf(ctx, a);
      if (closeAssignment(system, a.id, { state: 'released', reason })) report.released.push({ assignmentId: a.id, bankTxnId: a.bankTxnId, reason });
    }
    for (const [lineId, belege] of desired) {
      const files: BelegAssignmentFile[] = belege.map((b) => ({
        fileId: b.file.fileId,
        captureId: b.file.captureId,
        sha256: b.sha256,
        amountMinor: b.file.amountMinor,
        currency: b.file.currency,
        vatMinor: b.file.vatAmountMinor,
        matchJson: currentEngineSnapshotOf(ctx, b.file.captureId),
      }));
      // Critic A41.3 r1 R2: one line's failure never stops the others: its own savepoint, recorded.
      try {
        const assignmentId = ctx.store.tx(() => insertAssignment(system, { bankTxnId: lineId, source: 'engine_unique', files }));
        report.created.push({ assignmentId, bankTxnId: lineId });
      } catch (e) {
        report.refused!.push({ bankTxnId: lineId, error: String((e as { message?: unknown })?.message ?? e) });
      }
    }
    if (report.refused!.length === 0) delete report.refused;
    return report;
  });
}

// --- The person's writers (I-B.2) --------------------------------------------------------------------

/**
 * I-B.2: an assignment, its release and a figure confirmation are a PERSON's acts, under every dial. A41.3
 * follow-ups: by the `isMachineAct` rule (the hold plan's), so a person APPROVING a governed seat's draft of one of
 * these verbs (a draft that could only enter the queue beside the registry's prevalidate) is refused too, and so is
 * the system seat.
 */
export function assignHumanOnly(ctx: WorkspaceContext): Err | undefined {
  if (!isGovernedSeat(ctx.store, ctx.actor) && !isMachineAct(ctx)) return undefined;
  return err('human_only', {
    reason: 'only a person says which receipt belongs to which bank line, or confirms its figures; an agent can neither do it nor propose it',
  }) as Err;
}

/** I-E: both halves of a pairing are read rights; the refusal names no receipt fact. */
function bothReadRights(ctx: WorkspaceContext): Err | undefined {
  for (const capability of [BELEG_READ_CAPABILITY, BANK_LINE_READ_CAPABILITY]) {
    const held = ctx.capabilities.assert(capability);
    if (!held.ok) return held as Err;
  }
  return undefined;
}

export interface AssignBelegInput {
  bankTxnId?: unknown;
  fileIds?: unknown;
  idempotencyKey?: unknown;
}

export type AssignBelegOk = {
  assignmentId: string;
  bankTxnId: string;
  fileIds: string[];
  /** The assignments a person's act replaced (released `person`). */
  replaced: string[];
  alreadyAssigned: boolean;
};

/** Carries a refusal out of the transaction it rolls back. */
class AssignAbort {
  constructor(readonly result: Err) {}
}

/** The capture under review whose document is this file, with its bytes. */
function captureOfDocument(ctx: WorkspaceContext, fileId: string): { id: string; sha256: string } | undefined {
  return ctx.store.db
    .prepare("SELECT id, sha256 FROM captures WHERE workspace_id = ? AND document_id = ? AND status = 'needs_review' ORDER BY created_at, rowid LIMIT 1")
    .get(ctx.workspaceId, fileId) as { id: string; sha256: string } | undefined;
}

/** Put a document the released assignment filed on the open line back in Belege ohne Buchung. */
function unfileFromLine(ctx: WorkspaceContext, a: BelegAssignment, keep: ReadonlySet<string>): void {
  const at = ctx.clock.now();
  for (const f of a.files) {
    if (keep.has(f.fileId)) continue;
    ctx.store.db
      .prepare(
        `UPDATE stored_file SET entity_kind = NULL, entity_id = NULL, updated_at = ?, linked_by = ?, linked_by_seat = 'person'
          WHERE workspace_id = ? AND id = ? AND entity_kind = 'bank_txn' AND entity_id = ?
            AND EXISTS (SELECT 1 FROM captures c WHERE c.workspace_id = stored_file.workspace_id AND c.document_id = stored_file.id AND c.status = 'needs_review')`,
      )
      .run(at, ctx.actor, ctx.workspaceId, f.fileId, a.bankTxnId);
  }
}

/**
 * `assign_beleg`: a PERSON says these files are the receipt of this open bank line (see the module note).
 * Idempotent per key; assigning exactly the line's standing person assignment again answers `alreadyAssigned`.
 */
export function assignBeleg(ctx: WorkspaceContext, input: AssignBelegInput): Result<AssignBelegOk> {
  const human = assignHumanOnly(ctx);
  if (human !== undefined) return human;
  const reads = bothReadRights(ctx);
  if (reads !== undefined) return reads;
  const capable = ctx.capabilities.assert(editCapabilityForKind('bank_txn'));
  if (!capable.ok) return capable;
  const guard = requireString(input.bankTxnId, 'bankTxnId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  if (!Array.isArray(input.fileIds) || input.fileIds.length === 0 || input.fileIds.length > MAX_ASSIGNMENT_FILES) {
    return err('invalid_input', { field: 'fileIds', reason: `one to ${MAX_ASSIGNMENT_FILES} file ids` });
  }
  if (input.fileIds.some((f) => typeof f !== 'string' || f.length === 0) || new Set(input.fileIds).size !== input.fileIds.length) {
    return err('invalid_input', { field: 'fileIds', reason: 'distinct, non-empty file ids' });
  }
  const bankTxnId = input.bankTxnId as string;
  const fileIds = [...(input.fileIds as string[])].sort();
  const scopedKey = JSON.stringify(['assign_beleg', bankTxnId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result<AssignBelegOk>>(ctx.workspaceId, scopedKey, 'assign_beleg');
  if (replayed !== undefined) return replayed;
  try {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'assign_beleg', () => {
      const row = readBankTxn(ctx, bankTxnId);
      if (row === undefined) throw new AssignAbort(err('not_found', { bankTxnId }) as Err);
      const state = lineStateOf(ctx, row).state;
      if (state !== 'open') throw new AssignAbort(err('line_not_open', { bankTxnId, state, reason: 'a receipt is assigned to an open line; a booked one takes it with files_link' }) as Err);
      const files: BelegAssignmentFile[] = [];
      for (const fileId of fileIds) {
        const file = ctx.store.db
          .prepare(
            `SELECT f.id, f.sha256, f.entity_kind, f.entity_id, f.pending_delete,
                    EXISTS (SELECT 1 FROM stored_file s WHERE s.workspace_id = f.workspace_id AND s.supersedes_id = f.id) AS superseded
               FROM stored_file f WHERE f.workspace_id = ? AND f.id = ?`,
          )
          .get(ctx.workspaceId, fileId) as { id: string; sha256: string; entity_kind: string | null; entity_id: string | null; pending_delete: number; superseded: number } | undefined;
        if (file === undefined || file.pending_delete !== 0) throw new AssignAbort(err('not_found', { field: 'fileIds', fileId }) as Err);
        if (file.superseded !== 0) throw new AssignAbort(err('not_head_version', { fileId }) as Err);
        const capture = captureOfDocument(ctx, fileId);
        if (capture === undefined) throw new AssignAbort(err('beleg_not_captured', { fileId, reason: 'only a captured receipt under review is assigned; capture it first' }) as Err);
        const figures = currentFiguresOf(ctx, capture.id);
        if (figures === null) throw new AssignAbort(err('beleg_without_amount', { fileId, captureId: capture.id, reason: 'the capture states no amount; state it first' }) as Err);
        // The document may be unlinked, on this line already, or on another bank line that is open or
        // ignored (it moves here); anything else holds it.
        if (file.entity_kind !== null && !(file.entity_kind === 'bank_txn' && file.entity_id === bankTxnId)) {
          const elsewhere = file.entity_kind === 'bank_txn' && file.entity_id !== null ? readBankTxn(ctx, file.entity_id) : undefined;
          const movable = elsewhere !== undefined && ['open', 'ignored'].includes(lineStateOf(ctx, elsewhere).state);
          if (!movable) throw new AssignAbort(err('file_filed_elsewhere', { fileId, entityKind: file.entity_kind }) as Err);
        }
        // The one holder read; an ASSIGNMENT holder is replaced below (a person always wins), any other refuses.
        const holders = receiptHolders(ctx, file.sha256, { target: { kind: 'bank_txn', id: bankTxnId }, exceptFileIds: [fileId] }).filter((h) => h.entityKind !== ASSIGNMENT_HOLDER_KIND);
        if (holders.length > 0) throw new AssignAbort(err('receipt_already_booked', { fileId, holders }) as Err);
        files.push({ fileId, captureId: capture.id, sha256: file.sha256, amountMinor: figures.amountMinor, currency: figures.currency, vatMinor: figures.vatMinor, matchJson: currentEngineSnapshotOf(ctx, capture.id) });
      }
      const current = activeAssignmentOf(ctx, bankTxnId);
      if (current !== undefined && current.source === 'person' && current.files.map((f) => f.fileId).join('|') === fileIds.join('|')) {
        return ok<AssignBelegOk>({ assignmentId: current.id, bankTxnId, fileIds, replaced: [], alreadyAssigned: true });
      }
      const replaced: string[] = [];
      const keep = new Set(fileIds);
      // A person always wins: the line's own assignment, and any assignment holding one of these receipts.
      const others = activeAssignments(ctx).filter(
        (a) => a.bankTxnId === bankTxnId || a.files.some((f) => keep.has(f.fileId) || files.some((n) => n.captureId === f.captureId || n.sha256 === f.sha256)),
      );
      for (const a of others) {
        // A41.3 v3 reason table: an explicit replace blocks the pair, `person` for a person row, `person_rejected`
        // for an engine row.
        if (!closeAssignment(ctx, a.id, { state: 'released', reason: a.source === 'person' ? 'person' : 'person_rejected' })) continue;
        replaced.push(a.id);
        if (a.source === 'person') unfileFromLine(ctx, a, a.bankTxnId === bankTxnId ? keep : new Set());
      }
      // File each document on the open line, the capture kept under review (r1 P4): the booking closes it.
      for (const f of files) {
        const linked = linkFile(ctx, { fileId: f.fileId, entityKind: 'bank_txn', entityId: bankTxnId });
        if (!linked.ok) throw new AssignAbort(linked as Err);
      }
      const assignmentId = insertAssignment(ctx, { bankTxnId, source: 'person', files });
      return ok<AssignBelegOk>({ assignmentId, bankTxnId, fileIds, replaced, alreadyAssigned: false });
    });
  } catch (e) {
    if (e instanceof AssignAbort) return e.result;
    throw e;
  }
}

// --- A41.3 follow-ups: a FILED file assigned in one act (the drop on a row, a new version) ----------------------

/** The human-only setting that decides what a file a person drops on an OPEN bank line becomes (D172). */
export const DROP_ON_OPEN_LINE_SETTING = 'belege.drop_on_open_line';
export const DROP_ON_OPEN_LINE_MODES = ['assign', 'assign_if_stated', 'file'] as const;
export type DropOnOpenLineMode = (typeof DROP_ON_OPEN_LINE_MODES)[number];

export interface AssignBelegFileInput {
  bankTxnId?: unknown;
  fileId?: unknown;
  idempotencyKey?: unknown;
  /** N02 R1: a person's confirmation that these bytes, already evidence of a live booking, back this line too. */
  bookAgain?: unknown;
  overrideReason?: unknown;
}

export type AssignBelegFileOk = {
  bankTxnId: string;
  fileId: string;
  /** The capture the act created (or the one under review it found for this very document); null under `file`. */
  captureId: string | null;
  /** The person's assignment, or null when the act only filed (`file`, or `assign_if_stated` without an amount). */
  assignmentId: string | null;
  /** Where the assigned amount came from: the file's own bytes, the line (the person's drop states it), or none. */
  amountFrom: 'receipt' | 'line' | null;
  /** Why nothing was assigned (`file`: the setting; `beleg_without_amount`: assign_if_stated and no amount). */
  notAssigned: 'setting_file' | 'beleg_without_amount' | null;
  /** The assignments the hold plan released first (a person over TILL's own row elsewhere, or a move). */
  released: string[];
  alreadyAssigned: boolean;
};

/**
 * `assign_beleg_file` (A41.3 follow-ups): a PERSON says this FILED file is the receipt of this OPEN bank line, and
 * TILL captures it and assigns it in ONE act. The file is one a person filed (a drop on the row: `files_upload`
 * with the D142 per-intent key, then this verb with its own) or the new version of an assigned receipt that a
 * `move` left filed on the line ("Neue Version, bitte zuordnen"). Human-only (`assignHumanOnly`), both read rights
 * (I-E), the line's edit right and `manage_files` (it files and captures).
 *
 * THE WRITE-ORDER RULE (A41.3 v3). Every refusal is decided first, read-only, in this order:
 *  1. the line (this workspace, open, no active assignment: a line that holds one keeps it, and the file is then
 *     filed with `files_link` as D142 does; the standing person assignment of exactly this file is `alreadyAssigned`);
 *  2. the file (this workspace, the head of its chain, not pending delete, unlinked or already on this line, a mime
 *     the capture queue accepts, no live capture over the same bytes on another document: `beleg_already_captured`);
 *  3. THE HOLD PLAN (`holdPlan`, act `link`, the line as target): bytes another line's assignment holds: a person
 *     over TILL's own row releases it `person_overrode`; over a person's row `belege.assigned_move` decides;
 *  4. THE RECEIPT GUARD (`receiptHolderGuard`, N02's book-again rule) with the plan's releases excepted: bytes a
 *     live booking holds are refused under `files.duplicate_beleg = refuse`, asked for (`bookAgain` with a reason)
 *     under `confirm`, and pass under `allow`; an open line is judged here, before it holds the receipt.
 * Only then it writes: the plan (`applyHoldPlan`), the confirmation, the link (`linkFile`, the one link writer),
 * the capture (`captureStoredDocument`), the person's amount when the bytes state none, and the assignment.
 *
 * `belege.drop_on_open_line` (D172, human-only): `assign` (default) as above, a file whose bytes state no amount
 * takes the LINE's amount and currency as the person's statement (the drop on that line says it), ONLY for the
 * person's own fresh drop (critic r1 F1, `isFreshPersonDrop`; any other file is treated as `assign_if_stated`, and
 * its capture records the bytes' origin, never the clicking seat); `assign_if_stated`
 * assigns only bytes that state their amount, else it files and captures and the line waits; `file` files only
 * (the D142 path, through `linkFile`), nothing captured, nothing assigned.
 */
export function assignBelegFile(ctx: WorkspaceContext, input: AssignBelegFileInput): Result<AssignBelegFileOk> {
  const human = assignHumanOnly(ctx);
  if (human !== undefined) return human;
  const reads = bothReadRights(ctx);
  if (reads !== undefined) return reads;
  for (const capability of [editCapabilityForKind('bank_txn'), 'manage_files']) {
    const capable = ctx.capabilities.assert(capability);
    if (!capable.ok) return capable;
  }
  const guard = requireString(input.bankTxnId, 'bankTxnId') ?? requireString(input.fileId, 'fileId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  if (input.bookAgain !== undefined && typeof input.bookAgain !== 'boolean') return err('invalid_input', { field: 'bookAgain' });
  if (input.overrideReason !== undefined && typeof input.overrideReason !== 'string') return err('invalid_input', { field: 'overrideReason' });
  const bankTxnId = input.bankTxnId as string;
  const fileId = input.fileId as string;
  const scopedKey = JSON.stringify(['assign_beleg_file', bankTxnId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result<AssignBelegFileOk>>(ctx.workspaceId, scopedKey, 'assign_beleg_file');
  if (replayed !== undefined) return replayed;
  const answer = (o: Partial<AssignBelegFileOk>): Result<AssignBelegFileOk> =>
    ok<AssignBelegFileOk>({ bankTxnId, fileId, captureId: null, assignmentId: null, amountFrom: null, notAssigned: null, released: [], alreadyAssigned: false, ...o });
  try {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'assign_beleg_file', () => {
      // 1. The line.
      const row = readBankTxn(ctx, bankTxnId);
      if (row === undefined) throw new AssignAbort(err('not_found', { bankTxnId }) as Err);
      const state = lineStateOf(ctx, row).state;
      if (state !== 'open') throw new AssignAbort(err('line_not_open', { bankTxnId, state, reason: 'a receipt is assigned to an open line; a booked one takes it with files_link' }) as Err);
      const mode = getSetting<DropOnOpenLineMode>(ctx, DROP_ON_OPEN_LINE_SETTING);
      const current = activeAssignmentOf(ctx, bankTxnId);
      if (current !== undefined) {
        if (current.source === 'person' && current.files.length === 1 && current.files[0]!.fileId === fileId) {
          return answer({ captureId: current.files[0]!.captureId, assignmentId: current.id, alreadyAssigned: true });
        }
        if (mode !== 'file') throw new AssignAbort(err('line_assigned', { bankTxnId, reason: 'the line holds an assigned receipt; release it first ("Lösen"), or file the document with files_link' }) as Err);
      }
      // 2. The file.
      const file = ctx.store.db
        .prepare(
          `SELECT f.id, f.sha256, f.mime, f.entity_kind, f.entity_id, f.pending_delete,
                  EXISTS (SELECT 1 FROM stored_file s WHERE s.workspace_id = f.workspace_id AND s.supersedes_id = f.id) AS superseded
             FROM stored_file f WHERE f.workspace_id = ? AND f.id = ?`,
        )
        .get(ctx.workspaceId, fileId) as { id: string; sha256: string; mime: string; entity_kind: string | null; entity_id: string | null; pending_delete: number; superseded: number } | undefined;
      if (file === undefined || file.pending_delete !== 0) throw new AssignAbort(err('not_found', { field: 'fileId', fileId }) as Err);
      if (file.superseded !== 0) throw new AssignAbort(err('not_head_version', { fileId }) as Err);
      const onLine = file.entity_kind === 'bank_txn' && file.entity_id === bankTxnId;
      if (file.entity_kind !== null && !onLine) throw new AssignAbort(err('file_filed_elsewhere', { fileId, entityKind: file.entity_kind }) as Err);
      if (mode === 'file') {
        // The D142 path: the link alone, through the one link writer (its own hold plan inside).
        if (!onLine) {
          const linked = linkFile(ctx, { fileId, entityKind: 'bank_txn', entityId: bankTxnId });
          if (!linked.ok) throw new AssignAbort(linked as Err);
        }
        return answer({ notAssigned: 'setting_file' });
      }
      // Critic r1 F1 (I-F): only the person's OWN fresh drop (a person seat's upload, never filed, version 1,
      // proven from the stored row) may take the line's amount; any other bytes (an agent's file, an approved
      // draft's, a file filed before, a new version) are assigned only on an amount of their own
      // (`assign_if_stated`), and their capture keeps the bytes' origin (`captureStoredDocument`).
      const freshDrop = isFreshPersonDrop(ctx, fileId);
      const effective: DropOnOpenLineMode = mode === 'assign' && !freshDrop ? 'assign_if_stated' : mode;
      const own = captureOfDocument(ctx, fileId);
      if (own === undefined) {
        if (!isCaptureAcceptedMime(file.mime)) throw new AssignAbort(err('unsupported_mime', { fileId, mime: file.mime, accepted: [...CAPTURE_ACCEPTED_MIMES] }) as Err);
        const twin = liveCaptureOfBytes(ctx, file.sha256);
        if (twin !== undefined) throw new AssignAbort(err('beleg_already_captured', { fileId, captureId: twin.id, status: twin.status, reason: 'these bytes are already a capture of another document; assign that one' }) as Err);
      }
      // 3. The hold plan (A41.3 v3, the one enforcement), read-only.
      const target = { kind: 'bank_txn', id: bankTxnId };
      const plan = holdPlan(ctx, { sha256: file.sha256, fileId, target, act: 'link' });
      if ((plan as { ok?: unknown }).ok === false) throw new AssignAbort(plan as Err);
      const hold = plan as HoldPlan;
      // 4. N02's book-again rule, the plan's releases excepted, read-only until `record()`.
      const judged = receiptHolderGuard(ctx, file.sha256, target, {
        exceptFileIds: [fileId],
        exceptAssignmentIds: hold.exceptAssignmentIds,
        override: { bookAgain: input.bookAgain, overrideReason: input.overrideReason },
      });
      if ((judged as { ok?: unknown }).ok === false) throw new AssignAbort(judged as Err);
      const lineAmount = Math.abs(row.amount_minor);
      // The writes, in order: the plan, the confirmation, the link, the capture, the figures, the assignment.
      applyHoldPlan(ctx, hold);
      (judged as GuardPass).record();
      if (!onLine) {
        const linked = linkFile(ctx, { fileId, entityKind: 'bank_txn', entityId: bankTxnId });
        if (!linked.ok) throw new AssignAbort(linked as Err);
      }
      const captureId = own?.id ?? captureStoredDocument(ctx, fileId, file.sha256);
      let figures = currentFiguresOf(ctx, captureId);
      let amountFrom: 'receipt' | 'line' = 'receipt';
      if (figures === null) {
        if (effective === 'assign_if_stated' || lineAmount === 0) {
          return answer({ captureId, notAssigned: 'beleg_without_amount', released: hold.releases.map((r) => r.assignmentId) });
        }
        statePersonFigures(ctx, captureId, { minor: lineAmount, currency: row.currency });
        figures = currentFiguresOf(ctx, captureId);
        amountFrom = 'line';
        if (figures === null) throw new AssignAbort(err('beleg_without_amount', { fileId, captureId }) as Err);
      }
      const assignmentId = insertAssignment(ctx, {
        bankTxnId,
        source: 'person',
        files: [{ fileId, captureId, sha256: file.sha256, amountMinor: figures.amountMinor, currency: figures.currency, vatMinor: figures.vatMinor, matchJson: currentEngineSnapshotOf(ctx, captureId) }],
      });
      return answer({ captureId, assignmentId, amountFrom, released: hold.releases.map((r) => r.assignmentId) });
    });
  } catch (e) {
    if (e instanceof AssignAbort) return e.result;
    if (e instanceof ReceiptGuardAbort) return e.result;
    throw e;
  }
}

/**
 * A41.3 follow-ups: the NEW VERSION a person's `files_new_version` left filed on an open line under
 * `belege.assigned_move = move` (no capture, no assignment: the line waits for a person), or null. I-E: null for a seat that may not read receipts and bank lines, like the
 * assignment view.
 */
export function newVersionToAssignView(ctx: WorkspaceContext, bankTxnId: string): { fileId: string } | null {
  if (!holdsRead(ctx, BELEG_READ_CAPABILITY) || !holdsRead(ctx, BANK_LINE_READ_CAPABILITY)) return null;
  if (activeAssignmentOf(ctx, bankTxnId) !== undefined) return null;
  const fileId = newVersionAwaitingAssignment(ctx, bankTxnId);
  return fileId === null ? null : { fileId };
}

/**
 * Critic A41.3 follow-ups r1 F1: where the bytes of the marked new version came from (`storedBytesSeat`): `machine`
 * for an agent's version a person approved (or one of unknown origin), else `person`; null when there is no mark.
 * The Studio shows a machine's version as such, and its "Zuordnen" captures it as a machine intake, so its figures
 * back no unattended booking until a person confirms them ("Zahlen bestätigen").
 */
export function newVersionOriginOf(ctx: WorkspaceContext, mark: { fileId: string } | null): 'person' | 'machine' | null {
  if (mark === null) return null;
  return storedBytesSeat(ctx, mark.fileId) === 'person' ? 'person' : 'machine';
}

export interface ReleaseBelegInput {
  bankTxnId?: unknown;
  idempotencyKey?: unknown;
}

export type ReleaseBelegOk = { bankTxnId: string; releasedAssignmentId: string | null; alreadyReleased: boolean };

/** `release_beleg`: a PERSON says the line's assigned receipt is not its receipt (see the module note). */
export function releaseBeleg(ctx: WorkspaceContext, input: ReleaseBelegInput): Result<ReleaseBelegOk> {
  const human = assignHumanOnly(ctx);
  if (human !== undefined) return human;
  const reads = bothReadRights(ctx);
  if (reads !== undefined) return reads;
  const capable = ctx.capabilities.assert(editCapabilityForKind('bank_txn'));
  if (!capable.ok) return capable;
  const guard = requireString(input.bankTxnId, 'bankTxnId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const bankTxnId = input.bankTxnId as string;
  if (readBankTxn(ctx, bankTxnId) === undefined) return err('not_found', { bankTxnId });
  const scopedKey = JSON.stringify(['release_beleg', bankTxnId, input.idempotencyKey]);
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'release_beleg', () => {
    const a = activeAssignmentOf(ctx, bankTxnId);
    if (a === undefined) return ok<ReleaseBelegOk>({ bankTxnId, releasedAssignmentId: null, alreadyReleased: true });
    // A41.3 v3 reason table: an explicit "Lösen" blocks that pair, `person` on a person row, `person_rejected` on
    // an engine row (the person says the engine's pairing is wrong, H2).
    closeAssignment(ctx, a.id, { state: 'released', reason: a.source === 'person' ? 'person' : 'person_rejected' });
    if (a.source === 'person') unfileFromLine(ctx, a, new Set());
    return ok<ReleaseBelegOk>({ bankTxnId, releasedAssignmentId: a.id, alreadyReleased: false });
  });
}

export interface ConfirmCaptureFiguresInput {
  /**
   * One entry per capture: `expected` is what the person SAW, the capture's bytes (`sha256`) and every engine
   * field (`fields`, the `ENGINE_CAPTURE_KEYS` set: `{ key: value }` as `list_captures` / `get_capture` answer them
   * in `engineFields`, an absent key absent).
   */
  captures?: unknown;
  idempotencyKey?: unknown;
}

export type ConfirmCaptureFiguresOk = {
  confirmed: { captureId: string; amountMinor: number; currency: string; vatMinor: number | null; alreadyConfirmed: boolean }[];
};

/** The live state a person confirms: the bytes and every engine field. */
export function confirmableStateOf(ctx: WorkspaceContext, captureId: string): { sha256: string; fields: Partial<Record<string, unknown>> } | undefined {
  const c = ctx.store.db.prepare('SELECT sha256 FROM captures WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, captureId) as { sha256: string } | undefined;
  if (c === undefined) return undefined;
  const rows = ctx.store.db
    .prepare('SELECT key, value FROM capture_fields WHERE workspace_id = ? AND capture_id = ? AND superseded = 0')
    .all(ctx.workspaceId, captureId) as { key: string; value: string }[];
  return { sha256: c.sha256, fields: engineFieldValuesOf(rows) };
}

/**
 * `confirm_capture_figures`: a PERSON confirms one or more captures under review ("Zahlen bestätigen", I-F),
 * EXACTLY AS THEY SAW THEM (security review of the Studio wiring: an agent could otherwise edit the figures
 * between the person's read and the click). Every entry carries the REQUIRED `expected` state; under the write
 * lock, any capture whose bytes or engine fields differ from it refuses the WHOLE call `figures_changed`
 * (naming every such captureId) and nothing is confirmed. All or nothing; a capture whose newest confirmation
 * already names its live state answers `alreadyConfirmed` and writes no row.
 */
export function confirmCaptureFigures(ctx: WorkspaceContext, input: ConfirmCaptureFiguresInput): Result<ConfirmCaptureFiguresOk> {
  const human = assignHumanOnly(ctx);
  if (human !== undefined) return human;
  const reads = ctx.capabilities.assert(BELEG_READ_CAPABILITY);
  if (!reads.ok) return reads;
  const capable = ctx.capabilities.assert('manage_files');
  if (!capable.ok) return capable;
  const guard = requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  if (!Array.isArray(input.captures) || input.captures.length === 0 || input.captures.length > MAX_CONFIRM_CAPTURES) {
    return err('invalid_input', { field: 'captures', reason: `one to ${MAX_CONFIRM_CAPTURES} entries { captureId, expected: { sha256, fields } }` });
  }
  const entries: { captureId: string; expected: { sha256: string; fields: unknown } }[] = [];
  for (const [index, e] of (input.captures as unknown[]).entries()) {
    const entry = e as { captureId?: unknown; expected?: { sha256?: unknown; fields?: unknown } } | null;
    if (entry === null || typeof entry !== 'object' || typeof entry.captureId !== 'string' || entry.captureId.length === 0) {
      return err('invalid_input', { field: 'captures', index, reason: 'captureId required' });
    }
    const expected = entry.expected;
    if (
      expected === null ||
      expected === undefined ||
      typeof expected !== 'object' ||
      typeof expected.sha256 !== 'string' ||
      expected.fields === null ||
      typeof expected.fields !== 'object' ||
      Array.isArray(expected.fields)
    ) {
      return err('invalid_input', { field: 'captures', index, reason: 'expected { sha256, fields } is required: the state the person saw' });
    }
    entries.push({ captureId: entry.captureId, expected: { sha256: expected.sha256, fields: expected.fields } });
  }
  if (new Set(entries.map((e) => e.captureId)).size !== entries.length) return err('invalid_input', { field: 'captures', reason: 'distinct capture ids' });
  const scopedKey = JSON.stringify(['confirm_capture_figures', input.idempotencyKey]);
  try {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'confirm_capture_figures', () => {
      // Under the write lock: EVERY capture is checked against what the person saw before anything is written.
      const changed: string[] = [];
      for (const { captureId, expected } of entries) {
        const c = ctx.store.db.prepare('SELECT status FROM captures WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, captureId) as { status: string } | undefined;
        if (c === undefined) throw new AssignAbort(err('not_found', { captureId }) as Err);
        if (c.status !== 'needs_review') throw new AssignAbort(err('invalid_state', { captureId, status: c.status }) as Err);
        const live = confirmableStateOf(ctx, captureId)!;
        if (live.sha256 !== expected.sha256 || !engineFieldsMatch(live.fields, expected.fields)) changed.push(captureId);
      }
      if (changed.length > 0) {
        throw new AssignAbort(err('figures_changed', { captureIds: changed, reason: 'the receipt changed since you saw it; read it again and confirm what it says now' }) as Err);
      }
      const out: ConfirmCaptureFiguresOk['confirmed'] = [];
      const at = ctx.clock.now();
      for (const { captureId } of entries) {
        const c = ctx.store.db.prepare('SELECT sha256 FROM captures WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, captureId) as { sha256: string };
        const figures = currentFiguresOf(ctx, captureId);
        if (figures === null) throw new AssignAbort(err('beleg_without_amount', { captureId, reason: 'the capture states no amount; state it first' }) as Err);
        const newest = newestConfirmation(ctx, captureId);
        // Critic A41.3 r1 S1/S2: the person confirms every engine field (figures and match keys).
        const snapshot = currentEngineSnapshotOf(ctx, captureId);
        const already = newest !== undefined && newest.sha256 === c.sha256 && sameFigures(newest.figures, figures) && newest.matchJson === snapshot;
        if (!already) {
          ctx.store.db
            .prepare(
              `INSERT INTO capture_figure_confirmation (id, workspace_id, capture_id, sha256, amount_minor, currency, vat_minor, match_json, confirmed_by, confirmed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(ctx.ids.next('capconf'), ctx.workspaceId, captureId, c.sha256, figures.amountMinor, figures.currency, figures.vatMinor, snapshot, ctx.actor, at);
          ctx.audit.record({ entityKind: 'capture', entityId: captureId, action: 'confirm_figures', actor: ctx.actor, at });
        }
        out.push({ captureId, amountMinor: figures.amountMinor, currency: figures.currency, vatMinor: figures.vatMinor, alreadyConfirmed: already });
      }
      return ok<ConfirmCaptureFiguresOk>({ confirmed: out });
    });
  } catch (e) {
    if (e instanceof AssignAbort) return e.result;
    throw e;
  }
}

// --- The read model (I-E) ----------------------------------------------------------------------------

/** A line's active assignment as the inbox shows it to a seat that may read receipts. */
export interface BelegAssignmentView {
  assignmentId: string;
  source: 'engine_unique' | 'person';
  createdAt: string;
  files: { fileId: string; captureId: string; amountMinor: number; currency: string; vatMinor: number | null }[];
}

/**
 * The line's active assignment, or null. I-E: null for a seat that may not read receipts or bank lines, so an
 * assignment row never reaches it.
 */
export function belegAssignmentView(ctx: WorkspaceContext, bankTxnId: string): BelegAssignmentView | null {
  if (!holdsRead(ctx, BELEG_READ_CAPABILITY) || !holdsRead(ctx, BANK_LINE_READ_CAPABILITY)) return null;
  const a = activeAssignmentOf(ctx, bankTxnId);
  if (a === undefined) return null;
  return {
    assignmentId: a.id,
    source: a.source,
    createdAt: a.createdAt,
    files: a.files.map((f) => ({ fileId: f.fileId, captureId: f.captureId, amountMinor: f.amountMinor, currency: f.currency, vatMinor: f.vatMinor })),
  };
}
