/**
 * A31, document capture: the §H-ENUM single-source vocabularies.
 *
 * Every enum a capture row can carry lives here and NOWHERE else, because provenance stops being
 * evidence the moment a second file can disagree about what `qr` means or which mime the queue
 * accepts. `docs/specs/specs/A31-document-capture.md` §6b fixes each of these as non-customizable:
 * a workspace-defined provenance value would turn the audit trail into dialect.
 *
 * These are consumed by the engine (`capture.ts`, `captureParse.ts`), by the schema's CHECK
 * constraints (`captureSchema.ts`), and by the action layer's input validation. One definition, so a
 * new field key is one edit here plus the schema, never a grep across the surface.
 */

/** The capture lifecycle. `needs_review` is the only non-terminal state (§4 state machine). */
export const CAPTURE_STATUSES = ['needs_review', 'committed', 'discarded'] as const;
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];
export function isCaptureStatus(v: unknown): v is CaptureStatus {
  return typeof v === 'string' && (CAPTURE_STATUSES as readonly string[]).includes(v);
}

/**
 * The field keys a capture may propose. Every extracted value lands under exactly one of these, so a
 * caller (agent or operator) that names anything else is refused `unknown_field_key` structurally
 * rather than storing a value no reader can interpret.
 */
export const CAPTURE_FIELD_KEYS = [
  'vendor_name',
  'vendor_uid',
  'vendor_contact_id',
  'iban',
  'reference',
  'reference_type',
  'amount',
  'currency',
  'invoice_no',
  'invoice_date',
  'due_date',
  'customer_reference',
  'vat_rate',
  'vat_breakdown',
  'import_vat',
  'payment_conditions',
  'expense_account_id',
  'tax_code',
  'doc_type',
] as const;
export type CaptureFieldKey = (typeof CAPTURE_FIELD_KEYS)[number];
export function isCaptureFieldKey(v: unknown): v is CaptureFieldKey {
  return typeof v === 'string' && (CAPTURE_FIELD_KEYS as readonly string[]).includes(v);
}

/** How sure a source is of a value. Deterministic sources assert `high`; a human assertion is `high` too. */
export const CAPTURE_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type CaptureConfidence = (typeof CAPTURE_CONFIDENCES)[number];
export function isCaptureConfidence(v: unknown): v is CaptureConfidence {
  return typeof v === 'string' && (CAPTURE_CONFIDENCES as readonly string[]).includes(v);
}

/**
 * Where a value came from. The rank order used by the merge rules is DERIVED from this list in
 * `capture.ts`, not restated: `qr`/`swico` are deterministic (equal top rank), `agent` consumes
 * context a local pass does not, and `operator` is terminal against any non-operator source.
 */
export const CAPTURE_PROVENANCES = ['qr', 'swico', 'local_model', 'agent', 'operator'] as const;
export type CaptureProvenance = (typeof CAPTURE_PROVENANCES)[number];
export function isCaptureProvenance(v: unknown): v is CaptureProvenance {
  return typeof v === 'string' && (CAPTURE_PROVENANCES as readonly string[]).includes(v);
}

/** The two commit targets, the single source that also types the `target_kind` column (§4). */
export const CAPTURE_TARGET_KINDS = ['vendor_bill', 'expense_line'] as const;
export type CaptureTargetKind = (typeof CAPTURE_TARGET_KINDS)[number];
export function isCaptureTargetKind(v: unknown): v is CaptureTargetKind {
  return typeof v === 'string' && (CAPTURE_TARGET_KINDS as readonly string[]).includes(v);
}

/**
 * The mime types the capture queue accepts. E00 accepts any mime; the queue does not, because a
 * capture is a business document and a `.mp4` is a mis-wired upload. Widening this set is a spec
 * change, never a config (§4 scope degradation).
 */
export const CAPTURE_ACCEPTED_MIMES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/tiff',
] as const;
export type CaptureAcceptedMime = (typeof CAPTURE_ACCEPTED_MIMES)[number];
export function isCaptureAcceptedMime(v: unknown): v is CaptureAcceptedMime {
  return typeof v === 'string' && (CAPTURE_ACCEPTED_MIMES as readonly string[]).includes(v);
}

/** The value set of the `doc_type` field key, pre-selecting the review pane's target toggle. */
export const CAPTURE_DOC_TYPES = ['vendor_bill', 'expense', 'other'] as const;
export type CaptureDocType = (typeof CAPTURE_DOC_TYPES)[number];
export function isCaptureDocType(v: unknown): v is CaptureDocType {
  return typeof v === 'string' && (CAPTURE_DOC_TYPES as readonly string[]).includes(v);
}
