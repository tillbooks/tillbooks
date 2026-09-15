/**
 * A25 US-A25.5, `preparePeriod`: the agent readies a period so the human just reviews.
 *
 * It ORCHESTRATES the read models the month-end questions already have owners for (review coverage
 * here, drafts from A02, the unmatched bank queues from A20/A21, open debtors from A16, the MWST
 * preview from A07) into ONE review packet, and it leaves machine FLAGS on the two anomaly shapes
 * it can detect itself today: a duplicate-looking posting (same day, same amount) and a line
 * missing a tax code on an account that declares a default. A26's richer detection consumes the
 * same `flagEntry` seam later rather than a second flag machine.
 *
 * WHAT IT NEVER DOES: approve, lock, or export. Preparing annotates the books, so it gates on
 * `post` (the E00/G00 inheritance rule for data ABOUT a journal entry) and deliberately NOT on
 * `review`: the `agent` built-in can prepare, and sign-off stays a human act behind `review`.
 *
 * IDEMPOTENT twice over: the verb replays on its key (§H-IDEMPOTENT), and a re-run under a NEW key
 * refreshes the packet without duplicating a single machine flag, because every `prepare` flag is
 * recognised by its (entry, comment) identity before it would be written again. Reads are
 * §H-TENANT-scoped; the only rows written are `entry_review` flags (§H-AUDIT: the ledger is
 * untouched by construction, see `shared.ts`).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { computeVatReturn } from '../vat/index.js';
import { listOpenItems } from '../debtors/index.js';
import { VAT_FREE_ENTRY_SOURCES } from '../ledger/postEntry.js';
import { appendReviewEvent, parseReviewPeriod } from './shared.js';
import { reviewStatus } from './status.js';

export interface PreparePeriodInput {
  period: string;
  idempotencyKey: string;
}

interface AnomalyFlag {
  entryId: string;
  comment: string;
}

/** Duplicate suspicion: two posted business entries on one day over one amount. */
function duplicateSuspects(ctx: WorkspaceContext, start: string, end: string): AnomalyFlag[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT e.id, e.date, COALESCE(SUM(l.base_debit_minor), 0) AS total
         FROM journal_entry e
         JOIN journal_line l ON l.entry_id = e.id
        WHERE e.workspace_id = ? AND e.status = 'posted'
          AND e.date >= ? AND e.date <= ?
          AND e.source NOT IN ('reversal', 'close')
        GROUP BY e.id
        ORDER BY e.date ASC, e.id ASC`,
    )
    .all(ctx.workspaceId, start, end) as { id: string; date: string; total: number }[];

  const byKey = new Map<string, { id: string; date: string; total: number }[]>();
  for (const row of rows) {
    if (row.total <= 0) continue;
    const key = `${row.date}|${row.total}`;
    const group = byKey.get(key);
    if (group === undefined) byKey.set(key, [row]);
    else group.push(row);
  }

  const flags: AnomalyFlag[] = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    for (const row of group) {
      const others = group.filter((g) => g.id !== row.id).map((g) => g.id);
      flags.push({
        entryId: row.id,
        comment: `duplicate_suspect: same date and amount as ${others.join(', ')}`,
      });
    }
  }
  return flags;
}

/** A line with no tax code on an account whose chart row declares a VAT default. */
function missingTaxCodes(ctx: WorkspaceContext, start: string, end: string): AnomalyFlag[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT DISTINCT e.id AS entry_id, a.number AS account_number
         FROM journal_entry e
         JOIN journal_line l ON l.entry_id = e.id
         JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND e.status = 'posted'
          AND e.date >= ? AND e.date <= ?
          AND e.source NOT IN (${VAT_FREE_ENTRY_SOURCES.map(() => '?').join(', ')})
          AND a.vat_code_default IS NOT NULL AND l.tax_code IS NULL
        ORDER BY e.date ASC, e.id ASC`,
    )
    .all(ctx.workspaceId, start, end, ...VAT_FREE_ENTRY_SOURCES) as { entry_id: string; account_number: string }[];
  return rows.map((row) => ({
    entryId: row.entry_id,
    comment: `missing_tax_code: account ${row.account_number} declares a VAT default and the line carries none`,
  }));
}

export function preparePeriod(ctx: WorkspaceContext, input: PreparePeriodInput): Result {
  if (typeof input?.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const period = parseReviewPeriod(input.period);
  if (period === undefined) {
    return err('invalid_period', { period: input?.period, expected: 'YYYY-MM or YYYY' });
  }

  const run = (): Result => {
    // --- The machine flags, deduplicated by (entry, comment) against earlier prepare runs. ------
    const existing = new Set(
      (
        ctx.store.db
          .prepare(
            `SELECT entry_id, comment FROM entry_review
              WHERE workspace_id = ? AND source = 'prepare'`,
          )
          .all(ctx.workspaceId) as { entry_id: string; comment: string | null }[]
      ).map((row) => `${row.entry_id}|${row.comment ?? ''}`),
    );

    const detected = [
      ...duplicateSuspects(ctx, period.start, period.end),
      ...missingTaxCodes(ctx, period.start, period.end),
    ];
    const flags = detected.map((flag) => {
      const isNew = !existing.has(`${flag.entryId}|${flag.comment}`);
      if (isNew) {
        appendReviewEvent(ctx, {
          entryId: flag.entryId,
          kind: 'flag',
          status: 'flagged',
          comment: flag.comment,
          source: 'prepare',
        });
      }
      return { ...flag, new: isNew };
    });

    // --- The packet: every count from the read model that owns it. ------------------------------
    const review = reviewStatus(ctx, { period: period.period });
    if (!review.ok) return review;

    const draftCount = (
      ctx.store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM journal_entry
            WHERE workspace_id = ? AND status = 'draft' AND date >= ? AND date <= ?`,
        )
        .get(ctx.workspaceId, period.start, period.end) as { n: number }
    ).n;

    // A21's queue: registered incoming credits still awaiting a decision as of the period end.
    const unmatchedIncoming = (
      ctx.store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM reconciliation_match
            WHERE workspace_id = ? AND status = 'open' AND value_date <= ?`,
        )
        .get(ctx.workspaceId, period.end) as { n: number }
    ).n;

    // A20's board: imported txns in the period with no settled link. A routed credit settles
    // through its A21 queue row, so it counts as unmatched only while that row is still open.
    const unmatchedBankTxns = (
      ctx.store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM bank_txn t
            WHERE t.workspace_id = ?
              AND COALESCE(t.value_date, t.booking_date) >= ?
              AND COALESCE(t.value_date, t.booking_date) <= ?
              AND NOT EXISTS (
                    SELECT 1 FROM bank_txn_link l
                     WHERE l.workspace_id = t.workspace_id AND l.bank_txn_id = t.id)
              AND (t.credit_id IS NULL OR EXISTS (
                    SELECT 1 FROM reconciliation_match m
                     WHERE m.workspace_id = t.workspace_id AND m.id = t.credit_id
                       AND m.status = 'open'))`,
        )
        .get(ctx.workspaceId, period.start, period.end) as { n: number }
    ).n;

    const debtors = listOpenItems(ctx, { asOf: period.end });
    const openDebtors =
      debtors.ok && Array.isArray(debtors.items) ? (debtors.items as unknown[]).length : 0;

    // A07's preview. A workspace without VAT config gets the CODE surfaced as a packet note (the
    // spec's `needs_vat_config` state), never a failed prepare: the review still has value.
    const vat = computeVatReturn(ctx, { periodStart: period.start, periodEnd: period.end });
    const vatPreview = vat.ok
      ? {
          payableMinor: vat.payableMinor,
          creditMinor: vat.creditMinor,
          totalTaxDueMinor: vat.totalTaxDueMinor,
          totalInputTaxMinor: vat.totalInputTaxMinor,
          empty: vat.empty,
          error: null,
        }
      : { payableMinor: null, creditMinor: null, totalTaxDueMinor: null, totalInputTaxMinor: null, empty: null, error: vat.error };

    return ok({
      period: period.period,
      periodStart: period.start,
      periodEnd: period.end,
      packet: {
        review: {
          total: review.total,
          approved: review.approved,
          flagged: review.flagged,
          open: review.open,
        },
        draftCount,
        unmatchedIncoming,
        unmatchedBankTxns,
        openDebtors,
        vatPreview,
        flags,
      },
    });
  };
  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'prepare_period', run);
}
