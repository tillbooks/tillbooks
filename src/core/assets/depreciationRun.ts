/**
 * H04, the Depreciation RUN & POSTING engine: the controlled, auditable, idempotent period-end process
 * that turns H03's pure calculated amounts into real General-Ledger entries and keeps the asset
 * sub-ledger permanently reconciled with the GL control accounts (OP11, §H-ASSET).
 *
 * H03 CALCULATES (pure, side-effect-free); H04 POSTS. A run is created as a DRAFT (calculate + persist
 * a header and one line per eligible asset), reviewed, and then POSTED once: one balanced A02
 * `postEntry` (Dr depreciation expense / Cr accumulated depreciation) plus, per asset, an append-only
 * `asset_transaction` row (type=depreciation) and the asset's accumulated / NBV / last-period / status
 * advanced. A material error is corrected by REVERSING the run, never by rewriting history.
 *
 * THIS IS THE MONEY PATH, so the invariants are asserted, not decorated:
 *
 *  - IDEMPOTENT ON ROWS (§H-IDEMPOTENT). Create is idempotent on its key AND on the (period, selection)
 *    signature: two creates over the same eligible set yield ONE draft. Post is idempotent on its key
 *    AND on run status: a re-post posts NO second journal and writes NO second asset_transaction. A
 *    replay returns the original objects.
 *  - APPEND-ONLY (§H-AUDIT). The posted journal entry is immutable (A02's triggers), each
 *    `asset_transaction` row is immutable (its own triggers), and each run line is immutable (its own
 *    triggers). A reversal is a NEW reversing journal plus compensating movements, never a destructive
 *    edit.
 *  - BALANCED (§H-LEDGER). Every posting goes through A02 `postEntry`, the one door that balances and
 *    that this engine never bypasses. Debit == credit == the run total, verified by reading the entry
 *    back before the run is marked posted.
 *  - PERIOD-LOCKED (§H-PERIOD). Create and post both refuse a hard-locked period with `period_locked`
 *    and write nothing.
 *  - NEVER BELOW RESIDUAL (§H-ASSET). The amounts come verbatim from H03, which floors at residual and
 *    residual-adjusts the final period; H04 adds no arithmetic of its own beyond summing.
 *  - §H-TENANT on every read and write: a foreign run / asset id resolves to undefined, never its row.
 *
 * ATOMICITY. `postEntry` and the sub-ledger writes run INSIDE one transaction (the acquisition.ts /
 * payment.ts precedent). A failure at any step THROWS `RunAbort`, which rolls the whole transaction
 * back: a rejection leaves neither a journal entry, nor a transaction row, nor a mutated asset, nor a
 * flipped run status. Returning `{ok:false}` from inside `ctx.store.tx` would COMMIT the partial write,
 * so we throw and unwrap.
 */

import { createHash } from 'node:crypto';

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { postEntry } from '../ledger/postEntry.js';
import { reverseEntry } from '../ledger/reverseEntry.js';
import { getEntry } from '../ledger/reads.js';
import { calculateDepreciation, isPeriod, daysInPeriod } from './depreciation/engine.js';
import type { AssetSnapshot, CalcContext } from './depreciation/types.js';

/** The run granularity (§H-ENUM, spec §3). */
const GRANULARITIES: ReadonlySet<string> = new Set(['detailed', 'summarised']);
/** An ISO calendar date `YYYY-MM-DD`, the shape A02 dates already use. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A sanity bound on a period's production figure (one trillion units). Nothing a Swiss KMU makes in
 * a month comes near it; a typo, a millisecond timestamp or a float pasted into the field does. */
const MAX_UNITS_PER_PERIOD = 1_000_000_000_000;

// --- Row shapes (snake_case at the DB boundary) ----------------------------------------------------

interface AssetRow {
  id: string;
  workspace_id: string;
  number: string;
  name: string;
  status: string;
  category_id: string;
  acquisition_date: string;
  acquisition_cost_rappen: number;
  residual_value_rappen: number;
  useful_life_months: number | null;
  depreciation_method: string;
  gl_accum_depr_account_id: string;
  gl_depr_expense_account_id: string;
  accumulated_depr_rappen: number;
  net_book_value_rappen: number;
  last_depreciation_period: string | null;
  declining_rate_bp: number | null;
  total_estimated_units: number | null;
  default_cost_center_id?: string | null;
}

interface RunRow {
  id: string;
  workspace_id: string;
  period: string;
  status: string;
  posting_granularity: string;
  selection_hash: string;
  total_amount_rappen: number;
  asset_count: number;
  journal_entry_id: string | null;
  reversing_journal_entry_id: string | null;
  calculated_at: string;
  posted_at: string | null;
  reversed_at: string | null;
  created_by: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

interface LineRow {
  id: string;
  workspace_id: string;
  run_id: string;
  asset_id: string;
  amount_rappen: number;
  accumulated_before_rappen: number;
  accumulated_after_rappen: number;
  nbv_after_rappen: number;
  is_final: number;
  gl_depr_expense_account_id: string;
  gl_accum_depr_account_id: string;
  cost_center_id: string | null;
  last_period_before: string | null;
  units_produced: number | null;
  created_at: string;
  /** Joined from `asset` by readLines, not a column on the line table. */
  asset_number?: string;
}

function mapRun(row: RunRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    period: row.period,
    status: row.status,
    postingGranularity: row.posting_granularity,
    selectionHash: row.selection_hash,
    totalAmountRappen: row.total_amount_rappen,
    assetCount: row.asset_count,
    journalEntryId: row.journal_entry_id,
    reversingJournalEntryId: row.reversing_journal_entry_id,
    calculatedAt: row.calculated_at,
    postedAt: row.posted_at,
    reversedAt: row.reversed_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLine(row: LineRow) {
  return {
    id: row.id,
    runId: row.run_id,
    assetId: row.asset_id,
    assetNumber: typeof row.asset_number === 'string' ? row.asset_number : null,
    amountRappen: row.amount_rappen,
    accumulatedBeforeRappen: row.accumulated_before_rappen,
    accumulatedAfterRappen: row.accumulated_after_rappen,
    nbvAfterRappen: row.nbv_after_rappen,
    isFinal: row.is_final === 1,
    glDeprExpenseAccountId: row.gl_depr_expense_account_id,
    glAccumDeprAccountId: row.gl_accum_depr_account_id,
    costCenterId: row.cost_center_id,
    // The production figure behind a units_of_production amount, NULL for every other method.
    unitsProduced: typeof row.units_produced === 'number' ? row.units_produced : null,
  };
}

function readRun(ctx: WorkspaceContext, id: string): RunRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM asset_depreciation_run WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as RunRow | undefined;
}

function readLines(ctx: WorkspaceContext, runId: string): LineRow[] {
  // The asset NUMBER travels with the line, joined tenant-scoped on both sides. A line identifies an
  // asset to a bookkeeper by its register number, not by `asset_1`, and `skipped[]` already carries
  // one: the review table and the skipped table must speak the same language.
  //
  // ORDER BY the NUMBER, which is also what the selection is built by. Every line of a run is inserted
  // with the same `now`, and a production id is `prefix_${randomUUID()}`, so ordering by
  // (created_at, id) ordered a run's lines RANDOMLY in production while looking perfectly stable in
  // tests, whose id generator is monotonic. `l.id` stays only as a deterministic tie-break.
  return ctx.store.db
    .prepare(
      `SELECT l.*, a.number AS asset_number
         FROM asset_depreciation_line l
         JOIN asset a ON a.id = l.asset_id AND a.workspace_id = l.workspace_id
        WHERE l.workspace_id = ? AND l.run_id = ?
        ORDER BY a.number, l.id`,
    )
    .all(ctx.workspaceId, runId) as LineRow[];
}

function readAsset(ctx: WorkspaceContext, id: string): AssetRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM asset WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as AssetRow | undefined;
}

function toSnapshot(row: AssetRow): AssetSnapshot {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    status: row.status,
    acquisitionDate: row.acquisition_date,
    acquisitionCostRappen: row.acquisition_cost_rappen,
    residualValueRappen: row.residual_value_rappen,
    usefulLifeMonths: row.useful_life_months,
    depreciationMethod: row.depreciation_method,
    decliningRateBp: typeof row.declining_rate_bp === 'number' ? row.declining_rate_bp : null,
    totalEstimatedUnits: typeof row.total_estimated_units === 'number' ? row.total_estimated_units : null,
    accumulatedDeprRappen: row.accumulated_depr_rappen,
    netBookValueRappen: row.net_book_value_rappen,
    lastDepreciationPeriod: row.last_depreciation_period,
  };
}

/** The last day of a period as an ISO date, the default posting date (§4). `2026-07` -> `2026-07-31`. */
function endOfPeriod(period: string): string {
  return `${period}-${String(daysInPeriod(period)).padStart(2, '0')}`;
}

/** The first day of a period as an ISO date. `2026-07` -> `2026-07-01`. The chronology floor: a run's
 * journal and its sub-ledger movements belong to the period the run names, never before it. */
function startOfPeriod(period: string): string {
  return `${period}-01`;
}

/** The latest acquisition date across the assets a run's lines name. The second chronology floor: a
 * depreciation charge cannot be booked before the asset it depreciates was acquired, which would leave
 * the register's movement history non-chronological. Returns null when no line resolves. */
function latestAcquisitionDate(ctx: WorkspaceContext, assetIds: string[]): string | null {
  if (assetIds.length === 0) return null;
  const row = ctx.store.db
    .prepare(
      `SELECT MAX(acquisition_date) AS d FROM asset WHERE workspace_id = ? AND id IN (${assetIds.map(() => '?').join(', ')})`,
    )
    .get(ctx.workspaceId, ...assetIds) as { d: string | null } | undefined;
  return typeof row?.d === 'string' ? row.d : null;
}

/**
 * The eligible register for a run (spec §4). A method-`none` asset, a disposed / archived asset, one
 * already at residual, or one whose last depreciation is not before the target period is excluded; the
 * optional cost-centre / category / explicit-id filters narrow it further. Ordered by number so the
 * selection hash and the review table are deterministic.
 */
function eligibleAssets(
  ctx: WorkspaceContext,
  period: string,
  filter: { assetIds?: string[]; costCenterId?: string; categoryId?: string },
): { rows: AssetRow[]; skipped: SkippedAsset[] } | { error: Result } {
  const named = filter.assetIds !== undefined;
  let rows: AssetRow[];
  if (filter.assetIds !== undefined) {
    rows = [];
    for (const id of filter.assetIds) {
      const row = readAsset(ctx, id);
      if (row === undefined) return { error: err('not_found', { assetId: id }) }; // §H-TENANT: no leak.
      rows.push(row);
    }
  } else {
    const clauses = ['workspace_id = ?', "status NOT IN ('draft', 'disposed', 'archived')"];
    const params: unknown[] = [ctx.workspaceId];
    if (filter.categoryId !== undefined) {
      clauses.push('category_id = ?');
      params.push(filter.categoryId);
    }
    rows = ctx.store.db
      .prepare(`SELECT * FROM asset WHERE ${clauses.join(' AND ')} ORDER BY number`)
      .all(...params) as AssetRow[];
  }

  /** Why this asset cannot be charged this period, or null when it can. The order matters: the first
   * true statement about the asset is the one the operator is told. */
  const ineligibleReason = (a: AssetRow): string | null => {
    if (a.depreciation_method === 'none') return 'non_depreciable';
    if (a.status === 'disposed' || a.status === 'archived' || a.status === 'draft') return 'asset_terminal';
    if (a.accumulated_depr_rappen >= a.acquisition_cost_rappen - a.residual_value_rappen) return 'already_at_residual';
    if (a.last_depreciation_period !== null && period <= a.last_depreciation_period) return 'period_already_processed';
    if (filter.categoryId !== undefined && a.category_id !== filter.categoryId) return 'filtered_out';
    // Cost-centre filter: an asset's cost centre is its category's default (there is no per-asset cost
    // centre column), so a run restricted to a cost centre keeps only assets whose category books there.
    if (filter.costCenterId !== undefined && costCenterFor(ctx, a.category_id) !== filter.costCenterId) return 'filtered_out';
    return null;
  };

  const eligible: AssetRow[] = [];
  const skipped: SkippedAsset[] = [];
  for (const a of rows) {
    const reason = ineligibleReason(a);
    if (reason === null) {
      eligible.push(a);
      continue;
    }
    // NAMING an asset is an instruction about that asset, so its absence from the run has to be
    // accounted for: the pre-filter used to drop it before the engine ever saw it, which put the
    // silent skip back one step and made three of the reasons the tool text advertises structurally
    // unreachable. A SWEEP is different: there the eligible register IS the selection, and reporting
    // every archived or fully-depreciated asset in the register every period would bury the two rows
    // that matter under three hundred that do not.
    if (named) skipped.push({ assetId: a.id, assetNumber: a.number, reason });
  }
  return { rows: eligible, skipped };
}

/** The cost centre a line posts against: the asset's category default when one exists, else none. Read
 * defensively because `default_cost_center_id` lives on the category, not the asset. */
function costCenterFor(ctx: WorkspaceContext, categoryId: string): string | null {
  const row = ctx.store.db
    .prepare('SELECT default_cost_center_id FROM asset_category WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, categoryId) as { default_cost_center_id: string | null } | undefined;
  const cc = row?.default_cost_center_id;
  return typeof cc === 'string' && cc.length > 0 ? cc : null;
}

/**
 * A deterministic signature of a run's selection: the filters plus the exact eligible asset set (their
 * ids AND the amount each would post). Two creates over the same reality collide on this, which is what
 * makes create idempotent on the selection as well as on the key (§4 concurrency).
 */
function selectionHash(
  period: string,
  granularity: string,
  filter: { assetIds?: string[]; costCenterId?: string; categoryId?: string },
  lines: { assetId: string; amountRappen: number; unitsProduced: number | null }[],
): string {
  const payload = JSON.stringify({
    period,
    granularity,
    costCenterId: filter.costCenterId ?? null,
    categoryId: filter.categoryId ?? null,
    assetIdsFilter: filter.assetIds ? [...filter.assetIds].sort() : null,
    // The production figures are part of the selection, not a detail of it: a corrected figure
    // describes a different reality and must be a NEW run, never mistaken for a replay. They enter
    // through the LINES, which carry the figure actually used and persisted. Hashing the raw input
    // map instead defeated the guard: an id belonging to nobody, or a figure for a straight-line
    // asset that the engine discards, changed the signature while changing nothing about the run,
    // so two creates over the same eligible set produced two live drafts and the caller met
    // stale_draft at post time where run_already_posted was the honest answer.
    lines: [...lines].sort((a, b) => (a.assetId < b.assetId ? -1 : 1)),
  });
  return createHash('sha256').update(payload).digest('hex');
}

/** Abort the write transaction with a structured cause, so nothing is committed or memoised on a
 * rejection discovered after the transaction opened (the acquisition.ts `AcquisitionAbort` shape). */
class RunAbort {
  constructor(public readonly result: Result) {}
}

function runGuarded(body: () => Result): Result {
  try {
    return body();
  } catch (e) {
    if (e instanceof RunAbort) return e.result;
    throw e;
  }
}

// --- Create ----------------------------------------------------------------------------------------

export interface RunCreateInput {
  period?: string;
  assetIds?: unknown;
  costCenterId?: string;
  categoryId?: string;
  postingGranularity?: string;
  /** assetId -> units produced this period, for `units_of_production` assets. Same shape as the H03
   * preview verb's `unitsByAsset`, so a preview and the run it becomes take the identical map. */
  unitsByAsset?: unknown;
  idempotencyKey?: string;
}

/** An eligible asset that produced NO line, and why. The engine's reason verbatim, so the answer is
 * always the engine's, never a guess. Returned on every create: an asset that drops out of a run is a
 * fact the operator has to see, and the silent `continue` that used to do this was the defect. */
interface SkippedAsset {
  assetId: string;
  assetNumber: string;
  reason: string;
}

export function assetDepreciationRunCreate(ctx: WorkspaceContext, input: RunCreateInput): Result {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  // Replay a completed create BEFORE any state-dependent guard (§H-IDEMPOTENT), so a retry returns the
  // original draft instead of tripping run_already_exists on the run it itself wrote.
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'asset_depreciation_run_create');
  if (replayed !== undefined) return replayed;

  if (!isPeriod(input.period)) return err('invalid_period', { period: input.period });
  const period = input.period as string;

  const granularity =
    typeof input.postingGranularity === 'string' && input.postingGranularity.length > 0
      ? input.postingGranularity
      : 'detailed';
  if (!GRANULARITIES.has(granularity)) {
    return err('invalid_input', { field: 'postingGranularity', allowed: [...GRANULARITIES] });
  }

  let assetIds: string[] | undefined;
  if (input.assetIds !== undefined) {
    if (!Array.isArray(input.assetIds)) return err('invalid_input', { field: 'assetIds' });
    assetIds = [];
    for (const raw of input.assetIds) {
      if (typeof raw !== 'string' || raw.length === 0) return err('invalid_input', { field: 'assetIds' });
      assetIds.push(raw);
    }
  }
  const filter = {
    ...(assetIds !== undefined ? { assetIds } : {}),
    ...(typeof input.costCenterId === 'string' && input.costCenterId.length > 0 ? { costCenterId: input.costCenterId } : {}),
    ...(typeof input.categoryId === 'string' && input.categoryId.length > 0 ? { categoryId: input.categoryId } : {}),
  };

  // The period's production figures. Whole units only and never negative: the engine multiplies them
  // in exact BigInt arithmetic, where a fractional value THROWS rather than rounding, so a bad figure
  // is rejected at the boundary instead of crashing the calculation. Zero is a legitimate statement
  // (nothing was produced), not an error.
  const unitsByAsset: Record<string, number> = {};
  if (input.unitsByAsset !== undefined) {
    if (input.unitsByAsset === null || typeof input.unitsByAsset !== 'object' || Array.isArray(input.unitsByAsset)) {
      return err('invalid_input', { field: 'unitsByAsset' });
    }
    for (const [assetId, raw] of Object.entries(input.unitsByAsset as Record<string, unknown>)) {
      // isSafeInteger, not isInteger: `Number.isInteger(1e300)` is TRUE, so 1e300, 1e21 and
      // MAX_VALUE all passed and then sat in the INTEGER `units_produced` audit column as a float
      // (`typeof` = 'real'). The money was never at risk, because the charge clamps at the remaining
      // base, but a money-path audit column the tool text calls "whole units" must hold whole units.
      // The cap is a sanity bound far above any real production figure, not an accounting limit.
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || raw > MAX_UNITS_PER_PERIOD) {
        return err('invalid_input', { field: 'unitsByAsset', assetId, unitsProduced: raw, max: MAX_UNITS_PER_PERIOD });
      }
      unitsByAsset[assetId] = raw;
    }
  }

  // §H-PERIOD, checked BEFORE the write opens so a locked period rejects with nothing half-done. A
  // period is checked at its last day, the same date the post will book at by default.
  const periodOpen = ctx.periods.assertOpen(endOfPeriod(period));
  if (!periodOpen.ok) return periodOpen;

  const elig = eligibleAssets(ctx, period, filter);
  if ('error' in elig) return elig.error;

  // Calculate each eligible asset's amount verbatim from the H03 engine; keep only amount > 0. An
  // asset that yields nothing is RECORDED with the engine's own reason and returned to the caller: it
  // used to be dropped by a bare `continue`, which is how a units_of_production asset could sit in a
  // register for years, be selected by every run, and never once be depreciated or mentioned.
  const planned: {
    asset: AssetRow;
    amount: number;
    accumBefore: number;
    accumAfter: number;
    nbvAfter: number;
    isFinal: boolean;
    unitsProduced: number | null;
  }[] = [];
  // Seeded with the assets the SELECTION filtered out (explicit lists only, see eligibleAssets), then
  // extended with the ones the engine returned nothing for. Both are answers the caller must get.
  const skipped: SkippedAsset[] = [...elig.skipped];
  for (const asset of elig.rows) {
    const units = unitsByAsset[asset.id];
    const calcCtx: CalcContext = { period };
    if (units !== undefined) calcCtx.unitsProduced = units;
    const res = calculateDepreciation(toSnapshot(asset), calcCtx);
    if (res.amountRappen <= 0) {
      // The engine says `missing_production_data` for TWO different absences, and pointing an
      // operator at the figure they just supplied is no answer. If the master carries no
      // `totalEstimatedUnits` there is no denominator to allocate over, and that is what has to be
      // fixed, on the asset rather than on the run. (Split here, not in the engine: H03's reason
      // vocabulary is its own published contract.)
      const reason =
        res.reason === 'missing_production_data' && !(typeof asset.total_estimated_units === 'number' && asset.total_estimated_units > 0)
          ? 'missing_units_estimate'
          : (res.reason ?? 'zero_amount');
      // An asset the caller NAMED cannot be quietly reported: naming it is an instruction to
      // depreciate it, and both of these are input errors the caller can fix, so say so and write
      // nothing. A sweep keeps running for everything else and reports this one in `skipped`.
      if (assetIds !== undefined && reason === 'missing_production_data') {
        return err('missing_production_data', { assetId: asset.id, assetNumber: asset.number, period });
      }
      if (assetIds !== undefined && reason === 'missing_units_estimate') {
        return err('missing_units_estimate', {
          assetId: asset.id,
          assetNumber: asset.number,
          field: 'totalEstimatedUnits',
          period,
        });
      }
      skipped.push({ assetId: asset.id, assetNumber: asset.number, reason });
      continue;
    }
    planned.push({
      asset,
      amount: res.amountRappen,
      accumBefore: asset.accumulated_depr_rappen,
      accumAfter: asset.accumulated_depr_rappen + res.amountRappen,
      nbvAfter: res.projectedNbvAfterRappen,
      isFinal: res.isFinal,
      unitsProduced: asset.depreciation_method === 'units_of_production' && units !== undefined ? units : null,
    });
  }

  // NOTHING TO CHARGE: answer, and persist NOTHING.
  //
  // A run with no lines is not an accounting fact. It posts no journal, it moves no asset, and it can
  // never be posted (`empty_run`), so the only thing a persisted empty header ever did was lie: it
  // occupied the period's empty-selection signature, so the NEXT create collided with it and came
  // back `run_already_exists` pointing at a phantom draft that could be neither reviewed nor posted,
  // and it sat in `run_list` for ever, telling the period-close checklist that a finished period had
  // an outstanding draft. Both consequences outlive the session, and neither is fixable afterwards,
  // because a run header is append-only by design.
  //
  // So the empty answer is computed fresh every time and stored nowhere. Two creates over a finished
  // period are then identical BY CONSTRUCTION rather than by a special case, on the tenth call as on
  // the first, whatever key each one carries.
  if (planned.length === 0) {
    // Why this period is finished, when it is: a posted run stamped its own period on every asset it
    // charged, so those assets stopped being eligible. Name the run that did the work rather than
    // leaving the caller to infer it from an empty list. Two disjoint selections can both post for
    // one period, so this is explicitly the MOST RECENT one, ordered deterministically.
    const postedRunForPeriod = (
      ctx.store.db
        .prepare(
          "SELECT id FROM asset_depreciation_run WHERE workspace_id = ? AND period = ? AND status = 'posted' ORDER BY posted_at DESC, id DESC LIMIT 1",
        )
        .get(ctx.workspaceId, period) as { id: string } | undefined
    )?.id;
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'asset_depreciation_run_create', () =>
      ok({
        run: null,
        lines: [],
        empty: true,
        skipped,
        ...(postedRunForPeriod !== undefined ? { alreadyPostedRunId: postedRunForPeriod } : {}),
      }),
    );
  }

  const hash = selectionHash(
    period,
    granularity,
    filter,
    planned.map((p) => ({ assetId: p.asset.id, amountRappen: p.amount, unitsProduced: p.unitsProduced })),
  );

  // A non-reversed run for the same (period, selection) already exists: posted -> run_already_posted;
  // draft -> run_already_exists (the caller should read it via get/list). The partial unique index is
  // the race guard underneath. A different selection (a late acquisition changed the set) hashes
  // differently and is a legitimately new run.
  //
  // NOTE on run_already_posted: it is kept as a guard but is not reachable in practice, and the tool
  // text does not advertise it. Posting stamps every charged asset's last_depreciation_period, so a
  // create over the same selection afterwards finds nothing eligible and returns above, before this
  // lookup is ever reached.
  const existing = ctx.store.db
    .prepare(
      "SELECT * FROM asset_depreciation_run WHERE workspace_id = ? AND period = ? AND selection_hash = ? AND status != 'reversed' LIMIT 1",
    )
    .get(ctx.workspaceId, period, hash) as RunRow | undefined;
  if (existing !== undefined) {
    if (existing.status === 'posted') return err('run_already_posted', { runId: existing.id, period });
    return err('run_already_exists', { runId: existing.id, period });
  }

  const total = planned.reduce((s, p) => s + p.amount, 0);

  const run = (): Result => {
    const runId = ctx.ids.next('adrun');
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO asset_depreciation_run (
           id, workspace_id, period, status, posting_granularity, selection_hash,
           total_amount_rappen, asset_count, journal_entry_id, reversing_journal_entry_id,
           calculated_at, posted_at, reversed_at, created_by, idempotency_key, created_at, updated_at
         ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        ctx.workspaceId,
        period,
        granularity,
        hash,
        total,
        planned.length,
        now,
        ctx.actor,
        input.idempotencyKey,
        now,
        now,
      );
    for (const p of planned) {
      const cc = costCenterFor(ctx, p.asset.category_id);
      ctx.store.db
        .prepare(
          `INSERT INTO asset_depreciation_line (
             id, workspace_id, run_id, asset_id, amount_rappen, accumulated_before_rappen,
             accumulated_after_rappen, nbv_after_rappen, is_final, gl_depr_expense_account_id,
             gl_accum_depr_account_id, cost_center_id, last_period_before, units_produced, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ctx.ids.next('adline'),
          ctx.workspaceId,
          runId,
          p.asset.id,
          p.amount,
          p.accumBefore,
          p.accumAfter,
          p.nbvAfter,
          p.isFinal ? 1 : 0,
          p.asset.gl_depr_expense_account_id,
          p.asset.gl_accum_depr_account_id,
          cc,
          p.asset.last_depreciation_period,
          p.unitsProduced,
          now,
        );
    }
    return ok({
      run: mapRun(readRun(ctx, runId) as RunRow),
      lines: readLines(ctx, runId).map(mapLine),
      // Always present and always false here: a persisted run has at least one line, by construction.
      // The field stays on both shapes so a caller reads one flag rather than two response schemas.
      empty: false,
      // Every asset that produced no line, with its reason. Never omitted, so a caller that ignores
      // it is choosing to, rather than never being told.
      skipped,
    });
  };

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'asset_depreciation_run_create', run);
}

// --- Post ------------------------------------------------------------------------------------------

export interface RunPostInput {
  runId?: string;
  postingDate?: string;
  idempotencyKey?: string;
}

export function assetDepreciationRunPost(ctx: WorkspaceContext, input: RunPostInput): Result {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'asset_depreciation_run_post');
  if (replayed !== undefined) return replayed;

  if (typeof input.runId !== 'string' || input.runId.length === 0) {
    return err('invalid_input', { field: 'runId' });
  }
  const runRow = readRun(ctx, input.runId);
  if (runRow === undefined) return err('not_found', { runId: input.runId });

  // Idempotent on STATUS as well as on the key: an already-posted run returns its posted result so a
  // double-post never double-counts (the money-path guarantee), and a reversed run cannot be posted.
  if (runRow.status === 'posted') {
    return ok({ run: mapRun(runRow), journalEntryId: runRow.journal_entry_id, lines: readLines(ctx, runRow.id).map(mapLine) });
  }
  if (runRow.status === 'reversed') return err('run_reversed', { runId: input.runId });

  const lines = readLines(ctx, runRow.id);
  if (lines.length === 0) return err('empty_run', { runId: input.runId });

  const explicitDate = typeof input.postingDate === 'string' && input.postingDate.length > 0;
  const postingDate = explicitDate ? (input.postingDate as string).trim() : endOfPeriod(runRow.period);
  if (!ISO_DATE.test(postingDate)) return err('invalid_input', { field: 'postingDate' });

  // CHRONOLOGY. A shape check alone let a 2026-02 run book at 2019-01-01, ahead of the acquisition, so
  // the register's movement history read backwards. The charge may land later than its period (a
  // deliberate late close), never earlier than the period it charges, and an EXPLICIT date may not
  // predate the acquisition of any asset in the run either. The default (the last day of the period) is
  // left alone: it is derived, so it can never be the operator's mistake.
  if (postingDate < startOfPeriod(runRow.period)) {
    return err('invalid_input', { field: 'postingDate', reason: 'before_period', period: runRow.period });
  }
  if (explicitDate) {
    const acquired = latestAcquisitionDate(ctx, lines.map((l) => l.asset_id));
    if (acquired !== null && postingDate < acquired) {
      return err('invalid_input', { field: 'postingDate', reason: 'before_acquisition', acquisitionDate: acquired });
    }
  }

  // §H-PERIOD, checked BEFORE the write opens so a locked period rejects with nothing written. BOTH
  // dates are checked, and that is the point: the charge belongs to the RUN'S OWN period no matter
  // where the journal lands. The sub-ledger row, the asset's last_depreciation_period and the register
  // all record `runRow.period`, so checking only the posting date would let a posting date in an open
  // year slip a charge into a legally sealed one and break the OP11 sub-ledger-to-GL reconciliation
  // (US-H04.4: a hard-locked target period refuses both create and post, and writes nothing).
  const runPeriodOpen = ctx.periods.assertOpen(endOfPeriod(runRow.period));
  if (!runPeriodOpen.ok) return runPeriodOpen;
  const periodOpen = ctx.periods.assertOpen(postingDate);
  if (!periodOpen.ok) return periodOpen;

  return runGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'asset_depreciation_run_post', () => {
      // STALE-DRAFT re-check (§4, US-H04.6): the amounts were fixed at draft time. If any asset's
      // accumulated depreciation has moved since (another run posted, a correction), or it is no longer
      // eligible, the draft no longer describes reality and MUST NOT post. Recompute would silently
      // change filed figures; instead we refuse and the user recreates.
      for (const line of lines) {
        const asset = readAsset(ctx, line.asset_id);
        if (asset === undefined) throw new RunAbort(err('stale_draft', { runId: runRow.id, assetId: line.asset_id, reason: 'asset_missing' }));
        if (asset.status === 'disposed' || asset.status === 'archived') {
          throw new RunAbort(err('stale_draft', { runId: runRow.id, assetId: line.asset_id, reason: 'asset_terminal' }));
        }
        if (asset.accumulated_depr_rappen !== line.accumulated_before_rappen) {
          throw new RunAbort(err('stale_draft', { runId: runRow.id, assetId: line.asset_id, reason: 'accumulated_moved' }));
        }
        // VALUATION, not just accumulated depreciation. `nbv_after + amount` is the net book value the
        // draft was computed against, so this catches any movement in the asset's VALUE, whichever path
        // caused it. H02's `asset_add_capitalisation` is the shipped one: it raises acquisition cost AND
        // net book value and leaves accumulated depreciation alone, so it sailed through the check above,
        // and the post then wrote `net_book_value_rappen` from a figure computed against the pre-
        // capitalisation cost. The register carried an NBV the GL contradicted (§4's own identity,
        // `net_book_value == acquisition_cost - accumulated`, broken), the OP11 reconciliation opened a
        // hole the size of the capitalisation, and it compounded: the next draft read the corrupt NBV,
        // and on declining balance the CHARGE itself was then wrong. Written as a valuation check rather
        // than a cost check on purpose, so a future path that moves value some other way trips it too.
        if (asset.net_book_value_rappen !== line.nbv_after_rappen + line.amount_rappen) {
          throw new RunAbort(err('stale_draft', { runId: runRow.id, assetId: line.asset_id, reason: 'valuation_moved' }));
        }
      }

      // Build the balanced journal. Detailed: Dr expense / Cr accum per line. Summarised: collapse
      // identical (expense-account + cost-centre) and (accum-account + cost-centre) combinations. Either
      // way the per-asset asset_depreciation_line rows already exist for the sub-ledger audit.
      const journalLines = buildJournalLines(runRow.posting_granularity, lines);

      const posted = postEntry(ctx, {
        date: postingDate,
        source: 'asset_depreciation',
        description: `Abschreibung ${runRow.period}`,
        ref: runRow.id,
        idempotencyKey: JSON.stringify(['asset_depreciation_entry', runRow.id]),
        lines: journalLines,
      });
      if (!posted.ok) throw new RunAbort(posted);
      const entryId = posted.entryId;

      // Trust nothing, including our own posting path: read the entry back and assert debit == credit ==
      // the run total. This is the check that turns "the post is balanced" into one that bites.
      const check = getEntry(ctx, { entryId });
      if (!check.ok) throw new RunAbort(check);
      const debit = check.lines.reduce((s, l) => s + l.debit, 0);
      const credit = check.lines.reduce((s, l) => s + l.credit, 0);
      if (debit !== credit || debit !== runRow.total_amount_rappen) {
        throw new RunAbort(err('posting_verification_failed', { entryId, reason: 'unbalanced_or_wrong_total' }));
      }

      const now = ctx.clock.now();
      for (const line of lines) {
        const asset = readAsset(ctx, line.asset_id) as AssetRow;
        // The append-only sub-ledger event: a depreciation row moves accumulated depreciation, not cost.
        const txnId = ctx.ids.next('atxn');
        ctx.store.db
          .prepare(
            `INSERT INTO asset_transaction (
               id, workspace_id, asset_id, type, date, delta_cost_rappen, delta_accum_depr_rappen,
               proceeds_rappen, gain_loss_rappen, journal_entry_id, source_document_type,
               source_document_id, description, created_at, created_by, idempotency_key
             ) VALUES (?, ?, ?, 'depreciation', ?, 0, ?, NULL, NULL, ?, NULL, NULL, ?, ?, ?, ?)`,
          )
          .run(
            txnId,
            ctx.workspaceId,
            line.asset_id,
            postingDate,
            line.amount_rappen,
            entryId,
            `Abschreibung ${runRow.period}`,
            now,
            ctx.actor,
            `${runRow.id}:${line.asset_id}`,
          );

        // Advance the asset's convenience columns: accumulated rises to the line's accumulated_after,
        // NBV = cost - accumulated, last period is this run's period, and a final line lands the asset
        // in fully_depreciated. accumulated_after / nbv_after came from H03 (never below residual).
        const newStatus = line.is_final === 1 ? 'fully_depreciated' : asset.status;
        ctx.store.db
          .prepare(
            `UPDATE asset SET accumulated_depr_rappen = ?, net_book_value_rappen = ?,
                    last_depreciation_period = ?, status = ?, updated_at = ?
               WHERE workspace_id = ? AND id = ?`,
          )
          .run(line.accumulated_after_rappen, line.nbv_after_rappen, runRow.period, newStatus, now, ctx.workspaceId, line.asset_id);

        ctx.audit.record({ entityKind: 'asset_transaction', entityId: txnId, action: 'post', actor: ctx.actor, at: now });
      }

      // Advance the run to posted. Only status + the journal link + posted_at change (the run
      // status-only trigger enforces exactly this).
      ctx.store.db
        .prepare(
          "UPDATE asset_depreciation_run SET status = 'posted', journal_entry_id = ?, posted_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
        )
        .run(entryId, now, now, ctx.workspaceId, runRow.id);

      return ok({
        run: mapRun(readRun(ctx, runRow.id) as RunRow),
        journalEntryId: entryId,
        lines: readLines(ctx, runRow.id).map(mapLine),
      });
    }),
  );
}

/** The balanced journal lines for a run. Detailed keeps one Dr/Cr pair per asset; summarised collapses
 * identical (account + cost-centre) legs so the GL carries one line per account combination while the
 * sub-ledger keeps the per-asset detail. */
function buildJournalLines(
  granularity: string,
  lines: LineRow[],
): { account: string; debit?: number; credit?: number; costCenter?: string }[] {
  if (granularity !== 'summarised') {
    const out: { account: string; debit?: number; credit?: number; costCenter?: string }[] = [];
    for (const l of lines) {
      const cc = l.cost_center_id !== null ? { costCenter: l.cost_center_id } : {};
      out.push({ account: l.gl_depr_expense_account_id, debit: l.amount_rappen, ...cc });
      out.push({ account: l.gl_accum_depr_account_id, credit: l.amount_rappen, ...cc });
    }
    return out;
  }
  // Summarised: sum debits by (expense account, cost centre) and credits by (accum account, cost centre).
  const debitByKey = new Map<string, { account: string; costCenter: string | null; amount: number }>();
  const creditByKey = new Map<string, { account: string; costCenter: string | null; amount: number }>();
  for (const l of lines) {
    const dk = `${l.gl_depr_expense_account_id}|${l.cost_center_id ?? ''}`;
    const ck = `${l.gl_accum_depr_account_id}|${l.cost_center_id ?? ''}`;
    const d = debitByKey.get(dk) ?? { account: l.gl_depr_expense_account_id, costCenter: l.cost_center_id, amount: 0 };
    d.amount += l.amount_rappen;
    debitByKey.set(dk, d);
    const c = creditByKey.get(ck) ?? { account: l.gl_accum_depr_account_id, costCenter: l.cost_center_id, amount: 0 };
    c.amount += l.amount_rappen;
    creditByKey.set(ck, c);
  }
  const out: { account: string; debit?: number; credit?: number; costCenter?: string }[] = [];
  for (const d of debitByKey.values()) {
    out.push({ account: d.account, debit: d.amount, ...(d.costCenter !== null ? { costCenter: d.costCenter } : {}) });
  }
  for (const c of creditByKey.values()) {
    out.push({ account: c.account, credit: c.amount, ...(c.costCenter !== null ? { costCenter: c.costCenter } : {}) });
  }
  return out;
}

// --- Reverse ---------------------------------------------------------------------------------------

export interface RunReverseInput {
  runId?: string;
  reason?: string;
  reverseDate?: string;
  idempotencyKey?: string;
}

export function assetDepreciationRunReverse(ctx: WorkspaceContext, input: RunReverseInput): Result {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'asset_depreciation_run_reverse');
  if (replayed !== undefined) return replayed;

  if (typeof input.runId !== 'string' || input.runId.length === 0) {
    return err('invalid_input', { field: 'runId' });
  }
  const runRow = readRun(ctx, input.runId);
  if (runRow === undefined) return err('not_found', { runId: input.runId });
  if (runRow.status === 'draft') return err('run_not_posted', { runId: input.runId });
  if (runRow.status === 'reversed') return err('already_reversed', { runId: input.runId });

  const reverseDate =
    typeof input.reverseDate === 'string' && input.reverseDate.length > 0 ? input.reverseDate.trim() : endOfPeriod(runRow.period);
  if (!ISO_DATE.test(reverseDate)) return err('invalid_input', { field: 'reverseDate' });
  // The same chronology floor: a reversal is booked forward (in the period the error was found), never
  // before the charge it reverses.
  if (reverseDate < startOfPeriod(runRow.period)) {
    return err('invalid_input', { field: 'reverseDate', reason: 'before_period', period: runRow.period });
  }

  const periodOpen = ctx.periods.assertOpen(reverseDate);
  if (!periodOpen.ok) return periodOpen;

  // WHY the correction happened is part of the correction. A reversal on the money path without its
  // stated reason leaves the auditor with a mirror entry and no answer, so the operator's words go on
  // BOTH artefacts the reversal creates: the reversing journal entry and the compensating sub-ledger
  // movement. Trimmed and capped so a pasted essay cannot bloat a ledger description; a blank reason
  // adds nothing rather than a dangling separator.
  const reasonText =
    typeof input.reason === 'string' && input.reason.trim().length > 0 ? input.reason.trim().slice(0, 200) : null;
  const reverseDescription =
    reasonText !== null ? `Storno Abschreibung ${runRow.period}: ${reasonText}` : `Storno Abschreibung ${runRow.period}`;

  const lines = readLines(ctx, runRow.id);

  // ORDER. A reversal restores the accumulated depreciation by delta, which is arithmetically right even
  // under a later run, but `last_depreciation_period` correctly stays on the LATER period, and
  // `eligibleAssets` skips any asset whose last period is at or after the target. So reversing February
  // once March has posted leaves February permanently unrecoverable: a re-created February run comes back
  // empty with no error, and a month of depreciation is silently gone. US-H04.5 promises the opposite
  // ("a new run for the same period may be created after the reversal"), so the reversal has to happen in
  // reverse order. Refuse, and NAME the run that blocks so the operator knows what to reverse first.
  for (const line of lines) {
    const asset = readAsset(ctx, line.asset_id);
    if (asset === undefined) return err('not_found', { assetId: line.asset_id });
    if (asset.last_depreciation_period !== null && asset.last_depreciation_period > runRow.period) {
      return err('later_run_exists', {
        runId: runRow.id,
        period: runRow.period,
        assetId: line.asset_id,
        blockingPeriod: asset.last_depreciation_period,
      });
    }
  }

  return runGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'asset_depreciation_run_reverse', () => {
      // The one legal correction: reverse the original journal through A02 (a new mirror entry). The
      // original journal and the original run amounts are never touched (§H-AUDIT).
      const reversed = reverseEntry(ctx, {
        entryId: runRow.journal_entry_id as string,
        date: reverseDate,
        description: reverseDescription,
        idempotencyKey: JSON.stringify(['asset_depreciation_reverse', runRow.id, input.idempotencyKey]),
      });
      if (!reversed.ok) throw new RunAbort(reversed);
      const reversalId = reversed.reversalId;

      const now = ctx.clock.now();
      for (const line of lines) {
        const asset = readAsset(ctx, line.asset_id);
        if (asset === undefined) throw new RunAbort(err('not_found', { assetId: line.asset_id }));
        // Restore by DELTA, not by absolute snapshot, so a reversal is correct even when a LATER run
        // has since advanced the asset: give back exactly the accumulated depreciation this run took.
        const newAccum = asset.accumulated_depr_rappen - line.amount_rappen;
        const newNbv = asset.acquisition_cost_rappen - newAccum;
        // A fully_depreciated asset this reversal lifts back above residual returns to active. Only this
        // run's own last_depreciation_period is rolled back (a later run owns a later period).
        const newStatus =
          asset.status === 'fully_depreciated' && newNbv > asset.residual_value_rappen ? 'active' : asset.status;
        const newLastPeriod =
          asset.last_depreciation_period === runRow.period ? line.last_period_before : asset.last_depreciation_period;

        // The compensating sub-ledger event mirrors the reversing journal, so the register stays
        // reconciled to the GL (OP11): accumulated depreciation moves back by the same amount.
        const txnId = ctx.ids.next('atxn');
        ctx.store.db
          .prepare(
            `INSERT INTO asset_transaction (
               id, workspace_id, asset_id, type, date, delta_cost_rappen, delta_accum_depr_rappen,
               proceeds_rappen, gain_loss_rappen, journal_entry_id, source_document_type,
               source_document_id, description, created_at, created_by, idempotency_key
             ) VALUES (?, ?, ?, 'depreciation_reversal', ?, 0, ?, NULL, NULL, ?, NULL, NULL, ?, ?, ?, ?)`,
          )
          .run(
            txnId,
            ctx.workspaceId,
            line.asset_id,
            reverseDate,
            -line.amount_rappen,
            reversalId,
            reverseDescription,
            now,
            ctx.actor,
            `${runRow.id}:reverse:${line.asset_id}`,
          );

        ctx.store.db
          .prepare(
            `UPDATE asset SET accumulated_depr_rappen = ?, net_book_value_rappen = ?,
                    last_depreciation_period = ?, status = ?, updated_at = ?
               WHERE workspace_id = ? AND id = ?`,
          )
          .run(newAccum, newNbv, newLastPeriod, newStatus, now, ctx.workspaceId, line.asset_id);

        ctx.audit.record({ entityKind: 'asset_transaction', entityId: txnId, action: 'post', actor: ctx.actor, at: now });
      }

      ctx.store.db
        .prepare(
          "UPDATE asset_depreciation_run SET status = 'reversed', reversing_journal_entry_id = ?, reversed_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
        )
        .run(reversalId, now, now, ctx.workspaceId, runRow.id);

      return ok({
        run: mapRun(readRun(ctx, runRow.id) as RunRow),
        reversingJournalEntryId: reversalId,
      });
    }),
  );
}

// --- Reads -----------------------------------------------------------------------------------------

export function assetDepreciationRunGet(ctx: WorkspaceContext, input: { runId?: string }): Result {
  if (typeof input.runId !== 'string' || input.runId.length === 0) {
    return err('invalid_input', { field: 'runId' });
  }
  const runRow = readRun(ctx, input.runId);
  if (runRow === undefined) return err('not_found', { runId: input.runId });
  return ok({ run: mapRun(runRow), lines: readLines(ctx, runRow.id).map(mapLine) });
}

export interface RunListInput {
  period?: string;
  status?: unknown;
  from?: string;
  to?: string;
}

export function assetDepreciationRunList(ctx: WorkspaceContext, input: RunListInput = {}): Result {
  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (typeof input.period === 'string' && input.period.length > 0) {
    clauses.push('period = ?');
    params.push(input.period);
  }
  if (typeof input.status === 'string' && input.status.length > 0) {
    clauses.push('status = ?');
    params.push(input.status);
  } else if (Array.isArray(input.status) && input.status.length > 0) {
    const vals = input.status.filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (vals.length > 0) {
      clauses.push(`status IN (${vals.map(() => '?').join(', ')})`);
      params.push(...vals);
    }
  }
  if (typeof input.from === 'string' && input.from.length > 0) {
    clauses.push('period >= ?');
    params.push(input.from);
  }
  if (typeof input.to === 'string' && input.to.length > 0) {
    clauses.push('period <= ?');
    params.push(input.to);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM asset_depreciation_run WHERE ${clauses.join(' AND ')} ORDER BY period DESC, created_at DESC`)
    .all(...params) as RunRow[];
  return ok({ runs: rows.map(mapRun), total: rows.length });
}

export { DEPRECIATION_RUN_SCHEMA_SQL } from './depreciationRunSchema.js';
