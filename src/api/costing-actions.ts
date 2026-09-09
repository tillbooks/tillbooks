/**
 * B03's four verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `projectActions` / `billingActions` precedent), so several agents appending to the append-only
 * registry at once collide over a line rather than a block.
 *
 * FOUR READS AND NOT ONE WRITE, the A08 shape one register over: B03 owns no table and posts
 * nothing (pure P5), so every tool carries `readOnlyHint` on MCP, none carries an
 * `idempotency_key`, and there is no conformance write scenario to write. All four opt into
 * `READ_SCENARIOS` instead, and `test/costing/` holds the read-only claim up by census and by
 * static scan rather than by trusting this comment.
 *
 * Every call gates on A24 `costing.read` (see `actionCapabilities.ts`): the profitability layer is
 * a separate right from B00's master-data reads because the cost basis is where employee pay data
 * will surface once the cost-rate column lands (revDSG data minimization, spec §3).
 *
 * The descriptions name the German report words (`Projekterfolg`, `Marge`, `Budgetvergleich`) the
 * way A08 names Bilanz and Erfolgsrechnung, so an agent asked "verdient das Projekt etwas?" can
 * find the verb. They also say where each cost component attributes FROM (the A17/D02 project
 * tags, the OP1 cost-rate snapshot), because an agent will quote them.
 *
 * As with every sibling module, the helpers arrive as a parameter rather than an import, so the
 * module graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  costingProjectPl,
  costingPlList,
  costingBudgetVsActual,
  costingDrilldown,
  COSTING_COMPONENTS,
  COSTING_BASES,
} from '../core/costing/index.js';

export interface CostingActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
  BOOL: { readonly type: 'boolean' };
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The B03 verbs, in append order. */
export function costingActions(h: CostingActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;

  return [
    ctxAction(
      'costing_project_pl',
      'read',
      `Projekterfolg (project P&L card): revenue vs cost for ONE project in integer Rappen, recomputed live from the source rows on every call (pure read, B03 posts nothing and caches nothing). Cost splits into ${COSTING_COMPONENTS.filter((c) => c !== 'revenue' && c !== 'committed').join(' | ')}: 'time' is B01 entries at their OP1 snapshot rate (approved and beyond; includeOpenTime widens to open/submitted WIP), 'expenses' and 'purchases' are POSTED project-tagged A17 vendor bills at stored base net (purchases when 3-way matched to a D02 PO, expenses otherwise), 'accrued_purchases' is received-not-yet-billed project-tagged D02 quantity at PO base price (it drops as the matched bill posts, so no Rappen counts twice). committedMinor (ordered minus received on open POs) reports BESIDE the cost, never inside it. Revenue counts POSTED invoice lines generated from this project's time (B02's linkage), net of posted credit notes; drafts never count. marginBp is null when revenue is 0, never a fake break-even. basis '${COSTING_BASES.join("' or '")}': 'cost' values time at the rate card's cost-rate snapshot and falls back per entry to the bill rate with basisDegraded true where none was defined. asOf cuts every component by its source date. groupBy re-buckets the time component by a confirmed select custom field on time_entry without moving any total. A row priced in a non-base currency answers fx_base_missing rather than mixing currencies.`,
      ctxSchema(
        { projectId: STR, asOf: STR, basis: STR, includeOpenTime: BOOL, groupBy: STR },
        ['projectId'],
      ),
      (ctx, input) => costingProjectPl(ctx, as(input)),
    ),
    ctxAction(
      'costing_pl_list',
      'read',
      `Projekterfolg-Portfolio (P&L list): one revenue/cost/margin summary row per project, margin-sorted (die Marge, descending), the read that answers "welche Projekte oder Mandate tragen?". Closed projects are excluded unless status='closed' asks for them; any single B00 status filters exactly. A project with foreign-currency rows degrades to fxBaseMissing:true instead of blanking the portfolio. savedViewId applies a G00 saved view over the project entity kind: its stored filters merge underneath any filter named explicitly here. Same computation and same honesty flags as costing_project_pl (basisDegraded when a cost-basis entry lacks a cost rate).`,
      ctxSchema({ status: STR, asOf: STR, basis: STR, includeOpenTime: BOOL, savedViewId: STR }),
      (ctx, input) => costingPlList(ctx, as(input)),
    ),
    ctxAction(
      'costing_budget_vs_actual',
      'read',
      `Budgetvergleich (budget vs actual) for one project, in the workspace base currency: the B00 budget (the H-FX base snapshot where one was taken) against B03's cost-to-date (time at snapshot rates plus posted project bills plus the received-not-billed purchase accrual, the same terms B00's own budget seam reports), with remainingMinor, consumedBp (basis points, rounded once), logged hours vs budgetHours, and the overBudget flag. A project without budget fields answers budgeted:false and cost-to-date only, never a fake 0-budget overrun. remainingMinor goes negative on overrun, which an automation rule can read as condition data to fire an existing action (B03 emits no events of its own).`,
      ctxSchema({ projectId: STR, asOf: STR, includeOpenTime: BOOL }, ['projectId']),
      (ctx, input) => costingBudgetVsActual(ctx, as(input)),
    ),
    ctxAction(
      'costing_drilldown',
      'read',
      `Die Belege hinter dem Projekterfolg: the raw contributing rows for ONE component ('${COSTING_COMPONENTS.join("' | '")}'), so every Rappen of the margin resolves to its source: time entries with snapshot rates and minutes, posted vendor bills with their postedEntryId, PO lines with quantity and base unit price, posted invoice lines and credit-note lines with their postedEntryId (the OR 957a traceability chain into the journal). Keyset-paginated (cursor/nextCursor, limit up to 500); totalMinor is the whole component and equals the card figure exactly, same code path. A component whose source rows carry no project reference answers zero rows with unattributable:true (none does today). An unknown component answers invalid_component.`,
      ctxSchema(
        {
          projectId: STR,
          component: STR,
          asOf: STR,
          basis: STR,
          includeOpenTime: BOOL,
          groupBy: STR,
          cursor: STR,
          limit: INT,
        },
        ['projectId', 'component'],
      ),
      (ctx, input) => costingDrilldown(ctx, as(input)),
    ),
  ];
}
