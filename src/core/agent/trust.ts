/**
 * A35 THE TRUST READ MODEL: the evidence behind "may the agent stop asking", derived at read time
 * from `agent_call` + `agent_action` + `agent_dial` and NEVER stored (Pattern P5).
 *
 * WHY IT IS BUILT ON THE TRACE. A write executed at `auto` never becomes an `agent_action` row: its
 * only durable record is the call row, plus an `audit_log` row where the module happens to write one.
 * A trust view built on the approval queue alone would show a busy `auto` agent as idle, and one
 * built on the audit chain would miss every module that never calls `ctx.audit.record`. The trace
 * records at the dispatch seam and is complete by construction.
 *
 * DATA HONESTY IS THE PAYLOAD'S JOB TOO: every figure travels with the window it was counted over,
 * and the Studio's dash-versus-zero rule (`-` when nothing was ever proposed, `0` when proposals
 * exist and none were decided) is derivable from the counts without a second read.
 */

import type { WorkspaceContext } from '../context.js';
import type { Result } from '../result.js';
import { ok } from '../result.js';
import { DIAL_CAPABILITIES, effectiveDialLevel } from './dial.js';
import { TRUST_SUGGEST_THRESHOLD, TRUST_WINDOW_DAYS } from './constants.js';

export interface AgentTrustSummaryInput {
  from?: unknown;
  to?: unknown;
}

/** One capability's evidence row. Counts range over the stated window; levels are current. */
export interface TrustRow {
  capability: string;
  stored: string;
  effective: string;
  strongDefault: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
  proposed: number;
  approved: number;
  rejected: number;
  autoExecuted: number;
  lastAt: string | null;
  /** D90 D-3 precomputed: the threshold is met and the row may OFFER the D103 grant act (the Studio
   *  still honours its per-capability dismissal state; a dismissed suggestion never returns). */
  suggestGrant: boolean;
}

export function agentTrustSummary(ctx: WorkspaceContext, input: AgentTrustSummaryInput): Result {
  const now = ctx.clock.now();
  const from =
    typeof input.from === 'string'
      ? input.from
      : new Date(new Date(now).getTime() - TRUST_WINDOW_DAYS * 86_400_000).toISOString();
  const to = typeof input.to === 'string' ? input.to : now;
  const db = ctx.store.db;

  const rows: TrustRow[] = DIAL_CAPABILITIES.map((capability) => {
    const level = effectiveDialLevel(ctx, capability);
    // Critic F16: `proposed` ranges over PROPOSALS MADE in the window and `approved`/`rejected`
    // over DECISIONS MADE in the window, independently, so a proposal that straddles the boundary
    // (made before, decided inside) still counts where its decision happened instead of vanishing
    // from both columns and quietly biasing the D-3 suggestion away from firing.
    // Re-critic R-F4: `last_at` is WINDOW-BOUNDED like every other figure on this payload (the
    // latest in-window proposal OR decision): a figure must never name an instant outside the
    // window it travels with.
    const counts = db
      .prepare(
        `SELECT
           SUM(CASE WHEN created_at >= ? AND created_at <= ? THEN 1 ELSE 0 END) AS proposed,
           SUM(CASE WHEN status = 'executed' AND resolved_at >= ? AND resolved_at <= ? THEN 1 ELSE 0 END) AS approved,
           SUM(CASE WHEN status = 'rejected' AND resolved_at >= ? AND resolved_at <= ? THEN 1 ELSE 0 END) AS rejected,
           MAX(CASE WHEN created_at >= ? AND created_at <= ? THEN created_at END) AS last_proposed,
           MAX(CASE WHEN resolved_at >= ? AND resolved_at <= ? THEN resolved_at END) AS last_resolved
         FROM agent_action
        WHERE workspace_id = ? AND dial_capability = ?`,
      )
      .get(from, to, from, to, from, to, from, to, from, to, ctx.workspaceId, capability) as {
      proposed: number | null;
      approved: number | null;
      rejected: number | null;
      last_proposed: string | null;
      last_resolved: string | null;
    };
    const auto = db
      .prepare(
        `SELECT COUNT(*) AS n, MAX(at) AS last_at FROM agent_call
          WHERE workspace_id = ? AND dial_capability = ? AND mode = 'execute' AND ok = 1
            AND at >= ? AND at <= ?`,
      )
      .get(ctx.workspaceId, capability, from, to) as { n: number; last_at: string | null };

    const proposed = counts.proposed ?? 0;
    const approved = counts.approved ?? 0;
    const rejected = counts.rejected ?? 0;
    const lastAt =
      [counts.last_proposed, counts.last_resolved, auto.last_at]
        .filter((v): v is string => v !== null)
        .sort()
        .pop() ?? null;
    return {
      capability,
      stored: level.stored,
      effective: level.effective,
      strongDefault: level.strongDefault,
      updatedBy: level.updatedBy,
      updatedAt: level.updatedAt,
      proposed,
      approved,
      rejected,
      autoExecuted: auto.n,
      lastAt,
      suggestGrant: level.effective !== 'auto' && rejected === 0 && approved >= TRUST_SUGGEST_THRESHOLD,
    };
  });

  return ok({ window: { from, to, defaultDays: TRUST_WINDOW_DAYS }, suggestThreshold: TRUST_SUGGEST_THRESHOLD, rows });
}
