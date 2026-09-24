/**
 * B02, time -> billing: the barrel. The engine (`timeBilling.ts`) is the whole module; there is no
 * schema file, because B02 adds no tables (it writes B01's `time_entry.status`/`invoice_line_id`).
 */

export {
  unbilledPreview,
  generateInvoice,
  releaseLines,
  wipReport,
  BILLING_GROUP_BY,
} from './timeBilling.js';
export type {
  BillingGroupBy,
  UnbilledPreviewInput,
  GenerateInvoiceInput,
  ReleaseLinesInput,
  WipReportInput,
} from './timeBilling.js';
