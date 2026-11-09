/**
 * C03, sales forecasting: the barrel `src/api/` imports from. Pure reads only (P5): this module
 * exports no write verb and owns no table.
 */

export { weightedPipeline, salesKpis, revenue, vsActual, parsePeriod, FORECAST_GROUP_BY, HORIZON_MIN, HORIZON_MAX } from './forecast.js';
export type { WeightedPipelineInput, SalesKpisInput, RevenueInput, VsActualInput, ForecastGroupBy } from './forecast.js';
