/**
 * A26 US-A26.5, `detectAnomalies`: surface likely mistakes as FLAGS, never auto-corrections, and
 * WRITE NOTHING (readOnlyHint). The user confirms, and only then does a separate flow draft the fix
 * (§4). Every finding is `{ kind, entryIds, severity }`.
 *
 * The detections are pure reads over the posted ledger, so A26 stays self-contained: probable
 * duplicates (same date and same absolute base total in a window), stale/unbalanced drafts,
 * missing tax codes on income/expense lines, and round-number outliers.
 *
 * A25 is now wired: flagging a surfaced anomaly for Treuhänder review calls `ReviewSeam.flagEntry`
 * (reviewSeam.ts), backed by A25's real review module. It is DELIBERATELY still NOT called from this
 * read verb: a read must not mutate (conformance rule 4 / readOnlyHint). The flag is raised from the
 * human-driven inbox/approve flow through the wired seam, so the anomaly detection itself stays a
 * pure read.
 */

import type { WorkspaceContext } from '../context.js';
import type { Result } from '../result.js';
import { ok, err } from '../result.js';

export interface DetectAnomaliesInput {
  period?: unknown;
}

export interface Anomaly {
  kind: string;
  entryIds: string[];
  severity: 'low' | 'medium' | 'high';
}

/** `YYYY` or `YYYY-MM` -> an inclusive [start, end] day fence, or the all-time fence when absent. */
function fence(period: unknown): { start: string; end: string } {
  if (typeof period === 'string') {
    if (/^\d{4}$/.test(period)) return { start: `${period}-01-01`, end: `${period}-12-31` };
    const m = /^(\d{4})-(\d{2})$/.exec(period);
    if (m) return { start: `${period}-01`, end: `${period}-31` };
  }
  return { start: '0001-01-01', end: '9999-12-31' };
}

export function detectAnomalies(ctx: WorkspaceContext, input: DetectAnomaliesInput): Result {
  if (input.period !== undefined && typeof input.period !== 'string') {
    return err('invalid_input', { field: 'period' });
  }
  const { start, end } = fence(input.period);
  const anomalies: Anomaly[] = [];

  // Probable duplicates: two or more posted entries on the same date whose base total (summed from
  // the debit side, which balances the credit side) matches. Grouped in JS below for portability.
  const posted = ctx.store.db
    .prepare(
      `SELECT je.id AS id, je.date AS date,
              COALESCE(SUM(jl.base_debit_minor), 0) AS total,
              SUM(CASE WHEN jl.tax_code IS NULL AND a.type IN ('income','expense') THEN 1 ELSE 0 END) AS untaxed
         FROM journal_entry je
         JOIN journal_line jl ON jl.entry_id = je.id
         JOIN account a ON a.id = jl.account_id
        WHERE je.workspace_id = ? AND je.status = 'posted' AND je.date >= ? AND je.date <= ?
        GROUP BY je.id
        ORDER BY je.date, je.id`,
    )
    .all(ctx.workspaceId, start, end) as { id: string; date: string; total: number; untaxed: number }[];

  const seen = new Map<string, string[]>();
  const duplicateIds: string[] = [];
  const untaxedIds: string[] = [];
  const roundOutlierIds: string[] = [];
  for (const e of posted) {
    const key = `${e.date}:${e.total}`;
    const bucket = seen.get(key);
    if (bucket === undefined) seen.set(key, [e.id]);
    else bucket.push(e.id);
    if (e.untaxed > 0) untaxedIds.push(e.id);
    // A round-number outlier: an entry total that is an exact multiple of CHF 1'000.00 and non-trivial.
    if (e.total >= 100000 && e.total % 100000 === 0) roundOutlierIds.push(e.id);
  }
  for (const bucket of seen.values()) {
    if (bucket.length > 1) duplicateIds.push(...bucket);
  }
  if (duplicateIds.length > 0) anomalies.push({ kind: 'probable_duplicate', entryIds: duplicateIds, severity: 'high' });

  // Stale / unbalanced drafts: a draft is money not yet on the books; a lingering one is a mistake.
  const drafts = ctx.store.db
    .prepare(
      `SELECT id FROM journal_entry
        WHERE workspace_id = ? AND status = 'draft' AND date >= ? AND date <= ?
        ORDER BY date LIMIT 200`,
    )
    .all(ctx.workspaceId, start, end) as { id: string }[];
  if (drafts.length > 0) {
    anomalies.push({ kind: 'stale_draft', entryIds: drafts.map((d) => d.id), severity: 'medium' });
  }

  if (untaxedIds.length > 0) anomalies.push({ kind: 'missing_tax_code', entryIds: untaxedIds, severity: 'low' });
  if (roundOutlierIds.length > 0) anomalies.push({ kind: 'round_number_outlier', entryIds: roundOutlierIds, severity: 'low' });

  return ok({ period: typeof input.period === 'string' ? input.period : null, anomalies });
}
