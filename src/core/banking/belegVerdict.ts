/**
 * A41.3 re-cut v2 (D184, I-A, I-C): THE AUTOBOOK RECEIPT VERDICT, and the one input it reads.
 *
 * ONE CHOKEPOINT. The first A41.3 inferred "which receipt belongs to which line" from scattered state (the
 * pool, files on the line, captures, filing rows, who filed what) and every inference path became a hole
 * (three critic FAILs). This verdict reads exactly ONE input: the line's ACTIVE assignment
 * (`beleg_assignment`, `belegAssignmentStore.ts`), and, by the ids that assignment names, the capture and the
 * file it was made on, to re-check them. It never reads the receipt pool, never asks which files are filed on
 * the line, never matches. `test/banking/a41-3-chokepoint.test.mjs` holds that as a positive guard over this
 * module's source. Who may write an assignment is enumerated in `belegAssignment.ts` (the engine under the
 * write lock, and a person through `assign_beleg`); `files_link` never writes one.
 *
 * THE RE-CHECK (I-C), the same at read time (the digest) and under the write lock (the step):
 *   - exactly one active assignment on the line, else `no_beleg`;
 *   - every capture still under review over the same bytes, its file the head of its chain and not pending
 *     delete, else `beleg_changed`;
 *   - an `engine_unique` row: the live figures AND match keys equal the snapshot and are still trusted under
 *     `belege.autobook_figure_trust` (I-F), else `beleg_changed` (the engine releases it on its next pass);
 *     a `person` row: the person's snapshot is judged (a governed seat's later edit is ignored, I-D, and a
 *     person's own edit released the row already);
 *   - every file's figures fit the line by the A41.1 amount rule (exact, transaction currency, FX
 *     tolerance), else `beleg_amount_differs`;
 *   - the printed VAT (when one states it in the line's currency) within `belege.vat_delta_tolerance_rappen`
 *     of the VAT the booking computes, else `beleg_vat_differs`.
 * The receipt guard is the booking's own (the attach seam inside `book_bank_line`): a refusal there rolls the
 * booking back and the line waits `beleg_in_use`.
 *
 * Pure reads, §H-TENANT on every query.
 */

import type { WorkspaceContext } from '../context.js';
import { getSetting } from '../settings/settings.js';
import { lineBookingDate } from './bankLines.js';
import type { BankTxnRow } from './bankLines.js';
import type { BankProposalTarget } from './bankProposals.js';
import { amountMatch } from './belegMatch.js';
import { compareVat, computedVatOf } from './belegEvidence.js';
import { readLineFactsMap } from './statementFacts.js';
import { activeAssignmentOf, currentEngineSnapshotOf, currentFiguresOf, snapshotOf } from './belegAssignmentStore.js';
import type { BelegAssignment } from './belegAssignmentStore.js';
import { sameFigures } from './belegFigures.js';
import { figuresBackEngine } from './belegTrust.js';

/**
 * Why a line a granted rule would book WAITS for its receipt under `rules.autobook_requires_beleg = on`. A wait
 * is never recorded (an `autobook_run` row is final): the line books on a later tick once its assignment
 * passes. `belege_not_readable` is never a verdict: it is the ONE reason a seat without the receipt read right
 * sees for every waiting line (I-E).
 */
export const AUTOBOOK_WAIT_REASONS = ['no_beleg', 'beleg_changed', 'beleg_amount_differs', 'beleg_vat_differs', 'beleg_in_use', 'belege_not_readable'] as const;
export type AutobookWaitReason = (typeof AUTOBOOK_WAIT_REASONS)[number];

export type BelegVerdict =
  | { kind: 'book'; assignmentId: string; files: { fileId: string }[] }
  | { kind: 'wait'; reason: Exclude<AutobookWaitReason, 'belege_not_readable' | 'beleg_in_use'>; assignmentId: string | null };

/** Is the assignment's receipt still the one it was made on (capture, bytes, file)? */
export function receiptStands(ctx: WorkspaceContext, a: BelegAssignment): boolean {
  const capture = ctx.store.db.prepare('SELECT status, sha256 FROM captures WHERE workspace_id = ? AND id = ?');
  const file = ctx.store.db.prepare(
    `SELECT f.sha256, f.pending_delete,
            EXISTS (SELECT 1 FROM stored_file s WHERE s.workspace_id = f.workspace_id AND s.supersedes_id = f.id) AS superseded
       FROM stored_file f WHERE f.workspace_id = ? AND f.id = ?`,
  );
  for (const f of a.files) {
    const c = capture.get(ctx.workspaceId, f.captureId) as { status: string; sha256: string } | undefined;
    if (c === undefined || c.status !== 'needs_review' || c.sha256 !== f.sha256) return false;
    const r = file.get(ctx.workspaceId, f.fileId) as { sha256: string; pending_delete: number; superseded: number } | undefined;
    if (r === undefined || r.sha256 !== f.sha256 || r.pending_delete !== 0 || r.superseded !== 0) return false;
  }
  return true;
}

/** The step's receipt verdict on one line it would book to `target` (see the module note). */
export function assignmentVerdict(ctx: WorkspaceContext, line: BankTxnRow, target: BankProposalTarget | null): BelegVerdict {
  const a = activeAssignmentOf(ctx, line.id);
  if (a === undefined || a.files.length === 0) return { kind: 'wait', reason: 'no_beleg', assignmentId: null };
  if (!receiptStands(ctx, a)) return { kind: 'wait', reason: 'beleg_changed', assignmentId: a.id };
  if (a.source === 'engine_unique') {
    for (const f of a.files) {
      // Critic A41.3 r1 S1/S2: every engine field the engine paired on (figures AND match keys) still stands.
      if (!sameFigures(snapshotOf(f), currentFiguresOf(ctx, f.captureId)) || f.matchJson !== currentEngineSnapshotOf(ctx, f.captureId) || !figuresBackEngine(ctx, f.captureId)) {
        return { kind: 'wait', reason: 'beleg_changed', assignmentId: a.id };
      }
    }
  }
  const facts = readLineFactsMap(ctx, [line.id]).get(line.id) ?? null;
  const cfg = { fxTolerancePct: getSetting<number>(ctx, 'belege.match_fx_tolerance_pct') };
  const fx = new Map<string, bigint | null>();
  // The FX rule converts at the LINE's own date: the verdict reads nothing a seat can edit after the snapshot
  // (a receipt date is a live capture field), and the tolerance covers a few days of rate movement.
  const date = lineBookingDate(line);
  for (const f of a.files) {
    if (amountMatch(ctx, cfg, { row: line, facts }, { amountMinor: f.amountMinor, currency: f.currency, date }, fx) === null) {
      return { kind: 'wait', reason: 'beleg_amount_differs', assignmentId: a.id };
    }
  }
  const printed = a.files.find((f) => f.vatMinor !== null && f.currency === line.currency)?.vatMinor ?? null;
  if (printed !== null) {
    const computed = computedVatOf(ctx, line, target);
    if (computed !== null && !compareVat(printed, computed, getSetting<number>(ctx, 'belege.vat_delta_tolerance_rappen')).withinTolerance) {
      return { kind: 'wait', reason: 'beleg_vat_differs', assignmentId: a.id };
    }
  }
  return { kind: 'book', assignmentId: a.id, files: a.files.map((f) => ({ fileId: f.fileId })) };
}
