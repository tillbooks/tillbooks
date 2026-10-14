/**
 * A39, the bank line's ONE state (spec §0 items 1 to 3, §4.2): the enumerations, the state predicate,
 * the one link writer and the one supersession.
 *
 * WHY THIS FILE IS THE ONLY WRITER OF `bank_txn_link`. Before A39 three places inserted a link
 * (`confirmCamtMatch`, `createEntryForTxn`, `markBatchPaid`) and none could ever take one back, so a
 * reversed booking stayed "Zugeordnet" forever (walk B11.2). Every decision on a line now goes through
 * `writeLineLink`, which writes the link AND its `bank_line_decision` row in the caller's transaction,
 * and every correction goes through `supersedeActiveLink`, which stamps the decision and never deletes
 * anything. The storage guards in `bankInboxSchema.ts` hold the same rules for any future writer.
 *
 * THE STATE IS DERIVED, IN ONE PLACE, FOR BOTH FACES. `lineStateOf` answers it for one line in code,
 * `LINE_STATE_JOINS`/`LINE_STATE_EXPR` answer it in SQL for a page of lines (the inbox, the statement
 * list, the board, A25's review packet and G22's check all use this fragment, so no two counts can
 * disagree about one line: the B10.2 / G22 disagreement was exactly two predicates over the same row).
 * A line is `open` without a live decision, else the decision's `state`. There is no stale branch (spec
 * L3): an entry a live decision holds cannot be reversed by any other verb (`reverseEntry.ts` refuses
 * `owned_by reopen_bank_line`), so a live decision never points at money that is gone.
 *
 * §H-TENANT: every statement here binds `workspace_id`.
 */

import type { WorkspaceContext } from '../context.js';
import { err } from '../result.js';
import type { Err } from '../result.js';
import { resolveRole, isRejection } from '../payments/accounts.js';
import { deriveStatutoryOnPost } from '../files/postedFloor.js';
import type { CamtClassification, CamtCreditDebit } from './camt.js';

/**
 * A refusal found INSIDE a memoised write, thrown so nothing commits and nothing is memoised, and unwrapped
 * by every runner that writes a bank-line decision (`runBankGuarded` here and in `bankBooking.ts`, the A21
 * and A18 runners). The one writer throws it for every claim rule, so no storage error reaches a caller.
 */
export class BankAbort {
  constructor(public readonly result: Err) {}
}

// --- The closed enumerations (§H-ENUM, single point) ---------------------------------------------

export const BANK_LINE_STATES = ['open', 'booked', 'matched', 'ignored'] as const;
export type BankLineState = (typeof BANK_LINE_STATES)[number];

/** Why a line was ignored (owner answer 1). The balance comparison is the arbiter, not the count. */
export const BANK_LINE_IGNORE_REASONS = [
  'booked_elsewhere',
  'clearing_account',
  'before_start',
  'duplicate',
  'other',
] as const;
export type BankLineIgnoreReason = (typeof BANK_LINE_IGNORE_REASONS)[number];

/** What a decision was (the `target_kind` of `bank_line_decision`). */
export const BANK_LINE_TARGET_KINDS = [
  'open_item',
  'payment_batch',
  'existing_entry',
  'accounts',
  'ignore',
  'legacy',
] as const;
export type BankLineTargetKind = (typeof BANK_LINE_TARGET_KINDS)[number];

/** The link row's own `kind` vocabulary (A20's three plus A39's `ignored`). */
export type BankLinkKind = 'payment' | 'journal_entry' | 'payment_batch' | 'ignored';

// --- Row shapes -----------------------------------------------------------------------------------

export interface BankTxnRow {
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

export interface BankTxnDetailRow {
  counterparty_name: string | null;
  counterparty_iban: string | null;
  remittance_text: string | null;
  end_to_end_id: string | null;
}

/** The line's active link, whichever era wrote it. */
export interface ActiveLink {
  linkId: string;
  kind: BankLinkKind;
  targetId: string;
  /** True for a link written before A39 (no decision row). */
  legacy: boolean;
  state: Exclude<BankLineState, 'open'>;
  targetKind: BankLineTargetKind;
  entryId: string | null;
  paymentId: string | null;
  journalLineId: string | null;
  ignoreReason: string | null;
  note: string | null;
  remainderMode: string | null;
  remainderMinor: number | null;
  acceptDifference: boolean;
  differenceMinor: number | null;
  createdBy: string | null;
  createdAt: string;
}

/** A line's state and, when it is decided, the decision behind it. */
export interface LineState {
  state: BankLineState;
  /** The live decision: null exactly when the line is `open`. */
  link: ActiveLink | null;
  /** The A21 queue row's status for a credit, when there is one. */
  creditStatus: string | null;
}

// --- Small readers ----------------------------------------------------------------------------------

export function readBankTxn(ctx: WorkspaceContext, bankTxnId: string): BankTxnRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM bank_txn WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, bankTxnId) as BankTxnRow | undefined;
}

export function readBankTxnDetail(ctx: WorkspaceContext, bankTxnId: string): BankTxnDetailRow | undefined {
  return ctx.store.db
    .prepare(
      'SELECT counterparty_name, counterparty_iban, remittance_text, end_to_end_id FROM bank_txn_detail WHERE workspace_id = ? AND bank_txn_id = ?',
    )
    .get(ctx.workspaceId, bankTxnId) as BankTxnDetailRow | undefined;
}

/** The line's SIGNED amount: money in is positive, money out negative (the ledger's debit sign on a bank asset). */
export function signedAmountOf(row: Pick<BankTxnRow, 'amount_minor' | 'credit_debit'>): number {
  return row.credit_debit === 'CRDT' ? row.amount_minor : -row.amount_minor;
}

/** The date a line is booked on (the booking date, else the value date). */
export function lineBookingDate(row: Pick<BankTxnRow, 'booking_date' | 'value_date' | 'created_at'>): string {
  return row.booking_date ?? row.value_date ?? row.created_at.slice(0, 10);
}

/**
 * The line's value date (else its booking date). A RANKING signal only (A36's proximity window): every
 * booking, settlement, balance figure and G22 count uses `lineBookingDate` (critic A39-5).
 */
export function lineValueDate(row: Pick<BankTxnRow, 'booking_date' | 'value_date' | 'created_at'>): string {
  return row.value_date ?? row.booking_date ?? row.created_at.slice(0, 10);
}

interface ActiveRow {
  id: string;
  kind: BankLinkKind;
  created_by: string | null;
  created_at: string;
  state: string;
  target_kind: string;
  entry_id: string | null;
  payment_id: string | null;
  journal_line_id: string | null;
  ignore_reason: string | null;
  note: string | null;
  remainder_mode: string | null;
  remainder_minor: number | null;
  accept_difference: number;
  difference_minor: number | null;
}

/**
 * The line's ACTIVE decision: the one decision row not stamped superseded (the partial unique index
 * allows at most one). ONE CLAIM MODEL, NO LEGACY READ PATH (critic A39R2-1): a link without a decision
 * row is inert (generation 8 adopted every pre-A39 link once, spec L1), and nothing here reads a link's
 * `target_id`, a column G04's restore cannot remap (spec C7).
 */
const ACTIVE_LINK_SQL = `
  SELECT l.id, l.kind, l.created_by, l.created_at,
         d.state, d.target_kind, d.entry_id, d.payment_id, d.journal_line_id,
         d.ignore_reason, d.note, d.remainder_mode, d.remainder_minor, d.accept_difference,
         d.difference_minor
    FROM bank_line_decision d
    JOIN bank_txn_link l ON l.id = d.link_id
   WHERE d.workspace_id = ? AND d.bank_txn_id = ? AND d.superseded_at IS NULL
   LIMIT 1`;

/** The line's ACTIVE link, or undefined when the line has none. */
export function readActiveLink(ctx: WorkspaceContext, bankTxnId: string): ActiveLink | undefined {
  const row = ctx.store.db.prepare(ACTIVE_LINK_SQL).get(ctx.workspaceId, bankTxnId) as ActiveRow | undefined;
  if (row === undefined) return undefined;
  // What the decision names, from DECLARED references only (critic A39R2-1): a run's id is read through
  // its claimed payments, never from the link's `target_id`, which a restore leaves pointing elsewhere.
  const batchId =
    row.kind === 'payment_batch'
      ? ((
          ctx.store.db
            .prepare(
              `SELECT i.batch_id AS b FROM bank_line_claim c
                 JOIN payment p ON p.workspace_id = c.workspace_id AND p.journal_entry_id = c.entry_id
                 JOIN payment_batch_item i ON i.workspace_id = p.workspace_id AND i.posted_payment_id = p.id
                WHERE c.workspace_id = ? AND c.link_id = ? LIMIT 1`,
            )
            .get(ctx.workspaceId, row.id) as { b: string } | undefined
        )?.b ?? null)
      : null;
  return {
    linkId: row.id,
    kind: row.kind,
    targetId: batchId ?? row.entry_id ?? row.payment_id ?? row.ignore_reason ?? '',
    legacy: row.target_kind === 'legacy',
    state: row.state as ActiveLink['state'],
    targetKind: row.target_kind as BankLineTargetKind,
    entryId: row.entry_id,
    paymentId: row.payment_id,
    journalLineId: row.journal_line_id,
    ignoreReason: row.ignore_reason,
    note: row.note,
    remainderMode: row.remainder_mode,
    remainderMinor: row.remainder_minor,
    acceptDifference: row.accept_difference === 1,
    differenceMinor: row.difference_minor,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function creditRowStatus(ctx: WorkspaceContext, creditId: string | null): string | null {
  if (creditId === null) return null;
  const row = ctx.store.db
    .prepare('SELECT status FROM reconciliation_match WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, creditId) as { status: string } | undefined;
  return row?.status ?? null;
}

/**
 * SQL: the entry `entryExpr` (of workspace `wsExpr`) has a POSTED reversal. One definition for the
 * existing-entry guard, the proposals and the transfer guard: an entry with a Storno backs no line, and
 * neither does the Storno itself (`reverses_entry_id` set).
 */
export function HAS_REVERSAL_SQL(entryExpr: string, wsExpr: string): string {
  return `EXISTS (SELECT 1 FROM journal_entry rv WHERE rv.workspace_id = ${wsExpr} AND rv.reverses_entry_id = ${entryExpr} AND rv.status = 'posted')`;
}

/** The posted reversal of `entryId`, or null when it has none. */
export function reversalOf(ctx: WorkspaceContext, entryId: string | null): string | null {
  if (entryId === null) return null;
  const row = ctx.store.db
    .prepare("SELECT id FROM journal_entry WHERE workspace_id = ? AND reverses_entry_id = ? AND status = 'posted' ORDER BY rowid LIMIT 1")
    .get(ctx.workspaceId, entryId) as { id: string } | undefined;
  return row?.id ?? null;
}

/** Whether `entryId` has a posted reversal (spec §4.6: `entryIsReversed` is exactly that). */
export function entryIsReversed(ctx: WorkspaceContext, entryId: string | null): boolean {
  return reversalOf(ctx, entryId) !== null;
}

/** The line's one state (spec §4.2), the code twin of `LINE_STATE_EXPR`. */
export function lineStateOf(ctx: WorkspaceContext, row: BankTxnRow): LineState {
  const creditStatus = creditRowStatus(ctx, row.credit_id);
  const link = readActiveLink(ctx, row.id);
  if (link === undefined) return { state: 'open', link: null, creditStatus };
  return { state: link.state, link, creditStatus };
}

/**
 * The SQL twin of `lineStateOf`, for a page of lines under alias `t` (a `bank_txn`). Append
 * `LINE_STATE_JOINS(t)` to the FROM clause and select `LINE_STATE_EXPR(t)`. The decision join yields at
 * most one row per line because the partial unique index allows at most one active decision.
 */
export function LINE_STATE_JOINS(t: string): string {
  return `
    LEFT JOIN bank_line_decision ad_${t} ON ad_${t}.workspace_id = ${t}.workspace_id AND ad_${t}.bank_txn_id = ${t}.id
          AND ad_${t}.superseded_at IS NULL`;
}

export function LINE_STATE_EXPR(t: string): string {
  return `(CASE WHEN ad_${t}.link_id IS NULL THEN 'open' ELSE ad_${t}.state END)`;
}

// --- The one writer and the one supersession ----------------------------------------------------------

export interface WriteLineLinkInput {
  bankTxnId: string;
  kind: BankLinkKind;
  targetId: string;
  state: Exclude<BankLineState, 'open'>;
  targetKind: BankLineTargetKind;
  entryId?: string | null;
  paymentId?: string | null;
  journalLineId?: string | null;
  ignoreReason?: string | null;
  note?: string | null;
  remainderMode?: string | null;
  remainderMinor?: number | null;
  acceptDifference?: boolean;
  differenceMinor?: number | null;
  /**
   * The bank legs (`journal_line` ids on the Bankkonto's ledger account) this decision accounts for
   * (critic A39-1/A39-2). Every booked or matched decision claims at least one; an ignore claims none.
   */
  claims?: readonly string[];
}

/**
 * Record a decision on a line: ONE link row, its decision row and one claim row per bank leg it accounts
 * for, in the caller's transaction. THE CLAIM RULES LIVE HERE, AT THE ONE WRITER (critic A39R2-4, A39R2-6,
 * A39R2-8: every writer used to check its own subset), and each refuses with a typed `BankAbort`, never a
 * storage error:
 *   - the line has no live decision (`line_not_open`);
 *   - every claimed leg is a posted journal line of THIS workspace on THIS line's Bankkonto ledger
 *     (`claim_off_account`: a run funded by another account's line cannot claim the run's legs);
 *   - no claimed leg is held by another live decision (`entry_already_linked`, naming the holder), which
 *     is exactly what the partial unique index enforces underneath;
 *   - a booked or matched decision claims at least one leg, and its legs sum to the line's signed amount
 *     less the recorded accepted difference (`amount_mismatch`).
 */
export function writeLineLink(ctx: WorkspaceContext, input: WriteLineLinkInput): string {
  const row = readBankTxn(ctx, input.bankTxnId);
  if (row === undefined) throw new BankAbort(err('not_found', { bankTxnId: input.bankTxnId }));
  const active = readActiveLink(ctx, input.bankTxnId);
  if (active !== undefined) {
    throw new BankAbort(
      err('line_not_open', { bankTxnId: row.id, state: active.state, linkId: active.linkId, targetKind: active.targetKind, staleProposal: true }),
    );
  }
  const legs = validateClaims(ctx, row, input);
  const now = ctx.clock.now();
  const linkId = ctx.ids.next('btlk');
  ctx.store.db
    .prepare(
      `INSERT INTO bank_txn_link (id, workspace_id, bank_txn_id, kind, target_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(linkId, ctx.workspaceId, input.bankTxnId, input.kind, input.targetId, ctx.actor, now);
  insertDecision(ctx, linkId, input, now, null);
  const insert = ctx.store.db.prepare(
    `INSERT INTO bank_line_claim (link_id, workspace_id, bank_txn_id, journal_line_id, entry_id, amount_minor, released_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  );
  for (const leg of legs) insert.run(linkId, ctx.workspaceId, input.bankTxnId, leg.lineId, leg.entryId, leg.signedMinor);
  // D142 (A39 §11, OR 958f): the ONE chokepoint every booking and match passes. A Beleg attached to the
  // line while it was open becomes a retained voucher the moment the line is booked or matched, counted
  // from the later of the line's date and its claimed entries' dates, in this same transaction. A Beleg
  // attached afterwards derives in `linkFile`. Nothing here, and nothing on reopen, lowers a floor.
  if (input.state === 'booked' || input.state === 'matched') deriveStatutoryOnPost(ctx, 'bank_txn', input.bankTxnId);
  return linkId;
}

/** The claim rules of `writeLineLink`, answering the validated legs or throwing a typed `BankAbort`. */
function validateClaims(ctx: WorkspaceContext, row: BankTxnRow, input: WriteLineLinkInput): BankLeg[] {
  const ids = [...new Set(input.claims ?? [])];
  const decided = input.state === 'booked' || input.state === 'matched';
  if (!decided) {
    if (ids.length > 0) throw new BankAbort(err('internal_error', { reason: 'an ignore decision claims no leg' }));
    return [];
  }
  if (ids.length === 0) {
    throw new BankAbort(err('amount_mismatch', { bankTxnId: row.id, lineAmountMinor: signedAmountOf(row), claimedMinor: 0, reason: 'a booked or matched line accounts for at least one bank leg' }));
  }
  const ledger = bankLedgerOfLine(ctx, row);
  const read = ctx.store.db.prepare(
    `SELECT jl.id AS lineId, jl.entry_id AS entryId, jl.debit_minor - jl.credit_minor AS signedMinor, jl.currency AS currency,
            jl.account_id AS accountId
       FROM journal_line jl JOIN journal_entry e ON e.id = jl.entry_id
      WHERE e.workspace_id = ? AND e.status = 'posted' AND jl.id = ?`,
  );
  const holder = ctx.store.db.prepare(
    'SELECT bank_txn_id AS txn FROM bank_line_claim WHERE workspace_id = ? AND journal_line_id = ? AND released_at IS NULL',
  );
  const legs: BankLeg[] = [];
  for (const id of ids) {
    const leg = read.get(ctx.workspaceId, id) as (BankLeg & { accountId: string }) | undefined;
    if (leg === undefined || ledger === undefined || leg.accountId !== ledger) {
      throw new BankAbort(err('claim_off_account', { bankTxnId: row.id, journalLineId: id, ledgerAccountId: ledger ?? null, reason: "a line accounts only for legs on its own Bankkonto's ledger account" }));
    }
    const held = holder.get(ctx.workspaceId, id) as { txn: string } | undefined;
    if (held !== undefined) {
      throw new BankAbort(err('entry_already_linked', { entryId: leg.entryId, journalLineId: id, bankTxnId: held.txn }));
    }
    legs.push({ lineId: leg.lineId, entryId: leg.entryId, signedMinor: leg.signedMinor, currency: leg.currency });
  }
  const claimed = legs.reduce((s, l) => s + l.signedMinor, 0);
  const expected = signedAmountOf(row) - (input.differenceMinor ?? 0);
  if (claimed !== expected) {
    throw new BankAbort(err('amount_mismatch', { bankTxnId: row.id, lineAmountMinor: signedAmountOf(row), claimedMinor: claimed, differenceMinor: input.differenceMinor ?? null }));
  }
  return legs;
}

// --- Control accounts (critic A39-11) -----------------------------------------------------------------

/**
 * Whether `accountId` is one of A14's CONTROL accounts, the Debitoren (1100) or Kreditoren (2000)
 * collective account open items settle against. Money booked straight onto one moves a receivable or a
 * payable with no document behind it; the settlement path is `open_item`.
 */
export function controlAccountRoleOf(ctx: WorkspaceContext, accountId: string): 'receivable' | 'payable' | null {
  for (const role of ['receivable', 'payable'] as const) {
    const resolved = resolveRole(ctx, role);
    if (!isRejection(resolved) && resolved.id === accountId) return role;
  }
  return null;
}

// --- Bank legs: what a decision can claim -------------------------------------------------------------

/** The ledger account a line's Bankkonto books on, or undefined for an unregistered account. */
export function bankLedgerOfLine(ctx: WorkspaceContext, row: Pick<BankTxnRow, 'bank_account_id'>): string | undefined {
  const r = ctx.store.db
    .prepare('SELECT ledger_account_id FROM bank_account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, row.bank_account_id) as { ledger_account_id: string } | undefined;
  return r?.ledger_account_id;
}

export interface BankLeg {
  lineId: string;
  entryId: string;
  /** debit - credit, in the leg's own currency. */
  signedMinor: number;
  currency: string;
}

/** The legs of `entryIds` on `ledgerAccountId` (posted entries of this workspace), in insertion order. */
export function bankLegsOf(ctx: WorkspaceContext, ledgerAccountId: string, entryIds: readonly (string | null | undefined)[]): BankLeg[] {
  const ids = [...new Set(entryIds.filter((e): e is string => typeof e === 'string' && e.length > 0))];
  if (ids.length === 0) return [];
  const marks = ids.map(() => '?').join(', ');
  return ctx.store.db
    .prepare(
      `SELECT jl.id AS lineId, jl.entry_id AS entryId, jl.debit_minor - jl.credit_minor AS signedMinor, jl.currency AS currency
         FROM journal_line jl JOIN journal_entry e ON e.id = jl.entry_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND jl.account_id = ? AND jl.entry_id IN (${marks})
        ORDER BY jl.rowid`,
    )
    .all(ctx.workspaceId, ledgerAccountId, ...ids) as BankLeg[];
}

/** The bank-leg ids of `entryIds` on the line's Bankkonto: what a booking or a match claims. */
export function bankLegIdsFor(ctx: WorkspaceContext, row: Pick<BankTxnRow, 'bank_account_id'>, entryIds: readonly (string | null | undefined)[]): string[] {
  const ledger = bankLedgerOfLine(ctx, row);
  return ledger === undefined ? [] : bankLegsOf(ctx, ledger, entryIds).map((l) => l.lineId);
}

function insertDecision(
  ctx: WorkspaceContext,
  linkId: string,
  input: WriteLineLinkInput,
  createdAt: string,
  superseded: { at: string; by: string; reason: string } | null,
): void {
  ctx.store.db
    .prepare(
      `INSERT INTO bank_line_decision
         (link_id, workspace_id, bank_txn_id, state, target_kind, entry_id, payment_id, journal_line_id,
          ignore_reason, note, remainder_mode, remainder_minor, accept_difference, difference_minor,
          created_by, created_at, superseded_at, superseded_by, supersede_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      linkId,
      ctx.workspaceId,
      input.bankTxnId,
      input.state,
      input.targetKind,
      input.entryId ?? null,
      input.paymentId ?? null,
      input.journalLineId ?? null,
      input.ignoreReason ?? null,
      input.note ?? null,
      input.remainderMode ?? null,
      input.remainderMinor ?? null,
      input.acceptDifference === true ? 1 : 0,
      input.differenceMinor ?? null,
      ctx.actor,
      createdAt,
      superseded?.at ?? null,
      superseded?.by ?? null,
      superseded?.reason ?? null,
    );
}

/**
 * Retire the line's active decision (spec §0 item 3): stamp `superseded_at`/`superseded_by`/
 * `supersede_reason`, never delete; its claims are released by the same stamp (trigger). Returns the
 * superseded link, or undefined when the line had none.
 */
export function supersedeActiveLink(ctx: WorkspaceContext, bankTxnId: string, reason: string): ActiveLink | undefined {
  const link = readActiveLink(ctx, bankTxnId);
  if (link === undefined) return undefined;
  ctx.store.db
    .prepare(
      `UPDATE bank_line_decision SET superseded_at = ?, superseded_by = ?, supersede_reason = ?
        WHERE workspace_id = ? AND link_id = ? AND superseded_at IS NULL`,
    )
    .run(ctx.clock.now(), ctx.actor, reason, ctx.workspaceId, link.linkId);
  return link;
}

/** How many decisions this line has had retired: the generation a fresh money key is derived with. */
export function lineGeneration(ctx: WorkspaceContext, bankTxnId: string): number {
  const row = ctx.store.db
    .prepare('SELECT COUNT(*) AS n FROM bank_txn_link WHERE workspace_id = ? AND bank_txn_id = ?')
    .get(ctx.workspaceId, bankTxnId) as { n: number };
  return row.n;
}

// --- Which bank legs the lines already account for (critic A39-1/A39-2, A39R2-1) --------------------

/**
 * The bank LEGS (never whole entries) the live decisions account for, read from ONE place: the claim rows
 * (`bank_line_claim`), in one query (spec §4.6). Every pre-A39 link was adopted into decision and claim
 * rows by generation 8, whose references are declared, so G04's restore remaps them like every other row.
 * The guards and the proposals read it, so nothing is offered or accepted that the partial unique index
 * would refuse (critic A39R2-6).
 */
export interface ClaimedLegs {
  lineIds: Set<string>;
  /** Which bank line holds each claimed leg, for the refusal that names it. */
  holderOf: Map<string, string>;
}

export function claimedLegs(ctx: WorkspaceContext): ClaimedLegs {
  const rows = ctx.store.db
    .prepare('SELECT journal_line_id AS lineId, bank_txn_id AS txn FROM bank_line_claim WHERE workspace_id = ? AND released_at IS NULL')
    .all(ctx.workspaceId) as { lineId: string; txn: string }[];
  const lineIds = new Set<string>();
  const holderOf = new Map<string, string>();
  for (const r of rows) {
    lineIds.add(r.lineId);
    holderOf.set(r.lineId, r.txn);
  }
  return { lineIds, holderOf };
}

// --- The booking target (spec §4.3), shared by `book_bank_line` and the proposals ---------------------

/** What remains of a settlement that did not match the open amount exactly (spec §0.1 D-A39.2). */
export const BANK_LINE_REMAINDER_MODES = ['leave_open', 'write_off', 'on_account'] as const;
export type BankLineRemainderMode = (typeof BANK_LINE_REMAINDER_MODES)[number];

/** One leg of an `accounts` booking. `amountMinor` runs in the LINE's direction; negative runs against it. */
export interface BankLineLeg {
  accountId: string;
  amountMinor: number;
  taxCode?: string;
  description?: string;
}

export type BookBankLineTarget =
  | {
      kind: 'open_item';
      /** An issued invoice (a credit line) or a posted vendor bill (a debit line). */
      documentId: string;
      remainder?: BankLineRemainderMode;
      writeOffAccountId?: string;
    }
  | { kind: 'payment_batch'; batchId: string }
  | {
      kind: 'existing_entry';
      entryId: string;
      /** Link although the amounts differ (the difference is recorded and shown in the balance). */
      acceptDifference?: boolean;
      /** Why the difference is accepted: REQUIRED with `acceptDifference: true` (critic A39-12). */
      differenceReason?: string;
    }
  | { kind: 'accounts'; legs: BankLineLeg[] };

export const BOOK_BANK_LINE_TARGET_KINDS = ['open_item', 'payment_batch', 'existing_entry', 'accounts'] as const;
