/**
 * N03 (D183), Buchungsregeln that learn: the BACKTEST of a recipe and the MINER that offers new rules.
 *
 * THE BACKTEST (`backtestRule`, the verb `backtest_bank_rule`, the editor's "Testen"). Replays a rule's match
 * over the bank lines of the last days: a HIT is a line of the rule's counterparty and direction whose
 * remittance carries the rule's match text (when it has one); a booked hit is IDENTICAL when its posted entry
 * holds exactly the lines the recipe books on it (`buildAccountsLines`, the booking's own builder, on the
 * line's own date, so VAT and the Durchlaufkonto are compared as booked). A recipe that ASKS an amount books
 * nothing without its asks, so its hits are compared on accounts, codes, sides and the Durchlaufkonto only.
 * Read-only.
 *
 * THE MINER (`mineRules`, the verb `mine_rules`, the scheduler once a Swiss day). Groups the lines booked to
 * accounts in the last `rules.miner_lookback_days` by (counterparty key, direction, leg shape: every account
 * with its code and side, and the Durchlaufkonto; amounts may differ). A group of at least
 * `rules.miner_min_repeats` whose newest line no live rule speaks for (rung c2 silent) becomes ONE Vorschlag
 * of `set_bank_standard`, drafted as `system` with no dial capability so any person who may set rules
 * approves it, keyed `mine:<counterparty key>:<shape hash>`. The key is the memory: a Vorschlag the owner
 * rejected answers every later run from its rejected row (`enqueueDraftedAction` replays the key), so the
 * same counterparty and shape is never offered again. At most `rules.miner_max_open` mined Vorschläge wait
 * at once, the groups with the newest booking first. THE MINER NEVER WRITES A RULE (N03 §6b Fixed): only an
 * approval does, through `set_bank_standard` like any other.
 *
 * §H-TENANT on every query; the Vorschlag carries the workspace it was mined in.
 */

import { createHash } from 'node:crypto';

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { getSetting } from '../settings/settings.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { enqueueDraftedAction } from '../agent/draftedActions.js';
import { bankLedgerOfLine, lineBookingDate, readActiveLink, readBankTxn, readBankTxnDetail } from './bankLines.js';
import type { BankLineLeg, BankTxnDetailRow, BankTxnRow } from './bankLines.js';
import { buildAccountsLines } from './bankBooking.js';
import { containsTokenRun, counterpartyKeyOf, ruleRungContext, ruleRungSpeaks, textTokens } from './bankProposals.js';
import type { ProposalContext } from './bankProposals.js';
import { RESERVED_MINER_KEY_PREFIX, bookedShapeOf, directionOf, invalidViaReason, liveRuleFor, readLiveRule, recipeOfRow, recipeOfShape, shapeRecipe, suggestionTargetUsable } from './bankStandards.js';
import type { BankStandardDirection, BookedShape, RecipeLeg } from './bankStandards.js';
import { expectedRuleLegs } from './ruleStats.js';

/** The Vorschlag key prefix of a mined rule (`mine:<counterparty key>:<shape hash>`). */
export const MINED_RULE_KEY_PREFIX = RESERVED_MINER_KEY_PREFIX;

/** The actor a mined Vorschlag is drafted as: never a person, never the agent seat, so a person approves it. */
export const MINER_ACTOR = 'system';

/** How many hits a backtest lists line by line (newest first); the counts cover every hit. */
export const BACKTEST_LINES_MAX = 20;

/** The day `days` before `iso` (both `YYYY-MM-DD`). */
function daysBefore(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Today in the book's clock, and the first day the lookback setting reaches. */
function lookbackStart(ctx: WorkspaceContext): string {
  return daysBefore(ctx.clock.now().slice(0, 10), getSetting<number>(ctx, 'rules.miner_lookback_days'));
}

/** One bank line with its detail and its live decision, as the backtest and the miner read it. */
interface LineRow extends BankTxnRow {
  counterparty_name: string | null;
  counterparty_iban: string | null;
  remittance_text: string | null;
  end_to_end_id: string | null;
  decision_state: string | null;
  decision_kind: string | null;
  decision_entry: string | null;
}

const LINE_SELECT = `SELECT t.*, d.counterparty_name, d.counterparty_iban, d.remittance_text, d.end_to_end_id,
       dec.state AS decision_state, dec.target_kind AS decision_kind, dec.entry_id AS decision_entry
  FROM bank_txn t
  LEFT JOIN bank_txn_detail d ON d.workspace_id = t.workspace_id AND d.bank_txn_id = t.id
  LEFT JOIN bank_line_decision dec ON dec.workspace_id = t.workspace_id AND dec.bank_txn_id = t.id AND dec.superseded_at IS NULL`;

const LINE_DATE = `COALESCE(t.booking_date, t.value_date, substr(t.created_at, 1, 10))`;

function detailOf(r: LineRow): BankTxnDetailRow {
  return { counterparty_name: r.counterparty_name, counterparty_iban: r.counterparty_iban, remittance_text: r.remittance_text, end_to_end_id: r.end_to_end_id };
}

/** Whether a line is booked to accounts by its live decision (the only bookings a recipe can be compared to). */
function bookedToAccounts(r: LineRow): boolean {
  return r.decision_state === 'booked' && r.decision_entry !== null && (r.decision_kind === 'accounts' || r.decision_kind === 'legacy');
}

/** The posted lines of an entry, as a multiset key per line. */
function postedLineKeys(ctx: WorkspaceContext, entryId: string): string[] {
  return (
    ctx.store.db
      .prepare(
        `SELECT l.account_id AS a, l.debit_minor AS d, l.credit_minor AS c, l.tax_code AS t
           FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id AND e.workspace_id = ?
          WHERE l.entry_id = ? AND (l.debit_minor <> 0 OR l.credit_minor <> 0)`,
      )
      .all(ctx.workspaceId, entryId) as { a: string; d: number; c: number; t: string | null }[]
  )
    .map((l) => `${l.a}|${l.d}|${l.c}|${l.t ?? ''}`)
    .sort();
}

/** The shape key of booked legs (order-free): every account with its code and side, and the Durchlaufkonto. */
function shapeKeyOf(shape: BookedShape): string {
  const legs = shape.legs.map((l) => `${l.accountId}:${l.taxCode ?? ''}:${l.against ? 'a' : 'w'}`).sort();
  return `${legs.join(',')}|via:${shape.viaAccountId ?? ''}`;
}

/** The same key of a recipe (the rest leg is in the line's direction). */
function recipeShapeKey(legs: readonly RecipeLeg[], viaAccountId: string | null): string {
  const keyed = legs.map((l) => `${l.accountId}:${l.taxCode ?? ''}:${l.against === true ? 'a' : 'w'}`).sort();
  return `${keyed.join(',')}|via:${viaAccountId ?? ''}`;
}

/** Is a booked hit booked EXACTLY as the recipe books it? */
function bookedIdentically(ctx: WorkspaceContext, r: LineRow, legs: readonly RecipeLeg[], viaAccountId: string | null, base: string): boolean {
  if (!bookedToAccounts(r)) return false;
  const entryId = r.decision_entry as string;
  const asks = legs.some((l) => l.amount.kind === 'ask' || l.amount.kind === 'same');
  if (asks) {
    const shape = bookedShapeOf(ctx, r, entryId);
    return shape !== null && shapeKeyOf(shape) === recipeShapeKey(legs, viaAccountId);
  }
  const dropCodes = legs.some((l) => l.taxCode !== null) && r.currency !== base;
  const expected = expectedRuleLegs(legs, r.amount_minor, dropCodes);
  if (expected === null) return false;
  const target: BankLineLeg[] = expected.map((e) => ({ accountId: e.accountId, amountMinor: e.amountMinor as number, ...(e.taxCode !== null ? { taxCode: e.taxCode } : {}) }));
  const ledger = bankLedgerOfLine(ctx, r);
  if (ledger === undefined) return false;
  const built = buildAccountsLines(ctx, r, ledger, target, lineBookingDate(r), viaAccountId ?? undefined);
  if ('error' in built) return false;
  const want = built.lines
    .filter((l) => (l.debit ?? 0) !== 0 || (l.credit ?? 0) !== 0)
    .map((l) => `${l.account}|${l.debit ?? 0}|${l.credit ?? 0}|${l.taxCode ?? ''}`)
    .sort();
  const have = postedLineKeys(ctx, entryId);
  return want.length === have.length && want.every((k, i) => k === have[i]);
}

// --- The backtest ----------------------------------------------------------------------------------------

/** A recipe to test: an existing rule (`standardId`) or a new one from a line (`bankTxnId`), with any changes. */
export interface BacktestRecipeInput {
  standardId?: unknown;
  bankTxnId?: unknown;
  /** A line already booked to accounts: its counterparty and direction, and (without legs) its booked legs. */
  fromBankTxnId?: unknown;
  legs?: unknown;
  accountId?: unknown;
  taxCode?: unknown;
  matchText?: unknown;
  viaAccountId?: unknown;
}

export interface BacktestInput {
  recipe?: unknown;
  /** `YYYY-MM-DD`: the first booking date tested (default: `rules.miner_lookback_days` back). */
  since?: unknown;
}

/** One hit of a backtest. */
export interface BacktestLine {
  bankTxnId: string;
  date: string;
  /** Signed: money in positive, money out negative. */
  amountMinor: number;
  currency: string;
  state: 'open' | 'booked' | 'matched' | 'ignored';
  /** Booked exactly as the recipe books it (null for a line that is not booked). */
  identical: boolean | null;
  entryId: string | null;
}

export type BacktestOk = {
  since: string;
  counterpartyKey: string;
  direction: BankStandardDirection;
  matchText: string | null;
  /** Hits booked or matched (what the test compares). */
  hits: number;
  /** Of them, booked exactly as the recipe books them. */
  identical: number;
  /** Hits still open, and hits set aside (ignored). */
  openLines: number;
  ignoredLines: number;
  /** The newest hits, at most `BACKTEST_LINES_MAX`. */
  lines: BacktestLine[];
  /** The recipe tested, as resolved (a booked line's legs for `fromBankTxnId`): what "Als Regel speichern" prefills. */
  recipe: { legs: RecipeLeg[]; viaAccountId: string | null; matchText: string | null };
};

/** The recipe a backtest input stands for, with its counterparty and direction. */
interface ResolvedRecipe {
  key: string;
  direction: BankStandardDirection;
  legs: RecipeLeg[];
  viaAccountId: string | null;
  matchText: string | null;
}

function resolveRecipe(ctx: WorkspaceContext, raw: unknown): { recipe: ResolvedRecipe } | { error: Err } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: err('invalid_input', { field: 'recipe', reason: 'an object: standardId or bankTxnId, and legs, matchText, viaAccountId' }) };
  const r = raw as BacktestRecipeInput;
  const str = (v: unknown, field: string): { v: string | null } | { error: Err } =>
    v === undefined || v === null ? { v: null } : typeof v === 'string' && v.length > 0 ? { v } : { error: err('invalid_input', { field: `recipe.${field}` }) };
  const standardId = str(r.standardId, 'standardId');
  const fromBooked = str(r.fromBankTxnId, 'fromBankTxnId');
  if ('error' in fromBooked) return fromBooked;
  if (fromBooked.v !== null && r.bankTxnId !== undefined && r.bankTxnId !== null && r.bankTxnId !== fromBooked.v) {
    return { error: err('invalid_input', { field: 'recipe.bankTxnId', reason: 'bankTxnId and fromBankTxnId name the same line, or only fromBankTxnId is given' }) };
  }
  const bankTxnId = fromBooked.v !== null ? { v: fromBooked.v } : str(r.bankTxnId, 'bankTxnId');
  const accountId = str(r.accountId, 'accountId');
  const via = str(r.viaAccountId, 'viaAccountId');
  for (const x of [standardId, bankTxnId, accountId, via]) if ('error' in x) return x;
  const sid = (standardId as { v: string | null }).v;
  const tid = (bankTxnId as { v: string | null }).v;
  if ((sid === null) === (tid === null)) return { error: err('invalid_input', { field: 'recipe', reason: 'name the rule (standardId) or the line it is saved from (bankTxnId), exactly one' }) };
  let key: string;
  let direction: BankStandardDirection;
  let legs: RecipeLeg[] | null = null;
  let viaAccountId = (via as { v: string | null }).v;
  let matchText: string | null = null;
  if (sid !== null) {
    const rule = readLiveRule(ctx, sid);
    if (rule === undefined || rule.scope !== 'bank') return { error: err('rule_not_found', { standardId: sid, reason: 'no live bank rule of this workspace has this id' }) };
    key = rule.counterparty_key;
    direction = rule.direction;
    legs = recipeOfRow(rule);
    if (r.viaAccountId === undefined) viaAccountId = rule.via_account_id;
    matchText = rule.match_text;
  } else {
    const row = readBankTxn(ctx, tid as string);
    if (row === undefined) return { error: err('not_found', { bankTxnId: tid }) };
    const k = counterpartyKeyOf(row, readBankTxnDetail(ctx, row.id));
    if (k === null) return { error: err('no_counterparty', { bankTxnId: row.id, reason: 'the line names no counterparty IBAN and no name' }) };
    key = k;
    direction = directionOf(row);
  }
  if (r.legs !== undefined && r.legs !== null) {
    const shaped = shapeRecipe(r.legs);
    if ('error' in shaped) return shaped;
    legs = shaped.legs;
  } else if ((accountId as { v: string | null }).v !== null) {
    const code = typeof r.taxCode === 'string' && r.taxCode.trim() !== '' && r.taxCode.trim() !== 'none' ? r.taxCode.trim() : null;
    legs = [{ accountId: (accountId as { v: string }).v, taxCode: code, amount: { kind: 'rest' } }];
  } else if (fromBooked.v !== null) {
    // N03: the booked legs of the line, exactly as set_bank_standard { fromBankTxnId } would save them.
    const row = readBankTxn(ctx, fromBooked.v) as BankTxnRow;
    const link = readActiveLink(ctx, row.id);
    const entryId = link !== undefined && link.state === 'booked' && (link.targetKind === 'accounts' || link.targetKind === 'legacy') ? link.entryId : null;
    const shape = entryId === null ? null : bookedShapeOf(ctx, row, entryId);
    const derived = shape === null ? null : recipeOfShape(ctx, shape);
    if (shape === null || derived === null) {
      return { error: err('not_booked_to_accounts', { bankTxnId: row.id, state: link?.state ?? 'open', targetKind: link?.targetKind ?? null, reason: 'a rule is saved from a line booked to accounts' }) };
    }
    legs = derived;
    if (r.viaAccountId === undefined || r.viaAccountId === null) viaAccountId = shape.viaAccountId;
  }
  if (legs === null || legs.length === 0) return { error: err('invalid_input', { field: 'recipe.legs', reason: 'a recipe of legs, or accountId (an ignore rule books nothing to test)' }) };
  if (r.matchText !== undefined) {
    if (r.matchText !== null && typeof r.matchText !== 'string') return { error: err('invalid_input', { field: 'recipe.matchText' }) };
    const tokens = typeof r.matchText === 'string' ? textTokens(r.matchText) : [];
    matchText = tokens.length === 0 ? null : tokens.join(' ');
  }
  return { recipe: { key, direction, legs, viaAccountId, matchText } };
}

/** The backtest over already resolved parts (the verb's and the miner's shared core). */
function runBacktest(ctx: WorkspaceContext, recipe: ResolvedRecipe, since: string): BacktestOk {
  const rows = ctx.store.db
    .prepare(`${LINE_SELECT} WHERE t.workspace_id = ? AND t.credit_debit = ? AND ${LINE_DATE} >= ? ORDER BY ${LINE_DATE} DESC, t.rowid DESC`)
    .all(ctx.workspaceId, recipe.direction === 'in' ? 'CRDT' : 'DBIT', since) as LineRow[];
  const needle = recipe.matchText === null ? null : textTokens(recipe.matchText);
  const base = baseCurrencyOf(ctx);
  const out: BacktestOk = {
    since,
    counterpartyKey: recipe.key,
    direction: recipe.direction,
    matchText: recipe.matchText,
    hits: 0,
    identical: 0,
    openLines: 0,
    ignoredLines: 0,
    lines: [],
    recipe: { legs: recipe.legs, viaAccountId: recipe.viaAccountId, matchText: recipe.matchText },
  };
  for (const r of rows) {
    if (counterpartyKeyOf(r, detailOf(r)) !== recipe.key) continue;
    if (needle !== null && !containsTokenRun(textTokens(r.remittance_text), needle)) continue;
    const state = (r.decision_state ?? 'open') as BacktestLine['state'];
    let identical: boolean | null = null;
    if (state === 'open') out.openLines += 1;
    else if (state === 'ignored') out.ignoredLines += 1;
    else {
      out.hits += 1;
      identical = bookedIdentically(ctx, r, recipe.legs, recipe.viaAccountId, base);
      if (identical) out.identical += 1;
    }
    if (out.lines.length < BACKTEST_LINES_MAX) {
      out.lines.push({
        bankTxnId: r.id,
        date: lineBookingDate(r),
        amountMinor: r.credit_debit === 'CRDT' ? r.amount_minor : -r.amount_minor,
        currency: r.currency,
        state,
        identical,
        entryId: r.decision_entry,
      });
    }
  }
  return out;
}

/**
 * N03 (D183 §4): `backtest_bank_rule`. `recipe` names the rule (`standardId`) or the line a new one is saved
 * from (`bankTxnId`, or `fromBankTxnId` for a line booked to accounts, whose booked legs are the recipe when no
 * legs are given: the answer's `recipe` is what "Als Regel speichern" prefills), and may change its `legs`
 * (or `accountId` and `taxCode`), `matchText` and
 * `viaAccountId` as the editor holds them; `since` (`YYYY-MM-DD`) defaults to `rules.miner_lookback_days`
 * back. Refuses `invalid_input`, `invalid_recipe` (the shape `set_bank_standard` checks), `rule_not_found`,
 * `not_found`, `no_counterparty`, `not_booked_to_accounts`. Writes nothing.
 */
export function backtestRule(ctx: WorkspaceContext, input: BacktestInput): Result<BacktestOk> {
  const since = input.since;
  if (since !== undefined && since !== null && (typeof since !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(since))) {
    return err('invalid_input', { field: 'since', reason: 'a date YYYY-MM-DD' });
  }
  const resolved = resolveRecipe(ctx, input.recipe);
  if ('error' in resolved) return resolved.error;
  return ok<BacktestOk>(runBacktest(ctx, resolved.recipe, typeof since === 'string' ? since : lookbackStart(ctx)));
}

// --- The miner -------------------------------------------------------------------------------------------

/** What one mined group became. */
export interface MinedGroup {
  counterpartyKey: string;
  direction: BankStandardDirection;
  shapeHash: string;
  /** How many lines of the lookback were booked this way. */
  repeats: number;
  /** The newest of them (the line the rule is saved from). */
  bankTxnId: string;
  /** `drafted` (a new Vorschlag), `open` (one waits already), `rejected` (the owner said no before: never again), `made` (approved before). */
  outcome: 'drafted' | 'open' | 'rejected' | 'made';
  actionId: string;
}

export type MineRulesOk = {
  /** False when `rules.miner` is `off` (nothing was read). */
  ran: boolean;
  since: string | null;
  /** Lines booked to accounts in the lookback that were grouped. */
  considered: number;
  groups: MinedGroup[];
  /** Groups left for a later run because `rules.miner_max_open` mined Vorschläge already wait. */
  capped: number;
  /** Pending mined Vorschläge voided because a rule now covers their pattern (critic, finding 1). */
  voided?: string[];
};

/** The pending mined Vorschläge of this workspace. */
function openMinedCount(ctx: WorkspaceContext): number {
  return (
    ctx.store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_action
          WHERE workspace_id = ? AND action_tool = 'set_bank_standard' AND status = 'pending' AND idempotency_key LIKE ?`,
      )
      .get(ctx.workspaceId, `${MINED_RULE_KEY_PREFIX}%`) as { n: number }
  ).n;
}

/** The short hash of a direction and a shape (the Vorschlag key's second half). */
function shapeHashOf(direction: BankStandardDirection, shapeKey: string): string {
  return createHash('sha256').update(`${direction}|${shapeKey}`).digest('hex').slice(0, 12);
}

/** Every account and code of a recipe, and its Durchlaufkonto, can still be named by a rule now. */
function recipeUsable(ctx: WorkspaceContext, legs: readonly RecipeLeg[], viaAccountId: string | null): boolean {
  if (!legs.every((l) => suggestionTargetUsable(ctx, l.accountId, l.taxCode))) return false;
  if (viaAccountId === null) return true;
  const via = ctx.store.db
    .prepare('SELECT id, number, type, archived FROM account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, viaAccountId) as { id: string; number: string; type: string | null; archived: number } | undefined;
  return via !== undefined && invalidViaReason(ctx, via) === null && !legs.some((l) => l.accountId === viaAccountId);
}

/** The counterparty as the line names it (the rule's label), at most 80 characters. */
function counterpartyLabelOf(r: LineRow): string {
  return ((r.counterparty_name ?? r.payer_name ?? '').trim() || (r.counterparty_iban ?? '').trim()).slice(0, 80).trim();
}

/**
 * N03 (D183 §4): `mine_rules`, and the scheduler's daily run. See the header. `ctx.actor` is whoever asked;
 * every Vorschlag is drafted as `system` whoever asked, so the person who ran it may approve what it found.
 */
export function mineRules(ctx: WorkspaceContext): Result<MineRulesOk> {
  if (getSetting<string>(ctx, 'rules.miner') === 'off') return ok<MineRulesOk>({ ran: false, since: null, considered: 0, groups: [], capped: 0, voided: [] });
  const since = lookbackStart(ctx);
  const minRepeats = getSetting<number>(ctx, 'rules.miner_min_repeats');
  const maxOpen = getSetting<number>(ctx, 'rules.miner_max_open');
  const rows = ctx.store.db
    .prepare(
      `${LINE_SELECT}
        WHERE t.workspace_id = ? AND dec.state = 'booked' AND dec.target_kind IN ('accounts', 'legacy') AND dec.entry_id IS NOT NULL
          AND ${LINE_DATE} >= ?
        ORDER BY ${LINE_DATE} DESC, t.rowid DESC`,
    )
    .all(ctx.workspaceId, since) as LineRow[];
  // Newest first, so each group's first line is its newest and the groups come out newest evidence first.
  const groups = new Map<string, { key: string; direction: BankStandardDirection; shape: BookedShape; shapeKey: string; lines: LineRow[] }>();
  let considered = 0;
  for (const r of rows) {
    const key = counterpartyKeyOf(r, detailOf(r));
    if (key === null) continue;
    const shape = bookedShapeOf(ctx, r, r.decision_entry as string);
    if (shape === null) continue;
    considered += 1;
    const direction = directionOf(r);
    const shapeKey = shapeKeyOf(shape);
    const id = `${key}|${direction}|${shapeKey}`;
    const g = groups.get(id) ?? { key, direction, shape, shapeKey, lines: [] };
    g.lines.push(r);
    groups.set(id, g);
  }
  const pc: ProposalContext = ruleRungContext(ctx);
  const system: WorkspaceContext = { ...ctx, actor: MINER_ACTOR };
  // N03 (critic, finding 1): a pending mined Vorschlag whose pattern a rule now covers is void before anything
  // is drafted, so it neither waits in Pendenzen nor counts against the cap.
  const voided = voidCoveredMinedDrafts(ctx, pc);
  let open = openMinedCount(ctx);
  let capped = 0;
  const out: MinedGroup[] = [];
  for (const g of groups.values()) {
    if (g.lines.length < minRepeats) continue;
    const newest = g.lines[0]!;
    // "No live rule matching them": the rule rung of the ladder is silent for the newest line.
    if (ruleRungSpeaks(ctx, pc, newest, detailOf(newest))) continue;
    const legs = recipeOfShape(ctx, g.shape);
    if (legs === null || !recipeUsable(ctx, legs, g.shape.viaAccountId)) continue;
    const shapeHash = shapeHashOf(g.direction, g.shapeKey);
    const mineKey = `${MINED_RULE_KEY_PREFIX}${g.key}:${shapeHash}`;
    // N03 (critic, finding 6): only the miner's own rows (drafted as system) answer for a pattern; the prefix
    // is reserved besides (`setBankStandardRefusal`), so no other seat can draft under it.
    const known = ctx.store.db
      .prepare(
        "SELECT id, status FROM agent_action WHERE workspace_id = ? AND action_tool = 'set_bank_standard' AND idempotency_key = ? AND actor = ? AND status <> 'stale' ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 1",
      )
      .get(ctx.workspaceId, mineKey, MINER_ACTOR) as { id: string; status: string } | undefined;
    if (known === undefined && open >= maxOpen) {
      capped += 1;
      continue;
    }
    // A pattern that already has its row is answered from that row. Re-enqueueing it would carry a fresh
    // inner key and no stored facts, and the registry-level idempotency check (N01, D183) rightly refuses
    // a known key with other arguments.
    if (known !== undefined) {
      const status = known.status;
      const outcome: MinedGroup['outcome'] = status === 'pending' ? 'open' : status === 'rejected' ? 'rejected' : 'made';
      out.push({ counterpartyKey: g.key, direction: g.direction, shapeHash, repeats: g.lines.length, bankTxnId: newest.id, outcome, actionId: known.id });
      continue;
    }
    const label = counterpartyLabelOf(newest);
    // N03 (critic, finding 5): the evidence is read ONCE, here, and stored in the Vorschlag, so Pendenzen
    // shows it without a backtest per card per read. Only for a pattern with no row yet.
    const facts = known === undefined ? minedProposalFacts(ctx, { bankTxnId: newest.id, legs, viaAccountId: g.shape.viaAccountId, label }) : null;
    const payload: Record<string, unknown> = {
      workspaceId: ctx.workspaceId,
      bankTxnId: newest.id,
      legs,
      ...(g.shape.viaAccountId !== null ? { viaAccountId: g.shape.viaAccountId } : {}),
      ...(label !== '' ? { label } : {}),
      // N03 (critic, finding 1): the slot as it is now (null: empty); approving after a rule was set, edited or
      // removed there refuses `rule_slot_changed` instead of replacing it.
      expectSlotStandardId: liveRuleFor(ctx, g.key, g.direction, null)?.id ?? null,
      ...(facts !== null ? { minedFacts: facts } : {}),
      // MINTED (K1): the rule's write runs under a key no caller can know, so nobody can squat the
      // set_bank_standard memo the approval replays. The Vorschlag's OWN key (below) is the pattern's.
      idempotencyKey: ctx.ids.next('mrule'),
    };
    const drafted = enqueueDraftedAction(system, { actionTool: 'set_bank_standard', payload, dialCapability: null, idempotencyKey: mineKey });
    if (!drafted.ok) continue;
    const status = String(drafted['status']);
    const replayed = drafted['replayed'] === true;
    const outcome: MinedGroup['outcome'] = !replayed ? 'drafted' : status === 'pending' ? 'open' : status === 'rejected' ? 'rejected' : 'made';
    if (outcome === 'drafted') open += 1;
    out.push({ counterpartyKey: g.key, direction: g.direction, shapeHash, repeats: g.lines.length, bankTxnId: newest.id, outcome, actionId: String(drafted['actionId']) });
  }
  return ok<MineRulesOk>({ ran: true, since, considered, groups: out, capped, voided });
}

/**
 * N03 (critic, finding 1): every PENDING mined Vorschlag whose line a rule now speaks for (rung c2: one rule,
 * the picker, or "Nicht buchen") goes `stale`: it can never be approved, leaves Pendenzen, and frees its
 * pattern, so a later run drafts it again only if the rule goes away. Only rows the miner drafted (system,
 * with its evidence); a row whose approval already committed is left alone (D165). Answers their ids.
 */
function voidCoveredMinedDrafts(ctx: WorkspaceContext, pc: ProposalContext): string[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT id, payload_json FROM agent_action
        WHERE workspace_id = ? AND action_tool = 'set_bank_standard' AND actor = ? AND status = 'pending' AND committed_at IS NULL
          AND idempotency_key LIKE ?`,
    )
    .all(ctx.workspaceId, MINER_ACTOR, `${MINED_RULE_KEY_PREFIX}%`) as { id: string; payload_json: string }[];
  const stale = ctx.store.db.prepare(
    "UPDATE agent_action SET status = 'stale', resolved_at = ?, resolved_by = ? WHERE workspace_id = ? AND id = ? AND status = 'pending' AND committed_at IS NULL",
  );
  const out: string[] = [];
  for (const r of rows) {
    let bankTxnId: unknown;
    try {
      bankTxnId = (JSON.parse(r.payload_json) as { bankTxnId?: unknown }).bankTxnId;
    } catch {
      continue;
    }
    const line = typeof bankTxnId === 'string' ? readBankTxn(ctx, bankTxnId) : undefined;
    if (line === undefined || !ruleRungSpeaks(ctx, pc, line, readBankTxnDetail(ctx, line.id))) continue;
    if (stale.run(ctx.clock.now(), MINER_ACTOR, ctx.workspaceId, r.id).changes === 1) out.push(r.id);
  }
  return out;
}

// --- What Pendenzen shows for a mined Vorschlag ----------------------------------------------------------

/** The words and figures a mined rule's Vorschlag shows (N03 §6): read when it is drafted, stored in its payload. */
export interface MinedProposalFacts {
  counterparty: string;
  /** Lines booked exactly this way in the lookback. */
  repeats: number;
  /** The backtest: since when, how many booked hits, how many of them identical. */
  since: string;
  hits: number;
  identical: number;
  /** The newest identical bookings (the evidence), at most five. */
  evidence: { bankTxnId: string; date: string; amountMinor: number; currency: string; entryId: string | null }[];
}

/** Is this drafted act a mined rule (`set_bank_standard` drafted by `system`, carrying the miner's facts)? */
export function isMinedRuleVorschlag(tool: string, payload: Readonly<Record<string, unknown>>, actor: unknown): boolean {
  return tool === 'set_bank_standard' && actor === MINER_ACTOR && storedMinedFacts(payload) !== null;
}

/** The facts the miner stored in a Vorschlag's payload (`minedFacts`), or null when they are absent or malformed. */
export function storedMinedFacts(payload: Readonly<Record<string, unknown>>): MinedProposalFacts | null {
  const f = payload['minedFacts'];
  if (typeof f !== 'object' || f === null || Array.isArray(f)) return null;
  const r = f as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  if (typeof r['counterparty'] !== 'string' || typeof r['since'] !== 'string') return null;
  const evidence = Array.isArray(r['evidence'])
    ? (r['evidence'] as unknown[]).flatMap((e) => {
        const x = (e ?? {}) as Record<string, unknown>;
        return typeof x['bankTxnId'] === 'string' && typeof x['date'] === 'string' && typeof x['currency'] === 'string'
          ? [{ bankTxnId: x['bankTxnId'], date: x['date'], amountMinor: num(x['amountMinor']), currency: x['currency'], entryId: typeof x['entryId'] === 'string' ? x['entryId'] : null }]
          : [];
      })
    : [];
  return { counterparty: r['counterparty'], repeats: num(r['repeats']), since: r['since'], hits: num(r['hits']), identical: num(r['identical']), evidence };
}

/** The facts of a mined Vorschlag's payload, or null when its line or recipe no longer reads. */
export function minedProposalFacts(ctx: WorkspaceContext, payload: Readonly<Record<string, unknown>>): MinedProposalFacts | null {
  const resolved = resolveRecipe(ctx, { bankTxnId: payload['bankTxnId'], legs: payload['legs'], viaAccountId: payload['viaAccountId'] ?? null });
  if ('error' in resolved) return null;
  const test = runBacktest(ctx, resolved.recipe, lookbackStart(ctx));
  const row = readBankTxn(ctx, String(payload['bankTxnId']));
  const detail = row === undefined ? undefined : readBankTxnDetail(ctx, row.id);
  const label = typeof payload['label'] === 'string' && payload['label'] !== '' ? payload['label'] : (detail?.counterparty_name ?? row?.payer_name ?? '').trim();
  const evidence = test.lines.filter((l) => l.identical === true).slice(0, 5).map((l) => ({ bankTxnId: l.bankTxnId, date: l.date, amountMinor: l.amountMinor, currency: l.currency, entryId: l.entryId }));
  return { counterparty: label, repeats: test.identical, since: test.since, hits: test.hits, identical: test.identical, evidence };
}
