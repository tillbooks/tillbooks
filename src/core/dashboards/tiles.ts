/**
 * F00 §H-ENUM: the DASHBOARD TILE REGISTRY, the single source for what a dashboard can show.
 *
 * One entry per core tile: its id, the A24 capability set the viewer must hold (US-F00.6, exactly
 * the SOURCE verbs' own read gates, so seeing a tile is never easier than calling the verb behind
 * it), the decorative glyph, and the drill target (US-F00.2: the EXISTING Studio route and the
 * EXISTING MCP tool that answer for the figure, F00 mints no proxies).
 *
 * Adding a core tile is one entry here plus a consistency test in `test/dashboards/`. A plugin
 * tile (G02) is a filed, not built, extension of the same shape: the registry is additive for it
 * and nothing else in F00 changes.
 */

import type { Capability } from '../access/capabilities.js';

/** The closed set of core tile ids (§H-ENUM, spec §4). */
export const DASHBOARD_TILES = [
  'revenue',
  'cash',
  'ar_aging',
  'ap_aging',
  'utilisation',
  'project_margin',
  'mwst_due',
  'stock_value',
] as const;

export type DashboardTile = (typeof DASHBOARD_TILES)[number];

const TILE_SET: ReadonlySet<string> = new Set(DASHBOARD_TILES);

export function isDashboardTile(x: unknown): x is DashboardTile {
  return typeof x === 'string' && TILE_SET.has(x);
}

/** One registry entry: what a tile needs, and where its figure really lives. */
export interface DashboardTileDef {
  readonly tile: DashboardTile;
  /**
   * The A24 capabilities the viewer must hold to see this tile, ALL of them (US-F00.6). These are
   * the source verbs' OWN gates cited, never redefined: `read_books` because `income_statement` /
   * `general_ledger` / `list_vendor_bills` gate on it, `read_sales` because `aging_report` does,
   * `read_vat` for `vat_return`, `read_master_data` for `list_bank_accounts` /
   * `stock_valuation_report`, `time.read` for `time_list`, `costing.read` for `costing_pl_list`.
   */
  readonly requires: readonly Capability[];
  /** Decorative glyph; the Studio pairs it with a text label, never colour or shape alone. */
  readonly glyph: string;
  /** The existing Studio route a click lands on. */
  readonly studioRoute: string;
  /** The existing MCP tool an agent drills into. */
  readonly mcpTool: string;
}

/**
 * The registry, in default render order. The cash tile requires BOTH `read_books` (the Kontoblatt
 * balances) and `read_master_data` (the A19 account list it walks), the ALL-OF form.
 */
export const TILE_REGISTRY: readonly DashboardTileDef[] = [
  { tile: 'revenue', requires: ['read_books'], glyph: '◆', studioRoute: '/reports', mcpTool: 'income_statement' },
  { tile: 'cash', requires: ['read_books', 'read_master_data'], glyph: '●', studioRoute: '/bank-accounts', mcpTool: 'list_bank_accounts' },
  { tile: 'ar_aging', requires: ['read_sales'], glyph: '◧', studioRoute: '/open-items', mcpTool: 'aging_report' },
  { tile: 'ap_aging', requires: ['read_books'], glyph: '◨', studioRoute: '/bills', mcpTool: 'list_vendor_bills' },
  { tile: 'utilisation', requires: ['time.read'], glyph: '◔', studioRoute: '/time', mcpTool: 'time_list' },
  { tile: 'project_margin', requires: ['costing.read'], glyph: '◭', studioRoute: '/projects', mcpTool: 'costing_pl_list' },
  { tile: 'mwst_due', requires: ['read_vat'], glyph: '▣', studioRoute: '/mwst', mcpTool: 'vat_return' },
  { tile: 'stock_value', requires: ['read_master_data'], glyph: '▦', studioRoute: '/inventory', mcpTool: 'stock_valuation_report' },
];

const DEF_BY_TILE: ReadonlyMap<string, DashboardTileDef> = new Map(TILE_REGISTRY.map((d) => [d.tile, d]));

/** The registry row for a tile id, or undefined when it is not a registered tile. */
export function tileDef(tile: unknown): DashboardTileDef | undefined {
  return typeof tile === 'string' ? DEF_BY_TILE.get(tile) : undefined;
}
