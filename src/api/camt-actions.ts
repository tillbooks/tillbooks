/**
 * A20, the camt reconciliation verb surface: import, suggest, confirm, book, and the reconciled read.
 *
 * Defined here rather than inline in `registry.ts` for the reason §H-FX, A14, A19 and A21 all
 * established: the registry is the one append-only tool list and several agents append to it at once,
 * so the smaller the hunk the cheaper the merge. The helpers arrive as a parameter to keep the module
 * graph acyclic.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  importCamt,
  importCamtFiles,
  suggestCamtMatches,
  confirmCamtMatch,
  createEntryForTxn,
  listReconciliation,
  listBankStatements,
  reviewBankTxn,
  setCamtMatching,
} from '../core/banking/index.js';
import { importBankStatement, bankCsvPreview, prevalidateImportBankStatement } from '../core/banking/statementImport.js';
import { getBankCsvMapping, setBankCsvMapping } from '../core/banking/csvMapping.js';
import { resolvePossibleDuplicate, prevalidateResolvePossibleDuplicate } from '../core/banking/duplicateDecision.js';
import type { ActionKind } from './actionKind.js';

export interface CamtActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  /** D158/D178: attach a verb's pure pre-draft validation (`ActionDef.prevalidate`). */
  withPrevalidate(def: ActionDef, check: (ctx: WorkspaceContext, input: ActionInput) => Result | undefined): ActionDef;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
  BOOL: { readonly type: 'boolean' };
}

export function camtActions(h: CamtActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, withPrevalidate, STR, INT, BOOL } = h;

  const as = <T>(input: ActionInput): T => input as unknown as T;

  /** One allocation of a debit's cash onto a vendor bill (the A14 `ALLOCATIONS` shape, US-A20.5). */
  const ALLOCATIONS = {
    type: 'array',
    items: {
      type: 'object',
      properties: { vendorBillId: STR, targetId: STR, amountMinor: INT },
      required: [],
    },
  } as const;

  return [
    ctxAction(
      'import_camt',
      'write:final:books',
      "Import a day-end camt.053 statement onto a registered Bankkonto (A19): parses the XML, checks the file's IBAN against the account, and persists every booked entry, each keyed on its AcctSvcrRef, else its NtryRef, else its content. Duplicates are decided coverage first (D178 point 19, see import_bank_statement): only an AcctSvcrRef already in the books drops a line (skipped duplicate_entry); a statement that does not extend the balance chain imports its lines on days the books already cover FLAGGED (same_movement or covered_period_new_line), waiting for resolve_possible_duplicate, never counted twice silently. A byte-identical re-import of the same statement (Stmt/Id + ElctrncSeqNb + page number) is a safe no-op (duplicate:true); a same-identity statement whose content has genuinely changed refuses with statement_amended, naming what changed. allowDuplicateEntries:true admits a line whose AcctSvcrRef is already in the books as a genuine second movement; it never silences a flag. A batch entry (several TxDtls in one booking) fans out into one line per TxDtls; a repeated AcctSvcrRef inside one booking is kept apart (asr:<ref>#<n>), and a batch whose details are in another currency or do not sum to the booking is ONE line of the booking amount. A camt.054 refuses camt054_refused (a detail notification, not a statement). A camt.053 without ElctrncSeqNb or closing balance imports with the warning not_day_end_statement in warnings[]: import that day's day-end statement too. On an account fed over EBICS (A36) the successor rule decides first, at this door as at bank_sync: a statement imports only as the successor of the newest statement in the books (feed.rule, and with the warning statement_number_jump plus feed.jump naming the skipped numbers when its number skips some but its balances chain) or as the filler of a hole; a copy of one already there is a no-op (duplicate:true); otherwise it refuses gap_refused, overlap_refused, before_feed_start, unsupported_multipage_statement, or not_day_end_statement (refused there, not a warning), each naming the statements it compared, and a retry never helps: import the missing statement first. A booked, non-reversal CREDIT is also registered in A21's QR queue, whose row follows the line. Every new line then waits in the bank inbox (list_bank_inbox / book_bank_line); nothing is booked by the import. An archived Bankkonto refuses bank_account_archived; a file whose IBAN belongs to another registered account refuses iban_mismatch naming both IBANs and that account; an IBAN registered nowhere answers needs_bank_account with the file IBAN. Any entry this parser could not read, or an entry it skipped as a duplicate, is named in the skipped[] list, never silently dropped.",
      ctxSchema(
        { bankAccountId: STR, xml: STR, allowDuplicateEntries: BOOL, idempotencyKey: STR },
        ['bankAccountId', 'xml', 'idempotencyKey'],
      ),
      (ctx, input) => importCamt(ctx, as(input)),
    ),
    // A36 §4.7 (D150): the hand repair of a statement gap, several files in one call.
    ctxAction(
      'import_camt_files',
      'write:final:books',
      "Import several day-end camt.053 files onto one registered Bankkonto at once, in statement-number order: the hand repair of a statement gap (A36 §4.7, D150), for the days fetched from eBanking. Each file is split into single statements when it holds several <Stmt> (the envelope kept; a file whose statements disagree on IBAN or currency, or lack ElctrncSeqNb, is refused camt_split_refused rather than guessed), every statement is sorted by its position (year of FrDtTm, ElctrncSeqNb), and ONE ordered pass imports each through import_camt's own door, so on an EBICS-fed account the successor rule decides exactly as for one file (a hole filler lands in number order) and nothing counts twice. The answer is one outcome per statement in pass order: imported (statementId, txnCount, warnings), already_imported (the same statement is in the books; dropping the same files again imports nothing) or refused with the code and reason import_camt gives (gap_refused names the differenceMinor that does not chain, overlap_refused, iban_mismatch, camt054_refused, ...), plus imported/alreadyImported/refused totals. At most 100 files. Each call needs a fresh idempotencyKey; a replay returns the first report. Books nothing: every new line waits in the bank inbox.",
      ctxSchema(
        {
          bankAccountId: STR,
          files: { type: 'array', items: { type: 'object', properties: { name: STR, xml: STR }, required: ['xml'] } },
          idempotencyKey: STR,
        },
        ['bankAccountId', 'files', 'idempotencyKey'],
      ),
      (ctx, input) => importCamtFiles(ctx, as(input)),
    ),
    // D178 point 4 (spec A20 §11.4): one door for every statement format, and the CSV mapping verbs. A
    // governed seat's import is validated like a direct call BEFORE it is drafted, and an agent's CSV import
    // must carry its mapping in the payload, so what a person approves is what runs (D162).
    withPrevalidate(ctxAction(
      'import_bank_statement',
      'write:final:books',
      "Import ONE bank statement file onto a registered Bankkonto, whatever its format: a camt.053 XML, an MT940 (.sta/.mt940/.txt), or a bank CSV export. Send the file as content (text) or contentBase64 (its bytes; a CSV's encoding is detected from them: UTF-8 with or without BOM, else Windows-1252). format (auto, camt, mt940, csv) defaults to auto-detection. A camt goes through import_camt's own door, statement by statement in number order (the EBICS successor rule, the camt.054 refusal and every import_camt rule apply). An MT940 is read field by field (:25: must be this Bankkonto's IBAN, else the statement refuses account_mismatch; an account number that is not an IBAN imports with the warning account_unverified, unless the same file verifies another statement as this Bankkonto's, which refuses every statement naming a different account account_mismatch, and a file naming several accounts none of which verifies refuses mt940_several_accounts naming them; EC/ED expected entries are skipped as pending). A CSV is read through the Bankkonto's saved column mapping or the mapping you pass (see bank_csv_preview; saveMapping, default true, saves a passed mapping for next time); with neither it refuses csv_mapping_required with a guessedMapping, and a mapping that lacks the booking date or the amount, or names a column the file does not carry, refuses csv_mapping_invalid naming it. Duplicates are decided per Bankkonto, COVERAGE FIRST (D178 point 19, A20 §11.4). A delivery that EXTENDS the balance chain (its opening is the stored closing at the chain's end AND it starts later, or carries the next sequence number the same day) brings new lines; only a bank reference already in the books (camt AcctSvcrRef, MT940 //) drops a line (skipped duplicate_entry). A delivery that does not extend is an OVERLAP on the days stored statements already cover (their periods minus the known gaps; a CSV covers its first booking date to the day before its last, as does a camt or MT940 without a balance chain): each of its lines there is matched one to one on its movement (booking date, else value date; direction; amount; currency; occurrence) and imported FLAGGED same_movement naming the stored line (warning overlap_same_movement), or, matching nothing on a fully covered day, FLAGGED covered_period_new_line (warning covered_period_new_line); outside the covered span coverage flags nothing. Across formats the owner's rule applies as well: a stored line of ANOTHER format with the same direction, amount and currency, a counterparty that does not contradict (equal IBANs, else a shared name word, else money and date alone) and a booking or value date within three days is a candidate, and the line is imported FLAGGED with every candidate (warning possible_cross_format_duplicate). Flags show on list_bank_inbox (possibleDuplicates, possibleDuplicateOf, needsDuplicateDecision) and in nearDuplicates. A flagged line is never sure and no booking path takes it (duplicate_decision_pending) until resolve_possible_duplicate answers duplicate or distinct, one line at a time or every one-to-one match of the delivery at once. The setting bank.cross_format_duplicates = auto_strong (default ask) drops only a line whose bank reference another format's line carries with the same money on the same booking date (skipped cross_format_duplicate naming existingBankTxnId); two different bank references never drop, and a CSV never drops across formats. The same statement again is already_imported, the same statement identity with changed content refuses statement_amended; statement number, page and file are delivery identity only, never part of a line's key. allowDuplicateEntries admits a line whose bank reference is already in the books as a genuine second movement; it never silences a flag. Each line keeps its facts (bank code with the SIX label, the bank texts, references, the instructed foreign amount, the bank's and the effective rate, the charges and the fee), shown on list_bank_inbox. The answer: format, statements[] (outcome imported | already_imported | refused with code and reason, txnCount, duplicates, warnings), and the totals imported, duplicates (already in the books) and refused (lines not read: unreadable date or amount, zero, another currency, a total row), with skipped[] giving each line's reason and a sentence. An account fed over EBICS takes camt only: MT940 or CSV refuses bank_feed_account. An agent seat's import is validated at draft time with these same refusals, and an agent's CSV import must carry its mapping in the payload (a CSV without one refuses csv_mapping_required with the saved mapping attached as savedMapping: pass it as mapping), so the approval runs exactly the mapping the person saw. Books nothing: every new line waits in the bank inbox. Idempotent per key and file.",
      ctxSchema(
        {
          bankAccountId: STR,
          content: STR,
          contentBase64: STR,
          fileName: STR,
          format: STR,
          mapping: { type: 'object' },
          saveMapping: BOOL,
          allowDuplicateEntries: BOOL,
          idempotencyKey: STR,
        },
        ['bankAccountId', 'idempotencyKey'],
      ),
      (ctx, input) => importBankStatement(ctx, as(input)),
    ), (ctx, input) => prevalidateImportBankStatement(ctx, as(input))),
    ctxAction(
      'bank_csv_preview',
      'read',
      "Read a bank CSV the way import_bank_statement would, writing nothing: the detected encoding, separator and header row (a preamble above the header is skipped), the headers, the first 20 rows, and the column mapping it would use (the one you pass, else the Bankkonto's saved one, else a guess from the header words, with mappingSource given | saved | guessed, and guessedMapping always). missing names the required targets the mapping leaves unmapped (bookingDate; amount meaning a signed amount column or debit/credit columns), unknownColumns the mapped headers the file lacks, and blocking says it in one sentence; when the mapping reads the file, sample gives the first rows as they would import (date, value date, signed amount in Rappen, currency, text, counterparty) or the reason a row would be skipped. A mapping is { columns: { bookingDate, valueDate, amount | debit/credit, currency, text, counterparty, counterpartyIban, reference, instructedAmount, instructedCurrency, rate, fee: <header text> }, dateFormat: dd.mm.yyyy | dd.mm.yy | yyyy-mm-dd | dd/mm/yyyy, decimalSeparator?: . | ,, headerRow?, delimiter?: semicolon | comma | tab, encoding?: utf-8 | windows-1252 }. Send the file as content or contentBase64.",
      ctxSchema({ bankAccountId: STR, content: STR, contentBase64: STR, mapping: { type: 'object' } }, ['bankAccountId']),
      (ctx, input) => bankCsvPreview(ctx, as(input)),
    ),
    ctxAction(
      'set_bank_csv_mapping',
      'write:reversible:internal',
      'Save the CSV column mapping of one Bankkonto (the shape bank_csv_preview describes): from then on import_bank_statement reads that bank\'s CSV exports with it, by header text, so reordered columns still map. One mapping per Bankkonto; a later save replaces it (each change is in the audit log). Checks the shape only (unknown target field or date format refuses invalid_input); the file is checked at preview and import. Writes no ledger row. Idempotent per key.',
      ctxSchema({ bankAccountId: STR, mapping: { type: 'object' }, idempotencyKey: STR }, ['bankAccountId', 'mapping', 'idempotencyKey']),
      (ctx, input) => setBankCsvMapping(ctx, as(input)),
    ),
    ctxAction(
      'get_bank_csv_mapping',
      'read',
      'The saved CSV column mapping of one Bankkonto, with who saved it and when, or mapping: null when none is saved. Writes nothing.',
      ctxSchema({ bankAccountId: STR }, ['bankAccountId']),
      (ctx, input) => getBankCsvMapping(ctx, as(input)),
    ),
    // D178 point 19 (owner): the person's answer to a line flagged as a possible duplicate. Governed like
    // ignore_bank_line (the post dial): an agent may propose it, validated like a direct call first.
    withPrevalidate(
      ctxAction(
        'resolve_possible_duplicate',
        'write:reversible:books',
        'Answer a bank line flagged as a possible duplicate (list_bank_inbox: needsDuplicateDecision, possibleDuplicates), or every one-to-one match of one delivery at once. ONE LINE: bankTxnId with decision duplicate ("Duplikat": the line IS a movement already in the books; it is ignored with the reason duplicate, exactly as ignore_bank_line does, written first, and reopen_bank_line brings it back, needing a decision again) | distinct ("Kein Duplikat": its own movement, a normal line again, proposed and bookable); otherBankTxnId (optional) names the candidate judged against and must be one of possibleDuplicates; note (optional) is kept with the answer. ONE DELIVERY: statementId (the bank_statement id an import answered) with scope one_to_one_matches and decision duplicate answers every open line of that delivery that waits for its answer and was matched one to one on its movement (reason same_movement), each line with its own ignore and answer row; the answer lists decided [{ bankTxnId, otherBankTxnId, linkId }] and count. Until answered a line is never sure and no booking path decides it (duplicate_decision_pending). Refuses not_flagged for a line nothing names, line_not_open for a decided line, not_found for an unknown line or delivery. Every answer is recorded append-only (who, when), the latest in force; a re-import never touches it. Idempotent per key.',
        ctxSchema({ bankTxnId: STR, statementId: STR, scope: STR, decision: STR, otherBankTxnId: STR, note: STR, idempotencyKey: STR }, ['decision', 'idempotencyKey']),
        (ctx, input) => resolvePossibleDuplicate(ctx, as(input)),
      ),
      (ctx, input) => prevalidateResolvePossibleDuplicate(ctx, as(input)),
    ),
    ctxAction(
      'suggest_matches',
      'read',
      "Propose a match for every txn of an imported statement, writing nothing. A routed credit shows A21's live score (an invoice, or none). A debit or a reversed entry is RANKED (A36): the exact amount + currency gate is mandatory, then value-date proximity (workspace window, default +/- 5 days), counterparty-name overlap and reference hits order the gated bills, each proposal carrying a signals[] list (amount/value_date/counterparty/reference) and its confidence. A debit whose batch PmtInfId matches a generated A18 payment batch proposes the batch itself (kind:payment_batch); a batch-total mismatch is shown blocked (one-click disabled, use the manual split). Each txn also carries needsReview: true when no proposal reaches the workspace review threshold.",
      ctxSchema({ statementId: STR }, ['statementId']),
      (ctx, input) => suggestCamtMatches(ctx, as(input)),
    ),
    ctxAction(
      'review_bank_txn',
      'write:correctable:internal',
      "Signal that ONE open bank line (credit or debit) needs a human's review because its A39 proposal is below the workspace threshold (A36). Writes no ledger row and books nothing: it is a pure signal whose success emits bank_txn.needs_review for a G01 rule to react to (e.g. create an E03 task). Idempotent per (bankTxnId, idempotencyKey). import_camt already fires the same event once per new line; call this to re-signal a line later.",
      ctxSchema({ bankTxnId: STR, idempotencyKey: STR }, ['bankTxnId', 'idempotencyKey']),
      (ctx, input) => reviewBankTxn(ctx, as(input)),
    ),
    ctxAction(
      'set_camt_matching',
      'write:reversible:internal',
      'Tune the workspace debit-matching (A36 §6b): valueDateWindowDays (0-60, default 5) widens or narrows the value-date proximity signal, and reviewThreshold (any|medium|high, default any) sets the confidence floor below which a booked debit reports needsReview. These tune ranking and the review event only; they never touch the mandatory exact amount + currency gate. Idempotent; one row per workspace.',
      ctxSchema({ valueDateWindowDays: INT, reviewThreshold: STR, idempotencyKey: STR }, ['idempotencyKey']),
      (ctx, input) => setCamtMatching(ctx, as(input)),
    ),
    ctxAction(
      'confirm_match',
      'write:correctable:books',
      "A20's decision verb, now a wrapper over book_bank_line: settle an outgoing DEBIT against a vendor bill (vendorBillId, an open_item booking; a surplus parks as the supplier's Guthaben) or several bills (allocations[] for a multi-bill split) through A14's record_payment, or MATCH an existing journal entry that already books the movement (entryId, credit or debit: the entry must book this line's bank account with the same signed amount and its leg must not back another line). A settlement against a bank fact that is not a DBIT refuses wrong_direction. A line that is no longer open refuses line_not_open. Idempotent per key.",
      ctxSchema(
        {
          bankTxnId: STR,
          vendorBillId: STR,
          allocations: ALLOCATIONS,
          entryId: STR,
          idempotencyKey: STR,
        },
        ['bankTxnId', 'idempotencyKey'],
      ),
      (ctx, input) => confirmCamtMatch(ctx, as(input)),
    ),
    ctxAction(
      'create_entry_for_txn',
      'write:correctable:books',
      'A20\'s booking verb, now a wrapper over book_bank_line with one accounts leg: book an open line (a bank fee, interest, a refund, a transfer; credit or debit) to the chosen contra account via A02 and link it. taxCode is computed exactly as a manual journal line under the workspace VAT method (Vorsteuer, Umsatzsteuer, Bezugsteuer). A foreign-currency line books in its own currency at the stored rate (VAT on it refuses unsupported). A line that is no longer open refuses line_not_open.',
      ctxSchema(
        { bankTxnId: STR, contraAccountId: STR, description: STR, taxCode: STR, idempotencyKey: STR },
        ['bankTxnId', 'contraAccountId', 'idempotencyKey'],
      ),
      (ctx, input) => createEntryForTxn(ctx, as(input)),
    ),
    ctxAction(
      'list_reconciliation',
      'read',
      'The reconciliation board: matched, unmatched and partial txns. A single-statement call (statementId) also returns reconciled (true once the ledger bank account matches the statement\'s closing balance to the Rappen, D64 as-of; absent when the Bankkonto is foreign-currency or the message carried no balance). A cross-statement call (bankAccountId/from/to, or savedViewId) omits it and returns the filtered lists only.',
      ctxSchema({ statementId: STR, bankAccountId: STR, from: STR, to: STR, savedViewId: STR }),
      (ctx, input) => listReconciliation(ctx, as(input)),
    ),
    ctxAction(
      'list_bank_statements',
      'read',
      'The imported camt statements of the workspace, newest period first, each with its open-line count (lines still unmatched or partial) and the D64 reconciled indicator. This is the door to a statement: take its statementId into list_reconciliation and suggest_matches. bankAccountId narrows to one Bankkonto. Writes nothing.',
      ctxSchema({ bankAccountId: STR }),
      (ctx, input) => listBankStatements(ctx, as(input)),
    ),
  ];
}

