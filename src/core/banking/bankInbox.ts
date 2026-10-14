/**
 * A39, the bank inbox read and the balance line (spec §2, §4.5, L4): every line of every statement in
 * one list, each with its one state and its decision or its proposal; per Bankkonto three numbers; and
 * G22's "Bank abgestimmt" per period.
 *
 * THE BALANCE IS THREE NUMBERS (spec L4). At the latest statement date:
 *
 *   differenceMinor = bankBalanceMinor - ledgerBalanceMinor - openSumMinor
 *
 * the statement's closing balance, the linked ledger account's balance that day, and the signed sum of
 * the lines still open up to that day. Nothing else is explained away: an ignored line whose money is
 * not on the books, an entry no line backs, an accepted difference, and a line matched to an entry dated
 * after the statement all simply show as a difference (the last one until the next statement, C18).
 *
 * Signs: a line's signed amount is + for money in, - for money out; the ledger is debit - credit on the
 * bank asset account. FOREIGN CURRENCY IS JUDGED IN ITS OWN CURRENCY (D-A39.6): a EUR statement against
 * the EUR movement on the linked account, never a converted base figure.
 *
 * Pure reads, §H-TENANT on every query.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { optionalId, optionalText, optionalDate } from '../ledger/inputGuards.js';
import { applySavedView } from '../customization/views.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { BANK_LINE_STATES, LINE_STATE_EXPR, LINE_STATE_JOINS, readActiveLink, signedAmountOf } from './bankLines.js';
import type { BankLineState, BankTxnDetailRow, BankTxnRow } from './bankLines.js';
import { proposalContext, proposeForLine } from './bankProposals.js';
import type { BankLineProposal } from './bankProposals.js';
import type { BookBankLineTarget } from './bankLines.js';
import { IS_HEAD } from '../files/head.js';
import { STATEMENT_IS_VOUCHER_SQL } from '../accounts/accounts.js';

// --- Views ---------------------------------------------------------------------------------------

export type BankInboxDecision = {
  linkId: string;
  targetKind: string;
  entryId: string | null;
  paymentId: string | null;
  ignoreReason: string | null;
  note: string | null;
  remainderMode: string | null;
  remainderMinor: number | null;
  differenceMinor: number | null;
  decidedBy: string | null;
  decidedAt: string;
};

export type BankInboxLine = {
  bankTxnId: string;
  bankAccountId: string;
  statementId: string;
  state: BankLineState;
  bookingDate: string | null;
  valueDate: string | null;
  /** Signed: + money in, - money out. */
  amountMinor: number;
  currency: string;
  creditDebit: 'CRDT' | 'DBIT';
  reversal: boolean;
  counterparty: { name: string | null; iban: string | null };
  remittance: { text: string | null; referenceKind: string; referenceValue: string | null; endToEndId: string | null };
  entryRef: string | null;
  creditId: string | null;
  /** The decision behind a booked, matched or ignored line; null on an open one. */
  decision: BankInboxDecision | null;
  /** Only for an `open` line. */
  proposal: BankLineProposal | null;
  /**
   * D142 (A39 §11): how an OPEN line stands for the person, the one definition the Studio's facets and
   * the Übersicht band share (`attentionOf`). Null on a decided line.
   */
  attention: BankLineAttention | null;
  /** D142: current file versions linked to the line, plus those linked to the entry its decision booked. */
  receiptCount: number;
  /** D142: booked to accounts (`targetKind: 'accounts'`) and no receipt anywhere: the "Ohne Beleg" facet. */
  needsReceipt: boolean;
};

// --- D142: the attention facets and the receipts (A39 §11) --------------------------------------------

/** How an open line stands for the person (§H-ENUM, single point; mirrored by the Studio). */
export const BANK_LINE_ATTENTIONS = ['needs', 'sure', 'learned'] as const;
export type BankLineAttention = (typeof BANK_LINE_ATTENTIONS)[number];

/** The bank-line verbs a pending agent Vorschlag can carry. */
const LINE_VERBS = ['book_bank_line', 'ignore_bank_line', 'reopen_bank_line'] as const;

/** The lines a PENDING agent Vorschlag names (A35's queue): a person decides those, never the pick bar. */
export function vorschlagLineIds(ctx: WorkspaceContext): Set<string> {
  const rows = ctx.store.db
    .prepare(
      `SELECT payload_json FROM agent_action
        WHERE workspace_id = ? AND status = 'pending' AND action_tool IN (${LINE_VERBS.map(() => '?').join(', ')})`,
    )
    .all(ctx.workspaceId, ...LINE_VERBS) as { payload_json: string }[];
  const ids = new Set<string>();
  for (const r of rows) {
    try {
      const payload = JSON.parse(r.payload_json) as { bankTxnId?: unknown };
      if (typeof payload.bankTxnId === 'string' && payload.bankTxnId.length > 0) ids.add(payload.bankTxnId);
    } catch {
      // An unreadable payload names no line.
    }
  }
  return ids;
}

/**
 * Can the proposal's target be booked exactly as it stands? The engine twin of the Studio's `isBookable`:
 * an accounts booking needs at least one leg, an account and a non-zero amount on every leg, and legs
 * summing to the line; an accepted difference needs its reason (critic A39-12).
 */
export function isProposalBookable(absAmountMinor: number, target: BookBankLineTarget | null): boolean {
  if (target === null) return false;
  if (target.kind === 'existing_entry') return target.acceptDifference !== true || (target.differenceReason ?? '').trim() !== '';
  if (target.kind !== 'accounts') return true;
  if (target.legs.length === 0 || target.legs.some((l) => l.accountId === '' || l.amountMinor === 0)) return false;
  return target.legs.reduce((sum, l) => sum + l.amountMinor, 0) === absAmountMinor;
}

/**
 * THE ONE DEFINITION of "needs you" and "sure" (A39 §11): `sure` when the proposal is `sure`, bookable as
 * it stands and no pending Vorschlag names the line (what "Alle sicheren buchen" may send); `learned` when
 * the proposal is `learned` and no Vorschlag names it; `needs` for everything else.
 */
export function attentionOf(proposal: BankLineProposal | null, absAmountMinor: number, hasVorschlag: boolean): BankLineAttention {
  if (hasVorschlag || proposal === null) return 'needs';
  if (proposal.certainty === 'sure') return isProposalBookable(absAmountMinor, proposal.target) ? 'sure' : 'needs';
  if (proposal.certainty === 'learned') return 'learned';
  return 'needs';
}

/**
 * D142 amendment (owner, 28.09.2026): SQL, true when every leg of the booking entry `entryExpr` other than
 * the line's Bankkonto leg sits on an account whose voucher is the bank statement ("Beleg = Kontoauszug").
 * Such a line needs no Beleg of its own; a split with one unflagged leg still does. Tenant-bound through
 * the entry and the account.
 */
export function STATEMENT_COVERS_SQL(entryExpr: string, bankAccountExpr: string, wsExpr: string): string {
  return `(${entryExpr} IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM journal_line sjl
        JOIN journal_entry sje ON sje.id = sjl.entry_id AND sje.workspace_id = ${wsExpr}
        JOIN account sa ON sa.id = sjl.account_id AND sa.workspace_id = ${wsExpr}
        JOIN bank_account sba ON sba.workspace_id = ${wsExpr} AND sba.id = ${bankAccountExpr}
       WHERE sjl.entry_id = ${entryExpr} AND sjl.account_id != sba.ledger_account_id
         AND NOT ${STATEMENT_IS_VOUCHER_SQL('sa')}))`;
}

/** Current file versions linked to the line, plus those linked to the journal entry its decision booked. */
const RECEIPTS_SQL = `SELECT COUNT(*) AS n FROM stored_file f
   WHERE f.workspace_id = ? AND ${IS_HEAD('f')}
     AND ((f.entity_kind = 'bank_txn' AND f.entity_id = ?)
       OR (? IS NOT NULL AND f.entity_kind = 'journal_entry' AND f.entity_id = ?))`;

/** Per Bankkonto (and in total): what the Übersicht band counts, from the inbox's own definitions. */
export interface BankInboxAttentionCounts {
  open: number;
  needs: number;
  sure: number;
  learned: number;
  noReceipt: number;
  /** The open lines' money in and money out, each a positive sum in the account's currency. */
  inMinor: number;
  outMinor: number;
  /**
   * D150: of the `needs` lines, those a pending Vorschlag already names. The hub counts those in
   * `agent_action`, so `bank_lines_waiting` subtracts them and no line is counted twice.
   */
  vorschlag: number;
  /** D150: the earliest booking (else value) date among the `needs` lines not named by a Vorschlag, or null. */
  oldestWaiting: string | null;
}

/**
 * D142: the band's counts, by the SAME rules the inbox lines carry (`attentionOf`, `needsReceipt`), over
 * EVERY open line rather than a page, per Bankkonto and in total. `bankAccountId` narrows to one account.
 */
export function bankInboxAttention(
  ctx: WorkspaceContext,
  input: { bankAccountId?: string } = {},
): { total: BankInboxAttentionCounts; byAccount: Map<string, BankInboxAttentionCounts> } {
  const zero = (): BankInboxAttentionCounts => ({ open: 0, needs: 0, sure: 0, learned: 0, noReceipt: 0, inMinor: 0, outMinor: 0, vorschlag: 0, oldestWaiting: null });
  const total = zero();
  const byAccount = new Map<string, BankInboxAttentionCounts>();
  const bucket = (id: string): BankInboxAttentionCounts => {
    let b = byAccount.get(id);
    if (b === undefined) {
      b = zero();
      byAccount.set(id, b);
    }
    return b;
  };
  const scope = input.bankAccountId !== undefined ? 'AND t.bank_account_id = ?' : '';
  const params = input.bankAccountId !== undefined ? [ctx.workspaceId, input.bankAccountId] : [ctx.workspaceId];
  const open = ctx.store.db
    .prepare(
      `SELECT t.*, d2.counterparty_name, d2.counterparty_iban, d2.remittance_text, d2.end_to_end_id
         FROM bank_txn t ${LINE_STATE_JOINS('t')}
         LEFT JOIN bank_txn_detail d2 ON d2.workspace_id = t.workspace_id AND d2.bank_txn_id = t.id
        WHERE t.workspace_id = ? ${scope} AND ${LINE_STATE_EXPR('t')} = 'open'`,
    )
    .all(...params) as (BankTxnRow & BankTxnDetailRow)[];
  if (open.length > 0) {
    const pc = proposalContext(ctx);
    const named = vorschlagLineIds(ctx);
    for (const r of open) {
      const detail: BankTxnDetailRow = {
        counterparty_name: r.counterparty_name,
        counterparty_iban: r.counterparty_iban,
        remittance_text: r.remittance_text,
        end_to_end_id: r.end_to_end_id,
      };
      const hasVorschlag = named.has(r.id);
      const attention = attentionOf(proposeForLine(ctx, pc, r, detail), Math.abs(r.amount_minor), hasVorschlag);
      const lineDate = r.booking_date ?? r.value_date ?? null;
      for (const b of [total, bucket(r.bank_account_id)]) {
        b.open += 1;
        b[attention] += 1;
        if (attention === 'needs' && hasVorschlag) b.vorschlag += 1;
        if (attention === 'needs' && !hasVorschlag && lineDate !== null && (b.oldestWaiting === null || lineDate < b.oldestWaiting)) b.oldestWaiting = lineDate;
        if (r.credit_debit === 'CRDT') b.inMinor += r.amount_minor;
        else b.outMinor += r.amount_minor;
      }
    }
  }
  const missing = ctx.store.db
    .prepare(
      `SELECT t.bank_account_id AS a, COUNT(*) AS n
         FROM bank_txn t
         JOIN bank_line_decision d ON d.workspace_id = t.workspace_id AND d.bank_txn_id = t.id AND d.superseded_at IS NULL
        WHERE t.workspace_id = ? ${scope} AND d.state = 'booked' AND d.target_kind = 'accounts'
          AND NOT ${STATEMENT_COVERS_SQL('d.entry_id', 't.bank_account_id', 't.workspace_id')}
          AND NOT EXISTS (
            SELECT 1 FROM stored_file f
             WHERE f.workspace_id = t.workspace_id
               AND ((f.entity_kind = 'bank_txn' AND f.entity_id = t.id)
                 OR (d.entry_id IS NOT NULL AND f.entity_kind = 'journal_entry' AND f.entity_id = d.entry_id)))
        GROUP BY t.bank_account_id`,
    )
    .all(...params) as { a: string; n: number }[];
  for (const m of missing) {
    total.noReceipt += m.n;
    bucket(m.a).noReceipt += m.n;
  }
  return { total, byAccount };
}

/** The balance line of ONE Bankkonto at its latest statement (spec L4): three numbers and their gap. */
export type BankAccountBalance = {
  bankAccountId: string;
  name: string;
  iban: string;
  currency: string;
  ledgerAccountId: string;
  /** False when the bank and the books cannot be compared here; `reason` says why. */
  judgeable: boolean;
  reason: 'no_statement' | 'no_balance' | 'currency_differs' | null;
  statementId: string | null;
  statementDate: string | null;
  bankBalanceMinor: number | null;
  ledgerBalanceMinor: number | null;
  /** The lines still open up to the statement date: how many, and their signed sum. */
  openCount: number;
  openSumMinor: number;
  /** bank - ledger - open: zero when bank and books agree. */
  differenceMinor: number | null;
};

interface AccountRow {
  id: string;
  name: string;
  iban: string;
  currency: string;
  ledger_account_id: string;
  opening_entry_id: string | null;
  archived: number;
}

interface StatementRow {
  id: string;
  to_date: string | null;
  closing_balance_minor: number | null;
  balance_currency: string | null;
  imported_at: string;
}

/** The linked account's balance at `asOf`, in the Bankkonto's own currency (D-A39.6). */
export function ledgerBalanceInAccountCurrency(ctx: WorkspaceContext, account: Pick<AccountRow, 'ledger_account_id' | 'currency'>, asOf: string): number {
  const base = baseCurrencyOf(ctx);
  const sql =
    account.currency === base
      ? `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
           FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
          WHERE e.workspace_id = ? AND e.status = 'posted' AND l.account_id = ? AND e.date <= ?`
      : `SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) AS net
           FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
          WHERE e.workspace_id = ? AND e.status = 'posted' AND l.account_id = ? AND e.date <= ? AND l.currency = ?`;
  const params = account.currency === base ? [ctx.workspaceId, account.ledger_account_id, asOf] : [ctx.workspaceId, account.ledger_account_id, asOf, account.currency];
  return (ctx.store.db.prepare(sql).get(...params) as { net: number }).net;
}

/**
 * The date a line counts on (critic A39-5): its BOOKING date, else its value date. A camt.053 closing
 * balance (CLBD) is a booked balance, so a line booked on the statement's last day and valued the next is
 * inside that balance, and it is in the period it was booked in; the value date is a ranking signal only.
 */
const LINE_DATE = (t: string): string => `COALESCE(${t}.booking_date, ${t}.value_date, substr(${t}.created_at, 1, 10))`;

/** The balance line of ONE account as of `asOf` (default: its latest statement), spec L4. */
export function accountBalance(ctx: WorkspaceContext, account: AccountRow, asOf?: string): BankAccountBalance {
  const shell: BankAccountBalance = {
    bankAccountId: account.id,
    name: account.name,
    iban: account.iban,
    currency: account.currency,
    ledgerAccountId: account.ledger_account_id,
    judgeable: false,
    reason: null,
    statementId: null,
    statementDate: null,
    bankBalanceMinor: null,
    ledgerBalanceMinor: null,
    openCount: 0,
    openSumMinor: 0,
    differenceMinor: null,
  };
  const statements = ctx.store.db
    .prepare(
      `SELECT id, to_date, closing_balance_minor, balance_currency, imported_at FROM bank_statement
        WHERE workspace_id = ? AND bank_account_id = ? AND last_page_ind = 1
          ${asOf !== undefined ? "AND COALESCE(to_date, substr(imported_at, 1, 10)) <= ?" : ''}
        ORDER BY COALESCE(to_date, substr(imported_at, 1, 10)) DESC, imported_at DESC, rowid DESC`,
    )
    .all(...([ctx.workspaceId, account.id, ...(asOf !== undefined ? [asOf] : [])] as string[])) as StatementRow[];
  if (statements.length === 0) return { ...shell, reason: 'no_statement' };
  const stmt = statements.find((s) => s.closing_balance_minor !== null);
  if (stmt === undefined) return { ...shell, reason: 'no_balance' };
  const statementDate = stmt.to_date ?? stmt.imported_at.slice(0, 10);
  if (stmt.balance_currency !== null && stmt.balance_currency !== account.currency) {
    return { ...shell, statementId: stmt.id, statementDate, reason: 'currency_differs' };
  }
  const open = ctx.store.db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN t.credit_debit = 'CRDT' THEN t.amount_minor ELSE -t.amount_minor END), 0) AS s
         FROM bank_txn t ${LINE_STATE_JOINS('t')}
        WHERE t.workspace_id = ? AND t.bank_account_id = ? AND ${LINE_DATE('t')} <= ? AND ${LINE_STATE_EXPR('t')} = 'open'`,
    )
    .get(ctx.workspaceId, account.id, statementDate) as { n: number; s: number };
  const bank = stmt.closing_balance_minor as number;
  const ledger = ledgerBalanceInAccountCurrency(ctx, account, statementDate);
  return {
    ...shell,
    judgeable: true,
    statementId: stmt.id,
    statementDate,
    bankBalanceMinor: bank,
    ledgerBalanceMinor: ledger,
    openCount: open.n,
    openSumMinor: open.s,
    differenceMinor: bank - ledger - open.s,
  };
}

function readAccount(ctx: WorkspaceContext, bankAccountId: string): AccountRow | undefined {
  return ctx.store.db
    .prepare('SELECT id, name, iban, currency, ledger_account_id, opening_entry_id, archived FROM bank_account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, bankAccountId) as AccountRow | undefined;
}

// --- list_bank_inbox -----------------------------------------------------------------------------

export const BANK_INBOX_STATUS_FILTERS = [...BANK_LINE_STATES, 'all'] as const;
export const BANK_INBOX_DEFAULT_LIMIT = 50;
export const BANK_INBOX_MAX_LIMIT = 200;

export interface ListBankInboxInput {
  bankAccountId?: string;
  /** ONE line by its id, in any state with `status: 'all'` (a deep link to a line beyond the first page). */
  bankTxnId?: string;
  status?: string;
  query?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
  savedViewId?: string;
}

export type ListBankInboxOk = {
  lines: BankInboxLine[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
  /** Lines matching the filter across every page. */
  total: number;
  /** Per Bankkonto in scope: the balance line (spec L4). */
  summary: BankAccountBalance[];
};

function encodeCursor(date: string, rowid: number): string {
  return Buffer.from(JSON.stringify([date, rowid]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { date: string; rowid: number } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && Number.isSafeInteger(parsed[1])) {
      return { date: parsed[0], rowid: parsed[1] as number };
    }
  } catch {
    return null;
  }
  return null;
}

/** "89.90", "89,90" or "8990"-style text read as an amount in Rappen, for the amount half of `query`. */
function amountOfQuery(q: string): number | null {
  const m = /^\s*(\d{1,12})(?:[.,](\d{1,2}))?\s*$/.exec(q.replace(/'/g, ''));
  if (m === null) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

interface InboxRow extends BankTxnRow, BankTxnDetailRow {
  line_state: BankLineState;
  sort_date: string;
  rid: number;
}

/**
 * The inbox (spec §2): lines across ALL statements, newest first, one state each; an open line with its
 * proposal, a decided one with its decision. Default state filter `open`, the owner's "bank lines listed
 * separately, ready to book".
 */
export function listBankInbox(ctx: WorkspaceContext, input: ListBankInboxInput = {}): Result<ListBankInboxOk> {
  const guard =
    optionalId(input.bankAccountId, 'bankAccountId') ??
    optionalId(input.bankTxnId, 'bankTxnId') ??
    optionalText(input.status, 'status') ??
    optionalText(input.query, 'query') ??
    optionalDate(input.from, 'from') ??
    optionalDate(input.to, 'to') ??
    optionalId(input.cursor, 'cursor') ??
    optionalId(input.savedViewId, 'savedViewId');
  if (guard) return guard;
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1)) {
    return err('invalid_input', { field: 'limit', reason: 'a positive integer' });
  }
  const viewed = applySavedView(ctx, 'bank_txn', input);
  if (!viewed.ok) return viewed;
  const filter = viewed.filter;
  const status = filter.status ?? 'open';
  if (!(BANK_INBOX_STATUS_FILTERS as readonly string[]).includes(status)) {
    return err('invalid_input', { field: 'status', allowed: [...BANK_INBOX_STATUS_FILTERS] });
  }
  const limit = Math.min(filter.limit ?? BANK_INBOX_DEFAULT_LIMIT, BANK_INBOX_MAX_LIMIT);
  let cursor: { date: string; rowid: number } | null = null;
  if (filter.cursor !== undefined) {
    cursor = decodeCursor(filter.cursor);
    if (cursor === null) return err('invalid_input', { field: 'cursor' });
  }
  if (filter.bankAccountId !== undefined && readAccount(ctx, filter.bankAccountId) === undefined) {
    return err('not_found', { bankAccountId: filter.bankAccountId });
  }

  const clauses = ['t.workspace_id = ?'];
  const params: (string | number)[] = [ctx.workspaceId];
  if (filter.bankAccountId !== undefined) {
    clauses.push('t.bank_account_id = ?');
    params.push(filter.bankAccountId);
  }
  // Critic M4 (lean): a deep link names one line that may sit beyond the loaded page.
  if (input.bankTxnId !== undefined) {
    clauses.push('t.id = ?');
    params.push(input.bankTxnId);
  }
  if (filter.from !== undefined) {
    clauses.push(`${LINE_DATE('t')} >= ?`);
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    clauses.push(`${LINE_DATE('t')} <= ?`);
    params.push(filter.to);
  }
  if (status !== 'all') {
    clauses.push(`${LINE_STATE_EXPR('t')} = ?`);
    params.push(status);
  }
  const q = typeof filter.query === 'string' ? filter.query.trim() : '';
  if (q.length > 0) {
    const like = `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const amount = amountOfQuery(q);
    const fields = ['t.payer_name', 'd2.counterparty_name', 'd2.remittance_text', 't.reference_value', 't.entry_ref', 'd2.counterparty_iban'];
    const text = fields.map((f) => `lower(COALESCE(${f}, '')) LIKE ? ESCAPE '\\'`).join(' OR ');
    clauses.push(`(${text}${amount !== null ? ' OR t.amount_minor = ?' : ''})`);
    for (let i = 0; i < fields.length; i += 1) params.push(like);
    if (amount !== null) params.push(amount);
  }
  const from = `FROM bank_txn t ${LINE_STATE_JOINS('t')}
      LEFT JOIN bank_txn_detail d2 ON d2.workspace_id = t.workspace_id AND d2.bank_txn_id = t.id`;
  const where = clauses.join(' AND ');
  const total = (ctx.store.db.prepare(`SELECT COUNT(*) AS n ${from} WHERE ${where}`).get(...params) as { n: number }).n;
  const pageClauses = [...clauses];
  const pageParams = [...params];
  if (cursor !== null) {
    pageClauses.push(`(${LINE_DATE('t')} < ? OR (${LINE_DATE('t')} = ? AND t.rowid < ?))`);
    pageParams.push(cursor.date, cursor.date, cursor.rowid);
  }
  const rows = ctx.store.db
    .prepare(
      `SELECT t.*, ${LINE_STATE_EXPR('t')} AS line_state,
              ${LINE_DATE('t')} AS sort_date, t.rowid AS rid,
              d2.counterparty_name, d2.counterparty_iban, d2.remittance_text, d2.end_to_end_id
         ${from}
        WHERE ${pageClauses.join(' AND ')}
        ORDER BY sort_date DESC, t.rowid DESC
        LIMIT ?`,
    )
    .all(...pageParams, limit + 1) as InboxRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last !== undefined ? encodeCursor(last.sort_date, last.rid) : null;

  const pc = page.some((r) => r.line_state === 'open') ? proposalContext(ctx) : null;
  const named = pc !== null ? vorschlagLineIds(ctx) : new Set<string>();
  const receiptsOf = ctx.store.db.prepare(RECEIPTS_SQL);
  const statementCovers = ctx.store.db.prepare(
    `SELECT ${STATEMENT_COVERS_SQL('@entry', '@bank', '@ws')} AS covered`,
  );
  const decisions = new Map<string, BankInboxDecision>();
  for (const r of page) {
    if (r.line_state === 'open') continue;
    const link = readActiveLink(ctx, r.id);
    if (link === undefined) continue;
    decisions.set(r.id, {
      linkId: link.linkId,
      targetKind: link.targetKind,
      entryId: link.entryId,
      paymentId: link.paymentId,
      ignoreReason: link.ignoreReason,
      note: link.note,
      remainderMode: link.remainderMode,
      remainderMinor: link.remainderMinor,
      differenceMinor: link.differenceMinor,
      decidedBy: link.createdBy,
      decidedAt: link.createdAt,
    });
  }

  const lines: BankInboxLine[] = page.map((r) => {
    const decision = decisions.get(r.id);
    const detail: BankTxnDetailRow = {
      counterparty_name: r.counterparty_name,
      counterparty_iban: r.counterparty_iban,
      remittance_text: r.remittance_text,
      end_to_end_id: r.end_to_end_id,
    };
    const proposal = r.line_state === 'open' && pc !== null ? proposeForLine(ctx, pc, r, detail) : null;
    const entryId = decision?.entryId ?? null;
    const receiptCount = (receiptsOf.get(ctx.workspaceId, r.id, entryId, entryId) as { n: number }).n;
    return {
      bankTxnId: r.id,
      bankAccountId: r.bank_account_id,
      statementId: r.statement_id,
      state: r.line_state,
      bookingDate: r.booking_date,
      valueDate: r.value_date,
      amountMinor: signedAmountOf(r),
      currency: r.currency,
      creditDebit: r.credit_debit,
      reversal: r.reversal_ind === 1,
      counterparty: { name: r.counterparty_name ?? r.payer_name, iban: r.counterparty_iban },
      remittance: {
        text: r.remittance_text,
        referenceKind: r.reference_kind,
        referenceValue: r.reference_value,
        endToEndId: r.end_to_end_id,
      },
      entryRef: r.entry_ref,
      creditId: r.credit_id,
      decision: decision ?? null,
      proposal,
      attention: r.line_state === 'open' ? attentionOf(proposal, Math.abs(r.amount_minor), named.has(r.id)) : null,
      receiptCount,
      needsReceipt:
        r.line_state === 'booked' &&
        decision?.targetKind === 'accounts' &&
        receiptCount === 0 &&
        (statementCovers.get({ entry: entryId, bank: r.bank_account_id, ws: ctx.workspaceId }) as { covered: number }).covered !== 1,
    };
  });

  const accounts =
    filter.bankAccountId !== undefined
      ? [readAccount(ctx, filter.bankAccountId) as AccountRow]
      : (ctx.store.db
          .prepare('SELECT id, name, iban, currency, ledger_account_id, opening_entry_id, archived FROM bank_account WHERE workspace_id = ? AND archived = 0 ORDER BY name, rowid')
          .all(ctx.workspaceId) as AccountRow[]);
  const summary = accounts.map((a) => accountBalance(ctx, a, filter.to));
  return ok<ListBankInboxOk>({ lines, nextCursor, total, summary });
}

// --- G22 `bank_reconciled` (spec §4.5, D139) ----------------------------------------------------------

export type BankReconciledAccount = {
  bankAccountId: string;
  name: string;
  /**
   * `not_started` (D139): the account has no camt.053, or the period ends before its FIRST statement
   * opens; it passes, whatever the ledger holds earlier. `not_covered`: no statement reaches the period
   * end and no later one opens where the last closed (fails, `action: 'import_camt'`). `open_lines`: a
   * line booked in the period, or a hand-typed A21 credit of it, is still open (fails). `difference`:
   * the bank balance at the period end differs from the ledger balance that day (fails). `reconciled`.
   */
  status: 'reconciled' | 'difference' | 'open_lines' | 'not_covered' | 'not_started';
  statementId: string | null;
  /** The closing date of the statement the judgment rests on. */
  statementDate: string | null;
  /** The date the bank and the books were compared at: the period end when judged, else null. */
  judgedAt: string | null;
  /** The action that clears a failing row (`import_camt` when a statement is missing), else null. */
  action: 'import_camt' | null;
  /** Open lines booked in the period plus open hand-typed credits of the period. */
  openLines: number;
  bankBalanceMinor: number | null;
  ledgerBalanceMinor: number | null;
  differenceMinor: number | null;
  reason: string | null;
};

export type BankReconciledResult = {
  passed: boolean;
  /** Failing accounts plus open lines and credits: the number behind a failing check. */
  count: number;
  accounts: BankReconciledAccount[];
  openLines: number;
  openCredits: number;
};

interface CoverageStatement {
  id: string;
  statement_id: string;
  electronic_seq_nb: string | null;
  from_date: string | null;
  to_date: string;
  opening_balance_minor: number | null;
  closing_balance_minor: number | null;
  balance_currency: string | null;
}

/**
 * Where statement coverage begins (D139): the FIRST camt.053's opening day, else null (no statement at
 * all). Nothing else: postings before it are books a statement never vouched for, and do not fail.
 */
function accountStartOf(ctx: WorkspaceContext, account: AccountRow): string | null {
  const first = ctx.store.db
    .prepare(
      `SELECT MIN(COALESCE(from_date, to_date)) AS d FROM bank_statement
        WHERE workspace_id = ? AND bank_account_id = ? AND message_type = 'camt053' AND COALESCE(from_date, to_date) IS NOT NULL`,
    )
    .get(ctx.workspaceId, account.id) as { d: string | null };
  return first.d;
}

/**
 * The bank balance at the END of `day` (critic A39-10), from the statements: a statement COVERING the
 * day gives its closing balance less the lines it books after the day (a camt.053 closing balance is a
 * booked balance, so the booking date decides); a day in a gap between two statements is judged when the
 * next statement opens exactly where the previous one closed (nothing was booked in the gap). Otherwise
 * the coverage ends before the day (`gap`) or there is no statement at all (`none`).
 */
function bankBalanceAt(
  ctx: WorkspaceContext,
  account: AccountRow,
  day: string,
): { kind: 'covered'; statement: CoverageStatement; balanceMinor: number } | { kind: 'gap'; statement: CoverageStatement } | { kind: 'none' } {
  const cols = 'id, statement_id, electronic_seq_nb, from_date, to_date, opening_balance_minor, closing_balance_minor, balance_currency';
  const covering = ctx.store.db
    .prepare(
      `SELECT ${cols} FROM bank_statement
        WHERE workspace_id = ? AND bank_account_id = ? AND last_page_ind = 1 AND closing_balance_minor IS NOT NULL
          AND to_date IS NOT NULL AND to_date >= ? AND COALESCE(from_date, to_date) <= ?
        ORDER BY to_date ASC, imported_at DESC, rowid DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, account.id, day, day) as CoverageStatement | undefined;
  if (covering !== undefined) {
    const later = ctx.store.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN t.credit_debit = 'CRDT' THEN t.amount_minor ELSE -t.amount_minor END), 0) AS s
           FROM bank_txn t
          WHERE t.workspace_id = ? AND t.bank_account_id = ? AND ${LINE_DATE('t')} > ?
            AND t.statement_id IN (SELECT p.id FROM bank_statement p
                                    WHERE p.workspace_id = ? AND p.bank_account_id = ? AND p.statement_id = ?
                                      AND COALESCE(p.electronic_seq_nb, '') = COALESCE(?, ''))`,
      )
      .get(ctx.workspaceId, account.id, day, ctx.workspaceId, account.id, covering.statement_id, covering.electronic_seq_nb) as { s: number };
    return { kind: 'covered', statement: covering, balanceMinor: (covering.closing_balance_minor as number) - later.s };
  }
  const prev = ctx.store.db
    .prepare(
      `SELECT ${cols} FROM bank_statement
        WHERE workspace_id = ? AND bank_account_id = ? AND last_page_ind = 1 AND closing_balance_minor IS NOT NULL
          AND to_date IS NOT NULL AND to_date < ?
        ORDER BY to_date DESC, imported_at DESC, rowid DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, account.id, day) as CoverageStatement | undefined;
  if (prev === undefined) return { kind: 'none' };
  const next = ctx.store.db
    .prepare(
      `SELECT ${cols} FROM bank_statement
        WHERE workspace_id = ? AND bank_account_id = ? AND opening_balance_minor IS NOT NULL
          AND COALESCE(from_date, to_date) > ?
        ORDER BY COALESCE(from_date, to_date) ASC, imported_at DESC, rowid ASC LIMIT 1`,
    )
    .get(ctx.workspaceId, account.id, day) as CoverageStatement | undefined;
  if (next !== undefined && next.opening_balance_minor === prev.closing_balance_minor) {
    return { kind: 'covered', statement: prev, balanceMinor: prev.closing_balance_minor as number };
  }
  return { kind: 'gap', statement: prev };
}

/**
 * "Bank abgestimmt" for a period (spec §4.5, D139). Every non-archived Bankkonto is judged at the period
 * END: `not_started` before its first camt.053 (or with none), else its bank balance at that day, from a
 * statement covering it (or a gap the next statement proves empty), must equal the linked account's
 * ledger balance that day, and no line booked inside the period, nor a hand-typed A21 credit of it, may
 * still be open. Lines are counted by their OWN booking date only, so an old line stranded in a filed
 * quarter never fails every later period again (walk B17.3).
 */
export function bankReconciledForPeriod(ctx: WorkspaceContext, periodStart: string, periodEnd: string): BankReconciledResult {
  const accounts = ctx.store.db
    .prepare('SELECT id, name, iban, currency, ledger_account_id, opening_entry_id, archived FROM bank_account WHERE workspace_id = ? AND archived = 0 ORDER BY name, rowid')
    .all(ctx.workspaceId) as AccountRow[];
  const openLinesOf = ctx.store.db.prepare(
    `SELECT COUNT(*) AS n FROM bank_txn t ${LINE_STATE_JOINS('t')}
      WHERE t.workspace_id = ? AND t.bank_account_id = ?
        AND ${LINE_DATE('t')} >= ? AND ${LINE_DATE('t')} <= ? AND ${LINE_STATE_EXPR('t')} = 'open'`,
  );
  // A hand-typed A21 credit: no bank line carries it (spec L2: a camt credit is known by `bank_txn.credit_id`
  // or a non-null `reconciliation_match.bank_txn_id`).
  const openCreditsOf = ctx.store.db.prepare(
    `SELECT COUNT(*) AS n FROM reconciliation_match m
      WHERE m.workspace_id = ? AND m.bank_account_id = ? AND m.status = 'open' AND m.bank_txn_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM bank_txn t WHERE t.workspace_id = m.workspace_id AND t.credit_id = m.id)
        AND m.value_date >= ? AND m.value_date <= ?`,
  );
  const result: BankReconciledAccount[] = [];
  let openLines = 0;
  let openCredits = 0;
  for (const a of accounts) {
    const base: BankReconciledAccount = {
      bankAccountId: a.id,
      name: a.name,
      status: 'not_started',
      statementId: null,
      statementDate: null,
      judgedAt: null,
      action: null,
      openLines: 0,
      bankBalanceMinor: null,
      ledgerBalanceMinor: null,
      differenceMinor: null,
      reason: null,
    };
    const start = accountStartOf(ctx, a);
    if (start === null || periodEnd < start) {
      result.push({ ...base, reason: start === null ? 'no_statement' : 'period_before_first_statement' });
      continue;
    }
    const covered = bankBalanceAt(ctx, a, periodEnd);
    if (covered.kind !== 'covered') {
      result.push({
        ...base,
        status: 'not_covered',
        statementId: covered.kind === 'gap' ? covered.statement.id : null,
        statementDate: covered.kind === 'gap' ? covered.statement.to_date : null,
        reason: 'statement_missing_for_period_end',
        action: 'import_camt',
      });
      continue;
    }
    const stmt = covered.statement;
    const lines = (openLinesOf.get(ctx.workspaceId, a.id, periodStart, periodEnd) as { n: number }).n;
    const credits = (openCreditsOf.get(ctx.workspaceId, a.id, periodStart, periodEnd) as { n: number }).n;
    openLines += lines;
    openCredits += credits;
    const ledger = ledgerBalanceInAccountCurrency(ctx, a, periodEnd);
    const currencyDiffers = stmt.balance_currency !== null && stmt.balance_currency !== a.currency;
    const difference = currencyDiffers ? null : covered.balanceMinor - ledger;
    const judged = {
      ...base,
      statementId: stmt.id,
      statementDate: stmt.to_date,
      judgedAt: periodEnd,
      openLines: lines + credits,
      bankBalanceMinor: covered.balanceMinor,
      ledgerBalanceMinor: ledger,
      differenceMinor: difference,
    };
    if (lines + credits > 0) result.push({ ...judged, status: 'open_lines' });
    else if (difference !== 0) result.push({ ...judged, status: 'difference', ...(currencyDiffers ? { reason: 'currency_differs' } : {}) });
    else result.push({ ...judged, status: 'reconciled' });
  }
  const failing = result.filter((r) => r.status !== 'reconciled' && r.status !== 'not_started' && r.status !== 'open_lines').length;
  return {
    passed: result.every((r) => r.status === 'reconciled' || r.status === 'not_started'),
    count: failing + openLines + openCredits,
    accounts: result,
    openLines,
    openCredits,
  };
}
