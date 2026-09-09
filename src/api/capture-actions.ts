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

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
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

export interface CaptureActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
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

/** The A31 verbs, in append order. */
export function captureActions(h: CaptureActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;

  return [
    ctxAction(
      'capture_document',
      'write',
      'Ingest a supplier document into the Belegeingang queue (Belegerfassung). contentBase64 is the raw bytes; mime must be one of application/pdf, image/jpeg, image/png, image/heic, image/tiff (the queue refuses anything else, unlike E00). The file is stored via E00 and the deterministic pass decodes any Swiss QR Code payload present as text (creditor, IBAN, amount, currency, QRR/SCOR reference revalidated by check digit, and the Swico S1 billing information), landing each value as a provenance-stamped field. A byte-identical re-drop returns the existing capture ({duplicate:true}) and writes nothing; a hash matching only a discarded capture creates a fresh one cross-linking it (recovery). Posts nothing.',
      ctxSchema({ contentBase64: STR, mime: STR, filename: STR, idempotencyKey: STR }, ['contentBase64', 'mime', 'idempotencyKey']),
      (ctx, input) => captureIntake(ctx, as(input)),
    ),
    ctxAction(
      'capture_extract',
      'write',
      "Re-run or augment a capture's extraction. source='qr' re-runs the deterministic pass; source='agent' takes caller-supplied fields (each {key,value,confidence}, validated against the CAPTURE_FIELD_KEY registry); source='operator' takes review-pane corrections (each {key,value}, landing as operator/high); source='local_model' degrades honestly to needs_local_runtime (no on-device model is wired in the core). Merge rules are fixed: an operator value is never overwritten by a machine source, higher confidence wins, and a deterministic source outranks a probabilistic one at equal confidence; the loser is kept as a superseded row (auditable disagreement, never a silent drop). Re-running on unchanged input is a no-op.",
      ctxSchema({ captureId: STR, source: STR, fields: ARR, idempotencyKey: STR }, ['captureId', 'source', 'idempotencyKey']),
      (ctx, input) => captureExtract(ctx, as(input)),
    ),
    ctxAction(
      'capture_commit',
      'write',
      "Commit a reviewed capture into a DRAFT: target.kind='vendor_bill' delegates to A17 create_vendor_bill (+ attach_receipt + the E00 entity link that derives OR 958f retention), and target.kind='expense_line' delegates to E02 (onto target.claimId, or a fresh draft claim for target.employeeId). Requires the delegated verb's own capability (post for a bill, spesen.submit for an expense), re-checked inside the delegation. Posts NOTHING: the target lands as a draft and posting it is A17's separately-dialled step (P8). corrections (each {key,value}) land as operator fields before delegation. Idempotent: a double-commit returns the original target_id and never creates a second draft.",
      ctxSchema({ captureId: STR, target: OBJ, corrections: ARR, idempotencyKey: STR }, ['captureId', 'target', 'idempotencyKey']),
      (ctx, input) => captureCommit(ctx, as(input)),
    ),
    ctxAction(
      'capture_discard',
      'write',
      'Discard a capture that is not a bookable document: flips a needs_review capture to discarded (terminal). The E00 document survives untouched (its retention is E00 law). Discarding a committed capture is refused with invalid_state (correct it on the A17/E02 side). A discarded capture is recoverable by re-uploading the same bytes (the dedupe key is scoped to non-discarded captures).',
      ctxSchema({ captureId: STR, reason: STR, idempotencyKey: STR }, ['captureId', 'idempotencyKey']),
      (ctx, input) => captureDiscard(ctx, as(input)),
    ),
    ctxAction(
      'list_captures',
      'read',
      'The Belegeingang queue: captures with their live proposed fields. The default view excludes discarded captures; pass status to filter to needs_review, committed or discarded. from/to filter on capture date; savedViewId applies a G00 saved view.',
      ctxSchema({ status: STR, from: STR, to: STR, savedViewId: STR }),
      (ctx, input) => listCaptures(ctx, as(input)),
    ),
    ctxAction(
      'get_capture',
      'read',
      "One capture with all its fields (live plus superseded history, each carrying its provenance and confidence) and the E00 document reference to fetch the original via documents_get_content. A31 never serves bytes itself.",
      ctxSchema({ captureId: STR }, ['captureId']),
      (ctx, input) => getCapture(ctx, as(input)),
    ),
  ];
}
