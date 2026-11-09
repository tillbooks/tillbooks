/**
 * H07, the fixed-asset RECONCILIATION: the concrete realisation of OP11 (Sub-ledger Reconciliation) for
 * the Fixed Asset domain. It proves, to the Rappen, that the append-only `asset_transaction` sub-ledger
 * equals the General-Ledger control accounts that hold cost and accumulated depreciation, at any cut-off:
 *
 *     ∀ control accounts C used by any asset in the workspace:
 *       sub_ledger_balance(C, cut_off) === gl_balance(C, cut_off)
 *
 * Both sides are DERIVED and reproducible; nothing is cached and nothing is auto-corrected (§4 invariant
 * 5). A difference is REPORTED and blocks period close (§H-PERIOD); it is fixed by ordinary reversing +
 * correcting entries, never by the reconciliation touching the books. This is a pure READ capability: it
 * posts NOTHING and writes NOTHING.
 *
 * THE TWO SIDES, and why they are equal by construction:
 *
 *  - Sub-ledger. Every financial event on an asset is one `asset_transaction` row (`transactionSchema.ts`):
 *    acquisition / additional-capitalisation move `delta_cost_rappen` (+), depreciation moves
 *    `delta_accum_depr_rappen` (+), opening moves both (+), disposal moves both (−, clearing the asset).
 *    So for a COST control account C the sub-ledger balance is `Σ delta_cost_rappen` over every
 *    transaction (date ≤ cut-off) whose asset's `gl_asset_account_id = C`; for an ACCUMULATED-DEPRECIATION
 *    control account C it is `Σ delta_accum_depr_rappen` over transactions whose asset's
 *    `gl_accum_depr_account_id = C`.
 *  - General ledger. The SAME events posted balanced A02 journals against the SAME accounts: acquisition
 *    Dr cost, depreciation Cr accumulated, disposal Cr cost + Dr accumulated. So the cost account's GL
 *    balance is its posted `Σ (base_debit − base_credit)` (a debit balance) and the accumulated account's
 *    is its posted `Σ (base_credit − base_debit)` (a credit balance), both through the cut-off date, over
 *    the base-currency amounts the statements already sum (§H-FX).
 *
 * Because a disposal writes the negatives of both totals dated at the disposal date, an asset disposed on
 * or before the cut-off contributes 0 to BOTH the sub-ledger and the GL, and an asset acquired after the
 * cut-off contributes to neither: the date-filtered sums handle the cut-off rules (§4) with no
 * special-casing. The DETECTION mechanism (US-H07.6) falls straight out: a journal posted directly against
 * an asset control account with no backing `asset_transaction` moves the GL but not the sub-ledger, so the
 * delta is non-zero and the report shows `drift`. The system never invents a phantom asset to hide it.
 *
 * Every query is workspace-scoped (§H-TENANT): no foreign asset, transaction or journal row can enter a
 * total, even if an id is guessed.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';

/** An ISO calendar date `YYYY-MM-DD`. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A period `YYYY-MM`. */
const PERIOD = /^\d{4}-\d{2}$/;

type Role = 'cost' | 'accumulated_depreciation';

interface AccountMeta {
  id: string;
  number: string;
  name: string;
}

interface ReconAsset {
  assetId: string;
  assetNumber: string;
  name: string;
  amountRappen: number;
}

interface ReconAccount {
  accountId: string;
  accountNumber: string;
  accountName: string;
  role: Role;
  subLedgerRappen: number;
  glBalanceRappen: number;
  deltaRappen: number;
  status: 'balanced' | 'drift';
  /** The contributing assets and their individual balances, for the drill-down (US-H07.2). */
  assets: ReconAsset[];
}

/** The last day of a `YYYY-MM` period as `YYYY-MM-DD` (inclusive cut-off, §4). */
function periodEnd(period: string): string {
  const parts = period.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  // Day 0 of the next month is the last day of this one; UTC so no timezone can shift the date.
  const day = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${period}-${String(day).padStart(2, '0')}`;
}

/**
 * Resolve the cut-off date from the params: `asOf` (an ISO date) takes precedence over `period` (whose
 * end-of-month is the cut-off), and when neither is given the workspace clock's date is used, so the GUI's
 * first load has a sensible "as of today". Returns a structured error for a malformed input.
 */
function resolveCutOff(
  ctx: WorkspaceContext,
  params: { period?: string; asOf?: string },
): { cutOff: string; period: string | null } | Result {
  if (params.asOf !== undefined) {
    if (typeof params.asOf !== 'string' || !ISO_DATE.test(params.asOf)) return err('invalid_input', { field: 'asOf' });
    return { cutOff: params.asOf, period: null };
  }
  if (params.period !== undefined) {
    if (typeof params.period !== 'string' || !PERIOD.test(params.period)) {
      return err('invalid_input', { field: 'period' });
    }
    return { cutOff: periodEnd(params.period), period: params.period };
  }
  return { cutOff: ctx.clock.now().slice(0, 10), period: null };
}

function accountMeta(ctx: WorkspaceContext, accountId: string): AccountMeta {
  const row = ctx.store.db
    .prepare('SELECT id, number, name FROM account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, accountId) as { id: string; number: string; name: string } | undefined;
  return row ?? { id: accountId, number: '?', name: accountId };
}

/** The distinct control accounts of a role, in account-number order. */
function controlAccounts(ctx: WorkspaceContext, column: string): string[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT DISTINCT a.${column} AS acc
         FROM asset a
         JOIN account ac ON ac.workspace_id = a.workspace_id AND ac.id = a.${column}
        WHERE a.workspace_id = ?
        ORDER BY ac.number`,
    )
    .all(ctx.workspaceId) as { acc: string }[];
  return rows.map((r) => r.acc).filter((id) => typeof id === 'string' && id.length > 0);
}

/**
 * The GL balance of ONE account at a cut-off, over posted entries only, in base currency (§H-FX). For a
 * cost account we want the debit balance (`debit − credit`); for an accumulated-depreciation account the
 * credit balance (`credit − debit`). This is the exact aggregate the A08 statements take.
 */
function glBalance(ctx: WorkspaceContext, accountId: string, cutOff: string, role: Role): number {
  const expr =
    role === 'cost' ? 'l.base_debit_minor - l.base_credit_minor' : 'l.base_credit_minor - l.base_debit_minor';
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(${expr}), 0) AS bal
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.status = 'posted' AND e.workspace_id = ? AND l.account_id = ? AND e.date <= ?`,
    )
    .get(ctx.workspaceId, accountId, cutOff) as { bal: number };
  return row.bal;
}

/**
 * The per-asset sub-ledger contribution to ONE control account at a cut-off. The delta column is chosen
 * by role: cost accounts sum `delta_cost_rappen`, accumulated-depreciation accounts sum
 * `delta_accum_depr_rappen`. Assets contributing 0 (e.g. disposed before the cut-off) are dropped so the
 * drill-down shows only what still sits on the account.
 */
function subLedgerAssets(ctx: WorkspaceContext, accountId: string, cutOff: string, role: Role): ReconAsset[] {
  const column = role === 'cost' ? 'gl_asset_account_id' : 'gl_accum_depr_account_id';
  const deltaCol = role === 'cost' ? 'delta_cost_rappen' : 'delta_accum_depr_rappen';
  const rows = ctx.store.db
    .prepare(
      `SELECT a.id AS asset_id, a.number AS asset_number, a.name AS name,
              COALESCE(SUM(t.${deltaCol}), 0) AS amount
         FROM asset a
         LEFT JOIN asset_transaction t
           ON t.workspace_id = a.workspace_id AND t.asset_id = a.id AND t.date <= ?
        WHERE a.workspace_id = ? AND a.${column} = ?
        GROUP BY a.id, a.number, a.name
        ORDER BY a.number`,
    )
    .all(cutOff, ctx.workspaceId, accountId) as {
    asset_id: string;
    asset_number: string;
    name: string;
    amount: number;
  }[];
  return rows
    .map((r) => ({ assetId: r.asset_id, assetNumber: r.asset_number, name: r.name, amountRappen: r.amount }))
    .filter((r) => r.amountRappen !== 0);
}

/** Build the reconciliation for every control account of a role. */
function reconcileRole(
  ctx: WorkspaceContext,
  column: string,
  role: Role,
  cutOff: string,
  filter: Set<string> | null,
): ReconAccount[] {
  const out: ReconAccount[] = [];
  for (const accountId of controlAccounts(ctx, column)) {
    if (filter !== null && !filter.has(accountId)) continue;
    const meta = accountMeta(ctx, accountId);
    const assets = subLedgerAssets(ctx, accountId, cutOff, role);
    const subLedger = assets.reduce((s, a) => s + a.amountRappen, 0);
    const gl = glBalance(ctx, accountId, cutOff, role);
    const delta = subLedger - gl;
    out.push({
      accountId,
      accountNumber: meta.number,
      accountName: meta.name,
      role,
      subLedgerRappen: subLedger,
      glBalanceRappen: gl,
      deltaRappen: delta,
      status: delta === 0 ? 'balanced' : 'drift',
      assets,
    });
  }
  return out;
}

export interface ReconciliationReportInput {
  period?: string;
  asOf?: string;
  accountIds?: string[];
}

/**
 * US-H07.2 / US-H07.4: the full reconciliation report at a cut-off. One row per control account (cost and
 * accumulated-depreciation), each with its sub-ledger total, its GL balance, the delta (0 when balanced),
 * a `balanced`|`drift` status and the contributing-asset drill-down. The summary counts the balanced and
 * drifting accounts and the overall status.
 */
export function assetReconciliationReport(ctx: WorkspaceContext, input: ReconciliationReportInput): Result {
  const resolved = resolveCutOff(ctx, input);
  if ('ok' in resolved) return resolved;
  const { cutOff, period } = resolved;

  let filter: Set<string> | null = null;
  if (input.accountIds !== undefined) {
    if (!Array.isArray(input.accountIds) || input.accountIds.some((a) => typeof a !== 'string')) {
      return err('invalid_input', { field: 'accountIds' });
    }
    filter = new Set(input.accountIds);
  }

  const accounts = [
    ...reconcileRole(ctx, 'gl_asset_account_id', 'cost', cutOff, filter),
    ...reconcileRole(ctx, 'gl_accum_depr_account_id', 'accumulated_depreciation', cutOff, filter),
  ].sort((a, b) => a.accountNumber.localeCompare(b.accountNumber) || a.role.localeCompare(b.role));

  const driftCount = accounts.filter((a) => a.status === 'drift').length;
  const balancedCount = accounts.length - driftCount;

  return ok({
    cutOff,
    period,
    accounts,
    summary: {
      accountCount: accounts.length,
      balancedCount,
      driftCount,
      status: driftCount === 0 ? 'balanced' : 'drift',
    },
  });
}

export interface ReconciliationCheckInput {
  period?: string;
}

/**
 * US-H07.3: the HARD check period-close (and agents) invoke. It reconciles the whole workspace at the
 * period end and returns `{ status: 'balanced', accounts }` when every account nets to 0, or the structured
 * `reconciliation_drift` error naming the offending accounts and amounts when any does not. Period close
 * may proceed only on the balanced answer; a drift blocks the hard lock until it is explained or corrected
 * through the ordinary reversing + correcting flow.
 */
export function assetReconciliationCheck(ctx: WorkspaceContext, input: ReconciliationCheckInput): Result {
  if (typeof input.period !== 'string' || !PERIOD.test(input.period)) {
    return err('invalid_input', { field: 'period' });
  }
  const report = assetReconciliationReport(ctx, { period: input.period });
  if (!report.ok) return report;

  const accounts = report.accounts as ReconAccount[];
  const drift = accounts.filter((a) => a.status === 'drift');
  if (drift.length > 0) {
    return err('reconciliation_drift', {
      period: input.period,
      cutOff: report.cutOff,
      accounts: drift.map((a) => ({
        accountId: a.accountId,
        accountNumber: a.accountNumber,
        accountName: a.accountName,
        role: a.role,
        subLedgerRappen: a.subLedgerRappen,
        glBalanceRappen: a.glBalanceRappen,
        deltaRappen: a.deltaRappen,
      })),
    });
  }
  return ok({ status: 'balanced', period: input.period, cutOff: report.cutOff, accounts });
}
