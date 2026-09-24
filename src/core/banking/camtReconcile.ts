/**
 * A20, camt reconciliation: import, suggest, confirm, book, and the reconciled-to-balance read.
 *
 * THE COMPOSITION WITH A21, ANSWERED HERE (spec §0 note 2). A camt entry that is a booked,
 * non-reversal CREDIT flows into A21's queue through the public engine seam
 * `recordIncomingCredit({..., bankTxnId})`: A21 scores it, A21's own verbs decide it, and A21's
 * `bank_txn_id` dedupe makes a re-imported statement register nothing twice. This module builds NO
 * second matching machine for credits and NO wrapper verbs around A21's decisions: `confirmCamtMatch`
 * refuses a credit-classified txn with `use_qr_queue`, naming the A21 queue row to decide instead.
 * `confirmCamtMatch` covers exactly what A21 does not: an outgoing DEBIT settling one or more vendor
 * bills through A14 `recordPayment`, and an annotation LINK to an existing journal entry.
 *
 * PATTERN P3 IN FULL. Every posting is A02's `postEntry` or A14's `recordPayment` (which itself posts
 * through A02); this module posts nothing of its own and mints no journal row directly. The one leg it
 * owns is the RECORD of which write did the settling (`bank_txn_link`), never the writing itself.
 *
 * D81 (31.07.2026), REMEDIATING THE A20 CRITIC (docs/critique/a20-critic.md): camt's unit of identity
 * is the ENTRY (and, below it, the TRANSACTION), never the message. `importCamt` deduped only at the
 * message level (`bank_statement`'s unique key); `bank_txn` had no identity of its own, so an
 * overlapping statement, a re-cut period, or the camt.054-then-camt.053 pair re-imported every entry
 * (A20-C1), a multi-page statement lost everything after page 1 while reporting a safe no-op
 * (A20-C9), and a batch `Ntry` collapsed onto its first `TxDtls` alone (A20-C10). All three are one
 * root and are fixed together here: `camt.ts` now resolves each parsed row's identity
 * (`entryKey`, D81's AcctSvcrRef/NtryRef/content-hash ladder) and fans a batch out into one row per
 * `TxDtls`; this module enforces that identity as a `bank_txn` UNIQUE index and answers
 * `statement_amended` (never a silent `duplicate:true`) when a same-identity statement's content has
 * actually changed (A20-C2).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { requireString, optionalId, optionalText, optionalDate } from '../ledger/inputGuards.js';
import { postEntry } from '../ledger/postEntry.js';
import type { LineInput } from '../ledger/postEntry.js';
import { recordPayment, PAYMENT_INTENTS } from '../payments/payment.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { normalizeIban } from '../setup/iban.js';
import { applySavedView } from '../customization/views.js';
import { recordIncomingCredit, matchIncomingByQrr } from './qrMatch.js';
import type { QrMatchConfidence } from './qrMatch.js';
import { compactReference } from './pain001.js';
import { settledOnVendorBill } from '../purchase/reads.js';
import { parseCamt, hashCamtStatement } from './camt.js';
import type { CamtClassification, CamtCreditDebit, ParsedCamtStatement, CamtSkipReason } from './camt.js';

// --- Row shapes -----------------------------------------------------------------------------------

interface BankStatementRow {
  id: string;
  workspace_id: string;
  bank_account_id: string;
  message_type: string;
  statement_id: string;
  electronic_seq_nb: string | null;
  page_number: number;
  last_page_ind: number;
  content_hash: string;
  from_date: string | null;
  to_date: string | null;
  opening_balance_minor: number | null;
  closing_balance_minor: number | null;
  balance_currency: string | null;
  txn_count: number;
  imported_by: string | null;
  imported_at: string;
}

interface BankTxnRow {
  id: string;
  workspace_id: string;
  bank_account_id: string;
  statement_id: string;
  entry_key: string;
  entry_ref: string | null;
  amount_minor: number;
  currency: string;
  credit_debit: CamtCreditDebit;
  booking_date: string | null;
  value_date: string | null;
  reference_kind: string;
  reference_value: string | null;
  payer_name: string | null;
  reversal_ind: number;
  btc_domain: string | null;
  btc_family: string | null;
  btc_sub_family: string | null;
  batch_pmt_inf_id: string | null;
  classification: CamtClassification;
  credit_id: string | null;
  created_at: string;
}

interface BankTxnLinkRow {
  id: string;
  bank_txn_id: string;
  // `payment_batch` (A36 F2): the funding debit of an A18 Sammelzahlung, linked when the batch is
  // confirmed from the reconciliation board so the settled debit can no longer be double-booked.
  kind: 'payment' | 'journal_entry' | 'payment_batch';
  target_id: string;
  created_at: string;
}

// --- View shapes, the one both faces read (Pattern P5) ---------------------------------------------

export type CamtTxnStatus = 'matched' | 'unmatched' | 'partial';

export interface CamtTxnView {
  bankTxnId: string;
  bankAccountId: string;
  statementId: string;
  entryRef: string | null;
  amountMinor: number;
  currency: string;
  creditDebit: CamtCreditDebit;
  bookingDate: string | null;
  valueDate: string | null;
  referenceKind: string;
  referenceValue: string | null;
  payerName: string | null;
  reversalInd: boolean;
  classification: CamtClassification;
  status: CamtTxnStatus;
  /** Present only for `classification: 'incoming_credit'`: the A21 queue row deciding this txn. */
  creditId: string | null;
  /** Present only once linked (a debit settlement, a batch settlement, or a manual entry). */
  linkKind: 'payment' | 'journal_entry' | 'payment_batch' | null;
  linkTargetId: string | null;
}

function readStatementRow(ctx: WorkspaceContext, id: string): BankStatementRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM bank_statement WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as BankStatementRow | undefined;
}

function readTxnRow(ctx: WorkspaceContext, id: string): BankTxnRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM bank_txn WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as BankTxnRow | undefined;
}

function readLink(ctx: WorkspaceContext, bankTxnId: string): BankTxnLinkRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM bank_txn_link WHERE workspace_id = ? AND bank_txn_id = ?')
    .get(ctx.workspaceId, bankTxnId) as BankTxnLinkRow | undefined;
}

function creditRowStatus(
  ctx: WorkspaceContext,
  bankTxnId: string,
): { status: CamtTxnStatus; creditId: string | null } {
  const row = ctx.store.db
    .prepare('SELECT id, status, applied_mode FROM reconciliation_match WHERE workspace_id = ? AND bank_txn_id = ?')
    .get(ctx.workspaceId, bankTxnId) as { id: string; status: string; applied_mode: string | null } | undefined;
  if (row === undefined) return { status: 'unmatched', creditId: null };
  if (row.status === 'applied') {
    return { status: row.applied_mode === 'partial' ? 'partial' : 'matched', creditId: row.id };
  }
  return { status: 'unmatched', creditId: row.id };
}

function toTxnView(ctx: WorkspaceContext, row: BankTxnRow): CamtTxnView {
  let status: CamtTxnStatus = 'unmatched';
  let creditId: string | null = row.credit_id;
  let linkKind: 'payment' | 'journal_entry' | 'payment_batch' | null = null;
  let linkTargetId: string | null = null;

  if (row.classification === 'incoming_credit') {
    const scored = creditRowStatus(ctx, row.id);
    status = scored.status;
    creditId = scored.creditId;
  } else {
    const link = readLink(ctx, row.id);
    if (link !== undefined) {
      status = 'matched';
      linkKind = link.kind;
      linkTargetId = link.target_id;
    }
  }

  return {
    bankTxnId: row.id,
    bankAccountId: row.bank_account_id,
    statementId: row.statement_id,
    entryRef: row.entry_ref,
    amountMinor: row.amount_minor,
    currency: row.currency,
    creditDebit: row.credit_debit,
    bookingDate: row.booking_date,
    valueDate: row.value_date,
    referenceKind: row.reference_kind,
    referenceValue: row.reference_value,
    payerName: row.payer_name,
    reversalInd: row.reversal_ind === 1,
    classification: row.classification,
    status,
    creditId,
    linkKind,
    linkTargetId,
  };
}

// --- importCamt (US-A20.1) -------------------------------------------------------------------------

export interface ImportCamtInput {
  bankAccountId?: string;
  xml?: string;
  idempotencyKey?: string;
  /** D81's escape: admits a genuine same-day twin the entry-identity key would otherwise treat as a
   *  re-delivery of an already-imported booking. Off by default, so the ambiguity is answered by a
   *  human once, explicitly, rather than guessed on every import. */
  allowDuplicateEntries?: boolean;
}

export type ImportSkippedEntry = { entryRef: string | null; reason: CamtSkipReason; status?: string | null };

export type ImportCamtOk = {
  statementId: string;
  /** The number of `bank_txn` rows THIS call actually inserted (never the raw parsed count): a P9
   *  honest count, not a truncated one presented as complete (A20-C6). */
  txnCount: number;
  duplicate: boolean;
  /** Every `Ntry`/`TxDtls` this call did not import, and why: an unreadable amount, a status other
   *  than BOOK/PDNG, or an entry already present under the same identity (A20-C6). Always present,
   *  possibly empty. */
  skipped: ImportSkippedEntry[];
}

/**
 * A stable diff between an existing `bank_statement`'s stored content and a freshly re-parsed one
 * under the SAME identity key: named for A20-C2's `statement_amended` answer, so the operator sees
 * what changed rather than a silent `duplicate: true` that discards the correction.
 */
function diffAmendedStatement(
  ctx: WorkspaceContext,
  existing: BankStatementRow,
  fresh: ParsedCamtStatement,
): string[] {
  const changes: string[] = [];
  if (existing.opening_balance_minor !== fresh.openingBalanceMinor) {
    changes.push(`opening balance changed from ${existing.opening_balance_minor ?? 'n/a'} to ${fresh.openingBalanceMinor ?? 'n/a'}`);
  }
  if (existing.closing_balance_minor !== fresh.closingBalanceMinor) {
    changes.push(`closing balance changed from ${existing.closing_balance_minor ?? 'n/a'} to ${fresh.closingBalanceMinor ?? 'n/a'}`);
  }
  const oldRows = ctx.store.db
    .prepare('SELECT entry_key, amount_minor, currency, credit_debit FROM bank_txn WHERE workspace_id = ? AND statement_id = ?')
    .all(ctx.workspaceId, existing.id) as { entry_key: string; amount_minor: number; currency: string; credit_debit: string }[];
  const oldByKey = new Map(oldRows.map((r) => [r.entry_key, r]));
  const newByKey = new Map(fresh.entries.map((e) => [e.entryKey, e]));
  for (const [key, oldRow] of oldByKey) {
    const freshEntry = newByKey.get(key);
    if (freshEntry === undefined) {
      changes.push(`entry ${key} removed`);
      continue;
    }
    if (
      freshEntry.amountMinor !== oldRow.amount_minor ||
      freshEntry.currency !== oldRow.currency ||
      freshEntry.creditDebit !== oldRow.credit_debit
    ) {
      changes.push(`entry ${key} amount changed from ${oldRow.amount_minor} to ${freshEntry.amountMinor}`);
    }
  }
  for (const key of newByKey.keys()) {
    if (!oldByKey.has(key)) changes.push(`entry ${key} added`);
  }
  return changes;
}

/**
 * Import a camt.053/054 statement onto a registered A19 Bankkonto: parse, check the IBAN, dedupe the
 * STATEMENT on `(workspace, bank account, Stmt/Id, ElctrncSeqNb, page number)` and, inside it, dedupe
 * every ENTRY on its own identity (D81) so an overlapping or re-cut statement, or the
 * camt.054-then-camt.053 pair, cannot re-import a booking already on the books (A20-C1). A same-key
 * statement whose content has genuinely changed answers `statement_amended`, never a silent
 * `duplicate: true` (A20-C2). Persists `bank_statement` + `bank_txn`, and routes each booked
 * non-reversal CREDIT into A21's queue through `recordIncomingCredit`. Everything else is imported as
 * a fact and left for `confirmCamtMatch` / `createEntryForTxn` to settle.
 */
export function importCamt(ctx: WorkspaceContext, input: ImportCamtInput): Result<ImportCamtOk> {
  const capable = ctx.capabilities.assert('pay');
  if (!capable.ok) return capable;
  const guard =
    requireString(input.bankAccountId, 'bankAccountId') ??
    requireString(input.xml, 'xml') ??
    requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  if (input.allowDuplicateEntries !== undefined && typeof input.allowDuplicateEntries !== 'boolean') {
    return err('invalid_input', { field: 'allowDuplicateEntries' });
  }
  const allowDuplicateEntries = input.allowDuplicateEntries === true;

  const scopedKey = JSON.stringify(['import_camt', input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result<ImportCamtOk>>(ctx.workspaceId, scopedKey, 'import_camt');
  if (replayed !== undefined) return replayed;

  const account = ctx.store.db
    .prepare('SELECT id, iban, currency FROM bank_account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.bankAccountId) as { id: string; iban: string; currency: string } | undefined;
  if (account === undefined) return err('needs_bank_account', { bankAccountId: input.bankAccountId });

  const parsed = parseCamt(input.xml);
  if (!parsed.ok) return parsed;
  const stmt = parsed.statement;

  if (stmt.iban !== null && normalizeIban(stmt.iban) !== normalizeIban(account.iban)) {
    return err('iban_mismatch', { fileIban: stmt.iban, accountIban: account.iban });
  }

  const contentHash = hashCamtStatement(stmt);

  // D81/A20-C9: pagination is part of the statement's identity. Two pages of ONE multi-page statement
  // share Stmt/Id and ElctrncSeqNb by design (SPS 2.3 p.54); without the page number in the key, page
  // 2 collides with page 1 and is thrown away as a duplicate.
  const existing = ctx.store.db
    .prepare(
      `SELECT * FROM bank_statement
        WHERE workspace_id = ? AND bank_account_id = ? AND statement_id = ?
          AND COALESCE(electronic_seq_nb, '') = COALESCE(?, '') AND page_number = ?`,
    )
    .get(ctx.workspaceId, account.id, stmt.statementId, stmt.electronicSeqNb, stmt.pageNumber) as
    | BankStatementRow
    | undefined;
  if (existing !== undefined) {
    if (existing.content_hash === contentHash) {
      return ok<ImportCamtOk>({ statementId: existing.id, txnCount: existing.txn_count, duplicate: true, skipped: [] });
    }
    // A20-C2: the bank re-issued this exact statement identity with different content. The stale
    // figure is left standing (a silent overwrite would be worse) and the operator is told what
    // changed, naming the differing entries and balances rather than "already have this".
    return err('statement_amended', { statementId: existing.id, changes: diffAmendedStatement(ctx, existing, stmt) });
  }

  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'import_camt', () => {
    const now = ctx.clock.now();
    const statementRowId = ctx.ids.next('bstmt');

    // `bank_txn.statement_id` REFERENCES `bank_statement(id)` and foreign keys are enforced (ON), so
    // the parent row is inserted FIRST, with a placeholder txn_count corrected once the actual
    // inserted count (after entry-level dedupe skips) is known.
    ctx.store.db
      .prepare(
        `INSERT INTO bank_statement
           (id, workspace_id, bank_account_id, message_type, statement_id, electronic_seq_nb,
            page_number, last_page_ind, content_hash, from_date, to_date, opening_balance_minor,
            closing_balance_minor, balance_currency, txn_count, imported_by, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        statementRowId,
        ctx.workspaceId,
        account.id,
        stmt.messageType,
        stmt.statementId,
        stmt.electronicSeqNb,
        stmt.pageNumber,
        stmt.lastPage ? 1 : 0,
        contentHash,
        stmt.fromDate,
        stmt.toDate,
        stmt.openingBalanceMinor,
        stmt.closingBalanceMinor,
        stmt.balanceCurrency,
        0,
        ctx.actor,
        now,
      );

    // D81/A20-C1: every entry's identity is unique per (workspace, bank account). Preload the keys
    // already on the books for this account so an overlapping statement, a re-cut period, or the
    // camt.054-then-camt.053 pair is caught here rather than by the UNIQUE index throwing mid-insert.
    const existingKeys = new Set(
      (
        ctx.store.db
          .prepare('SELECT entry_key FROM bank_txn WHERE workspace_id = ? AND bank_account_id = ?')
          .all(ctx.workspaceId, account.id) as { entry_key: string }[]
      ).map((r) => r.entry_key),
    );

    const skipped: ImportSkippedEntry[] = stmt.skipped.map((s) => ({
      entryRef: s.entryRef,
      reason: s.reason,
      ...(s.status !== undefined ? { status: s.status } : {}),
    }));
    let insertedCount = 0;

    for (const entry of stmt.entries) {
      let storageKey = entry.entryKey;
      if (existingKeys.has(storageKey)) {
        if (!allowDuplicateEntries) {
          skipped.push({ entryRef: entry.entryRef, reason: 'duplicate_entry' });
          continue;
        }
        // The caller has explicitly told us this really is a second, genuine booking (D81): mint a
        // distinct storage key rather than relaxing the index, so the identity ladder stays exact for
        // every future import.
        let n = 1;
        while (existingKeys.has(`${entry.entryKey}~dup${n}`)) n += 1;
        storageKey = `${entry.entryKey}~dup${n}`;
      }
      existingKeys.add(storageKey);

      const txnId = ctx.ids.next('btxn');
      const reversal = entry.reversalInd;
      const classification: CamtClassification =
        reversal ? 'unclassified' : entry.creditDebit === 'CRDT' ? 'incoming_credit' : 'outgoing_debit';

      let creditId: string | null = null;
      if (classification === 'incoming_credit') {
        const recorded = recordIncomingCredit(ctx, {
          bankAccountId: account.id,
          amountMinor: entry.amountMinor,
          valueDate: entry.valueDate ?? entry.bookingDate ?? (stmt.toDate ?? now.slice(0, 10)),
          reference: entry.referenceValue,
          currency: entry.currency,
          ...(entry.payerName !== null ? { payerName: entry.payerName } : {}),
          bankTxnId: txnId,
          idempotencyKey: `camt-credit-${txnId}`,
        });
        // A rejection here is unreachable in ordinary operation (every field was already shaped to
        // what recordIncomingCredit demands); if the world still refuses, the row is still imported
        // as a booked fact with no queue entry, which is the honest degradation (P9): an unrouted
        // credit surfaces as unmatched on the reconciliation board rather than vanishing the import.
        if (recorded.ok) creditId = (recorded['credit'] as { creditId: string }).creditId;
      }

      ctx.store.db
        .prepare(
          `INSERT INTO bank_txn
             (id, workspace_id, bank_account_id, statement_id, entry_key, entry_ref, amount_minor,
              currency, credit_debit, booking_date, value_date, reference_kind, reference_value,
              payer_name, reversal_ind, btc_domain, btc_family, btc_sub_family, batch_pmt_inf_id,
              classification, credit_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          txnId,
          ctx.workspaceId,
          account.id,
          statementRowId,
          storageKey,
          entry.entryRef,
          entry.amountMinor,
          entry.currency,
          entry.creditDebit,
          entry.bookingDate,
          entry.valueDate,
          entry.referenceKind,
          entry.referenceValue,
          entry.payerName,
          reversal ? 1 : 0,
          entry.btcDomain,
          entry.btcFamily,
          entry.btcSubFamily,
          entry.batchPmtInfId,
          classification,
          creditId,
          now,
        );
      insertedCount += 1;
    }

    ctx.store.db
      .prepare('UPDATE bank_statement SET txn_count = ? WHERE workspace_id = ? AND id = ?')
      .run(insertedCount, ctx.workspaceId, statementRowId);

    ctx.audit.record({
      entityKind: 'bank_statement',
      entityId: statementRowId,
      action: 'import',
      actor: ctx.actor,
      at: now,
    });

    return ok<ImportCamtOk>({ statementId: statementRowId, txnCount: insertedCount, duplicate: false, skipped });
  });
}

// --- suggestCamtMatches (US-A20.2), read-only (Pattern P5) ------------------------------------------

/**
 * A36 adds the `payment_batch` kind (the batch-debit join) and a structured `signals` list beside the
 * single `reason` code. `signals` is the composed, translatable list of matched signals the GUI
 * renders verbatim (`camt.suggestion.reason.*`) and the agent reads structurally; `reason` stays the
 * single primary code for back-compat with the A21 credit path. `blocked` marks a proposal that is
 * shown for information but NOT one-click confirmable (a batch whose total does not equal the debit):
 * partial batch executions go to the manual split, honestly.
 */
export type CamtMatchSignal = 'amount' | 'value_date' | 'counterparty' | 'reference' | 'batch' | 'batch_total_mismatch';

export interface CamtMatchProposal {
  kind: 'invoice' | 'vendor_bill' | 'payment_batch';
  targetId: string;
  confidence: QrMatchConfidence;
  reason: string;
  signals?: readonly CamtMatchSignal[];
  blocked?: boolean;
}

export interface CamtTxnProposal {
  bankTxnId: string;
  classification: CamtClassification;
  proposal: CamtMatchProposal | null;
  /** A36: true when this booked txn has no proposal at or above the workspace review threshold. */
  needsReview: boolean;
}

export interface SuggestCamtMatchesInput {
  statementId?: string;
}

/** A36: the workspace's debit-matching tuning, with the spec defaults when no row is set. */
export interface CamtMatchConfig {
  valueDateWindowDays: number;
  reviewThreshold: 'any' | 'medium' | 'high';
}

export function readCamtMatchConfig(ctx: WorkspaceContext): CamtMatchConfig {
  const row = ctx.store.db
    .prepare('SELECT value_date_window_days AS w, review_threshold AS t FROM camt_match_config WHERE workspace_id = ?')
    .get(ctx.workspaceId) as { w: number; t: string } | undefined;
  const window = row !== undefined && Number.isInteger(row.w) && row.w >= 0 ? row.w : 5;
  const threshold: CamtMatchConfig['reviewThreshold'] =
    row?.t === 'medium' || row?.t === 'high' ? row.t : 'any';
  return { valueDateWindowDays: window, reviewThreshold: threshold };
}

/** A confidence rank so a threshold can be compared: none < medium < high. */
const CONFIDENCE_RANK: Record<QrMatchConfidence, number> = { none: 0, medium: 1, high: 2 };
const THRESHOLD_RANK: Record<CamtMatchConfig['reviewThreshold'], number> = { any: 1, medium: 1, high: 2 };

/**
 * A booked, non-reversal txn NEEDS REVIEW when it has no proposal at or above the workspace threshold.
 * Default `any`: needs review iff there is no proposal at all (every real proposal is at least
 * `medium`). A reversal-flagged (unclassified) txn is a returned movement a human always inspects, so
 * it never suppresses review on the strength of an automated score.
 */
function needsReviewFor(
  proposal: CamtMatchProposal | null,
  threshold: CamtMatchConfig['reviewThreshold'],
  reversal: boolean,
): boolean {
  // F3 remediation: honour the invariant this function's own doc states. A reversal-flagged
  // (unclassified) txn is a returned movement a human always inspects, so it needs review even when a
  // coincidental exact-amount candidate scores `high` (A20-C3 lets a reversal DBIT settle, but the
  // settlement stays a human's deliberate call, never an automated suppression).
  if (reversal) return true;
  if (proposal === null || proposal.blocked === true) return true;
  return CONFIDENCE_RANK[proposal.confidence] < THRESHOLD_RANK[threshold];
}

interface OpenBill {
  id: string;
  openMinor: number;
  dueDate: string | null;
  contactId: string;
  vendorReference: string | null;
}

/**
 * Every open vendor bill in this currency, with the amount still owed and the fields the ranker
 * scores on (counterparty contact, the supplier's own invoice number). §H-TENANT on the read.
 * Deliberately over `vendor_bill` directly rather than through `listVendorBills`'s ceiling-and-view
 * machinery: this is an internal scoring input, not a page a caller lists.
 */
function openVendorBills(ctx: WorkspaceContext, currency: string): OpenBill[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT id, due_date, payable_minor, contact_id, vendor_reference FROM vendor_bill
        WHERE workspace_id = ? AND status = 'posted' AND currency = ?`,
    )
    .all(ctx.workspaceId, currency) as {
    id: string;
    due_date: string | null;
    payable_minor: number;
    contact_id: string;
    vendor_reference: string | null;
  }[];
  return rows
    .map((r) => ({
      id: r.id,
      dueDate: r.due_date,
      openMinor: r.payable_minor - settledOnVendorBill(ctx, r.id),
      contactId: r.contact_id,
      vendorReference: r.vendor_reference,
    }))
    .filter((r) => r.openMinor > 0);
}

/** The contact's display name, for counterparty token overlap. */
function contactName(ctx: WorkspaceContext, contactId: string): string | null {
  const row = ctx.store.db
    .prepare('SELECT name FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, contactId) as { name: string | null } | undefined;
  return row?.name ?? null;
}

const LEGAL_FORM_STOPWORDS = new Set(['ag', 'gmbh', 'sa', 'sarl', 'sagl', 'ltd', 'inc', 'the']);

/** Lowercase, diacritic-fold, split on non-letters, drop legal-form stopwords and 1-char tokens. */
function nameTokens(s: string | null): Set<string> {
  if (s === null) return new Set();
  const folded = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const out = new Set<string>();
  for (const tok of folded.split(/[^a-z0-9]+/)) {
    if (tok.length >= 2 && !LEGAL_FORM_STOPWORDS.has(tok)) out.add(tok);
  }
  return out;
}

/** Absolute day distance between two ISO dates, or null when either is missing/unparseable. */
function dayDistance(a: string | null, b: string | null): number | null {
  if (a === null || b === null) return null;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.abs(Math.round((ta - tb) / 86_400_000));
}

/**
 * A36 the batch-debit join (spec §4): a debit whose `batch_pmt_inf_id` equals the PmtInfId TILL wrote
 * for an A18 `generated` batch (`compactReference('P', batch.id)`) proposes the BATCH. Amount equal to
 * the batch control sum: top confidence, one-click confirm routes through A18's settlement (never a
 * bespoke split). Amount NOT equal: shown for information, `blocked` so the one-click is disabled
 * (a partial execution goes to the manual split). Integer Rappen equality only, no rounding (P2).
 */
function batchJoin(ctx: WorkspaceContext, row: BankTxnRow): CamtMatchProposal | null {
  if (row.batch_pmt_inf_id === null || row.batch_pmt_inf_id.length === 0) return null;
  const batches = ctx.store.db
    .prepare("SELECT id, ctrl_sum_minor FROM payment_batch WHERE workspace_id = ? AND status = 'generated'")
    .all(ctx.workspaceId) as { id: string; ctrl_sum_minor: number | null }[];
  for (const b of batches) {
    if (compactReference('P', b.id) !== row.batch_pmt_inf_id) continue;
    const totalMatches = b.ctrl_sum_minor === row.amount_minor;
    return {
      kind: 'payment_batch',
      targetId: b.id,
      confidence: totalMatches ? 'high' : 'medium',
      reason: 'batch',
      signals: totalMatches ? ['batch'] : ['batch', 'batch_total_mismatch'],
      ...(totalMatches ? {} : { blocked: true }),
    };
  }
  return null;
}

/**
 * The ranked debit lane (spec §4, implementing what A20 §4 already promised). The exact amount +
 * currency gate stays MANDATORY: a candidate never appears on an amount mismatch, and that gate is
 * never widened (fuzzy amounts on the money path invite wrong bookings, §6b Fixed). Over the gated
 * set, ranking adds value-date proximity (window default +/- 5 days, workspace-configurable),
 * normalized counterparty-name token overlap, and reference hits (vendor_reference in the remittance
 * text, or EndToEndId equality). The reason is a composed list of matched SIGNALS the GUI renders and
 * the agent reads. Pure read; suggestion only, never a booking.
 */
function rankDebitCandidates(ctx: WorkspaceContext, row: BankTxnRow, config: CamtMatchConfig): CamtMatchProposal | null {
  // The batch join wins when it fires: it is the strongest possible signal (TILL wrote that PmtInfId).
  const batch = batchJoin(ctx, row);
  if (batch !== null) return batch;

  // THE MANDATORY GATE: exact amount + currency. openVendorBills already filtered to `row.currency`.
  const gated = openVendorBills(ctx, row.currency).filter((b) => b.openMinor === row.amount_minor);
  if (gated.length === 0) return null;

  const payerTokens = nameTokens(row.payer_name);
  const ref = (row.reference_value ?? '').toLowerCase();
  const entryRef = (row.entry_ref ?? '').toLowerCase();

  const scored = gated.map((bill) => {
    const signals: CamtMatchSignal[] = ['amount'];
    let score = 0;
    // Value date within the window (closest wins the tie-break below).
    const dist = dayDistance(row.value_date, bill.dueDate);
    const withinWindow = dist !== null && dist <= config.valueDateWindowDays;
    if (withinWindow) {
      signals.push('value_date');
      score += 3;
    }
    // Counterparty token overlap.
    const billTokens = nameTokens(contactName(ctx, bill.contactId));
    let overlap = 0;
    for (const tok of payerTokens) if (billTokens.has(tok)) overlap += 1;
    if (overlap > 0) {
      signals.push('counterparty');
      score += 2 + overlap;
    }
    // Reference: the supplier's invoice number quoted in the remittance / EndToEndId.
    const vref = (bill.vendorReference ?? '').toLowerCase();
    if (vref.length >= 3 && (ref.includes(vref) || entryRef.includes(vref))) {
      signals.push('reference');
      score += 4;
    }
    return { bill, signals, score, dist: dist ?? Number.MAX_SAFE_INTEGER };
  });

  // Deterministic order: highest score, then closest value date, then bill id (equal scores tie
  // visibly and never auto-pick, spec US-A36.5).
  scored.sort((a, b) => b.score - a.score || a.dist - b.dist || a.bill.id.localeCompare(b.bill.id));
  const best = scored[0]!;

  // A uniquely top-scoring gated candidate is `high` (the single-exact-amount case, or one bill that
  // the value date / counterparty / reference singles out); an ambiguous set where the top score ties
  // is `medium`, so a human picks and the tie is visible (spec US-A36.5, never auto-picked).
  const uniquelyBest = scored.length === 1 || best.score > (scored[1]?.score ?? -1);
  const confidence: QrMatchConfidence = uniquelyBest ? 'high' : 'medium';
  const primary = best.signals.includes('reference')
    ? 'reference_match'
    : best.signals.includes('counterparty')
      ? 'counterparty_match'
      : 'exact_open';
  return { kind: 'vendor_bill', targetId: best.bill.id, confidence, reason: primary, signals: best.signals };
}

export function suggestCamtMatches(
  ctx: WorkspaceContext,
  input: SuggestCamtMatchesInput,
): Result<{ txns: CamtTxnProposal[] }> {
  const guard = requireString(input.statementId, 'statementId');
  if (guard) return guard;

  const stmt = readStatementRow(ctx, input.statementId as string);
  if (stmt === undefined) return err('not_found', { statementId: input.statementId });

  const rows = ctx.store.db
    .prepare('SELECT * FROM bank_txn WHERE workspace_id = ? AND statement_id = ? ORDER BY rowid')
    .all(ctx.workspaceId, stmt.id) as BankTxnRow[];

  const config = readCamtMatchConfig(ctx);

  const txns: CamtTxnProposal[] = rows.map((row) => {
    if (row.classification === 'incoming_credit') {
      const scored = matchIncomingByQrr(ctx, {
        reference: row.reference_value,
        amountMinor: row.amount_minor,
        currency: row.currency,
        ...(row.value_date !== null ? { valueDate: row.value_date } : {}),
      });
      const proposal: CamtMatchProposal | null =
        scored.ok && scored.match.invoiceId !== null
          ? {
              kind: 'invoice' as const,
              targetId: scored.match.invoiceId,
              confidence: scored.match.confidence,
              reason: scored.match.reason ?? 'no_reference',
            }
          : null;
      // Credits are decided in A21's own queue; a routed credit is not a bank_txn.needs_review case
      // (A21 owns its `qr_match.needs_review`), so a credit never reports needsReview here.
      return { bankTxnId: row.id, classification: row.classification, proposal, needsReview: false };
    }
    const proposal = rankDebitCandidates(ctx, row, config);
    return {
      bankTxnId: row.id,
      classification: row.classification,
      proposal,
      needsReview: needsReviewFor(proposal, config.reviewThreshold, row.reversal_ind === 1),
    };
  });

  return ok({ txns });
}

// --- reviewBankTxn (A36), the per-txn bank_txn.needs_review emitter ---------------------------------

export interface ReviewBankTxnInput {
  bankTxnId?: string;
  idempotencyKey?: string;
}
export type ReviewBankTxnOk = {
  bankTxnId: string;
  needsReview: boolean;
  /**
   * The txn id when it needs review, else null. The G01 registry keys `bank_txn.needs_review` on
   * `result.needsReviewTxnId`, so a txn with a good proposal null-collapses and emits no occurrence
   * (the `qr_match.needs_review` / `dunning.proposed` idiom). ONE entity per firing, which is the
   * shape G01's dispatch requires and the reason this event could never ride `import_camt` (A20 §0):
   * a caller runs the suggestion pass and calls this verb per booked debit, so N unmatched txns fire N
   * occurrences instead of collapsing onto one `event_ref`.
   */
  needsReviewTxnId: string | null;
};

/**
 * A36 US-A36.5: signal that ONE booked debit needs a human's review because the ranked suggestion
 * found no candidate at or above the workspace threshold. WRITES NO LEDGER ROW and books nothing (the
 * only thing it persists is its own idempotency memo): it is a pure signal whose success emits
 * `bank_txn.needs_review` for a G01 rule to react to ("when a bank txn needs review, create an E03
 * task"). Idempotent per (bankTxnId, idempotencyKey). A CREDIT-classified txn refuses with
 * `use_qr_queue`: the credit review moment is A21's own `qr_match.needs_review`, not this. §H-TENANT
 * via `readTxnRow` (a foreign-workspace id is `not_found` before any work).
 */
export function reviewBankTxn(ctx: WorkspaceContext, input: ReviewBankTxnInput): Result<ReviewBankTxnOk> {
  const capable = ctx.capabilities.assert('pay');
  if (!capable.ok) return capable;
  const guard = requireString(input.bankTxnId, 'bankTxnId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const scopedKey = JSON.stringify(['review_bank_txn', input.bankTxnId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result<ReviewBankTxnOk>>(ctx.workspaceId, scopedKey, 'review_bank_txn');
  if (replayed !== undefined) return replayed;

  const row = readTxnRow(ctx, input.bankTxnId as string);
  if (row === undefined) return err('not_found', { bankTxnId: input.bankTxnId });
  if (row.classification === 'incoming_credit') {
    return err('use_qr_queue', {
      bankTxnId: row.id,
      creditId: row.credit_id,
      reason: 'the review moment for a credit is A21\'s qr_match.needs_review, not bank_txn.needs_review',
    });
  }

  const config = readCamtMatchConfig(ctx);
  const proposal = rankDebitCandidates(ctx, row, config);
  const needs = needsReviewFor(proposal, config.reviewThreshold, row.reversal_ind === 1);
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'review_bank_txn', () =>
    ok<ReviewBankTxnOk>({ bankTxnId: row.id, needsReview: needs, needsReviewTxnId: needs ? row.id : null }),
  );
}

// --- setCamtMatching (A36 §6b), the workspace debit-matching tuning ----------------------------------

export interface SetCamtMatchingInput {
  valueDateWindowDays?: number;
  reviewThreshold?: string;
  idempotencyKey?: string;
}

/**
 * A36 §6b: tune the debit-matching ranking (`valueDateWindowDays`, default 5) and the review-event
 * floor (`reviewThreshold` in {any, medium, high}, default any). These tune RANKING and review
 * emission only: they never touch the mandatory exact amount + currency gate (§6b Fixed). One row per
 * workspace, upserted; idempotent. `manage_settings` (a settings write, not a money move: it arms no
 * unattended settlement, so unlike `set_qr_auto_apply` it does not additionally require `pay`).
 */
export function setCamtMatching(ctx: WorkspaceContext, input: SetCamtMatchingInput): Result {
  const capable = ctx.capabilities.assert('manage_settings');
  if (!capable.ok) return capable;
  const guard = requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  if (
    input.valueDateWindowDays !== undefined &&
    (!Number.isInteger(input.valueDateWindowDays) || input.valueDateWindowDays < 0 || input.valueDateWindowDays > 60)
  ) {
    return err('invalid_input', { field: 'valueDateWindowDays', reason: 'an integer between 0 and 60 days' });
  }
  if (input.reviewThreshold !== undefined && !['any', 'medium', 'high'].includes(input.reviewThreshold)) {
    return err('invalid_input', { field: 'reviewThreshold', allowed: ['any', 'medium', 'high'] });
  }

  const scopedKey = JSON.stringify(['set_camt_matching', input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'set_camt_matching');
  if (replayed !== undefined) return replayed;

  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'set_camt_matching', () => {
    const cur = readCamtMatchConfig(ctx);
    const window = input.valueDateWindowDays ?? cur.valueDateWindowDays;
    const threshold = (input.reviewThreshold ?? cur.reviewThreshold) as CamtMatchConfig['reviewThreshold'];
    ctx.store.db
      .prepare(
        `INSERT INTO camt_match_config (workspace_id, value_date_window_days, review_threshold)
         VALUES (?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET value_date_window_days = excluded.value_date_window_days,
                                                 review_threshold = excluded.review_threshold`,
      )
      .run(ctx.workspaceId, window, threshold);
    return ok({ valueDateWindowDays: window, reviewThreshold: threshold });
  });
}

// --- confirmCamtMatch (US-A20.3), the debit settlement / journal-link decision -----------------------

export interface ConfirmCamtMatchAllocation {
  vendorBillId?: string;
  targetId?: string;
  amountMinor?: number;
}

export interface ConfirmCamtMatchInput {
  bankTxnId?: string;
  vendorBillId?: string;
  allocations?: ConfirmCamtMatchAllocation[];
  entryId?: string;
  idempotencyKey?: string;
}

export type ConfirmCamtMatchOk = {
  bankTxnId: string;
  // `payment_batch` surfaces only on the idempotent early-return path, when the debit is ALREADY
  // settled as an A18 batch (F2): confirm_match then books nothing and just echoes the existing link.
  kind: 'payment' | 'journal_entry' | 'payment_batch';
  targetId: string;
}

/**
 * `confirmCamtMatch` covers exactly what A21 does not (spec §0 note 2): an outgoing DEBIT settling
 * one or more vendor bills through A14 `recordPayment` (`vendorBillId`, or `allocations[]` for
 * US-A20.5's multi-bill split), or an annotation LINK to an existing journal entry that already books
 * the movement (`entryId`). A CREDIT-classified txn refuses with `use_qr_queue`, naming the A21 row
 * that decides it.
 */
export function confirmCamtMatch(ctx: WorkspaceContext, input: ConfirmCamtMatchInput): Result<ConfirmCamtMatchOk> {
  const capable = ctx.capabilities.assert('pay');
  if (!capable.ok) return capable;
  const capablePost = ctx.capabilities.assert('post');
  if (!capablePost.ok) return capablePost;

  const guard =
    requireString(input.bankTxnId, 'bankTxnId') ??
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    optionalId(input.vendorBillId, 'vendorBillId') ??
    optionalId(input.entryId, 'entryId');
  if (guard) return guard;

  const wantsSettlement = input.vendorBillId !== undefined || input.allocations !== undefined;
  const wantsLink = input.entryId !== undefined;
  if (wantsSettlement === wantsLink) {
    return err('invalid_input', {
      field: 'entryId',
      reason: 'name exactly one: vendorBillId or allocations (a settlement), or entryId (a journal link)',
    });
  }
  if (input.vendorBillId !== undefined && input.allocations !== undefined) {
    return err('invalid_input', { field: 'allocations', reason: 'name vendorBillId or allocations, not both' });
  }

  const scopedKey = JSON.stringify(['confirm_match', input.bankTxnId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result<ConfirmCamtMatchOk>>(ctx.workspaceId, scopedKey, 'confirm_match');
  if (replayed !== undefined) return replayed;

  const row = readTxnRow(ctx, input.bankTxnId as string);
  if (row === undefined) return err('not_found', { bankTxnId: input.bankTxnId });
  if (row.classification === 'incoming_credit') {
    return err('use_qr_queue', {
      bankTxnId: row.id,
      creditId: row.credit_id,
      reason: 'this credit is decided in the A21 Abgleich queue (apply_qr_match / override_qr_match), not here',
    });
  }
  // A20-C3: a reversal-flagged entry is `unclassified` regardless of direction, so a returned
  // outgoing payment (RvslInd=true, CdtDbtInd=CRDT: money arriving) reaches this far. A settlement
  // (vendorBillId/allocations) always books an OUTGOING payment (below); a CRDT bank fact settled
  // that way would move the ledger the OPPOSITE way from what the bank actually did. The manual
  // `entryId` LINK stays open to both directions: it only annotates an entry a human already posted,
  // it never decides a direction of its own.
  if (wantsSettlement && row.credit_debit !== 'DBIT') {
    return err('wrong_direction', {
      bankTxnId: row.id,
      creditDebit: row.credit_debit,
      reason:
        'a CRDT bank fact (money arriving) is not settled as an outgoing payment; correct a returned payment via reverse_payment, or use entryId to annotate an existing entry',
    });
  }
  const existingLink = readLink(ctx, row.id);
  if (existingLink !== undefined) {
    return ok<ConfirmCamtMatchOk>({ bankTxnId: row.id, kind: existingLink.kind, targetId: existingLink.target_id });
  }

  const bankAccount = ctx.store.db
    .prepare('SELECT ledger_account_id FROM bank_account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, row.bank_account_id) as { ledger_account_id: string } | undefined;
  if (bankAccount === undefined) return err('needs_bank_account', { bankAccountId: row.bank_account_id });

  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'confirm_match', () => {
    const now = ctx.clock.now();
    let kind: 'payment' | 'journal_entry';
    let targetId: string;

    if (wantsSettlement) {
      const allocations: ConfirmCamtMatchAllocation[] =
        input.allocations ?? [{ vendorBillId: input.vendorBillId as string, amountMinor: row.amount_minor }];
      const paid = recordPayment(ctx, {
        direction: 'outgoing',
        date: row.value_date ?? row.booking_date ?? now.slice(0, 10),
        amountMinor: row.amount_minor,
        currency: row.currency,
        bankAccountId: bankAccount.ledger_account_id,
        allocations: allocations.map((a) => ({
          ...(a.vendorBillId !== undefined ? { vendorBillId: a.vendorBillId } : {}),
          ...(a.targetId !== undefined ? { targetId: a.targetId } : {}),
          amountMinor: (a.amountMinor ?? row.amount_minor) as number,
        })),
        source: 'camt',
        intent: PAYMENT_INTENTS.record,
        idempotencyKey: `camt-confirm-${row.id}`,
      });
      if (!paid.ok) return paid;
      kind = 'payment';
      targetId = paid['paymentId'] as string;
    } else {
      const entry = ctx.store.db
        .prepare('SELECT id FROM journal_entry WHERE workspace_id = ? AND id = ? AND status = ?')
        .get(ctx.workspaceId, input.entryId, 'posted') as { id: string } | undefined;
      if (entry === undefined) return err('not_found', { entryId: input.entryId });
      kind = 'journal_entry';
      targetId = entry.id;
    }

    ctx.store.db
      .prepare(
        `INSERT INTO bank_txn_link (id, workspace_id, bank_txn_id, kind, target_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ctx.ids.next('btlk'), ctx.workspaceId, row.id, kind, targetId, ctx.actor, now);
    ctx.audit.record({ entityKind: 'bank_txn', entityId: row.id, action: 'confirm', actor: ctx.actor, at: now });

    return ok<ConfirmCamtMatchOk>({ bankTxnId: row.id, kind, targetId });
  });
}

// --- createEntryForTxn (US-A20.4) --------------------------------------------------------------------

export interface CreateEntryForTxnInput {
  bankTxnId?: string;
  contraAccountId?: string;
  description?: string;
  taxCode?: string;
  idempotencyKey?: string;
}

export type CreateEntryForTxnOk = {
  bankTxnId: string;
  entryId: string;
}

/**
 * Book an unmatched txn (a bank fee, interest, a standing transfer) as a balanced two-leg entry via
 * A02, and link it. `taxCode` is declared in the input shape (spec §5) but refused rather than
 * guessed at (P9): modelling VAT on an arbitrary manual bank-fact entry (which of A06's directions it
 * takes, which account role it corrects) is not built yet, and a wrong filed figure is worse than an
 * honest refusal naming the reason.
 */
export function createEntryForTxn(ctx: WorkspaceContext, input: CreateEntryForTxnInput): Result<CreateEntryForTxnOk> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const guard =
    requireString(input.bankTxnId, 'bankTxnId') ??
    requireString(input.contraAccountId, 'contraAccountId') ??
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    optionalText(input.description, 'description') ??
    optionalId(input.taxCode, 'taxCode');
  if (guard) return guard;

  if (input.taxCode !== undefined) {
    return err('unsupported', {
      field: 'taxCode',
      reason: 'vat_on_manual_bank_entries_not_modelled',
      hint: 'book the net amount and add the VAT as a separate manual entry (post_entry), or via A17 if this is really a vendor bill',
    });
  }

  const scopedKey = JSON.stringify(['create_entry_for_txn', input.bankTxnId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result<CreateEntryForTxnOk>>(
    ctx.workspaceId,
    scopedKey,
    'create_entry_for_txn',
  );
  if (replayed !== undefined) return replayed;

  const row = readTxnRow(ctx, input.bankTxnId as string);
  if (row === undefined) return err('not_found', { bankTxnId: input.bankTxnId });
  if (row.classification === 'incoming_credit') {
    return err('use_qr_queue', {
      bankTxnId: row.id,
      creditId: row.credit_id,
      reason: 'this credit is decided in the A21 Abgleich queue, not here',
    });
  }
  const existingLink = readLink(ctx, row.id);
  if (existingLink !== undefined) {
    if (existingLink.kind === 'journal_entry') {
      return ok<CreateEntryForTxnOk>({ bankTxnId: row.id, entryId: existingLink.target_id });
    }
    return err('already_matched', { bankTxnId: row.id, kind: existingLink.kind, targetId: existingLink.target_id });
  }

  const base = baseCurrencyOf(ctx);
  if (row.currency !== base) {
    return err('currency_mismatch', {
      bankTxnId: row.id,
      txnCurrency: row.currency,
      baseCurrency: base,
      reason: 'a cross-currency bank fact is booked through post_entry or record_payment, stating the conversion',
    });
  }

  const bankAccount = ctx.store.db
    .prepare('SELECT ledger_account_id FROM bank_account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, row.bank_account_id) as { ledger_account_id: string } | undefined;
  if (bankAccount === undefined) return err('needs_bank_account', { bankAccountId: row.bank_account_id });

  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'create_entry_for_txn', () => {
    const now = ctx.clock.now();
    const lines: LineInput[] =
      row.credit_debit === 'CRDT'
        ? [
            { account: bankAccount.ledger_account_id, debit: row.amount_minor },
            { account: input.contraAccountId as string, credit: row.amount_minor },
          ]
        : [
            { account: input.contraAccountId as string, debit: row.amount_minor },
            { account: bankAccount.ledger_account_id, credit: row.amount_minor },
          ];

    // MINTED, never derived from the txn id alone: the same A11/A17 rule against a squattable key.
    const postingKey = `camt-entry-${row.id}-${ctx.ids.next('cek')}`;
    const posted = postEntry(ctx, {
      date: row.booking_date ?? row.value_date ?? now.slice(0, 10),
      source: 'camt',
      description: input.description ?? `Bankbuchung ${row.entry_ref ?? row.id}`,
      idempotencyKey: postingKey,
      lines,
    });
    if (!posted.ok) return posted;

    ctx.store.db
      .prepare(
        `INSERT INTO bank_txn_link (id, workspace_id, bank_txn_id, kind, target_id, created_by, created_at)
         VALUES (?, ?, ?, 'journal_entry', ?, ?, ?)`,
      )
      .run(ctx.ids.next('btlk'), ctx.workspaceId, row.id, posted.entryId, ctx.actor, now);
    ctx.audit.record({
      entityKind: 'bank_txn',
      entityId: row.id,
      action: 'book',
      actor: ctx.actor,
      at: now,
    });

    return ok<CreateEntryForTxnOk>({ bankTxnId: row.id, entryId: posted.entryId });
  });
}

// --- listReconciliation (US-A20.5), the board's read model (Pattern P5) ------------------------------

export interface ListReconciliationInput {
  statementId?: string;
  bankAccountId?: string;
  from?: string;
  to?: string;
  savedViewId?: string;
}

const RECONCILIATION_LIST_CEILING = 1000;

/** The ledger's net movement on `accountId` up to and including `asOf` (or strictly before it). */
function ledgerNetAsOf(ctx: WorkspaceContext, accountId: string, asOf: string, strictlyBefore: boolean): number {
  const sum = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND l.account_id = ? AND e.date ${strictlyBefore ? '<' : '<='} ?`,
    )
    .get(ctx.workspaceId, accountId, asOf) as { net: number };
  return sum.net;
}

/**
 * A D64-shaped as-of comparison (spec §0 note 8): the ledger balance of the account's A19
 * `ledger_account_id`, summed to the statement's `to_date`, against the CLBD figure, AND (A20-C5,
 * a strengthening: a closing-side agreement alone says the balances happen to agree today, both
 * ends together say the period's movements actually reconcile) the ledger balance strictly BEFORE
 * `from_date` against the OPBD figure, when the statement carried one. Both sides describe the same
 * Stichtag. A base-currency workspace with a foreign-currency Bankkonto, a message that never
 * carried a balance (camt.054), or a non-last PAGE of a multi-page statement (D81/A20-C9: an
 * interim position is never the statement's real closing balance) gets no indicator rather than a
 * converted guess or a premature one (P9): `null`, not `false`.
 */
function statementReconciled(ctx: WorkspaceContext, stmt: BankStatementRow): boolean | null {
  if (stmt.closing_balance_minor === null) return null;
  if (stmt.last_page_ind !== 1) return null;
  const base = baseCurrencyOf(ctx);
  if (stmt.balance_currency !== null && stmt.balance_currency !== base) return null;

  const account = ctx.store.db
    .prepare('SELECT ledger_account_id, currency FROM bank_account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, stmt.bank_account_id) as { ledger_account_id: string; currency: string } | undefined;
  if (account === undefined || account.currency !== base) return null;

  const asOfClose = stmt.to_date ?? stmt.imported_at.slice(0, 10);
  if (ledgerNetAsOf(ctx, account.ledger_account_id, asOfClose, false) !== stmt.closing_balance_minor) return false;

  if (stmt.opening_balance_minor !== null && stmt.from_date !== null) {
    if (ledgerNetAsOf(ctx, account.ledger_account_id, stmt.from_date, true) !== stmt.opening_balance_minor) {
      return false;
    }
  }
  return true;
}

export type ListReconciliationOk = {
  matched: CamtTxnView[];
  unmatched: CamtTxnView[];
  partial: CamtTxnView[];
  reconciled?: boolean;
}

export interface ListBankStatementsInput {
  bankAccountId?: string;
}

/** One imported statement, as the Studio's statement list and an agent's "what is open" read see it. */
export interface BankStatementSummary {
  /** The engine's own id (`bstmt_...`), the key `list_reconciliation` / `suggest_matches` take. */
  statementId: string;
  bankAccountId: string;
  messageType: string;
  /** The bank's `Stmt/Id` (or `Ntfctn/Id`), for the human who holds the paper. */
  bankStatementId: string;
  pageNumber: number;
  fromDate: string | null;
  toDate: string | null;
  closingBalanceMinor: number | null;
  balanceCurrency: string | null;
  txnCount: number;
  /** Lines not yet matched (unmatched + partial), the number a person still has to decide. */
  openCount: number;
  /** The D64 as-of indicator, exactly as `list_reconciliation` reports it; null when it cannot be judged. */
  reconciled: boolean | null;
  importedAt: string;
}

export type ListBankStatementsOk = { statements: BankStatementSummary[] };

/**
 * The imported statements of a workspace, newest period first, each with its open-line count
 * (F-03, J3.3: "an imported statement has no door"). Measured 2026-09-05: the Studio's camt board
 * rendered only from `?statement=<id>`, which only an import in the same session set, so twenty
 * open lines on the golden ledger were unreachable from the rail. A pure read over `bank_statement`
 * and `bank_txn`, §H-TENANT scoped; writes nothing.
 */
export function listBankStatements(
  ctx: WorkspaceContext,
  input: ListBankStatementsInput = {},
): Result<ListBankStatementsOk> {
  const guard = optionalId(input.bankAccountId, 'bankAccountId');
  if (guard) return guard;
  const clauses = ['workspace_id = ?'];
  const params: string[] = [ctx.workspaceId];
  if (input.bankAccountId !== undefined) {
    clauses.push('bank_account_id = ?');
    params.push(input.bankAccountId);
  }
  const stmts = ctx.store.db
    .prepare(
      `SELECT * FROM bank_statement WHERE ${clauses.join(' AND ')}
        ORDER BY COALESCE(to_date, '') DESC, imported_at DESC, rowid DESC`,
    )
    .all(...params) as BankStatementRow[];
  const txnRows = ctx.store.db.prepare(
    'SELECT * FROM bank_txn WHERE workspace_id = ? AND statement_id = ? ORDER BY value_date, rowid',
  );
  const statements = stmts.map((s): BankStatementSummary => {
    const rows = txnRows.all(ctx.workspaceId, s.id) as BankTxnRow[];
    const openCount = rows.filter((r) => toTxnView(ctx, r).status !== 'matched').length;
    return {
      statementId: s.id,
      bankAccountId: s.bank_account_id,
      messageType: s.message_type,
      bankStatementId: s.statement_id,
      pageNumber: s.page_number,
      fromDate: s.from_date,
      toDate: s.to_date,
      closingBalanceMinor: s.closing_balance_minor,
      balanceCurrency: s.balance_currency,
      txnCount: s.txn_count,
      openCount,
      reconciled: statementReconciled(ctx, s),
      importedAt: s.imported_at,
    };
  });
  return ok<ListBankStatementsOk>({ statements });
}

export function listReconciliation(
  ctx: WorkspaceContext,
  input: ListReconciliationInput = {},
): Result<ListReconciliationOk> {
  const guard =
    optionalId(input.statementId, 'statementId') ??
    optionalId(input.bankAccountId, 'bankAccountId') ??
    optionalDate(input.from, 'from') ??
    optionalDate(input.to, 'to') ??
    optionalId(input.savedViewId, 'savedViewId');
  if (guard) return guard;

  const viewed = applySavedView(ctx, 'bank_txn', input);
  if (!viewed.ok) return viewed;
  const filter = viewed.filter;

  let rows: BankTxnRow[];
  let statement: BankStatementRow | undefined;
  if (filter.statementId !== undefined) {
    statement = readStatementRow(ctx, filter.statementId);
    if (statement === undefined) return err('not_found', { statementId: filter.statementId });
    rows = ctx.store.db
      .prepare('SELECT * FROM bank_txn WHERE workspace_id = ? AND statement_id = ? ORDER BY value_date, rowid')
      .all(ctx.workspaceId, statement.id) as BankTxnRow[];
  } else {
    const clauses = ['workspace_id = ?'];
    const params: string[] = [ctx.workspaceId];
    if (filter.bankAccountId !== undefined) {
      clauses.push('bank_account_id = ?');
      params.push(filter.bankAccountId);
    }
    if (filter.from !== undefined) {
      clauses.push('value_date >= ?');
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      clauses.push('value_date <= ?');
      params.push(filter.to);
    }
    rows = ctx.store.db
      .prepare(
        `SELECT * FROM bank_txn WHERE ${clauses.join(' AND ')}
          ORDER BY value_date DESC, rowid DESC LIMIT ${RECONCILIATION_LIST_CEILING}`,
      )
      .all(...params) as BankTxnRow[];
  }

  const items = rows.map((r) => toTxnView(ctx, r));
  const result: ListReconciliationOk = {
    matched: items.filter((i) => i.status === 'matched'),
    unmatched: items.filter((i) => i.status === 'unmatched'),
    partial: items.filter((i) => i.status === 'partial'),
  };
  if (statement !== undefined) {
    const reconciled = statementReconciled(ctx, statement);
    if (reconciled !== null) result.reconciled = reconciled;
  }
  return ok<ListReconciliationOk>(result);
}
