/**
 * A40, the customer payment-delay model (spec §4.3): deterministic, read from the books, no fitted model.
 *
 * A SAMPLE is `settleDate - dueDate` in calendar days for one settled invoice, where `settleDate` is
 * the latest date among the invoice's allocations from POSTED payments (a reversed payment never
 * counts: it did not pay). Negative samples are early payers and are kept.
 *
 * THE EXPECTED DELAY is the nearest-rank `q`-quantile of the customer's samples. Fewer than
 * `MIN_SAMPLES` borrows the workspace's pooled samples; fewer than that there assumes 0 and says
 * `no_history`. The quantile is CONDITIONAL on what is already known: a receivable `k` days past its
 * due date today is only quantiled over samples `>= k` (it has not arrived yet), and when no sample is
 * that large it is `overdue_beyond_history` and excluded from the forecast rather than assumed paid.
 *
 * §H-TENANT: the one query filters `workspace_id` on every table it reads.
 */

import type { WorkspaceContext } from '../context.js';
import { daysBetween } from './calendar.js';

/** The fewest samples a customer needs before their own history is used (else the pool). */
export const MIN_SAMPLES = 3;

/** The nearest-rank quantile (`q` in percent, 1..99) of `samples`, or null when empty. */
export function nearestRank(samples: readonly number[], q: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((q / 100) * sorted.length));
  return sorted[rank - 1] as number;
}

export type DelaySource = 'customer' | 'pooled' | 'no_history';

export type DelayAnswer =
  | { ok: true; delayDays: number; source: DelaySource; samples: number }
  | { ok: false; reason: 'overdue_beyond_history' | 'overdue_no_history'; source: DelaySource; samples: number };

/**
 * The expected delay of one receivable, given how late it already is (`lateByDays`, negative when not
 * yet due), the customer's own samples and the pool.
 */
export function expectedDelay(
  customerSamples: readonly number[],
  pooled: readonly number[],
  q: number,
  lateByDays: number,
): DelayAnswer {
  let source: DelaySource;
  let samples: readonly number[];
  if (customerSamples.length >= MIN_SAMPLES) {
    source = 'customer';
    samples = customerSamples;
  } else if (pooled.length >= MIN_SAMPLES) {
    source = 'pooled';
    samples = pooled;
  } else {
    if (lateByDays > 0) return { ok: false, reason: 'overdue_no_history', source: 'no_history', samples: 0 };
    return { ok: true, delayDays: Math.max(0, lateByDays), source: 'no_history', samples: 0 };
  }
  const survivors = samples.filter((s) => s >= lateByDays);
  const value = nearestRank(survivors, q);
  if (value === null) return { ok: false, reason: 'overdue_beyond_history', source, samples: samples.length };
  return { ok: true, delayDays: value, source, samples: samples.length };
}

export interface DelayHistory {
  byCustomer: ReadonlyMap<string, readonly number[]>;
  pooled: readonly number[];
}

/** Every settled invoice's delay, per customer and pooled, as of `asOf`. */
export function readDelayHistory(ctx: WorkspaceContext, asOf: string): DelayHistory {
  const rows = ctx.store.db
    .prepare(
      `SELECT d.contact_id AS customer, d.due_date AS due, MAX(p.date) AS settled
         FROM document d
         JOIN payment_allocation a
           ON a.workspace_id = d.workspace_id AND a.target_kind = 'document' AND a.target_id = d.id
         JOIN payment p
           ON p.workspace_id = a.workspace_id AND p.id = a.payment_id AND p.status = 'posted'
        WHERE d.workspace_id = ? AND d.type = 'invoice' AND d.status = 'settled'
          AND d.due_date IS NOT NULL AND d.contact_id IS NOT NULL AND p.date <= ?
        GROUP BY d.id
        ORDER BY d.id`,
    )
    .all(ctx.workspaceId, asOf) as { customer: string; due: string; settled: string }[];
  const byCustomer = new Map<string, number[]>();
  const pooled: number[] = [];
  for (const r of rows) {
    const s = daysBetween(r.due, r.settled);
    pooled.push(s);
    const list = byCustomer.get(r.customer) ?? [];
    list.push(s);
    byCustomer.set(r.customer, list);
  }
  return { byCustomer, pooled };
}
