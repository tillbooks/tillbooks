/**
 * A31's six verbs (4 writes + 2 reads), defined here and spread into `ACTIONS` as ONE line (the
 * `fxActions` / `purchaseActions` precedent), so several agents appending to the append-only registry
 * at once collide over a line rather than a block.
 *
 * The four writes all mint or move a queue record, so every one carries `idempotencyKey` and none
 * belongs in the conformance gate's key-exemption list. The commit verb produces a DRAFT only (P8):
 * posting is A17's separately-dialled `post_vendor_bill`, never reached here.
 *
 * As with `purchase-actions.ts`, the helpers arrive as a parameter rather than an import, so the
 * module graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, ApiDeps, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  captureIntake,
  captureExtract,
  captureCommit,
  captureDiscard,
  listCaptures,
  getCapture,
} from '../core/purchase/index.js';
import { readSourcePath } from '../core/files/index.js';
import { bankLineCandidatesForCaptures } from '../core/banking/belegMatch.js';
import { STATEMENT_COVERS_SQL } from '../core/banking/bankInbox.js';
import { figuresTrust } from '../core/banking/belegTrust.js';
import { confirmableStateOf } from '../core/banking/belegAssignment.js';
import type { FiguresTrust } from '../core/banking/belegTrust.js';
import { err } from '../core/result.js';
import type { ActionKind } from './actionKind.js';

/**
 * A41.1 (D184): each capture under review carries `bankLineCandidates`, the open or "Ohne Beleg" debit lines
 * it fits (the inbox's own matcher read the other way); every other capture an empty list. A read only.
 */
function withBankLineCandidates(ctx: WorkspaceContext, result: Result): Result {
  if (!result.ok) return result;
  const captures = (result as unknown as { captures?: Record<string, unknown>[] }).captures;
  if (!Array.isArray(captures)) return result;
  const byCapture = bankLineCandidatesForCaptures(ctx, STATEMENT_COVERS_SQL);
  return {
    ...result,
    captures: captures.map((c) => ({ ...c, bankLineCandidates: byCapture.get(String(c.id)) ?? [], ...trustOf(ctx, String(c.id)) })),
  } as Result;
}

/**
 * A41.3 re-cut v2 (D184, I-F): whether a capture's live figures may back an unattended booking under
 * `belege.autobook_figure_trust = confirmed`: `figuresTrust` says why (`confirmed`: a person's "Zahlen
 * bestätigen" names exactly these figures; `qr`: read from the receipt's Swiss QR code), null otherwise.
 */
function trustOf(
  ctx: WorkspaceContext,
  captureId: string,
): { figuresTrusted: boolean; figuresTrust: FiguresTrust | null; engineFields: Record<string, unknown>; sha256: string | null } {
  const trust = figuresTrust(ctx, captureId);
  // What "Zahlen bestätigen" sends back as `expected` (security review): the bytes and every engine field.
  const seen = confirmableStateOf(ctx, captureId);
  return { figuresTrusted: trust !== null, figuresTrust: trust, engineFields: seen?.fields ?? {}, sha256: seen?.sha256 ?? null };
}

/** `get_capture` carries the same two fields on its capture. */
function withCaptureTrust(ctx: WorkspaceContext, result: Result): Result {
  if (!result.ok) return result;
  const capture = (result as unknown as { capture?: Record<string, unknown> }).capture;
  if (capture === undefined || typeof capture.id !== 'string') return result;
  return { ...result, capture: { ...capture, ...trustOf(ctx, capture.id) } } as Result;
}

export interface CaptureActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput, deps: ApiDeps) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

const ARR = { type: 'array' } as const;
const OBJ = { type: 'object' } as const;

/**
 * N02 (D183): `capture_document` by PATH. Exactly one of `contentBase64` and `sourcePath`; the confined
 * read (local hosts only, `files.source_roots`) answers the bytes and their sniffed type, and the capture
 * engine then runs exactly as for base64, its own accepted-mime rule included (a WebP refuses
 * `unsupported_mime`, A31 §6b).
 */
function captureFromInput(ctx: WorkspaceContext, input: ActionInput, deps: ApiDeps): Result {
  if (input.sourcePath === undefined) return captureIntake(ctx, as(input));
  if (input.contentBase64 !== undefined) {
    return err('invalid_input', { field: 'sourcePath', reason: 'exactly_one_of', fields: ['contentBase64', 'sourcePath'] });
  }
  const read = readSourcePath(ctx, deps.localFiles, input.sourcePath);
  if ((read as { ok?: unknown }).ok === false) return read as Result;
  const file = (read as { file: { bytes: Buffer; mime: string; filename: string } }).file;
  return captureIntake(ctx, {
    contentBase64: file.bytes.toString('base64'),
    mime: file.mime,
    filename: typeof input.filename === 'string' ? input.filename : file.filename,
    ...(typeof input.idempotencyKey === 'string' ? { idempotencyKey: input.idempotencyKey } : {}),
  });
}

/** The A31 verbs, in append order. */
export function captureActions(h: CaptureActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;

  return [
    ctxAction(
      'capture_document',
      'write:correctable:internal',
      'Ingest a supplier document into the Belegeingang queue (Belegerfassung). contentBase64 is the raw bytes; mime must be one of application/pdf, image/jpeg, image/png, image/heic, image/tiff (the queue refuses anything else, unlike E00). The file is stored via E00 and the deterministic pass decodes any Swiss QR Code payload present as text (creditor, IBAN, amount, currency, QRR/SCOR reference revalidated by check digit, and the Swico S1 billing information), landing each value as a provenance-stamped field. A byte-identical re-drop returns the existing capture ({duplicate:true}) and writes nothing; a hash matching only a discarded capture creates a fresh one cross-linking it (recovery). Posts nothing. Instead of contentBase64 and mime, sourcePath names a file on THIS computer under files.source_roots (local till mcp or till up only, else source_path_local_only): the bytes are read, sniffed and captured as above (path_not_allowed, file_not_found, unsupported_type for anything but a PDF or an image). A receipt that already evidences a live booking (or waits for a Vorschlag) is queued like any other, and the answer names it: alreadyBooked: true and holders (each entityKind, entityId, and reservedBy for a waiting Vorschlag); committing it then meets the receipt rule (files.duplicate_beleg).',
      ctxSchema({ contentBase64: STR, mime: STR, sourcePath: STR, filename: STR, idempotencyKey: STR }, ['idempotencyKey']),
      (ctx, input, deps) => captureFromInput(ctx, input, deps),
    ),
    ctxAction(
      'capture_extract',
      'write:correctable:internal',
      "Re-run or augment a capture's extraction. source='qr' re-runs the deterministic pass; source='agent' takes caller-supplied fields (each {key,value,confidence}, validated against the CAPTURE_FIELD_KEY registry); source='operator' takes review-pane corrections (each {key,value}, landing as operator/high); source='local_model' degrades honestly to needs_local_runtime (no on-device model is wired in the core). Instead of fields, source='operator' or 'agent' may pass qrPayload: the text of the bill's Swiss QR Code as a phone scanner or decoder read it (optional decoder label, e.g. 'phone-scanner' or 'plugin:<id>'). It is checked strictly against the SIX QR-bill guideline v2.3; any violation refuses the whole payload with qr_payload_invalid and lists every issue (code, element, line, message), writing nothing. A clean payload lands creditor name and address, IBAN, amount, currency, reference and message plus the Swico S1 billing information as fields with the caller's provenance at high confidence, and records the raw payload as evidence (get_capture qrPayloads). Merge rules are fixed: an operator value is never overwritten by a machine source, higher confidence wins, and a deterministic source outranks a probabilistic one at equal confidence; the loser is kept as a superseded row (auditable disagreement, never a silent drop). Re-running on unchanged input is a no-op. A41: a value with a control, format or separator character (a bidi override, a zero-width space, a line break) in amount, currency, vat_amount, vendor_name, iban, vendor_uid, invoice_date or due_date refuses invalid_field_characters { key }, and an iban failing its check digits refuses invalid_iban { key }; nothing is written.",
      ctxSchema({ captureId: STR, source: STR, fields: ARR, qrPayload: STR, decoder: STR, idempotencyKey: STR }, ['captureId', 'source', 'idempotencyKey']),
      (ctx, input) => captureExtract(ctx, as(input)),
    ),
    ctxAction(
      'capture_commit',
      'write:correctable:internal',
      "Commit a reviewed capture into a DRAFT: target.kind='vendor_bill' delegates to A17 create_vendor_bill (+ attach_receipt + the E00 entity link that derives OR 958f retention), and target.kind='expense_line' delegates to E02 (onto target.claimId, or a fresh draft claim for target.employeeId). Requires the delegated verb's own capability (post for a bill, spesen.submit for an expense), re-checked inside the delegation. Posts NOTHING: the target lands as a draft and posting it is A17's separately-dialled step (P8). corrections (each {key,value}) land as operator fields before delegation. Idempotent: a double-commit returns the original target_id and never creates a second draft. Refuses document_already_linked when the capture's own document already belongs to another record, and receipt_already_booked (naming the holders) when the same receipt already evidences a live booking (an entry not reversed, a bill not void, a payment, a booked bank line, an expense claim) or waits for another Vorschlag; a person's bookAgain: true with an overrideReason books it anyway, recorded on the audit trail (never an agent's: human_only).",
      ctxSchema({ captureId: STR, target: OBJ, corrections: ARR, bookAgain: { type: 'boolean' }, overrideReason: STR, idempotencyKey: STR }, ['captureId', 'target', 'idempotencyKey']),
      (ctx, input) => captureCommit(ctx, as(input)),
    ),
    ctxAction(
      'capture_discard',
      'write:correctable:internal',
      'Discard a capture that is not a bookable document: flips a needs_review capture to discarded (terminal). The E00 document survives untouched (its retention is E00 law). Discarding a committed capture is refused with invalid_state (correct it on the A17/E02 side). A discarded capture is recoverable by re-uploading the same bytes (the dedupe key is scoped to non-discarded captures).',
      ctxSchema({ captureId: STR, reason: STR, idempotencyKey: STR }, ['captureId', 'idempotencyKey']),
      (ctx, input) => captureDiscard(ctx, as(input)),
    ),
    ctxAction(
      'list_captures',
      'read',
      'The Belegeingang queue: captures with their live proposed fields. The default view excludes discarded captures; pass status to filter to needs_review, committed or discarded. from/to filter on capture date; savedViewId applies a G00 saved view. A41: each capture under review carries bankLineCandidates [{ bankTxnId, state (open | booked), bookingDate, amountMinor, currency, counterparty, groupKey }], the open or booked-without-receipt debit lines its amount, date and sender fit (belege.match_mode, belege.match_date_window_days, belege.match_fx_tolerance_pct); attach it with book_bank_line attach:[{fileId}] (open) or files_link entityKind bank_txn (booked).',
      ctxSchema({ status: STR, from: STR, to: STR, savedViewId: STR }),
      (ctx, input) => withBankLineCandidates(ctx, listCaptures(ctx, as(input))),
    ),
    ctxAction(
      'get_capture',
      'read',
      "One capture with all its fields (live plus superseded history, each carrying its provenance and confidence, and qrPayloadId when a supplied QR payload wrote it), the supplied QR payloads as evidence (qrPayloads), and the E00 document reference to fetch the original via documents_get_content. A31 never serves bytes itself.",
      ctxSchema({ captureId: STR }, ['captureId']),
      (ctx, input) => withCaptureTrust(ctx, getCapture(ctx, as(input))),
    ),
  ];
}
