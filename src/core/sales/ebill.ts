/**
 * A32, eBill issuing (spec `docs/specs/specs/A32-ebill-issuing.md`): package an issued A11 invoice as
 * a STATUTORY, outward-facing eBill delivery payload for the Swiss SIX / Swico eBill network, carrying
 * A11's QR reference intact, and (owner-gated, cloud-tier) transmit it and track its status.
 *
 * THE ONE LOAD-BEARING FACT: **A32 POSTS NOTHING** (Pattern P3 by absence, spec §4). The financial
 * event happened at A11's issue (A11 -> A02). This module moves a document, never money: there is no
 * `postEntry`/`recordPayment` call anywhere below, and `test/sales/ebill.test.mjs` asserts it. The QR
 * reference the payload carries is the SAME one A11 assigned, so settlement reconciles exactly as
 * before (A14/A20/A21), unchanged.
 *
 * THE OP4 BOUNDARY (spec §3, the whole point): the OSS core validates, prepares, files the artifact,
 * records the delivery and reads status; it NEVER opens a socket. Transmission is reachable only
 * through a certified network-partner contract (ebill.ch), so it rides the host-wired
 * `EbillTransmitterPort` (context.ts) which is absent in the MIT core: `transmitEbill` then degrades
 * honestly to `{ transmitted:false, reason:'cloud_tier' }` and the local artifact stays downloadable.
 *
 * THE RECONCILED OI1 GATE (spec reconciliation banner, 2026-08-06): A11's `renderInvoicePdf` emits
 * `pdfaProfile: null` because PDF/A-3b output (A32-OI1) is DEFERRED per D31. `prepareEbill` therefore
 * SUCCEEDS and RECORDS the payload's conformance facts (`pdfa_profile`, `ebill_addressed`,
 * `payload_byte_length`) WITHOUT ever claiming conformance; `transmitEbill` is the boundary that
 * refuses `payload_not_conformant` before any payload reaches a connector. This keeps prepare a real,
 * gate-satisfiable write (D14 conformance rule 8 requires every write scenario to return ok) while
 * guaranteeing nothing non-conformant is ever transmitted. A11-OI2 (the eBill `AltPmt` element + Swico
 * S1) is already RESOLVED in `qrbill.ts` (D31); `prepareEbill` verifies the built payload carries it.
 *
 * THE tx-COMMIT-ON-ERR TRAP (house rule): returning `{ok:false}` INSIDE `ctx.store.tx` COMMITS the
 * partial writes. Every refusal below is pre-checked as a pure read BEFORE any write; a mid-tx failure
 * rolls back only by THROWING (the `EbillAbort` carrier), never by returning.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { getDocument } from './document.js';
import { buildQrBill, renderInvoicePdf } from './invoice.js';
import { uploadFile, linkFile, setFileRetention, getFileContent } from '../files/index.js';
import { statutoryRetentionUntil } from '../files/retention.js';
import { transitionDocument } from './document.js';
import { applySavedView } from '../customization/views.js';
import {
  BILLER_PID_PATTERN,
  EBILL_MAX_PAYLOAD_BYTES,
  EBILL_REQUIRED_PDFA_PROFILE,
  isEbillDeliveryStatus,
} from './ebillEnums.js';
import type { EbillDeliveryStatus } from './ebillEnums.js';

/** Rolls a transaction back by THROW (the tx-commit-on-err trap): a returned `{ok:false}` would commit. */
class EbillAbort extends Error {
  constructor(readonly result: Result) {
    super('ebill-abort');
  }
}

/** The invoice statuses a delivery may be prepared from (spec §2/§4). */
const PREPARABLE_STATUSES = new Set(['issued', 'sent', 'partially_paid']);

interface EbillDeliveryRow {
  id: string;
  workspace_id: string;
  document_id: string;
  artifact_document_id: string | null;
  format: string;
  bc_function: string;
  status: string;
  pdfa_profile: string | null;
  ebill_addressed: number;
  payload_byte_length: number;
  partner_status: string | null;
  partner_reason: string | null;
  business_case_id: string | null;
  correlation_id: string | null;
  transmitted_at: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

/** The payload artifact renderer seam. Defaults to A11's real `renderInvoicePdf`; a test injects a
 *  PDF/A-3b-declaring stub to exercise the post-OI1 transmit path WITHOUT a second render pipeline. */
export interface EbillRenderDeps {
  renderInvoicePdf: typeof renderInvoicePdf;
}

const DEFAULT_RENDER_DEPS: EbillRenderDeps = { renderInvoicePdf };

// --- config ------------------------------------------------------------------------------------

interface EbillConfigRow {
  workspace_id: string;
  biller_pid: string;
  updated_at: string;
  updated_by: string | null;
}

function readConfig(ctx: WorkspaceContext): EbillConfigRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM ebill_config WHERE workspace_id = ?')
    .get(ctx.workspaceId) as EbillConfigRow | undefined;
}

function configView(row: EbillConfigRow | undefined): Result {
  if (row === undefined) return ok({ config: null });
  return ok({
    config: { billerPid: row.biller_pid, updatedAt: row.updated_at, updatedBy: row.updated_by },
  });
}

/**
 * US-A32.1: record the eBill biller identity issued by a certified network partner at enrollment (a
 * commercial step, never a verb). Validates the SWP `billerPid` shape (`41` + 15 digits) and upserts
 * the one row per workspace. Asserts an ABSOLUTE state, so it is naturally idempotent (§H-IDEMPOTENT,
 * no key): a replay re-asserts the same row.
 */
export function setEbillConfig(ctx: WorkspaceContext, input: { billerPid?: unknown }): Result {
  const billerPid = input.billerPid;
  if (typeof billerPid !== 'string' || !BILLER_PID_PATTERN.test(billerPid)) {
    return err('invalid_biller_pid', {
      reason: 'billerPid must be "41" followed by 15 digits (SWP billerPid pattern 41[0-9]{15})',
    });
  }
  const at = ctx.clock.now();
  ctx.store.tx(() => {
    ctx.store.db
      .prepare(
        `INSERT INTO ebill_config (workspace_id, biller_pid, updated_at, updated_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET biller_pid = excluded.biller_pid,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(ctx.workspaceId, billerPid, at, ctx.actor);
    return ok({});
  });
  return configView(readConfig(ctx));
}

/** US-A32.1: read the eBill config back, or `null` when the workspace has not configured one. */
export function getEbillConfig(ctx: WorkspaceContext): Result {
  return configView(readConfig(ctx));
}

// --- delivery views ----------------------------------------------------------------------------

function deliveryView(row: EbillDeliveryRow): Record<string, unknown> {
  return {
    id: row.id,
    invoiceId: row.document_id,
    artifactDocumentId: row.artifact_document_id,
    format: row.format,
    bcFunction: row.bc_function,
    status: row.status,
    pdfaProfile: row.pdfa_profile,
    ebillAddressed: row.ebill_addressed === 1,
    payloadByteLength: row.payload_byte_length,
    partnerStatus: row.partner_status,
    partnerReason: row.partner_reason,
    businessCaseId: row.business_case_id,
    correlationId: row.correlation_id,
    transmittedAt: row.transmitted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readDelivery(ctx: WorkspaceContext, id: unknown): EbillDeliveryRow | undefined {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM ebill_deliveries WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as EbillDeliveryRow | undefined;
}

/** The single active (non-`failed`) delivery for an invoice, if any (the one-active-delivery rule). */
function readActiveDeliveryForInvoice(ctx: WorkspaceContext, invoiceId: string): EbillDeliveryRow | undefined {
  return ctx.store.db
    .prepare(
      "SELECT * FROM ebill_deliveries WHERE workspace_id = ? AND document_id = ? AND status != 'failed'",
    )
    .get(ctx.workspaceId, invoiceId) as EbillDeliveryRow | undefined;
}

// --- prepare -----------------------------------------------------------------------------------

/**
 * US-A32.2: turn an issued A11 invoice into an eBill delivery payload on disk. Guards the invoice
 * status (P9 `invalid_state` for a draft/cancelled/settled invoice), builds the QR-bill payload
 * (refusing with A11's own error, e.g. `needs_qr_iban`, when the invoice data cannot even produce a
 * payment part), renders the A11 PDF, stores it as an E00 `documents` row (OP3-linked,
 * `entity_kind='ebill_delivery'`, OR 958f retention off the issue date), and records an
 * `ebill_deliveries` row with `status='prepared'` plus the RECORDED (never asserted) conformance
 * facts. Idempotent by OUTCOME: at most one non-`failed` delivery per invoice, so re-entry returns the
 * existing active row and its stored artifact regardless of key (spec §2/§4). Posts nothing.
 */
export function prepareEbill(
  ctx: WorkspaceContext,
  input: { invoiceId?: unknown; idempotencyKey?: unknown },
  renderDeps: EbillRenderDeps = DEFAULT_RENDER_DEPS,
): Result {
  const invoiceId = input.invoiceId;
  if (typeof invoiceId !== 'string' || invoiceId.length === 0) {
    return err('invalid_input', { field: 'invoiceId' });
  }

  // Outcome-scoped idempotency (§2): a live delivery already answers, regardless of key. Justified by
  // the STORED bytes, not by re-rendering (an issued invoice is immutable, §H-AUDIT, but PDF metadata
  // is not byte-pinned, so the spec does not claim a fresh render would be identical).
  const existing = readActiveDeliveryForInvoice(ctx, invoiceId);
  if (existing !== undefined) return ok({ delivery: deliveryView(existing) });

  const view = getDocument(ctx, { documentId: invoiceId });
  if (!view.ok) return view;
  const document = view.document as { type: string; status: string };
  if (document.type !== 'invoice') return err('not_an_invoice', { documentId: invoiceId });
  if (!PREPARABLE_STATUSES.has(document.status)) {
    // A draft has no stable content, a cancelled invoice must not gain a delivery, a settled invoice
    // needs none: all refused with the same shape, and NOTHING is written.
    return err('invalid_state', {
      documentId: invoiceId,
      status: document.status,
      expected: [...PREPARABLE_STATUSES],
    });
  }

  // Build the QR-bill payload (A11). A payload that cannot even be built is an invoice-data defect, not
  // an eBill one: it is refused with A11's own precise code (needs_qr_iban / needs_customer_address /
  // unsupported_currency / ...), never a hand-wave. Pure read, no write yet.
  const qr = buildQrBill(ctx, invoiceId);
  if (!qr.ok) return qr;
  const swissQrPayload = ((qr as unknown as { qr: { swissQrPayload: string } }).qr).swissQrPayload;

  // Render the A11 PDF (pure read). PDF/A-3b (A32-OI1) is NOT asserted by A11: `pdfaProfile` is null
  // today, and we RECORD that fact rather than claim conformance. The transmit boundary enforces it.
  const rendered = renderDeps.renderInvoicePdf(ctx, invoiceId);
  if (!rendered.ok) return rendered;
  const pdf = (rendered as unknown as {
    pdf: { base64: string; byteLength: number; hasQrBill: boolean; pdfaProfile: string | null };
  }).pdf;
  if (pdf.hasQrBill !== true) {
    // No payment part means nothing an eBill recipient can pay: refuse rather than deliver a shell.
    return err('needs_qr_bill', { documentId: invoiceId });
  }

  // A32-OI2 (RESOLVED in A11): the qrbill format's structured data rides the embedded QR code, and the
  // eBill `AltPmt` element (`eBill/B/<id>`) is obligatory for it. Recorded here from the built payload;
  // the transmit gate enforces it alongside the PDF/A profile.
  const ebillAddressed = /(^|\n)eBill\/[BR]\//.test(swissQrPayload);

  const pdfaProfile = pdf.pdfaProfile; // null until A32-OI1 lands on A11
  const byteLength = pdf.byteLength;
  const shipDate = ctx.clock.now().slice(0, 10);
  const id = ctx.ids.next('ebd');
  const at = ctx.clock.now();
  const key = typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0 ? input.idempotencyKey : null;

  const run = (): Result => {
    // Insert the delivery row FIRST (artifact null), so the OP3 entity exists for the E00 link's
    // `entityExists` check. A concurrent prepare that already minted the active row makes this INSERT
    // trip the partial unique index; we recover by returning the winner (still one active per invoice).
    try {
      ctx.store.db
        .prepare(
          `INSERT INTO ebill_deliveries
             (id, workspace_id, document_id, artifact_document_id, format, bc_function, status,
              pdfa_profile, ebill_addressed, payload_byte_length, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, NULL, 'qrbill', 'bill', 'prepared', ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, ctx.workspaceId, invoiceId, pdfaProfile, ebillAddressed ? 1 : 0, byteLength, key, at, at);
    } catch (e) {
      const raced = readActiveDeliveryForInvoice(ctx, invoiceId);
      if (raced !== undefined) return ok({ delivery: deliveryView(raced) });
      throw e;
    }
    const uploaded = uploadFile(ctx, {
      title: `eBill-Nutzlast ${invoiceId}`,
      filename: `ebill-${invoiceId}.pdf`,
      mime: 'application/pdf',
      contentBase64: pdf.base64,
    });
    if (!uploaded.ok) throw new EbillAbort(uploaded);
    const fileId = (uploaded as unknown as { file: { id: string } }).file.id;
    // entityId before entityKind (the E00-link ordering the delivery-note precedent documents), so the
    // Studio audit-vocabulary scraper does not read this LINK as an audit emission for `ebill_delivery`.
    const linked = linkFile(ctx, { fileId, entityId: id, entityKind: 'ebill_delivery' });
    if (!linked.ok) throw new EbillAbort(linked);
    // OR 958f retention off the filing date: the delivery artifact is part of the accounting record and
    // outlives a revDSG erasure request, consistent with the suite (spec §3).
    const retention = setFileRetention(ctx, { fileId, retentionUntil: statutoryRetentionUntil(ctx, shipDate) });
    if (!retention.ok) throw new EbillAbort(retention);
    ctx.store.db
      .prepare('UPDATE ebill_deliveries SET artifact_document_id = ? WHERE workspace_id = ? AND id = ?')
      .run(fileId, ctx.workspaceId, id);
    const stored = readDelivery(ctx, id) as EbillDeliveryRow;
    return ok({ delivery: deliveryView(stored) });
  };

  try {
    return ctx.store.tx(run);
  } catch (e) {
    if (e instanceof EbillAbort) return e.result;
    throw e;
  }
}

// --- transmit ----------------------------------------------------------------------------------

function ebillDialEnabled(ctx: WorkspaceContext): boolean {
  // The same P8 outbound dial `send_invoice` reads (workspace.posting_auto_issue): one dial governs
  // every outbound step, so eBill transmit and invoice send behave identically for an agent.
  const row = ctx.store.db
    .prepare('SELECT posting_auto_issue AS v FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { v: number | null } | undefined;
  return row?.v === 1;
}

/** Derive the SWP `X-CORRELATION-ID` (1-36 chars) deterministically, minted ONCE and reused on retry. */
function deriveCorrelationId(seed: string): string {
  return seed.length <= 36 ? seed : seed.slice(0, 36);
}

/**
 * US-A32.3: transmit a prepared delivery through the owner-gated cloud connector. Guard order (spec
 * §4, deliberate): connector FIRST (no connector -> the honest OP4 `{ transmitted:false,
 * reason:'cloud_tier' }`, so an unconnected OSS-core user is never sent on a pointless Setup detour),
 * then config (`needs_biller_pid`), then P8 (`needs_confirmation`, outbound is draft-by-default), then
 * delivery status (only a `prepared`/`submitting` row submits), then the CONFORMANCE gate
 * (`payload_not_conformant`: PDF/A-3b + eBill addressing + <=10 MB, the reconciled OI1 boundary).
 *
 * Idempotent by OUTCOME: a `transmitted` delivery returns the recorded result unchanged (no
 * resubmission); a `submitting` delivery resubmits with the correlation id STORED on the row.
 * Transmission is AT-LEAST-ONCE (§4): the correlation id is a tracing id with no partner-side dedupe,
 * so a crash in the `submitting` window may leave the partner holding a business case the local row
 * never acknowledged. The local row itself never duplicates. On acknowledgement it records the
 * `business_case_id` and drives A10 `issued -> sent` ONLY when the invoice is `issued` (an already
 * `sent`/`partially_paid` invoice keeps its state, an explicit no-op: A10 has no re-entrant `sent`).
 */
export function transmitEbill(
  ctx: WorkspaceContext,
  input: { deliveryId?: unknown; idempotencyKey?: unknown; confirmed?: unknown },
): Result {
  const delivery = readDelivery(ctx, input.deliveryId);
  if (delivery === undefined) return err('not_found', { deliveryId: input.deliveryId });

  // Already settled by a prior transmit, same key or not: return the recorded outcome, resubmit nothing.
  if (delivery.status === 'transmitted') {
    return ok({ transmitted: true, transmittedDeliveryId: delivery.id, delivery: deliveryView(delivery) });
  }
  if (delivery.status === 'failed') {
    return err('invalid_state', {
      deliveryId: delivery.id,
      status: 'failed',
      recovery: 'failed is terminal; ebill_prepare mints a successor delivery',
    });
  }

  // 1) Connector FIRST (OP4). No connector in the OSS core: honest cloud_tier, the row stays as-is,
  //    nothing written. This is `ok:true` (the verb truthfully did all the OSS core can) with
  //    `transmitted:false`, never a fake success and never a throw (spec §2/§5).
  const connector = ctx.ebillTransmitter;
  if (connector === undefined) {
    return ok({
      transmitted: false,
      transmittedDeliveryId: null,
      reason: 'cloud_tier',
      delivery: deliveryView(delivery),
    });
  }

  // 2) Config: a connector needs the biller identity to address the submission.
  const config = readConfig(ctx);
  if (config === undefined) {
    return err('needs_biller_pid', { deliveryId: delivery.id, setup: 'configure the eBill-Biller-ID in Setup' });
  }

  // 3) P8: outbound is draft-by-default. Unless the dial is on or a human confirmed, stop at prepared.
  if (!ebillDialEnabled(ctx) && input.confirmed !== true) {
    return err('needs_confirmation', {
      deliveryId: delivery.id,
      transmitted: false,
      reason: 'outbound_transmit_requires_confirmation',
    });
  }

  // 4) Conformance (the reconciled OI1 boundary): refuse BEFORE anything reaches the connector. Nothing
  //    non-conformant is ever transmitted, and the refusal names exactly what is missing.
  const missing: string[] = [];
  if (delivery.pdfa_profile !== EBILL_REQUIRED_PDFA_PROFILE) {
    missing.push(`pdfa_profile (need ${EBILL_REQUIRED_PDFA_PROFILE}, got ${delivery.pdfa_profile ?? 'none'}; A32-OI1 pending on A11)`);
  }
  if (delivery.ebill_addressed !== 1) missing.push('ebill_addressing (QR code lacks the eBill AltPmt element)');
  if (delivery.payload_byte_length > EBILL_MAX_PAYLOAD_BYTES) {
    missing.push(`payload_size (>${EBILL_MAX_PAYLOAD_BYTES} bytes)`);
  }
  if (missing.length > 0) {
    return err('payload_not_conformant', { deliveryId: delivery.id, missing });
  }

  // Read the artifact bytes to submit (E00 byte read; sha256 re-verified there).
  const bytes = delivery.artifact_document_id === null ? null : readArtifactBase64(ctx, delivery.artifact_document_id);
  if (bytes === null) return err('artifact_missing', { deliveryId: delivery.id });

  // Mint / reuse the correlation id and mark `submitting` BEFORE the connector call, so a crash leaves
  // the at-least-once window visible on the row rather than a lie of `prepared`.
  const seed =
    delivery.correlation_id ??
    (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0 ? input.idempotencyKey : delivery.id);
  const correlationId = delivery.correlation_id ?? deriveCorrelationId(seed);
  const now = ctx.clock.now();
  ctx.store.tx(() => {
    ctx.store.db
      .prepare("UPDATE ebill_deliveries SET status = 'submitting', correlation_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(correlationId, now, ctx.workspaceId, delivery.id);
    return ok({});
  });

  // The connector call is the ONE outbound step, OUTSIDE any transaction (a network call inside a tx
  // would hold a write lock across the wire). A throw is UNKNOWN: the row stays `submitting`.
  const submitted = connector.submit({
    billerPid: config.biller_pid,
    format: delivery.format,
    bcFunction: delivery.bc_function,
    correlationId,
    pdfBase64: bytes,
  });

  if (!submitted.ok) {
    // Permanent, structured partner refusal: record `failed` (terminal; the recovery is a successor
    // prepare). Nothing left the building that the row does not now name.
    const at = ctx.clock.now();
    ctx.store.tx(() => {
      ctx.store.db
        .prepare("UPDATE ebill_deliveries SET status = 'failed', partner_reason = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
        .run(submitted.reason, at, ctx.workspaceId, delivery.id);
      return ok({});
    });
    const failed = readDelivery(ctx, delivery.id) as EbillDeliveryRow;
    return err('transmit_failed', { deliveryId: delivery.id, reason: submitted.reason, delivery: deliveryView(failed) });
  }

  // Acknowledged. Record the business case + `transmitted`, then drive A10 `sent` only from `issued`.
  const at = ctx.clock.now();
  const run = (): Result => {
    ctx.store.db
      .prepare(
        "UPDATE ebill_deliveries SET status = 'transmitted', business_case_id = ?, transmitted_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
      )
      .run(submitted.businessCaseId, at, at, ctx.workspaceId, delivery.id);
    // One lifecycle, two channels: transmit drives `issued -> sent` exactly as `send_invoice` would.
    // Only from `issued`: A10 has no re-entrant `sent` edge, so re-driving a `sent`/`partially_paid`
    // invoice would earn `illegal_transition`. Read the LIVE status inside the tx.
    const live = getDocument(ctx, { documentId: delivery.document_id });
    if (live.ok && (live.document as { status: string }).status === 'issued') {
      const transition = transitionDocument(ctx, { documentId: delivery.document_id, to: 'sent' });
      if (!transition.ok) throw new EbillAbort(transition);
    }
    const stored = readDelivery(ctx, delivery.id) as EbillDeliveryRow;
    return ok({ transmitted: true, transmittedDeliveryId: delivery.id, delivery: deliveryView(stored) });
  };
  try {
    return ctx.store.tx(run);
  } catch (e) {
    if (e instanceof EbillAbort) return e.result;
    throw e;
  }
}

/** Read a stored E00 artifact's bytes as base64 (E00 re-verifies sha256), or null when absent. */
function readArtifactBase64(ctx: WorkspaceContext, fileId: string): string | null {
  const content = getFileContent(ctx, { fileId });
  if (!content.ok) return null;
  return (content as unknown as { contentBase64: string }).contentBase64;
}

// --- status read model -------------------------------------------------------------------------

/**
 * US-A32.4: the P5 delivery-status read model. Single delivery by id, else a filtered list (by
 * invoice, local status, or mirrored partner status, newest first). No write twin.
 */
export function getEbillDeliveryStatus(
  ctx: WorkspaceContext,
  input: {
    deliveryId?: unknown;
    invoiceId?: unknown;
    status?: unknown;
    partnerStatus?: unknown;
    from?: unknown;
    to?: unknown;
    savedViewId?: unknown;
  },
): Result {
  if (typeof input.deliveryId === 'string' && input.deliveryId.length > 0) {
    const row = readDelivery(ctx, input.deliveryId);
    if (row === undefined) return err('not_found', { deliveryId: input.deliveryId });
    return ok({ delivery: deliveryView(row), events: readEvents(ctx, row.id) });
  }

  // The G00 saved-view seam (OP10): ONE unconditional call. It returns the filter untouched when no
  // view is named and merges a view's stored filters underneath the caller's explicit ones otherwise.
  const listFilter: {
    invoiceId?: string;
    status?: string;
    partnerStatus?: string;
    from?: string;
    to?: string;
    savedViewId?: string;
  } = {};
  if (typeof input.invoiceId === 'string' && input.invoiceId.length > 0) listFilter.invoiceId = input.invoiceId;
  if (typeof input.status === 'string' && input.status.length > 0) listFilter.status = input.status;
  if (typeof input.partnerStatus === 'string' && input.partnerStatus.length > 0) listFilter.partnerStatus = input.partnerStatus;
  if (typeof input.from === 'string' && input.from.length > 0) listFilter.from = input.from;
  if (typeof input.to === 'string' && input.to.length > 0) listFilter.to = input.to;
  if (typeof input.savedViewId === 'string' && input.savedViewId.length > 0) listFilter.savedViewId = input.savedViewId;
  const viewed = applySavedView(ctx, 'ebill_delivery', listFilter);
  if (!viewed.ok) return viewed;
  const filter = viewed.filter;

  const clauses: string[] = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (typeof filter.invoiceId === 'string' && filter.invoiceId.length > 0) {
    clauses.push('document_id = ?');
    params.push(filter.invoiceId);
  }
  if (typeof filter.status === 'string' && filter.status.length > 0) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (typeof filter.partnerStatus === 'string' && filter.partnerStatus.length > 0) {
    clauses.push('partner_status = ?');
    params.push(filter.partnerStatus);
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
    .prepare(`SELECT * FROM ebill_deliveries WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`)
    .all(...params) as EbillDeliveryRow[];
  return ok({ deliveries: rows.map(deliveryView) });
}

interface EbillEventRow {
  id: string;
  event_id: string;
  partner_status: string;
  partner_reason: string | null;
  approved_amount_minor: number | null;
  approved_amount_currency: string | null;
  occurred_at: string;
  recorded_at: string;
}

function readEvents(ctx: WorkspaceContext, deliveryId: string): Record<string, unknown>[] {
  const rows = ctx.store.db
    .prepare('SELECT * FROM ebill_delivery_events WHERE workspace_id = ? AND delivery_id = ? ORDER BY occurred_at ASC, rowid ASC')
    .all(ctx.workspaceId, deliveryId) as EbillEventRow[];
  return rows.map((r) => ({
    id: r.id,
    eventId: r.event_id,
    partnerStatus: r.partner_status,
    partnerReason: r.partner_reason,
    approvedAmountMinor: r.approved_amount_minor,
    approvedAmountCurrency: r.approved_amount_currency,
    occurredAt: r.occurred_at,
    recordedAt: r.recorded_at,
  }));
}

// --- the connector-facing mirror seam (NOT an MCP verb) ----------------------------------------

/**
 * The INTERNAL seam the cloud connector calls (through the §I contract) to mirror an SWP
 * status-changed event. NOT an MCP tool (spec §4): no human or agent sets a partner's status by hand,
 * so exposing it would be a lie surface. Flagged here so §5's "every action" audit does not read it as
 * an orphan. Each call APPENDS one `ebill_delivery_events` row (re-delivery of the same `eventId` is a
 * no-op, §H-IDEMPOTENT) and updates the delivery row's DENORMALIZED latest (`partner_status`,
 * `partner_reason`). The reported value is stored VERBATIM: an unknown value survives round-trip rather
 * than being coerced into the mirrored enum (spec §7).
 */
export function mirrorEbillPartnerStatus(
  ctx: WorkspaceContext,
  input: {
    deliveryId?: unknown;
    eventId?: unknown;
    occurredAt?: unknown;
    partnerStatus?: unknown;
    reason?: unknown;
    approvedAmount?: { minor?: unknown; currency?: unknown } | undefined;
  },
): Result {
  const delivery = readDelivery(ctx, input.deliveryId);
  if (delivery === undefined) return err('not_found', { deliveryId: input.deliveryId });
  if (typeof input.eventId !== 'string' || input.eventId.length === 0) {
    return err('invalid_input', { field: 'eventId' });
  }
  if (typeof input.partnerStatus !== 'string' || input.partnerStatus.length === 0) {
    return err('invalid_input', { field: 'partnerStatus' });
  }
  const eventId = input.eventId;
  const partnerStatus = input.partnerStatus; // stored VERBATIM, unknown values included
  const reason = typeof input.reason === 'string' ? input.reason : null;
  const occurredAt = typeof input.occurredAt === 'string' && input.occurredAt.length > 0 ? input.occurredAt : ctx.clock.now();
  const amtMinor = typeof input.approvedAmount?.minor === 'number' ? input.approvedAmount.minor : null;
  const amtCurrency = typeof input.approvedAmount?.currency === 'string' ? input.approvedAmount.currency : null;

  // Idempotent on (delivery, eventId): a re-polled event is a no-op.
  const dup = ctx.store.db
    .prepare('SELECT id FROM ebill_delivery_events WHERE delivery_id = ? AND event_id = ?')
    .get(delivery.id, eventId) as { id: string } | undefined;
  if (dup !== undefined) {
    return ok({ delivery: deliveryView(readDelivery(ctx, delivery.id) as EbillDeliveryRow), duplicate: true });
  }

  const id = ctx.ids.next('ebe');
  const at = ctx.clock.now();
  const run = (): Result => {
    ctx.store.db
      .prepare(
        `INSERT INTO ebill_delivery_events
           (id, workspace_id, delivery_id, event_id, partner_status, partner_reason,
            approved_amount_minor, approved_amount_currency, occurred_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ctx.workspaceId, delivery.id, eventId, partnerStatus, reason, amtMinor, amtCurrency, occurredAt, at);
    ctx.store.db
      .prepare('UPDATE ebill_deliveries SET partner_status = ?, partner_reason = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(partnerStatus, reason, at, ctx.workspaceId, delivery.id);
    return ok({ delivery: deliveryView(readDelivery(ctx, delivery.id) as EbillDeliveryRow) });
  };
  return ctx.store.tx(run);
}

/** Narrow a stored status string back to the enum for callers that need it (guard, never a cast). */
export function asEbillDeliveryStatus(v: unknown): EbillDeliveryStatus | null {
  return isEbillDeliveryStatus(v) ? v : null;
}
