/**
 * A31, THE BILL CHOKEPOINT (critic R3-M1, after R1-M1 and R2-M1; the three-FAIL redesign).
 *
 * WHY THIS MODULE EXISTS. A capture's fields come from two kinds of writer. A BILL writer states a
 * whole QR-bill at once: the deterministic read of the stored bytes (`qr`/`swico` rows, plus the UID
 * vendor match that derives from that read) and a supplied QR payload (`operator`/`agent` rows carrying
 * a `qr_payload_id`). A TYPED writer states one value for one key (the review pane's corrections, an
 * agent's `fields`, a commit's `corrections`). The merge rules were written per key, which is right for
 * a typed value and wrong for a bill: three critic rounds in a row found a bill writer that merged key
 * by key and so mixed two bills (an earlier payload's amount beside a new creditor, R1-M1; the bytes'
 * amount beside a supplied creditor, R2-M1; the bytes' re-read resurrecting what a payload retired,
 * R3-M1). Each fix covered one writer and the next writer reopened the class.
 *
 * SO A BILL IS MERGED IN ONE PLACE. `mergeBill` is the only code that writes, supersedes or retires a
 * row of bill provenance, and every bill writer hands it a WHOLE bill. `applyTypedField` is the only
 * other writer of `capture_fields`, and it refuses bill provenance. No other module writes the table:
 * `test/purchase/capture-bill-chokepoint.test.mjs` scans the engine and fails on any other writer. The
 * scan is lexical; the five writers that build a table name at runtime (the G04 restore wipe, load and
 * env_copy re-point, the env_copy workspace delete, the G12 test-mandate reset, the C00 contact merge)
 * are named in that test with why each is structural and states no bill.
 *
 * THE RULE (`mergeBill`):
 *  - "The bill on the capture" is every live row from a bill source: a row with a `qr_payload_id`, or
 *    a `qr`/`swico` row. Each such row speaks with its bill's authority: its supplier for a payload,
 *    `qr` for the bytes.
 *  - The incoming bill competes as a WHOLE, at bill level: `outranks(incoming authority, row authority)`
 *    must hold for every row of the current bill (the same truth table `decideField` asks per key, both
 *    sides at `high`, because a bill's authority is who states it, not one field's grade). An operator
 *    payload always wins; the bytes' read beats an agent payload and loses to an operator payload; an
 *    agent payload wins only over an earlier agent payload (or an empty bill); a bill re-states itself.
 *  - CORRECTIONS BELONG TO THEIR BILL (owner decision 01.10.2026, after critic R4-L1 and R5-M1). A
 *    typed OPERATOR value on a bill key (`BILL_KEYS`) is part of the bill on the capture and speaks
 *    with the operator's authority, so an agent bill or the bytes' read never takes a corrected capture
 *    over. WHICH bill it is, is decided by what it SAYS (critic R6-M1): `qrbill/identity.ts`
 *    `billIdentity`, the normalised IBAN, creditor, amount or open, currency, reference type,
 *    reference, message and Swico billing information, compared with `captures.bill_identity`, the identity of the bill the live rows came from
 *    (stored when a bill WINS, never by a losing one). Line breaks, the reader, a message or Swico data
 *    added, and any loser in between change nothing. The SAME bill (whoever re-states it, the bytes'
 *    re-read included) never touches a typed operator value. A DIFFERENT winning bill RESETS every bill key to
 *    itself: typed values on bill keys are discarded with the old bill (`superseded = 2`, history kept,
 *    worded in the review drawer), and a key the new bill leaves open has no live value (an open amount
 *    makes the commit ask again, `needs_amount`). Typed values on `TYPED_ONLY_KEYS` (the expense
 *    account, the tax code) are never touched by a bill.
 *  - A WINNER: each key it states replaces the current bill's row for that key (an identical bill value
 *    is left in place, so nothing churns), and every current-bill row whose key it does not state is
 *    RETIRED, kept as superseded history. An open amount therefore clears the other bill's amount.
 *  - A LOSER: nothing of it goes live. Each value it states that the live rows do not already show is
 *    kept once as a superseded loser; nothing is retired.
 *  - The UID vendor match is part of the bill: it is derived from the incoming bill's own Swico UID and
 *    merged with it, so it follows the winning bill and is retired with a losing one's predecessor.
 *  - Typed values on keys no bill states are never retired; a typed value on a bill key stands against
 *    the same bill and goes with its bill when a different one wins.
 *  - An empty bill (bytes with no QR code) states nothing and changes nothing.
 *
 * RE-RUNNING ON UNCHANGED INPUT IS A NO-OP, after any history: the same bill restating itself meets only
 * identical values and typed operator values it never touches, a loser meets its own recorded losers,
 * so no row is added, superseded or retired and `changed` is false. No shortcut decides this: the raw
 * sha256 and "the latest evidence" were both wrong answers to "is it the same bill" (R6-M1). An earlier
 * bill another one replaced is a DIFFERENT bill when supplied again: it takes the capture back, so the
 * operator can always switch back, but the corrections made to it before stay discarded history and
 * must be typed again (decided 01.10.2026). The FIRST bill on a capture with no bill meets earlier typed
 * values through the per-key rules (there is no previous bill to discard them for).
 */

import { createHash } from 'node:crypto';

import type { WorkspaceContext } from '../context.js';
import type { CaptureConfidence, CaptureProvenance, CaptureQrPayloadSource } from './captureEnums.js';
import type { QrDecodeIssue } from './qrbill/decode.js';
import { billIdentity, isCurrentIdentity } from './qrbill/identity.js';
import { locateSpcPayload } from './captureParse.js';
import { getFileContent } from '../files/index.js';

/** Provenances only a bill writer may stamp (the stored bytes' read). */
export const BILL_READ_PROVENANCES: ReadonlySet<string> = new Set(['qr', 'swico']);

const PROVENANCE_RANK: Record<string, number> = { qr: 3, swico: 3, agent: 2, local_model: 1, operator: 4 };
const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

export type IncomingField = { key: string; value: unknown; provenance: CaptureProvenance; confidence: CaptureConfidence };

interface LiveRow {
  id: string;
  key: string;
  value: string;
  confidence: string;
  provenance: string;
  qr_payload_id: string | null;
}

/**
 * Every key a bill can state: the stored bytes' parser and the strict decoder of a supplied payload
 * (creditor, IBAN, amount, currency, reference, dates, message, the Swico S1 keys) plus the vendor match
 * the bill's UID derives. A typed value on one of these keys BELONGS TO ITS BILL (owner decision
 * 01.10.2026, "corrections belong to their bill"): a different winning bill resets it. The keys no bill
 * states are `TYPED_ONLY_KEYS`; `test/purchase/capture-bill-chokepoint.test.mjs` holds that the two lists
 * cover `CAPTURE_FIELD_KEYS` exactly and that no reader emits a typed-only key.
 */
export const BILL_KEYS: ReadonlySet<string> = new Set([
  'vendor_name', 'vendor_uid', 'vendor_contact_id', 'vendor_address', 'iban', 'reference', 'reference_type',
  'amount', 'currency', 'payment_message', 'invoice_no', 'invoice_date', 'due_date', 'customer_reference',
  'vat_rate', 'vat_breakdown', 'import_vat', 'payment_conditions',
]);
/** The keys no bill states (a booking choice, not a fact of the paper): a bill never touches them. */
export const TYPED_ONLY_KEYS: ReadonlySet<string> = new Set(['expense_account_id', 'tax_code', 'doc_type']);

/**
 * `capture_fields.superseded`: 0 is live, 1 superseded (replaced by a later value or retired with its
 * bill), 2 a TYPED value DISCARDED WITH ITS BILL: a correction or confirmation on a bill key that a
 * different winning bill reset (the review drawer words it "Korrektur zur vorherigen Rechnung
 * verworfen"). Every live read is `superseded = 0`, so the third value changes no reader.
 */
export const SUPERSEDED = { live: 0, superseded: 1, discardedWithBill: 2 } as const;

/** What the merge rules decide for one incoming field, before anything is written. */
type FieldPlan =
  | { kind: 'noop' }
  | { kind: 'insert'; superseded: boolean; supersedeId: string | null; supersedeAs?: 1 | 2 };

function liveRowByKey(ctx: WorkspaceContext, captureId: string, key: string): LiveRow | undefined {
  return ctx.store.db
    .prepare('SELECT id, key, value, confidence, provenance, qr_payload_id FROM capture_fields WHERE workspace_id = ? AND capture_id = ? AND key = ? AND superseded = 0')
    .get(ctx.workspaceId, captureId, key) as LiveRow | undefined;
}

/** Is `row` part of a bill (a supplied payload's or the stored bytes' read)? */
function isBillRow(row: { provenance: string; qr_payload_id: string | null }): boolean {
  return row.qr_payload_id !== null || BILL_READ_PROVENANCES.has(row.provenance);
}

/**
 * Rules (2) to (5) as one question: would a write from `incoming` displace the live row `existing`?
 * Asked per key by `decideField` and per bill by `mergeBill`.
 */
export function outranks(
  incoming: { provenance: string; confidence: string },
  existing: { provenance: string; confidence: string },
): boolean {
  // (2) operator is terminal against a non-operator source; a fresh operator write supersedes.
  if (existing.provenance === 'operator' && incoming.provenance !== 'operator') return false;
  if (incoming.provenance === 'operator') return true;
  const c = (CONFIDENCE_RANK[incoming.confidence] ?? 0) - (CONFIDENCE_RANK[existing.confidence] ?? 0);
  if (c !== 0) return c > 0; // (3) higher confidence wins
  const r = (PROVENANCE_RANK[incoming.provenance] ?? 0) - (PROVENANCE_RANK[existing.provenance] ?? 0);
  if (r !== 0) return r > 0; // (4) rank breaks a confidence tie
  return true; // (5) equal rank and confidence: the newer write wins
}

/**
 * The per-key truth table, in evaluation order: (1) an identical value is a no-op; (2) an `operator`
 * row is never overwritten by a non-operator source; (3) the higher confidence wins, the loser kept
 * superseded; (4) at equal confidence `qr`/`swico` > `agent` > `local_model`; (5) at equal rank and
 * confidence the newer write wins.
 */
function decideField(ctx: WorkspaceContext, captureId: string, incoming: IncomingField): FieldPlan {
  const existing = liveRowByKey(ctx, captureId, incoming.key);
  if (existing === undefined) return { kind: 'insert', superseded: false, supersedeId: null };
  if (existing.value === JSON.stringify(incoming.value)) return { kind: 'noop' };
  if (existing.provenance === 'operator' && incoming.provenance !== 'operator') return { kind: 'noop' };
  if (outranks(incoming, existing)) return { kind: 'insert', superseded: false, supersedeId: existing.id };
  return loserPlan(ctx, captureId, incoming);
}

/**
 * A losing value is KEPT, as a superseded row: an auditable disagreement, never a silent drop. But only
 * ONCE: when the same source already lost with the same value at the same confidence, that
 * disagreement is on record, and a re-run must add no row (critic F2).
 */
function loserPlan(ctx: WorkspaceContext, captureId: string, incoming: IncomingField): FieldPlan {
  const recorded = ctx.store.db
    .prepare(
      'SELECT 1 AS hit FROM capture_fields WHERE workspace_id = ? AND capture_id = ? AND key = ? AND value = ? AND provenance = ? AND confidence = ? LIMIT 1',
    )
    .get(ctx.workspaceId, captureId, incoming.key, JSON.stringify(incoming.value), incoming.provenance, incoming.confidence) as
    | { hit: number }
    | undefined;
  if (recorded !== undefined) return { kind: 'noop' };
  return { kind: 'insert', superseded: true, supersedeId: null };
}

/** THE row writer, private to this module. Returns the id of the row it inserted, or null. */
function writeRow(ctx: WorkspaceContext, captureId: string, incoming: IncomingField, plan: FieldPlan, qrPayloadId: string | null): string | null {
  if (plan.kind === 'noop') return null;
  const at = ctx.clock.now();
  if (plan.supersedeId !== null) {
    ctx.store.db
      .prepare('UPDATE capture_fields SET superseded = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(plan.supersedeAs ?? SUPERSEDED.superseded, at, ctx.workspaceId, plan.supersedeId);
  }
  const id = ctx.ids.next('capf');
  ctx.store.db
    .prepare(
      `INSERT INTO capture_fields (id, workspace_id, capture_id, key, value, confidence, provenance, superseded, qr_payload_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ctx.workspaceId, captureId, incoming.key, JSON.stringify(incoming.value), incoming.confidence, incoming.provenance, plan.superseded ? 1 : 0, qrPayloadId, at, at);
  return id;
}

/**
 * A TYPED value for one key (a review-pane correction, an agent's `fields`, a commit's `corrections`):
 * the per-key rules decide. Refuses bill provenance: a `qr`/`swico` value can only come from a whole
 * bill through `mergeBill`, so no caller can launder a typed guess into the trusted read. A typed value
 * equal to the live one is a no-op (rule 1): it needs no pin, because a re-scan of the SAME bill never
 * touches a value and a DIFFERENT bill resets the key either way (owner decision 01.10.2026). Returns
 * whether a row was written.
 */
export function applyTypedField(ctx: WorkspaceContext, captureId: string, incoming: IncomingField): boolean {
  if (BILL_READ_PROVENANCES.has(incoming.provenance)) {
    throw new Error(`applyTypedField: ${incoming.provenance} is a bill provenance; a bill is merged whole through mergeBill`);
  }
  return writeRow(ctx, captureId, incoming, decideField(ctx, captureId, incoming), null) !== null;
}

/**
 * Propose a vendor by matching the Swico `/30/` UID against a C00 contact's `vat_number`, both reduced
 * to the 9-digit numeric UID (spec §2). C00 stores the ESTV form `CHE-###.###.### MWST`, so the digits
 * are formatted back to that shape and matched with a prefix `LIKE`.
 */
function matchVendorByUid(ctx: WorkspaceContext, uid: string): string | null {
  const digits = uid.replace(/\D/g, '').slice(-9);
  if (!/^\d{9}$/.test(digits)) return null;
  const canonical = `CHE-${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}`;
  const row = ctx.store.db
    .prepare('SELECT id FROM contact WHERE workspace_id = ? AND vat_number LIKE ? AND archived = 0 LIMIT 1')
    .get(ctx.workspaceId, `${canonical}%`) as { id: string } | undefined;
  return row?.id ?? null;
}

/** One field of a bill. The stored bytes' read stamps its own `qr`/`swico` per field. */
export interface BillField {
  key: string;
  value: unknown;
  confidence: CaptureConfidence;
  /** Only for the bytes' read (`qr` or `swico`); a payload's fields carry its supplier. */
  provenance?: 'qr' | 'swico';
}

/**
 * A whole bill: its fields, the Swico UID the vendor match derives from (null when none), and WHICH bill
 * it is (`qrbill/identity.ts` `billIdentity` of its SPC payload; null only when none can be read).
 */
export interface Bill {
  fields: readonly BillField[];
  uid: string | null;
  identity: string | null;
}

/** Who states the bill: the stored bytes' deterministic read, or a supplied payload and its evidence. */
export type BillSource =
  | { kind: 'bytes' }
  | { kind: 'payload'; supplier: CaptureQrPayloadSource; payload: string; decoder: string | null; warnings: readonly QrDecodeIssue[] };

export interface BillMergeOutcome {
  /** True when any row was added, superseded or retired. */
  readonly changed: boolean;
  /** `took_over` (it is the live bill now), `lost` (recorded only), or `empty` (it stated nothing). */
  readonly verdict: 'took_over' | 'lost' | 'empty';
  /** The evidence row of a payload that changed something, else null. */
  readonly payloadId: string | null;
}

function storedIdentity(ctx: WorkspaceContext, captureId: string): string | null {
  const row = ctx.store.db.prepare('SELECT bill_identity FROM captures WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, captureId) as
    | { bill_identity: string | null }
    | undefined;
  return row?.bill_identity ?? null;
}

/**
 * The identity of the bill the LIVE rows came from: `captures.bill_identity`, stored whenever a bill
 * wins. A capture whose bill won before the column existed (a book opened by an older TILL), or whose
 * stored identity is of another identity version, has none that compares; then it is derived, once per merge and never stored from here: from the stored document when
 * the live bill is the bytes' own read (the bytes never change), else from the evidence of the newest
 * live payload row. Null when no bill is on the capture.
 */
function currentBillIdentity(ctx: WorkspaceContext, captureId: string, live: readonly LiveRow[]): string | null {
  const stored = storedIdentity(ctx, captureId);
  // Only an identity of the CURRENT version compares; another version's is unknown, never equal or
  // different by accident, so it is re-derived below exactly like a missing one.
  if (isCurrentIdentity(stored)) return stored;
  const billRows = live.filter(isBillRow);
  if (billRows.length === 0) return null;
  const payloadRow = billRows.filter((r) => r.qr_payload_id !== null).at(-1);
  if (payloadRow === undefined) {
    const doc = ctx.store.db.prepare('SELECT document_id FROM captures WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, captureId) as
      | { document_id: string }
      | undefined;
    if (doc === undefined) return null;
    const content = getFileContent(ctx, { fileId: doc.document_id });
    const b64 = content.ok ? (content as { contentBase64?: string }).contentBase64 : undefined;
    const located = typeof b64 === 'string' ? locateSpcPayload(Buffer.from(b64, 'base64').toString('utf8')) : null;
    return located === null ? null : billIdentity(located);
  }
  const evidence = ctx.store.db
    .prepare(
      `SELECT q.payload AS payload FROM capture_fields f JOIN capture_qr_payloads q ON q.id = f.qr_payload_id AND q.workspace_id = f.workspace_id
        WHERE f.workspace_id = ? AND f.capture_id = ? AND f.superseded = 0 AND f.qr_payload_id IS NOT NULL
        ORDER BY q.created_at DESC, q.rowid DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, captureId) as { payload: string } | undefined;
  return evidence === undefined ? null : billIdentity(evidence.payload);
}

/**
 * THE BILL CHOKEPOINT. Merge one WHOLE bill into a capture under the rule in the module header. Must run
 * inside the caller's write transaction (every caller does: intake, extract).
 */
export function mergeBill(ctx: WorkspaceContext, captureId: string, bill: Bill, source: BillSource): BillMergeOutcome {
  const authority: string = source.kind === 'bytes' ? 'qr' : source.supplier;
  const incoming: IncomingField[] = bill.fields.map((f) => ({
    key: f.key,
    value: f.value,
    confidence: f.confidence,
    provenance: source.kind === 'bytes' ? (f.provenance ?? 'qr') : source.supplier,
  }));
  if (incoming.length === 0) return { changed: false, verdict: 'empty', payloadId: null };
  // The vendor match follows the bill it derives from.
  if (bill.uid !== null) {
    const contactId = matchVendorByUid(ctx, bill.uid);
    if (contactId !== null) {
      incoming.push({ key: 'vendor_contact_id', value: contactId, confidence: 'high', provenance: source.kind === 'bytes' ? 'swico' : source.supplier });
    }
  }

  // The bill on the capture: every live bill row, plus every live typed OPERATOR value on a bill key
  // (a correction belongs to its bill and speaks with the operator's authority, so an agent bill or the
  // bytes' read cannot take a corrected capture over).
  const live = ctx.store.db
    .prepare('SELECT id, key, value, confidence, provenance, qr_payload_id FROM capture_fields WHERE workspace_id = ? AND capture_id = ? AND superseded = 0')
    .all(ctx.workspaceId, captureId) as LiveRow[];
  const current = live.filter((row) => isBillRow(row) || (row.provenance === 'operator' && BILL_KEYS.has(row.key)));
  const rowAuthority = (row: LiveRow): string => (row.qr_payload_id !== null || !isBillRow(row) ? row.provenance : 'qr');
  const wins = current.every((row) => outranks({ provenance: authority, confidence: 'high' }, { provenance: rowAuthority(row), confidence: 'high' }));

  // WHICH BILL (critic R6-M1): the incoming bill is the SAME bill when what it says (its identity) is
  // what the bill the live rows came from said. Never decided by raw text (line breaks differ between
  // readers) nor by which evidence came last (a LOSING payload's evidence is history only).
  const onCapture = currentBillIdentity(ctx, captureId, live);
  const sameBill = bill.identity !== null && bill.identity === onCapture;
  // The FIRST bill on a capture that has none (only typed values, or nothing): there is no previous
  // bill to discard corrections for, so typed values meet the per-key rules.
  const firstBill = onCapture === null && !live.some(isBillRow);
  const reset = wins && !sameBill && !firstBill;

  const plans: FieldPlan[] = incoming.map((f) => {
    const existing = liveRowByKey(ctx, captureId, f.key);
    const identical = existing !== undefined && existing.value === JSON.stringify(f.value);
    if (!wins) return identical ? { kind: 'noop' } : loserPlan(ctx, captureId, f);
    if (existing === undefined) return { kind: 'insert', superseded: false, supersedeId: null };
    if (isBillRow(existing)) return identical ? { kind: 'noop' } : { kind: 'insert', superseded: false, supersedeId: existing.id };
    // A typed value on this key. A DIFFERENT bill resets it: corrections belong to their bill, so the
    // value is discarded with the old bill (history kept, worded in the drawer) and the new bill's
    // value goes live, even when the two are equal.
    if (reset) return { kind: 'insert', superseded: false, supersedeId: existing.id, supersedeAs: SUPERSEDED.discardedWithBill };
    if (identical) return { kind: 'noop' };
    // The SAME bill never touches a typed operator value (a correction or confirmation of it stands,
    // whoever re-states the bill and however it was read).
    if (sameBill && existing.provenance === 'operator') return { kind: 'noop' };
    // Otherwise (the first bill, or a non-operator typed value) the per-key rules decide.
    return decideField(ctx, captureId, f);
  });
  const stated = new Set(incoming.map((f) => f.key));
  // A winner retires every bill row it does not restate; a DIFFERENT bill also discards every typed
  // value on a bill key it leaves open (an open amount leaves no live amount, so the commit asks again).
  const retire: { id: string; as: 1 | 2 }[] = !wins
    ? []
    : live
        .filter((row) => !stated.has(row.key) && BILL_KEYS.has(row.key) && (isBillRow(row) || reset))
        .map((row) => ({ id: row.id, as: isBillRow(row) ? SUPERSEDED.superseded : SUPERSEDED.discardedWithBill }));
  // A WINNING bill is now the bill on the capture: its identity is stored (a losing one's never is).
  if (wins && bill.identity !== null && bill.identity !== storedIdentity(ctx, captureId)) {
    ctx.store.db.prepare('UPDATE captures SET bill_identity = ? WHERE workspace_id = ? AND id = ?').run(bill.identity, ctx.workspaceId, captureId);
  }
  if (plans.every((p) => p.kind === 'noop') && retire.length === 0) {
    return { changed: false, verdict: wins ? 'took_over' : 'lost', payloadId: null };
  }

  let payloadId: string | null = null;
  if (source.kind === 'payload') {
    // The evidence row is written BEFORE the field rows, which reference it (`qr_payload_id`, an FK G04
    // remaps), and only when the payload changes something: supplying it again is a no-op by rule.
    payloadId = ctx.ids.next('capq');
    ctx.store.db
      .prepare(
        `INSERT INTO capture_qr_payloads (id, workspace_id, capture_id, payload, sha256, source, decoder, warnings, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        payloadId,
        ctx.workspaceId,
        captureId,
        source.payload,
        createHash('sha256').update(source.payload, 'utf8').digest('hex'),
        source.supplier,
        source.decoder,
        JSON.stringify(source.warnings),
        ctx.actor,
        ctx.clock.now(),
      );
  }
  incoming.forEach((f, i) => writeRow(ctx, captureId, f, plans[i] ?? { kind: 'noop' }, payloadId));
  const at = ctx.clock.now();
  const retireRow = ctx.store.db.prepare('UPDATE capture_fields SET superseded = ?, updated_at = ? WHERE workspace_id = ? AND id = ?');
  for (const row of retire) retireRow.run(row.as, at, ctx.workspaceId, row.id);
  return { changed: true, verdict: wins ? 'took_over' : 'lost', payloadId };
}
