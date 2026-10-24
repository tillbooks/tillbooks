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
import type { Err, Result } from '../result.js';
import { requireString, optionalId, optionalText, optionalDate } from '../ledger/inputGuards.js';
import { recordPayment, PAYMENT_INTENTS } from '../payments/payment.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { normalizeIban } from '../setup/iban.js';
import { applySavedView } from '../customization/views.js';
import { recordIncomingCredit, matchIncomingByQrr } from './qrMatch.js';
import { parseCamt, hashCamtStatement } from './camt.js';
import { decideSuccessor, isEbicsFedAccount, readFeedBook } from './ebics/feed.js';
import type { FeedPosition, FeedSkippedRange, FeedStatementRef } from './ebics/feed.js';
import type { CamtClassification, CamtCreditDebit, ParsedBankStatement, ParsedCamtEntry, CamtSkipReason } from './camt.js';
import { writeLineFacts } from './statementFacts.js';
import {
  MAX_CANDIDATES,
  NEAR_DAYS,
  REASON_RANK,
  crossFormatModeOf,
  decideLines,
  duplicateDecisionPending,
  formatFamilyOf,
  incomingOf,
  readStoredLines,
  storedWindowOf,
  writePossibleDuplicates,
} from './statementDedupe.js';
import { coverageOf, lineDayOf, movementKeyOf, periodOf, storedMovements } from './statementCoverage.js';
import type { PossibleDuplicate } from './statementDedupe.js';
import type { LineDecision, PossibleDuplicateReason } from './statementDedupe.js';
import { readCamtMatchConfig, rankDebitCandidates, needsReviewFor, CONFIDENCE_RANK } from './debitRanking.js';
import type { CamtMatchConfig, CamtMatchProposal } from './debitRanking.js';
import {
  LINE_STATE_EXPR,
  LINE_STATE_JOINS,
  bankLegsOf,
  lineGeneration,
  lineStateOf,
  lineBookingDate,
  readBankTxn,
  readBankTxnDetail,
  writeLineLink,
} from './bankLines.js';
import type { BankLineState, BankTxnRow, BookBankLineTarget } from './bankLines.js';
import { performBooking, BankAbort, runBankGuarded } from './bankBooking.js';
import { liveBatchOfBill } from './pain001.js';
import type { BookBankLineOk } from './bankBooking.js';
import { proposalContext, proposeForLine } from './bankProposals.js';
import type { BankProposalCertainty, ProposalContext } from './bankProposals.js';

// A36's ranking moved to `debitRanking.ts` (A39, to break the cycle with the proposal engine); its
// names stay importable from here, where every caller has always found them.
export { readCamtMatchConfig };
export type { CamtMatchConfig, CamtMatchProposal };
export type { CamtMatchSignal } from './debitRanking.js';

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

// --- View shapes, the one both faces read (Pattern P5) ---------------------------------------------

/**
 * A20's three-lane vocabulary, kept for the board it was built for. It is NOT the line's state: A39's
 * `lineState` is (`open`, `booked`, `matched`, `ignored`, spec A39 §4.2). The mapping: `open` is
 * `unmatched`; `booked`/`matched` are `matched`, or `partial` when the settlement left part of the
 * open item open; an `ignored` line appears only in `ignored` (never in `unmatched`, owner answer 1),
 * with the lane word `matched` because it is decided.
 */
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
  /** Present only once linked (a settlement, a batch settlement, or an entry). Null for an ignored line. */
  linkKind: 'payment' | 'journal_entry' | 'payment_batch' | null;
  linkTargetId: string | null;
  /** A39: the line's one state (spec A39 §4.2). */
  lineState?: BankLineState;
  /** A39: why an ignored line was ignored. */
  ignoreReason?: string | null;
}

function readStatementRow(ctx: WorkspaceContext, id: string): BankStatementRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM bank_statement WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as BankStatementRow | undefined;
}

function readTxnRow(ctx: WorkspaceContext, id: string): BankTxnRow | undefined {
  return readBankTxn(ctx, id);
}

function toTxnView(ctx: WorkspaceContext, row: BankTxnRow): CamtTxnView {
  const line = lineStateOf(ctx, row);
  const link = line.link;
  let status: CamtTxnStatus = 'unmatched';
  if (line.state !== 'open') {
    const partial =
      line.state === 'booked' &&
      ((link !== null && link.remainderMode === 'leave_open' && (link.remainderMinor ?? 0) > 0) ||
        (link === null && line.creditStatus === 'applied' &&
          (ctx.store.db
            .prepare('SELECT applied_mode FROM reconciliation_match WHERE workspace_id = ? AND id = ?')
            .get(ctx.workspaceId, row.credit_id) as { applied_mode: string | null } | undefined)?.applied_mode === 'partial'));
    status = partial ? 'partial' : 'matched';
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
    creditId: row.credit_id,
    linkKind: link !== null && link.kind !== 'ignored' ? link.kind : null,
    // The decision's own declared reference (a G04 restore remaps it; a link's `target_id` it does not).
    linkTargetId: link !== null && link.kind !== 'ignored' ? link.targetId : null,
    lineState: line.state,
    ignoreReason: line.state === 'ignored' ? (link?.ignoreReason ?? 'other') : null,
  };
}

// --- importCamt (US-A20.1) -------------------------------------------------------------------------

export interface ImportCamtInput {
  bankAccountId?: string;
  xml?: string;
  idempotencyKey?: string;
  /** D81's escape: admits a line whose BANK reference (camt AcctSvcrRef, MT940 `//`) is already on the
   *  books, as a genuine second booking. Since the D178 point 19 re-cut only a bank reference drops a
   *  line at all, and this escape never silences a coverage flag: an overlapping line is still imported
   *  flagged and waits for the person's answer. Off by default. */
  allowDuplicateEntries?: boolean;
}

export type ImportSkippedEntry = {
  entryRef: string | null;
  reason: CamtSkipReason;
  status?: string | null;
  /** D178 (A20 §11.4): for `cross_format_duplicate`, the line already on the books this one IS. */
  existingBankTxnId?: string;
  /** D178: a CSV row's number in the file, for the row reasons. */
  row?: number;
};

/**
 * D178 point 19 (A20 §11.4): a NEW line that may be a stored line (`statementDedupe.ts`). It is imported,
 * flagged on the line itself (`possibleDuplicates` and `needsDuplicateDecision` on `list_bank_inbox`) and
 * named here, so the person decides: never a silent drop, never a silent double count. `existingBankTxnId`
 * is the nearest candidate, `candidates` every one; `sameFormat` is true for a CSV line resembling a stored
 * CSV line.
 */
export type NearCrossFormatDuplicate = {
  bankTxnId: string;
  /** The first line it names, or null for `covered_period_new_line` with nothing to name. */
  existingBankTxnId: string | null;
  reason: PossibleDuplicateReason;
  sameFormat: boolean;
  candidates: string[];
};

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
  /**
   * A39 L7 (c): stable codes a surface renders. `not_day_end_statement`: a camt.053 without
   * `ElctrncSeqNb` or without a closing balance (CLBD), an ad-hoc export the EBICS feed (A36) cannot
   * chain to; import that day's day-end statement too. Always present, possibly empty.
   * A36 adds `statement_number_jump` on an EBICS-fed account: the statement chained by its balances but
   * skipped numbers (named in `feed.jump`), which the owner imports by hand if they exist.
   */
  warnings: string[];
  /**
   * A36 §4.4: present only on an EBICS-fed account, where the successor rule decided the import:
   * which rule admitted it (`feed_start`, `successor`, `hole_filler`, or `already_imported` for a copy
   * of a statement already there), its position, and the skipped numbers of a jump.
   */
  feed?: {
    rule: 'feed_start' | 'successor' | 'hole_filler' | 'already_imported';
    position: FeedPosition;
    jump?: { after: FeedStatementRef; skipped: FeedSkippedRange[] };
  };
  /** D178 (A20 §11.4): present only when a new line resembles another format's line (with the warning
   *  `possible_cross_format_duplicate`). */
  nearDuplicates?: NearCrossFormatDuplicate[];
}

/**
 * A36 §4.4: the successor rule's answer leaves `importCamt`'s write transaction by THROW, so a refusal
 * (or an `already_imported` no-op) rolls the transaction back and is never memoised under the caller's
 * idempotency key: a re-run of the same file under the same key decides afresh (spec §4.3 step 4).
 */
class FeedAnswer extends Error {
  constructor(readonly result: Result<ImportCamtOk>) {
    super('feed-answer');
  }
}

/**
 * A stable diff between an existing `bank_statement`'s stored content and a freshly re-parsed one
 * under the SAME identity key: named for A20-C2's `statement_amended` answer, so the operator sees
 * what changed rather than a silent `duplicate: true` that discards the correction.
 */
function diffAmendedStatement(
  ctx: WorkspaceContext,
  existing: BankStatementRow,
  fresh: ParsedBankStatement,
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
    .prepare('SELECT id, iban, currency, archived, name FROM bank_account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.bankAccountId) as { id: string; iban: string; currency: string; archived: number; name: string } | undefined;
  if (account === undefined) return err('needs_bank_account', { bankAccountId: input.bankAccountId });
  // A39 D-A39.9 (frame §4 item 10 (d)): an archived Bankkonto takes no new statement, as A18 already
  // refuses it a payment run. Unarchive it first; its history stays readable either way.
  if (account.archived === 1) return err('bank_account_archived', { bankAccountId: account.id, name: account.name });

  const parsed = parseCamt(input.xml);
  if (!parsed.ok) return parsed;
  const stmt = parsed.statement;
  // A39 L7 (c), D140: a camt.054 is a detail notification, not a statement. It is refused HERE, in the one
  // door every channel uses (the Studio, MCP, the EBICS and managed channels, a G19 step), before any row
  // is written; `parseCamt` still reads it. The per-detail mode is parked (spec §10).
  if (stmt.messageType === 'camt054') {
    return err('camt054_refused', {
      bankAccountId: account.id,
      statementId: stmt.statementId,
      reason: 'a camt.054 is a detail notification, not a statement: import the day-end camt.053',
    });
  }
  const warnings = stmt.messageType === 'camt053' && (stmt.electronicSeqNb === null || stmt.closingBalanceMinor === null) ? ['not_day_end_statement'] : [];

  if (stmt.iban !== null && normalizeIban(stmt.iban) !== normalizeIban(account.iban)) {
    // A39 D-A39.9 (walk B2.2): name BOTH IBANs, and the account the file really belongs to when it is
    // registered; an IBAN registered nowhere is not a mismatch between two accounts but a missing one,
    // so it answers `needs_bank_account` with the file's IBAN, the A19 action.
    const owner = ctx.store.db
      .prepare('SELECT id, name, archived FROM bank_account WHERE workspace_id = ? AND iban = ?')
      .get(ctx.workspaceId, normalizeIban(stmt.iban)) as { id: string; name: string; archived: number } | undefined;
    if (owner === undefined) {
      return err('needs_bank_account', { fileIban: normalizeIban(stmt.iban), bankAccountId: account.id, accountIban: account.iban });
    }
    return err('iban_mismatch', {
      fileIban: normalizeIban(stmt.iban),
      accountIban: account.iban,
      matchingBankAccountId: owner.id,
      matchingBankAccountName: owner.name,
    });
  }

  const contentHash = hashCamtStatement(stmt);

  // A36 §4.4: on an EBICS-fed account the successor rule decides INSIDE the write transaction, before
  // any row and before A20's own statement dedupe, whichever door the file came through. A refusal or
  // an `already_imported` no-op THROWS out of it (`FeedAnswer`), so nothing is memoised under the key.
  if (isEbicsFedAccount(ctx, account.id)) {
    try {
      return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'import_camt', () => {
        const decision = decideSuccessor(stmt, readFeedBook(ctx, account.id));
        if (decision.verdict === 'refused') {
          throw new FeedAnswer(err(decision.code, { bankAccountId: account.id, statementId: stmt.statementId, ...decision.details }));
        }
        if (decision.verdict === 'already_imported') {
          throw new FeedAnswer(
            ok<ImportCamtOk>({
              statementId: decision.statementRowId,
              txnCount: decision.txnCount,
              duplicate: true,
              skipped: [],
              warnings: [],
              feed: { rule: 'already_imported', position: decision.position },
            }),
          );
        }
        const duplicate = existingStatementAnswer(ctx, account.id, stmt, contentHash);
        if (duplicate !== null) throw new FeedAnswer(duplicate);
        const feed: NonNullable<ImportCamtOk['feed']> = {
          rule: decision.rule,
          position: decision.position,
          ...(decision.jump !== undefined ? { jump: decision.jump } : {}),
        };
        const feedWarnings = decision.jump !== undefined ? [...warnings, 'statement_number_jump'] : warnings;
        const inserted = insertStatement(ctx, account, stmt, contentHash, allowDuplicateEntries, feedWarnings);
        return ok<ImportCamtOk>({ ...inserted, feed });
      });
    } catch (e) {
      if (e instanceof FeedAnswer) return e.result;
      throw e;
    }
  }

  const answered = existingStatementAnswer(ctx, account.id, stmt, contentHash);
  if (answered !== null) return answered;

  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'import_camt', () =>
    ok<ImportCamtOk>(insertStatement(ctx, account, stmt, contentHash, allowDuplicateEntries, warnings)),
  );
}

/**
 * A20's statement-level dedupe: the same identity key with the same content is `duplicate: true`
 * (writes nothing), with other content `statement_amended` (A20-C2). Null when the identity is new.
 */
export function existingStatementAnswer(
  ctx: WorkspaceContext,
  bankAccountId: string,
  stmt: ParsedBankStatement,
  contentHash: string,
): Result<ImportCamtOk> | null {
  // D81/A20-C9: pagination is part of the statement's identity. Two pages of ONE multi-page statement
  // share Stmt/Id and ElctrncSeqNb by design (SPS 2.3 p.54); without the page number in the key, page
  // 2 collides with page 1 and is thrown away as a duplicate.
  const existing = ctx.store.db
    .prepare(
      `SELECT * FROM bank_statement
        WHERE workspace_id = ? AND bank_account_id = ? AND statement_id = ?
          AND COALESCE(electronic_seq_nb, '') = COALESCE(?, '') AND page_number = ?`,
    )
    .get(ctx.workspaceId, bankAccountId, stmt.statementId, stmt.electronicSeqNb, stmt.pageNumber) as
    | BankStatementRow
    | undefined;
  if (existing !== undefined) {
    if (existing.content_hash === contentHash) {
      return ok<ImportCamtOk>({ statementId: existing.id, txnCount: existing.txn_count, duplicate: true, skipped: [], warnings: [] });
    }
    // A20-C2: the bank re-issued this exact statement identity with different content. The stale
    // figure is left standing (a silent overwrite would be worse) and the operator is told what
    // changed, naming the differing entries and balances rather than "already have this".
    return err('statement_amended', { statementId: existing.id, changes: diffAmendedStatement(ctx, existing, stmt) });
  }

  return null;
}

// --- D178 (A20 §11.4): the same bank movement only once, across formats (statementDedupe.ts) ---------

export { formatFamilyOf };

/** The window a resemblance is named in (kept under its first name; `statementDedupe.NEAR_DAYS`). */
export const CROSS_FORMAT_NEAR_DAYS = NEAR_DAYS;

/**
 * Write one statement and its lines (the body `importCamt` memoises under its key; D178: the same body
 * for MT940 and CSV, `statementImport.ts`). D178 point 19, re-cut (A20 §11.4):
 *  1. A line whose BANK reference key (camt AcctSvcrRef `asr:`, MT940 `//` `m9:`) is already in the books
 *     is dropped `duplicate_entry`. No other key drops a line: a `nr:`, `ck:`, `m9c:` or `csv:` key is a
 *     storage label, suffixed when taken.
 *  2. Coverage decides (statementCoverage.ts): an EXTENDING delivery's lines are new; an overlapping one's
 *     lines on a covered day are matched one to one on their movement and flagged (`same_movement`, or
 *     `covered_period_new_line` when nothing matches on a fully covered day).
 *  3. Point 19's cross-format candidates flag any line on top (`statementDedupe.ts`); under
 *     `bank.cross_format_duplicates` = `auto_strong` a shared bank reference on the same booking date drops it.
 * A flagged line waits for the person: never sure, and no decision but an ignore can be written for it
 * (the chokepoint in writeLineLink and the trigger on `bank_line_decision`).
 */
export function insertStatement(
  ctx: WorkspaceContext,
  account: { id: string },
  stmt: ParsedBankStatement,
  contentHash: string,
  allowDuplicateEntries: boolean,
  warnings: string[],
): {
  statementId: string;
  txnCount: number;
  duplicate: false;
  skipped: ImportSkippedEntry[];
  warnings: string[];
  nearDuplicates?: NearCrossFormatDuplicate[];
} {
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

  // Every stored key of the account, with its line: a BANK reference key already there drops the line
  // (A20 §11.4); any other key is only a storage label and is suffixed when taken.
  const existingKeys = new Map<string, string>(
    (
      ctx.store.db
        .prepare('SELECT entry_key, id FROM bank_txn WHERE workspace_id = ? AND bank_account_id = ?')
        .all(ctx.workspaceId, account.id) as { entry_key: string; id: string }[]
    ).map((r) => [r.entry_key, r.id]),
  );
  const isBankRefKey = (k: string): boolean => k.startsWith('asr:') || k.startsWith('m9:');

  const skipped: ImportSkippedEntry[] = stmt.skipped.map((s) => ({
    entryRef: s.entryRef,
    reason: s.reason,
    ...(s.status !== undefined ? { status: s.status } : {}),
    ...(s.row !== undefined ? { row: s.row } : {}),
  }));
  let insertedCount = 0;

  // Pass 0: the lines a bank reference key already holds (in the books, or earlier in this file).
  const exactRepeat = new Set<number>();
  const exactClaimed = new Set<string>();
  {
    const seen = new Set<string>();
    stmt.entries.forEach((e, i) => {
      if (!isBankRefKey(e.entryKey)) return;
      const storedId = existingKeys.get(e.entryKey);
      if (storedId !== undefined) exactClaimed.add(storedId);
      if (storedId !== undefined || seen.has(e.entryKey)) exactRepeat.add(i);
      seen.add(e.entryKey);
    });
  }
  const family = formatFamilyOf(stmt.messageType);
  const kept = (index: number): boolean => !exactRepeat.has(index) || allowDuplicateEntries;

  // Coverage first (statementCoverage.ts): does this delivery extend the chain, or which of its lines
  // fall on days the books already hold a statement for?
  const period = periodOf(stmt);
  const lineDays = stmt.entries.map((e) => lineDayOf(e, period));
  const covDays = lineDays.filter((d, i): d is string => d !== null && kept(i)).sort();
  const coverage = coverageOf(
    ctx,
    account.id,
    stmt,
    statementRowId,
    covDays.length === 0 ? null : { from: covDays[0] as string, to: covDays[covDays.length - 1] as string },
  );
  ctx.store.db.prepare('UPDATE bank_statement SET coverage = ? WHERE workspace_id = ? AND id = ?').run(coverage.coverage, ctx.workspaceId, statementRowId);

  // Point 19 across formats (statementDedupe.ts), for every line.
  const window = storedWindowOf(stmt.entries);
  const stored = window === null ? [] : readStoredLines(ctx, account.id, family, window.from, window.to);
  const incoming = stmt.entries.flatMap((e, index) => (kept(index) ? [incomingOf(e, index, family)] : []));
  const decisions: Map<number, LineDecision> =
    stored.length === 0 ? new Map() : decideLines({ family, mode: crossFormatModeOf(ctx), stored, incoming, exactClaimed });
  const familyOfStored = new Map(stored.map((r) => [r.id, r.family]));

  // Coverage's one-to-one match on the movement key, for the lines on covered days: every covered day of a
  // delivery that does not extend the chain, and the days a delivery without a balance chain (a CSV) covers
  // for one that does (critic R4-1).
  const coverageFlag = new Map<number, PossibleDuplicate | { bankTxnId: null; reason: 'covered_period_new_line' }>();
  if (coverage.span.full.size > 0 || coverage.span.edge.size > 0) {
    const overlap = incoming.filter((l) => {
      const d = lineDays[l.index] ?? null;
      return d !== null && (coverage.span.full.has(d) || coverage.span.edge.has(d)) && decisions.get(l.index)?.kind !== 'absorb';
    });
    const keyOf = (index: number): string => movementKeyOf(stmt.entries[index] as ParsedCamtEntry);
    const keys = [...new Set(overlap.map((l) => keyOf(l.index)))];
    const keyDates = keys.map((k) => k.slice(0, k.indexOf('|'))).filter((d) => d !== '').sort();
    const byKey =
      keyDates.length === 0 ? new Map<string, string[]>() : storedMovements(ctx, account.id, keys, { from: keyDates[0] as string, to: keyDates[keyDates.length - 1] as string });
    const used = new Map<string, number>();
    for (const l of overlap) {
      const k = keyOf(l.index);
      const list = byKey.get(k) ?? [];
      const i = used.get(k) ?? 0;
      if (i < list.length) {
        used.set(k, i + 1);
        coverageFlag.set(l.index, { bankTxnId: list[i] as string, reason: 'same_movement' });
      } else if (coverage.span.full.has(lineDays[l.index] as string)) {
        coverageFlag.set(l.index, { bankTxnId: null, reason: 'covered_period_new_line' });
      }
    }
  }
  const nearDuplicates: NearCrossFormatDuplicate[] = [];

  // D178 (critic M5): the two inserts every line makes are compiled once per statement, not per line.
  const insertTxn = ctx.store.db.prepare(
    `INSERT INTO bank_txn
       (id, workspace_id, bank_account_id, statement_id, entry_key, entry_ref, amount_minor,
        currency, credit_debit, booking_date, value_date, reference_kind, reference_value,
        payer_name, reversal_ind, btc_domain, btc_family, btc_sub_family, batch_pmt_inf_id,
        classification, credit_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertDetail = ctx.store.db.prepare(
    `INSERT INTO bank_txn_detail (bank_txn_id, workspace_id, counterparty_name, counterparty_iban, remittance_text, end_to_end_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  for (let index = 0; index < stmt.entries.length; index += 1) {
    const entry = stmt.entries[index] as (typeof stmt.entries)[number];
    let storageKey = entry.entryKey;
    if (exactRepeat.has(index) && !allowDuplicateEntries) {
      skipped.push({ entryRef: entry.entryRef, reason: 'duplicate_entry' });
      continue;
    }
    if (existingKeys.has(storageKey)) {
      // A bank reference the caller admits as a genuine second booking (D81's escape), or a storage label
      // already taken: a distinct storage key, never a relaxed index.
      let n = 1;
      while (existingKeys.has(`${entry.entryKey}~dup${n}`)) n += 1;
      storageKey = `${entry.entryKey}~dup${n}`;
    }
    // D178 point 19 (A20 §11.4), `auto_strong` only: the same movement another format already brought in,
    // PROVED by the bank's own reference on the same booking date. Skipped and named, unless the caller
    // admits it as a genuine second movement (the D81 escape, exactly as for an exact repeat).
    const decision = decisions.get(index);
    if (decision?.kind === 'absorb' && !allowDuplicateEntries) {
      skipped.push({ entryRef: entry.entryRef, reason: 'cross_format_duplicate', existingBankTxnId: decision.existingBankTxnId });
      continue;
    }
    existingKeys.set(storageKey, '');

    const txnId = ctx.ids.next('btxn');
    const reversal = entry.reversalInd;
    const classification: CamtClassification =
      reversal ? 'unclassified' : entry.creditDebit === 'CRDT' ? 'incoming_credit' : 'outgoing_debit';

    let creditId: string | null = null;
    if (classification === 'incoming_credit') {
      // A39 L2: the A21 row of a camt credit only FOLLOWS its line (`syncCreditRow`); the line itself is
      // decided on the bank inbox, and `apply_qr_match` / `override_qr_match` refuse `use_bank_inbox`.
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

    insertTxn.run(
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
        entry.batchPmtInfId ?? entry.txPmtInfId,
        classification,
        creditId,
        now,
      );
    // A39: the counterparty facts the inbox and the proposals read, kept beside the line (never in its
    // identity key or the statement hash, so a pre-A39 file still re-imports as a duplicate).
    insertDetail.run(txnId, ctx.workspaceId, entry.counterpartyName, entry.counterpartyIban, entry.remittanceText, entry.endToEndId);
    // D178 (A20 §11.1): the facts beyond the booked amount, once, beside the line.
    if (entry.facts !== undefined) writeLineFacts(ctx, txnId, entry.facts);
    insertedCount += 1;

    // D178 point 19 (A20 §11.4): a new line that may be a stored line is imported AND flagged on the line
    // itself with every candidate; it waits for the person's decision before it can be booked.
    const covFlag = coverageFlag.get(index);
    const named: PossibleDuplicate[] = [];
    if (covFlag !== undefined && covFlag.bankTxnId !== null) named.push(covFlag as PossibleDuplicate);
    if (decision?.kind === 'flag') {
      for (const c of decision.candidates) {
        const at = named.findIndex((n) => n.bankTxnId === c.bankTxnId);
        if (at < 0) named.push(c);
        else if (REASON_RANK[c.reason] < REASON_RANK[(named[at] as PossibleDuplicate).reason]) named[at] = c;
      }
    }
    if (named.length > 0 || covFlag !== undefined) {
      const candidates = named
        .map((c, order) => ({ c, order }))
        .sort((x, y) => REASON_RANK[x.c.reason] - REASON_RANK[y.c.reason] || x.order - y.order)
        .map((x) => x.c)
        .slice(0, MAX_CANDIDATES);
      const reason: PossibleDuplicateReason = candidates[0]?.reason ?? 'covered_period_new_line';
      writePossibleDuplicates(ctx, txnId, reason, candidates);
      nearDuplicates.push({
        bankTxnId: txnId,
        existingBankTxnId: candidates[0]?.bankTxnId ?? null,
        reason,
        sameFormat: candidates.every((c) => (familyOfStored.get(c.bankTxnId) ?? family) === family),
        candidates: candidates.map((c) => c.bankTxnId),
      });
    }
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

  // The warning codes a surface words (A20 §11.4): a line named across formats, a line matched one to one
  // on a covered day, a line on a covered day that matches nothing.
  const allWarnings = [...warnings];
  if (nearDuplicates.some((n) => !n.sameFormat)) allWarnings.push('possible_cross_format_duplicate');
  if ([...coverageFlag.values()].some((f) => f.reason === 'same_movement')) allWarnings.push('overlap_same_movement');
  if ([...coverageFlag.values()].some((f) => f.reason === 'covered_period_new_line')) allWarnings.push('covered_period_new_line');
  return {
    statementId: statementRowId,
    txnCount: insertedCount,
    duplicate: false,
    skipped,
    warnings: allWarnings,
    ...(nearDuplicates.length > 0 ? { nearDuplicates } : {}),
  };
}

// --- suggestCamtMatches (US-A20.2), read-only (Pattern P5) ------------------------------------------

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

/** The A36 confidence rank of an A39 certainty, so the workspace review threshold still applies. */
const CERTAINTY_AS_CONFIDENCE: Record<BankProposalCertainty, 'high' | 'medium' | 'none'> = {
  sure: 'high',
  learned: 'medium',
  check: 'medium',
  open: 'none',
};

/**
 * Whether one OPEN line needs a human's review (A36 US-A36.5, generalised by A39 to credits and debits
 * alike): its A39 proposal's certainty, read as an A36 confidence, falls below the workspace review
 * threshold, or the line is a reversal (always a human's call). A decided line never needs review.
 * Exported for the per-line import signal (`import_camt` fires `bank_txn.needs_review` over it).
 *
 * D144 (critic C8): the ladder is read WITHOUT the model rung. A model's unchecked guess is the weakest
 * reason on the ladder; it must not switch off the signal that asks a person to look, so a line whose
 * only proposal is a model suggestion needs review exactly as it did before the model spoke.
 *
 * D167 (critic D167-1, A39 §13.2): the same for the journal rung (d2). A text match in an old entry is
 * no better evidence than a model's guess, so it never switches the signal off: the default context
 * skips the rung (and so never reads the journal), and a `journal_history` proposal from a context a
 * caller hands in reads as needing review. A standard's `sure` (owner pick 1A) does switch it off.
 */
export function lineNeedsReview(
  ctx: WorkspaceContext,
  row: BankTxnRow,
  config: CamtMatchConfig = readCamtMatchConfig(ctx),
  pc: ProposalContext = proposalContext(ctx, { withModel: false, withJournal: false }),
): boolean {
  if (lineStateOf(ctx, row).state !== 'open') return false;
  if (row.reversal_ind === 1) return true;
  const proposal = proposeForLine(ctx, pc, row, readBankTxnDetail(ctx, row.id));
  // Belt to the braces above, for a caller that hands in a context built with the model or journal rung.
  if (proposal.reasonCode === 'model_suggested' || proposal.reasonCode === 'journal_history') return true;
  // D176 (A39 §15.3): a "Nicht buchen" rule NEVER switches the signal off, not even as `sure` under
  // `bank.buchungsregel_ignore_mode` = `bulk`: an ignored line never reaches the ledger, so a person looks.
  if (proposal.reasonCode === 'rule_ignore') return true;
  // D175 (A39 §14.3): a Buchungsregel switches the signal off ONLY when its proposal is `sure` (a complete
  // rule under `bank.buchungsregel_mode` = `bulk`). A rule that asks for an amount, the person's pick among
  // several rules, a rule proposal turned `check` by the setting or a dropped code: a person still looks.
  // D177: a computed-only rule (`rule_computed`) likewise: only its `sure` (setting
  // `bank.buchungsregel_computed_mode` = `bulk`) switches the signal off; the default `check` keeps it on.
  if (
    (proposal.reasonCode === 'standard' ||
      proposal.reasonCode === 'rule_needs_amount' ||
      proposal.reasonCode === 'rule_computed' ||
      proposal.reasonCode === 'several_rules') &&
    proposal.certainty !== 'sure'
  ) {
    return true;
  }
  const confidence = CERTAINTY_AS_CONFIDENCE[proposal.certainty];
  if (confidence === 'none') return true;
  const floor = config.reviewThreshold === 'high' ? 2 : 1;
  return CONFIDENCE_RANK[confidence] < floor;
}

/**
 * A36 US-A36.5: signal that ONE bank line needs a human's review because its proposal is below the
 * workspace threshold. WRITES NO LEDGER ROW and books nothing (the only thing it persists is its own
 * idempotency memo): it is a pure signal whose success emits `bank_txn.needs_review` for a G01 rule to
 * react to ("when a bank line needs review, create an E03 task"). Idempotent per (bankTxnId,
 * idempotencyKey). A39: a CREDIT is reviewed the same way as a debit (one line model; the A21 queue's
 * score is one of the proposal's sources), so the `use_qr_queue` refusal is gone. §H-TENANT via
 * `readTxnRow` (a foreign-workspace id is `not_found` before any work).
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

  const needs = lineNeedsReview(ctx, row);
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
 * `confirm_match`, A20's decision verb, kept as a WRAPPER over the A39 core (spec A39 §5), memoised under
 * its own verb name so no caller's key changes meaning:
 *
 *  - `vendorBillId`: an `open_item` booking of the debit (A39 §4.3: the bill settles through A14, a
 *    surplus parks as the supplier's Guthaben instead of refusing, walk B8.3);
 *  - `entryId`: an `existing_entry` MATCH under the A39 guard (walk B9.3: the entry must book this
 *    account with this signed amount, and its leg must not back another line); open to a credit too,
 *    since a credit is handled like a debit now;
 *  - `allocations[]`: the multi-bill split of US-A20.5, one A14 payment over several bills, as before,
 *    now recorded through the one link writer.
 *
 * A line that is no longer open refuses `line_not_open` (walk B14.3: the old answer replayed someone
 * else's link as `ok`, so an approved stale Vorschlag reported executed while nothing ran). A same-key
 * retry is answered from the memo first.
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
  if (input.allocations !== undefined && (!Array.isArray(input.allocations) || input.allocations.length === 0)) {
    return err('invalid_input', { field: 'allocations' });
  }

  const scopedKey = JSON.stringify(['confirm_match', input.bankTxnId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result<ConfirmCamtMatchOk>>(ctx.workspaceId, scopedKey, 'confirm_match');
  if (replayed !== undefined) return replayed;

  const row = readTxnRow(ctx, input.bankTxnId as string);
  if (row === undefined) return err('not_found', { bankTxnId: input.bankTxnId });
  // A20-C3: a settlement always books an OUTGOING payment, so a CRDT bank fact (a reversal-flagged
  // returned payment, or any credit) cannot be settled that way; the entryId match stays open to both.
  if (wantsSettlement && row.credit_debit !== 'DBIT') {
    return err('wrong_direction', {
      bankTxnId: row.id,
      creditDebit: row.credit_debit,
      reason:
        'a CRDT bank fact (money arriving) is not settled as an outgoing payment; correct a returned payment via reverse_payment, or use entryId to annotate an existing entry',
    });
  }
  const state = lineStateOf(ctx, row);
  if (state.state !== 'open') {
    return err('line_not_open', {
      bankTxnId: row.id,
      state: state.state,
      linkId: state.link?.linkId ?? null,
      staleProposal: true,
      reason: 'this line is already decided; reopen_bank_line undoes the decision first',
    });
  }
  // D178 point 19 (critic R3-1): a line waiting for its duplicate answer is settled by no path, the
  // multi-bill split included (its writeLineLink and the trigger refuse too; this says so before any payment).
  const duplicatePending = duplicateDecisionPending(ctx, row.id);
  if (duplicatePending !== null) return duplicatePending;

  return runBankGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'confirm_match', () => {
      if (input.allocations === undefined) {
        const target: BookBankLineTarget =
          input.vendorBillId !== undefined
            ? { kind: 'open_item', documentId: input.vendorBillId }
            : { kind: 'existing_entry', entryId: input.entryId as string };
        const booked = performBooking(ctx, row, target, {});
        if (!booked.ok) throw new BankAbort(booked);
        const done = booked as unknown as BookBankLineOk;
        return ok<ConfirmCamtMatchOk>({
          bankTxnId: row.id,
          kind: done.targetKind === 'existing_entry' ? 'journal_entry' : 'payment',
          targetId: done.targetKind === 'existing_entry' ? (done.entryId as string) : (done.paymentId as string),
        });
      }
      // The multi-bill split (US-A20.5): one A14 payment over several bills, exactly as A20 built it.
      // Spec §4.3 (C8, critic M1 lean): a bill in a live A18 run is paid by that run, here as on the
      // `open_item` path; settling it here would leave the run's `markBatchPaid` refusing for good.
      for (const a of input.allocations) {
        const billId = a.vendorBillId ?? a.targetId;
        const liveRun = typeof billId === 'string' ? liveBatchOfBill(ctx, billId) : null;
        if (liveRun !== null) throw new BankAbort(err('already_batched', { vendorBillId: billId, batchId: liveRun }));
      }
      const bankAccount = ctx.store.db
        .prepare('SELECT ledger_account_id FROM bank_account WHERE workspace_id = ? AND id = ?')
        .get(ctx.workspaceId, row.bank_account_id) as { ledger_account_id: string } | undefined;
      if (bankAccount === undefined) throw new BankAbort(err('needs_bank_account', { bankAccountId: row.bank_account_id }));
      const paid = recordPayment(ctx, {
        direction: 'outgoing',
        date: lineBookingDate(row),
        amountMinor: row.amount_minor,
        currency: row.currency,
        bankAccountId: bankAccount.ledger_account_id,
        allocations: input.allocations.map((a) => ({
          ...(a.vendorBillId !== undefined ? { vendorBillId: a.vendorBillId } : {}),
          ...(a.targetId !== undefined ? { targetId: a.targetId } : {}),
          amountMinor: (a.amountMinor ?? row.amount_minor) as number,
        })),
        source: 'camt',
        intent: PAYMENT_INTENTS.record,
        idempotencyKey: `camt-confirm-${row.id}-g${lineGeneration(ctx, row.id)}`,
      });
      if (!paid.ok) throw new BankAbort(paid as Err);
      const paymentId = paid['paymentId'] as string;
      writeLineLink(ctx, {
        bankTxnId: row.id,
        kind: 'payment',
        targetId: paymentId,
        state: 'booked',
        targetKind: 'open_item',
        paymentId,
        entryId: typeof paid['entryId'] === 'string' ? (paid['entryId'] as string) : null,
        claims: bankLegsOf(ctx, bankAccount.ledger_account_id, [paid['entryId'] as string | undefined]).map((l) => l.lineId),
      });
      ctx.audit.record({ entityKind: 'bank_txn', entityId: row.id, action: 'confirm', actor: ctx.actor, at: ctx.clock.now() });
      return ok<ConfirmCamtMatchOk>({ bankTxnId: row.id, kind: 'payment', targetId: paymentId });
    }),
  );
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
 * `create_entry_for_txn`, A20's booking verb, kept as a WRAPPER: a one-leg A39 `accounts` booking
 * (the bank leg plus the chosen contra account) memoised under its own verb name. What changed with
 * A39, each a walk fix: `taxCode` is HONOURED through A06's `buildVatLines` exactly as a manual journal
 * line is (B6.2, where it used to refuse `vat_on_manual_bank_entries_not_modelled` and the Studio booked
 * gross); a CREDIT is bookable (B6.5: interest, a refund, an own transfer had no verb at all); a
 * foreign-currency line books in its own currency at the stored rate (B6.3), VAT excepted.
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

  const scopedKey = JSON.stringify(['create_entry_for_txn', input.bankTxnId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result<CreateEntryForTxnOk>>(ctx.workspaceId, scopedKey, 'create_entry_for_txn');
  if (replayed !== undefined) return replayed;

  const row = readTxnRow(ctx, input.bankTxnId as string);
  if (row === undefined) return err('not_found', { bankTxnId: input.bankTxnId });
  const state = lineStateOf(ctx, row);
  if (state.state !== 'open') {
    return err('line_not_open', {
      bankTxnId: row.id,
      state: state.state,
      linkId: state.link?.linkId ?? null,
      staleProposal: true,
      reason: 'this line is already decided; reopen_bank_line undoes the decision first',
    });
  }

  return runBankGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'create_entry_for_txn', () => {
      const booked = performBooking(
        ctx,
        row,
        {
          kind: 'accounts',
          legs: [
            {
              accountId: input.contraAccountId as string,
              amountMinor: row.amount_minor,
              ...(input.taxCode !== undefined ? { taxCode: input.taxCode } : {}),
            },
          ],
        },
        { text: input.description ?? `Bankbuchung ${row.entry_ref ?? row.id}` },
      );
      if (!booked.ok) throw new BankAbort(booked);
      return ok<CreateEntryForTxnOk>({ bankTxnId: row.id, entryId: (booked as unknown as BookBankLineOk).entryId as string });
    }),
  );
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
  /** A39: ignored lines are decided and leave the three lanes (owner answer 1); listed here instead. */
  ignored?: CamtTxnView[];
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
  /**
   * A39: the lines of this statement whose ONE state is `open` (spec A39 §4.2), the number a person
   * still has to decide. The same predicate as the inbox, the board and G22's check: an ignored line is
   * decided, and a line booked with a remainder is decided too (its rest is open on the invoice or bill).
   */
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
  const openRows = ctx.store.db.prepare(
    `SELECT COUNT(*) AS n FROM bank_txn t ${LINE_STATE_JOINS('t')}
      WHERE t.workspace_id = ? AND t.statement_id = ? AND ${LINE_STATE_EXPR('t')} = 'open'`,
  );
  const statements = stmts.map((s): BankStatementSummary => {
    const openCount = (openRows.get(ctx.workspaceId, s.id) as { n: number }).n;
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
  const decided = items.filter((i) => i.lineState !== 'ignored');
  const result: ListReconciliationOk = {
    matched: decided.filter((i) => i.status === 'matched'),
    unmatched: decided.filter((i) => i.status === 'unmatched'),
    partial: decided.filter((i) => i.status === 'partial'),
    ignored: items.filter((i) => i.lineState === 'ignored'),
  };
  if (statement !== undefined) {
    const reconciled = statementReconciled(ctx, statement);
    if (reconciled !== null) result.reconciled = reconciled;
  }
  return ok<ListReconciliationOk>(result);
}
