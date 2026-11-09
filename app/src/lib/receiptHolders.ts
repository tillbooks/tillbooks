/**
 * N02 (D183), R1 RECEIPT UNIQUENESS, the data half (`src/core/files/receiptGuard.ts`): the records that
 * already hold a receipt, as the engine answers them on a refusal (`holders`) and on a Vorschlag's card
 * (`receiptHolders`), and the one test for a refusal a person may answer with a reason. The dialog and
 * the card's warning live in `components/BookAgain.tsx`.
 */
import type { Err } from './client';

/** One record that already holds the receipt. */
export interface ReceiptHolder {
  entityKind: string;
  entityId: string | null;
  /** The Vorschlag a reservation waits with, else null. */
  reservedBy: string | null;
  /** A41.3 v3, an assignment hold (`beleg_assignment`): the bank line that holds the receipt, and by whom. */
  bankTxnId?: string;
  source?: 'person' | 'engine_unique';
}

/** The person's confirmation, sent with the retried call. */
export interface BookAgainConfirmation {
  bookAgain: true;
  overrideReason: string;
}

/** The holders of a refusal or a card, defensively: an entry the Studio cannot read is left out. */
export function parseReceiptHolders(raw: unknown): ReceiptHolder[] {
  if (!Array.isArray(raw)) return [];
  const out: ReceiptHolder[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const h = entry as Record<string, unknown>;
    if (typeof h.entityKind !== 'string') continue;
    out.push({
      entityKind: h.entityKind,
      entityId: typeof h.entityId === 'string' ? h.entityId : null,
      reservedBy: typeof h.reservedBy === 'string' ? h.reservedBy : null,
      ...(typeof h.bankTxnId === 'string' && h.bankTxnId !== '' ? { bankTxnId: h.bankTxnId } : {}),
      ...(h.source === 'person' || h.source === 'engine_unique' ? { source: h.source } : {}),
    });
  }
  return out;
}

/**
 * A41.3 re-cut v3 (one holder truth): a receipt an active assignment holds on a bank line. A write that would
 * take it elsewhere is refused `receipt_assigned` with these holders (under `belege.assigned_move = refuse`).
 */
export interface AssignmentHolder {
  bankTxnId: string;
  assignmentId: string | null;
  source: 'person' | 'engine_unique' | null;
}

/** The assignment holders of a `receipt_assigned` refusal, defensively. */
export function parseAssignmentHolders(raw: unknown): AssignmentHolder[] {
  if (!Array.isArray(raw)) return [];
  const out: AssignmentHolder[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const h = entry as Record<string, unknown>;
    if (typeof h.bankTxnId !== 'string' || h.bankTxnId === '') continue;
    out.push({
      bankTxnId: h.bankTxnId,
      assignmentId: typeof h.assignmentId === 'string' ? h.assignmentId : null,
      source: h.source === 'person' || h.source === 'engine_unique' ? h.source : null,
    });
  }
  return out;
}

/**
 * A41.3 r4 C1: for a seat without the receipt read right the engine redacts every assignment hold to ONE marker,
 * `{ entityKind: 'receipt_held', entityId: null, reservedBy: null }`: the receipt is held, but by which line is
 * not this seat's to know. It is said in words, with no line, no link and no "Lösen".
 */
export const HELD_MARKER_KIND = 'receipt_held';

/** Does a holder list carry the redaction marker? */
export function hasHeldMarker(raw: unknown): boolean {
  return Array.isArray(raw) && raw.some((h) => typeof h === 'object' && h !== null && (h as { entityKind?: unknown }).entityKind === HELD_MARKER_KIND);
}

/**
 * A `receipt_assigned` refusal: answered by releasing the receipt on its bank line ("Lösen") and acting again,
 * or, redacted (`receipt_held`), only said.
 */
export function isReceiptAssignedRefusal(error: Err | null | undefined): boolean {
  return error !== null && error !== undefined && error.error === 'receipt_assigned';
}

/** The refusals a person may answer with a reason (each carries the engine's `override` hint). */
const CONFIRMABLE = ['receipt_already_booked', 'receipt_replace_needs_reason'];

/**
 * A refusal a person may answer with a reason: `receipt_already_booked` (a second booking of a receipt)
 * or `receipt_replace_needs_reason` (a new version replacing a booked receipt), with the engine's
 * `override` hint. Under `refuse` the hint is absent and the refusal stands.
 */
export function isBookAgainRefusal(error: Err | null | undefined): boolean {
  return error !== null && error !== undefined && CONFIRMABLE.includes(error.error) && typeof error.override === 'string';
}

/** A replacement of a booked receipt (its record first, then any holder of the new bytes). */
export function isReplaceRefusal(error: Err): boolean {
  return error.error === 'receipt_replace_needs_reason';
}
