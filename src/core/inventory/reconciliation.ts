/**
 * J06, the inventory valuation RUN and the GL link (OP11 for the Inventory domain). This is the ctx /
 * SQL half; it reads the J03 valuation through its PUBLIC API (`inventoryValuationPreview`) and never
 * reaches into the pure calculators or forks a method. J06 is the ONLY path an inventory valuation
 * figure reaches the General Ledger, and it reaches it through A02 `postEntry` / `reverseEntry` and no
 * second door.
 *
 * THE ONE IDENTITY THIS FILE EXISTS TO HOLD (spec §4, OP11), asserted in
 * `test/inventory/valuation-gl-link.test.mjs`:
 *
 *   after a successful posted valuation for a cut-off, for every inventory control account C:
 *     gl_balance(C, as_of) === subledger_valuation(C, as_of)
 *
 * It holds BY CONSTRUCTION because a run posts the DELTA between what J03 reports and what the GL
 * currently carries: `delta(C) = subledger(C) - gl_balance(C, as_of)`. Whatever C held before (an
 * opening entry, a D01 `stock` run, a prior J06 run, a stray manual posting), the delta closes the gap
 * exactly, so the balance equals the sub-ledger the instant the entry is sealed. A re-run over an
 * unchanged ledger computes delta 0 and posts nothing, which is what makes the value idempotent on top
 * of the row-level §H-IDEMPOTENT guard.
 *
 * THE FIVE MONEY-PATH LAWS, enforced here:
 *   - APPEND-ONLY / §H-AUDIT: a correction is a `reverseEntry` plus a fresh run, never an edit. The
 *     line rows are immutable at the DB layer; a posted run's financial identity is frozen (triggers
 *     in `reconciliationSchema.ts`).
 *   - §H-IDEMPOTENT: a replayed run key returns the cached run and posts nothing; the A02 post carries
 *     its own derived key, so a replayed post mints ONE journal.
 *   - §H-PERIOD: a create or post whose cut-off is in a soft/hard-closed period is refused BEFORE any
 *     write (postEntry re-checks, so this is the early structured refusal, not the only one).
 *   - §H-TENANT: every read and write scopes by workspace_id.
 *   - P2 money: J03 owns the single rounding point; J06 posts the already-integer Rappen it reports and
 *     never re-rounds. A02 receives only balanced integer lines.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result, Err } from '../result.js';

/**
 * An internal computation that either fails with a structured `Err` (which a verb returns verbatim) or
 * carries a typed value. Distinct from `Result<T>` on purpose: `Result` constrains `T` to an object
 * with a string index signature, which the shaped interfaces below deliberately do not have.
 */
type Computed$<T> = { readonly ok: true; readonly value: T } | Err;
import { postEntry } from '../ledger/postEntry.js';
import { reverseEntry } from '../ledger/reverseEntry.js';
import { inventoryValuationPreview, resolveMethodAt } from './valuationPolicy.js';
import { normaliseMethod, VALUATION_METHODS } from './valuation.js';
import type { ValuationMethod } from './valuation.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_RE = /^\d{4}-\d{2}$/;

/** The KMU accounts a valuation adjustment moves by default (spec §4; the D01 convention). */
const DEFAULT_INVENTORY_ACCOUNT = '1200'; // Vorräte Handelswaren (asset control)
const DEFAULT_CHANGE_ACCOUNT = '4200'; // Bestandesänderung / Einkauf Handelswaren

const RUN_SOURCE = 'inventory_valuation';

// --- shapes -------------------------------------------------------------------------------------

interface RunRow {
  id: string;
  workspace_id: string;
  as_of: string;
  period: string | null;
  method: string;
  status: string;
  total_value_rappen: number;
  delta_rappen: number;
  line_count: number;
  journal_entry_id: string | null;
  reversing_journal_entry_id: string | null;
  prior_run_id: string | null;
  filters_json: string | null;
  ledger_fingerprint: string | null;
  notes: string | null;
  is_opening: number;
  idempotency_key: string;
  created_at: string;
  created_by: string | null;
  posted_at: string | null;
  posted_by: string | null;
}

interface LineRow {
  id: string;
  run_id: string;
  item_id: string;
  item_name: string | null;
  location_id: string | null;
  lot_id: string | null;
  serial_id: string | null;
  qty: number;
  unit_cost_rappen: number | null;
  value_rappen: number;
  control_account_id: string;
  market_value_rappen: number | null;
  is_market_write_down: number;
  valuation_basis: string | null;
  reason: string | null;
}

const RUN_COLUMNS = `id, workspace_id, as_of, period, method, status, total_value_rappen, delta_rappen,
  line_count, journal_entry_id, reversing_journal_entry_id, prior_run_id, filters_json,
  ledger_fingerprint, notes, is_opening, idempotency_key, created_at, created_by, posted_at, posted_by`;

const LINE_COLUMNS = `id, run_id, item_id, item_name, location_id, lot_id, serial_id, qty,
  unit_cost_rappen, value_rappen, control_account_id, market_value_rappen, is_market_write_down,
  valuation_basis, reason`;

// --- small helpers ------------------------------------------------------------------------------

function accountIdByNumber(ctx: WorkspaceContext, number: string): string | undefined {
  const row = ctx.store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, number) as { id: string } | undefined;
  return row?.id;
}

function accountExists(ctx: WorkspaceContext, accountId: string): boolean {
  return (
    ctx.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, accountId) !==
    undefined
  );
}

/**
 * The GL balance of one account at a cut-off, in integer Rappen: the signed sum of posted base
 * debits minus base credits for entries dated on or before `asOf` (§H-TENANT). For an asset control
 * account this is the carrying value; the sign convention is debit-positive, which is what the delta
 * math below assumes when it debits the inventory account to RAISE the figure.
 */
function glBalanceAt(ctx: WorkspaceContext, accountId: string, asOf: string): number {
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ? AND l.account_id = ? AND e.status = 'posted' AND e.date <= ?`,
    )
    .get(ctx.workspaceId, accountId, asOf) as { net: number };
  return row.net;
}

/**
 * The last calendar day of a `YYYY-MM` period, for the cut-off of a period-end valuation.
 * `new Date(y, m, 0)` is the previous month's last day, i.e. the last day of month `m` (1-based).
 */
function periodEnd(period: string): string {
  const [y, m] = period.split('-').map((n) => Number.parseInt(n, 10));
  const d = new Date(Date.UTC(y as number, m as number, 0));
  return d.toISOString().slice(0, 10);
}

function periodOf(asOf: string): string {
  return asOf.slice(0, 7);
}

/**
 * A cheap fingerprint of the movement ledger up to a cut-off, for stale-draft detection (US-J06.7).
 * If any movement is added, removed or re-cost between a draft's calculation and its post, this string
 * changes and the post is refused with `stale_draft` rather than posting a figure the operator never
 * reviewed. Scoped by workspace and cut-off, so a later-dated movement never invalidates an older run.
 */
function ledgerFingerprint(ctx: WorkspaceContext, asOf: string): string {
  const row = ctx.store.db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(MAX(created_at), '') AS mx, COALESCE(SUM(qty), 0) AS sq,
              COALESCE(SUM(COALESCE(unit_cost_minor, 0)), 0) AS sc,
              COALESCE(SUM(COALESCE(cost_amount_minor, 0)), 0) AS sa
         FROM stock_movement WHERE workspace_id = ? AND moved_at <= ?`,
    )
    .get(ctx.workspaceId, asOf) as { n: number; mx: string; sq: number; sc: number; sa: number };
  return `${row.n}:${row.mx}:${row.sq}:${row.sc}:${row.sa}`;
}

interface ControlAccounts {
  inventoryAccountId: string;
  changeAccountId: string;
}

/**
 * Resolve the inventory control account (debited to raise the figure) and its counter (the COGS /
 * inventory-change account). Defaults to the KMU `1200` / `4200`; either may be overridden per run,
 * and an overridden account must exist in this workspace (§H-TENANT). A per-item / per-category
 * override is a documented forward seam (no D00 master field exists yet), so every line of a run
 * currently resolves to the one control account, and the journal builder groups by it regardless.
 */
function resolveControlAccounts(
  ctx: WorkspaceContext,
  input: { inventoryAccountId?: string; changeAccountId?: string },
): Computed$<ControlAccounts> {
  let inventoryAccountId: string | undefined;
  if (typeof input.inventoryAccountId === 'string' && input.inventoryAccountId.length > 0) {
    if (!accountExists(ctx, input.inventoryAccountId)) return err('invalid_reference', { field: 'inventoryAccountId' });
    inventoryAccountId = input.inventoryAccountId;
  } else {
    inventoryAccountId = accountIdByNumber(ctx, DEFAULT_INVENTORY_ACCOUNT);
  }
  let changeAccountId: string | undefined;
  if (typeof input.changeAccountId === 'string' && input.changeAccountId.length > 0) {
    if (!accountExists(ctx, input.changeAccountId)) return err('invalid_reference', { field: 'changeAccountId' });
    changeAccountId = input.changeAccountId;
  } else {
    changeAccountId = accountIdByNumber(ctx, DEFAULT_CHANGE_ACCOUNT);
  }
  if (inventoryAccountId === undefined || changeAccountId === undefined) {
    return err('needs_inventory_accounts', { accounts: [DEFAULT_INVENTORY_ACCOUNT, DEFAULT_CHANGE_ACCOUNT] });
  }
  return { ok: true, value: { inventoryAccountId, changeAccountId } };
}

// --- the computed valuation (via J03's public API) ----------------------------------------------

interface ComputedLine {
  itemId: string;
  itemName: string;
  locationId: string | null;
  qty: number;
  unitCostRappen: number | null;
  valueRappen: number;
  marketValueRappen: number | null;
  isMarketWriteDown: boolean;
  valuationBasis: string;
  reason: string | null;
}

interface Computed {
  method: ValuationMethod;
  totalValueRappen: number;
  totalWriteDownRappen: number;
  lines: ComputedLine[];
}

interface PreviewRow {
  itemId: string;
  itemName: string;
  locationId: string | null;
  qtyOnHand: number;
  unitCostMinor: number | null;
  totalValueMinor: number;
  writeDownMinor: number;
  lcmApplied: boolean;
  valuationBasis: string;
  reason: string | null;
}

/**
 * The authoritative valuation at `asOf`, read through J03's own `inventoryValuationPreview` with the
 * per-location breakdown on. Because that verb's per-location rows are guaranteed to sum to the item
 * total, `SUM(line.value) === total` holds exactly (identity 1). `netRealisableValues` flows straight
 * to J03's compulsory OR 960c clamp; omitted, the run posts pure cost. Pure quantity-zero, zero-value
 * rows are dropped (spec §2.1): a line is kept when it carries a quantity or a value.
 */
function computeValuation(
  ctx: WorkspaceContext,
  asOf: string,
  methodOverride: ValuationMethod | undefined,
  netRealisableValues: Record<string, number> | undefined,
): Computed$<Computed> {
  const preview = inventoryValuationPreview(ctx, {
    asOf,
    valueByLocation: true,
    ...(methodOverride !== undefined ? { methodOverride } : {}),
    ...(netRealisableValues !== undefined ? { netRealisableValues } : {}),
  });
  if (!preview.ok) return preview;

  const rows = preview.items as unknown as PreviewRow[];
  const lines: ComputedLine[] = [];
  for (const r of rows) {
    if (r.qtyOnHand === 0 && r.totalValueMinor === 0 && r.writeDownMinor === 0) continue;
    lines.push({
      itemId: r.itemId,
      itemName: r.itemName,
      locationId: r.locationId,
      qty: r.qtyOnHand,
      unitCostRappen: r.unitCostMinor,
      valueRappen: r.totalValueMinor,
      marketValueRappen: r.lcmApplied ? r.unitCostMinor : null,
      isMarketWriteDown: r.lcmApplied,
      valuationBasis: r.valuationBasis,
      reason: r.reason,
    });
  }

  // The workspace default method, only to STAMP the run when no override was given. The figure itself
  // already resolved each item's own method inside the preview (item override beats workspace default);
  // this is a label for the run header, and a run with mixed item methods is stamped with the default.
  const method =
    methodOverride ??
    (rows.length > 0
      ? // Resolve from the first item; the preview already applied each item's own method per line.
        resolveMethodAt(ctx, (rows[0] as PreviewRow).itemId, asOf).method
      : resolveMethodAt(ctx, '', asOf).method);

  return {
    ok: true,
    value: {
      method,
      totalValueRappen: (preview as unknown as { totalValueMinor: number }).totalValueMinor,
      totalWriteDownRappen: (preview as unknown as { totalWriteDownMinor: number }).totalWriteDownMinor,
      lines,
    },
  };
}

// --- serialisation ------------------------------------------------------------------------------

function runPayload(run: RunRow, lines: LineRow[] | undefined): Record<string, unknown> {
  return {
    run: {
      id: run.id,
      asOf: run.as_of,
      period: run.period,
      method: normaliseMethod(run.method) ?? run.method,
      status: run.status,
      totalValueRappen: run.total_value_rappen,
      deltaRappen: run.delta_rappen,
      lineCount: run.line_count,
      journalEntryId: run.journal_entry_id,
      reversingJournalEntryId: run.reversing_journal_entry_id,
      priorRunId: run.prior_run_id,
      filters: run.filters_json === null ? null : JSON.parse(run.filters_json),
      notes: run.notes,
      isOpening: run.is_opening === 1,
      createdAt: run.created_at,
      createdBy: run.created_by,
      postedAt: run.posted_at,
      postedBy: run.posted_by,
    },
    ...(lines !== undefined
      ? {
          lines: lines.map((l) => ({
            id: l.id,
            itemId: l.item_id,
            itemName: l.item_name,
            locationId: l.location_id,
            lotId: l.lot_id,
            serialId: l.serial_id,
            qty: l.qty,
            unitCostRappen: l.unit_cost_rappen,
            valueRappen: l.value_rappen,
            controlAccountId: l.control_account_id,
            marketValueRappen: l.market_value_rappen,
            isMarketWriteDown: l.is_market_write_down === 1,
            valuationBasis: l.valuation_basis,
            reason: l.reason,
          })),
        }
      : {}),
  };
}

function readRun(ctx: WorkspaceContext, runId: string): RunRow | undefined {
  return ctx.store.db
    .prepare(`SELECT ${RUN_COLUMNS} FROM inventory_valuation_run WHERE workspace_id = ? AND id = ?`)
    .get(ctx.workspaceId, runId) as RunRow | undefined;
}

function readRunByKey(ctx: WorkspaceContext, key: string): RunRow | undefined {
  return ctx.store.db
    .prepare(`SELECT ${RUN_COLUMNS} FROM inventory_valuation_run WHERE workspace_id = ? AND idempotency_key = ?`)
    .get(ctx.workspaceId, key) as RunRow | undefined;
}

function readLines(ctx: WorkspaceContext, runId: string): LineRow[] {
  return ctx.store.db
    .prepare(
      `SELECT ${LINE_COLUMNS} FROM inventory_valuation_line WHERE workspace_id = ? AND run_id = ?
        ORDER BY item_name, item_id, location_id`,
    )
    .all(ctx.workspaceId, runId) as LineRow[];
}

// --- create -------------------------------------------------------------------------------------

export interface ValuationCreateInput {
  asOf?: string;
  period?: string;
  method?: string;
  netRealisableValues?: Record<string, number>;
  inventoryAccountId?: string;
  changeAccountId?: string;
  notes?: string;
  idempotencyKey?: string;
}

/**
 * Create a DRAFT valuation run for a cut-off (US-J06.1). Computes the full inventory valuation through
 * J03, writes the run header plus one immutable line per (item, location) with a value or a quantity,
 * and returns the draft with its proposed journal so the UI can review it before anything hits the
 * books. Writes NO journal. A filtered run is deliberately not offered: a partitioned run cannot hold
 * the OP11 identity (see spec §10.2); use `inventory_valuation_report` for a filtered view.
 */
export function inventoryValuationCreate(ctx: WorkspaceContext, input: ValuationCreateInput): Result {
  const capable = ctx.capabilities.assert('inventory.setup');
  if (!capable.ok) return capable;

  const resolvedAsOf = resolveCutOff(input);
  if (!resolvedAsOf.ok) return resolvedAsOf;
  const { asOf, period } = resolvedAsOf;

  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  let methodOverride: ValuationMethod | undefined;
  if (input.method !== undefined) {
    const m = normaliseMethod(input.method);
    if (m === undefined) return err('unknown_method', { method: input.method, allowed: [...VALUATION_METHODS] });
    methodOverride = m;
  }

  // §H-IDEMPOTENT: a replay returns the cached run and its lines, and recomputes nothing.
  const replay = readRunByKey(ctx, input.idempotencyKey);
  if (replay !== undefined) return ok(runPayload(replay, readLines(ctx, replay.id)));

  const accounts = resolveControlAccounts(ctx, input);
  if (!accounts.ok) return accounts;

  // §H-PERIOD, before any write, so a locked cut-off leaves nothing behind (post re-checks too).
  const periodOpen = ctx.periods.assertOpen(asOf);
  if (!periodOpen.ok) return periodOpen;

  const computed = computeValuation(ctx, asOf, methodOverride, input.netRealisableValues);
  if (!computed.ok) return computed;

  const notes = typeof input.notes === 'string' && input.notes.trim().length > 0 ? input.notes.trim() : null;
  const fingerprint = ledgerFingerprint(ctx, asOf);

  try {
    return ctx.store.tx(() => {
      const raced = readRunByKey(ctx, input.idempotencyKey as string);
      if (raced !== undefined) return ok(runPayload(raced, readLines(ctx, raced.id)));
      const run = writeDraftRun(ctx, {
        asOf,
        period,
        method: computed.value.method,
        totalValueRappen: computed.value.totalValueRappen,
        lines: computed.value.lines,
        controlAccountId: accounts.value.inventoryAccountId,
        fingerprint,
        notes,
        isOpening: false,
        idempotencyKey: input.idempotencyKey as string,
      });
      return ok(runPayload(run, readLines(ctx, run.id)));
    });
  } catch (e) {
    const winner = readRunByKey(ctx, input.idempotencyKey);
    if (winner !== undefined) return ok(runPayload(winner, readLines(ctx, winner.id)));
    throw e;
  }
}

function resolveCutOff(input: { asOf?: string; period?: string }): Result<{ asOf: string; period: string | null }> {
  if (typeof input.period === 'string' && input.period.length > 0) {
    if (!PERIOD_RE.test(input.period)) return err('invalid_input', { field: 'period' });
    return ok({ asOf: periodEnd(input.period), period: input.period });
  }
  if (typeof input.asOf === 'string' && input.asOf.length > 0) {
    const asOf = input.asOf.slice(0, 10);
    if (!DATE_RE.test(asOf)) return err('invalid_input', { field: 'asOf' });
    // A cut-off that lands on a month end carries the period label, so period-close can find it.
    const end = periodEnd(periodOf(asOf));
    return ok({ asOf, period: asOf === end ? periodOf(asOf) : null });
  }
  return err('invalid_input', { field: 'asOf' });
}

interface DraftDraft {
  asOf: string;
  period: string | null;
  method: ValuationMethod;
  totalValueRappen: number;
  lines: ComputedLine[];
  controlAccountId: string;
  fingerprint: string;
  notes: string | null;
  isOpening: boolean;
  idempotencyKey: string;
  priorRunId?: string | null;
}

/** Write the draft run header and its immutable lines. Called inside a transaction only. */
function writeDraftRun(ctx: WorkspaceContext, d: DraftDraft): RunRow {
  const runId = ctx.ids.next('invval');
  const now = ctx.clock.now();
  ctx.store.db
    .prepare(
      `INSERT INTO inventory_valuation_run
         (id, workspace_id, as_of, period, method, status, total_value_rappen, delta_rappen, line_count,
          journal_entry_id, reversing_journal_entry_id, prior_run_id, filters_json, ledger_fingerprint,
          notes, is_opening, idempotency_key, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, 0, ?, NULL, NULL, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      ctx.workspaceId,
      d.asOf,
      d.period,
      d.method,
      d.totalValueRappen,
      d.lines.length,
      d.priorRunId ?? null,
      d.fingerprint,
      d.notes,
      d.isOpening ? 1 : 0,
      d.idempotencyKey,
      now,
      ctx.actor,
    );
  const insertLine = ctx.store.db.prepare(
    `INSERT INTO inventory_valuation_line
       (id, run_id, workspace_id, item_id, item_name, location_id, lot_id, serial_id, qty,
        unit_cost_rappen, value_rappen, control_account_id, market_value_rappen, is_market_write_down,
        valuation_basis, reason)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const line of d.lines) {
    insertLine.run(
      ctx.ids.next('invvl'),
      runId,
      ctx.workspaceId,
      line.itemId,
      line.itemName,
      line.locationId,
      line.qty,
      line.unitCostRappen,
      line.valueRappen,
      d.controlAccountId,
      line.marketValueRappen,
      line.isMarketWriteDown ? 1 : 0,
      line.valuationBasis,
      line.reason,
    );
  }
  return readRun(ctx, runId) as RunRow;
}

// --- the journal builder ------------------------------------------------------------------------

interface JournalPlan {
  lines: { account: string; debit?: number; credit?: number }[];
  totalDelta: number;
  perAccount: { accountId: string; subledger: number; baseline: number; delta: number }[];
}

/**
 * The baseline a run's delta is measured against, per control account. It is the value J06 ITSELF last
 * carried to the GL for that account, NOT the live GL balance, and the distinction is load-bearing.
 *
 * If the delta were computed against the live GL, a run posted after an external, non-J06 posting to
 * the control account (a stray manual entry, US-J06.7) would compute `subledger - gl` and post a
 * counter-adjustment that ABSORBS that external movement, silently masking exactly the drift the
 * reconciliation exists to surface. Measuring against J06's own last posted total instead leaves the
 * external movement untouched in the GL, so the recon report keeps showing it as drift and the hard
 * check keeps blocking period close until it is explained. That is the spec's rule: "Differences are
 * never auto-corrected; they are reported."
 *
 * The baseline is the account's grouped value in the MOST RECENT non-reversed posted run (a reversed
 * run left nothing standing, so it is excluded). When no posted run exists yet, the baseline IS the
 * live GL: a fresh workspace whose control account was seeded by an A04 opening balance must not
 * double-count that opening on its first valuation (spec §4, "versus current GL if this is the first
 * run"). The current run is still `draft` when this reads, so it is never its own baseline.
 */
function baselineForAccount(ctx: WorkspaceContext, accountId: string, asOf: string): number {
  const latest = ctx.store.db
    .prepare(
      // Posting recency, not cut-off: the baseline is the total J06 LAST established in the GL,
      // whatever cut-off that run carried. `posted_at` orders by when the GL actually moved.
      `SELECT id FROM inventory_valuation_run
        WHERE workspace_id = ? AND status = 'posted' ORDER BY posted_at DESC, created_at DESC, id DESC LIMIT 1`,
    )
    .get(ctx.workspaceId) as { id: string } | undefined;
  if (latest === undefined) return glBalanceAt(ctx, accountId, asOf);
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(value_rappen), 0) AS v FROM inventory_valuation_line
        WHERE workspace_id = ? AND run_id = ? AND control_account_id = ?`,
    )
    .get(ctx.workspaceId, latest.id, accountId) as { v: number };
  return row.v;
}

/**
 * Group the run's lines by control account, take each account's baseline (see `baselineForAccount`),
 * and build the balanced Dr/Cr the delta needs. One inventory line per control account (debit to
 * raise, credit to lower) plus ONE net counter line on the change account. When the deltas across
 * accounts offset to a net of zero the counter line is omitted (the inventory lines already balance
 * among themselves); when every delta is zero the plan is empty and no journal is posted.
 */
function buildJournalPlan(ctx: WorkspaceContext, lines: LineRow[], asOf: string, changeAccountId: string): JournalPlan {
  const subledgerByAccount = new Map<string, number>();
  for (const l of lines) {
    subledgerByAccount.set(l.control_account_id, (subledgerByAccount.get(l.control_account_id) ?? 0) + l.value_rappen);
  }
  const perAccount: { accountId: string; subledger: number; baseline: number; delta: number }[] = [];
  const journalLines: { account: string; debit?: number; credit?: number }[] = [];
  let totalDelta = 0;
  for (const [accountId, subledger] of subledgerByAccount) {
    const baseline = baselineForAccount(ctx, accountId, asOf);
    const delta = subledger - baseline;
    perAccount.push({ accountId, subledger, baseline, delta });
    totalDelta += delta;
    if (delta > 0) journalLines.push({ account: accountId, debit: delta });
    else if (delta < 0) journalLines.push({ account: accountId, credit: -delta });
  }
  if (totalDelta > 0) journalLines.push({ account: changeAccountId, credit: totalDelta });
  else if (totalDelta < 0) journalLines.push({ account: changeAccountId, debit: -totalDelta });
  return { lines: journalLines, totalDelta, perAccount };
}

/** Carries a structured A02 rejection out of a transaction so it rolls back and returns cleanly. */
class PostFailure {
  constructor(public readonly result: Result) {}
}

// --- post ---------------------------------------------------------------------------------------

export interface ValuationPostInput {
  runId?: string;
  changeAccountId?: string;
  idempotencyKey?: string;
}

/**
 * Post a reviewed draft (US-J06.2). In ONE transaction: re-check the period is open and the draft is
 * not stale, compute the per-control-account delta against J06's own last posted baseline
 * (`baselineForAccount`, which falls back to the live GL only when no posted run exists yet), post ONE balanced A02 entry
 * (`source='inventory_valuation'`) for it, and flip the run to `posted`. After this the OP11 identity
 * holds for the cut-off. Idempotent: a replay of a posted run returns it and posts nothing; the A02
 * post carries a derived key so a replay mints ONE journal.
 */
export function inventoryValuationPost(ctx: WorkspaceContext, input: ValuationPostInput): Result {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  if (typeof input.runId !== 'string' || input.runId.length === 0) return err('invalid_input', { field: 'runId' });
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }

  const run = readRun(ctx, input.runId);
  if (run === undefined) return err('not_found', { runId: input.runId });
  if (run.status === 'posted') return ok(runPayload(run, readLines(ctx, run.id)));
  if (run.status === 'reversed') return err('run_reversed', { runId: run.id });

  // §H-PERIOD before any write; the A02 post re-checks the same lock.
  const periodOpen = ctx.periods.assertOpen(run.as_of);
  if (!periodOpen.ok) return periodOpen;

  // Stale-draft guard: if the ledger changed since the draft was calculated, the reviewed figure no
  // longer describes the books, so it is refused rather than posted (US-J06.7).
  const fingerprint = ledgerFingerprint(ctx, run.as_of);
  if (run.ledger_fingerprint !== null && run.ledger_fingerprint !== fingerprint) {
    return err('stale_draft', { runId: run.id });
  }

  const accounts = resolveControlAccounts(ctx, input);
  if (!accounts.ok) return accounts;
  const lines = readLines(ctx, run.id);
  const plan = buildJournalPlan(ctx, lines, run.as_of, accounts.value.changeAccountId);

  try {
    return ctx.store.tx(() => {
      const fresh = readRun(ctx, run.id) as RunRow;
      if (fresh.status === 'posted') return ok(runPayload(fresh, readLines(ctx, fresh.id)));

      let journalEntryId: string | null = null;
      if (plan.lines.length > 0) {
        const posted = postEntry(ctx, {
          date: run.as_of,
          source: RUN_SOURCE,
          description: 'Bestandesbewertung (Inventar -> Hauptbuch)',
          lines: plan.lines,
          idempotencyKey: `${input.idempotencyKey}-post`,
        });
        if (!posted.ok) throw new PostFailure(posted);
        journalEntryId = posted.entryId;
      }
      const now = ctx.clock.now();
      ctx.store.db
        .prepare(
          `UPDATE inventory_valuation_run
              SET status = 'posted', delta_rappen = ?, journal_entry_id = ?, posted_at = ?, posted_by = ?
            WHERE workspace_id = ? AND id = ?`,
        )
        .run(plan.totalDelta, journalEntryId, now, ctx.actor, ctx.workspaceId, run.id);
      const out = readRun(ctx, run.id) as RunRow;
      // The run object carries journalEntryId and deltaRappen; no top-level duplicates, so the
      // idempotent replay (which returns runPayload alone) is byte-identical to this first post.
      return ok(runPayload(out, readLines(ctx, out.id)));
    });
  } catch (e) {
    if (e instanceof PostFailure) return e.result;
    throw e;
  }
}

// --- reverse ------------------------------------------------------------------------------------

export interface ValuationReverseInput {
  runId?: string;
  reason?: string;
  idempotencyKey?: string;
}

/**
 * Reverse a posted run (US-J06 reverse path). Posts the exact A02 mirror of the run's journal via
 * `reverseEntry`, which moves the GL back by the delta and so restores the baseline every subsequent
 * run measures its own delta against: the reversed run no longer counts, so `baselineForAccount` falls
 * back to the most recent still-standing posted run (or the live GL only when none remains). There is
 * no separate stored baseline; it is derived from the last non-reversed posted run. The original run
 * row is not deleted and the original journal is never mutated; the run is
 * marked `reversed` with the reversing journal recorded. A run that posted no journal (zero delta) is
 * marked reversed with nothing to reverse.
 */
export function inventoryValuationReverse(ctx: WorkspaceContext, input: ValuationReverseInput): Result {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  if (typeof input.runId !== 'string' || input.runId.length === 0) return err('invalid_input', { field: 'runId' });
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const reason = typeof input.reason === 'string' && input.reason.trim().length > 0 ? input.reason.trim() : null;
  if (reason === null) return err('invalid_input', { field: 'reason' });

  const run = readRun(ctx, input.runId);
  if (run === undefined) return err('not_found', { runId: input.runId });
  if (run.status === 'draft') return err('run_not_posted', { runId: run.id });
  if (run.status === 'reversed') return ok(runPayload(run, readLines(ctx, run.id)));

  // §H-PERIOD: the reversing entry lands at the run's cut-off, so the same lock must be open.
  const periodOpen = ctx.periods.assertOpen(run.as_of);
  if (!periodOpen.ok) return periodOpen;

  try {
    return ctx.store.tx(() => {
      const fresh = readRun(ctx, run.id) as RunRow;
      if (fresh.status === 'reversed') return ok(runPayload(fresh, readLines(ctx, fresh.id)));

      let reversingId: string | null = null;
      if (fresh.journal_entry_id !== null) {
        const reversed = reverseEntry(ctx, {
          entryId: fresh.journal_entry_id,
          // Dated at the run's cut-off, not today: the delta of every later run is measured against
          // the GL balance AS OF a cut-off, so a future-dated reversal would leave the GL at that
          // cut-off unchanged and make a re-run see no gap to post. Same date nets the balance to its
          // prior baseline exactly where the identity is checked (the period is open, asserted above).
          date: fresh.as_of,
          idempotencyKey: `${input.idempotencyKey}-rev`,
          description: 'Bestandesbewertung Storno',
        });
        if (!reversed.ok) throw new PostFailure(reversed);
        reversingId = reversed.reversalId;
      }
      ctx.store.db
        .prepare(
          `UPDATE inventory_valuation_run SET status = 'reversed', reversing_journal_entry_id = ?, notes = ?
            WHERE workspace_id = ? AND id = ?`,
        )
        .run(reversingId, reason, ctx.workspaceId, run.id);
      const out = readRun(ctx, run.id) as RunRow;
      return ok(runPayload(out, readLines(ctx, out.id)));
    });
  } catch (e) {
    if (e instanceof PostFailure) return e.result;
    throw e;
  }
}

// --- opening ------------------------------------------------------------------------------------

export interface ValuationOpeningInput {
  asOf?: string;
  lines?: { itemId: string; locationId?: string; qty: number; valueRappen: number }[];
  inventoryAccountId?: string;
  changeAccountId?: string;
  notes?: string;
  idempotencyKey?: string;
}

/**
 * Record an OPENING valuation for a migration or a new workspace (US-J06.6). The caller states the
 * known item values directly (rather than deriving them from a movement ledger that does not yet
 * exist), and the verb posts the opening delta against the current GL exactly as an ordinary run does,
 * so the OP11 identity holds from day one. A `posted` run is written in one step (no draft review):
 * an opening baseline is the operator's stated figure, not a computed one to review.
 */
export function inventoryValuationOpening(ctx: WorkspaceContext, input: ValuationOpeningInput): Result {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  if (typeof input.asOf !== 'string' || !DATE_RE.test(input.asOf.slice(0, 10))) return err('invalid_input', { field: 'asOf' });
  const asOf = input.asOf.slice(0, 10);
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) return err('invalid_input', { field: 'lines' });

  const replay = readRunByKey(ctx, input.idempotencyKey);
  if (replay !== undefined) return ok(runPayload(replay, readLines(ctx, replay.id)));

  const accounts = resolveControlAccounts(ctx, input);
  if (!accounts.ok) return accounts;
  const inventoryAccountId = accounts.value.inventoryAccountId;
  const changeAccountId = accounts.value.changeAccountId;

  const periodOpen = ctx.periods.assertOpen(asOf);
  if (!periodOpen.ok) return periodOpen;

  const computed: ComputedLine[] = [];
  let total = 0;
  for (const raw of input.lines) {
    if (typeof raw.itemId !== 'string' || raw.itemId.length === 0) return err('invalid_input', { field: 'lines.itemId' });
    const item = ctx.store.db
      .prepare('SELECT id, name FROM item WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, raw.itemId) as { id: string; name: string } | undefined;
    if (item === undefined) return err('not_found', { itemId: raw.itemId });
    if (!Number.isInteger(raw.qty)) return err('invalid_input', { field: 'lines.qty' });
    if (!Number.isInteger(raw.valueRappen) || raw.valueRappen < 0) return err('invalid_input', { field: 'lines.valueRappen' });
    let locationId: string | null = null;
    if (typeof raw.locationId === 'string' && raw.locationId.length > 0) {
      const loc = ctx.store.db
        .prepare('SELECT id FROM stock_location WHERE workspace_id = ? AND id = ?')
        .get(ctx.workspaceId, raw.locationId) as { id: string } | undefined;
      if (loc === undefined) return err('not_found', { locationId: raw.locationId });
      locationId = raw.locationId;
    }
    total += raw.valueRappen;
    computed.push({
      itemId: item.id,
      itemName: item.name,
      locationId,
      qty: raw.qty,
      unitCostRappen: raw.qty !== 0 ? Math.trunc(raw.valueRappen / raw.qty) : null,
      valueRappen: raw.valueRappen,
      marketValueRappen: null,
      isMarketWriteDown: false,
      valuationBasis: 'direct',
      reason: null,
    });
  }

  const notes = typeof input.notes === 'string' && input.notes.trim().length > 0 ? input.notes.trim() : null;

  try {
    return ctx.store.tx(() => {
      const raced = readRunByKey(ctx, input.idempotencyKey as string);
      if (raced !== undefined) return ok(runPayload(raced, readLines(ctx, raced.id)));

      const run = writeDraftRun(ctx, {
        asOf,
        period: asOf === periodEnd(periodOf(asOf)) ? periodOf(asOf) : null,
        method: resolveMethodAt(ctx, computed[0]?.itemId ?? '', asOf).method,
        totalValueRappen: total,
        lines: computed,
        controlAccountId: inventoryAccountId,
        fingerprint: ledgerFingerprint(ctx, asOf),
        notes,
        isOpening: true,
        idempotencyKey: input.idempotencyKey as string,
      });

      const runLines = readLines(ctx, run.id);
      const plan = buildJournalPlan(ctx, runLines, asOf, changeAccountId);
      let journalEntryId: string | null = null;
      if (plan.lines.length > 0) {
        const posted = postEntry(ctx, {
          date: asOf,
          source: RUN_SOURCE,
          description: 'Eröffnungsbewertung Inventar',
          lines: plan.lines,
          idempotencyKey: `${input.idempotencyKey}-post`,
        });
        if (!posted.ok) throw new PostFailure(posted);
        journalEntryId = posted.entryId;
      }
      ctx.store.db
        .prepare(
          `UPDATE inventory_valuation_run
              SET status = 'posted', delta_rappen = ?, journal_entry_id = ?, posted_at = ?, posted_by = ?
            WHERE workspace_id = ? AND id = ?`,
        )
        .run(plan.totalDelta, journalEntryId, ctx.clock.now(), ctx.actor, ctx.workspaceId, run.id);
      const out = readRun(ctx, run.id) as RunRow;
      return ok(runPayload(out, readLines(ctx, out.id)));
    });
  } catch (e) {
    if (e instanceof PostFailure) return e.result;
    const winner = readRunByKey(ctx, input.idempotencyKey);
    if (winner !== undefined) return ok(runPayload(winner, readLines(ctx, winner.id)));
    throw e;
  }
}

// --- reads: get / list --------------------------------------------------------------------------

export function inventoryValuationGet(ctx: WorkspaceContext, input: { runId?: string }): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;
  if (typeof input.runId !== 'string' || input.runId.length === 0) return err('invalid_input', { field: 'runId' });
  const run = readRun(ctx, input.runId);
  if (run === undefined) return err('not_found', { runId: input.runId });
  return ok(runPayload(run, readLines(ctx, run.id)));
}

export interface ValuationListInput {
  status?: string[];
  from?: string;
  to?: string;
  limit?: number;
}

export function inventoryValuationList(ctx: WorkspaceContext, input: ValuationListInput = {}): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;

  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (Array.isArray(input.status) && input.status.length > 0) {
    const valid = input.status.filter((s) => s === 'draft' || s === 'posted' || s === 'reversed');
    if (valid.length === 0) return err('invalid_input', { field: 'status' });
    clauses.push(`status IN (${valid.map(() => '?').join(', ')})`);
    params.push(...valid);
  }
  if (typeof input.from === 'string' && input.from.length > 0) {
    if (!DATE_RE.test(input.from)) return err('invalid_input', { field: 'from' });
    clauses.push('as_of >= ?');
    params.push(input.from);
  }
  if (typeof input.to === 'string' && input.to.length > 0) {
    if (!DATE_RE.test(input.to)) return err('invalid_input', { field: 'to' });
    clauses.push('as_of <= ?');
    params.push(input.to);
  }
  const limit = Number.isInteger(input.limit) && (input.limit as number) > 0 ? Math.min(input.limit as number, 500) : 100;

  const rows = ctx.store.db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM inventory_valuation_run WHERE ${clauses.join(' AND ')}
        ORDER BY as_of DESC, created_at DESC LIMIT ?`,
    )
    .all(...params, limit) as RunRow[];

  return ok({
    items: rows.map((r) => (runPayload(r, undefined) as { run: unknown }).run),
    total: rows.length,
  });
}

// --- reads: valuation report --------------------------------------------------------------------

export interface ValuationReportInput {
  asOf?: string;
  period?: string;
  runId?: string;
  method?: string;
  groupBy?: string[];
  accountIds?: string[];
  netRealisableValues?: Record<string, number>;
}

/**
 * The authoritative detailed valuation report (US-J06.3, US-J06.5). With `runId` it returns the FROZEN
 * lines of that run (what was posted). Without, it computes the LIVE valuation at the cut-off through
 * J03, groups by control account, and reports each account's total: this is the single source of truth
 * for "what is inventory worth at this cut-off". Optional `accountIds` narrows the account grouping.
 */
export function inventoryValuationReport(ctx: WorkspaceContext, input: ValuationReportInput = {}): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;

  if (typeof input.runId === 'string' && input.runId.length > 0) {
    const run = readRun(ctx, input.runId);
    if (run === undefined) return err('not_found', { runId: input.runId });
    const lines = readLines(ctx, run.id);
    return ok({
      source: 'run',
      asOf: run.as_of,
      method: normaliseMethod(run.method) ?? run.method,
      totalValueRappen: run.total_value_rappen,
      byAccount: groupLinesByAccount(lines),
      lines: (runPayload(run, lines) as { lines: unknown }).lines,
    });
  }

  const resolved = resolveCutOff(input);
  if (!resolved.ok) return resolved;
  let methodOverride: ValuationMethod | undefined;
  if (input.method !== undefined) {
    const m = normaliseMethod(input.method);
    if (m === undefined) return err('unknown_method', { method: input.method, allowed: [...VALUATION_METHODS] });
    methodOverride = m;
  }
  const computed = computeValuation(ctx, resolved.asOf, methodOverride, input.netRealisableValues);
  if (!computed.ok) return computed;

  const accounts = resolveControlAccounts(ctx, {});
  if (!accounts.ok) return accounts;
  const controlAccountId = accounts.value.inventoryAccountId;

  const wanted = Array.isArray(input.accountIds) && input.accountIds.length > 0 ? new Set(input.accountIds) : null;
  const lines = computed.value.lines
    .map((l) => ({ ...l, controlAccountId }))
    .filter((l) => wanted === null || wanted.has(l.controlAccountId));
  const total = lines.reduce((s, l) => s + l.valueRappen, 0);

  return ok({
    source: 'live',
    asOf: resolved.asOf,
    method: computed.value.method,
    totalValueRappen: total,
    totalWriteDownRappen: computed.value.totalWriteDownRappen,
    byAccount: groupComputedByAccount(lines),
    lines,
  });
}

function groupLinesByAccount(lines: LineRow[]): { accountId: string; valueRappen: number; lineCount: number }[] {
  const map = new Map<string, { valueRappen: number; lineCount: number }>();
  for (const l of lines) {
    const cur = map.get(l.control_account_id) ?? { valueRappen: 0, lineCount: 0 };
    cur.valueRappen += l.value_rappen;
    cur.lineCount += 1;
    map.set(l.control_account_id, cur);
  }
  return [...map].map(([accountId, v]) => ({ accountId, ...v }));
}

function groupComputedByAccount(
  lines: { controlAccountId: string; valueRappen: number }[],
): { accountId: string; valueRappen: number; lineCount: number }[] {
  const map = new Map<string, { valueRappen: number; lineCount: number }>();
  for (const l of lines) {
    const cur = map.get(l.controlAccountId) ?? { valueRappen: 0, lineCount: 0 };
    cur.valueRappen += l.valueRappen;
    cur.lineCount += 1;
    map.set(l.controlAccountId, cur);
  }
  return [...map].map(([accountId, v]) => ({ accountId, ...v }));
}

// --- reads: reconciliation ----------------------------------------------------------------------

export interface ReconciliationReportInput {
  period?: string;
  asOf?: string;
  accountIds?: string[];
}

interface AccountRecon {
  accountId: string;
  subLedgerRappen: number;
  glBalanceRappen: number;
  deltaRappen: number;
  status: 'balanced' | 'drift' | 'unposted';
}

/**
 * The reconciliation core (OP11), shared by the report and the hard check so they can never disagree.
 * For each control account it compares the LIVE sub-ledger valuation at the cut-off (J03) against the
 * GL balance, and reports the delta. `unposted` means the live valuation differs from what the GL
 * carries AND no posted run exists at the cut-off (a run would close the gap); `drift` means a delta
 * remains even though a run was posted at the cut-off (an external GL-only posting, US-J06.7).
 */
function reconcile(ctx: WorkspaceContext, asOf: string, accountIds: string[] | null): Computed$<{ accounts: AccountRecon[] }> {
  const computed = computeValuation(ctx, asOf, undefined, undefined);
  if (!computed.ok) return computed;

  const accounts = resolveControlAccounts(ctx, {});
  if (!accounts.ok) return accounts;
  const controlAccountId = accounts.value.inventoryAccountId;

  // Sub-ledger value per control account. Today every line maps to the one default account, so this is
  // a single-entry map; written per-account so per-item overrides drop in without changing the shape.
  const subByAccount = new Map<string, number>();
  subByAccount.set(controlAccountId, 0);
  for (const l of computed.value.lines) subByAccount.set(controlAccountId, (subByAccount.get(controlAccountId) ?? 0) + l.valueRappen);

  const postedAtCutOff = ctx.store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM inventory_valuation_run
        WHERE workspace_id = ? AND status = 'posted' AND as_of = ?`,
    )
    .get(ctx.workspaceId, asOf) as { n: number };
  const hasPostedRun = postedAtCutOff.n > 0;

  const wanted = accountIds !== null && accountIds.length > 0 ? new Set(accountIds) : null;
  const out: AccountRecon[] = [];
  for (const [accountId, subLedger] of subByAccount) {
    if (wanted !== null && !wanted.has(accountId)) continue;
    const gl = glBalanceAt(ctx, accountId, asOf);
    const delta = subLedger - gl;
    const status: AccountRecon['status'] = delta === 0 ? 'balanced' : hasPostedRun ? 'drift' : 'unposted';
    out.push({ accountId, subLedgerRappen: subLedger, glBalanceRappen: gl, deltaRappen: delta, status });
  }
  return { ok: true, value: { accounts: out } };
}

export function inventoryReconciliationReport(ctx: WorkspaceContext, input: ReconciliationReportInput = {}): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;

  const resolved = resolveCutOff(input);
  if (!resolved.ok) return resolved;
  const accountIds = Array.isArray(input.accountIds) ? input.accountIds : null;
  const recon = reconcile(ctx, resolved.asOf, accountIds);
  if (!recon.ok) return recon;

  const accounts = recon.value.accounts;
  const balancedCount = accounts.filter((a) => a.status === 'balanced').length;
  const driftCount = accounts.filter((a) => a.status === 'drift').length;
  const unpostedCount = accounts.filter((a) => a.status === 'unposted').length;
  const unpostedDeltaRappen = accounts.filter((a) => a.status === 'unposted').reduce((s, a) => s + a.deltaRappen, 0);

  return ok({
    asOf: resolved.asOf,
    period: resolved.period,
    accounts,
    balancedCount,
    driftCount,
    unpostedCount,
    unpostedDeltaRappen,
    status: driftCount > 0 ? 'drift' : unpostedCount > 0 ? 'unposted' : 'balanced',
  });
}

/**
 * The hard check period-close (and an agent) calls (US-J06.4). `balanced` lets the close proceed;
 * `drift` or `valuation_missing` is the structured refusal that blocks a hard lock until the gap is
 * explained or a corrective valuation is posted and re-checked. `valuation_missing` is returned when a
 * non-zero live valuation exists at the period end but no run was ever posted for it.
 */
export function inventoryReconciliationCheck(ctx: WorkspaceContext, input: { period?: string }): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;
  if (typeof input.period !== 'string' || !PERIOD_RE.test(input.period)) return err('invalid_input', { field: 'period' });

  const asOf = periodEnd(input.period);
  const recon = reconcile(ctx, asOf, null);
  if (!recon.ok) return recon;
  const accounts = recon.value.accounts;

  const hasValue = accounts.some((a) => a.subLedgerRappen !== 0);
  const posted = ctx.store.db
    .prepare(`SELECT COUNT(*) AS n FROM inventory_valuation_run WHERE workspace_id = ? AND status = 'posted' AND as_of = ?`)
    .get(ctx.workspaceId, asOf) as { n: number };

  if (hasValue && posted.n === 0) {
    return err('valuation_missing', { period: input.period, asOf, accounts, missing_run: true });
  }
  const drift = accounts.filter((a) => a.deltaRappen !== 0);
  if (drift.length > 0) {
    return err('reconciliation_drift', { period: input.period, asOf, accounts: drift });
  }
  return ok({ status: 'balanced', period: input.period, asOf, accounts });
}
