/**
 * D191, the disposal's proceeds document (H06 extension, owner decision Q4 of 15.10.2026).
 *
 * `asset_dispose` may name the document the proceeds came with: an A10 sales INVOICE the buyer was
 * billed on, an A14 INCOMING PAYMENT the money arrived as, or both (the payment then has to settle that
 * invoice). `asset_transaction_reverse` on that disposal refuses `proceeds_settled` while the linked
 * document stands: the D168/D169 rule, undo the money act first, then the event it paid for.
 *
 * WHERE THE LINK LIVES: no schema change. The disposal row already carries the optional pair
 * `source_document_type` / `source_document_id`, which H02 declared as "the optional link to what
 * triggered the event" and which `asset_acquire` fills for its vendor bill; H06 left it NULL. The
 * proceeds document is exactly that link for a disposal, so it is written there ('invoice' or
 * 'payment'). One pair holds one document: when both are given, the INVOICE is stored, because a payment
 * that settles it keeps it standing (its live allocation is part of the standing test below), so the
 * payment is never lost to the check. `SCHEMA_GENERATION` does not move. The compensating row's own pair
 * ('asset_transaction') is a different value, so no D170 query changes meaning.
 *
 * STANDS:
 *  - a payment stands while it is not reversed (`reversal_entry_id IS NULL`, the D169 predicate) and its
 *    entry's chain of posted mirrors is even (a raw Storno from before A14 owned the entry reads as
 *    reversed: the chain-walk the D170 legacy path uses);
 *  - an invoice stands while a live payment allocation on it stands, OR while it is not cancelled, its
 *    posted entry was not taken out raw (even chain) and its issued credit notes do not cover its total
 *    (credited in full is the Gutschrift's way of undoing it).
 *
 * VALIDATION at dispose time (and in the preview, which shares the plan): same workspace (§H-TENANT, a
 * foreign id answers exactly as an unknown one), the right kind (an invoice, not a quote or a credit
 * note; an incoming payment, not an outgoing one), issued and standing, and proceeds above zero (a scrap
 * has no proceeds document). A different AMOUNT or COUNTERPARTY is NOT refused: H06 books the proceeds
 * net of VAT and an invoice carries the gross, a foreign-currency invoice carries another currency, and
 * a part payment is legitimate. The difference is stored as-is and returned as a warning, so the caller
 * sees it before and after posting.
 *
 * THE SETTING: `assets.proceeds_check` (D172 registry) decides what the reverse does with a standing
 * document: `refuse` (default), `warn` or `off`. The link is stored whatever the setting says: it is a
 * fact about the disposal, and `asset_ledger_get` reports whether the document stands either way.
 */

import type { WorkspaceContext } from '../context.js';
import { err } from '../result.js';
import type { Result } from '../result.js';
import { creditCoverMinor } from '../payments/payment.js';

/** The two `source_document_type` values a disposal row may carry (D191). */
export const PROCEEDS_DOCUMENT_TYPES = ['invoice', 'payment'] as const;
export type ProceedsDocumentType = (typeof PROCEEDS_DOCUMENT_TYPES)[number];

/** The `assets.proceeds_check` setting values (D191, registry `src/core/settings/registry.ts`). */
export type ProceedsCheckMode = 'refuse' | 'warn' | 'off';

export function isProceedsDocumentType(v: string | null | undefined): v is ProceedsDocumentType {
  return v === 'invoice' || v === 'payment';
}

export interface ProceedsLinkInput {
  proceedsInvoiceId?: string | null | undefined;
  proceedsPaymentId?: string | null | undefined;
}

export interface ProceedsWarning {
  code:
    | 'proceeds_amount_differs'
    | 'proceeds_currency_differs'
    | 'counterparty_differs'
    | 'proceeds_payment_spans_invoices'
    | 'proceeds_payment_partly_unallocated'
    | 'proceeds_double_counted'
    // D192
    | 'proceeds_exceed_sale_line'
    | 'sale_reduced'
    | 'sale_in_other_month'
    | 'sale_in_other_financial_year'
    | 'abgrenzung_period_locked';
  [k: string]: unknown;
}

/** A validated link: what is stored on the row, plus what the caller is shown. */
export interface ProceedsLink {
  storedType: ProceedsDocumentType;
  storedId: string;
  invoiceId: string | null;
  paymentId: string | null;
  /** Critic r1 F2: the invoice was not named but resolved from the linked payment's one invoice allocation. */
  invoiceFromPayment: boolean;
  warnings: ProceedsWarning[];
  /** D192: the resolved invoice row (null for a payment-only link), read once for the plan. */
  invoice: InvoiceRow | null;
  /** D192: the named payment row, or null. */
  payment: PaymentRow | null;
  /** D192: for a payment-only link, the invoices its allocations touch (named by `proceeds_needs_invoice`). */
  paymentInvoiceIds: string[];
}

export interface InvoiceRow {
  id: string;
  type: string;
  number: string | null;
  status: string;
  contact_id: string | null;
  currency: string;
  total_minor: number;
  posted_entry_id: string | null;
}

export interface PaymentRow {
  id: string;
  direction: string;
  status: string;
  amount_minor: number;
  currency: string;
  base_amount_minor: number;
  counterparty_id: string | null;
  journal_entry_id: string | null;
  reversal_entry_id: string | null;
}

function readInvoice(ctx: WorkspaceContext, id: string): InvoiceRow | undefined {
  return ctx.store.db
    .prepare(
      `SELECT id, type, number, status, contact_id, currency, total_minor, posted_entry_id
         FROM document WHERE workspace_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, id) as InvoiceRow | undefined;
}

function readPayment(ctx: WorkspaceContext, id: string): PaymentRow | undefined {
  return ctx.store.db
    .prepare(
      `SELECT id, direction, status, amount_minor, currency, base_amount_minor, counterparty_id,
              journal_entry_id, reversal_entry_id
         FROM payment WHERE workspace_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, id) as PaymentRow | undefined;
}

/** Odd chain of posted mirrors from `entryId`: a raw Storno took it out (§H-TENANT on every hop). */
function takenOutRaw(ctx: WorkspaceContext, entryId: string | null): boolean {
  if (entryId === null) return false;
  let last = entryId;
  let links = 0;
  for (let hops = 0; hops < 16; hops += 1) {
    const next = ctx.store.db
      .prepare("SELECT id FROM journal_entry WHERE workspace_id = ? AND reverses_entry_id = ? AND status = 'posted' ORDER BY rowid LIMIT 1")
      .get(ctx.workspaceId, last) as { id: string } | undefined;
    if (next === undefined) break;
    last = next.id;
    links += 1;
  }
  return links % 2 === 1;
}

function paymentStands(ctx: WorkspaceContext, p: Pick<PaymentRow, 'status' | 'reversal_entry_id' | 'journal_entry_id'>): boolean {
  return p.reversal_entry_id === null && p.status !== 'reversed' && !takenOutRaw(ctx, p.journal_entry_id);
}

/**
 * The standing payments with a live allocation on the invoice (oldest id first) and the cash they
 * settled on it. ONE query, the allocation and its payment both scoped to this workspace (§H-TENANT,
 * a single layer on purpose, so its test bites).
 */
function standingPaymentsOn(ctx: WorkspaceContext, invoiceId: string): { paymentIds: string[]; paidMinor: number } {
  const rows = ctx.store.db
    .prepare(
      `SELECT p.id AS id, p.status AS status, p.reversal_entry_id AS reversal_entry_id,
              p.journal_entry_id AS journal_entry_id, a.amount_minor AS amount_minor
         FROM payment_allocation a
         JOIN payment p ON p.id = a.payment_id AND p.workspace_id = a.workspace_id
        WHERE a.workspace_id = ? AND a.target_kind = 'document' AND a.target_id = ?
        ORDER BY p.id, a.id`,
    )
    .all(ctx.workspaceId, invoiceId) as { id: string; status: string; reversal_entry_id: string | null; journal_entry_id: string | null; amount_minor: number }[];
  const paymentIds: string[] = [];
  let paidMinor = 0;
  for (const r of rows) {
    if (!paymentStands(ctx, r)) continue;
    paidMinor += r.amount_minor;
    if (!paymentIds.includes(r.id)) paymentIds.push(r.id);
  }
  return { paymentIds, paidMinor };
}

/** A credit note counts while its own posted entry was not taken out by a raw Storno (the D170 chain walk). */
function creditNoteCounts(ctx: WorkspaceContext, creditNoteId: string): boolean {
  const row = ctx.store.db
    .prepare('SELECT posted_entry_id FROM document WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, creditNoteId) as { posted_entry_id: string | null } | undefined;
  return row !== undefined && !takenOutRaw(ctx, row.posted_entry_id);
}

/** The face gross the invoice's issued (non-draft, non-cancelled, not taken out) credit notes took from it. */
function creditedGross(ctx: WorkspaceContext, invoiceId: string): number {
  const rows = ctx.store.db
    .prepare(
      `SELECT id, total_minor FROM document
        WHERE workspace_id = ? AND type = 'credit_note' AND credited_document_id = ?
          AND status NOT IN ('draft', 'cancelled')`,
    )
    .all(ctx.workspaceId, invoiceId) as { id: string; total_minor: number }[];
  return rows.filter((r) => creditNoteCounts(ctx, r.id)).reduce((n, r) => n + r.total_minor, 0);
}

/**
 * The cash already paid back on the invoice's credit notes (refund payouts, A14 outgoing allocations on
 * the credit note). Derived from A14's own `creditCoverMinor` (face minus refunds) over the same credit
 * notes `creditedGross` counts, so the refund netting is A14's and is not restated here.
 */
function refundedMinor(ctx: WorkspaceContext, invoiceId: string): number {
  return creditedGross(ctx, invoiceId) - creditCoverMinor(ctx, invoiceId, (id) => creditNoteCounts(ctx, id));
}

/** The invoice itself still stands (ignoring payments): issued, not cancelled, not taken out, not fully credited. */
function invoiceDocumentStands(ctx: WorkspaceContext, inv: InvoiceRow): boolean {
  if (inv.status === 'draft' || inv.status === 'cancelled') return false;
  if (takenOutRaw(ctx, inv.posted_entry_id)) return false;
  return creditedGross(ctx, inv.id) < inv.total_minor;
}

/** Why the linked document still stands. */
export interface StandingProceeds {
  proceedsDocumentType: ProceedsDocumentType;
  proceedsDocumentId: string;
  documentNumber: string | null;
  /** The standing payments that keep the proceeds in hand (empty when only the invoice itself stands). */
  paymentIds: string[];
  /** Invoice only: whether the invoice itself still stands (not cancelled, not credited in full). */
  invoiceStands: boolean;
}

/** Why the linked document still stands, or null when it no longer does (the reverse may go ahead). */
export function standingProceedsDocument(ctx: WorkspaceContext, type: string | null, id: string | null): StandingProceeds | null {
  if (!isProceedsDocumentType(type) || id === null) return null;
  if (type === 'payment') {
    const p = readPayment(ctx, id);
    if (p === undefined || !paymentStands(ctx, p)) return null;
    return { proceedsDocumentType: 'payment', proceedsDocumentId: id, documentNumber: null, paymentIds: [id], invoiceStands: false };
  }
  const inv = readInvoice(ctx, id);
  if (inv === undefined) return null;
  const docStands = invoiceDocumentStands(ctx, inv);
  // Critic r1 F1: a payment keeps the sale in hand only while it is not paid back. The standard
  // unwinding of a paid sale is a full credit note plus a refund payout on it; the refund nets the cash.
  const { paymentIds, paidMinor } = standingPaymentsOn(ctx, id);
  const moneyStands = paymentIds.length > 0 && paidMinor - refundedMinor(ctx, id) > 0;
  if (!docStands && !moneyStands) return null;
  return {
    proceedsDocumentType: 'invoice',
    proceedsDocumentId: id,
    documentNumber: inv.number,
    paymentIds: moneyStands ? paymentIds : [],
    invoiceStands: docStands,
  };
}

/** The structured refusal `asset_transaction_reverse` answers while the proceeds document stands. */
export function proceedsSettledRefusal(assetId: string, transactionId: string, standing: StandingProceeds): Result {
  // The hint names the undo a business really books. A refunded sale does not stand at all (F1), and a
  // real receipt is undone by a credit note plus a refund; reverse_payment only for a receipt booked in error.
  const hint =
    standing.proceedsDocumentType === 'payment'
      ? 'the disposal proceeds arrived as this incoming payment, linked without an invoice: reverse_payment if the receipt was booked in error, then the disposal; a sale undone with a refund payout is taken back with overrideProceedsCheck and its reason'
      : standing.paymentIds.length === 0
        ? 'the disposal proceeds were invoiced: cancel the invoice or credit it in full first (transition_document to cancelled, or create_credit_note), then the disposal'
        : standing.invoiceStands
          ? 'the disposal proceeds were invoiced and paid: credit the invoice in full (create_credit_note) and pay the refund out on the credit note (record_payment, outgoing), or reverse_payment only if the receipt was booked in error; then the disposal'
          : 'the invoice is credited in full but its payment is not paid back: pay the refund out on the credit note (record_payment, outgoing), or reverse_payment only if the receipt was booked in error; then the disposal';
  return err('proceeds_settled', { assetId, transactionId, ...standing, hint });
}

/**
 * Critic r2 G1: what the linked payment's allocations say. `invoiceIds` are the distinct LOCAL invoices
 * it settles; `wholly` is true only when every allocation is on one local invoice AND they consume the
 * whole payment (no remainder on account, nothing on another target). §H-TENANT on the allocation and on
 * the document join, so a foreign id is never named.
 */
function paymentAllocationPicture(ctx: WorkspaceContext, payment: PaymentRow): { invoiceIds: string[]; unallocatedMinor: number; otherTargets: boolean } {
  const rows = ctx.store.db
    .prepare(
      `SELECT a.target_kind AS target_kind, a.target_id AS target_id, a.payment_amount_minor AS used,
              d.type AS doc_type
         FROM payment_allocation a
         LEFT JOIN document d ON d.id = a.target_id AND d.workspace_id = a.workspace_id
        WHERE a.workspace_id = ? AND a.payment_id = ?
        ORDER BY a.target_id, a.id`,
    )
    .all(ctx.workspaceId, payment.id) as { target_kind: string; target_id: string; used: number; doc_type: string | null }[];
  const invoiceIds: string[] = [];
  let used = 0;
  let otherTargets = false;
  for (const r of rows) {
    used += r.used;
    if (r.target_kind === 'document' && r.doc_type === 'invoice') {
      if (!invoiceIds.includes(r.target_id)) invoiceIds.push(r.target_id);
    } else {
      otherTargets = true;
    }
  }
  return { invoiceIds, unallocatedMinor: Math.max(0, payment.amount_minor - used), otherTargets };
}

/** Is the proceeds account one of the invoice's NON-TAX credit lines (D192: tax lines never count, N1)? */
function proceedsOnInvoiceSaleCredit(ctx: WorkspaceContext, invoice: InvoiceRow, proceedsAccountId: string): boolean {
  return saleCreditLinesOf(ctx, invoice.posted_entry_id).some((l) => l.accountId === proceedsAccountId);
}

function invalid(field: string, reason: string, extra: Record<string, unknown> = {}): Result {
  return err('invalid_proceeds_document', { field, reason, ...extra });
}

function nameOf(ctx: WorkspaceContext, contactId: string | null): string | null {
  if (contactId === null) return null;
  const row = ctx.store.db
    .prepare('SELECT name FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, contactId) as { name: string | null } | undefined;
  return row?.name ?? null;
}

// --- D192: the invoice's sale line, its reductions, and one standing disposal per invoice -----------

/** `assets.proceeds_booking` (D192 point 7). */
export type ProceedsBookingMode = 'clear_via_document' | 'book_proceeds';
export const PROCEEDS_BOOKING_MODES: readonly ProceedsBookingMode[] = ['clear_via_document', 'book_proceeds'];
/** `assets.cross_year_sale` (D192 point 11). */
export type CrossYearSaleMode = 'post_abgrenzung' | 'refuse';
export const CROSS_YEAR_SALE_MODES: readonly CrossYearSaleMode[] = ['post_abgrenzung', 'refuse'];

/** The output-VAT account the A06 output poster books tax to (2200, A14's `outputVat` role). */
const OUTPUT_VAT_ACCOUNT_NUMBER = '2200';

/** One credit line of an invoice's posted entry outside the output-VAT account, base CHF above zero. */
export interface SaleLine {
  lineId: string;
  accountId: string;
  accountNumber: string;
  accountName: string;
  baseCreditMinor: number;
  costCenterId: string | null;
}

/**
 * The NON-TAX credit lines of an invoice's posted entry (D192 point 2): every credit outside the
 * output-VAT account with a base credit above zero, in posting order. §H-TENANT on the entry join, the
 * one layer this read has. An entry id of null (a migrated open item) has none.
 */
export function saleCreditLinesOf(ctx: WorkspaceContext, entryId: string | null): SaleLine[] {
  if (entryId === null) return [];
  const vat = ctx.store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, OUTPUT_VAT_ACCOUNT_NUMBER) as { id: string } | undefined;
  const rows = ctx.store.db
    .prepare(
      `SELECT l.id AS line_id, l.account_id AS account_id, a.number AS number, a.name AS name,
              l.base_credit_minor AS base_credit, l.cost_center_id AS cost_center_id
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id AND e.workspace_id = ?
         JOIN account a ON a.id = l.account_id
        WHERE l.entry_id = ? AND l.base_credit_minor > 0
        ORDER BY l.rowid`,
    )
    .all(ctx.workspaceId, entryId) as { line_id: string; account_id: string; number: string; name: string; base_credit: number; cost_center_id: string | null }[];
  return rows
    .filter((r) => r.account_id !== vat?.id)
    .map((r) => ({
      lineId: r.line_id,
      accountId: r.account_id,
      accountNumber: r.number,
      accountName: r.name,
      baseCreditMinor: r.base_credit,
      costCenterId: r.cost_center_id,
    }));
}

/**
 * D192 (code critic r2 S1): what this invoice's sale has ALREADY put on its sale account, net per
 * posting date (base, debit plus): the invoice's entry, the clearing of every disposal row that stores
 * this invoice (standing or reversed), the mirror of each reversed one, and the four entries (A, B and,
 * once taken back, C, D) of every Abgrenzung those disposals posted. The disposal plan adds its own
 * clearing and posts only the Abgrenzung that brings every financial year back to zero, so a redo after
 * a reverse never books a second deferral into a year that still holds the first (S1). Credit notes,
 * Skonto and write-offs are NOT part of it: they are reductions, warned and left where they book
 * (point 2). §H-TENANT on every table.
 */
export function saleAccountNetByDate(ctx: WorkspaceContext, invoice: { id: string; posted_entry_id: string | null }, accountId: string): { date: string; net: number }[] {
  return ctx.store.db
    .prepare(
      `WITH disp AS (
         SELECT id, journal_entry_id FROM asset_transaction
          WHERE workspace_id = ? AND type = 'disposal' AND source_document_type = 'invoice' AND source_document_id = ?
       ),
       ents(entry_id) AS (
         SELECT ?
         UNION SELECT journal_entry_id FROM disp
         UNION SELECT r.journal_entry_id FROM asset_transaction r JOIN disp ON r.source_document_id = disp.id
                WHERE r.workspace_id = ? AND r.source_document_type = 'asset_transaction'
         UNION SELECT a.entry_id FROM accrual a JOIN disp ON a.source_ref = 'asset_transaction:' || disp.id WHERE a.workspace_id = ?
         UNION SELECT a.reversal_entry_id FROM accrual a JOIN disp ON a.source_ref = 'asset_transaction:' || disp.id WHERE a.workspace_id = ?
         UNION SELECT a.storno_entry_id FROM accrual a JOIN disp ON a.source_ref = 'asset_transaction:' || disp.id WHERE a.workspace_id = ?
         UNION SELECT a.storno_reversal_entry_id FROM accrual a JOIN disp ON a.source_ref = 'asset_transaction:' || disp.id WHERE a.workspace_id = ?
       )
       SELECT e.date AS date, SUM(l.base_debit_minor - l.base_credit_minor) AS net
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id AND e.workspace_id = ?
        WHERE l.entry_id IN (SELECT entry_id FROM ents WHERE entry_id IS NOT NULL)
          AND l.account_id = ? AND e.status = 'posted'
        GROUP BY e.date
        ORDER BY e.date`,
    )
    .all(
      ctx.workspaceId,
      invoice.id,
      invoice.posted_entry_id,
      ctx.workspaceId,
      ctx.workspaceId,
      ctx.workspaceId,
      ctx.workspaceId,
      ctx.workspaceId,
      ctx.workspaceId,
      accountId,
    ) as { date: string; net: number }[];
}

/** The posted entry's date (the invoice's issue day, `invoice.ts`), or null. §H-TENANT. */
export function entryDateOf(ctx: WorkspaceContext, entryId: string | null): string | null {
  if (entryId === null) return null;
  const row = ctx.store.db
    .prepare('SELECT date FROM journal_entry WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, entryId) as { date: string } | undefined;
  return row?.date ?? null;
}

/** The invoice's sale line, or the refusal (D192 point 2: exactly one, `no_sale_line` / `sale_not_single_line`). */
export function saleLineOf(ctx: WorkspaceContext, invoice: { id: string; posted_entry_id: string | null }): Result | { line: SaleLine; entryDate: string } {
  const lines = saleCreditLinesOf(ctx, invoice.posted_entry_id);
  const entryDate = entryDateOf(ctx, invoice.posted_entry_id);
  if (lines.length === 0 || entryDate === null) {
    return invalid('proceedsInvoiceId', 'no_sale_line', {
      proceedsInvoiceId: invoice.id,
      hint: 'the invoice has no posted sale line (a migrated open item, for example): book the proceeds yourself with proceedsBooking book_proceeds and a reason, on the account the earlier books used',
    });
  }
  if (lines.length > 1) {
    return invalid('proceedsInvoiceId', 'sale_not_single_line', {
      proceedsInvoiceId: invoice.id,
      saleLines: lines.map((l) => ({ accountNumber: l.accountNumber, baseCreditMinor: l.baseCreditMinor })),
      hint: 'invoice the asset on its own invoice (one position), or book the proceeds yourself with proceedsBooking book_proceeds and a reason',
    });
  }
  return { line: lines[0] as SaleLine, entryDate };
}

/**
 * D192 point 2: the reductions booked against the invoice (a partial credit note, an A14 Skonto, an A14
 * write-off), in the invoice's currency. Warned, never refused or adjusted. §H-TENANT on each read.
 */
export function saleReductionsOf(ctx: WorkspaceContext, invoiceId: string): { creditNotes: { id: string; number: string | null; totalMinor: number }[]; skontoMinor: number; writeOffMinor: number } {
  const notes = (ctx.store.db
    .prepare(
      `SELECT id, number, total_minor FROM document
        WHERE workspace_id = ? AND type = 'credit_note' AND credited_document_id = ? AND status NOT IN ('draft', 'cancelled')
        ORDER BY id`,
    )
    .all(ctx.workspaceId, invoiceId) as { id: string; number: string | null; total_minor: number }[])
    .filter((n) => creditNoteCounts(ctx, n.id))
    .map((n) => ({ id: n.id, number: n.number, totalMinor: n.total_minor }));
  const allocations = ctx.store.db
    .prepare(
      `SELECT p.status AS status, p.reversal_entry_id AS reversal_entry_id, p.journal_entry_id AS journal_entry_id,
              a.skonto_minor AS skonto, a.writeoff_minor AS writeoff
         FROM payment_allocation a
         JOIN payment p ON p.id = a.payment_id AND p.workspace_id = a.workspace_id
        WHERE a.workspace_id = ? AND a.target_kind = 'document' AND a.target_id = ?`,
    )
    .all(ctx.workspaceId, invoiceId) as { status: string; reversal_entry_id: string | null; journal_entry_id: string | null; skonto: number; writeoff: number }[];
  let skontoMinor = 0;
  let writeOffMinor = 0;
  for (const r of allocations) {
    if (!paymentStands(ctx, r)) continue;
    skontoMinor += r.skonto;
    writeOffMinor += r.writeoff;
  }
  return { creditNotes: notes, skontoMinor, writeOffMinor };
}

/** The one invoice a payment lies WHOLLY on now (D191 point 1's rule, current allocations), or null. */
export function invoicePaymentLiesWhollyOn(ctx: WorkspaceContext, paymentId: string): string | null {
  const payment = readPayment(ctx, paymentId);
  if (payment === undefined) return null;
  const picture = paymentAllocationPicture(ctx, payment);
  return picture.invoiceIds.length === 1 && picture.unallocatedMinor === 0 && !picture.otherTargets ? (picture.invoiceIds[0] as string) : null;
}

/** A standing disposal that already resolves to an invoice (D192 point 13). */
export interface StandingInvoiceDisposal {
  transactionId: string;
  assetId: string;
  date: string;
}

/**
 * D192 point 13 (critic G1): another disposal of this workspace that STANDS (no compensating row names
 * it, D170) and resolves to `invoiceId` now: it stores that invoice, or a payment that lies wholly on
 * it. One query per kind, both scoped by `workspace_id` on the disposal and on the compensating row.
 */
export function standingDisposalOnInvoice(ctx: WorkspaceContext, invoiceId: string): StandingInvoiceDisposal | null {
  const standing = `d.workspace_id = ? AND d.type = 'disposal' AND NOT EXISTS (
      SELECT 1 FROM asset_transaction r WHERE r.workspace_id = d.workspace_id
         AND r.source_document_type = 'asset_transaction' AND r.source_document_id = d.id)`;
  const direct = ctx.store.db
    .prepare(
      `SELECT d.id AS id, d.asset_id AS asset_id, d.date AS date FROM asset_transaction d
        WHERE ${standing} AND d.source_document_type = 'invoice' AND d.source_document_id = ?
        ORDER BY d.rowid LIMIT 1`,
    )
    .get(ctx.workspaceId, invoiceId) as { id: string; asset_id: string; date: string } | undefined;
  if (direct !== undefined) return { transactionId: direct.id, assetId: direct.asset_id, date: direct.date };
  const viaPayment = ctx.store.db
    .prepare(
      `SELECT d.id AS id, d.asset_id AS asset_id, d.date AS date, d.source_document_id AS payment_id FROM asset_transaction d
        WHERE ${standing} AND d.source_document_type = 'payment'
        ORDER BY d.rowid`,
    )
    .all(ctx.workspaceId) as { id: string; asset_id: string; date: string; payment_id: string }[];
  const hit = viaPayment.find((r) => invoicePaymentLiesWhollyOn(ctx, r.payment_id) === invoiceId);
  return hit === undefined ? null : { transactionId: hit.id, assetId: hit.asset_id, date: hit.date };
}

/** The accounts a payment's own entry moves (D192 point 7 ii: the N2 warning on any of them). §H-TENANT. */
function paymentEntryAccounts(ctx: WorkspaceContext, payment: PaymentRow): Set<string> {
  if (payment.journal_entry_id === null) return new Set();
  const rows = ctx.store.db
    .prepare(
      `SELECT DISTINCT l.account_id AS account_id FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id AND e.workspace_id = ?
        WHERE l.entry_id = ?`,
    )
    .all(ctx.workspaceId, payment.journal_entry_id) as { account_id: string }[];
  return new Set(rows.map((r) => r.account_id));
}

/**
 * Validate the optional link (D191) and resolve it: which invoice and which payment it names, the
 * D191 resolution of a payment given alone, and the counterparty and payment-picture warnings. Returns
 * null (no link), a refusal Result, or the validated link. Writes nothing. The proceeds themselves are
 * the caller's business: `clear_via_document` derives them from the invoice's sale line, and
 * `book_proceeds` warns through `bookProceedsWarnings`.
 */
export function resolveProceedsLink(
  ctx: WorkspaceContext,
  input: ProceedsLinkInput,
  counterpartyName: string | null,
): Result | ProceedsLink | null {
  const given = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  for (const field of ['proceedsInvoiceId', 'proceedsPaymentId'] as const) {
    const v = input[field];
    if (v !== undefined && v !== null && typeof v !== 'string') return err('invalid_input', { field });
  }
  const invoiceId = given(input.proceedsInvoiceId) ? input.proceedsInvoiceId : null;
  const paymentId = given(input.proceedsPaymentId) ? input.proceedsPaymentId : null;
  if (invoiceId === null && paymentId === null) return null;

  const warnings: ProceedsWarning[] = [];
  const wanted = (counterpartyName ?? '').trim().toLowerCase();
  const compareName = (contactId: string | null, documentType: ProceedsDocumentType) => {
    const name = nameOf(ctx, contactId);
    if (wanted.length > 0 && name !== null && name.trim().toLowerCase() !== wanted) {
      warnings.push({ code: 'counterparty_differs', documentType, documentCounterparty: name, counterpartyName });
    }
  };

  let invoice: InvoiceRow | undefined;
  if (invoiceId !== null) {
    invoice = readInvoice(ctx, invoiceId);
    // §H-TENANT: a foreign id answers exactly as an unknown one.
    if (invoice === undefined) return invalid('proceedsInvoiceId', 'not_found', { proceedsInvoiceId: invoiceId });
    if (invoice.type !== 'invoice') return invalid('proceedsInvoiceId', 'not_an_invoice', { proceedsInvoiceId: invoiceId, type: invoice.type });
    if (invoice.status === 'draft') return invalid('proceedsInvoiceId', 'not_issued', { proceedsInvoiceId: invoiceId });
    if (!invoiceDocumentStands(ctx, invoice)) {
      return invalid('proceedsInvoiceId', 'not_standing', { proceedsInvoiceId: invoiceId, status: invoice.status });
    }
  }
  let payment: PaymentRow | undefined;
  if (paymentId !== null) {
    payment = readPayment(ctx, paymentId);
    if (payment === undefined) return invalid('proceedsPaymentId', 'not_found', { proceedsPaymentId: paymentId });
    if (payment.direction !== 'incoming') return invalid('proceedsPaymentId', 'not_incoming', { proceedsPaymentId: paymentId, direction: payment.direction });
    if (!paymentStands(ctx, payment)) return invalid('proceedsPaymentId', 'not_standing', { proceedsPaymentId: paymentId });
  }
  // Critic r1 F2 + r2 G1: a payment linked alone links its invoice ONLY when the whole payment went to
  // that one invoice (point 1: the invoice's check then covers the payment). Otherwise the payment stays
  // the link, so money that is not on the invoice (a remainder on account, another target) is never
  // dropped from the check, and the caller is warned when an invoice is involved.
  let invoiceFromPayment = false;
  let paymentInvoiceIds: string[] = [];
  if (invoice === undefined && payment !== undefined) {
    const picture = paymentAllocationPicture(ctx, payment);
    paymentInvoiceIds = picture.invoiceIds;
    const only = picture.invoiceIds.length === 1 ? (picture.invoiceIds[0] as string) : null;
    if (only !== null && picture.unallocatedMinor === 0 && !picture.otherTargets) {
      const settled = readInvoice(ctx, only);
      if (settled !== undefined && standingProceedsDocument(ctx, 'invoice', settled.id) !== null) {
        invoice = settled;
        invoiceFromPayment = true;
      }
    } else if (picture.invoiceIds.length > 1) {
      warnings.push({ code: 'proceeds_payment_spans_invoices', documentType: 'payment', proceedsPaymentId: payment.id, invoiceIds: picture.invoiceIds });
    } else if (only !== null) {
      warnings.push({
        code: 'proceeds_payment_partly_unallocated',
        documentType: 'payment',
        proceedsPaymentId: payment.id,
        invoiceId: only,
        unallocatedMinor: picture.unallocatedMinor,
        otherTargets: picture.otherTargets,
        hint: 'the payment is not wholly on this invoice (a remainder on account or another target); the payment stays the linked document',
      });
    }
  }
  if (invoice !== undefined && payment !== undefined && !invoiceFromPayment) {
    const settles = ctx.store.db
      .prepare(
        `SELECT 1 FROM payment_allocation WHERE workspace_id = ? AND payment_id = ? AND target_kind = 'document' AND target_id = ? LIMIT 1`,
      )
      .get(ctx.workspaceId, payment.id, invoice.id);
    if (settles === undefined) {
      return invalid('proceedsPaymentId', 'payment_not_for_invoice', {
        proceedsInvoiceId: invoice.id,
        proceedsPaymentId: payment.id,
        hint: 'link the invoice alone, or the payment that settles it',
      });
    }
  }

  if (invoice !== undefined) compareName(invoice.contact_id, 'invoice');
  else if (payment !== undefined) compareName(payment.counterparty_id, 'payment');

  return invoice !== undefined
    ? { storedType: 'invoice', storedId: invoice.id, invoiceId: invoice.id, paymentId, invoiceFromPayment, warnings, invoice, payment: payment ?? null, paymentInvoiceIds }
    : { storedType: 'payment', storedId: (payment as PaymentRow).id, invoiceId: null, paymentId, invoiceFromPayment, warnings, invoice: null, payment: payment ?? null, paymentInvoiceIds };
}

/**
 * D192 point 7: the warnings of a linked disposal booked under `book_proceeds` (the caller's account
 * and amount). D191's amount and currency differences; `proceeds_double_counted` when the account is
 * not one of the invoice's NON-TAX credit lines (N1: 2200 now warns) or, for a payment link, is any
 * account the payment's entry moved (N2: the bank, 1100 for a Guthaben); `proceeds_exceed_sale_line`
 * when the manual clearing on an invoice's sale account exceeds its LARGEST single line there.
 */
export function bookProceedsWarnings(ctx: WorkspaceContext, link: ProceedsLink, proceedsRappen: number, proceedsAccountId: string | null): ProceedsWarning[] {
  const warnings: ProceedsWarning[] = [];
  const base = (ctx.store.db.prepare('SELECT base_currency FROM workspace WHERE id = ?').get(ctx.workspaceId) as { base_currency: string | null } | undefined)
    ?.base_currency ?? 'CHF';
  const invoice = link.invoice;
  if (invoice !== null) {
    if (invoice.currency !== base) {
      warnings.push({ code: 'proceeds_currency_differs', documentType: 'invoice', documentCurrency: invoice.currency, proceedsCurrency: base });
    } else if (invoice.total_minor !== proceedsRappen) {
      warnings.push({ code: 'proceeds_amount_differs', documentType: 'invoice', documentAmountMinor: invoice.total_minor, proceedsRappen, hint: 'an invoice carries the gross with VAT; the disposal books the proceeds as entered' });
    }
    if (proceedsAccountId !== null) {
      const onSaleAccount = saleCreditLinesOf(ctx, invoice.posted_entry_id).filter((l) => l.accountId === proceedsAccountId);
      if (onSaleAccount.length === 0) {
        warnings.push({
          code: 'proceeds_double_counted',
          documentType: 'invoice',
          proceedsAccountId,
          hint: 'the invoice already books this sale; proceeds booked here count it twice. Clear via the invoice (assets.proceeds_booking clear_via_document), or book the proceeds on the account of the invoice\'s sale line',
        });
      } else {
        const largest = Math.max(...onSaleAccount.map((l) => l.baseCreditMinor));
        if (proceedsRappen > largest) {
          warnings.push({ code: 'proceeds_exceed_sale_line', documentType: 'invoice', proceedsAccountId, proceedsRappen, largestSaleLineMinor: largest, hint: 'more than the largest sale line on this account: other turnover of the invoice would be cleared too' });
        }
      }
    }
  } else if (link.payment !== null) {
    const payment = link.payment;
    if (payment.base_amount_minor !== proceedsRappen) {
      warnings.push({ code: 'proceeds_amount_differs', documentType: 'payment', documentAmountMinor: payment.base_amount_minor, proceedsRappen });
    }
    if (proceedsAccountId !== null && paymentEntryAccounts(ctx, payment).has(proceedsAccountId)) {
      warnings.push({
        code: 'proceeds_double_counted',
        documentType: 'payment',
        proceedsAccountId,
        hint: 'the payment already booked this money on this account; proceeds booked here count the receipt twice. Issue the invoice, apply the payment to it (allocate_payment), then dispose against the invoice',
      });
    }
  }
  return warnings;
}

/** Is the account one of the linked invoice's non-tax credit accounts (the manual clearing, D192 point 7 i)? */
export function isInvoiceSaleAccount(ctx: WorkspaceContext, link: ProceedsLink | null, accountId: string): boolean {
  return link !== null && link.invoice !== null && proceedsOnInvoiceSaleCredit(ctx, link.invoice, accountId);
}
