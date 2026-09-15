/** §H-FX: the rate store, rate resolution, and the integer rate arithmetic the ledger converts with. */

export {
  RATE_DECIMALS,
  RATE_SCALE,
  RATE_ONE,
  RATE_MAX_SCALED,
  parseRate,
  formatRate,
  convertMinor,
  allocateBase,
  isCurrencyCode,
} from './rateMath.js';

export {
  EXCHANGE_RATE_SOURCES,
  FX_RATE_METHODS,
  MAX_RATE_AGE_DAYS,
  baseCurrencyOf,
  resolveFxRate,
  recordExchangeRate,
  listExchangeRates,
  getExchangeRate,
} from './rates.js';

export type { ResolvedRate, ExchangeRateRow, RecordExchangeRateInput, ListExchangeRatesInput } from './rates.js';

export {
  FX_ELECTABLE_METHODS,
  FX_FALLBACK_METHOD,
  taxPeriodOf,
  electedFxMethod,
  assertFxMethodAdmissible,
  setFxMethod,
  getFxMethod,
} from './method.js';

export type { FxMethodElection, SetFxMethodInput, GetFxMethodInput } from './method.js';

export { BAZG_DAILY_URL, BAZG_MONTHLY_URL, RATE_FEED_SERIES, parseBazgFeed, fetchBazgFeed } from './bazgFeed.js';

export type { RateFeedSeries, ParsedFeed, ParsedFeedError, ParsedFeedRate } from './bazgFeed.js';

export { importExchangeRates, describeRateFeed } from './importRates.js';

export type { ImportExchangeRatesInput, ImportedRate, SkippedRate } from './importRates.js';

export { computeFxRevaluation, postFxRevaluation, reverseFxRevaluation } from './revaluation.js';

export type {
  FxPosition,
  FxNeedsRate,
  ComputeFxRevaluationInput,
  PostFxRevaluationInput,
  ReverseFxRevaluationInput,
} from './revaluation.js';
