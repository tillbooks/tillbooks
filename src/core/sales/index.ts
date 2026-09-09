/**
 * A09, customers & items: invoicing-lite master data (no ledger posting).
 */

export {
  createContact,
  updateContact,
  archiveContact,
  unarchiveContact,
  getContact,
  listContacts,
  tagContact,
  CONTACT_KINDS,
} from './contact.js';
export type { CreateContactInput, ContactPatch, ContactAddress } from './contact.js';

// C00, the CRM extension of A09: the OP5 activity log, dedupe/merge and revDSG anonymise.
export { logActivity, contactTimeline, ACTIVITY_KINDS } from './contactActivity.js';
export { mergeContacts, anonymiseContact } from './contactMerge.js';
export { importContacts } from './contactImport.js';

export { createItem, updateItem, archiveItem, unarchiveItem, deleteItem, getItem, listItems } from './item.js';
export type { CreateItemInput, ItemPatch } from './item.js';

// D00, the products/items master: the item enums, the category tree, and the price lists + resolver.
export { ITEM_KINDS, ITEM_UNITS, PRICE_LIST_SCOPES, isItemKind, isItemUnit } from './itemEnums.js';
export type { ItemKind, ItemUnit, PriceListScope } from './itemEnums.js';
export { upsertItemCategory, deleteItemCategory, listItemCategories } from './itemCategories.js';
export type { UpsertCategoryInput } from './itemCategories.js';
export {
  upsertPriceList,
  setPriceListPrice,
  unsetPriceListPrice,
  deletePriceList,
  listPriceLists,
  getPriceList,
  resolvePrice,
} from './priceLists.js';
export type { UpsertPriceListInput, SetPriceInput, UnsetPriceInput, ResolvePriceInput } from './priceLists.js';

// A10, the document lifecycle: the single P7 state machine (quote/order/invoice/credit_note).
export {
  createDocument,
  updateDocument,
  transitionDocument,
  convertDocument,
  getDocument,
  listDocuments,
  assertTransition,
  registerDocumentPoster,
  createMigratedDocument,
  isOrigin,
  DOCUMENT_TYPES,
  DOCUMENT_STATUSES,
  DOCUMENT_ORIGINS,
  DOCUMENT_LIST_CEILING,
} from './document.js';
export type {
  DocumentType,
  DocumentStatus,
  Origin,
  DocumentPoster,
  DocumentRow,
  CreateDocumentInput,
  UpdateDocumentPatch,
  DocumentLineInput,
  CreateMigratedDocumentInput,
  MigratedDocumentLineInput,
} from './document.js';

// C02, quotes / proposals: thin wrappers over A10's shared document machine (no new tables, no
// posting path). The engine module uses node:crypto for the OP4 accept token; it is Node-only and
// reached only by the API layer, never runtime-imported by the Studio (the browser-purity guard).
export {
  createQuote,
  updateQuote,
  sendQuote,
  acceptQuote,
  declineQuote,
  sweepExpiredQuotes,
  reviseQuote,
  convertQuote,
  getQuote,
  listQuotes,
  QUOTE_CONVERT_TARGETS,
} from './quotes.js';
export type {
  CreateQuoteInput,
  UpdateQuoteInput,
  SendQuoteInput,
  AcceptQuoteInput,
  DeclineQuoteInput,
  SweepExpiredInput,
  ReviseQuoteInput,
  ConvertQuoteInput,
  ListQuotesInput,
  QuoteLineInput,
  QuoteConvertTarget,
} from './quotes.js';

// A11, invoice: the invoice-scoped verbs + the QR-bill/PDF statutory core. Importing this module
// registers A11's `onIssue` poster into A10's seam (below), the ONE place invoicing gains a posting
// path (P3). Every surface that reaches A10's `transitionDocument(..., 'issued')` for an invoice now
// posts the balanced VAT entry through it.
import { invoicePoster } from './invoice.js';
import { registerDocumentPoster } from './document.js';

registerDocumentPoster('invoice', invoicePoster);

// A13, credit notes: importing this module registers A13's `onIssue` poster into A10's seam, the
// ONE place a Gutschrift gains a posting path (P3). `onCancel` reverses via A02 (§H-AUDIT).
import { creditNotePoster } from './creditNote.js';

registerDocumentPoster('credit_note', creditNotePoster);

export {
  createCreditNote,
  issueCreditNote,
  buildCreditNotePosting,
  renderCreditNotePdf,
  creditNotePoster,
  apportionNet,
} from './creditNote.js';
export type { CreateCreditNoteInput } from './creditNote.js';

export {
  buildInvoicePosting,
  buildQrBill,
  renderInvoicePdf,
  issueInvoice,
  sendInvoice,
  invoiceEmailSubject,
  invoicePoster,
  QR_IBAN_CHF_ONLY_FROM,
} from './invoice.js';

export {
  encodeSwissQrPayload,
  buildQrBillPayload,
  validateQrBill,
  buildQrrReference,
  isValidQrrReference,
  buildScorReference,
  isValidScorReference,
  mod10RecursiveCheckDigit,
  iso11649CheckDigits,
  buildSwicoS1,
  swicoEscape,
  bpToPercentString,
  formatQrAmount,
  isQrCurrency,
  isQrPermittedCodePoint,
  firstDisallowedQrChar,
  QrPayloadCharsetError,
  SWISS_QR_IG_VERSION,
} from './qrbill.js';
export type { BuildQrBillInput, QrBill, QrStructuredAddress, QrReferenceType, SwicoS1Input } from './qrbill.js';

// A11, the SCANNABLE graphic. `qrbill.ts` says WHAT to encode; this says what the customer actually
// scans, in the two forms that reach one: PDF content-stream operators for the invoice artifact, and
// an SVG for the Studio's payment panel. Public because the payment part is not an internal detail:
// a caller assembling its own document (G05 layouts, A32 eBill, a third-party PDF pipeline) has to
// be able to draw the same symbol rather than reinvent it and drift from the guideline.
// STRUCTURAL conformance against the cited SIX guideline plus a proven decoder round trip is the
// whole claim; SIX certification is a process with SIX and is NOT asserted anywhere.
export {
  renderSwissQrCodeSvg,
  renderSwissQrCodePdfOps,
  buildSwissQrCodeGraphic,
  swissQrGraphicSizeMm,
  swissQrGraphicSizePt,
  SwissQrPayloadTooLongError,
  SWISS_QR_CODE_SIZE_MM,
  SWISS_QR_QUIET_ZONE_MM,
  SWISS_QR_CROSS_SIZE_MM,
  SWISS_QR_MIN_MODULE_SIZE_MM,
  SWISS_QR_MAX_PAYLOAD_CHARS,
  PT_PER_MM,
} from './swiss-qr-graphic.js';
export type {
  SwissQrCodeGraphic,
  SwissQrRenderOptions,
  SwissQrSvgOptions,
  SwissQrPdfOptions,
} from './swiss-qr-graphic.js';

// D03, sales orders & delivery notes: the order -> delivery -> invoice fulfilment bridge. Five
// operational tables, no posting path (invoicing delegates to A10 createDocument, P3), issue
// movements minted only through D01 stock.move (OP2).
export {
  createSalesOrder,
  salesOrderFromQuote,
  confirmSalesOrder,
  cancelSalesOrder,
  salesOrderInvoice,
  listSalesOrders,
  getSalesOrder,
  listBackorders,
  SALES_ORDER_STATUSES,
} from './salesOrders.js';
export { createDeliveryNote, issueDeliveryNote, renderDeliveryNote } from './deliveryNotes.js';
export { SO_STATUSES, DN_STATUSES } from './salesOrderEnums.js';

// A32, eBill issuing: package an issued invoice as an outward-facing eBill delivery payload (OP4,
// cloud-tier transmit), carrying A11's QR reference. Posts nothing (P3 by absence).
export {
  setEbillConfig,
  getEbillConfig,
  prepareEbill,
  transmitEbill,
  getEbillDeliveryStatus,
  mirrorEbillPartnerStatus,
  asEbillDeliveryStatus,
} from './ebill.js';
export type { EbillRenderDeps } from './ebill.js';
export {
  EBILL_DELIVERY_STATUS,
  EBILL_FORMAT,
  EBILL_BC_FUNCTION,
  EBILL_PARTNER_STATUS,
  BILLER_PID_PATTERN,
  EBILL_MAX_PAYLOAD_BYTES,
  EBILL_REQUIRED_PDFA_PROFILE,
  isEbillDeliveryStatus,
} from './ebillEnums.js';
export type { EbillDeliveryStatus, EbillFormat, EbillBcFunction, EbillPartnerStatus } from './ebillEnums.js';
export { EBILL_SCHEMA_SQL } from './ebillSchema.js';
