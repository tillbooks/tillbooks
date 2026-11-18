/**
 * D198 point 5, THE DAILY PULL: under `settlement.pull_mode` = `daily`, the scheduler pulls every saved source
 * once per Swiss day.
 *
 * WHO. The person who last saved the source, their `post` right checked live and never a governed seat
 * (the bank auto-sync rule, D142): an unattended pull books, so it books as a person who could have booked
 * it by hand. When nobody qualifies, the attempt is recorded as failed with `no_actor` and nothing runs.
 *
 * HOW OFTEN. One successful pull per source and Swiss day; after a failure, another attempt at least an
 * hour later, at most `DAILY_PULL_MAX_ATTEMPTS` a day. Each attempt has its own idempotency key
 * (`dailyPullKey`, `settlement-daily:<source>:<day>:<n>`, a reserved prefix no caller may send), so a tick
 * that runs twice never pulls twice. An `incomplete` pull is not a success: the next attempt retries it.
 *
 * A failed attempt is recorded in `settlement_pull` (`recordFailedPull`): the verb itself writes nothing
 * when it refuses, and the last result must show the failure. Nothing is fetched without a saved template:
 * the verb refuses before it opens the feed, and that refusal is what the record shows.
 */

import type { WorkspaceContext } from '../context.js';
import type { Result } from '../result.js';
import { zurichParts } from '../banking/ebics/autoSync.js';
import { listSourceRows, pullModeOf, recordFailedPull, dailyRangeOf, settlementTodayOf } from './source.js';

export const DAILY_PULL_MAX_ATTEMPTS = 3;

/** The reserved idempotency-key prefix of a scheduled pull (`RESERVED_IDEMPOTENCY_KEY_PREFIXES`, re-cut R7). */
export const DAILY_PULL_KEY_PREFIX = 'settlement-daily:';

/** The key of one daily attempt: one per source, Swiss day and attempt number. */
export function dailyPullKey(sourceId: string, day: string, attempt: number): string {
  return `${DAILY_PULL_KEY_PREFIX}${sourceId}:${day}:${attempt}`;
}
/** The least time between two attempts of one source on one day. */
export const DAILY_PULL_RETRY_MS = 60 * 60 * 1000;

export interface DailyPullReport {
  sourceId: string;
  outcome: 'pulled' | 'failed' | 'skipped';
  code?: string;
}

export function runSettlementPullStep(
  ctx: WorkspaceContext,
  deps: { pull: (actor: string, input: Record<string, unknown>) => Result; holdsPost: (actor: string) => boolean },
): DailyPullReport[] {
  if (pullModeOf(ctx) !== 'daily') return [];
  const reports: DailyPullReport[] = [];
  const today = settlementTodayOf(ctx);
  const nowMs = Date.parse(ctx.clock.now());
  for (const source of listSourceRows(ctx)) {
    const attempts = ctx.store.db
      .prepare("SELECT outcome, at FROM settlement_pull WHERE workspace_id = ? AND source_id = ? AND trigger_kind = 'daily' ORDER BY at")
      .all(ctx.workspaceId, source.id) as { outcome: string; at: string }[];
    const todays = attempts.filter((a) => zurichParts(a.at).date === today);
    if (todays.some((a) => a.outcome === 'ok') || todays.length >= DAILY_PULL_MAX_ATTEMPTS) {
      reports.push({ sourceId: source.id, outcome: 'skipped' });
      continue;
    }
    const last = todays[todays.length - 1];
    if (last !== undefined && nowMs - Date.parse(last.at) < DAILY_PULL_RETRY_MS) {
      reports.push({ sourceId: source.id, outcome: 'skipped' });
      continue;
    }
    const range = dailyRangeOf(ctx, source);
    if (!deps.holdsPost(source.updated_by)) {
      recordFailedPull(ctx, source.id, range, 'no_actor', 'system');
      reports.push({ sourceId: source.id, outcome: 'failed', code: 'no_actor' });
      continue;
    }
    const result = deps.pull(source.updated_by, {
      workspaceId: ctx.workspaceId,
      system: source.source_system,
      processor: source.source_processor,
      idempotencyKey: dailyPullKey(source.id, today, todays.length + 1),
      trigger: 'daily',
    });
    if (result.ok) {
      reports.push({ sourceId: source.id, outcome: 'pulled' });
    } else {
      recordFailedPull(ctx, source.id, range, String(result.error), source.updated_by);
      reports.push({ sourceId: source.id, outcome: 'failed', code: String(result.error) });
    }
  }
  return reports;
}
