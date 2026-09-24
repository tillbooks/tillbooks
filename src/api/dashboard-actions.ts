/**
 * F00's two verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `costingActions` precedent), so several agents appending to the append-only registry at once
 * collide over a line rather than a block.
 *
 * TWO READS AND NOT ONE WRITE, the B03/A08 shape: F00 owns no table and posts nothing (pure P5),
 * so both tools carry `readOnlyHint` on MCP, neither carries an `idempotency_key`, and there is no
 * conformance write scenario to write. Both opt into `READ_SCENARIOS` instead, and
 * `test/dashboards/` holds the read-only claim up by census and by static scan rather than by
 * trusting this comment.
 *
 * RBAC is PER TILE, not per verb (spec US-F00.6): each tile in `src/core/dashboards/tiles.ts`
 * declares the source verbs' own read gates, the engine asserts them via `ctx.capabilities`, and a
 * tile the caller may not see is OMITTED server-side. The boundary declaration in
 * `actionCapabilities.ts` is therefore `ungated('asserted_in_engine', ...)`: gating the whole verb
 * on any one read domain would either deny an operations-only role its permitted tiles or leak a
 * financial tile past a role that lacks the source verb's own gate.
 *
 * The descriptions name the German report words (Übersicht, Kacheln, Umsatz, Auslastung, MWST
 * fällig) the way A08 names Bilanz and Erfolgsrechnung, so an agent asked "wie läuft das Geschäft?"
 * can find the verb. They also say what a degraded tile means, because an agent will quote them: a
 * `needs_projects` tile is a module not in use, not a measured zero.
 *
 * As with every sibling module, the helpers arrive as a parameter rather than an import, so the
 * module graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { dashboardOverview, dashboardTile, DASHBOARD_TILES } from '../core/dashboards/index.js';

export interface DashboardActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The F00 verbs, in append order. */
export function dashboardActions(h: DashboardActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;

  return [
    ctxAction(
      'dashboard_overview',
      'read',
      `Die Übersicht (dashboard): one KPI tile wall for a date range, composed live from the read models the product already computes and never cached (pure read, F00 posts nothing and owns no tables). Core tiles: ${DASHBOARD_TILES.join(' | ')}, each an integer-Rappen (or basis-point) figure that equals its source verb's answer for the same filter: revenue from income_statement (the Nettoerlöse section, with a previous-window trendBp), cash from the A19 bank accounts' Kontoblatt closing balances (general_ledger), AR from aging_report, AP from list_vendor_bills, utilisation as the billable share of time_list minutes (B01 has no capacity model), margin from costing_pl_list, MWST due verbatim from vat_return for the settlement period containing the range end, stock value from stock_valuation_report under the books' method. Every tile embeds a drill descriptor (studioRoute, mcpTool, params) naming the EXISTING source tool behind the number: call that tool for the rows. Tiles the caller's A24 role may not see are omitted server-side into omitted[] (per-tile gates: read_books, read_sales, read_vat, read_master_data, time.read, costing.read); an unconfigured or unused module degrades its one tile to ok:false with the source's own code (needs_vat_config, needs_chart, needs_projects, needs_stock_items) while the rest still render; an empty workspace answers ok:true zero states, never an error. from > to answers invalid_range. savedViewId applies a G00 saved view (entityKind 'workspace', layout 'dashboard') to restrict and order tiles; an unresolvable view falls back to the full default with viewFallback:true and can never widen access.`,
      ctxSchema({ from: STR, to: STR, savedViewId: STR }, ['from', 'to']),
      (ctx, input) => dashboardOverview(ctx, as(input)),
    ),
    ctxAction(
      'dashboard_tile',
      'read',
      `Eine Kachel der Übersicht in voller Tiefe: the same figure dashboard_overview shows for '${DASHBOARD_TILES.join("' | '")}', plus its detail block (the aging buckets behind the Debitoren figure, the top and bottom projects behind the Marge, the MWST settlement period and filed flag, the per-bank-account closing balances) and the drill descriptor naming the source tool that owns the rows. The value is the source verb's own answer, recomputed on every call; F00 fabricates nothing. An unknown tile id answers unknown_tile naming the valid set; a tile the caller's A24 role may not see answers permission_denied outright (the same per-tile gate the overview applies as an omission); an unavailable module answers the tile with ok:false and the source's own structured code.`,
      ctxSchema({ tile: STR, from: STR, to: STR }, ['tile', 'from', 'to']),
      (ctx, input) => dashboardTile(ctx, as(input)),
    ),
  ];
}
