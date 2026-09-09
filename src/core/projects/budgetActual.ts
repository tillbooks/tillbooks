/**
 * B00 US-B00.4: the budget-vs-actual read model, per project and per phase.
 *
 * A PURE QUERY (Pattern P5): computed live on every call, never cached in a table, and it WRITES
 * NOTHING. Two consecutive calls over unchanged data answer identically, which §7 asserts.
 *
 * COST ONLY, and that fence is structural: there is no revenue side and no margin here, because
 * project P&L belongs to B03 (US-B00.4's scope fence). The actual-cost side is drawn from the
 * `COST_SOURCES` seam below. Three sources register today: B01's `b01_time`
 * (`src/core/time/seams.ts`), and A17's `a17_bills` + D02's `d02_purchases`
 * (`src/core/purchase/costSeams.ts`, live since `vendor_bill.project_id` / `po_line.project_id`
 * landed with the B03 project cost dimension). Nothing here ever grows a branch per consumer (the
 * G09 `seams.ts` argument), and no source may write: a cost source is a query.
 *
 * Rollups over a mixed-currency subtree sum the BASE side (`budget_base_minor` where snapshotted,
 * the budget itself where the project is already in base), so §H-FX aggregation is exact integer
 * addition of already-snapshotted Rappen, no re-rating and no re-rounding (P2 round-once).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { readProject, mapProject } from './projects.js';
import type { ProjectRow } from './projects.js';
import type { PhaseRow } from './shared.js';

/**
 * One registered cost source: given a project, answer the integer Rappen of actual cost and the
 * integer minutes of actual time it can attribute, per phase (`null` phase = unattributed to any
 * phase). READ-ONLY by contract: a source is handed the ctx and must only SELECT.
 */
export interface CostSource {
  /** Names the owning capability in diagnostics (`b01_time`, `a17_bills`, `d02_purchases`). */
  readonly id: string;
  readonly actuals: (
    ctx: WorkspaceContext,
    project: ProjectRow,
  ) => readonly { phaseId: string | null; costMinor: number; hours: number }[];
}

const COST_SOURCES: CostSource[] = [];

export function registerCostSource(source: CostSource): void {
  COST_SOURCES.push(source);
}

interface Standing {
  budgetMinor: number;
  budgetHours: number;
  actualCostMinor: number;
  actualHours: number;
  remainingMinor: number;
  remainingHours: number;
  overBudget: boolean;
}

function standing(budgetMinor: number, budgetHours: number, actualCostMinor: number, actualHours: number): Standing {
  return {
    budgetMinor,
    budgetHours,
    actualCostMinor,
    actualHours,
    remainingMinor: budgetMinor - actualCostMinor,
    remainingHours: budgetHours - actualHours,
    overBudget: budgetMinor > 0 && actualCostMinor > budgetMinor,
  };
}

/** The base-currency figure a subtree rollup adds for one project (§H-FX: snapshot, never re-rate). */
function baseBudgetOf(row: ProjectRow): number {
  return row.budget_base_minor ?? row.budget_minor;
}

function directDescendants(ctx: WorkspaceContext, projectId: string): ProjectRow[] {
  return ctx.store.db
    .prepare('SELECT * FROM project WHERE workspace_id = ? AND parent_id = ?')
    .all(ctx.workspaceId, projectId) as ProjectRow[];
}

/** One project's actuals, per phase id, folded across every registered cost source. */
function actualsOf(
  ctx: WorkspaceContext,
  project: ProjectRow,
): { totalCostMinor: number; totalHours: number; perPhase: Map<string, { costMinor: number; hours: number }> } {
  const perPhase = new Map<string, { costMinor: number; hours: number }>();
  let totalCostMinor = 0;
  let totalHours = 0;
  for (const source of COST_SOURCES) {
    for (const row of source.actuals(ctx, project)) {
      totalCostMinor += row.costMinor;
      totalHours += row.hours;
      if (row.phaseId !== null) {
        const bucket = perPhase.get(row.phaseId) ?? { costMinor: 0, hours: 0 };
        bucket.costMinor += row.costMinor;
        bucket.hours += row.hours;
        perPhase.set(row.phaseId, bucket);
      }
    }
  }
  return { totalCostMinor, totalHours, perPhase };
}

export function projectBudgetActual(
  ctx: WorkspaceContext,
  input: { projectId: string; includeSubprojects?: boolean; asOf?: string },
): Result {
  const project = readProject(ctx, input.projectId);
  if (project === undefined) return err('project_not_found', { projectId: input.projectId });

  const { totalCostMinor, totalHours, perPhase } = actualsOf(ctx, project);

  const phases = ctx.store.db
    .prepare('SELECT * FROM project_phase WHERE workspace_id = ? AND project_id = ? ORDER BY sort, name')
    .all(ctx.workspaceId, project.id) as PhaseRow[];

  const phaseStandings = phases.map((phase) => {
    const actual = perPhase.get(phase.id) ?? { costMinor: 0, hours: 0 };
    return {
      phaseId: phase.id,
      name: phase.name,
      milestoneOn: phase.milestone_on,
      doneAt: phase.done_at,
      ...standing(phase.budget_minor, phase.budget_hours, actual.costMinor, actual.hours),
    };
  });

  // The headline standing is reported in the workspace BASE currency, because the cost seam answers
  // base Rappen by contract (`costSeams.ts`). Subtracting those from a project-currency budget mixed
  // two currencies into `remainingMinor` / `overBudget` for a non-base project; the fix subtracts base
  // from base by using the SAME snapshot the subtree rollup adds (`baseBudgetOf`), tagged base. For a
  // base-currency project this is a no-op: `budget_base_minor` is null so the fallback is the budget
  // itself, and `baseCurrencyOf` equals the project currency.
  const result: Record<string, unknown> = {
    project: mapProject(project),
    ...standing(baseBudgetOf(project), project.budget_hours, totalCostMinor, totalHours),
    currency: baseCurrencyOf(ctx),
    phases: phaseStandings,
  };

  if (input.includeSubprojects === true) {
    // The subtree rollup, in the workspace BASE currency: breadth-first over parent_id, bounded by
    // the visited set (a cycle cannot be created through the verbs, but a rollup must not hang on a
    // hand-edited database). Actuals from the seam are base-currency by contract.
    const base = { budgetBaseMinor: 0, actualCostMinor: 0, actualHours: 0, projectCount: 0 };
    const seen = new Set<string>();
    const queue: ProjectRow[] = [project];
    while (queue.length > 0) {
      const current = queue.shift() as ProjectRow;
      if (seen.has(current.id)) continue;
      seen.add(current.id);
      base.projectCount += 1;
      base.budgetBaseMinor += baseBudgetOf(current);
      const actuals = current.id === project.id ? { totalCostMinor, totalHours } : (() => {
        const a = actualsOf(ctx, current);
        return { totalCostMinor: a.totalCostMinor, totalHours: a.totalHours };
      })();
      base.actualCostMinor += actuals.totalCostMinor;
      base.actualHours += actuals.totalHours;
      queue.push(...directDescendants(ctx, current.id));
    }
    result.subtree = {
      ...base,
      remainingBaseMinor: base.budgetBaseMinor - base.actualCostMinor,
      overBudget: base.budgetBaseMinor > 0 && base.actualCostMinor > base.budgetBaseMinor,
    };
  }

  return ok(result);
}
