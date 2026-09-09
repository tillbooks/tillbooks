/**
 * A17, vendor bills and expenses (Kreditoren / Aufwand + Vorsteuer).
 *
 * The creditor half of the money path: capture a supplier bill, post it to 2000 Kreditoren with its
 * input VAT split to 1170/1171, and let A14 settle it. A17 posts through A02 and computes its VAT
 * through A06; it owns no posting path and no VAT arithmetic of its own, and it owns no pay verb at
 * all (settlement is `record_payment` / `allocate_payment`, unchanged).
 *
 * Importing this barrel also registers the A17/D02 rows in B00's cost-source seam
 * (`./costSeams.js`, side-effecting at load, the B01 `seams.ts` shape).
 */

import './costSeams.js';

export {
  createVendorBill,
  recordExpense,
  postVendorBill,
  attachReceipt,
  voidVendorBill,
  createMigratedVendorBill,
  PURCHASE_SOURCE,
  RESERVED_EXPENSE_ACCOUNTS,
} from './vendorBill.js';

export type {
  CreateVendorBillInput,
  PostVendorBillInput,
  AttachReceiptInput,
  VoidVendorBillInput,
  CreateMigratedVendorBillInput,
} from './vendorBill.js';

export {
  listVendorBills,
  getVendorBill,
  readVendorBillRow,
  settledOnVendorBill,
  payablesBalanceAsOf,
  vendorBillEcho,
  VENDOR_BILL_LIST_CEILING,
} from './reads.js';

export type { ListVendorBillsInput, VendorBillRow, VendorBillView } from './reads.js';

export {
  VENDOR_BILL_STATUSES,
  VENDOR_BILL_SETTLEMENT_STATUSES,
  VENDOR_BILL_DISPLAY_STATUSES,
  VENDOR_BILL_TAX_KINDS,
  displayStatus,
  settlementStatusFor,
  isVendorBillTaxKind,
} from './enums.js';

export type {
  VendorBillStatus,
  VendorBillSettlementStatus,
  VendorBillDisplayStatus,
} from './enums.js';

export { PURCHASE_SCHEMA_SQL } from './schema.js';

// A31, document capture (Belegerfassung): the queue that feeds A17 drafts and E02 expense lines.
export {
  captureIntake,
  captureExtract,
  captureCommit,
  captureDiscard,
  listCaptures,
  getCapture,
} from './capture.js';
export type {
  CaptureIntakeInput,
  CaptureExtractInput,
  CaptureCommitInput,
  CaptureDiscardInput,
  ListCapturesInput,
  GetCaptureInput,
} from './capture.js';
export { CAPTURE_SCHEMA_SQL } from './captureSchema.js';
export {
  CAPTURE_STATUSES,
  CAPTURE_FIELD_KEYS,
  CAPTURE_CONFIDENCES,
  CAPTURE_PROVENANCES,
  CAPTURE_TARGET_KINDS,
  CAPTURE_ACCEPTED_MIMES,
  CAPTURE_DOC_TYPES,
} from './captureEnums.js';
