/**
 * A21, QR incoming-payment matching: the queue that turns "money arrived" into "invoice paid".
 *
 * The design in one paragraph. An incoming bank credit enters the QUEUE as a `reconciliation_match`
 * row (`recordIncomingCredit`: manual entry today, A20's camt importer through the same seam later),
 * is SCORED against the open invoices by its structured reference (`matchIncomingByQrr`, a pure
 * read), and leaves the queue by a DECISION: `applyQrMatch` settles an invoice, `overrideQrMatch`
 * corrects or dismisses. The one thing this module never does is post: every settlement is an A14
 * `recordPayment` (intent `post_payment`, `source: 'qr'`) and every correction an A14
 * `reversePayment`, so §H-AUDIT, §H-PERIOD, the Ist-VAT stamp, the FX refusal and the A17-C1
 * settlement-side guard all bind A21 for free, through the one posting path (Pattern P3).
 *
 * THE SCORING VOCABULARY IS FIXED (spec §6b) and mirrors A14's honesty rule: a word that stretches
 * stops meaning anything. `high` is reserved for an exact reference AND an exact amount, where
 * "exact" admits exactly two figures: the invoice's own open amount (the payer used the invoice's
 * QR part) and open + unpaid Mahngebühr (the payer used the Mahnung's QR part, which carries the
 * invoice's OWN reference per D73). Everything else that still names an invoice is `medium` with
 * the reason in words, and everything that names none is `none`, including a mistyped check digit:
 * the A14 rule that a typo is reported as a typo and never silently degrades into a ranking hint
 * holds here with more force, because this module's `high` can move money unattended.
 *
 * THE MAHNGEBÜHR SPLIT (spec §0 note 4). A16's open item includes a booked fee, but A14 allocations
 * target documents only (the A15 §4 / D59 known limit), so a credit covering invoice + fee
 * allocates the invoice's open amount and PARKS the fee share as a Guthaben. The pair nets to zero
 * on the OP-Liste and the A16 reconciliation holds; clearing the parked share against the fee is
 * A14's future allocation target, not a bespoke posting here.
 *
 * P8, WHO MAY APPLY UNATTENDED. For a HUMAN or AGENT caller, `apply_qr_match` posts without
 * `confirmed: true` only when the workspace's `auto_apply` dial is ON and the LIVE score of this
 * credit against this invoice is `high`; an override of an APPLIED row always requires
 * `confirmed: true`, because an override is by definition a human disagreeing with the machine.
 * For a STORED RULE there is no such nuance at all: `apply_qr_match` and `override_qr_match` are
 * on the G01 denylist outright (D77, the who-may-act logic: `confirmed` here gates a JUDGMENT
 * about whose money arrived, not a dispatch, and a rule's stored `confirmed: true` is a lie the
 * gate cannot see through, which the A21 critic's F1/F2 demonstrated on rows). The dial verb
 * `set_qr_auto_apply` is denied too (D65 leg (e)), so the dial, which admits live `high` scores
 * only, is the one and only unattended path into a settlement.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import {
  requireString,
  requireDate,
  optionalId,
  optionalText,
  optionalDate,
} from '../ledger/inputGuards.js';
import { classifyReference, formatReference } from '../payments/reference.js';
import {
  recordPayment,
  reversePayment,
  settledMinor,
  SETTLEABLE_STATUSES,
  documentReferences,
  PAYMENT_INTENTS,
  writeOffThresholdOf,
} from '../payments/payment.js';
import type { DocRow } from '../payments/payment.js';
import { listOpenItems } from '../debtors/openItems.js';
import { applySavedView } from '../customization/views.js';

// --- The closed enumerations (§H-ENUM, single point) ---------------------------------------------

export const QR_MATCH_CONFIDENCES = ['high', 'medium', 'none'] as const;
export type QrMatchConfidence = (typeof QR_MATCH_CONFIDENCES)[number];

/**
 * Why a score is what it is, as machine keys the GUI renders from its own catalogue (P11). A `high`
 * carries which exact figure matched; a `medium` carries the direction of the discrepancy or the
 * currency question; a `none` carries what stopped the match. No free text is ever minted here.
 */
export const QR_MATCH_REASONS = [
  'exact_open',
  'exact_open_plus_fee',
  'amount_short',
  'amount_over',
  'currency_differs',
  'no_invoice',
  'already_paid',
  'ambiguous_reference',
  'reference_invalid',
  'no_reference',
] as const;
export type QrMatchReason = (typeof QR_MATCH_REASONS)[number];

export const QR_MATCH_STATUSES = ['open', 'applied', 'dismissed'] as const;
export type QrMatchStatus = (typeof QR_MATCH_STATUSES)[number];

export const QR_APPLY_MODES = ['full', 'partial'] as const;

export const QR_OVERRIDE_ACTIONS = ['unmatch', 'dismiss'] as const;

// --- Row and view shapes -------------------------------------------------------------------------

interface CreditRow {
  id: string;
  workspace_id: string;
  bank_txn_id: string | null;
  bank_account_id: string;
  amount_minor: number;
  currency: string;
  value_date: string;
  reference_kind: string;
  reference_value: string | null;
  payer_name: string | null;
  invoice_id: string | null;
  confidence: QrMatchConfidence;
  reason: string | null;
  status: QrMatchStatus;
  applied_mode: string | null;
  payment_id: string | null;
  reversed_payment_ids: string;
  decided_by: string | null;
  decided_at: string | null;
  created_by: string | null;
  created_at: string;
}

/** The score of one credit's facts against the books, the same shape both faces render (P5). */
export interface QrMatchScore {
  confidence: QrMatchConfidence;
  /** Null only for the theoretical no-reason case; every shipped path names one. */
  reason: QrMatchReason | null;
  /** The invoice the score names, when it names one (`high`/`medium`, and `already_paid`). */
  invoiceId: string | null;
  invoiceNumber: string | null;
  contactId: string | null;
  contactName: string | null;
  /**
   * The PRINCIPAL still owed on the invoice: total minus settled, NET of linked open credit notes
   * (A13's `creditedOpenMinor`, the same netting A15's `principalOf` demands with), without the
   * fee. This is the figure a correct payer pays, so it is the figure `exact_open` compares with.
   */
  invoiceOpenMinor: number | null;
  /** The linked open credit-note value already reducing the claim (A13). Informational. */
  creditedOpenMinor: number | null;
  /** The unpaid booked Mahngebühr riding on the invoice's open item (A15/A16). */
  dunningFeeMinor: number | null;
  /** What the customer owes under this reference: `invoiceOpenMinor + dunningFeeMinor`. */
  totalDueMinor: number | null;
  /**
   * Credit minus total due. Negative = short, positive = over. Null when no invoice is named AND
   * whenever the currencies differ: a subtraction across two units is not a delta (critic F6).
   */
  deltaMinor: number | null;
  invoiceCurrency: string | null;
  reference: {
    kind: string;
    value: string | null;
    display: string | null;
    valid: boolean;
  };
}

export interface QrCreditView {
  creditId: string;
  bankTxnId: string | null;
  bankAccountId: string;
  bankAccountName: string | null;
  amountMinor: number;
  currency: string;
  valueDate: string;
  payerName: string | null;
  status: QrMatchStatus;
  /** The LIVE score for an open row (a later-issued invoice is found); the decided score otherwise. */
  score: QrMatchScore;
  /** The invoice the row is proposed against or was applied to. */
  invoiceId: string | null;
  /** The mode the applied decision was taken in (`full`/`partial`), part of the replay identity (F5). */
  appliedMode: string | null;
  paymentId: string | null;
  /** Payments an override reversed, oldest first: the row's correction chain (§H-AUDIT). */
  reversedPaymentIds: string[];
  decidedBy: string | null;
  decidedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

export type RecordIncomingCreditOk = {
  credit: QrCreditView;
  /**
   * The G01 event hook: `qr_match.needs_review` resolves its entity id from THIS field, so a credit
   * that scored `high` sets it null and emits no occurrence (the `dunning.proposed` precedent).
   */
  needsReviewCreditId: string | null;
};

export type MatchQrPaymentOk = { match: QrMatchScore };

export type ApplyQrMatchOk = { paymentId: string; credit: QrCreditView };

export type OverrideQrMatchOk = { credit: QrCreditView; reversedPaymentId: string | null };

export type SetQrAutoApplyOk = { autoApply: boolean };

// --- Internals -----------------------------------------------------------------------------------

/** Abort the memoised write with a structured cause: nothing commits, nothing replays (A14's shape). */
class QrAbort {
  constructor(public readonly result: Result) {}
}

/**
 * Run a memoised write that may abort. `rememberIdempotent` stores WHATEVER compute returns, so a
 * rejection returned from inside would be memoised and replayed forever, turning a transient refusal
 * (a locked period, a since-settled invoice) into a permanent one. Throwing rolls the transaction
 * back, memoises nothing, and the caller still gets a P9 Result rather than an exception.
 */
function runGuarded(body: () => Result): Result {
  try {
    return body();
  } catch (e) {
    if (e instanceof QrAbort) return e.result;
    throw e;
  }
}

/** Optional reference: absent or null (no structured reference), or a string. */
function optionalReference(value: unknown): ReturnType<typeof err> | null {
  if (value === undefined || value === null || typeof value === 'string') return null;
  return err('invalid_input', { field: 'reference' });
}

/** The P8 dial (spec §0 note 5). Absent row = OFF: unattended applying is opt-in, never a default. */
export function qrAutoApplyEnabled(ctx: WorkspaceContext): boolean {
  const row = ctx.store.db
    .prepare('SELECT auto_apply AS v FROM qr_match_config WHERE workspace_id = ?')
    .get(ctx.workspaceId) as { v: number } | undefined;
  return row?.v === 1;
}

function readCreditRow(ctx: WorkspaceContext, creditId: string): CreditRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM reconciliation_match WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, creditId) as CreditRow | undefined;
}

/**
 * A16's open-item figures for one document: `openMinor` INCLUDES the fee, `dunningFeeMinor` names
 * it, and `creditedMinor` is A13's linked open credit-note value (the reduction the payer already
 * holds a Gutschrift for). Read from A16 rather than re-derived, the A15 rule: never fork the join.
 */
function openItemFigures(
  ctx: WorkspaceContext,
): Map<string, { openMinor: number; feeMinor: number; creditedMinor: number }> {
  const listed = listOpenItems(ctx, {});
  const map = new Map<string, { openMinor: number; feeMinor: number; creditedMinor: number }>();
  if (!listed.ok) return map;
  const items = listed['items'] as {
    kind: string;
    documentId: string | null;
    openMinor: number;
    dunningFeeMinor: number;
    creditedOpenMinor: number;
  }[];
  for (const item of items) {
    if (item.kind !== 'document' || item.documentId === null) continue;
    map.set(item.documentId, {
      openMinor: item.openMinor,
      feeMinor: item.dunningFeeMinor,
      creditedMinor: item.creditedOpenMinor,
    });
  }
  return map;
}

interface InvoiceHit {
  doc: DocRow & { contact_name: string | null };
  open: boolean;
  /** The A14 view: total minus settled, GROSS. The allocation cap, never the expectation. */
  grossOpenMinor: number;
  /** What the customer still owes on the invoice itself: gross open net of linked credit notes. */
  principalMinor: number;
  creditedMinor: number;
  feeMinor: number;
}

/** Every non-draft invoice whose A11-derived reference equals `value`, open or settled. */
function invoicesByReference(ctx: WorkspaceContext, value: string): InvoiceHit[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT d.id, d.type, d.number, d.status, d.contact_id, d.currency, d.subtotal_minor,
              d.tax_minor, d.total_minor, d.issue_date, d.due_date, d.posted_entry_id,
              c.name AS contact_name
         FROM document d
         LEFT JOIN contact c ON c.id = d.contact_id AND c.workspace_id = ?
        WHERE d.workspace_id = ? AND d.type = 'invoice' AND d.number IS NOT NULL
          AND d.status NOT IN ('draft', 'cancelled', 'converted')
        ORDER BY d.rowid`,
    )
    .all(ctx.workspaceId, ctx.workspaceId) as (DocRow & { contact_name: string | null })[];

  const figures = openItemFigures(ctx);
  const hits: InvoiceHit[] = [];
  for (const doc of rows) {
    if (!documentReferences(doc).some((r) => r.value === value)) continue;
    const paid = settledMinor(ctx, 'document', doc.id);
    const grossOpenMinor = Math.max(0, doc.total_minor - paid);
    const creditedMinor = figures.get(doc.id)?.creditedMinor ?? 0;
    // The F4 netting: a payer holding a Gutschrift owes the invoice MINUS it, and that is the
    // amount the scorer must expect (A15's `principalOf`, one capability over). An invoice whose
    // credit notes cover it entirely has nothing left for a payment to settle.
    const principalMinor = Math.max(0, grossOpenMinor - creditedMinor);
    const open = principalMinor > 0 && SETTLEABLE_STATUSES.has(doc.status);
    hits.push({
      doc,
      open,
      grossOpenMinor,
      principalMinor,
      creditedMinor,
      feeMinor: figures.get(doc.id)?.feeMinor ?? 0,
    });
  }
  return hits;
}

function emptyScore(
  reference: QrMatchScore['reference'],
  reason: QrMatchReason,
): QrMatchScore {
  return {
    confidence: 'none',
    reason,
    invoiceId: null,
    invoiceNumber: null,
    contactId: null,
    contactName: null,
    invoiceOpenMinor: null,
    creditedOpenMinor: null,
    dunningFeeMinor: null,
    totalDueMinor: null,
    deltaMinor: null,
    invoiceCurrency: null,
    reference,
  };
}

/**
 * Score one invoice against a credit's amount and currency: the one place the confidence words are
 * given their meaning, used by the free scoring, the record-time scoring, and the P8 gate alike so
 * the three can never disagree.
 */
function scoreHit(
  hit: InvoiceHit,
  amountMinor: number,
  currency: string,
  reference: QrMatchScore['reference'],
): QrMatchScore {
  const totalDue = hit.principalMinor + hit.feeMinor;
  const base: Omit<QrMatchScore, 'confidence' | 'reason'> = {
    invoiceId: hit.doc.id,
    invoiceNumber: hit.doc.number,
    contactId: hit.doc.contact_id,
    contactName: hit.doc.contact_name,
    invoiceOpenMinor: hit.principalMinor,
    creditedOpenMinor: hit.creditedMinor,
    dunningFeeMinor: hit.feeMinor,
    totalDueMinor: totalDue,
    deltaMinor: amountMinor - totalDue,
    invoiceCurrency: hit.doc.currency,
    reference,
  };
  if (hit.doc.currency !== currency) {
    // The conversion the payer's bank applied happened outside these books (spec §0 note 7): the
    // invoice is NAMED, the confidence is capped, and apply refuses rather than guesses. The delta
    // is NULL, not a subtraction across two units (critic F6).
    return { ...base, deltaMinor: null, confidence: 'medium', reason: 'currency_differs' };
  }
  if (amountMinor === hit.principalMinor) return { ...base, confidence: 'high', reason: 'exact_open' };
  if (hit.feeMinor > 0 && amountMinor === totalDue) {
    return { ...base, confidence: 'high', reason: 'exact_open_plus_fee' };
  }
  // A 5-Rappen difference is `medium`, not `high`: the confidence never rounds away a real
  // discrepancy (P2), and the write-off question belongs to the human pressing accept-as-full.
  if (amountMinor < totalDue) return { ...base, confidence: 'medium', reason: 'amount_short' };
  return { ...base, confidence: 'medium', reason: 'amount_over' };
}

export interface MatchQrPaymentInput {
  reference?: string | null;
  amountMinor?: number;
  currency?: string;
  valueDate?: string;
}

/** The pure scoring read (US-A21.1/3/5). Writes nothing; both faces and the P8 gate call it. */
export function matchIncomingByQrr(ctx: WorkspaceContext, input: MatchQrPaymentInput): Result<MatchQrPaymentOk> {
  const guard = optionalReference(input.reference) ?? optionalDate(input.valueDate, 'valueDate');
  if (guard) return guard;
  if (!Number.isSafeInteger(input.amountMinor) || (input.amountMinor as number) <= 0) {
    return err('invalid_input', { field: 'amountMinor' });
  }
  if (input.currency !== undefined && typeof input.currency !== 'string') {
    return err('invalid_input', { field: 'currency' });
  }
  const amountMinor = input.amountMinor as number;
  const currency = input.currency ?? workspaceBaseCurrency(ctx);

  const classified = classifyReference(input.reference);
  const reference: QrMatchScore['reference'] = {
    kind: classified.kind,
    value: classified.value,
    display: classified.value === null ? null : formatReference(classified.kind, classified.value),
    valid: classified.valid,
  };

  // An unstructured or absent reference is not an error: it is A20's heuristic lane (P9).
  if (classified.kind === 'none' || classified.kind === 'free_text') {
    return ok<MatchQrPaymentOk>({ match: emptyScore(reference, 'no_reference') });
  }
  // A mistyped check digit is a TYPO and is reported as one; it never ranks (the A14 rule).
  if (!classified.valid) {
    return ok<MatchQrPaymentOk>({ match: emptyScore(reference, 'reference_invalid') });
  }

  const hits = invoicesByReference(ctx, classified.value as string);
  const openHits = hits.filter((h) => h.open);
  if (openHits.length === 0) {
    if (hits.length > 0) {
      // The reference resolves, but the invoice is settled: "you already booked this" is the
      // answer, with the invoice named so the surface can link it.
      const settled = hits[0]!;
      return ok<MatchQrPaymentOk>({
        match: {
          ...emptyScore(reference, 'already_paid'),
          invoiceId: settled.doc.id,
          invoiceNumber: settled.doc.number,
          contactId: settled.doc.contact_id,
          contactName: settled.doc.contact_name,
          invoiceCurrency: settled.doc.currency,
        },
      });
    }
    return ok<MatchQrPaymentOk>({ match: emptyScore(reference, 'no_invoice') });
  }
  if (openHits.length > 1) {
    // Two open invoices claiming one reference: guessing between them is the one thing this
    // surface must not do (the A14 prefill rule, applied to money). DEFENSIVE, and honestly so
    // (critic F8): A11 derives the QRR from the gap-free UNIQUE invoice number, so no shipped door
    // can mint two open invoices under one reference today. The branch guards data arriving from
    // outside those doors (a future A20 import, a SCOR regime, a restored backup) and is not to be
    // read as exercised behaviour.
    return ok<MatchQrPaymentOk>({ match: emptyScore(reference, 'ambiguous_reference') });
  }
  return ok<MatchQrPaymentOk>({ match: scoreHit(openHits[0]!, amountMinor, currency, reference) });
}

function workspaceBaseCurrency(ctx: WorkspaceContext): string {
  const row = ctx.store.db
    .prepare('SELECT base_currency FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { base_currency: string } | undefined;
  return row?.base_currency ?? 'CHF';
}

function parseReversed(row: CreditRow): string[] {
  try {
    const parsed = JSON.parse(row.reversed_payment_ids) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Re-derive a row's score from its stored facts: what the queue shows for every OPEN row. */
function liveScoreOf(ctx: WorkspaceContext, row: CreditRow): QrMatchScore {
  const scored = matchIncomingByQrr(ctx, {
    reference: row.reference_value,
    amountMinor: row.amount_minor,
    currency: row.currency,
  });
  if (scored.ok) return scored.match;
  // The facts were validated at record time, so a failing re-score is unreachable; degrade to the
  // stored words rather than throwing (P9).
  return {
    ...emptyScore(
      { kind: row.reference_kind, value: row.reference_value, display: row.reference_value, valid: true },
      'no_reference',
    ),
    confidence: row.confidence,
    reason: (row.reason as QrMatchReason | null) ?? null,
  };
}

/**
 * The stored decision as a score shape, for decided rows. The WORDS are history and never
 * re-scored (confidence and reason are what was decided), but the FIGURES are live (critic F7):
 * spec §6's success state promises "a reviewed partial shows the remaining open amount", and the
 * remaining open is a fact about the books now, not about the decision then. `deltaMinor` stays
 * null: the credit has been decided, so there is no discrepancy left to describe.
 */
function decidedScoreOf(ctx: WorkspaceContext, row: CreditRow): QrMatchScore {
  const classified = classifyReference(row.reference_value);
  const reference: QrMatchScore['reference'] = {
    kind: row.reference_kind,
    value: classified.value,
    display: classified.value === null ? null : formatReference(classified.kind, classified.value),
    valid: classified.valid,
  };
  const doc =
    row.invoice_id === null
      ? undefined
      : (ctx.store.db
          .prepare(
            `SELECT d.number, d.contact_id, d.currency, d.total_minor, c.name AS contact_name
               FROM document d LEFT JOIN contact c ON c.id = d.contact_id AND c.workspace_id = ?
              WHERE d.workspace_id = ? AND d.id = ?`,
          )
          .get(ctx.workspaceId, ctx.workspaceId, row.invoice_id) as
          | {
              number: string | null;
              contact_id: string | null;
              currency: string;
              total_minor: number;
              contact_name: string | null;
            }
          | undefined);
  let principalMinor: number | null = null;
  let creditedMinor: number | null = null;
  let feeMinor: number | null = null;
  let totalDueMinor: number | null = null;
  if (doc !== undefined && row.invoice_id !== null) {
    const grossOpen = Math.max(0, doc.total_minor - settledMinor(ctx, 'document', row.invoice_id));
    const figures = openItemFigures(ctx).get(row.invoice_id);
    creditedMinor = figures?.creditedMinor ?? 0;
    feeMinor = figures?.feeMinor ?? 0;
    principalMinor = Math.max(0, grossOpen - creditedMinor);
    totalDueMinor = principalMinor + feeMinor;
  }
  return {
    confidence: row.confidence,
    reason: (row.reason as QrMatchReason | null) ?? null,
    invoiceId: row.invoice_id,
    invoiceNumber: doc?.number ?? null,
    contactId: doc?.contact_id ?? null,
    contactName: doc?.contact_name ?? null,
    invoiceOpenMinor: principalMinor,
    creditedOpenMinor: creditedMinor,
    dunningFeeMinor: feeMinor,
    totalDueMinor,
    deltaMinor: null,
    invoiceCurrency: doc?.currency ?? null,
    reference,
  };
}

function creditView(ctx: WorkspaceContext, row: CreditRow): QrCreditView {
  const account = ctx.store.db
    .prepare('SELECT name FROM bank_account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, row.bank_account_id) as { name: string } | undefined;
  const score = row.status === 'open' ? liveScoreOf(ctx, row) : decidedScoreOf(ctx, row);
  return {
    creditId: row.id,
    bankTxnId: row.bank_txn_id,
    bankAccountId: row.bank_account_id,
    bankAccountName: account?.name ?? null,
    amountMinor: row.amount_minor,
    currency: row.currency,
    valueDate: row.value_date,
    payerName: row.payer_name,
    status: row.status,
    score,
    invoiceId: row.invoice_id,
    appliedMode: row.applied_mode,
    paymentId: row.payment_id,
    reversedPaymentIds: parseReversed(row),
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

// --- recordIncomingCredit (US-A21.1..3, the ingestion door; spec §0 note 2) ----------------------

export interface RecordIncomingCreditInput {
  bankAccountId?: string;
  amountMinor?: number;
  valueDate?: string;
  reference?: string | null;
  currency?: string;
  payerName?: string;
  bankTxnId?: string;
  idempotencyKey?: string;
}

export function recordIncomingCredit(
  ctx: WorkspaceContext,
  input: RecordIncomingCreditInput,
): Result {
  const capable = ctx.capabilities.assert('pay');
  if (!capable.ok) return capable;
  const guard =
    requireString(input.bankAccountId, 'bankAccountId') ??
    requireDate(input.valueDate, 'valueDate') ??
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    optionalReference(input.reference) ??
    optionalText(input.payerName, 'payerName') ??
    optionalId(input.bankTxnId, 'bankTxnId');
  if (guard) return guard;
  if (!Number.isSafeInteger(input.amountMinor) || (input.amountMinor as number) <= 0) {
    return err('invalid_input', { field: 'amountMinor' });
  }
  if (input.currency !== undefined && typeof input.currency !== 'string') {
    return err('invalid_input', { field: 'currency' });
  }

  const scopedKey = JSON.stringify(['record_incoming_credit', input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'record_incoming_credit');
  if (replayed !== undefined) return replayed;

  // The credit must land on a REGISTERED account (A19): `needs_bank_account` is the P9 CTA the
  // surface renders, and a foreign account id answers identically so nothing is probeable
  // (§H-TENANT).
  const account = ctx.store.db
    .prepare('SELECT id, currency FROM bank_account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.bankAccountId) as { id: string; currency: string } | undefined;
  if (account === undefined) {
    return err('needs_bank_account', { bankAccountId: input.bankAccountId });
  }

  // Statement-level dedupe (§H-IDEMPOTENT, second layer): a bank txn already registered returns the
  // EXISTING row as a success, because "this credit is in the queue" is the state the caller asked
  // for. A20's re-imported statement flows through here and duplicates nothing.
  if (input.bankTxnId !== undefined) {
    const existing = ctx.store.db
      .prepare('SELECT id FROM reconciliation_match WHERE workspace_id = ? AND bank_txn_id = ?')
      .get(ctx.workspaceId, input.bankTxnId) as { id: string } | undefined;
    if (existing !== undefined) {
      const row = readCreditRow(ctx, existing.id) as CreditRow;
      return ok<RecordIncomingCreditOk>({ credit: creditView(ctx, row), needsReviewCreditId: null });
    }
  }

  const currency = input.currency ?? account.currency;
  const scored = matchIncomingByQrr(ctx, {
    reference: input.reference ?? null,
    amountMinor: input.amountMinor as number,
    currency,
  });
  if (!scored.ok) return scored;
  const score = scored.match;

  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'record_incoming_credit', () => {
    const id = ctx.ids.next('qrm');
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO reconciliation_match
           (id, workspace_id, bank_txn_id, bank_account_id, amount_minor, currency, value_date,
            reference_kind, reference_value, payer_name, invoice_id, confidence, reason, status,
            reversed_payment_ids, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', '[]', ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        input.bankTxnId ?? null,
        account.id,
        input.amountMinor as number,
        currency,
        input.valueDate as string,
        score.reference.kind,
        score.reference.value,
        input.payerName ?? null,
        score.invoiceId,
        score.confidence,
        score.reason,
        ctx.actor,
        now,
      );
    ctx.audit.record({
      entityKind: 'reconciliation_match',
      entityId: id,
      action: 'record',
      actor: ctx.actor,
      at: now,
    });
    const row = readCreditRow(ctx, id) as CreditRow;
    return ok<RecordIncomingCreditOk>({
      credit: creditView(ctx, row),
      needsReviewCreditId: score.confidence === 'high' ? null : id,
    });
  });
}

// --- applyQrMatch (US-A21.1/2/5, the settlement decision) ----------------------------------------

export interface ApplyQrMatchInput {
  creditId?: string;
  invoiceId?: string;
  mode?: string;
  confirmed?: boolean;
  idempotencyKey?: string;
}

/**
 * Settle an invoice from a queued credit, THROUGH A14 (Pattern P3: this module posts nothing).
 *
 * `mode` DEFAULTS TO `'partial'` (critic F3): the conservative mode, which never writes off, is
 * what an omitted word gets; accepting a shortfall as full payment is an explicit choice. `'full'`
 * settles the invoice completely: a surplus (the Mahngebühr share, or a genuine overpayment) parks
 * as a Guthaben, and a SHORT credit writes off the residual ONLY within A14's one-click write-off
 * threshold (`set_write_off_threshold`, default CHF 1.00): above it the verb refuses with the
 * amount named, because a receivable loss of arbitrary size must be typed deliberately through
 * `record_payment`, never derived from a mode word. All figures are NET of linked credit notes
 * (critic F4): a payer holding a Gutschrift owes the principal, and paying it exactly is a full
 * settlement, not a shortfall.
 *
 * Idempotent PER CREDIT: the A14 payment's key is derived from the credit id and its correction
 * generation, so no retry and no second caller can settle one credit twice (§H-IDEMPOTENT on
 * ROWS: the payment table's key uniqueness is the backstop, not this module's memory). The replay
 * identity INCLUDES the mode (critic F5, the `files.ts` confirmed-in-the-key precedent): asking
 * `full` after a `partial` was applied is a different question and refuses honestly rather than
 * answering ok while doing nothing.
 */
export function applyQrMatch(ctx: WorkspaceContext, input: ApplyQrMatchInput): Result {
  const capable = ctx.capabilities.assert('pay');
  if (!capable.ok) return capable;
  const guard =
    requireString(input.creditId, 'creditId') ??
    requireString(input.invoiceId, 'invoiceId') ??
    requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  // The SAFE mode is the default (F3): an agent that omits the optional word gets the mode that
  // books no loss, and 'full' is a stated choice.
  const mode = input.mode ?? 'partial';
  if (!(QR_APPLY_MODES as readonly string[]).includes(mode)) {
    return err('invalid_input', { field: 'mode', allowed: [...QR_APPLY_MODES] });
  }

  const scopedKey = JSON.stringify(['apply_qr_match', input.creditId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'apply_qr_match');
  if (replayed !== undefined) return replayed;

  const row = readCreditRow(ctx, input.creditId as string);
  if (row === undefined) return err('not_found', { creditId: input.creditId });
  if (row.status === 'dismissed') {
    return err('credit_dismissed', { creditId: row.id, reason: 'override the dismissal first' });
  }
  if (row.status === 'applied') {
    if (row.invoice_id === input.invoiceId && row.applied_mode === mode && row.payment_id !== null) {
      // Idempotent per credit: re-applying the SAME decision replays it, whatever the caller's key.
      return ok<ApplyQrMatchOk>({ paymentId: row.payment_id, credit: creditView(ctx, row) });
    }
    if (row.invoice_id === input.invoiceId) {
      // Same invoice, DIFFERENT mode: this is not a replay, it is a new question the applied
      // decision does not answer (F5). Refusing is the honest response; answering ok with the old
      // payment id would be the D59 reported-success-doing-nothing shape.
      return err('already_applied', {
        creditId: row.id,
        paymentId: row.payment_id,
        invoiceId: row.invoice_id,
        appliedMode: row.applied_mode,
        requestedMode: mode,
        reason: 'mode_mismatch: this credit was applied in another mode; corrections go through override_qr_match',
      });
    }
    return err('already_applied', {
      creditId: row.id,
      paymentId: row.payment_id,
      invoiceId: row.invoice_id,
      reason: 'a different invoice was settled from this credit; corrections go through override_qr_match',
    });
  }

  // The LIVE score of THIS credit against THIS invoice is what the P8 gate reads: a stale
  // record-time score must never be the thing that lets money move unattended.
  const scored = matchIncomingByQrr(ctx, {
    reference: row.reference_value,
    amountMinor: row.amount_minor,
    currency: row.currency,
  });
  if (!scored.ok) return scored;
  const live = scored.match;
  const scoredThisInvoice = live.invoiceId === input.invoiceId ? live : null;

  if (scoredThisInvoice?.reason === 'currency_differs') {
    return err('currency_mismatch', {
      creditId: row.id,
      creditCurrency: row.currency,
      invoiceCurrency: scoredThisInvoice.invoiceCurrency,
      reason:
        'the conversion applied by the payer bank cannot be re-derived here; record this settlement through record_payment, stating paymentAmountMinor',
    });
  }

  // P8: unattended only under the dial AND a live `high` on exactly this invoice.
  const unattendedOk = qrAutoApplyEnabled(ctx) && scoredThisInvoice?.confidence === 'high';
  if (!unattendedOk && input.confirmed !== true) {
    return err('needs_confirmation', {
      creditId: row.id,
      reason: 'apply_requires_confirmation',
      liveConfidence: scoredThisInvoice?.confidence ?? 'none',
    });
  }

  // The invoice, in the A14 sense. A settled or unknown invoice is refused with the honest word.
  const doc = ctx.store.db
    .prepare(
      `SELECT id, status, contact_id, currency, total_minor FROM document
        WHERE workspace_id = ? AND id = ? AND type = 'invoice'`,
    )
    .get(ctx.workspaceId, input.invoiceId) as
    | { id: string; status: string; contact_id: string | null; currency: string; total_minor: number }
    | undefined;
  if (doc === undefined) return err('not_found', { invoiceId: input.invoiceId });
  if (doc.currency !== row.currency) {
    return err('currency_mismatch', {
      creditId: row.id,
      creditCurrency: row.currency,
      invoiceCurrency: doc.currency,
      reason:
        'the conversion applied by the payer bank cannot be re-derived here; record this settlement through record_payment, stating paymentAmountMinor',
    });
  }
  // The three figures, exactly as the scorer derives them (F4): the GROSS open caps what an A14
  // allocation may release, the PRINCIPAL (gross net of linked credit notes) is what the customer
  // actually owes, and only the principal may ever feed a write-off. Without the netting, a payer
  // settling a credited invoice's net booked the Gutschrift's value to 3805 as a fictitious loss
  // while the credit note dangled: the reduction counted twice.
  const grossOpenMinor = doc.total_minor - settledMinor(ctx, 'document', doc.id);
  const creditedMinor = openItemFigures(ctx).get(doc.id)?.creditedMinor ?? 0;
  const principalMinor = Math.max(0, grossOpenMinor - creditedMinor);
  if (principalMinor <= 0 || !SETTLEABLE_STATUSES.has(doc.status)) {
    return err('already_paid', { invoiceId: doc.id, status: doc.status });
  }

  // THE NAMING TRAP, resolved here (the A19 file's own warning): A14's `bankAccountId` is the
  // LEDGER account the money moved on, A21's is the A19 Bankkonto row. The register row carries
  // the link (`ledger_account_id`), so the queue speaks A19 and the posting speaks A14, and no
  // caller ever has to know there are two vocabularies.
  const bankLink = ctx.store.db
    .prepare('SELECT ledger_account_id FROM bank_account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, row.bank_account_id) as { ledger_account_id: string } | undefined;
  if (bankLink === undefined) {
    return err('needs_bank_account', { bankAccountId: row.bank_account_id });
  }

  const allocateMinor = Math.min(row.amount_minor, grossOpenMinor);
  // The residual an accept-as-full would forgive, measured against the PRINCIPAL (F4), and bounded
  // by A14's own one-click threshold (F3): the same `writeOffThresholdOf` every A14 path consults,
  // never a second figure of A21's own. Above it, the verb refuses with the amount named: a larger
  // Ausbuchung is typed deliberately through record_payment's writeOffMinor, never derived from a
  // mode word (the A14 idiom: the threshold governs what a ONE-CLICK act may forgive).
  const writeOffMinor = mode === 'full' && row.amount_minor < principalMinor ? principalMinor - row.amount_minor : 0;
  if (writeOffMinor > 0) {
    const thresholdMinor = writeOffThresholdOf(ctx);
    if (writeOffMinor > thresholdMinor) {
      return err('write_off_above_threshold', {
        creditId: row.id,
        invoiceId: doc.id,
        writeOffMinor,
        thresholdMinor,
        reason:
          'accepting this credit as full payment would forgive more than the one-click write-off threshold; book it as a partial here, or record the settlement through record_payment stating the write-off deliberately',
      });
    }
  }

  // The correction generation: an override reverses `qr-apply-<id>-g0`, and the re-apply mints g1.
  // Without it, A14's per-workspace key uniqueness would (correctly) refuse the second payment.
  const generation = parseReversed(row).length;

  return runGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'apply_qr_match', () => {
      const paid = recordPayment(ctx, {
        direction: 'incoming',
        date: row.value_date,
        amountMinor: row.amount_minor,
        currency: row.currency,
        bankAccountId: bankLink.ledger_account_id,
        ...(doc.contact_id !== null ? { counterpartyKind: 'customer', counterpartyId: doc.contact_id } : {}),
        ...(row.reference_value !== null ? { reference: row.reference_value } : {}),
        allocations: [
          {
            documentId: doc.id,
            amountMinor: allocateMinor,
            ...(writeOffMinor > 0 ? { writeOffMinor } : {}),
          },
        ],
        source: 'qr',
        intent: PAYMENT_INTENTS.record,
        idempotencyKey: `qr-apply-${row.id}-g${generation}`,
      });
      // A rejection travels out as an abort so it is never memoised: a locked period or a race on
      // the invoice must stay retryable once the world changes.
      if (!paid.ok) throw new QrAbort(paid);
      const paymentId = paid['paymentId'] as string;
      const now = ctx.clock.now();
      ctx.store.db
        .prepare(
          `UPDATE reconciliation_match
              SET status = 'applied', invoice_id = ?, payment_id = ?, applied_mode = ?, confidence = ?,
                  reason = ?, decided_by = ?, decided_at = ?
            WHERE workspace_id = ? AND id = ?`,
        )
        .run(
          doc.id,
          paymentId,
          mode,
          scoredThisInvoice?.confidence ?? 'none',
          scoredThisInvoice?.reason ?? null,
          ctx.actor,
          now,
          ctx.workspaceId,
          row.id,
        );
      ctx.audit.record({
        entityKind: 'reconciliation_match',
        entityId: row.id,
        action: 'apply',
        actor: ctx.actor,
        at: now,
      });
      const updated = readCreditRow(ctx, row.id) as CreditRow;
      return ok<ApplyQrMatchOk>({ paymentId, credit: creditView(ctx, updated) });
    }),
  );
}

// --- overrideQrMatch (US-A21.4, the human veto on every row state) -------------------------------

export interface OverrideQrMatchInput {
  creditId?: string;
  invoiceId?: string;
  action?: string;
  confirmed?: boolean;
  idempotencyKey?: string;
}

/**
 * The manual decision on ANY row state (the US-A21.4 gap this spec rewrite closed).
 *
 * On an APPLIED row it first reverses the A14 payment (§H-AUDIT: a reversing entry re-opens the
 * settled documents; the allocations stay on disk and simply stop counting), then re-applies to the
 * named invoice or returns the row to open. On an OPEN row it re-points or clears the proposal, or
 * dismisses ("not a customer payment": book it via A02, or A20's create-entry lane when it lands).
 * A dismissed row can be re-opened the same way. Reversing money always requires `confirmed: true`:
 * the auto-apply dial never covers an override, because an override IS the human disagreeing.
 */
export function overrideQrMatch(ctx: WorkspaceContext, input: OverrideQrMatchInput): Result {
  const capable = ctx.capabilities.assert('pay');
  if (!capable.ok) return capable;
  const guard =
    requireString(input.creditId, 'creditId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const hasInvoice = input.invoiceId !== undefined;
  const hasAction = input.action !== undefined;
  if (hasInvoice === hasAction) {
    return err('invalid_input', {
      field: 'invoiceId',
      reason: 'name exactly one: the correct invoiceId, or an action (unmatch | dismiss)',
    });
  }
  if (hasInvoice && typeof input.invoiceId !== 'string') {
    return err('invalid_input', { field: 'invoiceId' });
  }
  if (hasAction && !(QR_OVERRIDE_ACTIONS as readonly string[]).includes(input.action as string)) {
    return err('invalid_input', { field: 'action', allowed: [...QR_OVERRIDE_ACTIONS] });
  }

  const scopedKey = JSON.stringify(['override_qr_match', input.creditId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'override_qr_match');
  if (replayed !== undefined) return replayed;

  const row = readCreditRow(ctx, input.creditId as string);
  if (row === undefined) return err('not_found', { creditId: input.creditId });

  const wasApplied = row.status === 'applied' && row.payment_id !== null;
  if (wasApplied && input.confirmed !== true) {
    return err('needs_confirmation', {
      creditId: row.id,
      reason: 'override_of_applied_requires_confirmation',
      paymentId: row.payment_id,
    });
  }
  if (row.status === 'dismissed' && hasAction && input.action === 'dismiss') {
    // Re-dismissing a dismissed row is the state it is already in: idempotent, not an error.
    return ok<OverrideQrMatchOk>({ credit: creditView(ctx, row), reversedPaymentId: null });
  }

  return runGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'override_qr_match', () => {
    let reversedPaymentId: string | null = null;
    let reversed = parseReversed(row);

    if (wasApplied) {
      const undone = reversePayment(ctx, {
        paymentId: row.payment_id as string,
        intent: PAYMENT_INTENTS.reverse,
        idempotencyKey: `qr-override-${row.id}-${row.payment_id}`,
      });
      // Abort, never memoise: a period lock on the reversal must stay retryable (see runGuarded).
      if (!undone.ok) throw new QrAbort(undone);
      reversedPaymentId = row.payment_id;
      reversed = [...reversed, row.payment_id as string];
      const now = ctx.clock.now();
      ctx.store.db
        .prepare(
          `UPDATE reconciliation_match
              SET status = 'open', payment_id = NULL, applied_mode = NULL, reversed_payment_ids = ?,
                  decided_by = ?, decided_at = ?
            WHERE workspace_id = ? AND id = ?`,
        )
        .run(JSON.stringify(reversed), ctx.actor, now, ctx.workspaceId, row.id);
    }

    const now = ctx.clock.now();
    if (hasAction && input.action === 'dismiss') {
      ctx.store.db
        .prepare(
          `UPDATE reconciliation_match
              SET status = 'dismissed', invoice_id = NULL, applied_mode = NULL, confidence = 'none', reason = NULL,
                  decided_by = ?, decided_at = ?
            WHERE workspace_id = ? AND id = ?`,
        )
        .run(ctx.actor, now, ctx.workspaceId, row.id);
    } else if (hasAction && input.action === 'unmatch') {
      ctx.store.db
        .prepare(
          `UPDATE reconciliation_match
              SET status = 'open', invoice_id = NULL, applied_mode = NULL, confidence = 'none', reason = NULL,
                  decided_by = ?, decided_at = ?
            WHERE workspace_id = ? AND id = ?`,
        )
        .run(ctx.actor, now, ctx.workspaceId, row.id);
    } else {
      // Re-point to the named invoice. On a previously applied row this MINTS the corrected
      // payment right away (the human just confirmed a money movement, leaving the row half-done
      // would strand it); on an open or dismissed row it records the proposal for the apply step.
      ctx.store.db
        .prepare(
          `UPDATE reconciliation_match
              SET status = 'open', invoice_id = ?, applied_mode = NULL, confidence = 'none', reason = NULL,
                  decided_by = ?, decided_at = ?
            WHERE workspace_id = ? AND id = ?`,
        )
        .run(input.invoiceId, ctx.actor, now, ctx.workspaceId, row.id);
      if (wasApplied) {
        const reapplied = applyQrMatch(ctx, {
          creditId: row.id,
          invoiceId: input.invoiceId as string,
          mode: 'partial',
          confirmed: true,
          idempotencyKey: `override-reapply-${input.idempotencyKey as string}`,
        });
        // A failed re-apply rolls the WHOLE override back, reversal included: a half-done override
        // (money reversed, nothing re-applied) is worse than a refused one, and the caller can
        // still choose `unmatch` explicitly to reverse without a target.
        if (!reapplied.ok) throw new QrAbort(reapplied);
      }
    }

    ctx.audit.record({
      entityKind: 'reconciliation_match',
      entityId: row.id,
      action: 'override',
      actor: ctx.actor,
      at: now,
    });
    const updated = readCreditRow(ctx, row.id) as CreditRow;
    return ok<OverrideQrMatchOk>({ credit: creditView(ctx, updated), reversedPaymentId });
    }),
  );
}

// --- listUnmatchedIncoming (US-A21.3/5, the queue read model, P5) --------------------------------

export interface ListUnmatchedIncomingInput {
  bankAccountId?: string;
  status?: string;
  from?: string;
  to?: string;
  savedViewId?: string;
}

export function listUnmatchedIncoming(
  ctx: WorkspaceContext,
  input: ListUnmatchedIncomingInput = {},
): Result {
  const guard =
    optionalId(input.bankAccountId, 'bankAccountId') ??
    optionalDate(input.from, 'from') ??
    optionalDate(input.to, 'to') ??
    optionalId(input.savedViewId, 'savedViewId');
  if (guard) return guard;
  if (input.status !== undefined && !(QR_MATCH_STATUSES as readonly string[]).includes(input.status)) {
    return err('invalid_input', { field: 'status', allowed: [...QR_MATCH_STATUSES] });
  }

  // The OP10 seam, one unconditional line (the `list_payments` shape): stored filters merge
  // UNDERNEATH anything named explicitly here.
  const viewed = applySavedView(ctx, 'reconciliation_match', input);
  if (!viewed.ok) return viewed;
  const filter = viewed.filter;

  const clauses = ['workspace_id = ?'];
  const params: string[] = [ctx.workspaceId];
  if (filter.bankAccountId !== undefined) {
    clauses.push('bank_account_id = ?');
    params.push(filter.bankAccountId);
  }
  if (filter.status !== undefined) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.from !== undefined) {
    clauses.push('value_date >= ?');
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    clauses.push('value_date <= ?');
    params.push(filter.to);
  }
  const rows = ctx.store.db
    .prepare(
      `SELECT * FROM reconciliation_match WHERE ${clauses.join(' AND ')}
        ORDER BY value_date DESC, rowid DESC`,
    )
    .all(...params) as CreditRow[];

  const items = rows.map((r) => creditView(ctx, r));
  const openItems = items.filter((i) => i.status === 'open');
  return ok({
    items,
    counts: {
      open: openItems.length,
      review: openItems.filter((i) => i.score.confidence === 'medium').length,
      unmatched: openItems.filter((i) => i.score.confidence === 'none').length,
      applied: items.filter((i) => i.status === 'applied').length,
      dismissed: items.filter((i) => i.status === 'dismissed').length,
    },
    autoApply: qrAutoApplyEnabled(ctx),
    /** A14's one-click write-off ceiling, so the surface can offer accept-as-full only inside it. */
    writeOffThresholdMinor: writeOffThresholdOf(ctx),
    filtered:
      filter.bankAccountId !== undefined || filter.status !== undefined || filter.from !== undefined || filter.to !== undefined,
  });
}

// --- setQrAutoApply (the P8 dial; NOT automatable, D65 leg (e)) ----------------------------------

export interface SetQrAutoApplyInput {
  autoApply?: boolean;
  idempotencyKey?: string;
}

export function setQrAutoApply(ctx: WorkspaceContext, input: SetQrAutoApplyInput): Result {
  const guard = requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  if (typeof input.autoApply !== 'boolean') {
    return err('invalid_input', { field: 'autoApply' });
  }
  // The side-table memo, the `set_aging_bucket_config` shape: the config row's PRIMARY KEY is the
  // workspace, so the key cannot live on the row it replaces.
  const scopedKey = JSON.stringify(['set_qr_auto_apply', input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'set_qr_auto_apply');
  if (replayed !== undefined) return replayed;
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'set_qr_auto_apply', () => {
    ctx.store.db
      .prepare(
        `INSERT INTO qr_match_config (workspace_id, auto_apply) VALUES (?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET auto_apply = excluded.auto_apply`,
      )
      .run(ctx.workspaceId, input.autoApply ? 1 : 0);
    ctx.audit.record({
      entityKind: 'reconciliation_match',
      entityId: ctx.workspaceId,
      action: 'set_auto_apply',
      actor: ctx.actor,
      at: ctx.clock.now(),
    });
    return ok<SetQrAutoApplyOk>({ autoApply: input.autoApply as boolean });
  });
}
