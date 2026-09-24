/**
 * E01, e-signature: request, track and complete signatures on E00 stored files.
 *
 * WHAT THIS MODULE IS. The lifecycle record around the single most legally consequential document
 * event in a business: a `sign_request` row tracks one signer on one E00 file version through
 * `draft -> sent -> viewed -> signed | declined | expired`, and the signed artifact lands back in
 * E00 as a NEW VERSION of the same file (`newFileVersion`, `supersedes_id`, retention carried
 * forward per OR 958f). E01 never writes file bytes itself.
 *
 * WHAT THIS MODULE IS NOT. It never touches the journal: no `_rappen` column, no `postEntry`, no
 * `recordPayment` (asserted by `test/sign/no-money-path.test.mjs`; spec §4 "Money correctness": P3
 * is satisfied vacuously). And it never transmits by itself: the OSS core produces the local
 * artifact (the JSON envelope on the row) and STOPS (Pattern OP4). `send` hands over to an injected
 * `SignTransmitterPort` when the host wired one, and degrades honestly to `needs_provider` when it
 * did not, which is the MIT core's only behaviour: there is deliberately no transmitter in the core
 * (the `EmailRelayPort` argument in `context.ts`).
 *
 * THE STATE MACHINE IS DATA (`enums.ts`), and this module only ever asks `isLegalSignTransition`.
 * `signed|declined|expired` are terminal. The one extra edge into `signed` is `draft -> signed`,
 * the manual/wet-ink completion path (US-E01.4): with no provider, `send` refused and the request
 * never left `draft`, so the operator uploads the out-of-band-signed scan and completes directly.
 *
 * EXPIRY IS LAZY (spec US-E01.5): no background daemon in the OSS core. `get` and `list` persist
 * `expired` (`expired_reason='deadline'`) on first observation of an overdue row; the WRITE verbs
 * judge an overdue row by its EFFECTIVE status without writing, so a refused transition writes
 * ZERO rows (the C02/D03 tx-atomicity bug class: a write-then-return-`{ok:false}` would COMMIT).
 *
 * TENANCY (§H-TENANT): every query filters on `ctx.workspaceId`, so a foreign id answers the same
 * `not_found` a nonexistent one does and no id can be probed across tenants.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { newFileVersion } from '../files/files.js';
import { applySavedView } from '../customization/views.js';
import {
  isLegalSignTransition,
  isSignatureLevel,
  isSignRequestStatus,
  OPEN_SIGN_STATUSES,
  SIGN_REQUEST_STATUSES,
  SIGNATURE_LEVELS,
} from './enums.js';
import type { SignExpiredReason, SignRequestStatus } from './enums.js';

export interface SignRequestRow {
  id: string;
  workspace_id: string;
  file_id: string;
  signer_contact_id: string;
  signature_level: string;
  status: string;
  message: string | null;
  expires_at: string | null;
  sent_at: string | null;
  viewed_at: string | null;
  signed_at: string | null;
  declined_reason: string | null;
  expired_reason: string | null;
  provider_ref: string | null;
  document_sha256: string;
  local_artifact_json: string;
  signed_file_id: string | null;
  requested_by: string;
  created_at: string;
  updated_at: string;
}

/** The one wire shape every verb answers a sign request with, so eight verbs cannot drift (P5). */
export interface SignRequestView {
  id: string;
  fileId: string;
  signerContactId: string;
  signatureLevel: string;
  status: string;
  message: string | null;
  expiresAt: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  signedAt: string | null;
  declinedReason: string | null;
  expiredReason: string | null;
  providerRef: string | null;
  documentSha256: string;
  signedFileId: string | null;
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
  /** The OP4 local artifact: the provider-agnostic envelope the cloud tier would transmit. */
  localArtifact: SignArtifactEnvelope;
}

/**
 * The provider-agnostic OP4 envelope. `events` is the locally kept evidence trail: every recorded
 * status event appends here (with whatever evidence the connector delivered), so "who signed what,
 * when, at which level" is answerable offline from the row alone.
 */
export interface SignArtifactEnvelope {
  documentSha256: string;
  fileId: string;
  signer: { contactId: string; name: string | null; email: string };
  signatureLevel: string;
  message: string | null;
  expiresAt: string | null;
  workspaceId: string;
  requestedBy: string;
  requestedAt: string;
  events: { status: string; at: string; actor: string; reason?: string; evidence?: unknown }[];
}

function parseEnvelope(raw: string): SignArtifactEnvelope {
  // The only writer is this module and it always writes the full shape; the defensive fallback
  // exists because a hand-edited database is a thing that happens to local-first software.
  try {
    return JSON.parse(raw) as SignArtifactEnvelope;
  } catch {
    return {
      documentSha256: '',
      fileId: '',
      signer: { contactId: '', name: null, email: '' },
      signatureLevel: '',
      message: null,
      expiresAt: null,
      workspaceId: '',
      requestedBy: '',
      requestedAt: '',
      events: [],
    };
  }
}

export function mapSignRequest(row: SignRequestRow): SignRequestView {
  return {
    id: row.id,
    fileId: row.file_id,
    signerContactId: row.signer_contact_id,
    signatureLevel: row.signature_level,
    status: row.status,
    message: row.message,
    expiresAt: row.expires_at,
    sentAt: row.sent_at,
    viewedAt: row.viewed_at,
    signedAt: row.signed_at,
    declinedReason: row.declined_reason,
    expiredReason: row.expired_reason,
    providerRef: row.provider_ref,
    documentSha256: row.document_sha256,
    signedFileId: row.signed_file_id,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    localArtifact: parseEnvelope(row.local_artifact_json),
  };
}

export function readSignRequest(ctx: WorkspaceContext, id: unknown): SignRequestRow | undefined {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM sign_request WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as SignRequestRow | undefined;
}

/** A sortable ISO day or instant: `YYYY-MM-DD` prefix and parseable. Refused, never coerced. */
function isValidInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return false;
  const parsed = value.length === 10 ? Date.parse(`${value}T00:00:00Z`) : Date.parse(value);
  return !Number.isNaN(parsed);
}

/** Epoch ms of an ISO day (midnight UTC) or instant. Callers have validated with `isValidInstant`. */
function msOf(value: string): number {
  return value.length === 10 ? Date.parse(`${value}T00:00:00Z`) : Date.parse(value);
}

/** Is this open row past its deadline at `nowMs`? */
function isOverdue(row: SignRequestRow, nowMs: number): boolean {
  return (
    (OPEN_SIGN_STATUSES as readonly string[]).includes(row.status) &&
    row.expires_at !== null &&
    msOf(row.expires_at) <= nowMs
  );
}

/**
 * The status a WRITE verb judges a row by: an overdue open row is `expired` even before the lazy
 * sweep has persisted it. Deliberately a pure read: a refused transition must write ZERO rows, so
 * the persisting half of lazy expiry lives only in `get`/`list` (spec US-E01.5).
 */
function effectiveStatus(ctx: WorkspaceContext, row: SignRequestRow): SignRequestStatus {
  const nowMs = Date.parse(ctx.clock.now());
  if (isOverdue(row, nowMs)) return 'expired';
  return row.status as SignRequestStatus;
}

/** Persist `expired` on every overdue open row (the lazy sweep behind `get` and `list`). */
function sweepOverdue(ctx: WorkspaceContext, id?: string): void {
  const now = ctx.clock.now();
  const nowMs = Date.parse(now);
  const clauses = [`workspace_id = ?`, `status IN ('draft', 'sent', 'viewed')`, `expires_at IS NOT NULL`];
  const params: string[] = [ctx.workspaceId];
  if (id !== undefined) {
    clauses.push('id = ?');
    params.push(id);
  }
  const overdue = ctx.store.db
    .prepare(`SELECT id, expires_at FROM sign_request WHERE ${clauses.join(' AND ')}`)
    .all(...params) as { id: string; expires_at: string }[];
  const due = overdue.filter((r) => msOf(r.expires_at) <= nowMs);
  if (due.length === 0) return;
  ctx.store.tx(() => {
    const update = ctx.store.db.prepare(
      `UPDATE sign_request SET status = 'expired', expired_reason = 'deadline', updated_at = ?
        WHERE workspace_id = ? AND id = ?`,
    );
    for (const r of due) {
      update.run(now, ctx.workspaceId, r.id);
      ctx.audit.record({ entityKind: 'sign_request', entityId: r.id, action: 'expire', actor: ctx.actor, at: now });
    }
  });
}

/** Append one event to the row's envelope trail. Runs inside the caller's transaction. */
function appendEnvelopeEvent(
  ctx: WorkspaceContext,
  row: SignRequestRow,
  event: { status: string; at: string; reason?: string; evidence?: unknown },
): string {
  const envelope = parseEnvelope(row.local_artifact_json);
  const entry: SignArtifactEnvelope['events'][number] = { status: event.status, at: event.at, actor: ctx.actor };
  if (event.reason !== undefined) entry.reason = event.reason;
  if (event.evidence !== undefined) entry.evidence = event.evidence;
  envelope.events.push(entry);
  return JSON.stringify(envelope);
}

// --- Create --------------------------------------------------------------------------------------

export interface CreateSignRequestInput {
  fileId: string;
  signerContactId: string;
  signatureLevel: string;
  message?: string;
  expiresAt?: string;
  idempotencyKey?: string;
}

export function createSignRequest(ctx: WorkspaceContext, input: CreateSignRequestInput): Result {
  // Replay FIRST (the `completeTask` pattern): a retried creation must answer the original draft
  // rather than trip the open-request guard on the row it itself minted (§H-IDEMPOTENT, US-E01.3
  // Boundary: a retried workflow never mints duplicate requests, and never sees a refusal either).
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const prior = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'sign_requests_create');
    if (prior !== undefined) return prior;
  }

  if (typeof input.fileId !== 'string' || input.fileId.length === 0) {
    return err('invalid_input', { field: 'fileId' });
  }
  if (typeof input.signerContactId !== 'string' || input.signerContactId.length === 0) {
    return err('invalid_input', { field: 'signerContactId' });
  }
  if (!isSignatureLevel(input.signatureLevel)) {
    return err('invalid_input', { field: 'signatureLevel', allowed: [...SIGNATURE_LEVELS] });
  }
  if (input.message !== undefined && typeof input.message !== 'string') {
    return err('invalid_input', { field: 'message' });
  }

  // The E00 target, workspace-scoped (§H-TENANT), and HEAD-ONLY: a request anchors the bytes the
  // signer will actually see, so a superseded version is refused with E00's own word for it rather
  // than silently anchoring stale content.
  const file = ctx.store.db
    .prepare('SELECT id, sha256, version FROM stored_file WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.fileId) as { id: string; sha256: string; version: number } | undefined;
  if (file === undefined) return err('file_not_found', { fileId: input.fileId });
  const successor = ctx.store.db
    .prepare('SELECT id FROM stored_file WHERE workspace_id = ? AND supersedes_id = ?')
    .get(ctx.workspaceId, file.id) as { id: string } | undefined;
  if (successor !== undefined) {
    return err('not_head_version', { fileId: file.id, version: file.version });
  }

  const signer = ctx.store.db
    .prepare('SELECT id, name, email FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.signerContactId) as { id: string; name: string | null; email: string | null } | undefined;
  if (signer === undefined) return err('contact_not_found', { contactId: input.signerContactId });
  if (signer.email === null || signer.email.length === 0) {
    return err('signer_email_missing', { contactId: signer.id });
  }

  const now = ctx.clock.now();
  if (input.expiresAt !== undefined) {
    if (typeof input.expiresAt !== 'string' || !isValidInstant(input.expiresAt)) {
      return err('invalid_input', { field: 'expiresAt' });
    }
    if (msOf(input.expiresAt) <= Date.parse(now)) {
      return err('expiry_in_past', { expiresAt: input.expiresAt, now });
    }
  }

  // The open-request guard (US-E01.1 Boundary): one signer, one file version, one open request.
  // Keyed on (file_id, signer) over the OPEN statuses; a terminal request never blocks a re-issue,
  // and a superseded version's requests key on the OLD file id, so a fresh head is never blocked.
  const open = ctx.store.db
    .prepare(
      `SELECT id, status, expires_at FROM sign_request
        WHERE workspace_id = ? AND file_id = ? AND signer_contact_id = ?
          AND status IN ('draft', 'sent', 'viewed')`,
    )
    .all(ctx.workspaceId, file.id, signer.id) as SignRequestRow[];
  const nowMs = Date.parse(now);
  const stillOpen = open.find((r) => !isOverdue(r, nowMs));
  if (stillOpen !== undefined) {
    return err('request_already_open', { signRequestId: stillOpen.id, status: stillOpen.status });
  }

  const run = (): Result => {
    const id = ctx.ids.next('sigreq');
    const envelope: SignArtifactEnvelope = {
      documentSha256: file.sha256,
      fileId: file.id,
      signer: { contactId: signer.id, name: signer.name, email: signer.email as string },
      signatureLevel: input.signatureLevel,
      message: input.message ?? null,
      expiresAt: input.expiresAt ?? null,
      workspaceId: ctx.workspaceId,
      requestedBy: ctx.actor,
      requestedAt: now,
      events: [{ status: 'draft', at: now, actor: ctx.actor }],
    };
    ctx.store.db
      .prepare(
        `INSERT INTO sign_request (
           id, workspace_id, file_id, signer_contact_id, signature_level, status, message,
           expires_at, sent_at, viewed_at, signed_at, declined_reason, expired_reason, provider_ref,
           document_sha256, local_artifact_json, signed_file_id, requested_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        file.id,
        signer.id,
        input.signatureLevel,
        input.message ?? null,
        input.expiresAt ?? null,
        file.sha256,
        JSON.stringify(envelope),
        ctx.actor,
        now,
        now,
      );
    ctx.audit.record({ entityKind: 'sign_request', entityId: id, action: 'create', actor: ctx.actor, at: now });
    return ok({ signRequestId: id, signRequest: mapSignRequest(readSignRequest(ctx, id) as SignRequestRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'sign_requests_create', run);
  }
  return ctx.store.tx(run);
}

// --- Send (OP4: the ONE outbound verb) -----------------------------------------------------------

export function sendSignRequest(
  ctx: WorkspaceContext,
  input: { signRequestId: string; confirmed?: boolean; idempotencyKey?: string },
): Result {
  // Replay FIRST (the `sendInvoice` pattern): a retried committed send answers the original result
  // rather than `invalid_transition` on the row it itself transitioned.
  const scopedKey =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0
      ? JSON.stringify([input.signRequestId, input.idempotencyKey])
      : undefined;
  if (scopedKey !== undefined) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'sign_requests_send');
    if (replayed !== undefined) return replayed;
  }

  const row = readSignRequest(ctx, input.signRequestId);
  if (row === undefined) return err('not_found', { signRequestId: input.signRequestId });
  const from = effectiveStatus(ctx, row);
  if (!isLegalSignTransition(from, 'sent')) {
    return err('invalid_transition', { signRequestId: row.id, from, to: 'sent', transmitted: false });
  }

  // P8 (spec §4, the `send_invoice` shape): sending is outbound and confirm-by-default, for human
  // and agent callers identically. The gate sits on `send`, never on `create`, which is exactly why
  // an agent may draft freely (US-E01.3).
  if (input.confirmed !== true) {
    return err('needs_confirmation', {
      signRequestId: row.id,
      transmitted: false,
      reason: 'outbound_send_requires_confirmation',
      confirmWith: { signRequestId: row.id, confirmed: true },
    });
  }

  // OP4: the transmitter is an injected seam and the MIT core ships NONE. The refusal carries the
  // local artifact, which is the honest degradation (P9): everything the provider would need exists
  // locally, nothing has left the device, and the request stays `draft` for the manual path.
  const transmitter = ctx.signTransmitter;
  if (transmitter === undefined) {
    return err('needs_provider', {
      signRequestId: row.id,
      transmitted: false,
      reason: 'cloud_tier',
      artifact: parseEnvelope(row.local_artifact_json),
    });
  }

  // M-2 ordering: every guard has run; the transmission is the one irreversible act and it happens
  // OUTSIDE any transaction (an outbound effect cannot live inside something that can roll back).
  const handed = transmitter.transmit(parseEnvelope(row.local_artifact_json));
  if (!handed.ok) {
    return err('provider_send_failed', { signRequestId: row.id, transmitted: false, reason: handed.reason });
  }

  const run = (): Result => {
    const now = ctx.clock.now();
    const artifactJson = appendEnvelopeEvent(ctx, row, { status: 'sent', at: now });
    ctx.store.db
      .prepare(
        `UPDATE sign_request
            SET status = 'sent', sent_at = ?, provider_ref = ?, local_artifact_json = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .run(now, handed.providerRef, artifactJson, now, ctx.workspaceId, row.id);
    ctx.audit.record({ entityKind: 'sign_request', entityId: row.id, action: 'send', actor: ctx.actor, at: now });
    return ok({
      signRequestId: row.id,
      signRequest: mapSignRequest(readSignRequest(ctx, row.id) as SignRequestRow),
      transmitted: true,
      providerRef: handed.providerRef,
    });
  };

  if (scopedKey !== undefined) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'sign_requests_send', run);
  }
  return ctx.store.tx(run);
}

// --- Record a provider (or manual) status event --------------------------------------------------

export function recordSignRequestEvent(
  ctx: WorkspaceContext,
  input: {
    signRequestId: string;
    status: string;
    declinedReason?: string;
    evidence?: unknown;
    idempotencyKey?: string;
  },
): Result {
  const scopedKey =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0
      ? JSON.stringify([input.signRequestId, input.idempotencyKey])
      : undefined;
  if (scopedKey !== undefined) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'sign_requests_record_event');
    if (replayed !== undefined) return replayed;
  }

  if (!isSignRequestStatus(input.status) || !['viewed', 'declined', 'expired'].includes(input.status)) {
    return err('invalid_input', { field: 'status', allowed: ['viewed', 'declined', 'expired'] });
  }
  if (input.declinedReason !== undefined && typeof input.declinedReason !== 'string') {
    return err('invalid_input', { field: 'declinedReason' });
  }
  const row = readSignRequest(ctx, input.signRequestId);
  if (row === undefined) return err('not_found', { signRequestId: input.signRequestId });
  const from = effectiveStatus(ctx, row);
  const to = input.status as SignRequestStatus;

  // Recording `viewed` on a row already `viewed` is a NO-OP, not a refusal (US-E01.4 Boundary):
  // status is monotonic within the machine and the same provider event may be delivered twice.
  if (to === 'viewed' && from === 'viewed') {
    return ok({ signRequestId: row.id, signRequest: mapSignRequest(row), changed: false });
  }
  if (!isLegalSignTransition(from, to)) {
    return err('invalid_transition', { signRequestId: row.id, from, to });
  }

  const run = (): Result => {
    const now = ctx.clock.now();
    const event: { status: string; at: string; reason?: string; evidence?: unknown } = { status: to, at: now };
    if (input.declinedReason !== undefined) event.reason = input.declinedReason;
    if (input.evidence !== undefined) event.evidence = input.evidence;
    const artifactJson = appendEnvelopeEvent(ctx, row, event);
    const sets = [`status = ?`, `local_artifact_json = ?`, `updated_at = ?`];
    const params: (string | null)[] = [to, artifactJson, now];
    if (to === 'viewed') {
      sets.push('viewed_at = ?');
      params.push(now);
    }
    if (to === 'declined') {
      sets.push('declined_reason = ?');
      params.push(input.declinedReason ?? null);
    }
    if (to === 'expired') {
      sets.push('expired_reason = ?');
      params.push('deadline' satisfies SignExpiredReason);
    }
    ctx.store.db
      .prepare(`UPDATE sign_request SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`)
      .run(...params, ctx.workspaceId, row.id);
    const action = to === 'viewed' ? 'view' : to === 'declined' ? 'decline' : 'expire';
    ctx.audit.record({ entityKind: 'sign_request', entityId: row.id, action, actor: ctx.actor, at: now });
    // The OUTCOME-SPECIFIC id field: the G01 event registry keys the three sign_request.* provider
    // events on disjoint result paths (`events.ts`), so only the moment that actually happened has
    // a resolvable entity id and the other two rows are skipped by the dispatch.
    const outcomeField =
      to === 'viewed' ? 'viewedSignRequestId' : to === 'declined' ? 'declinedSignRequestId' : 'expiredSignRequestId';
    return ok({
      signRequestId: row.id,
      signRequest: mapSignRequest(readSignRequest(ctx, row.id) as SignRequestRow),
      changed: true,
      [outcomeField]: row.id,
    });
  };

  if (scopedKey !== undefined) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'sign_requests_record_event', run);
  }
  return ctx.store.tx(run);
}

// --- Complete: the signed artifact lands back in E00 ---------------------------------------------

/**
 * Control-flow abort for a delegation refusal INSIDE the completion transaction (the `SendAbort`
 * shape from `sendInvoice`). Returning the refusal from inside `rememberIdempotent` would COMMIT it
 * as the key's remembered answer, and a retry with corrected content would then replay the stale
 * refusal forever. Throwing rolls the unit back and memoizes nothing, so the retry really retries.
 */
class CompleteAbort extends Error {
  constructor(readonly result: Result) {
    super('sign_request_complete_abort');
  }
}

export function completeSignRequest(
  ctx: WorkspaceContext,
  input: {
    signRequestId: string;
    signedContentBase64: string;
    originalSha256: string;
    mime?: string;
    idempotencyKey?: string;
  },
): Result {
  const scopedKey =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0
      ? JSON.stringify([input.signRequestId, input.idempotencyKey])
      : undefined;
  if (scopedKey !== undefined) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'sign_requests_complete');
    if (replayed !== undefined) return replayed;
  }

  const row = readSignRequest(ctx, input.signRequestId);
  if (row === undefined) return err('not_found', { signRequestId: input.signRequestId });
  const from = effectiveStatus(ctx, row);
  if (!isLegalSignTransition(from, 'signed')) {
    return err('invalid_transition', { signRequestId: row.id, from, to: 'signed' });
  }

  // THE INTEGRITY GUARD (spec §6b, fixed): the completion evidence must reference the exact file
  // version the signer was asked to sign. A swapped or re-uploaded original is refused, never
  // silently accepted, because this anchor is the evidentiary chain of custody.
  if (typeof input.originalSha256 !== 'string' || input.originalSha256 !== row.document_sha256) {
    return err('document_hash_mismatch', {
      signRequestId: row.id,
      expected: row.document_sha256,
    });
  }

  const run = (): Result => {
    // THE E00 DELEGATION: `newFileVersion` owns decode, size cap, the head-only guard, the version
    // chain and retention carry-forward. E01 writes no file bytes. Its refusals (`file_unreadable`,
    // `file_too_large`, `not_head_version`) write nothing, so returning them from inside this
    // transaction commits nothing (the delegation validates before it writes).
    const version = newFileVersion(ctx, {
      fileId: row.file_id,
      contentBase64: input.signedContentBase64,
      ...(input.mime !== undefined ? { mime: input.mime } : {}),
    });
    if (!version.ok) throw new CompleteAbort(version);
    const signedFileId = (version as unknown as { file: { id: string } }).file.id;

    const now = ctx.clock.now();
    const artifactJson = appendEnvelopeEvent(ctx, row, { status: 'signed', at: now });
    ctx.store.db
      .prepare(
        `UPDATE sign_request
            SET status = 'signed', signed_at = ?, signed_file_id = ?, local_artifact_json = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .run(now, signedFileId, artifactJson, now, ctx.workspaceId, row.id);
    ctx.audit.record({ entityKind: 'sign_request', entityId: row.id, action: 'sign', actor: ctx.actor, at: now });
    return ok({
      signRequestId: row.id,
      signRequest: mapSignRequest(readSignRequest(ctx, row.id) as SignRequestRow),
      signedFileId,
    });
  };

  try {
    if (scopedKey !== undefined) {
      return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'sign_requests_complete', run);
    }
    return ctx.store.tx(run);
  } catch (e) {
    if (e instanceof CompleteAbort) return e.result;
    throw e;
  }
}

// --- Withdraw ------------------------------------------------------------------------------------

/**
 * Senden zurückziehen (US-E01.5): `sent|viewed -> expired` with `expired_reason='withdrawn'`. No
 * seventh enum value is minted (§H-ENUM stays six states); the reason column tells a withdrawn
 * request from a deadline expiry. A `draft` is not withdrawn, it is deleted (`deleteDraft`).
 */
export function withdrawSignRequest(
  ctx: WorkspaceContext,
  input: { signRequestId: string; idempotencyKey?: string },
): Result {
  const scopedKey =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0
      ? JSON.stringify([input.signRequestId, input.idempotencyKey])
      : undefined;
  if (scopedKey !== undefined) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'sign_requests_withdraw');
    if (replayed !== undefined) return replayed;
  }

  const row = readSignRequest(ctx, input.signRequestId);
  if (row === undefined) return err('not_found', { signRequestId: input.signRequestId });
  const from = effectiveStatus(ctx, row);
  // `draft -> expired` is not an edge of the machine, so the matrix itself refuses a draft
  // withdrawal; the spec's own answer for a dead draft is `delete_draft` (US-E01.5 Error).
  if (from === 'draft' || !isLegalSignTransition(from, 'expired')) {
    return err('invalid_transition', { signRequestId: row.id, from, to: 'expired' });
  }

  const run = (): Result => {
    const now = ctx.clock.now();
    const artifactJson = appendEnvelopeEvent(ctx, row, { status: 'expired', at: now, reason: 'withdrawn' });
    ctx.store.db
      .prepare(
        `UPDATE sign_request
            SET status = 'expired', expired_reason = 'withdrawn', local_artifact_json = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .run(artifactJson, now, ctx.workspaceId, row.id);
    ctx.audit.record({ entityKind: 'sign_request', entityId: row.id, action: 'withdraw', actor: ctx.actor, at: now });
    return ok({ signRequestId: row.id, signRequest: mapSignRequest(readSignRequest(ctx, row.id) as SignRequestRow) });
  };

  if (scopedKey !== undefined) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'sign_requests_withdraw', run);
  }
  return ctx.store.tx(run);
}

// --- Delete a draft ------------------------------------------------------------------------------

/** Verwerfen (US-E01.5): a draft never went anywhere, so it is deleted, not tombstoned. */
export function deleteDraftSignRequest(
  ctx: WorkspaceContext,
  input: { signRequestId: string; idempotencyKey?: string },
): Result {
  const scopedKey =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0
      ? JSON.stringify([input.signRequestId, input.idempotencyKey])
      : undefined;
  if (scopedKey !== undefined) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'sign_requests_delete_draft');
    if (replayed !== undefined) return replayed;
  }

  const row = readSignRequest(ctx, input.signRequestId);
  if (row === undefined) return err('not_found', { signRequestId: input.signRequestId });
  const from = effectiveStatus(ctx, row);
  if (from !== 'draft') {
    return err('invalid_transition', { signRequestId: row.id, from, to: 'deleted' });
  }

  const run = (): Result => {
    const now = ctx.clock.now();
    ctx.store.db
      .prepare('DELETE FROM sign_request WHERE workspace_id = ? AND id = ?')
      .run(ctx.workspaceId, row.id);
    ctx.audit.record({ entityKind: 'sign_request', entityId: row.id, action: 'delete', actor: ctx.actor, at: now });
    return ok({ signRequestId: row.id, deleted: true });
  };

  if (scopedKey !== undefined) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'sign_requests_delete_draft', run);
  }
  return ctx.store.tx(run);
}

// --- Reads ---------------------------------------------------------------------------------------

export function getSignRequest(ctx: WorkspaceContext, input: { signRequestId: string }): Result {
  const before = readSignRequest(ctx, input.signRequestId);
  if (before === undefined) return err('not_found', { signRequestId: input.signRequestId });
  // The lazy sweep persists on first observation (US-E01.5): reading an overdue request is the
  // moment its expiry becomes a stored fact rather than a derivable one.
  sweepOverdue(ctx, before.id);
  return ok({ signRequest: mapSignRequest(readSignRequest(ctx, input.signRequestId) as SignRequestRow) });
}

export interface ListSignRequestsFilter {
  fileId?: string;
  status?: string;
  signerContactId?: string;
  savedViewId?: string;
}

/**
 * The tracking read model (P5): the drawer's per-file list, the "Offene Signaturen" filter, and the
 * G00 saved-view seam (one unconditional `applySavedView` call, the `listTasks` shape: the view's
 * stored filters merge UNDER the caller's explicit ones).
 */
export function listSignRequests(ctx: WorkspaceContext, filter: ListSignRequestsFilter = {}): Result {
  const viewed = applySavedView(ctx, 'sign_request', filter);
  if (!viewed.ok) return viewed;
  filter = viewed.filter;

  if (filter.status !== undefined && !isSignRequestStatus(filter.status)) {
    return err('invalid_input', { field: 'status', allowed: [...SIGN_REQUEST_STATUSES] });
  }

  sweepOverdue(ctx);

  const clauses = ['workspace_id = ?'];
  const params: string[] = [ctx.workspaceId];
  if (filter.fileId !== undefined) {
    clauses.push('file_id = ?');
    params.push(filter.fileId);
  }
  if (filter.status !== undefined) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.signerContactId !== undefined) {
    clauses.push('signer_contact_id = ?');
    params.push(filter.signerContactId);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM sign_request WHERE ${clauses.join(' AND ')} ORDER BY created_at, id`)
    .all(...params) as SignRequestRow[];
  return ok({ signRequests: rows.map(mapSignRequest), total: rows.length });
}
