/**
 * A25's shared internals: the review enums (§H-ENUM, single source), the period parser, the entry
 * lookup every review verb guards with, and the ONE writer of `entry_review` rows.
 *
 * THE ONE WRITER IS THE TRIPWIRE'S OTHER HALF. Review is a sidecar to the immutable ledger
 * (§H-AUDIT), so the whole module funnels every write through `appendReviewEvent`, which only ever
 * INSERTs into `entry_review` and stamps the audit trail through the injected port. Nothing in
 * `src/core/review/` prepares an UPDATE or DELETE statement at all; `test/review/` asserts the
 * `journal_*` rows are byte-identical across every review verb rather than trusting this sentence.
 */

import type { WorkspaceContext } from '../context.js';

/** The review states (§H-ENUM). `status` on a row is the state AFTER that row's event. */
export const REVIEW_STATUSES: readonly string[] = ['open', 'flagged', 'approved'];

/** The event kinds a row can record. `prepare` flags arrive as kind 'flag', source 'prepare'. */
export const REVIEW_EVENT_KINDS: readonly string[] = ['comment', 'flag', 'approve'];

export interface ReviewEventRow {
  id: string;
  workspace_id: string;
  entry_id: string;
  kind: string;
  status: string;
  reviewer: string | null;
  comment: string | null;
  source: string;
  created_at: string;
}

/** The camelCase view of one review event, the shape every A25 payload answers with. */
export function mapReviewEvent(row: ReviewEventRow) {
  return {
    id: row.id,
    entryId: row.entry_id,
    kind: row.kind,
    status: row.status,
    reviewer: row.reviewer,
    comment: row.comment,
    source: row.source,
    createdAt: row.created_at,
  };
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR_RE = /^\d{4}$/;

export interface ReviewPeriod {
  /** The period exactly as given: `YYYY-MM` or `YYYY`. */
  period: string;
  /** Inclusive ISO first day. */
  start: string;
  /** Inclusive ISO last day. */
  end: string;
}

/**
 * Parse a review period: a month (`YYYY-MM`) or a CALENDAR year (`YYYY`), the same two shapes A03's
 * `period_lock` keys on, so what a Treuhänder reviews is exactly what `lock_period` can then lock.
 * Returns undefined on anything else; the caller answers `invalid_period`.
 */
export function parseReviewPeriod(period: unknown): ReviewPeriod | undefined {
  if (typeof period !== 'string') return undefined;
  if (MONTH_RE.test(period)) {
    const year = Number(period.slice(0, 4));
    const month = Number(period.slice(5, 7));
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { period, start: `${period}-01`, end: `${period}-${String(lastDay).padStart(2, '0')}` };
  }
  if (YEAR_RE.test(period)) {
    return { period, start: `${period}-01-01`, end: `${period}-12-31` };
  }
  return undefined;
}

export interface PostedEntryRow {
  id: string;
  date: string;
  ref: string | null;
  description: string | null;
  status: string;
  source: string;
  reverses_entry_id: string | null;
}

/** The entry a review verb is about: must exist in THIS workspace (§H-TENANT) and be posted. */
export function postedEntry(ctx: WorkspaceContext, entryId: unknown): PostedEntryRow | undefined {
  if (typeof entryId !== 'string' || entryId.length === 0) return undefined;
  const row = ctx.store.db
    .prepare(
      `SELECT id, date, ref, description, status, source, reverses_entry_id
         FROM journal_entry WHERE workspace_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, entryId) as PostedEntryRow | undefined;
  return row;
}

/** The current review status of one entry: the latest event row wins; no row means `open`. */
export function currentReviewStatus(ctx: WorkspaceContext, entryId: string): string {
  const row = ctx.store.db
    .prepare(
      `SELECT status FROM entry_review
        WHERE workspace_id = ? AND entry_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, entryId) as { status: string } | undefined;
  return row?.status ?? 'open';
}

/** Has this entry been reversed by another posted entry? Approval of one is allowed but noted. */
export function isReversed(ctx: WorkspaceContext, entryId: string): boolean {
  const row = ctx.store.db
    .prepare(
      `SELECT 1 AS present FROM journal_entry
        WHERE workspace_id = ? AND reverses_entry_id = ? LIMIT 1`,
    )
    .get(ctx.workspaceId, entryId);
  return row !== undefined;
}

/**
 * THE ONE WRITER. Appends one review event row and stamps the audit trail. INSERT only, ever:
 * the append-only thread is what keeps the sidecar boundary (§H-AUDIT) structural.
 */
export function appendReviewEvent(
  ctx: WorkspaceContext,
  input: { entryId: string; kind: string; status: string; comment?: string | null; source?: string },
): ReviewEventRow {
  const id = ctx.ids.next('review');
  const now = ctx.clock.now();
  ctx.store.db
    .prepare(
      `INSERT INTO entry_review (id, workspace_id, entry_id, kind, status, reviewer, comment, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ctx.workspaceId,
      input.entryId,
      input.kind,
      input.status,
      ctx.actor,
      input.comment ?? null,
      input.source ?? 'manual',
      now,
    );
  ctx.audit.record({
    entityKind: 'entry_review',
    entityId: id,
    action: input.kind,
    actor: ctx.actor,
    at: now,
  });
  return ctx.store.db
    .prepare('SELECT * FROM entry_review WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as ReviewEventRow;
}
