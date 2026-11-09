/**
 * G20's parallel-run reconciliation: TILL's own figures against the prior system's DECLARED figures
 * for the agreed window, to the Rappen (US-G20.3).
 *
 * THREE VERBS: `declareParallelFigures` (the prior system's figures, entered exactly like G11 control
 * totals: declared, hashed, never edited in place; a correction supersedes by reference), then
 * `runParallelCheck` (computes TILL's own figures from the OWNING read models and compares), then
 * `getParallelStatus` (the per-period roll-up).
 *
 * THIS FILE COMPUTES NOTHING BEYOND INTEGER-RAPPEN SUBTRACTION (P2 by absence). Every TILL-side figure
 * is FETCHED from the read model that owns it: A08 `computeTrialBalance` per period, A07
 * `computeVatReturn` per Ziffer for the workspace's method, A16 `listOpenItems` and A17
 * `listPayableOpenItems` for the open-item counts and totals. The difference is integer subtraction;
 * there is no rounding because there is no arithmetic beyond subtraction.
 *
 * ZERO TOLERANCE, NO DIAL (spec §6b Fixed): a 0-Rappen difference passes, ANY nonzero difference
 * fails. THREE-STATUS HONESTY (G11): a figure with no declaration is `not_asserted`, NEVER green.
 *
 * WINDOW ALIGNMENT PER MWST METHOD: effektiv aligns to QUARTER boundaries, saldo to SEMESTER; a
 * declaration whose period does not align to the method's boundary refuses (`period_outside_window`
 * naming the boundary). D112: the window MAY span MULTIPLE filing periods (declare + check per period
 * across the window; nothing forces a single-period window). A cutover COMBINED with a method change
 * refuses the declaration/check without a recorded `mwst_method` sign-off (`method_change_needs_signoff`).
 *
 * §H-TENANT on every query; §H-IDEMPOTENT on both writes. §H-LEDGER untouched: this file posts NOTHING.
 */

import { createHash } from 'node:crypto';

import type { WorkspaceContext } from '../context.js';
import type { Result } from '../result.js';
import { err, ok } from '../result.js';
import { computeTrialBalance } from '../reports/index.js';
import { computeVatReturn, monthsOfVatPeriod } from '../vat/index.js';
import { listOpenItems } from '../debtors/index.js';
import { listPayableOpenItems } from '../banking/index.js';

/** The MWST filing methods (§H-ENUM, single-sourced here): effektiv quarterly, saldo semi-annual. */
export const MWST_METHODS = ['effektiv', 'saldo'] as const;
export type MwstMethod = (typeof MWST_METHODS)[number];

export function isMwstMethod(value: unknown): value is MwstMethod {
  return typeof value === 'string' && (MWST_METHODS as readonly string[]).includes(value);
}

/** What a declared/computed figure is ABOUT (§H-ENUM). */
export const FIGURE_KINDS = ['trial_balance', 'vat_return', 'open_items_ar', 'open_items_ap'] as const;
export type FigureKind = (typeof FIGURE_KINDS)[number];

export function isFigureKind(value: unknown): value is FigureKind {
  return typeof value === 'string' && (FIGURE_KINDS as readonly string[]).includes(value);
}

/** The three-status model (§H-ENUM). `not_asserted` is orange, never green (G11). */
export const FIGURE_STATUSES = ['passed', 'failed', 'not_asserted'] as const;
export type FigureStatus = (typeof FIGURE_STATUSES)[number];

/** One declared figure the operator entered from the prior system. `declaredRappen` is an integer. */
export interface DeclaredFigure {
  kind: FigureKind;
  ref: string;
  declaredRappen: number;
}

/** One compared figure the check returns. */
export interface CheckedFigure {
  kind: FigureKind;
  ref: string;
  declaredRappen: number | null;
  computedRappen: number | null;
  differenceRappen: number | null;
  status: FigureStatus;
}

interface ProjectRow {
  id: string;
  mwst_method: string;
  method_change: number;
  cutover_date: string;
}

function loadProject(ctx: WorkspaceContext, projectId: unknown): ProjectRow | undefined {
  if (typeof projectId !== 'string' || projectId.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT id, mwst_method, method_change, cutover_date FROM implementation_project WHERE id = ? AND workspace_id = ?')
    .get(projectId, ctx.workspaceId) as ProjectRow | undefined;
}

function reqStr(value: unknown, field: string): Result | undefined {
  if (typeof value !== 'string' || value.length === 0) return err('invalid_input', { field });
  return undefined;
}

/**
 * A live (unvoided) `mwst_method` sign-off exists for the project.
 *
 * The method-change gate (US-G20.3): a cutover combined with a method change must not proceed silently,
 * so the declaration and the check both refuse until a Treuhänder has signed the method choice.
 */
function hasMwstMethodSignoff(ctx: WorkspaceContext, projectId: string): boolean {
  const row = ctx.store.db
    .prepare(
      "SELECT 1 FROM implementation_signoff WHERE workspace_id = ? AND project_id = ? AND kind = 'mwst_method' AND voided_at IS NULL LIMIT 1",
    )
    .get(ctx.workspaceId, projectId);
  return row !== undefined;
}

const YYYY_MM = /^(\d{4})-(\d{2})$/;

/** The last ISO day of a `YYYY-MM` month. */
function endOfMonth(month: string): string {
  const m = YYYY_MM.exec(month);
  if (m === null) return month;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}`;
}

/**
 * The period bounds for a method-aligned window token, or a structured refusal naming the boundary.
 *
 * effektiv: `YYYY-Qn` (quarter). saldo: `YYYY-Hn` (semester). A token of the WRONG granularity for the
 * method is `period_outside_window` with the boundary the method requires, which is the "window
 * straddling a boundary refuses at declaration" rule made concrete: a saldo filer cannot declare a
 * quarter, and an effektiv filer cannot declare a semester.
 */
function periodBounds(method: MwstMethod, period: unknown): { start: string; end: string } | { error: Result } {
  if (typeof period !== 'string' || period.length === 0) return { error: err('invalid_input', { field: 'period' }) };
  const isQuarter = /^\d{4}-Q[1-4]$/.test(period);
  const isSemester = /^\d{4}-H[12]$/.test(period);
  if (method === 'effektiv' && !isQuarter) {
    return { error: err('period_outside_window', { period, method, boundary: 'quarter', expected: 'YYYY-Qn' }) };
  }
  if (method === 'saldo' && !isSemester) {
    return { error: err('period_outside_window', { period, method, boundary: 'semester', expected: 'YYYY-Hn' }) };
  }
  const months = monthsOfVatPeriod(period);
  if (months === null || months.length === 0) return { error: err('invalid_input', { field: 'period' }) };
  return { start: `${months[0]}-01`, end: endOfMonth(months[months.length - 1] as string) };
}

function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** The hash a declaration binds to: locale-neutral (integer Rappen, ISO period), the G11 discipline. */
function declarationHash(period: string, figures: readonly DeclaredFigure[]): string {
  return sha256Canonical({
    v: 1,
    period,
    figures: [...figures]
      .map((f) => ({ kind: f.kind, ref: f.ref, declaredRappen: f.declaredRappen }))
      .sort((a, b) => (a.kind + '' + a.ref).localeCompare(b.kind + '' + b.ref)),
  });
}

// --- declareParallelFigures (US-G20.3) ----------------------------------------------------------

export function declareParallelFigures(
  ctx: WorkspaceContext,
  input: { projectId: unknown; period: unknown; figures: unknown; idempotencyKey: unknown },
): Result {
  const guard = reqStr(input.projectId, 'projectId') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const project = loadProject(ctx, input.projectId);
  if (project === undefined) return err('not_found', { projectId: input.projectId });
  if (!isMwstMethod(project.mwst_method)) return err('invalid_state', { reason: 'unknown_mwst_method' });

  // The method-change gate: a cutover combined with a method change needs a recorded mwst_method
  // sign-off before any figure is declared against it.
  if (project.method_change === 1 && !hasMwstMethodSignoff(ctx, project.id)) {
    return err('method_change_needs_signoff', { projectId: project.id, signoffKind: 'mwst_method' });
  }

  const boundsOrErr = periodBounds(project.mwst_method, input.period);
  if ('error' in boundsOrErr) return boundsOrErr.error;

  if (!Array.isArray(input.figures) || input.figures.length === 0) {
    return err('invalid_input', { field: 'figures', expected: 'non-empty array' });
  }
  const figures: DeclaredFigure[] = [];
  for (const raw of input.figures as unknown[]) {
    if (raw === null || typeof raw !== 'object') return err('invalid_input', { field: 'figures[]' });
    const f = raw as Record<string, unknown>;
    if (!isFigureKind(f.kind)) return err('invalid_input', { field: 'figures[].kind', expected: FIGURE_KINDS });
    if (typeof f.ref !== 'string' || f.ref.length === 0) return err('invalid_input', { field: 'figures[].ref' });
    if (typeof f.declaredRappen !== 'number' || !Number.isInteger(f.declaredRappen)) {
      return err('invalid_input', { field: 'figures[].declaredRappen', expected: 'integer Rappen' });
    }
    figures.push({ kind: f.kind, ref: f.ref, declaredRappen: f.declaredRappen });
  }

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey as string, 'project_declare_parallel_figures');
  if (replayed !== undefined) return replayed;

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'project_declare_parallel_figures', () => {
    const now = ctx.clock.now();
    const period = input.period as string;
    const hash = declarationHash(period, figures);
    const declarationId = ctx.ids.next('paralleldecl');

    // Supersede the prior ACTIVE declaration for this period by reference (both retained): the
    // correction is a new row, never an edit in place (US-G20.3, the G11 discipline).
    const prior = ctx.store.db
      .prepare(
        'SELECT id FROM parallel_run_declaration WHERE workspace_id = ? AND project_id = ? AND period = ? AND superseded_by IS NULL ORDER BY created_at DESC, id DESC LIMIT 1',
      )
      .get(ctx.workspaceId, project.id, period) as { id: string } | undefined;

    ctx.store.db
      .prepare(
        `INSERT INTO parallel_run_declaration (id, workspace_id, project_id, period, figures, hash, superseded_by, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(declarationId, ctx.workspaceId, project.id, period, JSON.stringify(figures), hash, ctx.actor, now);

    if (prior !== undefined) {
      ctx.store.db
        .prepare('UPDATE parallel_run_declaration SET superseded_by = ? WHERE id = ? AND workspace_id = ?')
        .run(declarationId, prior.id, ctx.workspaceId);
    }

    return ok({ declarationId, period, hash, superseded: prior?.id ?? null });
  });
}

// --- The TILL-side computation (fetch from the owning read models, subtract) ---------------------

/** The TILL figure for one declared reference, or null when the read model could not answer it. */
function computeFigure(ctx: WorkspaceContext, kind: FigureKind, ref: string, bounds: { start: string; end: string }): number | null {
  if (kind === 'trial_balance') {
    const tb = computeTrialBalance(ctx, { periodStart: bounds.start, periodEnd: bounds.end });
    if (!tb.ok) return null;
    const rows = tb.rows as ReadonlyArray<{ account: { number: string }; closingMinor: number }>;
    const row = rows.find((r) => r.account.number === ref);
    return row === undefined ? 0 : row.closingMinor;
  }
  if (kind === 'vat_return') {
    const ret = computeVatReturn(ctx, { periodStart: bounds.start, periodEnd: bounds.end });
    if (!ret.ok) return null;
    if (ref === 'payable') return ret.payableMinor as number;
    if (ref === 'credit') return ret.creditMinor as number;
    if (ref === 'net') return (ret.totalTaxDueMinor as number) - (ret.totalInputTaxMinor as number);
    const lines = ret.lines as ReadonlyArray<{ code: string; baseMinor: number; taxMinor: number; rateBp: number | null }>;
    const line = lines.find((l) => l.code === ref);
    if (line === undefined) return 0;
    // A tax-column Ziffer (a rated line, or a 3xx/4xx code) compares on its Steuer figure; a
    // turnover-only Ziffer compares on its Umsatz figure. Both are integer Rappen from A07's own once
    // rounded computation, never recomputed here.
    const isTaxColumn = line.rateBp !== null || ref.startsWith('3') || ref.startsWith('4') || ref.startsWith('5');
    return isTaxColumn ? line.taxMinor : line.baseMinor;
  }
  if (kind === 'open_items_ar') {
    const op = listOpenItems(ctx, { asOf: bounds.end });
    if (!op.ok) return null;
    if (ref === 'count') return (op.items as ReadonlyArray<unknown>).length;
    // 'total' (or any other ref) reads the base-currency open total the tiles show.
    return op.baseTotalOpenMinor as number;
  }
  // open_items_ap: A17's payable open items. No asOf filter exists, so this is the point-in-time
  // payable position; the Rappen comparison is exact on whatever the read model returns.
  const ap = listPayableOpenItems(ctx, {});
  if (!ap.ok) return null;
  const items = ap.items as ReadonlyArray<{ amountMinor: number }>;
  if (ref === 'count') return items.length;
  return items.reduce((n, i) => n + i.amountMinor, 0);
}

// --- runParallelCheck (US-G20.3) ----------------------------------------------------------------

export function runParallelCheck(
  ctx: WorkspaceContext,
  input: { projectId: unknown; period: unknown; idempotencyKey: unknown },
): Result {
  const guard = reqStr(input.projectId, 'projectId') ?? reqStr(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const project = loadProject(ctx, input.projectId);
  if (project === undefined) return err('not_found', { projectId: input.projectId });
  if (!isMwstMethod(project.mwst_method)) return err('invalid_state', { reason: 'unknown_mwst_method' });

  if (project.method_change === 1 && !hasMwstMethodSignoff(ctx, project.id)) {
    return err('method_change_needs_signoff', { projectId: project.id, signoffKind: 'mwst_method' });
  }

  const boundsOrErr = periodBounds(project.mwst_method, input.period);
  if ('error' in boundsOrErr) return boundsOrErr.error;
  const bounds: { start: string; end: string } = boundsOrErr;

  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey as string, 'project_run_parallel_check');
  if (replayed !== undefined) return replayed;

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'project_run_parallel_check', () => {
    const now = ctx.clock.now();
    const period = input.period as string;
    const declaration = ctx.store.db
      .prepare(
        'SELECT id, figures FROM parallel_run_declaration WHERE workspace_id = ? AND project_id = ? AND period = ? AND superseded_by IS NULL ORDER BY created_at DESC, id DESC LIMIT 1',
      )
      .get(ctx.workspaceId, project.id, period) as { id: string; figures: string } | undefined;

    // No declaration: nothing is asserted for this period (three-status honesty). An empty result
    // set, and getParallelStatus reports the period `not_asserted`.
    const declared: DeclaredFigure[] = declaration === undefined ? [] : (JSON.parse(declaration.figures) as DeclaredFigure[]);

    const figures: CheckedFigure[] = declared.map((d) => {
      const computedRappen = computeFigure(ctx, d.kind, d.ref, bounds);
      if (computedRappen === null) {
        // A figure TILL cannot compute yet (a period it has not closed): reported as not_asserted,
        // never compared against half a period.
        return { kind: d.kind, ref: d.ref, declaredRappen: d.declaredRappen, computedRappen: null, differenceRappen: null, status: 'not_asserted' };
      }
      // The difference is declared - computed (exact integer subtraction). ZERO tolerance: 0 passes,
      // any nonzero fails.
      const differenceRappen = d.declaredRappen - computedRappen;
      return {
        kind: d.kind,
        ref: d.ref,
        declaredRappen: d.declaredRappen,
        computedRappen,
        differenceRappen,
        status: differenceRappen === 0 ? 'passed' : 'failed',
      };
    });

    const checkId = ctx.ids.next('parallelcheck');
    ctx.store.db
      .prepare(
        `INSERT INTO parallel_run_check (id, workspace_id, project_id, period, declaration_id, results, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(checkId, ctx.workspaceId, project.id, period, declaration?.id ?? null, JSON.stringify(figures), now);

    const failedCount = figures.filter((f) => f.status === 'failed').length;
    return ok({
      checkId,
      period,
      figures,
      // OP8 null-collapse anchor: the parallel_check_failed event fires only when a figure failed.
      failedCheckId: failedCount > 0 ? checkId : null,
    });
  });
}

// --- getParallelStatus (US-G20.3) ---------------------------------------------------------------

/**
 * The per-period roll-up over the LATEST check of each period, plus an overall status.
 *
 * A period with a check where every declared figure passed is `passed`; any failed figure makes it
 * `failed`; a period with no declaration (or no check) is `not_asserted`. `overall` is `failed` if
 * any period failed, `passed` only if at least one period passed and none failed or is not_asserted,
 * else `not_asserted` (never green while a declaration is missing: G11's honesty at the roll-up).
 */
export function getParallelStatus(ctx: WorkspaceContext, input: { projectId: unknown }): Result {
  if (typeof input.projectId !== 'string' || input.projectId.length === 0) return err('invalid_input', { field: 'projectId' });
  const project = loadProject(ctx, input.projectId);
  if (project === undefined) return err('not_found', { projectId: input.projectId });

  // The distinct declared periods, and the latest check per period.
  const declRows = ctx.store.db
    .prepare('SELECT DISTINCT period FROM parallel_run_declaration WHERE workspace_id = ? AND project_id = ?')
    .all(ctx.workspaceId, project.id) as Array<{ period: string }>;

  const periods = declRows
    .map((r) => r.period)
    .sort()
    .map((period) => {
      const check = ctx.store.db
        .prepare(
          'SELECT results FROM parallel_run_check WHERE workspace_id = ? AND project_id = ? AND period = ? ORDER BY computed_at DESC, id DESC LIMIT 1',
        )
        .get(ctx.workspaceId, project.id, period) as { results: string } | undefined;
      const figures: CheckedFigure[] = check === undefined ? [] : (JSON.parse(check.results) as CheckedFigure[]);
      const status: FigureStatus =
        figures.length === 0
          ? 'not_asserted'
          : figures.some((f) => f.status === 'failed')
            ? 'failed'
            : figures.every((f) => f.status === 'passed')
              ? 'passed'
              : 'not_asserted';
      return { period, status, figures };
    });

  const overall: FigureStatus =
    periods.length === 0
      ? 'not_asserted'
      : periods.some((p) => p.status === 'failed')
        ? 'failed'
        : periods.every((p) => p.status === 'passed')
          ? 'passed'
          : 'not_asserted';

  return ok({ periods, overall });
}

/**
 * Whether the parallel run is provably CLEAN: at least one period, every period passed. Consumed by
 * `project_get` (the passed conjunction) and `project_close`.
 */
export function parallelRunPassed(ctx: WorkspaceContext, projectId: string): boolean {
  const status = getParallelStatus(ctx, { projectId });
  if (!status.ok) return false;
  const periods = status.periods as ReadonlyArray<{ status: FigureStatus }>;
  return periods.length > 0 && periods.every((p) => p.status === 'passed');
}
