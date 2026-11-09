/**
 * N02 (D183), RECEIPT UNIQUENESS (R1), the re-cut after three critic FAILs on one class of defect.
 *
 * THE RULE, one sentence: within a workspace one receipt (its sha256) evidences at most ONE live
 * accounting record, unless a PERSON confirms a second with a reason.
 *
 * WHY ONE GUARD. Rounds 1 to 3 each found another door (attach, capture_commit, a pending Vorschlag)
 * through which the same receipt reached a second booking, because each door carried its own duplicate
 * check. This module is the one judgment; every door asks it, and `RECEIPT_DOORS` / `RECEIPT_GUARD_EXEMPT`
 * name every place in the code that links a file to a booking record or writes a receipt pointer, held
 * equal to the code by `test/files/receipt-guard-doors.test.mjs` (derived from the code, not from field
 * names).
 *
 * LIVE HOLDERS of a receipt, other than the caller's own file row and own Vorschlag:
 *  - a file with that sha256 linked to a journal entry that is not reversed, a vendor bill that
 *    is not void, an expense claim that is not rejected or reversed, a payment, a document, or a bank
 *    line with an active booking decision (not ignored, not reopened). A SUPERSEDED version counts as much
 *    as the head (security review): a booking's evidence is its whole file chain, so replacing the bytes
 *    of a booked receipt never frees the old receipt for a second booking;
 *  - a RECEIPT POINTER to such a file: a vendor bill's `receipt_ref` (not void) or an expense line's
 *    `receipt_document_id` on a claim that is not rejected or reversed. A pointer is a booking's own
 *    statement of its receipt even where no file link was made;
 *  - a RESERVATION: the same bytes stored pending for ANOTHER Vorschlag still pending. A draft or a
 *    release sees only reservations made before its own (first come, first booked); a direct call counts
 *    every live one. A draft that names an existing filed twin makes no reservation; the approval-time
 *    check catches it.
 * A holder that IS the target record is no conflict, and neither is one the target bank line's own
 * decision settles (E1): the payment it records and that payment's allocations (the bill or invoice it
 * pays), the vendor bills of a payment run it matches, the entry it links. A receipt on a bill and on the
 * bank line that pays it is one booking.
 *
 * ONLY A LIVE TARGET IS JUDGED: a link to a record that is not live (a bank line still open or ignored, a
 * reversed entry, a void bill) books nothing. The one record that can BECOME live afterwards is a bank
 * line, and its booking or match judges every file it holds then (`bankLineReceiptRefusal`, called by
 * `writeLineLink`), with its own decision's settlement known. So a receipt filed on an open line that will
 * pay a bill already holding it is no conflict once the line pays that bill.
 *
 * THE OUTCOME (`files.duplicate_beleg`: confirm, the default; allow; refuse):
 *  - a PERSON's direct call refuses `receipt_already_booked`, naming the holders, unless it passes
 *    `bookAgain: true` with an `overrideReason`: recorded in `receipt_override` and on the audit chain;
 *  - a GOVERNED seat may never pass `bookAgain` (`human_only`); a hit on its call answers
 *    `receipt_already_booked` with `proposeInstead`, and the transport seam DRAFTS it, even at an `auto`
 *    dial, with the holders stored on the Vorschlag for its card;
 *  - the APPROVAL of a Vorschlag takes `bookAgain` + `overrideReason` on `approve_drafted_action` itself
 *    and is judged against the holders AT APPROVAL TIME: a holder the card did not show refuses
 *    `holders_changed` (the card then shows the new list), a known one needs the person's confirmation;
 *  - `refuse` refuses every hit, a confirmation included; `allow` skips the rule.
 */

import { createHash } from 'node:crypto';

import type { WorkspaceContext } from '../context.js';
import { err } from '../result.js';
import type { Err } from '../result.js';
import { getSetting } from '../settings/settings.js';
import { isGovernedSeat } from '../access/capability.js';

/** The record kinds a receipt is BOOKED on (or on its way to a booking: a draft bill already counts). */
export const RECEIPT_BOOKING_KINDS: readonly string[] = ['journal_entry', 'document', 'payment', 'bank_txn', 'vendor_bill', 'expense_claim'];

export function isReceiptBookingKind(kind: unknown): boolean {
  return typeof kind === 'string' && RECEIPT_BOOKING_KINDS.includes(kind);
}

/**
 * THE DOORS, derived from the code (`test/files/receipt-guard-doors.test.mjs` scans `src/` and fails on a
 * site in neither map, and on an entry no site matches): every `linkFile` call whose entity kind can be a
 * booking kind, every SQL write of a receipt pointer (`vendor_bill.receipt_ref`,
 * `expense_line.receipt_document_id`), every write of a file's link (`stored_file.entity_kind` /
 * `entity_id`) and every write of a bank line's decision (the liveness transition). Keyed `file#function`.
 */
export const RECEIPT_DOORS: Readonly<Record<string, string>> = {
  'src/core/files/files.ts#linkFile': 'the chokepoint: a link to a booking kind asks the guard, the row\'s own current link excluded (it moves); a row already on this record is not judged again',
  'src/api/file-actions.ts#fileActions': 'files_link: the Studio attach path (Bank, Journal, Files) and the agent verb, through linkFile',
  'src/core/files/attach.ts#linkOrAbort': 'attach on post_entry, book_bank_line, create_vendor_bill and record_expense, a Vorschlag\'s release, and the drop-link redemption onto a booking, through linkFile',
  'src/core/files/files.ts#linkReceiptPointer': 'a receipt pointer naming a stored file links it to its record, through linkFile',
  'src/core/purchase/capture.ts#captureCommit': 'capture_commit to a vendor bill: its document is linked to the bill through linkFile (guarded), then attach_receipt points at it (the same record, not judged again)',
  'src/core/purchase/vendorBill.ts#insertDraft': 'create_vendor_bill / record_expense: a receiptRef naming a stored file is linked through linkReceiptPointer',
  'src/core/purchase/vendorBill.ts#attachReceipt': 'attach_receipt: a receiptRef naming a stored file is linked through linkReceiptPointer',
  'src/core/hr/claims.ts#linkLineReceipt': 'the line\'s receipt is linked to its claim through linkFile (guarded; the confirmation is recorded there, once)',
  'src/core/hr/claims.ts#upsertLine': 'expense_line_upsert (and capture_commit to an expense line): a new receiptDocumentId is judged against the claim before the memo',
  'src/core/files/files.ts#newFileVersion': 'files_new_version on a live booking: replacing its receipt is a person\'s act with a reason (receiptReplaceGuard); the old bytes stay a holder, new bytes booked elsewhere are judged',
  'src/core/banking/bankLines.ts#insertDecision': 'the liveness transition: writeLineLink, the one caller, judges every file the line holds once a booked or matched decision exists (E1 applied)',
  'src/core/banking/belegAssignment.ts#assignBelegFile': 'assign_beleg_file (A41.3 follow-ups): files a filed file on an OPEN bank line through linkFile after its own hold plan (holdPlan, applied first) and the receipt guard over the open line (N02 book-again rule, the plan\'s releases excepted), then captures and assigns it; the line is judged again when it is booked',
  'src/core/banking/belegAssignment.ts#assignBeleg': 'assign_beleg (A41.3): files a captured receipt on an OPEN bank line through linkFile; it refuses bytes a live booking holds (receiptHolders) before linking, and the line is judged again when it is booked (the liveness transition)',
};

/** What is deliberately NOT a door, each with its reason (same keys, same scan). */
export const RECEIPT_GUARD_EXEMPT: Readonly<Record<string, string>> = {
  'src/core/files/files.ts#repointFileLinks': 'a contact merge re-points the links of the merged-away record to its survivor: no booking kind, no new booking',
  'src/core/banking/bankLines.ts#supersedeActiveLink': 'a reopen supersedes the active decision: the line stops being live, nothing is booked',
  'src/core/store/migrations.ts#adoptPreA39BankDecisions': 'the A39 schema migration adopts decisions taken before the decision table existed: no new booking',
  'src/core/banking/belegHold.ts#applyHoldPlan': 'the hold plan (A41.3 re-cut v3) un-files a moved receipt group from its old line (entity_kind and entity_id set NULL), inside the door that already passed the guard for the new target: it removes a filing, so no booking gains a receipt',
  'src/core/banking/belegAssignment.ts#unfileFromLine': 'release_beleg (A41.3) takes a document a person assignment filed on an OPEN line back to Belege ohne Buchung (unlinked): it removes a filing from a record that books nothing, so no booking gains a receipt',
};

/**
 * Copies of books, outside the scan because they write rows generically (no literal column list):
 * restore and environment copy (`src/core/data/portability.ts`), the landscape copy and seed
 * (`src/core/landscape`), the migration and extraction importers (`src/core/migration`). Each copies
 * books whose receipts were judged when they were booked.
 */
export const RECEIPT_GUARD_BOOK_COPIES: readonly string[] = ['src/core/data/portability.ts', 'src/core/landscape', 'src/core/migration'];

/** The kind a RESERVATION holder carries: the Vorschlag its pending receipt waits with. */
export const RESERVATION_KIND = 'drafted_action';

export interface ReceiptHolder {
  fileId: string;
  entityKind: string;
  entityId: string | null;
  /** The Vorschlag a reservation waits with, else null (a filed holder). */
  reservedBy: string | null;
  /**
   * A41.3 re-cut v3: an ACTIVE receipt assignment is a holder (`entityKind` `beleg_assignment`, `entityId` its
   * line): its id, its source and its line. Absent on every other holder.
   */
  assignmentId?: string;
  source?: 'engine_unique' | 'person';
  bankTxnId?: string;
}

/** A41.3 re-cut v3: the holder kind of an active receipt assignment. */
export const ASSIGNMENT_HOLDER_KIND = 'beleg_assignment';

/** The assignment holders of a holder list, as a refusal names them (`{ bankTxnId, assignmentId, source }`). */
export function assignmentHoldersOf(holders: readonly ReceiptHolder[]): { bankTxnId: string; assignmentId: string; source: 'engine_unique' | 'person' }[] {
  return holders
    .filter((h) => h.entityKind === ASSIGNMENT_HOLDER_KIND && h.assignmentId !== undefined)
    .map((h) => ({ bankTxnId: h.bankTxnId as string, assignmentId: h.assignmentId as string, source: h.source as 'engine_unique' | 'person' }));
}

/**
 * The right that reads receipts (A41 I-E). Kept equal to `BELEG_READ_CAPABILITY` (belegMatch.ts, which imports this
 * module, so the constant is restated here; a test asserts they agree).
 */
export const HOLD_READ_CAPABILITY = 'read_master_data';

/**
 * A41.3 follow-ups (code critic LOW b): the right that reads bank lines, kept equal to `BANK_LINE_READ_CAPABILITY`
 * (belegMatch.ts; restated for the same reason, a test asserts they agree). A hold names a LINE, so it is shown
 * only to a seat that may read both halves, exactly as the inbox's assignment view (`belegAssignmentView`).
 */
export const HOLD_BANK_READ_CAPABILITY = 'read_sales';

/** May this seat be shown WHICH line holds a receipt (both reads, I-E)? Every holder emitter asks this one rule. */
export function seatReadsHolds(ctx: WorkspaceContext): boolean {
  return ctx.capabilities.assert(HOLD_READ_CAPABILITY).ok && ctx.capabilities.assert(HOLD_BANK_READ_CAPABILITY).ok;
}

/** The one uniform marker a seat without the receipt read right sees for every assignment hold. */
export const HELD_MARKER_KIND = 'receipt_held';

/** A holder as a seat is shown it: a filed or reserved holder, an assignment hold, or the uniform marker. */
export interface HolderView {
  entityKind: string;
  entityId: string | null;
  reservedBy: string | null;
  fileId?: string;
  assignmentId?: string;
  bankTxnId?: string;
  source?: 'engine_unique' | 'person';
}

/**
 * A41.3 r4 C1 (I-E), THE ONE REDACTION of holders, used by every emitter (the `receipt_assigned` refusals, the
 * drafted card, capture intake's `alreadyBooked`): an assignment hold (any holder naming an `assignmentId`) is shown
 * as `{ entityKind: 'beleg_assignment', entityId: <line>, reservedBy: null, assignmentId, bankTxnId, source }` to a
 * seat holding BOTH the receipt and the bank-line read right (`seatReadsHolds`, A41.3 follow-ups: aligned with the
 * inbox's assignment view); any other seat gets ONE `{ entityKind: 'receipt_held', entityId: null,
 * reservedBy: null }` in place of all of them (no line, no id, no source), so it learns "held" and nothing more.
 * Other holders pass unchanged.
 */
export function holdersForSeat(
  ctx: WorkspaceContext,
  holders: readonly { assignmentId?: string; bankTxnId?: string; source?: 'engine_unique' | 'person'; entityKind?: string; entityId?: string | null; reservedBy?: string | null; fileId?: string }[],
): HolderView[] {
  const reads = seatReadsHolds(ctx);
  const out: HolderView[] = [];
  let held = false;
  for (const h of holders) {
    if (h.assignmentId === undefined && h.entityKind !== ASSIGNMENT_HOLDER_KIND) {
      out.push(h as HolderView);
      continue;
    }
    if (!reads) {
      held = true;
      continue;
    }
    const line = (h.bankTxnId ?? h.entityId ?? null) as string | null;
    out.push({
      entityKind: ASSIGNMENT_HOLDER_KIND,
      entityId: line,
      reservedBy: null,
      ...(h.assignmentId !== undefined ? { assignmentId: h.assignmentId } : {}),
      ...(line !== null ? { bankTxnId: line } : {}),
      ...(h.source !== undefined ? { source: h.source } : {}),
    });
  }
  if (held) out.push({ entityKind: HELD_MARKER_KIND, entityId: null, reservedBy: null });
  return out;
}

export interface ReceiptTarget {
  kind: string;
  id: string | null;
}

export interface ReceiptOverride {
  bookAgain?: unknown;
  overrideReason?: unknown;
}

/** Where a reservation sits in the queue: only reservations before it count for a draft or a release. */
export interface ReservationMark {
  createdAt: string;
  rowid: number;
}

// --- the per-call frame (a person's confirmation, an approval in progress) -------------------------

interface Frame {
  bookAgain: boolean;
  reason: string;
  approvingActionId: string | null;
}

const frames: Frame[] = [];

/**
 * Run `fn` with a person's confirmation in force (`bookAgain` + `overrideReason` of the call, or of
 * `approve_drafted_action` while it replays a Vorschlag). The guard reads the innermost frame.
 */
export function withReceiptOverride<T>(override: ReceiptOverride & { approvingActionId?: string | null }, fn: () => T): T {
  frames.push({
    bookAgain: override.bookAgain === true,
    reason: typeof override.overrideReason === 'string' ? override.overrideReason.trim() : '',
    // Named (an id, or null for a call of its own): that; absent: the enclosing frame's.
    approvingActionId: 'approvingActionId' in override ? (override.approvingActionId ?? null) : (frames[frames.length - 1]?.approvingActionId ?? null),
  });
  try {
    return fn();
  } finally {
    frames.pop();
  }
}

function frame(): Frame | undefined {
  return frames[frames.length - 1];
}

/** The Vorschlag whose approval is replaying right now, if any. */
export function approvingReceiptAction(): string | null {
  return frame()?.approvingActionId ?? null;
}

// --- E1: what a bank line's own decision settles ------------------------------------------------------

function key(kind: string, id: string | null): string {
  return `${kind}:${id ?? ''}`;
}

/** The records a bank line's ACTIVE decision books or settles (E1), as `kind:id` keys. */
export function settledByBankLine(ctx: WorkspaceContext, bankTxnId: string): Set<string> {
  const out = new Set<string>();
  const decision = ctx.store.db
    .prepare(
      `SELECT d.entry_id, d.payment_id, l.kind AS link_kind, l.target_id AS link_target
         FROM bank_line_decision d LEFT JOIN bank_txn_link l ON l.id = d.link_id AND l.workspace_id = d.workspace_id
        WHERE d.workspace_id = ? AND d.bank_txn_id = ? AND d.superseded_at IS NULL AND d.state IN ('booked', 'matched')`,
    )
    .get(ctx.workspaceId, bankTxnId) as { entry_id: string | null; payment_id: string | null; link_kind: string | null; link_target: string | null } | undefined;
  if (decision === undefined) return out;
  const payments: string[] = [];
  if (decision.entry_id !== null) out.add(key('journal_entry', decision.entry_id));
  if (decision.payment_id !== null) payments.push(decision.payment_id);
  if (decision.link_kind === 'payment_batch' && decision.link_target !== null) {
    const items = ctx.store.db
      .prepare('SELECT vendor_bill_id, posted_payment_id FROM payment_batch_item WHERE workspace_id = ? AND batch_id = ?')
      .all(ctx.workspaceId, decision.link_target) as { vendor_bill_id: string | null; posted_payment_id: string | null }[];
    for (const item of items) {
      if (item.vendor_bill_id !== null) out.add(key('vendor_bill', item.vendor_bill_id));
      if (item.posted_payment_id !== null) payments.push(item.posted_payment_id);
    }
  }
  for (const paymentId of payments) {
    out.add(key('payment', paymentId));
    const allocations = ctx.store.db
      .prepare('SELECT target_kind, target_id FROM payment_allocation WHERE workspace_id = ? AND payment_id = ?')
      .all(ctx.workspaceId, paymentId) as { target_kind: string; target_id: string }[];
    for (const a of allocations) out.add(key(a.target_kind, a.target_id));
    const entry = ctx.store.db.prepare('SELECT journal_entry_id FROM payment WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, paymentId) as
      | { journal_entry_id: string | null }
      | undefined;
    if (entry?.journal_entry_id) out.add(key('journal_entry', entry.journal_entry_id));
  }
  return out;
}

/**
 * E1 at DRAFT time, before the decision exists: what a `book_bank_line` input says it will settle (the
 * documents or bills of an open-item booking, the entry it matches, the bills of the payment run).
 */
export function settledByBankInput(ctx: WorkspaceContext, target: unknown): Set<string> {
  const out = new Set<string>();
  if (typeof target !== 'object' || target === null) return out;
  const t = target as Record<string, unknown>;
  const addDoc = (id: unknown): void => {
    if (typeof id !== 'string') return;
    out.add(key('document', id));
    out.add(key('vendor_bill', id));
  };
  if (t.kind === 'open_item') {
    addDoc(t.documentId);
    if (Array.isArray(t.allocations)) for (const a of t.allocations) addDoc((a as { documentId?: unknown } | null)?.documentId);
  }
  if (t.kind === 'existing_entry' && typeof t.entryId === 'string') out.add(key('journal_entry', t.entryId));
  if (t.kind === 'payment_batch' && typeof t.batchId === 'string') {
    const items = ctx.store.db.prepare('SELECT vendor_bill_id FROM payment_batch_item WHERE workspace_id = ? AND batch_id = ?').all(ctx.workspaceId, t.batchId) as {
      vendor_bill_id: string | null;
    }[];
    for (const item of items) if (item.vendor_bill_id !== null) out.add(key('vendor_bill', item.vendor_bill_id));
  }
  return out;
}

// --- the holders -----------------------------------------------------------------------------------

export interface HolderQuery {
  target: ReceiptTarget;
  /** The caller's own file rows (never a holder of themselves). */
  exceptFileIds?: readonly string[];
  /** The caller's own Vorschlag (its reservations are no holders). */
  exceptActionId?: string | null;
  /** A draft or a release: only reservations ordered before this one count. Absent: every live one. */
  reservationBefore?: ReservationMark | null;
  /** E1 at draft time (`settledByBankInput`), on top of the target line's own decision. */
  alsoSettled?: ReadonlySet<string>;
  /** A41.3 v3: assignments the act itself releases first (its `holdPlan`): no holders against it. */
  exceptAssignmentIds?: readonly string[];
  /** A41.3 v3, the engine pass: this capture's OWN engine row is re-validated, so it holds nothing against it. */
  keepEngineCaptureId?: string;
}

/**
 * A41.3 re-cut v3, THE ONE HOLDER READ (`receiptHolders`, replacing `liveReceiptHolders`): the live and draft
 * holders of a receipt (see the module note) PLUS every ACTIVE receipt assignment (person or engine) over these
 * bytes. An assignment is never a holder against its own line (the query's target), against an assignment the act
 * releases first (`exceptAssignmentIds`), or, for the engine pass, against its own capture's engine row
 * (`keepEngineCaptureId`). A GL archive entry is no holder (not a booking kind: a read-only copy of another
 * ledger, which backs the same real transaction during the cutover). Tenant-scoped, read-only.
 */
export function receiptHolders(ctx: WorkspaceContext, sha256: string, q: HolderQuery): ReceiptHolder[] {
  const except = new Set(q.exceptFileIds ?? []);
  const marks = RECEIPT_BOOKING_KINDS.map(() => '?').join(', ');
  const filed = ctx.store.db
    .prepare(
      `SELECT f.id, f.entity_kind, f.entity_id FROM stored_file f
        WHERE f.workspace_id = ? AND f.sha256 = ? AND f.entity_kind IN (${marks})
          AND CASE f.entity_kind
                WHEN 'journal_entry' THEN NOT EXISTS (SELECT 1 FROM journal_entry r WHERE r.workspace_id = f.workspace_id AND r.reverses_entry_id = f.entity_id)
                WHEN 'vendor_bill' THEN EXISTS (SELECT 1 FROM vendor_bill b WHERE b.workspace_id = f.workspace_id AND b.id = f.entity_id AND b.status <> 'void')
                WHEN 'expense_claim' THEN EXISTS (SELECT 1 FROM expense_claim c WHERE c.workspace_id = f.workspace_id AND c.id = f.entity_id AND c.status NOT IN ('rejected', 'cancelled', 'reversed'))
                WHEN 'document' THEN EXISTS (SELECT 1 FROM document d WHERE d.workspace_id = f.workspace_id AND d.id = f.entity_id AND d.status <> 'cancelled')
                WHEN 'bank_txn' THEN EXISTS (SELECT 1 FROM bank_line_decision d WHERE d.workspace_id = f.workspace_id AND d.bank_txn_id = f.entity_id
                                               AND d.superseded_at IS NULL AND d.state IN ('booked', 'matched'))
                ELSE 1
              END
        ORDER BY f.created_at ASC, f.rowid ASC`,
    )
    .all(ctx.workspaceId, sha256, ...RECEIPT_BOOKING_KINDS) as { id: string; entity_kind: string; entity_id: string }[];
  // The receipt POINTERS (A17 `receipt_ref`, E02 `receipt_document_id`) to a file with these bytes.
  const pointers = ctx.store.db
    .prepare(
      `SELECT f.id, 'vendor_bill' AS entity_kind, b.id AS entity_id FROM vendor_bill b
         JOIN stored_file f ON f.workspace_id = b.workspace_id AND f.id = b.receipt_ref
        WHERE b.workspace_id = ? AND f.sha256 = ? AND b.status <> 'void'
       UNION ALL
       SELECT f.id, 'expense_claim' AS entity_kind, c.id AS entity_id FROM expense_line l
         JOIN expense_claim c ON c.workspace_id = l.workspace_id AND c.id = l.claim_id
         JOIN stored_file f ON f.workspace_id = l.workspace_id AND f.id = l.receipt_document_id
        WHERE l.workspace_id = ? AND f.sha256 = ? AND c.status NOT IN ('rejected', 'cancelled', 'reversed')`,
    )
    .all(ctx.workspaceId, sha256, ctx.workspaceId, sha256) as { id: string; entity_kind: string; entity_id: string }[];
  filed.push(...pointers);
  const settled = new Set<string>(q.alsoSettled ?? []);
  if (q.target.kind === 'bank_txn' && q.target.id !== null) for (const k of settledByBankLine(ctx, q.target.id)) settled.add(k);
  const out: ReceiptHolder[] = [];
  for (const f of filed) {
    if (except.has(f.id) && !pointerOf(pointers, f)) continue;
    if (f.entity_kind === q.target.kind && f.entity_id === q.target.id) continue;
    if (settled.has(key(f.entity_kind, f.entity_id))) continue;
    // E1, the other direction: a bank line whose ACTIVE decision books or settles the target is the same
    // booking as the target, so it holds nothing against it.
    if (f.entity_kind === 'bank_txn' && q.target.id !== null && settledByBankLine(ctx, f.entity_id).has(key(q.target.kind, q.target.id))) continue;
    out.push({ fileId: f.id, entityKind: f.entity_kind, entityId: f.entity_id, reservedBy: null });
  }
  const before = q.reservationBefore ?? null;
  const reservations = ctx.store.db
    .prepare(
      `SELECT p.id, p.action_id FROM stored_file_pending p
         JOIN agent_action a ON a.workspace_id = p.workspace_id AND a.id = p.action_id AND a.status = 'pending'
        WHERE p.workspace_id = ? AND p.sha256 = ? AND p.action_id <> ?
          ${before === null ? '' : 'AND (p.created_at < ? OR (p.created_at = ? AND p.rowid < ?))'}
        ORDER BY p.created_at ASC, p.rowid ASC`,
    )
    .all(ctx.workspaceId, sha256, q.exceptActionId ?? '', ...(before === null ? [] : [before.createdAt, before.createdAt, before.rowid])) as {
    id: string;
    action_id: string;
  }[];
  for (const r of reservations) {
    if (except.has(r.id)) continue;
    out.push({ fileId: r.id, entityKind: RESERVATION_KIND, entityId: r.action_id, reservedBy: r.action_id });
  }
  const exceptAssignments = new Set(q.exceptAssignmentIds ?? []);
  const assigned = ctx.store.db
    .prepare(
      `SELECT f.assignment_id, f.bank_txn_id, f.file_id, f.capture_id, a.source FROM beleg_assignment_file f
         JOIN beleg_assignment a ON a.workspace_id = f.workspace_id AND a.id = f.assignment_id
        WHERE f.workspace_id = ? AND f.sha256 = ? AND f.active = 1 AND a.state = 'active'
        ORDER BY a.created_at, a.rowid`,
    )
    .all(ctx.workspaceId, sha256) as { assignment_id: string; bank_txn_id: string; file_id: string; capture_id: string; source: 'engine_unique' | 'person' }[];
  for (const r of assigned) {
    if (q.target.kind === 'bank_txn' && q.target.id === r.bank_txn_id) continue;
    if (exceptAssignments.has(r.assignment_id)) continue;
    if (q.keepEngineCaptureId !== undefined && r.source === 'engine_unique' && r.capture_id === q.keepEngineCaptureId) continue;
    out.push({ fileId: r.file_id, entityKind: ASSIGNMENT_HOLDER_KIND, entityId: r.bank_txn_id, reservedBy: null, assignmentId: r.assignment_id, source: r.source, bankTxnId: r.bank_txn_id });
  }
  return dedupe(out);
}

/**
 * A pointer row is a holder even for the caller's own file row: excluding the row a caller links (its own
 * current LINK moves with it) must never hide another record's POINTER to the same file.
 */
function pointerOf(pointers: readonly { id: string; entity_kind: string; entity_id: string }[], f: { id: string; entity_kind: string; entity_id: string }): boolean {
  return pointers.includes(f);
}

/** The holders a Vorschlag's card showed (stored when it was drafted or last refused). */
export function storedVorschlagHolders(ctx: WorkspaceContext, actionId: string): ReceiptHolder[] {
  const row = ctx.store.db.prepare('SELECT holders_json FROM vorschlag_receipt_holders WHERE workspace_id = ? AND action_id = ?').get(ctx.workspaceId, actionId) as
    | { holders_json: string }
    | undefined;
  if (row === undefined) return [];
  try {
    const parsed = JSON.parse(row.holders_json) as unknown;
    return Array.isArray(parsed) ? (parsed as ReceiptHolder[]) : [];
  } catch {
    return [];
  }
}

/** Store (replace) the holders a Vorschlag's card shows. Inside the caller's transaction. */
export function storeVorschlagHolders(ctx: WorkspaceContext, actionId: string, holders: readonly ReceiptHolder[]): void {
  const unique = dedupe(holders);
  const existing = ctx.store.db.prepare('SELECT id FROM vorschlag_receipt_holders WHERE workspace_id = ? AND action_id = ?').get(ctx.workspaceId, actionId) as
    | { id: string }
    | undefined;
  if (existing === undefined) {
    if (unique.length === 0) return;
    ctx.store.db
      .prepare('INSERT INTO vorschlag_receipt_holders (id, workspace_id, action_id, holders_json, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(ctx.ids.next('vrh'), ctx.workspaceId, actionId, JSON.stringify(unique), ctx.clock.now());
    return;
  }
  ctx.store.db
    .prepare('UPDATE vorschlag_receipt_holders SET holders_json = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
    .run(JSON.stringify(unique), ctx.clock.now(), ctx.workspaceId, existing.id);
}

function holderKey(h: Pick<ReceiptHolder, 'entityKind' | 'entityId'>): string {
  return key(h.entityKind, h.entityId);
}

function dedupe(holders: readonly ReceiptHolder[]): ReceiptHolder[] {
  const seen = new Set<string>();
  const out: ReceiptHolder[] = [];
  for (const h of holders) {
    const k = holderKey(h);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
  }
  return out;
}

// --- the guard -------------------------------------------------------------------------------------

export interface GuardPass {
  holders: ReceiptHolder[];
  /** Write the person's confirmation (inside the act's transaction); a no-op when nothing was confirmed. */
  record(): void;
}

function isErr(v: unknown): v is Err {
  return typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false;
}

/**
 * THE GUARD (see the module note). Read-only until `record()`: the caller runs it before its write, so a
 * refusal is never memoised, and calls `record()` inside its own transaction.
 */
export function receiptHolderGuard(ctx: WorkspaceContext, sha256: string, target: ReceiptTarget, q: Omit<HolderQuery, 'target'> & { override?: ReceiptOverride } = {}): GuardPass | Err {
  const none: GuardPass = { holders: [], record: () => {} };
  // A41.3 re-cut v3: an ACTIVE assignment is an explicit claim, not a duplicate booking, so it is judged BEFORE
  // `files.duplicate_beleg` and `bookAgain` and neither passes it. An act that releases the assignment first
  // names it (`exceptAssignmentIds`, its `holdPlan`); any other assignment holder refuses `receipt_assigned`.
  const claimed = assignmentHoldersOf(
    receiptHolders(ctx, sha256, {
      target,
      ...(q.exceptFileIds !== undefined ? { exceptFileIds: q.exceptFileIds } : {}),
      ...(q.exceptAssignmentIds !== undefined ? { exceptAssignmentIds: q.exceptAssignmentIds } : {}),
    }),
  );
  if (claimed.length > 0) return err('receipt_assigned', { holders: holdersForSeat(ctx, claimed), target, reason: 'the receipt is assigned to another bank line; release it there first (release_beleg)' }) as Err;
  const mode = getSetting<string>(ctx, 'files.duplicate_beleg');
  if (mode === 'allow') return none;
  const current = frame();
  const bookAgain = q.override !== undefined ? q.override.bookAgain === true : current?.bookAgain === true;
  const reason = q.override !== undefined ? (typeof q.override.overrideReason === 'string' ? q.override.overrideReason.trim() : '') : (current?.reason ?? '');
  const approving = current?.approvingActionId ?? null;
  const governed = isGovernedSeat(ctx.store, ctx.actor);
  if (bookAgain && governed) {
    return err('human_only', { field: 'bookAgain', reason: 'only a person confirms a second booking of a receipt; an agent proposes it' }) as Err;
  }
  const holders = dedupe(
    receiptHolders(ctx, sha256, {
      target,
      ...(q.exceptAssignmentIds !== undefined ? { exceptAssignmentIds: q.exceptAssignmentIds } : {}),
      ...(q.exceptFileIds !== undefined ? { exceptFileIds: q.exceptFileIds } : {}),
      exceptActionId: q.exceptActionId ?? approving,
      ...(q.reservationBefore !== undefined ? { reservationBefore: q.reservationBefore } : {}),
      ...(q.alsoSettled !== undefined ? { alsoSettled: q.alsoSettled } : {}),
    }),
  );
  if (holders.length === 0) return none;
  if (approving !== null) {
    const shown = new Set(storedVorschlagHolders(ctx, approving).map(holderKey));
    if (holders.some((h) => !shown.has(holderKey(h)))) {
      return err('holders_changed', { actionId: approving, holders, setting: 'files.duplicate_beleg' }) as Err;
    }
  }
  if (mode === 'refuse') return err('receipt_already_booked', { holders, target, setting: 'files.duplicate_beleg' }) as Err;
  if (governed) return err('receipt_already_booked', { holders, target, proposeInstead: true }) as Err;
  if (!bookAgain) return err('receipt_already_booked', { holders, target, override: 'bookAgain with overrideReason' }) as Err;
  if (reason.length === 0) return err('reason_required', { field: 'overrideReason' }) as Err;
  return {
    holders,
    record: () => {
      const at = ctx.clock.now();
      const id = ctx.ids.next('rov');
      ctx.store.db
        .prepare(
          `INSERT INTO receipt_override (id, workspace_id, sha256, target_kind, target_id, holders_json, reason, action_id, actor, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, ctx.workspaceId, sha256, target.kind, target.id, JSON.stringify(holders), reason, approving, ctx.actor, at);
      ctx.audit.record({ entityKind: 'receipt_override', entityId: id, action: 'confirm', actor: ctx.actor, at });
    },
  };
}

/**
 * Is the record a link would go to LIVE (see the module note)? A payment and a document are; a journal
 * entry until it is reversed; a vendor bill until it is void; an expense claim until it is rejected or
 * reversed; a bank line only with an active booked or matched decision. A record that does not exist (a
 * draft's target not created yet) counts as live: the guard then judges it.
 */
export function isLiveReceiptTarget(ctx: WorkspaceContext, kind: string, id: string | null): boolean {
  if (id === null) return true;
  switch (kind) {
    case 'journal_entry':
      return ctx.store.db.prepare('SELECT 1 AS p FROM journal_entry WHERE workspace_id = ? AND reverses_entry_id = ?').get(ctx.workspaceId, id) === undefined;
    case 'vendor_bill':
      return ctx.store.db.prepare("SELECT 1 AS p FROM vendor_bill WHERE workspace_id = ? AND id = ? AND status = 'void'").get(ctx.workspaceId, id) === undefined;
    case 'expense_claim':
      return ctx.store.db.prepare("SELECT 1 AS p FROM expense_claim WHERE workspace_id = ? AND id = ? AND status IN ('rejected', 'cancelled', 'reversed')").get(ctx.workspaceId, id) === undefined;
    case 'document':
      return ctx.store.db.prepare("SELECT 1 AS p FROM document WHERE workspace_id = ? AND id = ? AND status = 'cancelled'").get(ctx.workspaceId, id) === undefined;
    case 'bank_txn':
      return (
        ctx.store.db
          .prepare("SELECT 1 AS p FROM bank_line_decision WHERE workspace_id = ? AND bank_txn_id = ? AND superseded_at IS NULL AND state IN ('booked', 'matched')")
          .get(ctx.workspaceId, id) !== undefined
      );
    default:
      return true;
  }
}

/**
 * R1 (security review), REPLACING A BOOKED RECEIPT: a new version with different bytes of a file linked to
 * a LIVE booking. The old bytes stay that booking's evidence (a superseded version is still a holder), and
 * the new bytes become it. The new bytes are judged by THE guard itself (`receiptHolderGuard`), so every
 * rule of a link holds here too: live holders and pending reservations, `refuse`, the agent seat, and at
 * an approval the holders as they are NOW (`holders_changed` for one the card did not show). On top of
 * that, and only that, replacing the receipt is a person's act with a reason: a governed seat is refused
 * `human_only`; a person passes `bookAgain` + `overrideReason` (`receipt_replace_needs_reason` otherwise),
 * recorded like any confirmation. `allow` skips the rule. There is NO exemption (security review): E01's
 * signature completion of a file that is a live booking's receipt meets this guard like any other
 * replacement, the person's confirmation carried on `sign_requests_complete` itself. Read-only until
 * `record()`.
 */
export function receiptReplaceGuard(
  ctx: WorkspaceContext,
  file: { id: string; entity_kind: string; entity_id: string },
  newSha: string,
): GuardPass | Err {
  const none: GuardPass = { holders: [], record: () => {} };
  if (getSetting<string>(ctx, 'files.duplicate_beleg') === 'allow') return none;
  if (isGovernedSeat(ctx.store, ctx.actor)) {
    return err('human_only', { field: 'contentBase64', reason: 'replacing the receipt of a live booking is a person\'s act' }) as Err;
  }
  const target: ReceiptTarget = { kind: file.entity_kind, id: file.entity_id };
  const judged = receiptHolderGuard(ctx, newSha, target, { exceptFileIds: [file.id] });
  if (isErr(judged)) return judged;
  // The guard passed: no other holder, or a person confirmed them with a reason (its record() writes it).
  if (judged.holders.length > 0) return judged;
  const current = frame();
  if (current?.bookAgain !== true) {
    return err('receipt_replace_needs_reason', { fileId: file.id, entityKind: file.entity_kind, entityId: file.entity_id, holders: [], override: 'bookAgain with overrideReason' }) as Err;
  }
  const reason = current.reason;
  if (reason.length === 0) return err('reason_required', { field: 'overrideReason' }) as Err;
  return {
    holders: [],
    record: () => {
      const at = ctx.clock.now();
      const id = ctx.ids.next('rov');
      ctx.store.db
        .prepare(
          `INSERT INTO receipt_override (id, workspace_id, sha256, target_kind, target_id, holders_json, reason, action_id, actor, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, ctx.workspaceId, newSha, target.kind, target.id, JSON.stringify([{ replaces: file.id }]), reason, current.approvingActionId, ctx.actor, at);
      ctx.audit.record({ entityKind: 'receipt_override', entityId: id, action: 'confirm', actor: ctx.actor, at });
    },
  };
}

/** The guard for a stored file (by its row): its sha256, its own row excluded. */
export function guardFile(
  ctx: WorkspaceContext,
  file: { id: string; sha256: string },
  target: ReceiptTarget,
  q: Omit<HolderQuery, 'target' | 'exceptFileIds'> & { override?: ReceiptOverride } = {},
): GuardPass | Err {
  return receiptHolderGuard(ctx, file.sha256, target, { ...q, exceptFileIds: [file.id] });
}

/**
 * Thrown where a refusal has no Result channel of its own; the registry and the attach seam answer it as
 * the refusal it carries, after the transaction rolled back.
 */
export class ReceiptGuardAbort extends Error {
  constructor(public readonly result: Err) {
    super(result.error);
  }
}

/**
 * The liveness transition (E1 applied): a bank line becoming live (booked or matched) judges every file
 * it already holds. Called by `writeLineLink` right after the decision row is written, so the decision's
 * own settlement is known; answers the refusal (the caller throws it and the booking rolls back) or null,
 * having recorded any confirmation.
 */
export function bankLineReceiptRefusal(ctx: WorkspaceContext, bankTxnId: string): Err | null {
  const files = ctx.store.db
    .prepare(
      `SELECT f.id, f.sha256 FROM stored_file f
        WHERE f.workspace_id = ? AND f.entity_kind = 'bank_txn' AND f.entity_id = ?`,
    )
    .all(ctx.workspaceId, bankTxnId) as { id: string; sha256: string }[];
  const passes: GuardPass[] = [];
  for (const file of files) {
    const judged = guardFile(ctx, file, { kind: 'bank_txn', id: bankTxnId });
    if (isErr(judged)) return judged;
    passes.push(judged);
  }
  for (const pass of passes) pass.record();
  return null;
}

// --- what a Vorschlag's card shows ------------------------------------------------------------------

function text(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function fileRowOf(ctx: WorkspaceContext, id: string | null): { id: string; sha256: string; entity_kind: string | null; entity_id: string | null } | undefined {
  if (id === null) return undefined;
  return ctx.store.db.prepare('SELECT id, sha256, entity_kind, entity_id FROM stored_file WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, id) as
    | { id: string; sha256: string; entity_kind: string | null; entity_id: string | null }
    | undefined;
}

/**
 * The holders a drafted call of a guarded door would meet, for the Vorschlag's card (R1): the receipt the
 * call names (a file to link, a receipt pointer, a capture's document, the files a bank line holds)
 * against the record it would book. `attach` entries are judged by the attach seam's own staging. A draft
 * makes no reservation here, so every live reservation counts. Read-only.
 */
export function draftReceiptHolders(ctx: WorkspaceContext, verb: string, input: Record<string, unknown>): ReceiptHolder[] {
  // A41.3 re-cut v3 (D7): the card lists every holder the approval will meet. An active assignment holds under
  // `files.duplicate_beleg = allow` too (the hold plan ignores that setting), so only the other holders drop then.
  const merged = dedupe([...draftGuardHolders(ctx, verb, input), ...draftAssignmentHolders(ctx, verb, input)]);
  return getSetting<string>(ctx, 'files.duplicate_beleg') === 'allow' ? merged.filter((h) => h.entityKind === ASSIGNMENT_HOLDER_KIND) : merged;
}

/**
 * The assignment holds a drafted `files_link` / `files_new_version` meets that the guard's read alone does not show
 * (the hold plan's rule): the file's OWN active assignment when the call moves it off its line (any target) or
 * versions it, and every assignment holding its bytes on another line when the target is a booking kind, open or
 * draft included. Read-only.
 */
function draftAssignmentHolders(ctx: WorkspaceContext, verb: string, input: Record<string, unknown>): ReceiptHolder[] {
  if (verb !== 'files_link' && verb !== 'files_new_version') return [];
  const f = fileRowOf(ctx, text(input.fileId));
  if (f === undefined) return [];
  const own = ctx.store.db
    .prepare(
      `SELECT a.id AS assignment_id, a.bank_txn_id, a.source FROM beleg_assignment_file af
         JOIN beleg_assignment a ON a.workspace_id = af.workspace_id AND a.id = af.assignment_id
        WHERE af.workspace_id = ? AND af.file_id = ? AND af.active = 1 AND a.state = 'active' LIMIT 1`,
    )
    .get(ctx.workspaceId, f.id) as { assignment_id: string; bank_txn_id: string; source: 'engine_unique' | 'person' } | undefined;
  const out: ReceiptHolder[] = [];
  const kind = verb === 'files_link' ? text(input.entityKind) : f.entity_kind;
  const id = verb === 'files_link' ? text(input.entityId) : f.entity_id;
  const offItsLine = verb === 'files_new_version' || !(kind === 'bank_txn' && id === own?.bank_txn_id);
  if (own !== undefined && offItsLine) {
    out.push({ fileId: f.id, entityKind: ASSIGNMENT_HOLDER_KIND, entityId: own.bank_txn_id, reservedBy: null, assignmentId: own.assignment_id, source: own.source, bankTxnId: own.bank_txn_id });
  }
  if (verb === 'files_link' && kind !== null && isReceiptBookingKind(kind)) {
    out.push(...receiptHolders(ctx, f.sha256, { target: { kind, id } }).filter((h) => h.entityKind === ASSIGNMENT_HOLDER_KIND));
  }
  return out;
}

function draftGuardHolders(ctx: WorkspaceContext, verb: string, input: Record<string, unknown>): ReceiptHolder[] {
  switch (verb) {
    case 'files_link': {
      const kind = text(input.entityKind);
      const id = text(input.entityId);
      const f = fileRowOf(ctx, text(input.fileId));
      if (f === undefined || kind === null || !isReceiptBookingKind(kind) || (f.entity_kind === kind && f.entity_id === id)) return [];
      if (!isLiveReceiptTarget(ctx, kind, id)) return [];
      return receiptHolders(ctx, f.sha256, { target: { kind, id }, exceptFileIds: [f.id] });
    }
    case 'files_new_version': {
      // The new bytes against the record the file is linked to (the old bytes stay its own evidence).
      const f = fileRowOf(ctx, text(input.fileId));
      const content = text(input.contentBase64);
      if (f === undefined || content === null || f.entity_kind === null || f.entity_id === null || !isReceiptBookingKind(f.entity_kind)) return [];
      const sha = createHash('sha256').update(Buffer.from(content, 'base64')).digest('hex');
      if (sha === f.sha256 || !isLiveReceiptTarget(ctx, f.entity_kind, f.entity_id)) return [];
      return receiptHolders(ctx, sha, { target: { kind: f.entity_kind, id: f.entity_id }, exceptFileIds: [f.id] });
    }
    case 'attach_receipt': {
      const f = fileRowOf(ctx, text(input.receiptRef));
      return f === undefined ? [] : receiptHolders(ctx, f.sha256, { target: { kind: 'vendor_bill', id: text(input.vendorBillId) } });
    }
    case 'create_vendor_bill':
    case 'record_expense': {
      const f = fileRowOf(ctx, text(input.receiptRef));
      return f === undefined ? [] : receiptHolders(ctx, f.sha256, { target: { kind: 'vendor_bill', id: null } });
    }
    case 'expense_line_upsert': {
      const line = typeof input.line === 'object' && input.line !== null ? (input.line as Record<string, unknown>) : {};
      const f = fileRowOf(ctx, text(line.receiptDocumentId));
      return f === undefined ? [] : receiptHolders(ctx, f.sha256, { target: { kind: 'expense_claim', id: text(input.claimId) } });
    }
    case 'capture_commit': {
      const capture = ctx.store.db.prepare('SELECT document_id, sha256 FROM captures WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, text(input.captureId)) as
        | { document_id: string; sha256: string }
        | undefined;
      if (capture === undefined) return [];
      const t = typeof input.target === 'object' && input.target !== null ? (input.target as Record<string, unknown>) : {};
      const target: ReceiptTarget = t.kind === 'vendor_bill' ? { kind: 'vendor_bill', id: null } : { kind: 'expense_claim', id: text(t.claimId) };
      return receiptHolders(ctx, capture.sha256, { target, exceptFileIds: [capture.document_id] });
    }
    case 'book_bank_line': {
      const bankTxnId = text(input.bankTxnId);
      if (bankTxnId === null) return [];
      const alsoSettled = settledByBankInput(ctx, input.target);
      const files = ctx.store.db
        .prepare(
          `SELECT f.id, f.sha256 FROM stored_file f
            WHERE f.workspace_id = ? AND f.entity_kind = 'bank_txn' AND f.entity_id = ?`,
        )
        .all(ctx.workspaceId, bankTxnId) as { id: string; sha256: string }[];
      return dedupe(files.flatMap((f) => receiptHolders(ctx, f.sha256, { target: { kind: 'bank_txn', id: bankTxnId }, exceptFileIds: [f.id], alsoSettled })));
    }
    default:
      return [];
  }
}

/** Merge holders into what a Vorschlag's card already shows (a drop onto it, a converted refusal). */
export function addVorschlagHolders(ctx: WorkspaceContext, actionId: string, holders: readonly ReceiptHolder[]): void {
  if (holders.length === 0) return;
  storeVorschlagHolders(ctx, actionId, [...storedVorschlagHolders(ctx, actionId), ...holders]);
}

/** A guard refusal that the transport seam turns into a Vorschlag (a governed seat met a holder). */
export function isProposeInstead(result: unknown): result is Err & { holders: ReceiptHolder[] } {
  const r = result as { ok?: unknown; error?: unknown; proposeInstead?: unknown } | null;
  return typeof r === 'object' && r !== null && r.ok === false && r.error === 'receipt_already_booked' && r.proposeInstead === true;
}
