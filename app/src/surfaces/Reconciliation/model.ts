/**
 * A21's view-model parsers: the engine's `list_unmatched_incoming` payload, narrowed defensively.
 *
 * The payload is not declared (the open `Result`), so the surface narrows it at ONE seam instead of
 * scattering `as` casts through the render tree: a shape the engine stops sending turns into a
 * `null` here and the surface renders its honest error state, never `undefined` in a cell.
 */

export type QrConfidence = 'high' | 'medium' | 'none';
export type QrStatus = 'open' | 'applied' | 'dismissed';

export interface QrScoreView {
  confidence: QrConfidence;
  reason: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  contactName: string | null;
  /** The principal still owed: net of linked credit notes, without the fee (the engine's netting). */
  invoiceOpenMinor: number | null;
  creditedOpenMinor: number | null;
  dunningFeeMinor: number | null;
  totalDueMinor: number | null;
  /** Null when no invoice is named AND when the currencies differ (never a cross-unit subtraction). */
  deltaMinor: number | null;
  invoiceCurrency: string | null;
  referenceDisplay: string | null;
  referenceValid: boolean;
}

export interface QrCreditRowView {
  creditId: string;
  bankAccountId: string;
  bankAccountName: string | null;
  amountMinor: number;
  currency: string;
  valueDate: string;
  payerName: string | null;
  status: QrStatus;
  score: QrScoreView;
  invoiceId: string | null;
  appliedMode: string | null;
  paymentId: string | null;
  reversedPaymentIds: string[];
  decidedBy: string | null;
  decidedAt: string | null;
}

export interface QueueView {
  items: QrCreditRowView[];
  counts: { open: number; review: number; unmatched: number; applied: number; dismissed: number };
  autoApply: boolean;
  /** A14's one-click write-off ceiling: accept-as-full is offered only inside it (critic F3). */
  writeOffThresholdMinor: number;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseScore(value: unknown): QrScoreView | null {
  if (typeof value !== 'object' || value === null) return null;
  const s = value as Record<string, unknown>;
  const confidence = str(s['confidence']);
  if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'none') return null;
  const reference = (s['reference'] ?? {}) as Record<string, unknown>;
  return {
    confidence,
    reason: str(s['reason']),
    invoiceId: str(s['invoiceId']),
    invoiceNumber: str(s['invoiceNumber']),
    contactName: str(s['contactName']),
    invoiceOpenMinor: num(s['invoiceOpenMinor']),
    creditedOpenMinor: num(s['creditedOpenMinor']),
    dunningFeeMinor: num(s['dunningFeeMinor']),
    totalDueMinor: num(s['totalDueMinor']),
    deltaMinor: num(s['deltaMinor']),
    invoiceCurrency: str(s['invoiceCurrency']),
    referenceDisplay: str(reference['display']),
    referenceValid: reference['valid'] !== false,
  };
}

function parseItem(value: unknown): QrCreditRowView | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  const creditId = str(r['creditId']);
  const bankAccountId = str(r['bankAccountId']);
  const amountMinor = num(r['amountMinor']);
  const currency = str(r['currency']);
  const valueDate = str(r['valueDate']);
  const status = str(r['status']);
  const score = parseScore(r['score']);
  if (
    creditId === null ||
    bankAccountId === null ||
    amountMinor === null ||
    currency === null ||
    valueDate === null ||
    score === null ||
    (status !== 'open' && status !== 'applied' && status !== 'dismissed')
  ) {
    return null;
  }
  return {
    creditId,
    bankAccountId,
    bankAccountName: str(r['bankAccountName']),
    amountMinor,
    currency,
    valueDate,
    payerName: str(r['payerName']),
    status,
    score,
    invoiceId: str(r['invoiceId']),
    appliedMode: str(r['appliedMode']),
    paymentId: str(r['paymentId']),
    reversedPaymentIds: Array.isArray(r['reversedPaymentIds'])
      ? (r['reversedPaymentIds'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    decidedBy: str(r['decidedBy']),
    decidedAt: str(r['decidedAt']),
  };
}

export function parseQueue(body: Record<string, unknown>): QueueView | null {
  if (!Array.isArray(body['items'])) return null;
  const items: QrCreditRowView[] = [];
  for (const raw of body['items'] as unknown[]) {
    const item = parseItem(raw);
    if (item === null) return null;
    items.push(item);
  }
  const counts = (body['counts'] ?? {}) as Record<string, unknown>;
  return {
    items,
    counts: {
      open: num(counts['open']) ?? 0,
      review: num(counts['review']) ?? 0,
      unmatched: num(counts['unmatched']) ?? 0,
      applied: num(counts['applied']) ?? 0,
      dismissed: num(counts['dismissed']) ?? 0,
    },
    autoApply: body['autoApply'] === true,
    writeOffThresholdMinor: num(body['writeOffThresholdMinor']) ?? 0,
  };
}

/** An open invoice offered by the override/manual-match picker (A16's `list_open_items` rows). */
export interface OpenInvoiceOption {
  documentId: string;
  number: string | null;
  customerName: string | null;
  openMinor: number;
  currency: string;
}

// --- A20's camt board: the imported-transaction view model ----------------------------------------

export type CamtStatus = 'matched' | 'unmatched' | 'partial';
export type CamtClassification = 'incoming_credit' | 'outgoing_debit' | 'unclassified';

export interface CamtTxnRowView {
  bankTxnId: string;
  /** The A19 bank account this movement belongs to. Resolved to a ledger account for the posting
   * preview so `preview_payment` mirrors what `confirm_match` will book (A36-U3). */
  bankAccountId: string | null;
  entryRef: string | null;
  amountMinor: number;
  currency: string;
  creditDebit: 'CRDT' | 'DBIT';
  valueDate: string | null;
  payerName: string | null;
  classification: CamtClassification;
  status: CamtStatus;
  creditId: string | null;
  linkKind: 'payment' | 'journal_entry' | null;
}

export interface ReconciliationBoardView {
  matched: CamtTxnRowView[];
  unmatched: CamtTxnRowView[];
  partial: CamtTxnRowView[];
  reconciled: boolean | null;
}

function parseCamtRow(value: unknown): CamtTxnRowView | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  const bankTxnId = str(r['bankTxnId']);
  const amountMinor = num(r['amountMinor']);
  const currency = str(r['currency']);
  const creditDebit = r['creditDebit'];
  const classification = r['classification'];
  const status = r['status'];
  if (
    bankTxnId === null ||
    amountMinor === null ||
    currency === null ||
    (creditDebit !== 'CRDT' && creditDebit !== 'DBIT') ||
    (classification !== 'incoming_credit' && classification !== 'outgoing_debit' && classification !== 'unclassified') ||
    (status !== 'matched' && status !== 'unmatched' && status !== 'partial')
  ) {
    return null;
  }
  const linkKind = r['linkKind'];
  return {
    bankTxnId,
    bankAccountId: str(r['bankAccountId']),
    entryRef: str(r['entryRef']),
    amountMinor,
    currency,
    creditDebit,
    valueDate: str(r['valueDate']),
    payerName: str(r['payerName']),
    classification,
    status,
    creditId: str(r['creditId']),
    linkKind: linkKind === 'payment' || linkKind === 'journal_entry' ? linkKind : null,
  };
}

function parseCamtRows(value: unknown): CamtTxnRowView[] {
  if (!Array.isArray(value)) return [];
  const out: CamtTxnRowView[] = [];
  for (const raw of value) {
    const row = parseCamtRow(raw);
    if (row !== null) out.push(row);
  }
  return out;
}

export function parseReconciliationBoard(body: Record<string, unknown>): ReconciliationBoardView | null {
  if (!Array.isArray(body['matched']) || !Array.isArray(body['unmatched']) || !Array.isArray(body['partial'])) {
    return null;
  }
  return {
    matched: parseCamtRows(body['matched']),
    unmatched: parseCamtRows(body['unmatched']),
    partial: parseCamtRows(body['partial']),
    reconciled: body['reconciled'] === true ? true : body['reconciled'] === false ? false : null,
  };
}

// --- A36's ranked debit suggestions (`suggest_matches`), keyed onto the camt board's own rows -----

export type CamtMatchSignal = 'amount' | 'value_date' | 'counterparty' | 'reference' | 'batch' | 'batch_total_mismatch';

export interface CamtMatchProposalView {
  kind: 'invoice' | 'vendor_bill' | 'payment_batch';
  targetId: string;
  confidence: QrConfidence;
  reason: string;
  signals: CamtMatchSignal[];
  blocked: boolean;
}

export interface CamtTxnProposalView {
  bankTxnId: string;
  classification: CamtClassification;
  proposal: CamtMatchProposalView | null;
  needsReview: boolean;
}

const KNOWN_SIGNALS = new Set<CamtMatchSignal>(['amount', 'value_date', 'counterparty', 'reference', 'batch', 'batch_total_mismatch']);

function parseSignals(value: unknown): CamtMatchSignal[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is CamtMatchSignal => typeof s === 'string' && KNOWN_SIGNALS.has(s as CamtMatchSignal));
}

function parseProposal(value: unknown): CamtMatchProposalView | null {
  if (typeof value !== 'object' || value === null) return null;
  const p = value as Record<string, unknown>;
  const kind = p['kind'];
  const targetId = str(p['targetId']);
  const confidence = str(p['confidence']);
  if (
    (kind !== 'invoice' && kind !== 'vendor_bill' && kind !== 'payment_batch') ||
    targetId === null ||
    (confidence !== 'high' && confidence !== 'medium' && confidence !== 'none')
  ) {
    return null;
  }
  return {
    kind,
    targetId,
    confidence,
    reason: str(p['reason']) ?? '',
    signals: parseSignals(p['signals']),
    blocked: p['blocked'] === true,
  };
}

function parseTxnProposal(value: unknown): CamtTxnProposalView | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  const bankTxnId = str(r['bankTxnId']);
  const classification = r['classification'];
  if (
    bankTxnId === null ||
    (classification !== 'incoming_credit' && classification !== 'outgoing_debit' && classification !== 'unclassified')
  ) {
    return null;
  }
  return {
    bankTxnId,
    classification,
    proposal: parseProposal(r['proposal']),
    needsReview: r['needsReview'] === true,
  };
}

/**
 * `suggest_matches`, keyed by `bankTxnId` so the camt board can look a proposal up per row. Never
 * blocks the board: a shape the engine stops sending, or a transport failure, resolves to an empty
 * map here (the caller passes `isErr(...)` bodies through this the same way), and the row simply
 * renders with no proposal, exactly as it did before A36.
 */
// --- F-03 (J3.3): the statement list (`list_bank_statements`), the door to a board -----------------

/** One imported statement, the engine's `BankStatementSummary` as the surface reads it. */
export interface BankStatementSummaryView {
  statementId: string;
  bankAccountId: string;
  bankStatementId: string;
  fromDate: string | null;
  toDate: string | null;
  txnCount: number;
  openCount: number;
  reconciled: boolean | null;
  importedAt: string;
}

export function parseBankStatements(body: Record<string, unknown>): BankStatementSummaryView[] {
  if (!Array.isArray(body['statements'])) return [];
  const out: BankStatementSummaryView[] = [];
  for (const value of body['statements']) {
    if (typeof value !== 'object' || value === null) continue;
    const r = value as Record<string, unknown>;
    const statementId = str(r['statementId']);
    const bankAccountId = str(r['bankAccountId']);
    if (statementId === null || bankAccountId === null) continue;
    out.push({
      statementId,
      bankAccountId,
      bankStatementId: str(r['bankStatementId']) ?? statementId,
      fromDate: str(r['fromDate']),
      toDate: str(r['toDate']),
      txnCount: num(r['txnCount']) ?? 0,
      openCount: num(r['openCount']) ?? 0,
      reconciled: r['reconciled'] === true ? true : r['reconciled'] === false ? false : null,
      importedAt: str(r['importedAt']) ?? '',
    });
  }
  return out;
}

export function parseSuggestions(body: Record<string, unknown>): Record<string, CamtTxnProposalView> {
  const out: Record<string, CamtTxnProposalView> = {};
  if (!Array.isArray(body['txns'])) return out;
  for (const raw of body['txns'] as unknown[]) {
    const parsed = parseTxnProposal(raw);
    if (parsed !== null) out[parsed.bankTxnId] = parsed;
  }
  return out;
}

/** A posted, open vendor bill offered by the confirm dialog's picker (A17's `list_vendor_bills`). */
export interface OpenVendorBillOption {
  vendorBillId: string;
  vendorReference: string | null;
  vendorName: string | null;
  openMinor: number;
  currency: string;
}

export function parseOpenVendorBills(body: Record<string, unknown>): OpenVendorBillOption[] {
  // A36-U1: `list_vendor_bills` answers `{ bills: [...] }` and emits each bill's id under `id`
  // (`src/core/purchase/reads.ts`), never `{ vendorBills: [{ vendorBillId }] }`. Reading the Studio's
  // own guessed keys here dropped every real bill on the `id === null` filter, so the confirm
  // dialog's picker never populated and a proposed debit could not be settled against its bill.
  if (!Array.isArray(body['bills'])) return [];
  const options: OpenVendorBillOption[] = [];
  for (const raw of body['bills'] as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const vendorBillId = str(r['id']);
    const openMinor = num(r['openMinor']);
    const currency = str(r['currency']);
    // Only POSTED bills carry an open amount worth settling (a draft answers openMinor 0); the
    // `openMinor > 0` filter keeps the picker to what a payment can actually clear.
    if (vendorBillId === null || openMinor === null || openMinor <= 0 || currency === null) {
      continue;
    }
    options.push({
      vendorBillId,
      vendorReference: str(r['vendorReference']),
      vendorName: str(r['vendorName']),
      openMinor,
      currency,
    });
  }
  return options;
}

export function parseOpenInvoices(body: Record<string, unknown>): OpenInvoiceOption[] {
  if (!Array.isArray(body['items'])) return [];
  const options: OpenInvoiceOption[] = [];
  for (const raw of body['items'] as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const documentId = str(r['documentId']);
    const openMinor = num(r['openMinor']);
    const currency = str(r['currency']);
    if (r['kind'] !== 'document' || documentId === null || openMinor === null || openMinor <= 0 || currency === null) {
      continue;
    }
    options.push({
      documentId,
      number: str(r['number']),
      customerName: str(r['customerName']),
      openMinor,
      currency,
    });
  }
  return options;
}
