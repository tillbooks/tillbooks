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
    });
  }
  return out;
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
