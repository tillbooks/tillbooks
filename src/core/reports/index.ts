/**
 * A08, financial statements: the four statutory read models and their local export.
 *
 * Everything here is a pure query (Pattern P5). A08 owns no table, registers no write verb, and
 * emits no domain event, so it has no conformance scenario and no idempotency key: a read needs
 * none (Pattern P4).
 */

export {
  computeTrialBalance,
  computeBalanceSheet,
  computeIncomeStatement,
  computeGeneralLedger,
  STATEMENT_KINDS,
  SUPPORTED_GROUP_BY,
} from './statements.js';
export type {
  TrialBalanceInput,
  BalanceSheetInput,
  IncomeStatementInput,
  GeneralLedgerInput,
} from './statements.js';
export {
  BILANZ_SECTIONS,
  ERFOLG_SECTIONS,
  COMPUTED_EQUITY_LINES,
  KMU_CLASS_LABELS,
  STATUTORY_ERFOLG_POSITIONS,
  OR_ARTICLE_COVERAGE,
  bilanzSectionFor,
  erfolgSectionFor,
  kmuClassOf,
  classPosition,
  accountNumberValue,
} from './sections.js';
export type {
  SectionLabels,
  BilanzSectionDef,
  ErfolgSectionDef,
  BilanzSide,
  OrArticleCoverage,
} from './sections.js';
export { exportStatement, EXPORT_FORMATS, BILANZ_COVERAGE_NOTE } from './export.js';
export type { ExportStatementInput } from './export.js';
