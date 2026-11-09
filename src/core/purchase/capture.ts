/**
 * A31, document capture into the purchase ledger (Belegerfassung). The engine (Pattern P1: pure
 * `(ctx, input) -> Result` verbs).
 *
 * WHAT THIS IS AND, JUST AS IMPORTANTLY, WHAT IT IS NOT. A capture is a work-queue record about a
 * stored file: a document enters once, the deterministic pass extracts what a Swiss QR Code and its
 * Swico S1 billing information state machine-readably, a human or agent reviews and corrects, and one
 * committed hand-off produces a DRAFT vendor bill (A17) or expense line (E02) with the original
 * attached (E00) and every proposed field carrying an auditor-readable provenance.
 *
 * A31 WRITES NO ACCOUNTING COLUMN AND POSTS NOTHING (P3, tripwire §7). Every financial effect goes
 * through the named A17/E02/E00 verbs, which self-assert their own capabilities (`createVendorBill`
 * asserts `post`, `upsertLine`/`createClaim` assert `spesen.submit`), so the delegation is
 * re-gated at execution time against the acting identity and A31 can never widen what a caller could
 * do by calling those verbs directly. `captureCommit` produces a DRAFT only (P8); posting the draft
 * is A17's separately-dialled `post_vendor_bill`, unchanged.
 *
 * MERGE RULES ARE FIXED (§6b), a configurable merge would let a workspace silently prefer guessed
 * fields over read ones. They live in `./billMerge.ts`: `mergeBill` is the one chokepoint every BILL
 * writer goes through (the bytes' read and a supplied payload, whole), and `applyTypedField` takes a
 * typed value per key. This module writes no `capture_fields` row itself.
 */

import { createHash } from 'node:crypto';

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { uploadFile, getFileContent, linkFile, fileLinkedTo } from '../files/index.js';
import { createVendorBill, attachReceipt } from './vendorBill.js';
import { createClaim, upsertLine } from '../hr/index.js';
import {
  isCaptureAcceptedMime,
  isCaptureFieldKey,
  isCaptureConfidence,
  isCaptureTargetKind,
  CAPTURE_ACCEPTED_MIMES,
  CAPTURE_TARGET_KINDS,
  isCaptureQrPayloadSource,
  CAPTURE_QR_DECODER_MAX,
  type CaptureProvenance,
  type CaptureConfidence,
  type CaptureQrPayloadSource,
} from './captureEnums.js';
import { locateSpcPayload, parseSpcPayload, type ParsedField, type ParseNote } from './captureParse.js';
import { decodeSwissQrBill, type QrDecodeIssue } from './qrbill/decode.js';
import { decodedBillFields } from './qrbill/fields.js';
import { billIdentity } from './qrbill/identity.js';
import { mergeBill, applyTypedField, SUPERSEDED, type Bill } from './billMerge.js';
import { ReceiptGuardAbort, holdersForSeat, isReceiptBookingKind, receiptHolders } from '../files/receiptGuard.js';
import { applySavedView } from '../customization/views.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { intakeSeatOf, isMachineAct } from './intakeSeat.js';
import type { IntakeSeat } from './intakeSeat.js';
import { engineFieldRefusal } from './captureFieldGuard.js';
import { applyHoldPlan, holdPlan, type HoldPlan } from '../banking/belegHold.js';
import { assignmentOnCaptureCommitted, assignmentOnCaptureDiscarded, assignmentOnFiguresChanged } from '../banking/belegAssignmentStore.js';

// --- Rows ---------------------------------------------------------------------------------------

interface CaptureRow {
  id: string;
  workspace_id: string;
  document_id: string;
  sha256: string;
  status: string;
  rescued_from_capture_id: string | null;
  qr_present: number;
  swico_present: number;
  parse_notes: string;
  target_kind: string | null;
  target_id: string | null;
  committed_by: string | null;
  committed_at: string | null;
  discard_reason: string | null;
  created_by: string;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

interface FieldRow {
  id: string;
  key: string;
  value: string;
  confidence: string;
  provenance: string;
  superseded: number;
  /** A31 §0a: the supplied QR payload that wrote this row (an FK G04 restore remaps), else NULL. */
  qr_payload_id?: string | null;
  created_at: string;
  updated_at: string;
}

/** Abort a write transaction with a structured cause, so nothing is memoised on a rejection (the
 *  A17 `BillAbort` pattern: returning `{ok:false}` inside `ctx.store.tx` COMMITS partial writes). */
class CaptureAbort {
  constructor(public readonly result: Result) {}
}

function runGuarded(body: () => Result): Result {
  try {
    return body();
  } catch (e) {
    if (e instanceof CaptureAbort) return e.result;
    // A41.3 (critic r2 M2/M3): the assignment chokepoint refuses a machine act that would end a person's row.
    if (e instanceof ReceiptGuardAbort) return e.result;
    throw e;
  }
}

function readCapture(ctx: WorkspaceContext, id: unknown): CaptureRow | undefined {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM captures WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as CaptureRow | undefined;
}

/** The LIVE fields of a capture, keyed by field key (superseded rows excluded). §H-TENANT scoped. */
function liveFields(ctx: WorkspaceContext, captureId: string): FieldRow[] {
  return ctx.store.db
    .prepare('SELECT * FROM capture_fields WHERE workspace_id = ? AND capture_id = ? AND superseded = 0 ORDER BY key')
    .all(ctx.workspaceId, captureId) as FieldRow[];
}

function liveFieldByKey(ctx: WorkspaceContext, captureId: string, key: string): FieldRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM capture_fields WHERE workspace_id = ? AND capture_id = ? AND key = ? AND superseded = 0')
    .get(ctx.workspaceId, captureId, key) as FieldRow | undefined;
}

/** JSON-safe read of a stored field value. */
function fieldValue(row: FieldRow | undefined): unknown {
  if (row === undefined) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

// --- Deterministic pass -------------------------------------------------------------------------

/** Decode a stored file's bytes back to text for the SPC-payload search. */
function fileText(ctx: WorkspaceContext, documentId: string): string | null {
  const content = getFileContent(ctx, { fileId: documentId });
  if (!content.ok) return null;
  const b64 = (content as { contentBase64?: string }).contentBase64;
  if (typeof b64 !== 'string') return null;
  // UTF-8: the SIX IG encodes the Swiss QR Code payload as UTF-8 (byte mode), and `toString` never
  // throws (it substitutes on invalid bytes), so binary content simply yields no `SPC` header.
  return Buffer.from(b64, 'base64').toString('utf8');
}

/** Run the deterministic pass over a text blob: locate + parse the SPC payload. */
function deterministicParse(text: string): {
  fields: ParsedField[];
  notes: ParseNote[];
  qrPresent: boolean;
  swicoPresent: boolean;
  swicoUid: string | null;
  identity: string | null;
} {
  const payload = locateSpcPayload(text);
  if (payload === null) return { fields: [], notes: [], qrPresent: false, swicoPresent: false, swicoUid: null, identity: null };
  const parsed = parseSpcPayload(payload);
  return {
    identity: billIdentity(payload),
    fields: parsed.fields,
    notes: parsed.notes,
    qrPresent: parsed.qrPresent,
    swicoPresent: parsed.swicoPresent,
    swicoUid: parsed.swicoUid,
  };
}

/** The stored bytes' read as ONE bill for the chokepoint (its UID drives the vendor match there). */
function bytesBill(parsed: ReturnType<typeof deterministicParse>): Bill {
  return {
    // A41.3 (security review): a value read off the bytes that breaks the engine-field rule (a hidden
    // character, an IBAN failing its check digits) is not landed: the intake still succeeds, the field stays
    // empty for a person to state (refusing the whole document would lose the receipt).
    fields: parsed.fields
      .filter((f) => engineFieldRefusal(f.key, f.value) === null)
      .map((f) => ({ key: f.key, value: f.value, confidence: f.confidence, provenance: f.provenance })),
    uid: parsed.swicoUid,
    identity: parsed.identity,
  };
}

// --- Intake -------------------------------------------------------------------------------------

export interface CaptureIntakeInput {
  contentBase64: string;
  mime: string;
  filename?: string;
  idempotencyKey?: string;
}

/**
 * Ingest a document: refuse a mime the queue does not accept BEFORE any write (the tx-commit-on-err
 * trap), dedupe on content hash against non-discarded captures, store via E00, then run the
 * deterministic pass in the same transaction. A hash matching only DISCARDED captures is not a dead
 * end: intake proceeds with `rescued_from_capture_id` set (append-only recovery), so a mistaken
 * discard is recoverable by re-uploading the same bytes.
 */
export function captureIntake(ctx: WorkspaceContext, input: CaptureIntakeInput): Result {
  if (typeof input.mime !== 'string' || !isCaptureAcceptedMime(input.mime)) {
    return err('unsupported_mime', { mime: input.mime, accepted: [...CAPTURE_ACCEPTED_MIMES] });
  }
  if (typeof input.contentBase64 !== 'string' || input.contentBase64.length === 0) {
    return err('file_unreadable', { field: 'contentBase64', reason: 'missing' });
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(input.contentBase64, 'base64');
  } catch {
    return err('file_unreadable', { field: 'contentBase64', reason: 'not_base64' });
  }
  if (bytes.byteLength === 0) return err('file_unreadable', { field: 'contentBase64', reason: 'empty' });
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  // Replay a completed keyed intake FIRST, so a retry returns the original result rather than being
  // re-classified as a duplicate of the capture it itself created (§H-IDEMPOTENT).
  const key = typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0 ? input.idempotencyKey : undefined;
  if (key !== undefined) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'capture_document');
    if (replayed !== undefined) return replayed;
  }

  // Dedupe against NON-discarded captures (the partial unique index's live scope). A live/committed
  // twin returns without any write.
  const liveTwin = ctx.store.db
    .prepare("SELECT id FROM captures WHERE workspace_id = ? AND sha256 = ? AND status != 'discarded' LIMIT 1")
    .get(ctx.workspaceId, sha256) as { id: string } | undefined;
  if (liveTwin !== undefined) {
    return ok({ captureId: liveTwin.id, duplicate: true });
  }
  // R1 (N02): a receipt that already evidences a live booking (or waits for a Vorschlag) is queued like
  // any other; the answer names its holders, so the person sees it before committing. The commit itself
  // meets the receipt guard like every other door.
  // A hash matching only DISCARDED captures cross-links the newest discarded twin (recovery).
  const discardedTwin = ctx.store.db
    .prepare("SELECT id FROM captures WHERE workspace_id = ? AND sha256 = ? AND status = 'discarded' ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(ctx.workspaceId, sha256) as { id: string } | undefined;

  const parsed = deterministicParse(bytes.toString('utf8'));

  const run = (): Result => {
    const uploaded = uploadFile(ctx, {
      contentBase64: input.contentBase64,
      mime: input.mime,
      filename: input.filename ?? 'beleg',
      title: input.filename ?? 'Beleg',
    });
    if (!uploaded.ok) throw new CaptureAbort(uploaded);
    const documentId = (uploaded as unknown as { file: { id: string } }).file.id;

    const id = ctx.ids.next('cap');
    const at = ctx.clock.now();
    const holders = receiptHolders(ctx, sha256, { target: { kind: 'capture', id }, exceptFileIds: [documentId] });
    ctx.store.db
      .prepare(
        `INSERT INTO captures
           (id, workspace_id, document_id, sha256, status, rescued_from_capture_id, qr_present, swico_present,
            parse_notes, target_kind, target_id, committed_by, committed_at, discard_reason, created_by,
            idempotency_key, created_at, updated_at, intake_seat)
         VALUES (?, ?, ?, ?, 'needs_review', ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        documentId,
        sha256,
        discardedTwin?.id ?? null,
        parsed.qrPresent ? 1 : 0,
        parsed.swicoPresent ? 1 : 0,
        JSON.stringify(parsed.notes),
        ctx.actor,
        key ?? null,
        at,
        at,
        // A41.3 re-cut v2 (D184, I-F): WHERE the bytes came from, read now and engine-side (`intakeSeat.ts`: a
        // governed executor, or an approval replay of a governed seat's draft, is `machine`; the Belegeingang
        // scan is `folder`). A Swiss QR code backs an unattended booking only on a document a person brought in:
        // an agent could otherwise upload a QR bill of its own making.
        intakeSeatOf(ctx),
      );
    mergeBill(ctx, id, bytesBill(parsed), { kind: 'bytes' });
    ctx.audit.record({ entityKind: 'capture', entityId: id, action: 'intake', actor: ctx.actor, at });
    return ok({
      captureId: id,
      duplicate: false,
      ...(discardedTwin !== undefined ? { rescuedFromCaptureId: discardedTwin.id } : {}),
      ...(holders.length > 0 ? { alreadyBooked: true, holders: holdersForSeat(ctx, holders) } : {}),
    });
  };

  const wrapped = (): Result =>
    key !== undefined
      ? ctx.store.rememberIdempotent(ctx.workspaceId, key, 'capture_document', run)
      : ctx.store.tx(run);
  return runGuarded(wrapped);
}

/**
 * Critic A41.3 follow-ups r1 F1 (I-F): WHERE A STORED FILE'S BYTES CAME FROM, never who acts on them now: the seat
 * stamped on the stored file when its bytes entered the filing (`stored_file.intake_seat`, an upload, a new
 * version, a chunked commit, a released Vorschlag file; a twin row carries its source's). Unknown (a file from
 * before that stamp, or none in this workspace) is `machine`: fail closed.
 */
export function storedBytesSeat(ctx: WorkspaceContext, documentId: string): IntakeSeat {
  const row = ctx.store.db.prepare('SELECT intake_seat FROM stored_file WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, documentId) as { intake_seat: string | null } | undefined;
  const seat = row?.intake_seat ?? null;
  return seat === 'person' || seat === 'folder' ? seat : 'machine';
}

/**
 * Critic A41.3 follow-ups r1 F1: is this stored file the person's OWN fresh drop, proven engine-side from the row
 * itself: bytes a PERSON seat uploaded (`intake_seat = 'person'`, so no agent, plugin, system or approved draft),
 * the first version of no chain, never filed anywhere (`entity_kind` and `linked_by` both NULL: no link was ever
 * written), not pending delete. Only such bytes may take the line's amount as the person's statement.
 */
export function isFreshPersonDrop(ctx: WorkspaceContext, documentId: string): boolean {
  const row = ctx.store.db
    .prepare('SELECT intake_seat, entity_kind, linked_by, version, supersedes_id, pending_delete FROM stored_file WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, documentId) as { intake_seat: string | null; entity_kind: string | null; linked_by: string | null; version: number; supersedes_id: string | null; pending_delete: number } | undefined;
  return (
    row !== undefined &&
    row.intake_seat === 'person' &&
    row.entity_kind === null &&
    row.linked_by === null &&
    row.version === 1 &&
    row.supersedes_id === null &&
    row.pending_delete === 0
  );
}

/**
 * A41.3 follow-ups (`assign_beleg_file`): capture a document that is ALREADY STORED (a file a person dropped on an
 * open bank line, or the new version of an assigned receipt), inside the CALLER's transaction. The same row and
 * the same deterministic pass as `captureIntake`, without a second upload. The caller has decided every refusal
 * first, read-only: a mime the queue accepts (`isCaptureAcceptedMime`) and no live capture over these bytes
 * (`liveCaptureOfBytes`, the `captures_dedupe_live` index). Answers the new capture id.
 *
 * Critic r1 F1 (I-F): its `intake_seat` is the BYTES' origin (`storedBytesSeat`), never the seat acting now: a
 * person's "Zuordnen" of an agent's QR bill keeps it a machine intake, so its QR figures never back an unattended
 * booking until a person confirms them.
 */
export function captureStoredDocument(ctx: WorkspaceContext, documentId: string, sha256: string): string {
  const text = fileText(ctx, documentId);
  const parsed = deterministicParse(text ?? '');
  const id = ctx.ids.next('cap');
  const at = ctx.clock.now();
  ctx.store.db
    .prepare(
      `INSERT INTO captures
         (id, workspace_id, document_id, sha256, status, rescued_from_capture_id, qr_present, swico_present,
          parse_notes, target_kind, target_id, committed_by, committed_at, discard_reason, created_by,
          idempotency_key, created_at, updated_at, intake_seat)
       VALUES (?, ?, ?, ?, 'needs_review', NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?, ?, ?)`,
    )
    .run(id, ctx.workspaceId, documentId, sha256, parsed.qrPresent ? 1 : 0, parsed.swicoPresent ? 1 : 0, JSON.stringify(parsed.notes), ctx.actor, at, at, storedBytesSeat(ctx, documentId));
  mergeBill(ctx, id, bytesBill(parsed), { kind: 'bytes' });
  ctx.audit.record({ entityKind: 'capture', entityId: id, action: 'intake', actor: ctx.actor, at });
  return id;
}

/** The live (not discarded) capture over these bytes, or undefined: at most one (`captures_dedupe_live`). */
export function liveCaptureOfBytes(ctx: WorkspaceContext, sha256: string): { id: string; documentId: string; status: string } | undefined {
  return ctx.store.db
    .prepare("SELECT id, document_id AS documentId, status FROM captures WHERE workspace_id = ? AND sha256 = ? AND status != 'discarded' LIMIT 1")
    .get(ctx.workspaceId, sha256) as { id: string; documentId: string; status: string } | undefined;
}

/**
 * A41.3 follow-ups: a PERSON's statement of a capture's amount and currency (`operator`, `high`), in the caller's
 * transaction, through the one typed-field writer (`applyTypedField`). Audited as an extract.
 */
export function statePersonFigures(ctx: WorkspaceContext, captureId: string, amount: { minor: number; currency: string }): void {
  applyTypedField(ctx, captureId, { key: 'amount', value: { minor: amount.minor, currency: amount.currency }, provenance: 'operator', confidence: 'high' });
  applyTypedField(ctx, captureId, { key: 'currency', value: amount.currency, provenance: 'operator', confidence: 'high' });
  const at = ctx.clock.now();
  ctx.store.db.prepare('UPDATE captures SET updated_at = ? WHERE workspace_id = ? AND id = ?').run(at, ctx.workspaceId, captureId);
  ctx.audit.record({ entityKind: 'capture', entityId: captureId, action: 'extract', actor: ctx.actor, at });
}

// --- Extract ------------------------------------------------------------------------------------

export interface CaptureExtractInput {
  captureId: string;
  source: 'qr' | 'local_model' | 'agent' | 'operator';
  fields?: { key: string; value?: unknown; confidence?: string }[];
  /**
   * A31 §0a: a Swiss QR Code payload the caller read off the bill (a phone scanner, the Studio's image
   * decode, a G02 decoder plugin), instead of `fields`. Only with `source` `operator` or `agent`.
   */
  qrPayload?: string;
  /** Which reader produced `qrPayload` (`phone-scanner`, `studio-barcode-detector`, `plugin:<id>`). */
  decoder?: string;
  idempotencyKey?: string;
}

/** A label for the reader that decoded a supplied payload: printable ASCII, 1 to 64 characters. */
function isDecoderLabel(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= CAPTURE_QR_DECODER_MAX && /^[\x21-\x7E][\x20-\x7E]*$/.test(v);
}

/**
 * Re-run or augment extraction. `qr` re-runs the deterministic pass; `agent` takes caller-supplied
 * fields (validated against CAPTURE_FIELD_KEY); `operator` takes review-pane corrections (landing
 * `operator`/`high`); `local_model` degrades honestly to `needs_local_runtime` (no E05 adapter is
 * wired in the core, spec §3: absent adapter = `needs_local_runtime`, never a cloud fallback).
 *
 * `agent` and `operator` may instead supply `qrPayload` (spec §0a): the strict decoder runs first and
 * a payload breaking any guideline rule writes nothing (`qr_payload_invalid`, every issue listed). A
 * clean one lands through the SAME merge rules with the supplier's provenance, never `qr`/`swico`
 * (those mean "read from the stored bytes", and a caller who could land them by supplying a
 * well-formed payload could launder a guess into the trusted provenance), and one
 * `capture_qr_payloads` row records the raw payload and the field rows it wrote.
 */
export function captureExtract(ctx: WorkspaceContext, input: CaptureExtractInput): Result {
  const capture = readCapture(ctx, input.captureId);
  if (capture === undefined) return err('not_found', { captureId: input.captureId });
  if (capture.status !== 'needs_review') {
    return err('invalid_state', { captureId: capture.id, status: capture.status });
  }
  if (input.source === 'local_model') {
    // The only inference path is the optional E05/OP6 local adapter, a same-machine companion. None
    // is wired in the core, so this is the honest degradation, never a 500 and never a cloud call.
    return err('needs_local_runtime', { captureId: capture.id });
  }
  if (input.source !== 'qr' && input.source !== 'agent' && input.source !== 'operator') {
    return err('invalid_input', { field: 'source' });
  }

  // A supplied QR payload (spec §0a item 9) is decoded strictly BEFORE any write: a payload that breaks
  // any rule of the guideline lands nothing and names every issue (§0a item 11).
  let supplied: { source: CaptureQrPayloadSource; payload: string; decoder: string | null; warnings: QrDecodeIssue[]; swicoUid: string | null } | null = null;
  let incoming: { key: string; value: unknown; provenance: CaptureProvenance; confidence: CaptureConfidence }[] = [];
  if (input.qrPayload !== undefined) {
    if (!isCaptureQrPayloadSource(input.source)) {
      return err('invalid_input', { field: 'source', reason: 'qr_payload_needs_operator_or_agent' });
    }
    if (input.fields !== undefined) return err('invalid_input', { field: 'fields', reason: 'fields_and_qr_payload' });
    if (typeof input.qrPayload !== 'string') return err('invalid_input', { field: 'qrPayload' });
    if (input.decoder !== undefined && !isDecoderLabel(input.decoder)) {
      return err('invalid_input', { field: 'decoder', max: CAPTURE_QR_DECODER_MAX });
    }
    const decoded = decodeSwissQrBill(input.qrPayload);
    if (!decoded.ok) {
      return err('qr_payload_invalid', { captureId: capture.id, errors: decoded.errors, warnings: decoded.warnings });
    }
    supplied = {
      source: input.source,
      payload: input.qrPayload,
      decoder: input.decoder ?? null,
      warnings: decoded.warnings,
      swicoUid: decoded.bill.swico?.uid ?? null,
    };
    incoming = decodedBillFields(decoded.bill, input.source);
    // A41.3 (security review): a supplied payload meets the same engine-field rule as typed fields.
    for (const f of incoming) {
      const unsafe = engineFieldRefusal(f.key, f.value);
      if (unsafe !== null) return unsafe;
    }
  } else if (input.decoder !== undefined) {
    return err('invalid_input', { field: 'decoder', reason: 'decoder_without_qr_payload' });
  }

  // Validate agent/operator fields BEFORE any write (the tx-commit-on-err trap): a bad key must not
  // land a partial batch. `qr` needs no field input.
  if (supplied === null && (input.source === 'agent' || input.source === 'operator')) {
    if (!Array.isArray(input.fields)) return err('invalid_input', { field: 'fields' });
    for (const f of input.fields) {
      if (f === null || typeof f !== 'object' || !isCaptureFieldKey((f as { key?: unknown }).key)) {
        return err('unknown_field_key', { key: (f as { key?: unknown })?.key });
      }
      const key = (f as { key: string }).key;
      const value = (f as { value?: unknown }).value;
      if (value === undefined) return err('invalid_input', { field: 'value', key });
      // A41.3 (security review): no hidden characters and no broken IBAN in a field the pairing reads.
      const unsafe = engineFieldRefusal(key, value);
      if (unsafe !== null) return unsafe;
      if (input.source === 'agent') {
        const conf = (f as { confidence?: unknown }).confidence;
        if (!isCaptureConfidence(conf)) return err('invalid_input', { field: 'confidence', key });
        incoming.push({ key, value, provenance: 'agent', confidence: conf });
      } else {
        // A human assertion carries no probabilistic grade: operator is always `high`.
        incoming.push({ key, value, provenance: 'operator', confidence: 'high' });
      }
    }
  }

  let payloadId: string | null = null;
  const run = (): Result => {
    // Every bill goes through the ONE chokepoint whole (`billMerge.ts`, critic R3-M1); a typed value
    // goes per key. Nothing here writes a field row itself.
    let changed: boolean;
    if (input.source === 'qr') {
      const text = fileText(ctx, capture.document_id);
      if (text === null) throw new CaptureAbort(err('file_unreadable', { captureId: capture.id }));
      const parsed = deterministicParse(text);
      changed = mergeBill(ctx, capture.id, bytesBill(parsed), { kind: 'bytes' }).changed;
      const notes = JSON.stringify(parsed.notes);
      if (capture.qr_present !== (parsed.qrPresent ? 1 : 0) || capture.swico_present !== (parsed.swicoPresent ? 1 : 0) || capture.parse_notes !== notes) {
        ctx.store.db
          .prepare('UPDATE captures SET qr_present = ?, swico_present = ?, parse_notes = ? WHERE workspace_id = ? AND id = ?')
          .run(parsed.qrPresent ? 1 : 0, parsed.swicoPresent ? 1 : 0, notes, ctx.workspaceId, capture.id);
        changed = true;
      }
    } else if (supplied !== null) {
      const fields = incoming.map((f) => ({ key: f.key, value: f.value, confidence: f.confidence }));
      const merged = mergeBill(ctx, capture.id, { fields, uid: supplied.swicoUid, identity: billIdentity(supplied.payload) }, {
        kind: 'payload',
        supplier: supplied.source,
        payload: supplied.payload,
        decoder: supplied.decoder,
        warnings: supplied.warnings,
      });
      payloadId = merged.payloadId;
      changed = merged.changed;
    } else {
      changed = false;
      for (const f of incoming) if (applyTypedField(ctx, capture.id, f)) changed = true;
    }
    // Re-running on unchanged input is a TRUE no-op: no row, no timestamp, no audit entry.
    if (!changed) {
      return ok({
        captureId: capture.id,
        fields: liveFields(ctx, capture.id).map(projectField),
        ...(supplied !== null ? { qrPayload: { id: payloadId, warnings: supplied.warnings } } : {}),
      });
    }
    ctx.store.db.prepare('UPDATE captures SET updated_at = ? WHERE workspace_id = ? AND id = ?').run(ctx.clock.now(), ctx.workspaceId, capture.id);
    ctx.audit.record({ entityKind: 'capture', entityId: capture.id, action: 'extract', actor: ctx.actor, at: ctx.clock.now() });
    // A41.3 re-cut v2 (D184, I-D): a figure change releases an engine assignment over this capture, and a
    // person's assignment only when a PERSON changed the figures (a governed seat's edit is ignored).
    assignmentOnFiguresChanged(ctx, capture.id, !isMachineAct(ctx));
    return ok({
      captureId: capture.id,
      fields: liveFields(ctx, capture.id).map(projectField),
      ...(supplied !== null ? { qrPayload: { id: payloadId, warnings: supplied.warnings } } : {}),
    });
  };

  const key = typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0 ? input.idempotencyKey : undefined;
  const scoped = key !== undefined ? JSON.stringify([capture.id, key]) : undefined;
  const wrapped = (): Result =>
    scoped !== undefined ? ctx.store.rememberIdempotent(ctx.workspaceId, scoped, 'capture_extract', run) : ctx.store.tx(run);
  return runGuarded(wrapped);
}

// --- Commit -------------------------------------------------------------------------------------

/**
 * The currency a commit books the captured amount in (critic R1-H2). Money is `{ minor, currency }`
 * as ONE value: the minor units mean nothing without the currency they count, so a commit carries the
 * captured currency into the draft and never lets the target default it. A EUR 100.00 QR-bill that
 * landed as CHF 100.00 was a wrong amount, and the payable, the pain.001 and the VAT figure followed it.
 *
 * Read in order: the amount's own currency, then the capture's `currency` field (an operator who typed
 * a bare `{ minor }` correction beside a read currency), then the base currency (nothing on the capture
 * states one, which is the hand-typed case the drafts always had). Two statements that disagree are
 * refused (`currency_conflict`) rather than one silently winning: which of them is the bill's is a
 * question for the reviewer. A value that is not an ISO 4217 code shape is refused too, before the
 * target could store it.
 */
function commitCurrency(ctx: WorkspaceContext, captureId: string, amount: { currency?: unknown }, stated: unknown): string {
  const fromAmount = typeof amount.currency === 'string' ? amount.currency : undefined;
  const fromField = typeof stated === 'string' ? stated : undefined;
  if (fromAmount !== undefined && fromField !== undefined && fromAmount !== fromField) {
    throw new CaptureAbort(err('currency_conflict', { captureId, amountCurrency: fromAmount, currency: fromField }));
  }
  const currency = fromAmount ?? fromField ?? baseCurrencyOf(ctx);
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new CaptureAbort(err('invalid_input', { field: 'currency', captureId, currency }));
  }
  return currency;
}


export interface CaptureCommitInput {
  captureId: string;
  target: {
    kind: string;
    vendorId?: string;
    billDate?: string;
    dueDate?: string;
    expenseAccountId?: string;
    taxCode?: string | null;
    costCenterId?: string;
    projectId?: string;
    // expense_line path
    claimId?: string;
    employeeId?: string;
    category?: string;
    expenseDate?: string;
  };
  corrections?: { key: string; value?: unknown }[];
  /**
   * R1: a person commits although the receipt already evidences another live booking (needs
   * `overrideReason`). Read by the receipt guard from the call's frame (the registry puts it there).
   */
  bookAgain?: boolean;
  overrideReason?: string;
  idempotencyKey: string;
}

/**
 * Commit a capture into a DRAFT vendor bill (A17) or expense line (E02). Delegates in one
 * transaction and posts NOTHING (P8): posting is A17's own separately-dialled verb. Idempotent by
 * key: a double-commit returns the original `target_id` and never creates a second draft (the outer
 * `rememberIdempotent` replays the result before the state check even runs, and the delegated write
 * carries a derived key of its own).
 */
export function captureCommit(ctx: WorkspaceContext, input: CaptureCommitInput): Result {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const target = input.target ?? ({} as CaptureCommitInput['target']);
  if (!isCaptureTargetKind(target.kind)) {
    return err('invalid_input', { field: 'target.kind', allowed: [...CAPTURE_TARGET_KINDS] });
  }

  const scoped = JSON.stringify([input.captureId, input.idempotencyKey]);
  // Replay a completed commit BEFORE the state guard, so a retry returns the original target rather
  // than `invalid_state` on the capture it itself committed (§H-IDEMPOTENT).
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scoped, 'capture_commit');
  if (replayed !== undefined) return replayed;

  const capture = readCapture(ctx, input.captureId);
  if (capture === undefined) return err('not_found', { captureId: input.captureId });
  if (capture.status !== 'needs_review') {
    return err('invalid_state', { captureId: capture.id, status: capture.status });
  }
  if (Array.isArray(input.corrections)) {
    for (const c of input.corrections) {
      if (c === null || typeof c !== 'object' || !isCaptureFieldKey((c as { key?: unknown }).key)) {
        return err('unknown_field_key', { key: (c as { key?: unknown })?.key });
      }
      if ((c as { value?: unknown }).value === undefined) return err('invalid_input', { field: 'value', key: (c as { key: string }).key });
      // A41.3 (security review): corrections land as operator fields; the same engine-field rule.
      const unsafe = engineFieldRefusal((c as { key: string }).key, (c as { value?: unknown }).value);
      if (unsafe !== null) return unsafe;
    }
  }
  // A41.3 re-cut v3 (D10), THE WRITE-ORDER RULE: the assignment hold is decided FIRST, read-only. `capture_commit`
  // keeps its own rule (H4, I-D): a PERSON's commit releases the assignment, person or engine row, as
  // `capture_committed` (the line then follows the bill's payment); a MACHINE's is refused `receipt_assigned`.
  const holdTarget = { kind: target.kind === 'expense_line' ? 'expense_claim' : 'vendor_bill', id: null };
  const commitHold = holdPlan(ctx, { sha256: capture.sha256, fileId: capture.document_id, target: holdTarget, act: 'commit' });
  if ((commitHold as { ok?: unknown }).ok === false) return commitHold as Result;
  const releasedLines = new Set((commitHold as HoldPlan).releases.map((r) => r.bankTxnId));
  // N02 (D183, critic F1): a capture whose OWN document already evidences a BOOKING (a person linked it
  // by hand) is never committed over it: re-linking would MOVE the Beleg off that booking (a file has one
  // primary link). Refused before anything is written, naming the holder. A document filed on a record
  // that books nothing (a contact, a project) is moved to the bill, as `files_link` would move it. A41.3: a
  // document filed on the OPEN line whose assignment this commit releases is unfiled by the plan, not refused.
  const documentLink = ctx.store.db
    .prepare('SELECT entity_kind, entity_id FROM stored_file WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, capture.document_id) as { entity_kind: string | null; entity_id: string | null } | undefined;
  const unfiledByPlan = documentLink?.entity_kind === 'bank_txn' && documentLink.entity_id !== null && releasedLines.has(documentLink.entity_id);
  if (documentLink !== undefined && documentLink.entity_kind !== null && isReceiptBookingKind(documentLink.entity_kind) && !unfiledByPlan) {
    return err('document_already_linked', {
      captureId: capture.id,
      fileId: capture.document_id,
      entityKind: documentLink.entity_kind,
      entityId: documentLink.entity_id,
    });
  }
  // R1 (N02): the same RECEIPT evidencing another live booking (another filing row, a receipt pointer, a
  // Vorschlag's reservation) is judged by the receipt guard at the door the commit reaches: the bill's
  // `attach_receipt` (which links the document) or the expense line's `expense_line_upsert`. A refusal
  // there rolls the whole commit back, and a person's `bookAgain` + `overrideReason` is recorded there.

  const run = (): Result => {
    // A41.3 v3: the hold plan is the commit's FIRST write; a later refusal is thrown, so it rolls back whole.
    applyHoldPlan(ctx, commitHold as HoldPlan);
    // Corrections land as operator fields FIRST, so the delegated write reads the corrected values.
    if (Array.isArray(input.corrections)) {
      for (const c of input.corrections) {
        applyTypedField(ctx, capture.id, { key: (c as { key: string }).key, value: (c as { value: unknown }).value, provenance: 'operator', confidence: 'high' });
      }
    }
    const field = (k: string): unknown => fieldValue(liveFieldByKey(ctx, capture.id, k));

    const delegatedKey = `${input.idempotencyKey}:${capture.id}`;
    // K1: every delegated write carries a key DERIVED from this commit's own, so each runs in the
    // commit's own idempotency scope (`capture_commit>…`), never in the public scope of the verb it
    // delegates to: a `create_vendor_bill`, `files_link`, `expense_claim_create` or `expense_line_upsert`
    // made first under the derived key used to be replayed here and committed as the capture's target.
    // Each result is then READ BACK as this commit's own before the capture is marked committed. (A
    // squatted key that a domain table holds unique now refuses `idempotency_key_conflict` instead.)
    const notOwn = (innerVerb: string, detail: Record<string, unknown>): Result =>
      err('inner_write_not_own', { composite: 'capture_commit', inner: innerVerb, captureId: capture.id, ...detail });
    let targetId: string;
    if (target.kind === 'vendor_bill') {
      const vendorId = target.vendorId ?? (typeof field('vendor_contact_id') === 'string' ? (field('vendor_contact_id') as string) : undefined);
      if (typeof vendorId !== 'string' || vendorId.length === 0) {
        throw new CaptureAbort(err('needs_vendor', { captureId: capture.id }));
      }
      if (typeof target.expenseAccountId !== 'string' || target.expenseAccountId.length === 0) {
        throw new CaptureAbort(err('needs_account', { field: 'expenseAccountId', captureId: capture.id }));
      }
      const amount = field('amount') as { minor?: number; currency?: unknown } | undefined;
      if (amount === undefined || typeof amount.minor !== 'number') {
        throw new CaptureAbort(err('needs_amount', { captureId: capture.id }));
      }
      const currency = commitCurrency(ctx, capture.id, amount, field('currency'));
      const billDate = target.billDate ?? (typeof field('invoice_date') === 'string' ? (field('invoice_date') as string) : ctx.clock.now().slice(0, 10));
      const amountMinor = amount.minor;
      const expenseAccountId = target.expenseAccountId;
      const created = ctx.store.innerWrite('capture_commit', () => createVendorBill(ctx, {
        vendorId,
        billDate,
        ...(target.dueDate ?? field('due_date') ? { dueDate: (target.dueDate ?? (field('due_date') as string)) } : {}),
        amountMinor,
        currency,
        amountIsGross: true,
        ...(target.taxCode !== undefined ? { taxCode: target.taxCode } : typeof field('tax_code') === 'string' ? { taxCode: field('tax_code') as string } : {}),
        expenseAccountId,
        ...(target.costCenterId ? { costCenterId: target.costCenterId } : {}),
        ...(target.projectId ? { projectId: target.projectId } : {}),
        idempotencyKey: `${delegatedKey}:vb`,
      }));
      if (!created.ok) throw new CaptureAbort(created);
      targetId = (created as unknown as { vendorBillId: string }).vendorBillId;
      const bill = ctx.store.db
        .prepare('SELECT contact_id, status, idempotency_key FROM vendor_bill WHERE workspace_id = ? AND id = ?')
        .get(ctx.workspaceId, targetId) as { contact_id: string; status: string; idempotency_key: string } | undefined;
      if (bill === undefined || bill.status !== 'draft' || bill.contact_id !== vendorId || bill.idempotency_key !== `${delegatedKey}:vb`) {
        throw new CaptureAbort(notOwn('create_vendor_bill', { vendorBillId: targetId }));
      }
      // The E00 entity link (which derives OR 958f retention) AND the receipt reference (A17's own
      // pointer) do different jobs; both fire. The LINK first: the capture owns the document it uploaded,
      // so it files it against the bill (moving a link a squatter set, K1); it is the receipt guard's door
      // for this commit (R1, the document's own current link excluded: it moves). A17's pointer then finds
      // it already on this bill (`refuseReceiptLink` never lets a pointer move a link), so `attach_receipt`
      // links nothing a second time.
      const linked = ctx.store.innerWrite('capture_commit', () => linkFile(ctx, { fileId: capture.document_id, entityKind: 'vendor_bill', entityId: targetId, idempotencyKey: `${delegatedKey}:lk` }));
      if (!linked.ok) throw new CaptureAbort(linked);
      if (!fileLinkedTo(ctx, capture.document_id, 'vendor_bill', targetId)) {
        throw new CaptureAbort(notOwn('files_link', { fileId: capture.document_id, vendorBillId: targetId }));
      }
      const attached = ctx.store.innerWrite('capture_commit', () => attachReceipt(ctx, { vendorBillId: targetId, receiptRef: capture.document_id, idempotencyKey: `${delegatedKey}:ar` }));
      if (!attached.ok) throw new CaptureAbort(attached);
      const receiptRef = ctx.store.db.prepare('SELECT receipt_ref FROM vendor_bill WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, targetId) as { receipt_ref: string | null };
      if (receiptRef.receipt_ref !== capture.document_id) throw new CaptureAbort(notOwn('attach_receipt', { vendorBillId: targetId }));
    } else {
      // expense_line: onto a supplied draft claim, or a fresh one for the target employee.
      let claimId = target.claimId;
      if (typeof claimId !== 'string' || claimId.length === 0) {
        if (typeof target.employeeId !== 'string' || target.employeeId.length === 0) {
          throw new CaptureAbort(err('needs_open_claim', { captureId: capture.id }));
        }
        const employeeId = target.employeeId;
        const claim = ctx.store.innerWrite('capture_commit', () => createClaim(ctx, { employeeId, title: 'Belegerfassung', idempotencyKey: `${delegatedKey}:clm` }));
        if (!claim.ok) throw new CaptureAbort(claim);
        claimId = (claim as unknown as { claimId: string }).claimId;
        const held = ctx.store.db
          .prepare('SELECT employee_id, status, idempotency_key FROM expense_claim WHERE workspace_id = ? AND id = ?')
          .get(ctx.workspaceId, claimId) as { employee_id: string; status: string; idempotency_key: string } | undefined;
        if (held === undefined || held.employee_id !== employeeId || held.status !== 'draft' || held.idempotency_key !== `${delegatedKey}:clm`) {
          throw new CaptureAbort(notOwn('expense_claim_create', { claimId }));
        }
      }
      const amount = field('amount') as { minor?: number; currency?: unknown } | undefined;
      if (amount === undefined || typeof amount.minor !== 'number') {
        throw new CaptureAbort(err('needs_amount', { captureId: capture.id }));
      }
      // The expense line carries its own currency and converts it ONCE through §H-FX (E02), so a
      // foreign receipt books its base amount at the rate, never its minor units relabelled as base; an
      // unresolvable rate is E02's own refusal and rolls the whole commit back.
      const currency = commitCurrency(ctx, capture.id, amount, field('currency'));
      const expenseDate = target.expenseDate ?? (typeof field('invoice_date') === 'string' ? (field('invoice_date') as string) : ctx.clock.now().slice(0, 10));
      const lineClaimId = claimId;
      const lineMinor = amount.minor;
      // The capture owns the document it uploaded: it files it against the claim first (moving a link a
      // squatter set, as the bill branch does), so E02's receipt pointer finds it already on this claim.
      const claimLinked = ctx.store.innerWrite('capture_commit', () => linkFile(ctx, { fileId: capture.document_id, entityKind: 'expense_claim', entityId: lineClaimId, idempotencyKey: `${delegatedKey}:lkc` }));
      if (!claimLinked.ok) throw new CaptureAbort(claimLinked);
      if (!fileLinkedTo(ctx, capture.document_id, 'expense_claim', lineClaimId)) {
        throw new CaptureAbort(notOwn('files_link', { fileId: capture.document_id, claimId: lineClaimId }));
      }
      const line = ctx.store.innerWrite('capture_commit', () => upsertLine(ctx, {
        claimId: lineClaimId,
        line: {
          expenseDate,
          category: target.category ?? 'other',
          amountMinor: lineMinor,
          currency,
          ...(target.taxCode !== undefined ? { taxCode: target.taxCode } : typeof field('tax_code') === 'string' ? { taxCode: field('tax_code') as string } : {}),
          ...(target.expenseAccountId ? { expenseAccountId: target.expenseAccountId } : {}),
          receiptDocumentId: capture.document_id,
          ...(target.projectId ? { projectId: target.projectId } : {}),
        },
        idempotencyKey: `${delegatedKey}:eln`,
      }));
      if (!line.ok) throw new CaptureAbort(line);
      targetId = (line as unknown as { lineId: string }).lineId;
      const booked = ctx.store.db
        .prepare('SELECT claim_id, receipt_document_id, idempotency_key FROM expense_line WHERE workspace_id = ? AND id = ?')
        .get(ctx.workspaceId, targetId) as { claim_id: string; receipt_document_id: string | null; idempotency_key: string | null } | undefined;
      if (booked === undefined || booked.claim_id !== lineClaimId || booked.receipt_document_id !== capture.document_id || booked.idempotency_key !== `${delegatedKey}:eln`) {
        throw new CaptureAbort(notOwn('expense_line_upsert', { lineId: targetId, claimId: lineClaimId }));
      }
    }

    const at = ctx.clock.now();
    ctx.store.db
      .prepare("UPDATE captures SET status = 'committed', target_kind = ?, target_id = ?, committed_by = ?, committed_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(target.kind, targetId, ctx.actor, at, at, ctx.workspaceId, capture.id);
    ctx.audit.record({ entityKind: 'capture', entityId: capture.id, action: 'commit', actor: ctx.actor, at });
    // A41.3 re-cut v2 (D184, I-D, H4): committed into its own bill or expense line, the receipt is no bank
    // line's Beleg any more; the line follows the bill's payment, never a second expense.
    assignmentOnCaptureCommitted(ctx, capture.id);
    return ok({ captureId: capture.id, targetKind: target.kind, targetId });
  };

  return runGuarded(() => ctx.store.rememberIdempotent(ctx.workspaceId, scoped, 'capture_commit', run));
}

// --- Discard ------------------------------------------------------------------------------------

export interface CaptureDiscardInput {
  captureId: string;
  reason?: string;
  idempotencyKey?: string;
}

/** Flip a `needs_review` capture to `discarded` (terminal). The E00 document is untouched. */
export function captureDiscard(ctx: WorkspaceContext, input: CaptureDiscardInput): Result {
  const key = typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0 ? input.idempotencyKey : undefined;
  const scoped = key !== undefined ? JSON.stringify([input.captureId, key]) : undefined;
  if (scoped !== undefined) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scoped, 'capture_discard');
    if (replayed !== undefined) return replayed;
  }
  const capture = readCapture(ctx, input.captureId);
  if (capture === undefined) return err('not_found', { captureId: input.captureId });
  if (capture.status === 'committed') {
    return err('invalid_state', { captureId: capture.id, status: capture.status });
  }
  if (capture.status === 'discarded') {
    // Terminal already; idempotent no-op success.
    return ok({ captureId: capture.id, status: 'discarded' });
  }
  // A41.3: only a PERSON ends a person's receipt assignment (I-D). That rule lives in ONE place, the store's
  // `closeAssignment` (critic r2 M2/M3): a machine discard of a receipt a person assigned is refused there
  // (`receipt_assigned`) inside this transaction, which rolls back whole.
  const run = (): Result => {
    const at = ctx.clock.now();
    ctx.store.db
      .prepare("UPDATE captures SET status = 'discarded', discard_reason = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(typeof input.reason === 'string' ? input.reason : null, at, ctx.workspaceId, capture.id);
    ctx.audit.record({ entityKind: 'capture', entityId: capture.id, action: 'discard', actor: ctx.actor, at });
    // Critic A41.3 r1 R2: a discarded receipt is no line's Beleg: its assignment ends in this transaction, so
    // a re-drop of the same bytes (the documented recovery) is free to be assigned again.
    assignmentOnCaptureDiscarded(ctx, capture.id);
    return ok({ captureId: capture.id, status: 'discarded' });
  };
  return runGuarded(() => (scoped !== undefined ? ctx.store.rememberIdempotent(ctx.workspaceId, scoped, 'capture_discard', run) : ctx.store.tx(run)));
}

// --- Reads --------------------------------------------------------------------------------------

function projectField(row: FieldRow): Record<string, unknown> {
  return {
    id: row.id,
    key: row.key,
    value: fieldValue(row),
    confidence: row.confidence,
    provenance: row.provenance,
    superseded: row.superseded !== SUPERSEDED.live,
    // Why a superseded row is history: `discarded_with_bill` is a typed value on a bill key that a
    // different winning bill reset (owner decision 01.10.2026); the drawer words it. Null otherwise.
    supersededReason: row.superseded === SUPERSEDED.discardedWithBill ? 'discarded_with_bill' : null,
    qrPayloadId: row.qr_payload_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectCapture(row: CaptureRow): Record<string, unknown> {
  let notes: unknown = [];
  try {
    notes = JSON.parse(row.parse_notes);
  } catch {
    notes = [];
  }
  return {
    id: row.id,
    documentId: row.document_id,
    sha256: row.sha256,
    status: row.status,
    rescuedFromCaptureId: row.rescued_from_capture_id,
    qrPresent: row.qr_present === 1,
    swicoPresent: row.swico_present === 1,
    parseNotes: notes,
    targetKind: row.target_kind,
    targetId: row.target_id,
    committedBy: row.committed_by,
    committedAt: row.committed_at,
    discardReason: row.discard_reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ListCapturesInput {
  status?: string;
  from?: string;
  to?: string;
  savedViewId?: string;
}

/** The queue read model (P5). The default view excludes `discarded`; a status filter overrides it. */
export function listCaptures(ctx: WorkspaceContext, input: ListCapturesInput): Result {
  // The G00 seam (OP10): a stored view's filters merge underneath anything named explicitly here.
  const applied = applySavedView(ctx, 'capture', {
    savedViewId: input.savedViewId,
    status: input.status,
    from: input.from,
    to: input.to,
  });
  if (!applied.ok) return applied;
  const filter = applied.filter as ListCapturesInput;

  const clauses = ['workspace_id = ?'];
  const params: (string | number)[] = [ctx.workspaceId];
  if (typeof filter.status === 'string' && filter.status.length > 0) {
    clauses.push('status = ?');
    params.push(filter.status);
  } else {
    clauses.push("status != 'discarded'");
  }
  if (typeof filter.from === 'string' && filter.from.length > 0) {
    clauses.push('created_at >= ?');
    params.push(filter.from);
  }
  if (typeof filter.to === 'string' && filter.to.length > 0) {
    clauses.push('created_at <= ?');
    params.push(filter.to);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM captures WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT 500`)
    .all(...params) as CaptureRow[];
  const captures = rows.map((row) => {
    const projected = projectCapture(row);
    const fields = liveFields(ctx, row.id).map(projectField);
    return { ...projected, fields };
  });
  return ok({ captures, total: captures.length });
}

export interface GetCaptureInput {
  captureId: string;
}

/** One capture, its fields (live plus superseded history), and its document reference (P5). */
export function getCapture(ctx: WorkspaceContext, input: GetCaptureInput): Result {
  const row = readCapture(ctx, input.captureId);
  if (row === undefined) return err('not_found', { captureId: input.captureId });
  const fields = ctx.store.db
    .prepare('SELECT * FROM capture_fields WHERE workspace_id = ? AND capture_id = ? ORDER BY key, superseded, created_at')
    .all(ctx.workspaceId, row.id) as FieldRow[];
  return ok({
    capture: projectCapture(row),
    fields: fields.map(projectField),
    qrPayloads: qrPayloadsOf(ctx, row.id),
    documentId: row.document_id,
  });
}

interface QrPayloadRow {
  id: string;
  payload: string;
  sha256: string;
  source: string;
  decoder: string | null;
  warnings: string;
  created_by: string;
  created_at: string;
}

function parseJsonArray(raw: string): unknown[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** The supplied-payload evidence of one capture (§0a item 9), oldest first. §H-TENANT scoped. */
function qrPayloadsOf(ctx: WorkspaceContext, captureId: string): {
  id: string;
  payload: string;
  sha256: string;
  source: string;
  decoder: string | null;
  warnings: unknown[];
  fieldIds: string[];
  createdBy: string;
  createdAt: string;
}[] {
  const rows = ctx.store.db
    .prepare('SELECT * FROM capture_qr_payloads WHERE workspace_id = ? AND capture_id = ? ORDER BY created_at, rowid')
    .all(ctx.workspaceId, captureId) as QrPayloadRow[];
  // The field rows a payload wrote are the ones that reference it: one link, stored once, as an FK
  // that G04's restore remaps (a JSON id list here was lost on every restore, critic F3).
  const fieldIdsOf = ctx.store.db.prepare(
    'SELECT id FROM capture_fields WHERE workspace_id = ? AND capture_id = ? AND qr_payload_id = ? ORDER BY created_at, rowid',
  );
  return rows.map((r) => ({
    id: r.id,
    payload: r.payload,
    sha256: r.sha256,
    source: r.source,
    decoder: r.decoder,
    warnings: parseJsonArray(r.warnings),
    fieldIds: (fieldIdsOf.all(ctx.workspaceId, captureId, r.id) as { id: string }[]).map((f) => f.id),
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}
