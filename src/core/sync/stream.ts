/**
 * M02: the READ half of the contract, and the payload projection. Every function here is a PURE
 * read: it issues SELECTs and NEVER writes, which is what lets `sync_stream_read` and its siblings sit
 * under the conformance "no read verb mutates the database" rule. The publish stream is fed by the
 * transactional-outbox trigger and the enable-time backfill (`outbox.ts`); this file only reads it and
 * renders the fact bodies.
 *
 * WHY THE PAYLOAD IS PROJECTED, NOT STORED. `sync_outbox` holds the envelope and a STABLE REFERENCE to
 * the fact (`source_ref`), not a rendered body. A `journal.posted` event's payload is built HERE by
 * reading the posted `journal_entry` and its lines, which the §H-AUDIT immutability triggers guarantee
 * can never change once posted. So the rendered payload can never drift from what the books hold, and
 * "lossless reconstruct" is a property of reading immutable rows, not of trusting a copy: a consumer
 * that folds every `journal.posted` payload rebuilds the trial balance to the Rappen (proven by
 * `reconstruct.ts` + the golden fixture).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { baseCurrencyOf } from '../fx/rates.js';
import {
  CONTRACT_VERSION,
  SUPPORTED_CONTRACT_VERSIONS,
  STREAM_KINDS,
  SYNC_ERRORS,
  isFactKind,
} from './contract.js';
import type { StreamEnvelope, StreamKind } from './contract.js';
import { readPublishState, headSeqOf } from './outbox.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

export interface StreamCursor {
  seq?: number;
  epoch?: string;
}

export interface ReadStreamInput {
  // The tenant is on the ctx (§H-TENANT), not the input (the `PostEntryInput` convention).
  cursor?: StreamCursor;
  limit?: number;
  /** The contract major the consumer speaks. An unknown major is refused, never best-effort parsed. */
  contractVersion?: string;
}

/** Refuse a contract major this build does not speak (Refuse-dont-guess, D41's posture on the wire). */
function contractGuard(contractVersion: string | undefined): Result | null {
  if (contractVersion === undefined) return null;
  if (!SUPPORTED_CONTRACT_VERSIONS.includes(contractVersion)) {
    return err(SYNC_ERRORS.UNSUPPORTED_CONTRACT, {
      requested: contractVersion,
      supported: SUPPORTED_CONTRACT_VERSIONS,
    });
  }
  return null;
}

interface OutboxRow {
  seq: number;
  epoch: string;
  occurred_at: string;
  actor: string;
  kind: string;
  source_ref: string;
  payload_schema: string;
  artifact_sha256: string | null;
}

/**
 * Build a `journal.posted` payload from the IMMUTABLE posted entry and its lines. Amounts are integer
 * Rappen; the §H-FX triple (transaction amount + base amount + rate) rides every line verbatim, so a
 * consumer never re-derives a rate. Facts only: this is what HAPPENED, never an instruction.
 */
function renderJournalPayload(ctx: WorkspaceContext, entryId: string): Record<string, unknown> {
  const entry = ctx.store.db
    .prepare(
      `SELECT id, date, ref, description, source, reverses_entry_id, created_by, created_at
         FROM journal_entry WHERE workspace_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, entryId) as
    | {
        id: string;
        date: string;
        ref: string | null;
        description: string | null;
        source: string;
        reverses_entry_id: string | null;
        created_by: string | null;
        created_at: string;
      }
    | undefined;
  // A source_ref always points at a posted entry that exists (the outbox row was written at its post,
  // and posted entries are immutable and never deleted). The guard is defensive, not expected.
  if (entry === undefined) return { entryId, missing: true };

  const lines = ctx.store.db
    .prepare(
      `SELECT jl.account_id AS account_id, a.number AS account_number, jl.cost_center_id AS cost_center_id,
              jl.debit_minor AS debit_minor, jl.credit_minor AS credit_minor, jl.currency AS currency,
              jl.base_debit_minor AS base_debit_minor, jl.base_credit_minor AS base_credit_minor,
              jl.fx_rate AS fx_rate, jl.tax_code AS tax_code, jl.tax_base_minor AS tax_base_minor,
              jl.tax_amount_minor AS tax_amount_minor, jl.supply_date AS supply_date
         FROM journal_line jl
         JOIN account a ON a.id = jl.account_id
        WHERE jl.entry_id = ?
        ORDER BY jl.id`,
    )
    .all(entryId) as {
    account_id: string;
    account_number: string;
    cost_center_id: string | null;
    debit_minor: number;
    credit_minor: number;
    currency: string;
    base_debit_minor: number;
    base_credit_minor: number;
    fx_rate: string | null;
    tax_code: string | null;
    tax_base_minor: number | null;
    tax_amount_minor: number | null;
    supply_date: string | null;
  }[];

  return {
    entryId: entry.id,
    date: entry.date,
    ref: entry.ref,
    description: entry.description,
    source: entry.source,
    reversesEntryId: entry.reverses_entry_id,
    baseCurrency: baseCurrencyOf(ctx),
    postedAt: entry.created_at,
    actor: entry.created_by ?? 'system',
    lines: lines.map((l) => ({
      account: l.account_id,
      accountNumber: l.account_number,
      costCenter: l.cost_center_id,
      debitMinor: l.debit_minor,
      creditMinor: l.credit_minor,
      currency: l.currency,
      baseDebitMinor: l.base_debit_minor,
      baseCreditMinor: l.base_credit_minor,
      fxRate: l.fx_rate,
      taxCode: l.tax_code,
      taxBaseMinor: l.tax_base_minor,
      taxAmountMinor: l.tax_amount_minor,
      supplyDate: l.supply_date,
    })),
  };
}

/** Project an outbox row into a full wire envelope, rendering its payload from the immutable source. */
function renderEnvelope(ctx: WorkspaceContext, row: OutboxRow): StreamEnvelope {
  const kind = row.kind as StreamKind;
  const payload =
    kind === STREAM_KINDS.JOURNAL_POSTED ? renderJournalPayload(ctx, row.source_ref) : { ref: row.source_ref };
  return {
    contractVersion: CONTRACT_VERSION,
    workspaceId: ctx.workspaceId,
    seq: row.seq,
    epoch: row.epoch,
    occurredAt: row.occurred_at,
    actor: row.actor,
    kind,
    payloadSchema: row.payload_schema,
    ...(row.artifact_sha256 !== null ? { artifactSha256: row.artifact_sha256 } : {}),
    payload,
  };
}

/**
 * `get_sync_contract`: describe the contract to a consumer. Reports the majors this build speaks, this
 * workspace's publish posture, its stream head and epoch, and the sole-writer / file-per-tenant facts
 * §I promises. An optional `contractVersion` lets a consumer negotiate: an unknown major is refused.
 */
export function getSyncContract(ctx: WorkspaceContext, input: ReadStreamInput): Result {
  const bad = contractGuard(input.contractVersion);
  if (bad) return bad;
  const state = readPublishState(ctx);
  const publishing = state?.publishing === 1;
  return ok({
    versions: SUPPORTED_CONTRACT_VERSIONS,
    contractVersion: CONTRACT_VERSION,
    publishing,
    epoch: state?.epoch ?? null,
    headSeq: publishing ? headSeqOf(ctx) : 0,
    // The §I posture, stated so it is testable rather than merely promised: the MIT core is the sole
    // writer, and the managed tier runs one process against one file per tenant. No consumer of this
    // contract can write the ledger; the inbound lane is existing verbs, gated by A24.
    soleWriter: true,
    oneFilePerTenant: true,
  });
}

/**
 * `sync_stream_read`: the paged, cursor-driven read. At-least-once by design: the stream is append-only
 * and immutable, so a re-read from the same cursor is always safe. The consumer OWNS its cursor (the
 * core persists none, which is what keeps this a pure read); it presents `{seq, epoch}` and receives
 * every event after `seq`, up to `limit`, plus the current `headSeq` so it knows its lag.
 */
export function readSyncStream(ctx: WorkspaceContext, input: ReadStreamInput): Result {
  const bad = contractGuard(input.contractVersion);
  if (bad) return bad;

  const state = readPublishState(ctx);
  if (state === undefined || state.publishing !== 1 || state.epoch === null) {
    // Disable revokes stream visibility (US-M02.2/.5): the raw feed is refused, not merely empty.
    return err(SYNC_ERRORS.PUBLISHING_DISABLED, { workspaceId: ctx.workspaceId });
  }

  const cursor = input.cursor ?? {};
  const fromSeq = cursor.seq ?? 0;
  if (typeof fromSeq !== 'number' || !Number.isInteger(fromSeq) || fromSeq < 0) {
    return err('invalid_input', { field: 'cursor.seq' });
  }
  // A cursor from a superseded epoch is reading a forked history (a G04 restore re-minted the stream):
  // refuse with the new epoch rather than replay mismatched seqs against different facts.
  if (cursor.epoch !== undefined && cursor.epoch !== state.epoch) {
    return err(SYNC_ERRORS.CURSOR_RESET_REQUIRED, { epoch: state.epoch, presented: cursor.epoch });
  }

  const head = headSeqOf(ctx);
  if (fromSeq > head) {
    return err(SYNC_ERRORS.INVALID_CURSOR, { cursor: fromSeq, headSeq: head });
  }

  const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const rows = ctx.store.db
    .prepare(
      `SELECT seq, epoch, occurred_at, actor, kind, source_ref, payload_schema, artifact_sha256
         FROM sync_outbox
        WHERE workspace_id = ? AND seq > ?
        ORDER BY seq
        LIMIT ?`,
    )
    .all(ctx.workspaceId, fromSeq, limit) as OutboxRow[];

  const events = rows.map((r) => renderEnvelope(ctx, r));
  const lastSeq = events.length > 0 ? (events[events.length - 1] as StreamEnvelope).seq : fromSeq;
  return ok({
    contractVersion: CONTRACT_VERSION,
    epoch: state.epoch,
    headSeq: head,
    cursor: { seq: lastSeq, epoch: state.epoch },
    hasMore: lastSeq < head,
    events,
  });
}

/**
 * `sync_stream_status`: the monitoring read. Head, epoch, publish posture, and (when the consumer
 * presents its cursor) the lag = head - cursor.seq. No tenant rows, only stream metadata: the ops
 * surface D42's zero-egress posture extends to (a tier watches lag, never content).
 */
export function syncStreamStatus(ctx: WorkspaceContext, input: ReadStreamInput): Result {
  const state = readPublishState(ctx);
  const publishing = state?.publishing === 1 && state?.epoch !== null;
  const head = publishing ? headSeqOf(ctx) : 0;
  const cursorSeq = input.cursor?.seq;
  const lag = typeof cursorSeq === 'number' && Number.isInteger(cursorSeq) ? Math.max(0, head - cursorSeq) : null;
  return ok({
    publishing,
    contractVersion: CONTRACT_VERSION,
    epoch: state?.epoch ?? null,
    headSeq: head,
    lag,
  });
}

export interface ReadArtifactInput {
  // The tenant is on the ctx (§H-TENANT), not the input.
  sha256: string;
}

/**
 * `sync_artifact_read`: fetch an `artifact.*` blob by its content hash. The `artifact.*` family is a
 * DEFINED namespace whose producers ride E00's content-addressed store; this build produces no
 * artifact events, so any hash resolves to a structured `artifact_not_found`. It is a real, gated,
 * PURE read: it looks the hash up in this workspace's published artifact handles (§H-TENANT) and never
 * inlines blob bytes into the stream. A hash that is not a published handle is refused, never guessed.
 */
export function readSyncArtifact(ctx: WorkspaceContext, input: ReadArtifactInput): Result {
  const state = readPublishState(ctx);
  if (state === undefined || state.publishing !== 1) {
    return err(SYNC_ERRORS.PUBLISHING_DISABLED, { workspaceId: ctx.workspaceId });
  }
  if (typeof input.sha256 !== 'string' || input.sha256.length === 0) {
    return err('invalid_input', { field: 'sha256' });
  }
  const handle = ctx.store.db
    .prepare(
      `SELECT source_ref, payload_schema, kind FROM sync_outbox
        WHERE workspace_id = ? AND artifact_sha256 = ? LIMIT 1`,
    )
    .get(ctx.workspaceId, input.sha256) as { source_ref: string; payload_schema: string; kind: string } | undefined;
  if (handle === undefined || !isFactKind(handle.kind)) {
    return err(SYNC_ERRORS.ARTIFACT_NOT_FOUND, { sha256: input.sha256 });
  }
  // The managed runtime (the private consumer repo) binds the E00 content store that returns the
  // bytes; the MIT core publishes the HANDLE (hash + ref) and never the blob inline, so a self-hoster
  // fetches from their own E00 storage. Reported honestly until a store is wired.
  return ok({ sha256: input.sha256, ref: handle.source_ref, payloadSchema: handle.payload_schema });
}
