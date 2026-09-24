/**
 * A03, the tamper-evident audit log (§H-AUDIT, OR Art. 957a).
 *
 * Every posted entry (and every lock/unlock/close) appends one row to an append-only, hash-chained
 * log: `hash = H(prev_hash ‖ canonical(row))`. There is no update/delete path (the repo layer exposes
 * none, and the immutability is what makes the record unalterable for the OR 958f retention horizon).
 * The chain is verified on every read (Pattern P5, no stored flag to go stale): any edited, reordered,
 * or reinserted row, and any MIDDLE deletion, breaks a link and `getAuditLog` reports
 * `chainVerified:false` with `brokenAtId`.
 *
 * A bare prev/hash chain cannot by itself catch TAIL truncation (dropping the last rows leaves a valid
 * shorter prefix), so each workspace also carries an `audit_head` anchor (row count + head hash),
 * updated inside the same transaction as every append. `getAuditLog` cross-checks the walked length and
 * last hash against the anchor, so a truncated or wholly-deleted log fails to verify too. This raises
 * the bar on tampering (a forger must also rewrite the anchor row); the external, out-of-band anchor
 * against a fully in-DB forgery is the cloud archive export (OP4, out of scope for Wave 0).
 *
 * The chain is per-workspace (§H-TENANT): each workspace has its own independent chain, ordered by
 * insertion (SQLite `rowid`), so a multi-tenant store never interleaves two tenants' trails.
 */

import { createHash } from 'node:crypto';

import type { SqliteStore } from '../store/sqlite-store.js';
import type { WorkspaceContext } from '../context.js';
import type { AuditPort, AuditEvent } from '../ports.js';
import type { IdGen } from '../ids.js';
import { ok } from '../result.js';
import type { Result } from '../result.js';

/**
 * The single §H-ENUM source of truth for `audit_log.action`. A spec that legitimately needs a new
 * action adds it here, in one place, so no entry can slip through unclassified for the FTA/auditor read.
 */
export const AUDIT_ACTIONS: ReadonlySet<string> = new Set([
  'create',
  'post',
  'reverse',
  'close',
  'lock',
  'unlock',
]);

/** The `prev_hash` used when computing the first (genesis) row's hash. Stored as NULL in the row. */
export const AUDIT_GENESIS_PREV = '';
const GENESIS = AUDIT_GENESIS_PREV;

export interface AuditRowContent {
  id: string;
  workspaceId: string;
  entityKind: string;
  entityId: string;
  action: string;
  actor: string;
  at: string;
}

/**
 * A canonical, delimiter-safe serialisation of a row's semantic content (everything but the hash). A
 * JSON array is injective over these string fields (quoting/escaping keeps the boundaries unambiguous),
 * and the fixed field order makes the hash reproducible on every read.
 */
export function auditCanonicalRow(row: AuditRowContent): string {
  return canonicalRow(row);
}

function canonicalRow(row: AuditRowContent): string {
  return JSON.stringify([
    row.id,
    row.workspaceId,
    row.entityKind,
    row.entityId,
    row.action,
    row.actor,
    row.at,
  ]);
}

/** `H(prev_hash ‖ canonical(row))`, SHA-256 hex. The prev hash is fixed-width
 * hex (or empty at genesis) and the two parts are separated by a NUL byte, an unambiguous boundary here:
 * `JSON.stringify` escapes any NUL inside the canonical string, so a literal NUL can never appear in it.
 *
 * Write that separator as the ESCAPE, never as a raw byte. One raw NUL anywhere in a file makes `file`
 * call it binary, and `grep` then skips it in silence: no match, no warning, exit 1. This file carried
 * one until 2026-07-26 and was invisible to every `grep -rn` over `src/`, the method that has found
 * most of the Studio/engine contract defects here. The escape hashes identically, and
 * `test/style/binary-source-files.test.mjs` now reddens if any tracked text file gains a NUL. */
/**
 * G04 restore reuses `hashRow` (via this export) to RE-CHAIN a restored workspace's audit log:
 * `workspace_id` is a hash input (`canonicalRow`), and restore mints a NEW workspace id, so the
 * copied hashes must be recomputed under the new identity or `getAuditLog` would fail to verify.
 * Exposed so there is ONE source of truth for the chain hash, never a second copy in `core/data/`.
 */
export function auditHashRow(prevHash: string, canonical: string): string {
  return hashRow(prevHash, canonical);
}

function hashRow(prevHash: string, canonical: string): string {
  return createHash('sha256').update(prevHash).update('\u0000').update(canonical).digest('hex');
}

export interface AuditDeps {
  store: SqliteStore;
  workspaceId: string;
  ids: IdGen;
}

interface StoredRow {
  id: string;
  workspace_id: string;
  entity_kind: string;
  entity_id: string;
  action: string;
  actor: string;
  at: string;
  prev_hash: string | null;
  hash: string;
}

/**
 * Append one row to the workspace's chain. Reads the current tail's hash, computes this row's hash off
 * it, and inserts. Meant to run inside the same transaction as the event it records (A02's post writes
 * the entry and this row together), so a crash leaves neither.
 */
export function appendAuditLog(
  deps: AuditDeps,
  event: AuditEvent,
): { ok: true; hash: string; id: string } {
  const { db } = deps.store;
  // The head anchor is the tail pointer: it holds the chain length and the last hash, so append reads
  // it (not the log) and truncating the log without rewriting the anchor is detectable at read time.
  const head = db
    .prepare('SELECT row_count, head_hash FROM audit_head WHERE workspace_id = ?')
    .get(deps.workspaceId) as { row_count: number; head_hash: string } | undefined;
  const prevHash = head?.head_hash ?? GENESIS;
  const id = deps.ids.next('audit');
  const canonical = canonicalRow({
    id,
    workspaceId: deps.workspaceId,
    entityKind: event.entityKind,
    entityId: event.entityId,
    action: event.action,
    actor: event.actor,
    at: event.at,
  });
  const hash = hashRow(prevHash, canonical);
  db.prepare(
    `INSERT INTO audit_log (id, workspace_id, entity_kind, entity_id, action, actor, at, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    deps.workspaceId,
    event.entityKind,
    event.entityId,
    event.action,
    event.actor,
    event.at,
    head === undefined ? null : prevHash,
    hash,
  );
  db.prepare(
    `INSERT INTO audit_head (workspace_id, row_count, head_hash) VALUES (?, 1, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET row_count = row_count + 1, head_hash = excluded.head_hash`,
  ).run(deps.workspaceId, hash);
  return { ok: true, hash, id };
}

/**
 * The real `AuditPort` (A03) that A02 records through. `noAudit` (ports.ts) is the Phase-1 stub; this
 * replaces it in a wired ledger context so the stamp fires on every post with no way to skip it.
 */
export function makeAuditPort(deps: AuditDeps): AuditPort {
  return {
    record(event: AuditEvent): void {
      appendAuditLog(deps, event);
    },
  };
}

export interface AuditLogFilter {
  entityKind?: string;
  from?: string;
  to?: string;
}

function toCamel(r: StoredRow) {
  return {
    id: r.id,
    entityKind: r.entity_kind,
    entityId: r.entity_id,
    action: r.action,
    actor: r.actor,
    at: r.at,
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}

/**
 * Read the workspace's audit trail. The whole chain is walked and verified on every call (P5), then
 * the returned rows are filtered: `chainVerified` reflects the entire chain's integrity, so a filter
 * that matches nothing still returns `chainVerified:true` (nothing to break) unless a row was tampered.
 */
export function getAuditLog(ctx: WorkspaceContext, filter: AuditLogFilter = {}): Result {
  const all = ctx.store.db
    .prepare(
      `SELECT id, workspace_id, entity_kind, entity_id, action, actor, at, prev_hash, hash
         FROM audit_log WHERE workspace_id = ? ORDER BY rowid ASC`,
    )
    .all(ctx.workspaceId) as StoredRow[];

  let chainVerified = true;
  let brokenAtId: string | undefined;
  let prevHash = GENESIS;
  let walked = 0;
  for (const r of all) {
    const canonical = canonicalRow({
      id: r.id,
      workspaceId: r.workspace_id,
      entityKind: r.entity_kind,
      entityId: r.entity_id,
      action: r.action,
      actor: r.actor,
      at: r.at,
    });
    const expected = hashRow(prevHash, canonical);
    const storedPrev = r.prev_hash ?? GENESIS;
    if (storedPrev !== prevHash || r.hash !== expected) {
      chainVerified = false;
      brokenAtId = r.id;
      break;
    }
    prevHash = r.hash;
    walked += 1;
  }

  // Tail anchor (§H-AUDIT): a bare prefix chain cannot catch tail truncation, so cross-check the walked
  // length and last hash against the head. A truncated, wholly-deleted, or head-tampered log fails here
  // even though every surviving link is internally consistent. No `brokenAtId`: the break is structural,
  // not a specific surviving row.
  if (chainVerified) {
    const head = ctx.store.db
      .prepare('SELECT row_count, head_hash FROM audit_head WHERE workspace_id = ?')
      .get(ctx.workspaceId) as { row_count: number; head_hash: string } | undefined;
    const expectedCount = head?.row_count ?? 0;
    const expectedHead = head?.head_hash ?? GENESIS;
    if (walked !== expectedCount || prevHash !== expectedHead) {
      chainVerified = false;
    }
  }

  const rows = all
    .filter((r) => filter.entityKind === undefined || r.entity_kind === filter.entityKind)
    .filter((r) => filter.from === undefined || r.at >= filter.from)
    .filter((r) => filter.to === undefined || r.at <= filter.to)
    .map(toCamel);

  return chainVerified
    ? ok({ rows, chainVerified: true })
    : ok({ rows, chainVerified: false, brokenAtId });
}
