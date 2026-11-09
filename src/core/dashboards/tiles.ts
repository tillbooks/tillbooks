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
  // D186 (owner, 09.11.2026): the money ON the bank leads the page, a double-width tile.
  'bank_balance',
  'revenue',
  'cash',
  'ar_aging',
  'ap_aging',
  'utilisation',
  'project_margin',
  'mwst_due',
  'stock_value',
  'bank_inbox',
  // D186: the key-figure library. Each is a tile like any other: shown or hidden, ordered, sized and
  // compared per person (`overview.tiles`); `OVERVIEW_TILES_OFF_BY_DEFAULT` names the ones that start hidden.
  'free_cash',
  'runway',
  'low_point',
  'expense',
  'result',
  'margin',
  'revenue_ltm',
  'dso',
  'top_customer',
  'auto_rate',
  'receipt_rate',
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
  // D186: A39's balance line per Bankkonto (`list_bank_inbox`'s summary, gate `read_sales`), the linked
  // ledger accounts (`read_books`) and the A19 register (`read_master_data`).
  { tile: 'bank_balance', requires: ['read_sales', 'read_books', 'read_master_data'], glyph: '●', studioRoute: '/bank', mcpTool: 'list_bank_inbox' },
  { tile: 'revenue', requires: ['read_books'], glyph: '◆', studioRoute: '/reports', mcpTool: 'income_statement' },
  { tile: 'cash', requires: ['read_books', 'read_master_data'], glyph: '●', studioRoute: '/bank-accounts', mcpTool: 'list_bank_accounts' },
  { tile: 'ar_aging', requires: ['read_sales'], glyph: '◧', studioRoute: '/open-items', mcpTool: 'aging_report' },
  { tile: 'ap_aging', requires: ['read_books'], glyph: '◨', studioRoute: '/bills', mcpTool: 'list_vendor_bills' },
  { tile: 'utilisation', requires: ['time.read'], glyph: '◔', studioRoute: '/time', mcpTool: 'time_list' },
  { tile: 'project_margin', requires: ['costing.read'], glyph: '◭', studioRoute: '/projects', mcpTool: 'costing_pl_list' },
  { tile: 'mwst_due', requires: ['read_vat'], glyph: '▣', studioRoute: '/mwst', mcpTool: 'vat_return' },
  { tile: 'stock_value', requires: ['read_master_data'], glyph: '▦', studioRoute: '/inventory', mcpTool: 'stock_valuation_report' },
  // D142: the Übersicht's Bankeingang band. ALL-OF: `read_sales` is `list_bank_inbox`'s gate (the lines
  // and their facets), `read_books` is `bank_channel_status`'s (the fetch line). The Studio renders it as
  // the full-width band above the grid, not as a tile in it.
  { tile: 'bank_inbox', requires: ['read_sales', 'read_books'], glyph: '⇄', studioRoute: '/bank', mcpTool: 'list_bank_inbox' },
  // D186, the key-figure library. Each gate is the union of its sources' own gates (ALL-OF).
  // free_cash: the bank figure (above), the open creditors (`read_books`) and the MWST due (`read_vat`).
  { tile: 'free_cash', requires: ['read_sales', 'read_books', 'read_master_data', 'read_vat'], glyph: '◉', studioRoute: '/bank-accounts', mcpTool: 'dashboard_tile' },
  // runway: the bank figure over the Erfolgsrechnung's monthly expense (`read_books`).
  { tile: 'runway', requires: ['read_sales', 'read_books', 'read_master_data'], glyph: '◷', studioRoute: '/reports', mcpTool: 'income_statement' },
  { tile: 'expense', requires: ['read_books'], glyph: '◇', studioRoute: '/reports', mcpTool: 'income_statement' },
  { tile: 'result', requires: ['read_books'], glyph: '◈', studioRoute: '/reports', mcpTool: 'income_statement' },
  { tile: 'margin', requires: ['read_books'], glyph: '◐', studioRoute: '/reports', mcpTool: 'income_statement' },
  { tile: 'revenue_ltm', requires: ['read_books'], glyph: '◆', studioRoute: '/reports', mcpTool: 'income_statement' },
  // low_point: A40's `liquidity_forecast` and its gate.
  { tile: 'low_point', requires: ['read_books'], glyph: '◒', studioRoute: '/creditor-payments', mcpTool: 'liquidity_forecast' },
  // dso, top_customer: the invoices and their payments (`aging_report`'s gate) and the contact's name.
  { tile: 'dso', requires: ['read_sales'], glyph: '◫', studioRoute: '/open-items', mcpTool: 'aging_report' },
  { tile: 'top_customer', requires: ['read_sales', 'read_master_data'], glyph: '◩', studioRoute: '/contacts', mcpTool: 'get_contact' },
  // auto_rate, receipt_rate: the bank lines' decisions (`list_bank_inbox`'s and `bank_rule_stats`' gate).
  { tile: 'auto_rate', requires: ['read_sales'], glyph: '⟳', studioRoute: '/bank', mcpTool: 'bank_rule_stats' },
  { tile: 'receipt_rate', requires: ['read_sales'], glyph: '▤', studioRoute: '/bank', mcpTool: 'list_bank_inbox' },
];

const DEF_BY_TILE: ReadonlyMap<string, DashboardTileDef> = new Map(TILE_REGISTRY.map((d) => [d.tile, d]));

/** The registry row for a tile id, or undefined when it is not a registered tile. */
export function tileDef(tile: unknown): DashboardTileDef | undefined {
  return typeof tile === 'string' ? DEF_BY_TILE.get(tile) : undefined;
}
