/**
 * A05, MWST config: the single tax enumeration point (§H-ENUM) and the `resolveTax` (P6) contract.
 * A05 stores config and rates only; it never calls `postEntry` (P3 by absence).
 */

export {
  seedTaxCodes,
  upsertTaxCode,
  deactivateTaxCode,
  reactivateTaxCode,
  setAccountTaxDefault,
  listTaxCodes,
} from './taxCodes.js';
export type { UpsertTaxCodeInput } from './taxCodes.js';
export {
  configureVat,
  getVatConfig,
  listSaldoGenerations,
  newLastDayOfPredecessor,
  setSaldoDeclarationBasis,
} from './config.js';
export type {
  ConfigureVatInput,
  SaldoActivityInput,
  SaldoRateInput,
  SetSaldoDeclarationBasisInput,
} from './config.js';
export {
  generationOn,
  methodOn,
  methodsGoverning,
  saldoDeclarationRegimeForPeriod,
  SALDO_PER_POSITION_LAST_DAY,
} from './saldoGenerations.js';
export type { MethodEra, SaldoActivityRow, SaldoDeclarationBasis, SaldoGeneration } from './saldoGenerations.js';
export { resolveTax } from './resolveTax.js';
export type { ResolveTaxInput, TaxSign } from './resolveTax.js';
export { computeLineTax, buildVatLines } from './applyVat.js';
export type {
  ComputeLineTaxInput,
  ComputeLineTaxResult,
  VatTrace,
  VatJournalLine,
  VatDirection,
  BuildVatLinesInput,
} from './applyVat.js';
export {
  computeVatReturn,
  listVatPeriods,
  markVatPeriodFiled,
  monthsOfVatPeriod,
  formLineLabel,
  ESTV_FORM_LINE_LABELS,
  ESTV_FORM_LINE_LABELS_SALDO,
  OUTPUT_VAT_ACCOUNT,
  INPUT_VAT_ACCOUNTS,
} from './abrechnung.js';
export type { ComputeVatReturnInput, MarkVatPeriodFiledInput, VatReturnLine, VatPeriod } from './abrechnung.js';
export { vatBridgeOf } from './bridge.js';
export type { VatBridge, VatBridgeKind, VatBridgeInput } from './bridge.js';
export { exportVatReturnEch0217, mapReturnToEch0217, ESTV_EPORTAL_URL } from './ech0217.js';
export type { ExportVatReturnEch0217Input, Ech0217Identity } from './ech0217.js';
export {
  VAT_METHODS,
  VAT_TIMINGS,
  TAX_CODE_KINDS,
  DEFAULT_TAX_CODES,
  ESTV_SALDO_RATES_BP,
  NORMAL_RATE_BP,
} from './enums.js';
export type { SeedTaxCode } from './enums.js';
export {
  VAT_RATE_ERAS,
  PROPOSED_RATE_ERAS,
  EARLIEST_RATE_ERA_FROM,
  CURRENT_RATE_ERA_FROM,
  SALDO_ELIGIBILITY_ERAS,
  vatRatesOn,
  normalRateBpOn,
  saldoLadderOn,
  saldoEligibilityOn,
  currentVatRates,
  isValidRateDate,
  toIsoDay,
} from './rateEras.js';
export type { VatRateEra, SaldoEligibilityEra } from './rateEras.js';
export { saldoEligibility } from './saldoEligibility.js';
export type { SaldoEligibilityInput } from './saldoEligibility.js';
