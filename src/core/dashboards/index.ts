/**
 * F00, Dashboards & KPIs: the barrel `src/api/` imports from.
 *
 * A PURE READ MODEL (P5): no schema file, no writes, no events. The two verbs compose the read
 * models the product already computes (A08/A16/A17/A07/B01/B03/D01, plus A19's account list and
 * G00's saved views) into one tile wall; see `dashboards.ts` for the per-tile source contract and
 * `tiles.ts` for the §H-ENUM tile registry.
 */

export { dashboardOverview, dashboardTile } from './dashboards.js';
export type { DashboardOverviewInput, DashboardTileInput } from './dashboards.js';
export { DASHBOARD_TILES, TILE_REGISTRY, isDashboardTile, tileDef } from './tiles.js';
export type { DashboardTile, DashboardTileDef } from './tiles.js';
