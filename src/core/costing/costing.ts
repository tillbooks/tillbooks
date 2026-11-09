/**
 * B03, job costing / project P&L: a PURE READ MODEL (Pattern P5) over the landed B00/B01/B02/A11
 * rows. It owns NO tables, posts NOTHING, and issues no INSERT/UPDATE/DELETE anywhere: every figure
 * is recomputed from the source rows on every call, so the P&L can never drift from the books.
 * `test/costing/read-only.test.mjs` asserts that statically (no write SQL, no postEntry/recordPayment
 * import) and `test/costing/costing.test.mjs` brackets every verb in a full row census.
 *
 * THE COMPONENT DERIVATION (spec §4, all landed since the project cost dimension):
 *
 *  - **time**: Σ over the project's `time_entry` rows (B01), each valued round-once from the OP1
 *    snapshot (ONE division and ONE rounding point, P2). The `bill` basis uses `rate_minor`; the
 *    `cost` basis uses the capture snapshot `cost_rate_minor`, falling back PER ENTRY to the bill
 *    rate where none was defined, with `basisDegraded: true` saying so (P9: no invented rate, no
 *    silent wrong number). Default slice is `approved|locked|billed`; `includeOpenTime` widens.
 *  - **revenue**: Σ over DISTINCT A11 invoice lines linked from the project's time entries
 *    (B02 stamps `time_entry.invoice_line_id`; a POSTED invoice's linkage is frozen), drafts
 *    excluded (`posted_entry_id` NOT NULL, §H-AUDIT), NET of posted credit-note lines that credit
 *    those exact positions (A13's `credited_document_id` + `credited_line_position`).
 *  - **expenses**: Σ posted `vendor_bill` rows tagged `project_id` with NO successful 3-way match,
 *    at `base_net_minor` (the base figure read off the posted entry, §H-FX).
 *  - **purchases**: the same rows WITH a successful match (`po_match` matched/overridden), so a
 *    bill sits in exactly one of the two.
 *  - **accrued_purchases**: Σ over project-tagged `po_line` rows of received-but-not-yet-billed
 *    quantity at `unit_price_base_rappen`. The 3-way match raises `billed_qty` as the bill enters
 *    `purchases`, which is the anti-double-count seam: a Franken leaves the accrual the moment it
 *    lands as a booked purchase.
 *  - **committed**: the open order balance (ordered minus received) of project-tagged lines on
 *    `sent`/`received` POs, reported BESIDE the P&L, never inside `costMinor` (an obligation, not
 *    a cost incurred).
 *
 * `unattributableComponents` is EMPTY today (single-sourced in `enums.ts`) and stays in the
 * payload as the honesty vocabulary for any future component whose source has not landed.
 *
 * §H-TENANT: every query filters `workspace_id`, and every project resolves through B00's
 * `readProject`, which is itself workspace-fenced; a cross-tenant project id answers
 * `project_not_found`, never another book's figures.
 *
 * §H-FX: B03 contains NO conversion code. A contributing row whose currency differs from
 * `workspace.base_currency` (or a bill missing its stored base) is surfaced loud
 * (`fx_base_missing` + rowIds) on the single-project verbs and degrades per row on the portfolio
 * list, never silently mixed (spec US-B03.4). Bill and PO-line figures are STORED base amounts,
 * converted once at capture/post by their owners, never re-rated here.
 *
 * ONE HONEST asOf LIMIT: D02 stores no dated per-line billed quantity (`billed_qty` is a counter
 * the match raises), so an `asOf` cut re-derives RECEIVED quantity from the dated receipt lines
 * but subtracts the CURRENT billed counter, clamped at zero. Receipts, bills and time all cut by
 * their own source date exactly.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { readProject, isProjectStatus, PROJECT_STATUSES } from '../projects/index.js';
import type { ProjectRow } from '../projects/index.js';
import { entryValueMinor } from '../time/index.js';
import { applySavedView } from '../customization/index.js';
import {
  COSTING_COMPONENTS,
  COSTING_BASES,
  UNATTRIBUTABLE_COMPONENTS,
  isCostingComponent,
  isCostingBasis,
} from './enums.js';
import type { CostingBasis } from './enums.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Drilldown page sizing: a default an agent can walk and a cap a query cannot blow past. */
const DRILLDOWN_LIMIT = 200;
const DRILLDOWN_LIMIT_MAX = 500;

// ------------------------------------------------------------------------------------------------
// Shared input shapes
// ------------------------------------------------------------------------------------------------

interface SliceOptions {
  asOf?: string | undefined;
  includeOpenTime?: boolean | undefined;
}

export interface ProjectPlInput extends SliceOptions {
  projectId: string;
  basis?: string | undefined;
  groupBy?: string | undefined;
}

export interface PlListInput extends SliceOptions {
  status?: string | undefined;
  basis?: string | undefined;
  savedViewId?: string | undefined;
}

export interface BudgetVsActualInput extends SliceOptions {
  projectId: string;
}

export interface DrilldownInput extends SliceOptions {
  projectId: string;
  component: string;
  basis?: string | undefined;
  groupBy?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

// ------------------------------------------------------------------------------------------------
// Row shapes read off the source tables (each one owned by its source capability)
// ------------------------------------------------------------------------------------------------

interface TimeRow {
  id: string;
  phase_id: string | null;
  user_id: string;
  started_at: string;
  minutes: number;
  rate_minor: number;
  rate_currency: string;
  cost_rate_minor: number | null;
  status: string;
  notes: string | null;
}

interface InvoiceLineRow {
  line_id: string;
  position: number;
  description: string | null;
  line_total_minor: number;
  document_id: string;
  number: string | null;
  issue_date: string | null;
  created_at: string;
  currency: string;
  posted_entry_id: string;
}

interface CreditLineRow {
  line_id: string;
  line_total_minor: number;
  credited_line_position: number;
  document_id: string;
  number: string | null;
  issue_date: string | null;
  created_at: string;
  currency: string;
  posted_entry_id: string;
  credited_document_id: string;
}

function baseCurrencyOf(ctx: WorkspaceContext): string {
  const row = ctx.store.db
    .prepare('SELECT base_currency FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { base_currency: string } | undefined;
  return row?.base_currency ?? 'CHF';
}

function invalidAsOf(asOf: string | undefined): Result | undefined {
  if (asOf !== undefined && !ISO_DATE.test(asOf)) return err('invalid_input', { field: 'asOf' });
  return undefined;
}

/** The time slice's status set: approved-and-beyond by default, widened per call (spec §0). */
function timeStatuses(includeOpenTime: boolean | undefined): readonly string[] {
  return includeOpenTime === true
    ? ['open', 'submitted', 'approved', 'locked', 'billed']
    : ['approved', 'locked', 'billed'];
}

function timeRows(ctx: WorkspaceContext, projectId: string, opts: SliceOptions): TimeRow[] {
  const statuses = timeStatuses(opts.includeOpenTime);
  const params: unknown[] = [ctx.workspaceId, projectId, ...statuses];
  let where =
    `workspace_id = ? AND project_id = ? AND minutes IS NOT NULL ` +
    `AND status IN (${statuses.map(() => '?').join(', ')})`;
  if (opts.asOf !== undefined) {
    where += ` AND substr(started_at, 1, 10) <= ?`;
    params.push(opts.asOf);
  }
  return ctx.store.db
    .prepare(
      `SELECT id, phase_id, user_id, started_at, minutes, rate_minor, rate_currency, cost_rate_minor, status, notes
         FROM time_entry WHERE ${where} ORDER BY started_at, id`,
    )
    .all(...params) as TimeRow[];
}

/**
 * One entry's value under a basis (P2, round-once): `bill` prices at the snapshot `rate_minor`;
 * `cost` prices at the capture snapshot `cost_rate_minor` and falls back PER ENTRY to the bill
 * rate where none was defined (spec US-B03.1 boundary), which is exactly what `basisDegraded`
 * reports. One helper, so the card, the group buckets and the drilldown cannot value differently.
 */
function timeValueMinor(row: TimeRow, basis: CostingBasis): number {
  const rate = basis === 'cost' && row.cost_rate_minor !== null ? row.cost_rate_minor : row.rate_minor;
  return entryValueMinor(row.minutes, rate);
}

/**
 * The project's POSTED invoice lines, through B02's linkage: a `document_line` counts exactly when
 * at least one of the project's time entries was billed onto it (DISTINCT lines, so a line grouping
 * several entries is one revenue row). Drafts never appear: `posted_entry_id` NOT NULL is the gate.
 */
function invoiceLineRows(ctx: WorkspaceContext, projectId: string, asOf: string | undefined): InvoiceLineRow[] {
  const params: unknown[] = [ctx.workspaceId, ctx.workspaceId, projectId];
  let dateCut = '';
  if (asOf !== undefined) {
    dateCut = ` AND substr(IFNULL(d.issue_date, d.created_at), 1, 10) <= ?`;
    params.push(asOf);
  }
  return ctx.store.db
    .prepare(
      `SELECT dl.id AS line_id, dl.position, dl.description, dl.line_total_minor,
              d.id AS document_id, d.number, d.issue_date, d.created_at, d.currency, d.posted_entry_id
         FROM document_line dl
         JOIN document d ON d.id = dl.document_id AND d.workspace_id = dl.workspace_id
        WHERE dl.workspace_id = ?
          AND d.type = 'invoice' AND d.posted_entry_id IS NOT NULL
          AND dl.id IN (
            SELECT DISTINCT invoice_line_id FROM time_entry
             WHERE workspace_id = ? AND project_id = ? AND invoice_line_id IS NOT NULL
          )${dateCut}
        ORDER BY IFNULL(d.issue_date, d.created_at), dl.id`,
    )
    .all(...params) as InvoiceLineRow[];
}

/**
 * Posted credit-note lines crediting the project's invoice positions (A13's per-line derivation
 * chain), so a cancelled or partly credited time invoice nets OUT of revenue instead of standing in
 * it. Attribution rides the credited invoice line's own project linkage, no second tag.
 */
function creditLineRows(ctx: WorkspaceContext, projectId: string, asOf: string | undefined): CreditLineRow[] {
  const params: unknown[] = [ctx.workspaceId, projectId];
  let dateCut = '';
  if (asOf !== undefined) {
    dateCut = ` AND substr(IFNULL(cn.issue_date, cn.created_at), 1, 10) <= ?`;
    params.push(asOf);
  }
  return ctx.store.db
    .prepare(
      `SELECT cl.id AS line_id, cl.line_total_minor, cl.credited_line_position,
              cn.id AS document_id, cn.number, cn.issue_date, cn.created_at, cn.currency,
              cn.posted_entry_id, cn.credited_document_id
         FROM document_line cl
         JOIN document cn ON cn.id = cl.document_id AND cn.workspace_id = cl.workspace_id
        WHERE cl.workspace_id = ?
          AND cn.type = 'credit_note' AND cn.posted_entry_id IS NOT NULL
          AND cn.credited_document_id IS NOT NULL
          AND cl.credited_line_position IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM document_line il
            JOIN time_entry te ON te.invoice_line_id = il.id AND te.workspace_id = il.workspace_id
            WHERE il.workspace_id = cl.workspace_id
              AND il.document_id = cn.credited_document_id
              AND il.position = cl.credited_line_position
              AND te.project_id = ?
          )${dateCut}
        ORDER BY IFNULL(cn.issue_date, cn.created_at), cl.id`,
    )
    .all(...params) as CreditLineRow[];
}

/** A posted, project-tagged A17 bill: an `expenses` row unmatched, a `purchases` row matched. */
interface BillCostRow {
  id: string;
  bill_date: string;
  vendor_reference: string | null;
  contact_id: string;
  base_net_minor: number | null;
  entry_id: string | null;
  /** 1 when a successful 3-way match (`matched`/`overridden`) links this bill to a PO. */
  matched: number;
}

/**
 * The project's POSTED vendor bills (A17), at their STORED base net (§H-FX: read off the posted
 * entry by A17, never recomputed here). `matched` splits them into `purchases` (3-way matched to a
 * D02 PO) and `expenses` (no PO behind them), so one bill lands in exactly one component.
 */
function billCostRows(ctx: WorkspaceContext, projectId: string, asOf: string | undefined): BillCostRow[] {
  const params: unknown[] = [ctx.workspaceId, projectId];
  let dateCut = '';
  if (asOf !== undefined) {
    dateCut = ` AND b.bill_date <= ?`;
    params.push(asOf);
  }
  return ctx.store.db
    .prepare(
      `SELECT b.id, b.bill_date, b.vendor_reference, b.contact_id, b.base_net_minor, b.entry_id,
              EXISTS (
                SELECT 1 FROM po_match m
                 WHERE m.workspace_id = b.workspace_id AND m.bill_id = b.id
                   AND m.status IN ('matched', 'overridden')
              ) AS matched
         FROM vendor_bill b
        WHERE b.workspace_id = ? AND b.project_id = ? AND b.status = 'posted'${dateCut}
        ORDER BY b.bill_date, b.id`,
    )
    .all(...params) as BillCostRow[];
}

/** A project-tagged D02 PO line with its accrual and open-order quantities resolved. */
interface PoCostRow {
  id: string;
  po_id: string;
  po_number: string;
  po_status: string;
  po_created_at: string;
  item_id: string | null;
  description: string | null;
  qty: number;
  unit_price_base_rappen: number;
  received_qty: number;
  billed_qty: number;
}

/**
 * The project's tagged `po_line` rows on non-cancelled POs, with `received_qty` re-derived from
 * the DATED receipt lines when `asOf` cuts (the counter and the derivation agree without a cut;
 * `test/purchase/d02-purchasing.test.mjs` pins the counter's arithmetic). `billed_qty` stays the
 * current counter under `asOf`: D02 stores no dated billed quantity, and the accrual clamps at 0
 * rather than fabricating a history the source does not hold (the docblock's stated limit).
 */
function poCostRows(ctx: WorkspaceContext, projectId: string, asOf: string | undefined): PoCostRow[] {
  const params: unknown[] = [];
  let receivedExpr = 'l.received_qty';
  if (asOf !== undefined) {
    receivedExpr = `(SELECT COALESCE(SUM(grl.qty), 0) FROM goods_receipt_line grl
                       JOIN goods_receipt gr ON gr.id = grl.receipt_id AND gr.workspace_id = grl.workspace_id
                      WHERE grl.workspace_id = l.workspace_id AND grl.po_line_id = l.id
                        AND substr(gr.received_at, 1, 10) <= ?)`;
    params.push(asOf);
  }
  params.push(ctx.workspaceId, projectId);
  let poCut = '';
  if (asOf !== undefined) {
    poCut = ` AND substr(po.created_at, 1, 10) <= ?`;
    params.push(asOf);
  }
  return ctx.store.db
    .prepare(
      `SELECT l.id, l.po_id, po.number AS po_number, po.status AS po_status, po.created_at AS po_created_at,
              l.item_id, l.description, l.qty, l.unit_price_base_rappen,
              ${receivedExpr} AS received_qty, l.billed_qty
         FROM po_line l
         JOIN purchase_order po ON po.id = l.po_id AND po.workspace_id = l.workspace_id
        WHERE l.workspace_id = ? AND l.project_id = ? AND po.status <> 'cancelled'${poCut}
        ORDER BY po.created_at, l.id`,
    )
    .all(...params) as PoCostRow[];
}

/** Received-not-yet-billed quantity: the accrual leg, clamped so a match can never drive it negative. */
function unbilledQty(row: PoCostRow): number {
  return Math.max(0, row.received_qty - row.billed_qty);
}

/** Ordered-not-yet-received quantity on an OPEN (`sent`/`received`) PO: the committed leg. */
function openQty(row: PoCostRow): number {
  if (row.po_status !== 'sent' && row.po_status !== 'received') return 0;
  return Math.max(0, row.qty - row.received_qty);
}

// ------------------------------------------------------------------------------------------------
// The computed model: one code path for the card, the list row and the drilldown (P5)
// ------------------------------------------------------------------------------------------------

// A type ALIAS, not an interface: aliases carry the implicit index signature `Result<T>` requires
// (the `result.ts` docblock's own instruction).
type ComputedPl = {
  timeMinor: number;
  timeMinutes: number;
  /** True when basis 'cost' fell back to the bill rate on at least one contributing entry (P9). */
  costRateMissing: boolean;
  revenueMinor: number;
  expensesMinor: number;
  purchasesMinor: number;
  accruedPurchasesMinor: number;
  committedMinor: number;
  time: TimeRow[];
  invoiceLines: InvoiceLineRow[];
  creditLines: CreditLineRow[];
  bills: BillCostRow[];
  poLines: PoCostRow[];
};

/**
 * Compute the project's components ONCE; card, list row and drilldown all read this. Answers
 * `fx_base_missing` when any contributing row prices in a non-base currency, or a posted bill is
 * missing its stored base: B03 owns no rate table and no conversion, so a mixed sum is refused
 * rather than fabricated (§H-FX).
 */
function computePl(ctx: WorkspaceContext, projectId: string, opts: SliceOptions, basis: CostingBasis): Result<ComputedPl> {
  const base = baseCurrencyOf(ctx);
  const time = timeRows(ctx, projectId, opts);
  const invoiceLines = invoiceLineRows(ctx, projectId, opts.asOf);
  const creditLines = creditLineRows(ctx, projectId, opts.asOf);
  const bills = billCostRows(ctx, projectId, opts.asOf);
  const poLines = poCostRows(ctx, projectId, opts.asOf);

  const missing: string[] = [];
  for (const row of time) if (row.rate_currency !== base) missing.push(row.id);
  for (const row of invoiceLines) if (row.currency !== base) missing.push(row.line_id);
  for (const row of creditLines) if (row.currency !== base) missing.push(row.line_id);
  // A posted bill always stores its base figures (A17 fills them on post); a NULL here is a file
  // this engine did not write, and the honest answer is the loud one, not a zero-valued expense.
  for (const row of bills) if (row.base_net_minor === null) missing.push(row.id);
  if (missing.length > 0) return err('fx_base_missing', { rowIds: missing });

  let timeMinor = 0;
  let timeMinutes = 0;
  let costRateMissing = false;
  for (const row of time) {
    timeMinor += timeValueMinor(row, basis);
    timeMinutes += row.minutes;
    if (row.cost_rate_minor === null) costRateMissing = true;
  }
  let revenueMinor = 0;
  for (const row of invoiceLines) revenueMinor += row.line_total_minor;
  for (const row of creditLines) revenueMinor -= row.line_total_minor;

  let expensesMinor = 0;
  let purchasesMinor = 0;
  for (const row of bills) {
    if (row.matched === 1) purchasesMinor += row.base_net_minor as number;
    else expensesMinor += row.base_net_minor as number;
  }
  let accruedPurchasesMinor = 0;
  let committedMinor = 0;
  for (const row of poLines) {
    accruedPurchasesMinor += unbilledQty(row) * row.unit_price_base_rappen;
    committedMinor += openQty(row) * row.unit_price_base_rappen;
  }

  return ok({
    timeMinor,
    timeMinutes,
    costRateMissing,
    revenueMinor,
    expensesMinor,
    purchasesMinor,
    accruedPurchasesMinor,
    committedMinor,
    time,
    invoiceLines,
    creditLines,
    bills,
    poLines,
  });
}

/** `margin × 10'000 / revenue`, rounded ONCE, or null when there is no revenue (never 0-as-break-even). */
function marginBpOf(marginMinor: number, revenueMinor: number): number | null {
  if (revenueMinor === 0) return null;
  return Math.round((marginMinor * 10000) / revenueMinor);
}

function resolveBasis(basis: string | undefined): Result<{ basis: CostingBasis }> {
  if (basis === undefined) return ok<{ basis: CostingBasis }>({ basis: 'bill' });
  if (!isCostingBasis(basis)) return err('invalid_basis', { basis, known: [...COSTING_BASES] });
  return ok<{ basis: CostingBasis }>({ basis });
}

interface GroupDef {
  id: string;
  key: string;
}

/**
 * Resolve a `groupBy` key to a confirmed, unarchived `select` field on `time_entry` (spec §0:
 * the one B03-relevant registered OP3 kind today; `multiselect` would let one row land in two
 * buckets and make the presentational Σ exceed the component total, so it is refused).
 */
function resolveGroupBy(ctx: WorkspaceContext, groupBy: string): Result<{ def: GroupDef }> {
  const def = ctx.store.db
    .prepare(
      `SELECT id, key, type, archived, draft FROM custom_field_def
        WHERE workspace_id = ? AND entity_kind = 'time_entry' AND key = ?`,
    )
    .get(ctx.workspaceId, groupBy) as
    | { id: string; key: string; type: string; archived: number; draft: number }
    | undefined;
  if (def === undefined || def.archived === 1 || def.draft === 1 || def.type !== 'select') {
    return err('field_not_found', { key: groupBy, entityKind: 'time_entry' });
  }
  return ok({ def: { id: def.id, key: def.key } });
}

/** The field's value per time-entry id, JSON-decoded; a row with no value buckets under null. */
function groupValues(ctx: WorkspaceContext, defId: string): Map<string, string> {
  const rows = ctx.store.db
    .prepare(`SELECT entity_id, value FROM custom_field_value WHERE workspace_id = ? AND field_def_id = ?`)
    .all(ctx.workspaceId, defId) as { entity_id: string; value: string }[];
  const map = new Map<string, string>();
  for (const row of rows) {
    try {
      const decoded: unknown = JSON.parse(row.value);
      if (typeof decoded === 'string') map.set(row.entity_id, decoded);
    } catch {
      // A malformed stored value buckets as unset rather than crashing a report (P9).
    }
  }
  return map;
}

// ------------------------------------------------------------------------------------------------
// The four read verbs
// ------------------------------------------------------------------------------------------------

/** The project P&L card (US-B03.1/.4/.5): revenue vs cost by component, margin and margin-bp. */
export function costingProjectPl(ctx: WorkspaceContext, input: ProjectPlInput): Result {
  const bad = invalidAsOf(input.asOf);
  if (bad !== undefined) return bad;
  const basis = resolveBasis(input.basis);
  if (!basis.ok) return basis;
  const project = readProject(ctx, input.projectId);
  if (project === undefined) return err('project_not_found', { projectId: input.projectId });

  const computed = computePl(ctx, input.projectId, input, basis.basis);
  if (!computed.ok) return computed;

  let breakdownByGroup: { component: 'time'; groups: { value: string | null; minor: number; minutes: number }[] } | undefined;
  if (input.groupBy !== undefined) {
    const resolved = resolveGroupBy(ctx, input.groupBy);
    if (!resolved.ok) return resolved;
    const values = groupValues(ctx, resolved.def.id);
    const buckets = new Map<string | null, { minor: number; minutes: number }>();
    for (const row of computed.time) {
      const value = values.get(row.id) ?? null;
      const bucket = buckets.get(value) ?? { minor: 0, minutes: 0 };
      bucket.minor += timeValueMinor(row, basis.basis);
      bucket.minutes += row.minutes;
      buckets.set(value, bucket);
    }
    breakdownByGroup = {
      component: 'time',
      groups: [...buckets.entries()]
        .map(([value, sums]) => ({ value, minor: sums.minor, minutes: sums.minutes }))
        .sort((a, b) => (a.value ?? '').localeCompare(b.value ?? '')),
    };
  }

  const costMinor =
    computed.timeMinor + computed.expensesMinor + computed.purchasesMinor + computed.accruedPurchasesMinor;
  const marginMinor = computed.revenueMinor - costMinor;

  return ok({
    projectId: project.id,
    currency: baseCurrencyOf(ctx),
    basis: basis.basis,
    // Degraded exactly where it is true (P9): the cost basis fell back to the bill rate on at
    // least one contributing entry because its card carried no cost rate at capture.
    basisDegraded: basis.basis === 'cost' && computed.costRateMissing,
    revenueMinor: computed.revenueMinor,
    costMinor,
    costBreakdown: {
      timeMinor: computed.timeMinor,
      expensesMinor: computed.expensesMinor,
      purchasesMinor: computed.purchasesMinor,
      accruedPurchasesMinor: computed.accruedPurchasesMinor,
    },
    committedMinor: computed.committedMinor,
    marginMinor,
    marginBp: marginBpOf(marginMinor, computed.revenueMinor),
    timeMinutes: computed.timeMinutes,
    unattributableComponents: [...UNATTRIBUTABLE_COMPONENTS],
    ...(breakdownByGroup !== undefined ? { groupBy: input.groupBy, breakdownByGroup } : {}),
  });
}

/** The portfolio (US-B03.5): one summary row per project, margin-sorted, closed behind a filter. */
export function costingPlList(ctx: WorkspaceContext, input: PlListInput = {}): Result {
  // The G00 seam, one unconditional call (the `listProjects` shape): stored filters merge UNDER the
  // caller's explicit ones, so an explicit filter always wins.
  const viewed = applySavedView(ctx, 'project', input);
  if (!viewed.ok) return viewed;
  input = viewed.filter;

  const bad = invalidAsOf(input.asOf);
  if (bad !== undefined) return bad;
  const basis = resolveBasis(input.basis);
  if (!basis.ok) return basis;
  if (input.status !== undefined && !isProjectStatus(input.status)) {
    return err('invalid_status', { status: input.status, known: [...PROJECT_STATUSES] });
  }

  const params: unknown[] = [ctx.workspaceId];
  let where = 'workspace_id = ?';
  if (input.status !== undefined) {
    where += ' AND status = ?';
    params.push(input.status);
  } else {
    // History stays reportable (US-B03.5) but does not crowd the working list: closed projects
    // appear exactly when asked for.
    where += " AND status <> 'closed'";
  }
  const projects = ctx.store.db
    .prepare(`SELECT * FROM project WHERE ${where} ORDER BY code`)
    .all(...params) as ProjectRow[];

  const rows: Record<string, unknown>[] = [];
  const degraded: Record<string, unknown>[] = [];
  let anyCostRateMissing = false;
  for (const project of projects) {
    const summary = { projectId: project.id, code: project.code, name: project.name, status: project.status };
    const computed = computePl(ctx, project.id, input, basis.basis);
    if (!computed.ok) {
      // One foreign-currency project must not blank the portfolio: its row degrades loud
      // (`fxBaseMissing`, no figures) and sorts last, the per-row form of `fx_base_missing`.
      degraded.push({ ...summary, fxBaseMissing: true });
      continue;
    }
    if (computed.costRateMissing) anyCostRateMissing = true;
    const costMinor =
      computed.timeMinor + computed.expensesMinor + computed.purchasesMinor + computed.accruedPurchasesMinor;
    const marginMinor = computed.revenueMinor - costMinor;
    rows.push({
      ...summary,
      revenueMinor: computed.revenueMinor,
      costMinor,
      marginMinor,
      marginBp: marginBpOf(marginMinor, computed.revenueMinor),
      timeMinutes: computed.timeMinutes,
    });
  }
  rows.sort((a, b) => (b.marginMinor as number) - (a.marginMinor as number));

  return ok({
    currency: baseCurrencyOf(ctx),
    basis: basis.basis,
    basisDegraded: basis.basis === 'cost' && anyCostRateMissing,
    projects: [...rows, ...degraded],
    unattributableComponents: [...UNATTRIBUTABLE_COMPONENTS],
  });
}

/** Cost-to-date vs the B00 budget (US-B03.2), in the workspace base currency (§H-FX snapshot side). */
export function costingBudgetVsActual(ctx: WorkspaceContext, input: BudgetVsActualInput): Result {
  const bad = invalidAsOf(input.asOf);
  if (bad !== undefined) return bad;
  const project = readProject(ctx, input.projectId);
  if (project === undefined) return err('project_not_found', { projectId: input.projectId });

  // The BILL basis, fixed: budget burn is measured at booked cost (bills at base net, accrual at
  // PO price, time at the snapshot rate), the same terms B00's own cost-source seam reports, so
  // the two budget surfaces cannot disagree. The verb takes no basis parameter.
  const computed = computePl(ctx, input.projectId, input, 'bill');
  if (!computed.ok) return computed;

  // The base-currency budget: the §H-FX snapshot where one was taken, the budget itself where the
  // project already keeps its budget in base (B00's `baseBudgetOf` contract).
  const budgetMinor = project.budget_base_minor ?? project.budget_minor;
  const budgetHours = project.budget_hours;
  const budgeted = budgetMinor > 0 || budgetHours > 0;
  const costToDateMinor =
    computed.timeMinor + computed.expensesMinor + computed.purchasesMinor + computed.accruedPurchasesMinor;
  const hoursToDate = computed.timeMinutes / 60;

  if (!budgeted) {
    // No fake 0-budget overrun (US-B03.2 empty): cost-to-date only.
    return ok({
      projectId: project.id,
      budgeted: false,
      currency: baseCurrencyOf(ctx),
      costToDateMinor,
      minutesToDate: computed.timeMinutes,
      hoursToDate,
      unattributableComponents: [...UNATTRIBUTABLE_COMPONENTS],
    });
  }

  return ok({
    projectId: project.id,
    budgeted: true,
    currency: baseCurrencyOf(ctx),
    budgetMinor,
    budgetHours,
    costToDateMinor,
    minutesToDate: computed.timeMinutes,
    hoursToDate,
    remainingMinor: budgetMinor - costToDateMinor,
    consumedBp: budgetMinor > 0 ? Math.round((costToDateMinor * 10000) / budgetMinor) : null,
    hoursRemaining: budgetHours > 0 ? budgetHours - hoursToDate : null,
    overBudget: budgetMinor > 0 && costToDateMinor > budgetMinor,
    unattributableComponents: [...UNATTRIBUTABLE_COMPONENTS],
  });
}

/** One drilldown row: the source row an agent (or the GUI table) can explain a Rappen with. */
interface DrilldownRow {
  id: string;
  sourceKind: string;
  amountMinor: number;
  orderKey: string;
  [key: string]: unknown;
}

/** The contributing rows for one component (US-B03.3), keyset-paginated, Σ(rows) == card figure. */
export function costingDrilldown(ctx: WorkspaceContext, input: DrilldownInput): Result {
  const bad = invalidAsOf(input.asOf);
  if (bad !== undefined) return bad;
  if (!isCostingComponent(input.component)) {
    return err('invalid_component', { component: input.component, known: [...COSTING_COMPONENTS] });
  }
  const basis = resolveBasis(input.basis);
  if (!basis.ok) return basis;
  const project = readProject(ctx, input.projectId);
  if (project === undefined) return err('project_not_found', { projectId: input.projectId });

  if ((UNATTRIBUTABLE_COMPONENTS as readonly string[]).includes(input.component)) {
    // The honest empty: the source table exists, its project reference does not (spec §0). Zero
    // rows plus the flag, never an error and never a fabricated attribution.
    return ok({
      projectId: project.id,
      component: input.component,
      currency: baseCurrencyOf(ctx),
      basis: basis.basis,
      totalMinor: 0,
      rows: [],
      unattributable: true,
      nextCursor: null,
    });
  }

  const computed = computePl(ctx, input.projectId, input, basis.basis);
  if (!computed.ok) return computed;

  let all: DrilldownRow[];
  let totalMinor: number;
  let groupBy: { def: GroupDef; values: Map<string, string> } | undefined;
  if (input.groupBy !== undefined && input.component === 'time') {
    const resolved = resolveGroupBy(ctx, input.groupBy);
    if (!resolved.ok) return resolved;
    groupBy = { def: resolved.def, values: groupValues(ctx, resolved.def.id) };
  }

  if (input.component === 'time') {
    totalMinor = computed.timeMinor;
    all = computed.time.map((row) => ({
      id: row.id,
      sourceKind: 'time_entry',
      amountMinor: timeValueMinor(row, basis.basis),
      orderKey: `${row.started_at}|${row.id}`,
      startedAt: row.started_at,
      minutes: row.minutes,
      rateMinor: row.rate_minor,
      rateCurrency: row.rate_currency,
      costRateMinor: row.cost_rate_minor,
      status: row.status,
      userId: row.user_id,
      phaseId: row.phase_id,
      notes: row.notes,
      ...(groupBy !== undefined ? { groupValue: groupBy.values.get(row.id) ?? null } : {}),
    }));
  } else if (input.component === 'expenses' || input.component === 'purchases') {
    // A posted, project-tagged A17 bill, whole (a bill is a single-line header): `purchases` when
    // 3-way matched, `expenses` otherwise, at the stored base net. `posted_entry_id` names the
    // journal entry behind every row (OR 957a traceability).
    const wantMatched = input.component === 'purchases' ? 1 : 0;
    const slice = computed.bills.filter((row) => row.matched === wantMatched);
    totalMinor = input.component === 'purchases' ? computed.purchasesMinor : computed.expensesMinor;
    all = slice.map((row) => ({
      id: row.id,
      sourceKind: 'vendor_bill',
      amountMinor: row.base_net_minor as number,
      orderKey: `${row.bill_date}|${row.id}`,
      billDate: row.bill_date,
      number: row.vendor_reference,
      vendorId: row.contact_id,
      postedEntryId: row.entry_id,
    }));
  } else if (input.component === 'accrued_purchases' || input.component === 'committed') {
    // A project-tagged D02 PO line: the accrual leg (received-not-billed at PO base price) or the
    // open order balance (ordered-not-received on a sent PO). Zero-quantity lines are omitted so
    // Σ(rows) == the card figure with no zero-amount padding.
    const isAccrual = input.component === 'accrued_purchases';
    totalMinor = isAccrual ? computed.accruedPurchasesMinor : computed.committedMinor;
    all = computed.poLines
      .map((row) => ({ row, qty: isAccrual ? unbilledQty(row) : openQty(row) }))
      .filter(({ qty }) => qty > 0)
      .map(({ row, qty }) => ({
        id: row.id,
        sourceKind: 'po_line',
        amountMinor: qty * row.unit_price_base_rappen,
        orderKey: `${row.po_created_at}|${row.id}`,
        poId: row.po_id,
        number: row.po_number,
        itemId: row.item_id,
        description: row.description,
        qty,
        unitPriceBaseMinor: row.unit_price_base_rappen,
      }));
  } else {
    // 'revenue': the posted invoice lines and the credit-note lines netting them, one merged
    // stream so Σ over every page equals the card's revenue figure exactly.
    totalMinor = computed.revenueMinor;
    const invoiceRows: DrilldownRow[] = computed.invoiceLines.map((row) => ({
      id: row.line_id,
      sourceKind: 'invoice_line',
      amountMinor: row.line_total_minor,
      orderKey: `${row.issue_date ?? row.created_at}|${row.line_id}`,
      documentId: row.document_id,
      number: row.number,
      issueDate: row.issue_date,
      description: row.description,
      currency: row.currency,
      postedEntryId: row.posted_entry_id,
    }));
    const creditRows: DrilldownRow[] = computed.creditLines.map((row) => ({
      id: row.line_id,
      sourceKind: 'credit_note_line',
      amountMinor: -row.line_total_minor,
      orderKey: `${row.issue_date ?? row.created_at}|${row.line_id}`,
      documentId: row.document_id,
      number: row.number,
      issueDate: row.issue_date,
      currency: row.currency,
      postedEntryId: row.posted_entry_id,
      creditedDocumentId: row.credited_document_id,
    }));
    all = [...invoiceRows, ...creditRows].sort((a, b) => a.orderKey.localeCompare(b.orderKey));
  }

  const limit = Math.min(Math.max(input.limit ?? DRILLDOWN_LIMIT, 1), DRILLDOWN_LIMIT_MAX);
  const start = input.cursor === undefined ? 0 : all.findIndex((row) => row.orderKey > (input.cursor as string));
  const window = start === -1 ? [] : all.slice(start, start + limit);
  const last = window[window.length - 1];
  const nextCursor = window.length === limit && last !== undefined ? last.orderKey : null;

  return ok({
    projectId: project.id,
    component: input.component,
    currency: baseCurrencyOf(ctx),
    basis: basis.basis,
    basisDegraded: basis.basis === 'cost' && computed.costRateMissing,
    totalMinor,
    rows: window.map(({ orderKey, ...row }) => ({ ...row, cursor: orderKey })),
    nextCursor,
    ...(groupBy !== undefined ? { groupBy: groupBy.def.key } : {}),
  });
}
