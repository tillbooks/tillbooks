/**
 * A41.2 and A41.4 (D184), THE EVIDENCE ON AN AGENT'S VORSCHLAG, computed by the ENGINE at read time.
 *
 * An agent's `book_bank_line` Vorschlag says what the agent believes; `agentReason` says why. Neither is
 * evidence. This module asks TILL's own question for the same line: the full-ladder proposal
 * (`proposeForLine`, rules, references and history as they stand NOW, since rules change) compared with
 * the agent's target. The certainty vocabulary is A39's own (`sure`, `learned`, `check`, `open`); there is
 * no score.
 *
 *  - The agent's target IS the engine's (same kind and identity: the accounts with their tax codes, the
 *    rule, the document, the entry, the run, the contact, the claims): the engine's certainty and reason.
 *  - It differs, or the engine has no proposal: `check`, with the engine's reason and target, so the
 *    person reads WHAT TILL would book instead.
 *  - A41.1's amount rule over every receipt the booking would carry (the payload's `attach`, and the files
 *    already on the line): a receipt whose captured amount does not fit the line adds
 *    `beleg_amount_differs` and `check`.
 *  - A41.4, the VAT: when a receipt states its VAT (`vat_amount`) and the booking taxes a leg, the receipt's
 *    figure beside the engine's (the net VAT of the lines `buildAccountsLines` builds, exactly what `book_bank_line` posts).
 *    Within `belege.vat_delta_tolerance_rappen`: a note (`vat_rounding`), the certainty unchanged; beyond:
 *    `vat_differs` and `check`. The booking always books the computed VAT (the statutory recompute in
 *    `postEntry` is untouched, D184 point 3).
 *  - D188: a receipt that states VAT where the booking taxes no leg (`vat_not_booked`: `vat` carries the figure
 *    beside a computed 0, `untaxed: true`), or in another currency than the line (`vat_not_compared`: the
 *    figure in its currency, not compared), is a NOTE: the certainty is unchanged, nothing is recomputed.
 *
 * Pure reads, §H-TENANT on every query.
 */

import type { WorkspaceContext } from '../context.js';
import { getSetting } from '../settings/settings.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { IS_HEAD } from '../files/head.js';
import { STATEMENT_IS_VOUCHER_SQL } from '../accounts/accounts.js';
import { buildAccountsLines, expandRule } from './bankBooking.js';
import { lineBookingDate, readBankTxn, readBankTxnDetail, lineStateOf } from './bankLines.js';
import type { BankLineLeg, BankTxnDetailRow, BankTxnRow, BookBankLineTarget } from './bankLines.js';
import { proposalContext, proposeForLine } from './bankProposals.js';
import type { BankLineProposal, BankProposalCertainty, BankProposalParams, BankProposalReason, BankProposalTarget, ProposalContext } from './bankProposals.js';
import { BANK_LINE_READ_CAPABILITY, BELEG_READ_CAPABILITY, amountMatch, belegMatchContext, fieldsOf, holdsRead, receiptFigures } from './belegMatch.js';
import type { BelegCandidateGroup, BelegMatchContext, VatComparison } from './belegMatch.js';
import { calendarDay } from './belegFigures.js';
import { readLineFactsMap } from './statementFacts.js';
import type { BankLineFacts } from './statementFacts.js';
import { attachReceiptVat, receiptVatContext } from './receiptVat.js';
import type { ReceiptVatReading, ReceiptVatSourceKind } from './receiptVat.js';

/** Why the evidence says what it says (closed, §H-ENUM; the Studio words each). */
export const EVIDENCE_REASONS = [
  'agrees',
  'differs_from_engine',
  'no_engine_proposal',
  'beleg_amount_differs',
  'vat_differs',
  'vat_rounding',
  // D188 (A39 §21): two NOTES, the certainty unchanged. The receipt states VAT but the booking taxes no leg
  // (`vat_not_booked`), or the receipt states it in another currency than the line, so it is not compared
  // (`vat_not_compared`). Before, both were silent (`vat: null`).
  'vat_not_booked',
  'vat_not_compared',
  'belege_not_readable',
] as const;
export type EvidenceReason = (typeof EVIDENCE_REASONS)[number];

/** One receipt the booking would carry, as the evidence judged it. */
export interface EvidenceBeleg {
  fileId: string;
  captureId: string | null;
  amountMinor: number | null;
  currency: string | null;
  /** Null when the receipt states no amount (nothing to compare). */
  amountAgrees: boolean | null;
}

export interface VorschlagEvidence {
  /** The engine's certainty when the agent's target is its own, else `check`; never the agent's word. */
  certainty: BankProposalCertainty;
  agrees: boolean;
  reasons: EvidenceReason[];
  /** What TILL itself proposes for the line now. */
  engine: { certainty: BankProposalCertainty; reasonCode: BankProposalReason; reasonParams: BankProposalParams; target: BankProposalTarget | null };
  belege: EvidenceBeleg[];
  vat: VatComparison | null;
}

/** A read's shared state: one proposal context, one receipt pool, one rate memo. */
export interface EvidenceContext {
  pc: ProposalContext;
  mc: BelegMatchContext | null;
  fxTolerancePct: number;
  vatToleranceMinor: number;
}

export function evidenceContext(ctx: WorkspaceContext, pc?: ProposalContext, mc?: BelegMatchContext | null): EvidenceContext {
  const pool = mc === undefined ? belegMatchContext(ctx) : mc;
  let context = pc;
  if (context === undefined) {
    // A41.8 (D193): TILL's own proposal carries the receipt's code, as the inbox shows it (a caller that passes its
    // context attached the reader itself).
    context = proposalContext(ctx);
    attachReceiptVat(context, receiptVatContext(ctx, pool));
  }
  return {
    pc: context,
    mc: pool,
    fxTolerancePct: getSetting<number>(ctx, 'belege.match_fx_tolerance_pct'),
    vatToleranceMinor: getSetting<number>(ctx, 'belege.vat_delta_tolerance_rappen'),
  };
}

// --- Target identity -------------------------------------------------------------------------------------

type Legs = readonly Pick<BankLineLeg, 'accountId' | 'taxCode' | 'amountMinor' | 'fx'>[];

/**
 * The legs as one string: account, tax code, AMOUNT and the transaction-currency figure of each, sorted
 * (security review, 07.11.2026: the right accounts with another split are another booking, and must never
 * inherit the engine's `sure` or `learned`).
 */
function legsSignature(legs: Legs, via: string | undefined): string {
  const parts = legs.map((l) => `${l.accountId}|${l.taxCode ?? ''}|${l.amountMinor}|${l.fx === undefined ? '' : `${l.fx.currency}:${l.fx.amountMinor}`}`).sort();
  return `accounts:${via ?? ''}:${parts.join(',')}`;
}

/** A target's identity on this line, expanding a rule to the accounts it books (when it can). */
function signatureOf(ctx: WorkspaceContext, row: BankTxnRow, target: BankProposalTarget | null): string | null {
  if (target === null) return null;
  switch (target.kind) {
    case 'accounts':
      return legsSignature(target.legs, target.viaAccountId);
    case 'rule': {
      // Expanded on THIS line with ITS asks: a rule is the legs and amounts it books, never only its id. A
      // rule that cannot be expanded as it stands (an ask still open) is a booking of its own, equal to
      // nothing else.
      const expanded = expandRule(ctx, row, { standardId: target.standardId, asks: target.asks ?? {} });
      return 'error' in expanded ? `rule:${target.standardId}:unexpanded:${JSON.stringify(target.asks ?? {})}` : legsSignature(expanded.target.legs, expanded.target.viaAccountId);
    }
    case 'open_item':
      return `open_item:${target.documentId ?? ''}:${(target.allocations ?? []).map((a) => `${a.documentId}|${a.amountMinor}`).sort().join(',')}:${target.remainder ?? ''}:${target.writeOffAccountId ?? ''}`;
    case 'existing_entry':
      return `existing_entry:${target.entryId}:${target.acceptDifference === true ? 'accept' : ''}`;
    case 'payment_batch':
      return `payment_batch:${target.batchId}`;
    case 'contact':
      return `contact:${target.contactId}`;
    case 'expense_claims':
      return `expense_claims:${[...target.claimIds].sort().join(',')}`;
    case 'ignore':
      return `ignore:${target.reason}`;
    default:
      return JSON.stringify(target);
  }
}

/** Does the agent's target book what the engine proposes? */
export function targetsAgree(ctx: WorkspaceContext, row: BankTxnRow, agent: BankProposalTarget | null, engine: BankLineProposal): boolean {
  if (agent === null || engine.target === null) return false;
  const a = signatureOf(ctx, row, agent);
  return a !== null && a === signatureOf(ctx, row, engine.target);
}

// --- A41.4, the VAT --------------------------------------------------------------------------------------

/**
 * The legs `target` books on this line (an accounts target as it stands, a rule expanded on the line with its
 * own asks) and its Durchlaufkonto, or null when the target books no account legs (an open item, a contact, an
 * entry link, a run, claims, an ignore) or the rule cannot be expanded as it stands.
 */
export function bookedLegsOf(ctx: WorkspaceContext, row: BankTxnRow, target: BookBankLineTarget | BankProposalTarget | null): { legs: readonly BankLineLeg[]; via: string | null } | null {
  if (target === null) return null;
  if (target.kind === 'accounts') return { legs: target.legs, via: target.viaAccountId ?? null };
  if (target.kind === 'rule') {
    const expanded = expandRule(ctx, row, { standardId: target.standardId, asks: target.asks ?? {} });
    if ('error' in expanded) return null;
    return { legs: expanded.target.legs, via: expanded.target.viaAccountId ?? null };
  }
  return null;
}

/**
 * A41.3 (critic A41 r1 P1/P2, kept by the re-cut): is a captured receipt EXPECTED for booking `row` to
 * `target`? Only on a DEBIT line (a capture is purchase evidence and pairs with money out) whose booked
 * accounts are not all "Beleg = Kontoauszug" (`STATEMENT_IS_VOUCHER_SQL`, the predicate the inbox's
 * `STATEMENT_COVERS_SQL` uses, e.g. the bank-fee accounts): there the statement IS the voucher. A target that
 * books no account legs expects one.
 */
export function receiptExpected(ctx: WorkspaceContext, row: BankTxnRow, target: BookBankLineTarget | BankProposalTarget | null): boolean {
  if (row.credit_debit !== 'DBIT') return false;
  const booked = bookedLegsOf(ctx, row, target);
  if (booked === null) return true;
  const ids = [...new Set([...booked.legs.map((l) => l.accountId), ...(booked.via !== null ? [booked.via] : [])])];
  if (ids.length === 0) return true;
  const marks = ids.map(() => '?').join(', ');
  const r = ctx.store.db
    .prepare(`SELECT COUNT(*) AS n FROM account a WHERE a.workspace_id = ? AND a.id IN (${marks}) AND ${STATEMENT_IS_VOUCHER_SQL('a')}`)
    .get(ctx.workspaceId, ...ids) as { n: number };
  return r.n !== ids.length;
}

/**
 * The VAT the engine books for `target` on this line: the net VAT of the lines `buildAccountsLines` builds, a
 * leg against the line reducing it, as an absolute figure in Rappen.
 * Null when no leg is taxed, the target books no legs, or the line is not in the base currency (where
 * `book_bank_line` refuses VAT).
 */
export function computedVatOf(ctx: WorkspaceContext, row: BankTxnRow, target: BookBankLineTarget | BankProposalTarget | null): number | null {
  const booked = bookedLegsOf(ctx, row, target);
  if (booked === null) return null;
  if (row.currency !== baseCurrencyOf(ctx)) return null;
  // Critic A41 r1 V2: the engine's OWN line builder (`buildAccountsLines`, what `book_bank_line` posts), so a
  // leg running against the line reduces the VAT exactly as the entry does. Signed by side (a debit adds, a
  // credit subtracts, the trace postEntry stores), absolute at the end: never a parallel formula.
  const bank = ctx.store.db
    .prepare('SELECT ledger_account_id FROM bank_account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, row.bank_account_id) as { ledger_account_id: string } | undefined;
  if (bank === undefined) return null;
  const built = buildAccountsLines(ctx, row, bank.ledger_account_id, booked.legs, lineBookingDate(row), booked.via ?? undefined);
  if ('error' in built) return null;
  let signed = 0;
  let taxed = false;
  for (const l of built.lines) {
    if (l.taxCode === undefined || l.taxAmount === undefined) continue;
    signed += (l.debit !== undefined && l.debit > 0 ? 1 : -1) * Math.abs(l.taxAmount);
    taxed = true;
  }
  return taxed ? Math.abs(signed) : null;
}

/** The VAT a BOOKED line's entry carries: the stored trace of its taxed lines, or null when none is taxed. */
export function bookedVatOf(ctx: WorkspaceContext, entryId: string | null): number | null {
  if (entryId === null) return null;
  const r = ctx.store.db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(l.tax_amount_minor), 0) AS s FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id AND e.workspace_id = ?
        WHERE l.entry_id = ? AND l.tax_code IS NOT NULL AND l.tax_amount_minor IS NOT NULL`,
    )
    .get(ctx.workspaceId, entryId) as { n: number; s: number };
  // Critic A41 r1 V2: the stored trace is signed (a leg against the line is negative); the net, absolute.
  return r.n > 0 ? Math.abs(r.s) : null;
}

export function compareVat(belegMinor: number, computedMinor: number, toleranceMinor: number): VatComparison {
  const deltaMinor = belegMinor - computedMinor;
  return { belegMinor, computedMinor, deltaMinor, toleranceMinor, withinTolerance: Math.abs(deltaMinor) <= toleranceMinor };
}

/** A41.4 on the inbox's candidate groups: each group's printed VAT beside `computedMinor` (null: nothing). */
export function withVatComparisons(groups: BelegCandidateGroup[], computedMinor: number | null, toleranceMinor: number): BelegCandidateGroup[] {
  if (computedMinor === null) return groups;
  return groups.map((g) => {
    const printed = g.files.find((f) => f.vatAmountMinor !== null && f.currency === g.currency)?.vatAmountMinor ?? null;
    return printed === null ? g : { ...g, vat: compareVat(printed, computedMinor, toleranceMinor) };
  });
}

// --- A41.8 (D193), the line's receipt beside the booking -------------------------------------------------

/** How a line's receipt VAT stands beside what the booking books (closed, §H-ENUM; the Studio words two). */
export const VAT_CHECKS = ['match', 'differs', 'unread', 'none'] as const;
export type VatCheck = (typeof VAT_CHECKS)[number];

/** The line's receipt as the inbox shows it beside `vatCheck` (a seat that reads receipts only). */
export interface ReceiptVatView {
  source: ReceiptVatSourceKind;
  /** The first receipt's ids. */
  captureId: string;
  fileId: string;
  /** How many receipts the line has (critic r2: a code is picked only for exactly one). */
  receipts: number;
  /** Every receipt at or above `belege.autobook_figure_trust` (figures and the VAT statement). */
  trusted: boolean;
  /** The receipt's one rate (0: it states no VAT), else null. */
  rateBp: number | null;
  /** The receipt's VAT in `currency` (0: none); several receipts: their compared sum; else null. */
  amountMinor: number | null;
  currency: string | null;
  /** One receipt whose gross covers the line (A41.1's amount rule). */
  covers: boolean;
  /** A41.4's comparison (`compareVat`) when one was made, else null. */
  comparison: VatComparison | null;
}

/**
 * A41.8: `vatCheck` of a line, through A41.4's ONE comparison (`compareVat`), over the line's receipts (assigned, filed
 * or the single candidate group, `receiptVat.ts`, each read on its own). `booking.booksAccounts` says whether the
 * booking books account legs at all; `booking.vatMinor` is what it computes (open: `computedVatOf` of the proposal's
 * target) or carries (booked: `bookedVatOf`), null when no leg is taxed. Critic r1 F1: a booking that self-assesses its
 * tax (`booking.selfAssessed`: a `reverse_charge` or `import` code) books no tax the VENDOR charged, so the receipt is
 * compared with 0.
 *  - `none`: no receipt, only silent ones, a line outside the base currency, a booking without accounts;
 *  - `unread`: a receipt's figures, or its VAT statement, are below the trust level;
 *  - `match` / `differs` (the REAL comparison): exactly ONE receipt, whose gross covers the line (`covers`), in the
 *    line's currency, stating its VAT: within / beyond `belege.vat_delta_tolerance_rappen` of the booking's;
 *  - every other case (critic r2 ruling: two or more receipts, a gross that does not cover the line, another or mixed
 *    currency, a silent receipt beside a stating one) is never `match`: `differs` when a trusted comparison (every
 *    receipt stating its VAT in the line's currency, summed) disagrees, otherwise `unread`.
 * `caps`: the proposal's `sure`/`learned` reads `check` (`receiptVatCap`): on `differs`, and on `unread` in those other
 * (structural) cases. ONE covering receipt in the line's currency that is merely unconfirmed reads `unread` WITHOUT the
 * cap, as before (an agent-read receipt does not overrule a person's rule; A41.2's evidence and A41.6 govern it).
 */
export function receiptVatCheck(
  readings: readonly ReceiptVatReading[],
  row: Pick<BankTxnRow, 'currency'>,
  baseCurrency: string,
  booking: { booksAccounts: boolean; vatMinor: number | null; selfAssessed?: boolean },
  toleranceMinor: number,
): { vatCheck: VatCheck; comparison: VatComparison | null; caps: boolean } {
  const none = { vatCheck: 'none' as const, comparison: null, caps: false };
  if (readings.length === 0 || row.currency !== baseCurrency || !booking.booksAccounts) return none;
  // The one receipt that may be compared for real: it covers the line, in the line's currency.
  const one = readings.length === 1 && readings[0]!.covers && readings[0]!.currency === row.currency;
  if (readings.some((r) => !r.trusted || (r.states !== 'silent' && !r.rateTrusted))) return { vatCheck: 'unread', comparison: null, caps: !one };
  if (readings.every((r) => r.states === 'silent')) return none;
  const compare = (beleg: number): VatComparison =>
    booking.selfAssessed === true
      ? compareVat(beleg, 0, toleranceMinor)
      : booking.vatMinor === null
        ? { ...compareVat(beleg, 0, toleranceMinor), untaxed: true }
        : compareVat(beleg, booking.vatMinor, toleranceMinor);
  const comparable = readings.every((r) => r.states !== 'silent' && r.amountMinor !== null && r.currency === row.currency);
  const comparison = comparable ? compare(readings.reduce((sum, r) => sum + (r.amountMinor as number), 0)) : null;
  if (one && comparison !== null) return { vatCheck: comparison.withinTolerance ? 'match' : 'differs', comparison, caps: !comparison.withinTolerance };
  return { vatCheck: comparison !== null && !comparison.withinTolerance ? 'differs' : 'unread', comparison, caps: true };
}

/** Critic r1 F1: is any of these codes self-assessed (`reverse_charge`, `import`) in this book? §H-TENANT. */
function anySelfAssessed(ctx: WorkspaceContext, codes: readonly string[]): boolean {
  if (codes.length === 0) return false;
  const r = ctx.store.db
    .prepare(`SELECT COUNT(*) AS n FROM tax_code WHERE workspace_id = ? AND code IN (${codes.map(() => '?').join(', ')}) AND kind IN ('reverse_charge', 'import')`)
    .get(ctx.workspaceId, ...codes) as { n: number };
  return r.n > 0;
}

/** Does the booking `target` would make on `row` self-assess its tax (a leg with a `reverse_charge` or `import` code)? */
export function targetSelfAssessed(ctx: WorkspaceContext, row: BankTxnRow, target: BookBankLineTarget | BankProposalTarget | null): boolean {
  const booked = bookedLegsOf(ctx, row, target);
  return booked !== null && anySelfAssessed(ctx, booked.legs.flatMap((l) => (l.taxCode !== undefined ? [l.taxCode] : [])));
}

/** Does a booked entry self-assess its tax (a line with a `reverse_charge` or `import` code)? */
export function entrySelfAssessed(ctx: WorkspaceContext, entryId: string | null): boolean {
  if (entryId === null) return false;
  const codes = ctx.store.db
    .prepare(
      `SELECT DISTINCT l.tax_code AS c FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id AND e.workspace_id = ?
        WHERE l.entry_id = ? AND l.tax_code IS NOT NULL`,
    )
    .all(ctx.workspaceId, entryId) as { c: string }[];
  return anySelfAssessed(ctx, codes.map((r) => r.c));
}

/** The view of a line's receipts (null for none): the first's ids, the one rate and VAT when there is ONE receipt. */
export function receiptVatViewOf(readings: readonly ReceiptVatReading[], comparison: VatComparison | null): ReceiptVatView | null {
  const first = readings[0];
  if (first === undefined) return null;
  const one = readings.length === 1;
  return {
    source: first.source,
    captureId: first.captureId,
    fileId: first.fileId,
    receipts: readings.length,
    trusted: readings.every((r) => r.trusted && (r.states === 'silent' || r.rateTrusted)),
    rateBp: one ? first.rateBp : null,
    amountMinor: one ? first.amountMinor : (comparison?.belegMinor ?? null),
    currency: one ? first.currency : comparison !== null ? (first.currency ?? null) : null,
    covers: one && first.covers,
    comparison,
  };
}

// --- The receipts the booking carries --------------------------------------------------------------------

interface CapturedFigures {
  captureId: string;
  amountMinor: number | null;
  currency: string | null;
  vatMinor: number | null;
  date: string | null;
}

/** The capture behind a file (its own document, else a capture over the same bytes), with its figures. */
function capturedFiguresOf(ctx: WorkspaceContext, fileId: string): CapturedFigures | null {
  const row = ctx.store.db
    .prepare(
      `SELECT c.id FROM captures c
         JOIN stored_file f ON f.workspace_id = c.workspace_id AND f.id = ?
        WHERE c.workspace_id = ? AND (c.document_id = f.id OR c.sha256 = f.sha256) AND c.status != 'discarded'
        ORDER BY (c.document_id = f.id) DESC, c.created_at, c.rowid LIMIT 1`,
    )
    .get(fileId, ctx.workspaceId) as { id: string } | undefined;
  if (row === undefined) return null;
  // Critic A41 r1 E1: the pool's own reading of the figures (`receiptFigures`): an amount stated without a
  // currency is in the base currency here too, so it is compared, never skipped.
  const fields = fieldsOf(ctx, row.id);
  const figures = receiptFigures(fields, baseCurrencyOf(ctx));
  const date = fields.get('invoice_date');
  return {
    captureId: row.id,
    amountMinor: figures?.amountMinor ?? null,
    currency: figures?.currency ?? null,
    vatMinor: figures?.vatMinor ?? null,
    // Critic A41.3 r2 P1: the one date parser (a value that is no calendar day is no date).
    date: calendarDay(date),
  };
}

/** The file ids a booking would carry: the payload's `attach` by id, then the files already on the line. */
function bookingFileIds(ctx: WorkspaceContext, bankTxnId: string, attach: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(attach)) {
    for (const a of attach) {
      const id = a !== null && typeof a === 'object' ? (a as { fileId?: unknown }).fileId : undefined;
      if (typeof id === 'string' && id !== '' && !out.includes(id)) out.push(id);
    }
  }
  const linked = ctx.store.db
    .prepare(`SELECT f.id FROM stored_file f WHERE f.workspace_id = ? AND f.entity_kind = 'bank_txn' AND f.entity_id = ? AND ${IS_HEAD('f')} ORDER BY f.created_at, f.rowid`)
    .all(ctx.workspaceId, bankTxnId) as { id: string }[];
  for (const l of linked) if (!out.includes(l.id)) out.push(l.id);
  return out;
}

// --- The evidence ----------------------------------------------------------------------------------------

/**
 * The engine's evidence for booking `row` to `agentTarget` with the receipts `attach` names (plus those on
 * the line). Exported for A41.6 and the tests; `vorschlagEvidenceOf` reads a payload.
 */
export function evidenceForBooking(
  ctx: WorkspaceContext,
  ec: EvidenceContext,
  row: BankTxnRow,
  detail: BankTxnDetailRow | undefined,
  facts: BankLineFacts | null,
  agentTarget: BankProposalTarget | null,
  attach: unknown,
): VorschlagEvidence {
  const engine = proposeForLine(ctx, ec.pc, row, detail);
  // Security review: the receipts are ALWAYS judged (showing is not deciding); a seat that may not read the
  // filing register is shown no per-receipt figure, and its certainty is capped at `check`
  // (`belege_not_readable`): a seat that cannot see the evidence cannot bulk on it.
  const readsBelege = holdsRead(ctx, BELEG_READ_CAPABILITY);
  const reasons: EvidenceReason[] = [];
  const agrees = engine.target !== null && targetsAgree(ctx, row, agentTarget, engine);
  let certainty: BankProposalCertainty;
  if (engine.target === null) {
    reasons.push('no_engine_proposal');
    certainty = 'check';
  } else if (agrees) {
    reasons.push('agrees');
    certainty = engine.certainty;
  } else {
    reasons.push('differs_from_engine');
    certainty = 'check';
  }
  const belege: EvidenceBeleg[] = [];
  let printedVat: number | null = null;
  // D188: the first VAT a receipt states in ANOTHER currency than the line (compared with nothing, only noted).
  let foreignVat: { minor: number; currency: string } | null = null;
  for (const fileId of bookingFileIds(ctx, row.id, attach)) {
    const figures = capturedFiguresOf(ctx, fileId);
    if (figures === null || figures.amountMinor === null || figures.currency === null) {
      belege.push({ fileId, captureId: figures?.captureId ?? null, amountMinor: figures?.amountMinor ?? null, currency: figures?.currency ?? null, amountAgrees: null });
      continue;
    }
    const fits =
      amountMatch(
        ctx,
        { fxTolerancePct: ec.fxTolerancePct },
        { row, facts },
        { amountMinor: figures.amountMinor, currency: figures.currency, date: figures.date ?? lineBookingDate(row) },
        ec.mc?.fx ?? new Map(),
      ) !== null;
    belege.push({ fileId, captureId: figures.captureId, amountMinor: figures.amountMinor, currency: figures.currency, amountAgrees: fits });
    if (printedVat === null && figures.vatMinor !== null && figures.currency === row.currency) printedVat = figures.vatMinor;
    if (foreignVat === null && figures.vatMinor !== null && figures.vatMinor > 0 && figures.currency !== row.currency) foreignVat = { minor: figures.vatMinor, currency: figures.currency };
  }
  if (belege.some((b) => b.amountAgrees === false)) {
    reasons.push('beleg_amount_differs');
    certainty = 'check';
  }
  let vat: VatComparison | null = null;
  const stated = printedVat !== null ? { minor: printedVat, currency: row.currency } : foreignVat;
  if (stated !== null) {
    const computed = computedVatOf(ctx, row, agentTarget);
    if (printedVat !== null && computed !== null) {
      vat = compareVat(printedVat, computed, ec.vatToleranceMinor);
      if (!vat.withinTolerance) {
        reasons.push('vat_differs');
        certainty = 'check';
      } else if (vat.deltaMinor !== 0) {
        reasons.push('vat_rounding');
      }
    } else if (computed === null && stated.minor > 0) {
      // D188: the receipt states VAT, the booking books none. A note with the figure; never `check` (an
      // untaxed booking of a foreign or a non-deductible receipt is often right), never a recompute.
      vat = { ...compareVat(stated.minor, 0, ec.vatToleranceMinor), currency: stated.currency, untaxed: true };
      reasons.push('vat_not_booked');
    } else if (computed !== null && printedVat === null && foreignVat !== null) {
      // D188: the booking taxes a leg in the line's currency; the receipt states its VAT in another. Not compared.
      vat = { belegMinor: foreignVat.minor, computedMinor: computed, deltaMinor: 0, toleranceMinor: ec.vatToleranceMinor, withinTolerance: true, currency: foreignVat.currency, notCompared: true };
      reasons.push('vat_not_compared');
    }
  }
  if (!readsBelege && belege.length > 0) {
    // Security review (side channel): what a hidden receipt says must not leak through a reason code, so a
    // seat that cannot read the receipts gets the SAME answer whether they agree or not. The judgement above
    // still ran; it governs every decision that does not depend on the caller's seat (autobook).
    const shown = reasons.filter((r) => r !== 'beleg_amount_differs' && r !== 'vat_differs' && r !== 'vat_rounding' && r !== 'vat_not_booked' && r !== 'vat_not_compared');
    reasons.length = 0;
    reasons.push(...shown, 'belege_not_readable');
    certainty = 'check';
  }
  return {
    certainty,
    agrees,
    reasons,
    engine: { certainty: engine.certainty, reasonCode: engine.reasonCode, reasonParams: engine.reasonParams, target: engine.target },
    belege: readsBelege ? belege : [],
    vat: readsBelege ? vat : null,
  };
}

/**
 * The evidence of ONE pending `book_bank_line` payload (`{ bankTxnId, target, attach? }`), or null when the
 * payload names no line of this workspace or the line is no longer open (its Vorschlag is stale anyway).
 */
export function vorschlagEvidenceOf(ctx: WorkspaceContext, ec: EvidenceContext, payload: Readonly<Record<string, unknown>>): VorschlagEvidence | null {
  const bankTxnId = payload['bankTxnId'];
  if (typeof bankTxnId !== 'string' || bankTxnId === '') return null;
  // Security review: TILL's own proposal for a bank line only for a seat that may read the bank inbox.
  if (!holdsRead(ctx, BANK_LINE_READ_CAPABILITY)) return null;
  const row = readBankTxn(ctx, bankTxnId);
  if (row === undefined || lineStateOf(ctx, row).state !== 'open') return null;
  const target = payload['target'];
  const agentTarget = target !== null && typeof target === 'object' && typeof (target as { kind?: unknown }).kind === 'string' ? (target as BankProposalTarget) : null;
  const facts = readLineFactsMap(ctx, [row.id]).get(row.id) ?? null;
  return evidenceForBooking(ctx, ec, row, readBankTxnDetail(ctx, row.id), facts, agentTarget, payload['attach']);
}
