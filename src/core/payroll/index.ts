/** A34, payroll hand-off boundary: the barrel every face resolves A34's verbs through. */

export { PAYROLL_HANDOFF_SCHEMA_SQL } from './handoffSchema.js';
export {
  payrollHandoffExport,
  wageJournalPost,
  validateSupplementary,
  validateRunKindStatic,
  runKindReasonRequired,
  NONREGULAR_AUDIT_KIND,
  WAGE_RUN_KINDS,
  isWageRunKind,
  listPayrollHandoffs,
  PAYROLL_HANDOFF_FORMATS,
  isPayrollHandoffFormat,
  WAGE_JOURNAL_SOURCE,
} from './handoff.js';
export type {
  PayrollHandoffExportInput,
  WageJournalPostInput,
  WageJournalLineInput,
  ListPayrollHandoffsInput,
  PayrollHandoffFormat,
} from './handoff.js';
export { wageJournalReverse, wageJournalReversalOf, wageJournalChain } from './reverse.js';
export type { WageJournalReverseInput } from './reverse.js';
