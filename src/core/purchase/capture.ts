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
import { applySavedView } from '../customization/views.js';
import { baseCurrencyOf } from '../fx/rates.js';

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
    fields: parsed.fields.map((f) => ({ key: f.key, value: f.value, confidence: f.confidence, provenance: f.provenance })),
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
    ctx.store.db
      .prepare(
        `INSERT INTO captures
           (id, workspace_id, document_id, sha256, status, rescued_from_capture_id, qr_present, swico_present,
            parse_notes, target_kind, target_id, committed_by, committed_at, discard_reason, created_by,
            idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'needs_review', ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
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
      );
    mergeBill(ctx, id, bytesBill(parsed), { kind: 'bytes' });
    ctx.audit.record({ entityKind: 'capture', entityId: id, action: 'intake', actor: ctx.actor, at });
    return ok({ captureId: id, duplicate: false, ...(discardedTwin !== undefined ? { rescuedFromCaptureId: discardedTwin.id } : {}) });
  };

  const wrapped = (): Result =>
    key !== undefined
      ? ctx.store.rememberIdempotent(ctx.workspaceId, key, 'capture_document', run)
      : ctx.store.tx(run);
  return runGuarded(wrapped);
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
    }
  }

  const run = (): Result => {
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
      // The receipt reference (A17's own pointer) AND the E00 entity link (which derives OR 958f
      // retention) do different jobs; both fire.
      const attached = ctx.store.innerWrite('capture_commit', () => attachReceipt(ctx, { vendorBillId: targetId, receiptRef: capture.document_id, idempotencyKey: `${delegatedKey}:ar` }));
      if (!attached.ok) throw new CaptureAbort(attached);
      const receiptRef = ctx.store.db.prepare('SELECT receipt_ref FROM vendor_bill WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, targetId) as { receipt_ref: string | null };
      if (receiptRef.receipt_ref !== capture.document_id) throw new CaptureAbort(notOwn('attach_receipt', { vendorBillId: targetId }));
      const linked = ctx.store.innerWrite('capture_commit', () => linkFile(ctx, { fileId: capture.document_id, entityKind: 'vendor_bill', entityId: targetId, idempotencyKey: `${delegatedKey}:lk` }));
      if (!linked.ok) throw new CaptureAbort(linked);
      if (!fileLinkedTo(ctx, capture.document_id, 'vendor_bill', targetId)) {
        throw new CaptureAbort(notOwn('files_link', { fileId: capture.document_id, vendorBillId: targetId }));
      }
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
  const run = (): Result => {
    const at = ctx.clock.now();
    ctx.store.db
      .prepare("UPDATE captures SET status = 'discarded', discard_reason = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(typeof input.reason === 'string' ? input.reason : null, at, ctx.workspaceId, capture.id);
    ctx.audit.record({ entityKind: 'capture', entityId: capture.id, action: 'discard', actor: ctx.actor, at });
    return ok({ captureId: capture.id, status: 'discarded' });
  };
  return scoped !== undefined ? ctx.store.rememberIdempotent(ctx.workspaceId, scoped, 'capture_discard', run) : ctx.store.tx(run);
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
