/**
 * A25 US-A25.2, `reviewStatus`: the coverage read model (P5) behind the review surface's bar.
 *
 * "142/150 approved, 3 flagged, 5 open" for a period, plus the per-entry list with each entry's
 * current review state, its last event and its comment count, so the surface renders the whole
 * period from ONE read. Pure query over `journal_entry` joined to the latest `entry_review` event
 * per entry; drafts never appear (review covers the books, and a draft is not the books yet).
 * §H-TENANT on every correlated read.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { applySavedView } from '../customization/index.js';
import { parseReviewPeriod } from './shared.js';

interface StatusRow {
  id: string;
  date: string;
  ref: string | null;
  description: string | null;
  source: string;
  review_status: string | null;
  reviewer: string | null;
  last_event_at: string | null;
  comment_count: number;
  flag_count: number;
}

export interface ReviewStatusInput {
  period?: string;
  savedViewId?: string;
}

export function reviewStatus(ctx: WorkspaceContext, input: ReviewStatusInput): Result {
  // The G00 saved-view seam, one unconditional call exactly as `listJournal` makes it: `entry_review`
  // is a registered customization kind, so a saved view over it (e.g. a Treuhänder's "March 2026
  // review") stores its `period` and this read applies it. Stored filters merge UNDER any named here,
  // so an explicit period always wins over the view's.
  const viewed = applySavedView(ctx, 'entry_review', input);
  if (!viewed.ok) return viewed;
  input = viewed.filter;

  const period = parseReviewPeriod(input?.period);
  if (period === undefined) {
    return err('invalid_period', { period: input?.period, expected: 'YYYY-MM or YYYY' });
  }

  const rows = ctx.store.db
    .prepare(
      `SELECT e.id, e.date, e.ref, e.description, e.source,
              (SELECT r.status FROM entry_review r
                WHERE r.workspace_id = e.workspace_id AND r.entry_id = e.id
                ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) AS review_status,
              (SELECT r.reviewer FROM entry_review r
                WHERE r.workspace_id = e.workspace_id AND r.entry_id = e.id
                ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) AS reviewer,
              (SELECT r.created_at FROM entry_review r
                WHERE r.workspace_id = e.workspace_id AND r.entry_id = e.id
                ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) AS last_event_at,
              (SELECT COUNT(*) FROM entry_review r
                WHERE r.workspace_id = e.workspace_id AND r.entry_id = e.id
                  AND r.kind = 'comment') AS comment_count,
              (SELECT COUNT(*) FROM entry_review r
                WHERE r.workspace_id = e.workspace_id AND r.entry_id = e.id
                  AND r.kind = 'flag') AS flag_count
         FROM journal_entry e
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date >= ? AND e.date <= ?
        ORDER BY e.date ASC, e.id ASC`,
    )
    .all(ctx.workspaceId, period.start, period.end) as StatusRow[];

  let approved = 0;
  let flagged = 0;
  let open = 0;
  const entries = rows.map((row) => {
    const status = row.review_status ?? 'open';
    if (status === 'approved') approved += 1;
    else if (status === 'flagged') flagged += 1;
    else open += 1;
    return {
      entryId: row.id,
      date: row.date,
      ref: row.ref,
      description: row.description,
      source: row.source,
      status,
      reviewer: row.reviewer,
      lastEventAt: row.last_event_at,
      commentCount: row.comment_count,
      flagCount: row.flag_count,
    };
  });

  return ok({
    period: period.period,
    periodStart: period.start,
    periodEnd: period.end,
    total: entries.length,
    approved,
    flagged,
    open,
    entries,
  });
}
