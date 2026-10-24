/**
 * D167 (spec A39 §13.1), widened by D175 (§14): the STANDARD per counterparty, now a BUCHUNGSREGEL. "This
 * counterparty, money in or money out, books like this." A rule PREFILLS a line (rung (c2) of the proposal
 * ladder, `bankProposals.ts`); it never posts and no stored automation fires it. Owner pick 1A (D167) and
 * D175 point 5: a complete rule's proposal is `sure` (setting `bank.buchungsregel_mode` = `bulk`, the
 * default), so the one bulk button books it, because the person made it.
 *
 * THE RECIPE (D175). A rule holds 1 to 20 legs: an account, an optional MWST code, and an amount that is
 * either the REST (exactly one leg) or ASKED at booking time under a label ("Bruttoumsatz"). An optional
 * Durchlaufkonto (`viaAccountId`) routes the whole entry through itself (bank against it, it against each
 * leg), and an optional match text ("Nur wenn der Text enthält") narrows the rule to lines whose REMITTANCE
 * text contains it, never the payer name (two businesses can share one payer). A D167 row (`legs_json`
 * NULL) reads as the one-leg rest recipe of its `account_id` and `tax_code`, so it behaves as before.
 *
 * THE KEY IS THE COUNTERPARTY, NEVER A BANKKONTO: the IBAN, else the normalised name (`counterpartyKeyOf`,
 * the key bank history already groups by), plus the direction (`in` for a credit, `out` for a debit), plus
 * the match text: one live rule per (key, direction, text), the text-less rule being the '' slot.
 *
 * D176 (A39 §15): a rule has a SCOPE and an OUTCOME. Scope `bank` is the D175 rule a bank line proposes;
 * scope `manual` is a VORLAGE the Buchungssatz composer books from (`expandTemplate`, `bankTemplates.ts`):
 * every leg states its side (Soll or Haben), one leg is the rest that balances the entry, and an amount may
 * be `same` as another asked leg (the month entry asks the gross once and uses it twice). An amount may be
 * `same` in a bank recipe too. A manual row has no counterparty: it is stored under the key
 * `vorlage:<the label's folded tokens>` with direction 'out' and no text, so the generation-15 one-live
 * index holds ONE LIVE VORLAGE PER FOLDED LABEL, and a real key (`iban:` or `name:`) can never meet it. The
 * API answers a Vorlage's key, counterparty and direction as null. Outcome `ignore` (bank scope only)
 * proposes "Nicht buchen" with one of the ignore reasons and a note instead of legs; such a row has no legs,
 * and its NOT NULL `account_id` holds the Bankkonto ledger account of the line it was saved from, or of the
 * workspace's oldest Bankkonto when an edit turns a booking rule into one (critic D176-C3; nothing books to
 * it; the API answers null). A bank rule may name a follow-up Vorlage (`followUpStandardId`): once
 * its line is decided by the rule, the inbox offers that Vorlage as the next step.
 *
 * APPEND-ONLY (`bank_standard` in `bankInboxSchema.ts`): a new rule for the same slot SUPERSEDES the live
 * one in the same transaction, clearing one only stamps its supersession, and an EDIT (`standardId`)
 * supersedes the edited row. A partial unique index keeps at most one live row per slot, so two concurrent
 * sets cannot leave two answers; three triggers freeze every column but the supersession stamp.
 *
 * WHAT A RULE MAY NAME is the account a person could book a line to by hand (`invalidAccountReason`): not
 * archived, not a Bankkonto's ledger account, not the 1100/2000 control accounts (settling is `open_item`),
 * not a VAT account. A Vorlage is held to the same rule (it never books a bank ledger, D139: that is the bank
 * line's job, and the engine derives the VAT legs itself). A code must exist in the book and be active, and
 * may only sit on an account where VAT can apply (`vatCanApplyToAccount`, the Studio's `vatCanApply` rule
 * restated here). A Durchlaufkonto passes the same account check, is no leg's account, and is a balance
 * account (never income or expense).
 *
 * §H-TENANT on every query: a line, account or rule of another workspace is `not_found`.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { requireString } from '../ledger/inputGuards.js';
import { BANK_LINE_IGNORE_REASONS, controlAccountRoleOf, readBankTxn, readBankTxnDetail } from './bankLines.js';
import type { BankLineIgnoreReason, BankTxnRow } from './bankLines.js';
import { counterpartyKeyOf, textTokens } from './bankProposals.js';

export const BANK_STANDARD_DIRECTIONS = ['in', 'out'] as const;
export type BankStandardDirection = (typeof BANK_STANDARD_DIRECTIONS)[number];

/** D176: where a rule speaks: on a bank line (`bank`) or as a Vorlage in the composer (`manual`). */
export const BANK_RULE_SCOPES = ['bank', 'manual'] as const;
export type BankRuleScope = (typeof BANK_RULE_SCOPES)[number];

/** D176: what a rule proposes: its legs, or "Nicht buchen" with a reason (bank scope only). */
export const BANK_RULE_OUTCOMES = ['legs', 'ignore'] as const;
export type BankRuleOutcome = (typeof BANK_RULE_OUTCOMES)[number];

/** D176: the side a Vorlage's leg books on. */
export const RECIPE_SIDES = ['debit', 'credit'] as const;
export type RecipeSide = (typeof RECIPE_SIDES)[number];

/** D176: the key prefix of a Vorlage (a line's key is always `iban:` or `name:`). */
export const VORLAGE_KEY_PREFIX = 'vorlage:';
/** D176: the fixed direction a Vorlage row stores (the column is NOT NULL; a Vorlage has no direction). */
const VORLAGE_DIRECTION: BankStandardDirection = 'out';

/** The VAT accounts no booking line, and so no rule, may name (the Studio's `VAT_ACCOUNT_NUMBERS`). */
export const VAT_ACCOUNT_NUMBERS: readonly string[] = ['1170', '1171', '2200', '2201'];
/** The control accounts a rule never names: settling an invoice or a bill is `open_item`. */
const CONTROL_ACCOUNT_NUMBERS: readonly string[] = ['1100', '2000'];

// --- The recipe (D175, A39 §14.1; D176, §15.1) -------------------------------------------------------

/**
 * D177 (A39 §16.1): what a computed amount's fraction stands for, in basis points, used ONLY for words (the
 * formula on hover, "MWST 8.1 % und 9.9 % Gebühr"). The amount is `num`/`den`, never these.
 */
export type RecipeFactorExplain = { vatBp?: number; feeBp?: number };

/**
 * How a leg's amount is found when it is booked: the rest (of the line, or what balances a Vorlage), asked
 * under a label, (D176) the SAME amount as another ASKED leg, named by its index, or (D177) COMPUTED from
 * the line: round-half-up(|line| x num / den) in Rappen, exact integer arithmetic, `num` and `den` positive
 * safe integers. A computed leg is prefilled and may be overridden by `asks[legIndex]` at booking time. Bank
 * scope only: a Vorlage has no line amount to compute from (`invalid_recipe` detail `factor`).
 */
export type RecipeAmount =
  | { kind: 'rest' }
  | { kind: 'ask'; label: string }
  | { kind: 'same'; legIndex: number }
  | { kind: 'factor'; label: string; num: number; den: number; explain?: RecipeFactorExplain };

/** One leg of a Buchungsregel. */
export interface RecipeLeg {
  accountId: string;
  taxCode: string | null;
  amount: RecipeAmount;
  /** Bank scope: a leg that runs against the line's direction (a fee, a cost). Never on the rest leg. */
  against?: boolean;
  /** D176, manual scope (required there, absent on a bank rule): the side the leg books on. */
  side?: RecipeSide;
  description?: string;
}

/** A recipe leg as `list_bank_standards` answers it, with its account's number and name. */
export type BankStandardLeg = RecipeLeg & { accountNumber: string; accountName: string };

export const BANK_RULE_MAX_LEGS = 20;
/** D176: a Vorlage books an entry of its own, so it needs at least two legs. */
export const BANK_VORLAGE_MIN_LEGS = 2;
export const BANK_RULE_ASK_LABEL_MAX = 40;
export const BANK_RULE_LEG_DESCRIPTION_MAX = 120;
export const BANK_RULE_LABEL_MAX = 80;
export const BANK_RULE_MATCH_TEXT_MAX = 120;
/** D176: an ignore rule's note, the length `ignore_bank_line` admits. */
export const BANK_RULE_IGNORE_NOTE_MAX = 500;

/**
 * Why a live rule went quiet (§H-ENUM, single point; the Studio mirrors it): an account of a leg or the
 * Durchlaufkonto archived, one no longer a valid target (it became a Bankkonto's ledger, a control or a VAT
 * account), a leg's code gone or archived, a code on an account where MWST cannot apply, or a stored recipe
 * this build cannot read.
 */
export const BANK_RULE_INVALID_REASONS = ['account_archived', 'account_not_bookable', 'tax_code_inactive', 'vat_not_applicable', 'recipe_unreadable'] as const;
export type BankRuleInvalidReason = (typeof BANK_RULE_INVALID_REASONS)[number];

/** Which rule a refused recipe broke (the `detail` of `invalid_recipe`, §H-ENUM). */
export const BANK_RULE_RECIPE_DETAILS = [
  'legs_count',
  'leg_shape',
  'rest_count',
  'ask_label',
  'against_on_rest',
  'description',
  'invalid_account',
  'invalid_tax_code',
  'vat_not_applicable',
  'via_account',
  // D176 (A39 §15.1): a `same` that names no asked leg; a side missing on a Vorlage's leg (or present on a
  // bank rule's); an ignore outcome with legs or without a valid reason; a follow-up that is not a live
  // Vorlage of this workspace.
  'same_target',
  'side',
  'ignore_outcome',
  'follow_up',
  // D177 (A39 §16.1): a computed amount whose label, num, den or explain is malformed, or one on a Vorlage
  // (a manual Vorlage has no line amount to compute from).
  'factor',
] as const;
export type BankRuleRecipeDetail = (typeof BANK_RULE_RECIPE_DETAILS)[number];

export type BankStandard = {
  id: string;
  /** D176: `bank` (proposed on a matching line) or `manual` (a Vorlage in the composer). */
  scope: BankRuleScope;
  /** D176: `legs` (book the recipe) or `ignore` ("Nicht buchen", bank scope only). */
  outcome: BankRuleOutcome;
  /** The counterparty key; null for a Vorlage (it has no counterparty). */
  counterpartyKey: string | null;
  /** The counterparty as the line names it; null for a Vorlage. */
  counterpartyLabel: string | null;
  /** The line direction the rule is for; null for a Vorlage. */
  direction: BankStandardDirection | null;
  /** D175: the rule's name, or null (a D167 standard has none). Always set on a Vorlage. */
  label: string | null;
  /** D175: the folded remittance text the rule requires, or null for every line of the counterparty. */
  matchText: string | null;
  /** D175: the Durchlaufkonto the entry runs through, or null for a direct booking. */
  viaAccountId: string | null;
  viaAccountNumber: string | null;
  viaAccountName: string | null;
  /** D175: the recipe in order; a D167 standard reads as its one rest leg, an `ignore` rule has none. */
  legs: BankStandardLeg[];
  /** D175: why the rule is silent on the ladder, or null while it is valid. */
  invalidReason: BankRuleInvalidReason | null;
  /** D176: the ignore reason and note an `ignore` rule proposes; null otherwise. */
  ignoreReason: BankLineIgnoreReason | null;
  ignoreNote: string | null;
  /** D176: the Vorlage offered as the next step once the line is decided, while one is live; else null. */
  followUpStandardId: string | null;
  followUpLabel: string | null;
  /** The REST leg's account and code, kept for D167 readers; null for an `ignore` rule (it has no legs). */
  accountId: string | null;
  accountNumber: string | null;
  accountName: string | null;
  taxCode: string | null;
  setBy: string | null;
  setAt: string;
};

interface StandardRow {
  id: string;
  counterparty_key: string;
  counterparty_label: string;
  direction: BankStandardDirection;
  account_id: string;
  tax_code: string | null;
  set_by: string | null;
  set_at: string;
  superseded_at: string | null;
  label: string | null;
  match_text: string | null;
  legs_json: string | null;
  via_account_id: string | null;
  scope: BankRuleScope;
  outcome: BankRuleOutcome;
  ignore_reason: string | null;
  ignore_note: string | null;
  follow_up_standard_id: string | null;
}

/** A stored rule row as `expandRule` and `expandTemplate` read it (exported for those two only). */
export type BankStandardRow = StandardRow;

interface AccountRow {
  id: string;
  number: string;
  name: string;
  type: string | null;
  archived: number;
}

/** The direction of a line: a credit brings money in. */
export function directionOf(row: Pick<BankTxnRow, 'credit_debit'>): BankStandardDirection {
  return row.credit_debit === 'CRDT' ? 'in' : 'out';
}

/** D176: the stored key of a Vorlage named `label`, or null when the label has no letter or digit. */
export function vorlageKeyOf(label: string): string | null {
  const tokens = textTokens(label);
  return tokens.length === 0 ? null : `${VORLAGE_KEY_PREFIX}${tokens.join(' ')}`;
}

function readAccount(ctx: WorkspaceContext, accountId: string): AccountRow | undefined {
  return ctx.store.db
    .prepare('SELECT id, number, name, type, archived FROM account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, accountId) as AccountRow | undefined;
}

/** Every account of the workspace by id, one read (for a list or an index of rules). */
function accountsById(ctx: WorkspaceContext): Map<string, AccountRow> {
  const rows = ctx.store.db
    .prepare('SELECT id, number, name, type, archived FROM account WHERE workspace_id = ?')
    .all(ctx.workspaceId) as AccountRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

/** Critic D176-C3: the ledger account of the workspace's oldest Bankkonto, or '' when it has none. */
function oldestBankLedger(ctx: WorkspaceContext): string {
  const row = ctx.store.db.prepare('SELECT ledger_account_id FROM bank_account WHERE workspace_id = ? ORDER BY rowid LIMIT 1').get(ctx.workspaceId) as
    | { ledger_account_id: string }
    | undefined;
  return row?.ledger_account_id ?? '';
}

function bankLedgerIds(ctx: WorkspaceContext): Set<string> {
  return new Set(
    (ctx.store.db.prepare('SELECT ledger_account_id FROM bank_account WHERE workspace_id = ?').all(ctx.workspaceId) as { ledger_account_id: string }[]).map(
      (r) => r.ledger_account_id,
    ),
  );
}

/**
 * Why an account cannot be a rule's target, or null when it can: archived, a Bankkonto's own ledger
 * account, a control account (by role or by its KMU number), or a VAT account.
 */
export function invalidAccountReason(
  ctx: WorkspaceContext,
  account: Pick<AccountRow, 'id' | 'number' | 'archived'>,
  ledgers: ReadonlySet<string> = bankLedgerIds(ctx),
): string | null {
  if (account.archived === 1) return 'archived';
  if (ledgers.has(account.id)) return 'bank_ledger';
  if (CONTROL_ACCOUNT_NUMBERS.includes(account.number) || controlAccountRoleOf(ctx, account.id) !== null) return 'control_account';
  if (VAT_ACCOUNT_NUMBERS.includes(account.number)) return 'vat_account';
  return null;
}

/**
 * Why an account cannot be a Durchlaufkonto, or null when it can (A39 §14.1): every reason an account
 * cannot be a target, and an income or expense account (a Durchlaufkonto is a balance account). Being a
 * leg's own account is the caller's check (it needs the legs).
 */
export function invalidViaReason(
  ctx: WorkspaceContext,
  account: Pick<AccountRow, 'id' | 'number' | 'archived' | 'type'>,
  ledgers: ReadonlySet<string> = bankLedgerIds(ctx),
): string | null {
  const invalid = invalidAccountReason(ctx, account, ledgers);
  if (invalid !== null) return invalid;
  if (account.type === 'income' || account.type === 'expense') return 'income_or_expense';
  return null;
}

/**
 * Can a VAT code apply to a booking on this account? The Studio's `vatCanApply` (and the composer's
 * `isTaxBearing`) rule, in the engine: an income or expense account, or an asset account numbered 12xx or
 * 14xx to 17xx (Vorräte and Anlagevermögen); never a VAT account or a Bankkonto's ledger account.
 */
export function vatCanApplyToAccount(account: Pick<AccountRow, 'id' | 'number' | 'type'>, ledgers: ReadonlySet<string>): boolean {
  if (VAT_ACCOUNT_NUMBERS.includes(account.number) || ledgers.has(account.id)) return false;
  if (account.type === 'income' || account.type === 'expense') return true;
  return account.type === 'asset' && /^1[24-7]\d{2}$/.test(account.number);
}

/** Is the code in this book and active (an archived code books nothing new)? */
function taxCodeIsActive(ctx: WorkspaceContext, code: string): boolean {
  const row = ctx.store.db
    .prepare('SELECT active FROM tax_code WHERE workspace_id = ? AND code = ? ORDER BY active DESC LIMIT 1')
    .get(ctx.workspaceId, code) as { active: number } | undefined;
  return row !== undefined && row.active === 1;
}

/**
 * THE ONE GUARD on what a suggestion may prefill (a rule (c2), the journal rung (d2)): an account a
 * person could book the line to (`invalidAccountReason`), and, with a code, a code still active on an
 * account where VAT can apply. A target that fails it would only be refused by `book_bank_line`.
 */
function targetUsable(ctx: WorkspaceContext, account: AccountRow, taxCode: string | null, ledgers: ReadonlySet<string>): boolean {
  return (
    invalidAccountReason(ctx, account, ledgers) === null &&
    (taxCode === null || (taxCodeIsActive(ctx, taxCode) && vatCanApplyToAccount(account, ledgers)))
  );
}

/** `targetUsable` by account id (tenant-bound): an account outside the workspace is never usable. */
export function suggestionTargetUsable(ctx: WorkspaceContext, accountId: string, taxCode: string | null): boolean {
  const account = readAccount(ctx, accountId);
  return account !== undefined && targetUsable(ctx, account, taxCode, bankLedgerIds(ctx));
}

// --- Reading a stored recipe ---------------------------------------------------------------------------

/** A stored recipe, or null when the row's JSON is not one this build can read. */
function parseStoredLegs(json: string, scope: BankRuleScope): RecipeLeg[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const shaped = shapeLegs(raw, scope);
  return 'legs' in shaped ? shaped.legs : null;
}

/**
 * The recipe a row stands for: its stored legs, or a D167 row's one rest leg; an `ignore` rule has none.
 * Null when unreadable.
 */
export function recipeOfRow(
  row: Pick<StandardRow, 'legs_json' | 'account_id' | 'tax_code'> & Partial<Pick<StandardRow, 'scope' | 'outcome'>>,
): RecipeLeg[] | null {
  if (row.outcome === 'ignore') return [];
  if (row.legs_json === null) return [{ accountId: row.account_id, taxCode: row.tax_code, amount: { kind: 'rest' } }];
  return parseStoredLegs(row.legs_json, row.scope ?? 'bank');
}

function canonicalAmount(a: RecipeAmount): RecipeAmount {
  if (a.kind === 'rest') return { kind: 'rest' };
  if (a.kind === 'ask') return { kind: 'ask', label: a.label };
  if (a.kind === 'factor') {
    const explain = canonicalExplain(a.explain);
    return { kind: 'factor', label: a.label, num: a.num, den: a.den, ...(explain !== undefined ? { explain } : {}) };
  }
  return { kind: 'same', legIndex: a.legIndex };
}

/** D177: an explain in its canonical form (fixed key order, absent keys left out), or undefined when empty. */
function canonicalExplain(e: RecipeFactorExplain | undefined): RecipeFactorExplain | undefined {
  if (e === undefined) return undefined;
  const out: RecipeFactorExplain = { ...(e.vatBp !== undefined ? { vatBp: e.vatBp } : {}), ...(e.feeBp !== undefined ? { feeBp: e.feeBp } : {}) };
  return Object.keys(out).length === 0 ? undefined : out;
}

/** A recipe in its canonical JSON form (the stored form, and what `unchanged` compares). */
function canonicalLegs(legs: readonly RecipeLeg[]): string {
  return JSON.stringify(
    legs.map((l) => ({
      accountId: l.accountId,
      taxCode: l.taxCode,
      amount: canonicalAmount(l.amount),
      ...(l.side !== undefined ? { side: l.side } : {}),
      ...(l.against === true ? { against: true } : {}),
      ...(l.description !== undefined && l.description !== '' ? { description: l.description } : {}),
    })),
  );
}

/** The index of the rest leg (a valid recipe has exactly one; an `ignore` rule none, -1). */
export function restLegIndex(legs: readonly RecipeLeg[]): number {
  return legs.findIndex((l) => l.amount.kind === 'rest');
}

/**
 * Why a stored rule is silent, or null while every account and code it names is still usable. One reason,
 * the first found: the Durchlaufkonto first, then the legs in order. An `ignore` rule names none.
 */
function invalidReasonOfRule(
  ctx: WorkspaceContext,
  legs: readonly RecipeLeg[] | null,
  viaAccountId: string | null,
  accounts: ReadonlyMap<string, AccountRow>,
  ledgers: ReadonlySet<string>,
): BankRuleInvalidReason | null {
  if (legs === null) return 'recipe_unreadable';
  if (viaAccountId !== null) {
    const via = accounts.get(viaAccountId);
    if (via === undefined || via.archived === 1) return 'account_archived';
    if (invalidViaReason(ctx, via, ledgers) !== null) return 'account_not_bookable';
  }
  for (const leg of legs) {
    const account = accounts.get(leg.accountId);
    if (account === undefined || account.archived === 1) return 'account_archived';
    if (invalidAccountReason(ctx, account, ledgers) !== null) return 'account_not_bookable';
    if (leg.taxCode !== null) {
      if (!taxCodeIsActive(ctx, leg.taxCode)) return 'tax_code_inactive';
      if (!vatCanApplyToAccount(account, ledgers)) return 'vat_not_applicable';
    }
  }
  return null;
}

const STANDARD_SELECT = `SELECT s.id, s.counterparty_key, s.counterparty_label, s.direction, s.account_id, s.tax_code,
        s.set_by, s.set_at, s.superseded_at, s.label, s.match_text, s.legs_json, s.via_account_id,
        s.scope, s.outcome, s.ignore_reason, s.ignore_note, s.follow_up_standard_id
   FROM bank_standard s`;

/**
 * D176: the live Vorlage a follow-up names, by id; when that row was since edited (superseded), the live
 * Vorlage that now holds its label slot, so an edit that keeps the name keeps the next step. Null when there
 * is none (cleared, or renamed away). Tenant-bound.
 */
export function resolveFollowUp(ctx: WorkspaceContext, followUpId: string | null): { standardId: string; label: string } | null {
  if (followUpId === null) return null;
  type Named = { id: string; counterparty_key: string; label: string | null; superseded_at: string | null };
  const named = ctx.store.db
    .prepare("SELECT id, counterparty_key, label, superseded_at FROM bank_standard WHERE workspace_id = ? AND id = ? AND scope = 'manual'")
    .get(ctx.workspaceId, followUpId) as Named | undefined;
  if (named === undefined) return null;
  const live =
    named.superseded_at === null
      ? named
      : (ctx.store.db
          .prepare("SELECT id, counterparty_key, label, superseded_at FROM bank_standard WHERE workspace_id = ? AND scope = 'manual' AND counterparty_key = ? AND superseded_at IS NULL")
          .get(ctx.workspaceId, named.counterparty_key) as Named | undefined);
  return live === undefined ? null : { standardId: live.id, label: live.label ?? '' };
}

function toStandard(ctx: WorkspaceContext, r: StandardRow, accounts: ReadonlyMap<string, AccountRow>, ledgers: ReadonlySet<string>): BankStandard {
  const legs = recipeOfRow(r);
  const named = (id: string) => accounts.get(id);
  const ignore = r.outcome === 'ignore';
  const manual = r.scope === 'manual';
  const rest = ignore ? undefined : named(r.account_id);
  const via = r.via_account_id === null ? undefined : named(r.via_account_id);
  const followUp = resolveFollowUp(ctx, r.follow_up_standard_id);
  return {
    id: r.id,
    scope: r.scope,
    outcome: r.outcome,
    counterpartyKey: manual ? null : r.counterparty_key,
    counterpartyLabel: manual ? null : r.counterparty_label,
    direction: manual ? null : r.direction,
    label: r.label,
    matchText: r.match_text,
    viaAccountId: r.via_account_id,
    viaAccountNumber: via?.number ?? null,
    viaAccountName: via?.name ?? null,
    legs: (legs ?? []).map((l) => ({ ...l, accountNumber: named(l.accountId)?.number ?? '', accountName: named(l.accountId)?.name ?? '' })),
    invalidReason: invalidReasonOfRule(ctx, legs, r.via_account_id, accounts, ledgers),
    ignoreReason: ignore ? (r.ignore_reason as BankLineIgnoreReason) : null,
    ignoreNote: ignore ? r.ignore_note : null,
    followUpStandardId: followUp?.standardId ?? null,
    followUpLabel: followUp?.label ?? null,
    accountId: ignore ? null : r.account_id,
    accountNumber: ignore ? null : (rest?.number ?? ''),
    accountName: ignore ? null : (rest?.name ?? ''),
    taxCode: ignore ? null : r.tax_code,
    setBy: r.set_by,
    setAt: r.set_at,
  };
}

function liveRuleFor(ctx: WorkspaceContext, key: string, direction: BankStandardDirection, matchText: string | null): StandardRow | undefined {
  // The slot is (key, direction, text); a Vorlage's key carries its own prefix, so the slot names its scope.
  return ctx.store.db
    .prepare(
      `${STANDARD_SELECT} WHERE s.workspace_id = ? AND s.counterparty_key = ? AND s.direction = ? AND COALESCE(s.match_text, '') = ? AND s.superseded_at IS NULL`,
    )
    .get(ctx.workspaceId, key, direction, matchText ?? '') as StandardRow | undefined;
}

/** One live rule of this workspace (§H-TENANT), or undefined: another workspace's id, a superseded one. */
export function readLiveRule(ctx: WorkspaceContext, standardId: string): StandardRow | undefined {
  return ctx.store.db.prepare(`${STANDARD_SELECT} WHERE s.workspace_id = ? AND s.id = ? AND s.superseded_at IS NULL`).get(ctx.workspaceId, standardId) as
    | StandardRow
    | undefined;
}

/** One rule of this workspace by id, live or superseded (§H-TENANT): what a decision's `rule_id` names. */
/**
 * Critic D176-C1: why a stored rule cannot be used NOW (an account archived or turned into a Bankkonto's
 * ledger, a control or VAT account since it was saved, a code gone), or null while it can. The same check
 * `list_bank_standards` reports as `invalidReason`, read for one row at the moment it would book.
 */
export function ruleInvalidReason(ctx: WorkspaceContext, row: StandardRow): BankRuleInvalidReason | null {
  return invalidReasonOfRule(ctx, recipeOfRow(row), row.via_account_id, accountsById(ctx), bankLedgerIds(ctx));
}

export function readRuleRow(ctx: WorkspaceContext, standardId: string): StandardRow | undefined {
  return ctx.store.db.prepare(`${STANDARD_SELECT} WHERE s.workspace_id = ? AND s.id = ?`).get(ctx.workspaceId, standardId) as StandardRow | undefined;
}

// --- The read side: what the ladder and the inbox use ---------------------------------------------

/** One live rule as the ladder reads it. */
export interface LiveRule {
  id: string;
  label: string | null;
  matchText: string | null;
  viaAccountId: string | null;
  /** The recipe; empty when unreadable (then `usable` is false), and for an `ignore` rule. */
  legs: RecipeLeg[];
  /** False when an account or code it names is no longer valid: the rule is silent on the ladder. */
  usable: boolean;
  /** D176: `legs`, or `ignore` with its reason and note. */
  outcome: BankRuleOutcome;
  ignoreReason: BankLineIgnoreReason | null;
  ignoreNote: string | null;
}

/**
 * Every live BANK rule of the workspace (never a Vorlage: it has no line to speak on), keyed
 * `<counterpartyKey>|<direction>`, each list newest first: one read per context (and one for the accounts).
 */
export function liveRulesIndex(ctx: WorkspaceContext): Map<string, LiveRule[]> {
  const rows = ctx.store.db
    .prepare(`${STANDARD_SELECT} WHERE s.workspace_id = ? AND s.superseded_at IS NULL AND s.scope = 'bank' ORDER BY s.set_at DESC, s.rowid DESC`)
    .all(ctx.workspaceId) as StandardRow[];
  const index = new Map<string, LiveRule[]>();
  if (rows.length === 0) return index;
  const accounts = accountsById(ctx);
  const ledgers = bankLedgerIds(ctx);
  for (const r of rows) {
    const legs = recipeOfRow(r);
    const usable = invalidReasonOfRule(ctx, legs, r.via_account_id, accounts, ledgers) === null;
    const key = `${r.counterparty_key}|${r.direction}`;
    const list = index.get(key) ?? [];
    list.push({
      id: r.id,
      label: r.label,
      matchText: r.match_text,
      viaAccountId: r.via_account_id,
      legs: legs ?? [],
      usable,
      outcome: r.outcome,
      ignoreReason: r.outcome === 'ignore' ? (r.ignore_reason as BankLineIgnoreReason) : null,
      ignoreNote: r.outcome === 'ignore' ? r.ignore_note : null,
    });
    index.set(key, list);
  }
  return index;
}

/** The index key of a line: its counterparty key and direction, or null when it has no counterparty. */
export function standardKeyOfLine(row: BankTxnRow, detail: ReturnType<typeof readBankTxnDetail>): string | null {
  const key = counterpartyKeyOf(row, detail);
  return key === null ? null : `${key}|${directionOf(row)}`;
}

// --- list_bank_standards -------------------------------------------------------------------------

/**
 * Every LIVE rule, newest first, valid or not: a rule that went quiet carries its `invalidReason`, so a
 * surface can say why (D175). D176: `scope` narrows to the bank rules or the Vorlagen (default both). The
 * registry's A24 gate asserts the read right, like `list_bank_inbox`.
 */
export type ListBankStandardsOk = { standards: BankStandard[] };

export function listBankStandards(ctx: WorkspaceContext, input: { scope?: unknown } = {}): Result<ListBankStandardsOk> {
  const scope = input.scope;
  if (scope !== undefined && scope !== null && !(BANK_RULE_SCOPES as readonly unknown[]).includes(scope)) {
    return err('invalid_input', { field: 'scope', allowed: [...BANK_RULE_SCOPES] });
  }
  const scoped = typeof scope === 'string';
  const rows = ctx.store.db
    .prepare(`${STANDARD_SELECT} WHERE s.workspace_id = ? AND s.superseded_at IS NULL ${scoped ? 'AND s.scope = ?' : ''} ORDER BY s.set_at DESC, s.rowid DESC`)
    .all(...(scoped ? [ctx.workspaceId, scope] : [ctx.workspaceId])) as StandardRow[];
  const accounts = accountsById(ctx);
  const ledgers = bankLedgerIds(ctx);
  return ok<ListBankStandardsOk>({ standards: rows.map((r) => toStandard(ctx, r, accounts, ledgers)) });
}

// --- set_bank_standard ---------------------------------------------------------------------------

export interface SetBankStandardInput {
  /** The line a bank rule is saved from (its counterparty and direction). Never with a Vorlage. */
  bankTxnId?: string;
  /** D176: EDIT this live rule (supersede it) instead of saving from a line. */
  standardId?: string;
  /** D176: `bank` (default) or `manual` (a Vorlage). */
  scope?: string;
  /** D176: `legs` (default) or `ignore` (bank scope only). */
  outcome?: string;
  /** D176: the reason an `ignore` rule proposes (one of `BANK_LINE_IGNORE_REASONS`). */
  ignoreReason?: string | null;
  /** D176: the note an `ignore` rule proposes. */
  ignoreNote?: string | null;
  /** D176: the Vorlage offered as the next step once the line is decided (bank scope only). */
  followUpStandardId?: string | null;
  /** D167: the one account (ignored when `legs` is given). */
  accountId?: string;
  /** D167: its code, or null for no MWST (ignored when `legs` is given). */
  taxCode?: string | null;
  /** D175: the rule's name (required for a Vorlage). */
  label?: string | null;
  /** D175: only lines whose remittance text contains this (stored folded). */
  matchText?: string | null;
  /** D175: the Durchlaufkonto. */
  viaAccountId?: string | null;
  /** D175: the recipe; without it the rule is the one rest leg of `accountId` and `taxCode`. */
  legs?: unknown;
  /**
   * Critic D176-C2, R2-1: a Vorlage saved (or renamed) onto a name another live Vorlage holds replaces that
   * one only when the caller NAMES it: the id of the Vorlage it means to replace, as `label_taken` reported
   * it. When the row holding the name at write time is another one (the person edited it since), the save
   * refuses `label_taken` again with the current holder, so a drafted save never replaces a Vorlage its
   * author did not see. A bare `replace` flag is refused (`invalid_input`).
   */
  replaceStandardId?: string | null;
  /** Retired by critic D176-R2-1: refused with `invalid_input`, naming `replaceStandardId`. */
  replace?: unknown;
  idempotencyKey?: string;
}

export type SetBankStandardOk = { standard: BankStandard; supersededId: string | null; unchanged: boolean };

function invalidRecipe(detail: BankRuleRecipeDetail, extra: Record<string, unknown> = {}): Err {
  return err('invalid_recipe', { detail, ...extra });
}

/**
 * The SHAPE of a recipe (no database read). Bank scope: 1 to 20 legs, no side. Manual scope (D176): 2 to 20
 * legs, every leg with its side, no `against`. Each leg: an account id, an optional code, an amount that is
 * the rest, asked under a non-blank label of at most 40 characters, or the same as another ASKED leg, an
 * optional `against` (never on the rest leg) and an optional description of at most 120; exactly one rest.
 */
function shapeLegs(raw: unknown, scope: BankRuleScope): { legs: RecipeLeg[] } | { error: Err } {
  const min = scope === 'manual' ? BANK_VORLAGE_MIN_LEGS : 1;
  if (!Array.isArray(raw) || raw.length < min || raw.length > BANK_RULE_MAX_LEGS) {
    return { error: invalidRecipe('legs_count', { reason: `${min} to ${BANK_RULE_MAX_LEGS} legs` }) };
  }
  const legs: RecipeLeg[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const l = raw[i] as Record<string, unknown> | null;
    if (typeof l !== 'object' || l === null || Array.isArray(l)) return { error: invalidRecipe('leg_shape', { legIndex: i }) };
    const accountId = l['accountId'];
    if (typeof accountId !== 'string' || accountId.length === 0) return { error: invalidRecipe('leg_shape', { legIndex: i, field: 'accountId' }) };
    const code = l['taxCode'];
    if (code !== undefined && code !== null && (typeof code !== 'string' || code.trim().length === 0)) {
      return { error: invalidRecipe('leg_shape', { legIndex: i, field: 'taxCode' }) };
    }
    const taxCode = typeof code === 'string' && code.trim() !== 'none' ? code.trim() : null;
    const amount = l['amount'] as Record<string, unknown> | null | undefined;
    if (
      typeof amount !== 'object' ||
      amount === null ||
      (amount['kind'] !== 'rest' && amount['kind'] !== 'ask' && amount['kind'] !== 'same' && amount['kind'] !== 'factor')
    ) {
      return { error: invalidRecipe('leg_shape', { legIndex: i, field: 'amount' }) };
    }
    let parsed: RecipeAmount;
    if (amount['kind'] === 'factor') {
      const factor = shapeFactor(amount, i, scope);
      if ('error' in factor) return factor;
      parsed = factor.amount;
    } else if (amount['kind'] === 'ask') {
      const label = typeof amount['label'] === 'string' ? amount['label'].trim() : '';
      if (label.length === 0 || label.length > BANK_RULE_ASK_LABEL_MAX) {
        return { error: invalidRecipe('ask_label', { legIndex: i, maxLength: BANK_RULE_ASK_LABEL_MAX }) };
      }
      parsed = { kind: 'ask', label };
    } else if (amount['kind'] === 'same') {
      const target = amount['legIndex'];
      if (!Number.isSafeInteger(target) || (target as number) < 0 || (target as number) >= raw.length || target === i) {
        return { error: invalidRecipe('same_target', { legIndex: i, reason: 'same names another leg of the recipe by its index' }) };
      }
      parsed = { kind: 'same', legIndex: target as number };
    } else {
      parsed = { kind: 'rest' };
    }
    const against = l['against'];
    if (against !== undefined && typeof against !== 'boolean') return { error: invalidRecipe('leg_shape', { legIndex: i, field: 'against' }) };
    if (against === true && parsed.kind === 'rest') return { error: invalidRecipe('against_on_rest', { legIndex: i }) };
    if (against === true && scope === 'manual') {
      return { error: invalidRecipe('side', { legIndex: i, reason: 'a Vorlage states each leg\'s side; against is a bank rule\'s' }) };
    }
    const sideRaw = l['side'];
    let side: RecipeSide | undefined;
    if (scope === 'manual') {
      if (sideRaw !== 'debit' && sideRaw !== 'credit') return { error: invalidRecipe('side', { legIndex: i, allowed: [...RECIPE_SIDES] }) };
      side = sideRaw;
    } else if (sideRaw !== undefined && sideRaw !== null) {
      return { error: invalidRecipe('side', { legIndex: i, reason: 'a bank rule\'s legs follow the line\'s direction; side is a Vorlage\'s' }) };
    }
    const description = l['description'];
    if (description !== undefined && description !== null && (typeof description !== 'string' || description.length > BANK_RULE_LEG_DESCRIPTION_MAX)) {
      return { error: invalidRecipe('description', { legIndex: i, maxLength: BANK_RULE_LEG_DESCRIPTION_MAX }) };
    }
    const text = typeof description === 'string' ? description.trim() : '';
    legs.push({
      accountId,
      taxCode,
      amount: parsed,
      ...(side !== undefined ? { side } : {}),
      ...(against === true ? { against: true } : {}),
      ...(text !== '' ? { description: text } : {}),
    });
  }
  const rests = legs.filter((l) => l.amount.kind === 'rest').length;
  if (rests !== 1) return { error: invalidRecipe('rest_count', { restLegs: rests, reason: 'exactly one leg is the rest' }) };
  // D176: `same` copies an ASKED amount; a rest or another `same` has no amount of its own to copy.
  for (let i = 0; i < legs.length; i += 1) {
    const a = (legs[i] as RecipeLeg).amount;
    if (a.kind === 'same' && legs[a.legIndex]?.amount.kind !== 'ask') {
      return { error: invalidRecipe('same_target', { legIndex: i, reason: 'same names an asked leg' }) };
    }
  }
  return { legs };
}

/** D177 (critic D177-C5): the largest `num` or `den` a computed amount may name. */
export const BANK_RULE_FACTOR_TERM_MAX = 1_000_000;
/** D177 (critic D177-C5): a computed amount is at most this many times the line (`num` <= this x `den`). */
export const BANK_RULE_FACTOR_RATIO_MAX = 1000;

/** D177: the largest basis-point figure an `explain` may give (100 %). */
export const BANK_RULE_FACTOR_EXPLAIN_MAX_BP = 10000;

/**
 * D177 (A39 §16.1): the SHAPE of a computed amount, `{ kind: 'factor', label, num, den, explain? }`. The label
 * as an ask's (non-blank, at most 40 characters), `num` and `den` positive safe integers, `explain` an
 * optional object of `vatBp` and `feeBp` (integers 0 to 10000, nothing else). Bank scope only: a Vorlage has
 * no line amount to compute from. Every fault answers `invalid_recipe` detail `factor` naming the field.
 */
function shapeFactor(amount: Record<string, unknown>, legIndex: number, scope: BankRuleScope): { amount: RecipeAmount } | { error: Err } {
  const fault = (field: string, reason: string) => ({ error: invalidRecipe('factor', { legIndex, field, reason }) });
  if (scope === 'manual') return fault('amount', 'a Vorlage has no line amount to compute from; ask for the amount instead');
  const label = typeof amount['label'] === 'string' ? amount['label'].trim() : '';
  if (label.length === 0 || label.length > BANK_RULE_ASK_LABEL_MAX) return fault('label', `a name of 1 to ${BANK_RULE_ASK_LABEL_MAX} characters`);
  const num = amount['num'];
  const den = amount['den'];
  if (!Number.isSafeInteger(num) || (num as number) <= 0) return fault('num', 'a positive whole number');
  if (!Number.isSafeInteger(den) || (den as number) <= 0) return fault('den', 'a positive whole number');
  // Critic D177-C5: bounded at save time, so |line| x num / den can never leave a safe integer for any line
  // a bank reports (the result is at most 1000 times the line).
  if ((num as number) > BANK_RULE_FACTOR_TERM_MAX) return fault('num', `a whole number up to ${BANK_RULE_FACTOR_TERM_MAX}`);
  if ((den as number) > BANK_RULE_FACTOR_TERM_MAX) return fault('den', `a whole number up to ${BANK_RULE_FACTOR_TERM_MAX}`);
  if ((num as number) > BANK_RULE_FACTOR_RATIO_MAX * (den as number)) {
    return fault('num', `the computed amount is at most ${BANK_RULE_FACTOR_RATIO_MAX} times the line (num up to ${BANK_RULE_FACTOR_RATIO_MAX} x den)`);
  }
  const explainRaw = amount['explain'];
  let explain: RecipeFactorExplain | undefined;
  if (explainRaw !== undefined && explainRaw !== null) {
    if (typeof explainRaw !== 'object' || Array.isArray(explainRaw)) return fault('explain', 'an object { vatBp?, feeBp? }');
    const e = explainRaw as Record<string, unknown>;
    for (const k of Object.keys(e)) if (k !== 'vatBp' && k !== 'feeBp') return fault(`explain.${k}`, 'explain holds vatBp and feeBp only');
    const bp = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= BANK_RULE_FACTOR_EXPLAIN_MAX_BP;
    if (e['vatBp'] !== undefined && !bp(e['vatBp'])) return fault('explain.vatBp', `basis points, 0 to ${BANK_RULE_FACTOR_EXPLAIN_MAX_BP}`);
    if (e['feeBp'] !== undefined && !bp(e['feeBp'])) return fault('explain.feeBp', `basis points, 0 to ${BANK_RULE_FACTOR_EXPLAIN_MAX_BP}`);
    explain = canonicalExplain({
      ...(e['vatBp'] !== undefined ? { vatBp: e['vatBp'] as number } : {}),
      ...(e['feeBp'] !== undefined ? { feeBp: e['feeBp'] as number } : {}),
    });
  }
  return { amount: { kind: 'factor', label, num: num as number, den: den as number, ...(explain !== undefined ? { explain } : {}) } };
}

/**
 * D177 (A39 §16.1): a computed amount on a line: round-half-up(|line| x num / den) in Rappen, in EXACT
 * integer arithmetic (BigInt, so no product is ever rounded by a float). Positive for a positive line;
 * 0 only for a line too small for the fraction. Null when the result is beyond a safe integer.
 */
export function factorAmountMinor(lineMinor: number, num: number, den: number): number | null {
  const a = BigInt(Math.abs(lineMinor));
  const n = BigInt(num);
  const d = BigInt(den);
  // floor(a*n/d + 1/2) = floor((2*a*n + d) / (2*d)), every operand a non-negative integer.
  const q = (2n * a * n + d) / (2n * d);
  return q > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(q);
}

/**
 * D177: one computed leg of a recipe on a line (the shape `reasonParams.computed` carries). `overflow: true`
 * (critic D177-C5) when the amount is beyond a safe integer: `amountMinor` is then 0 and the booking refuses
 * `rule_not_applicable` with `factor_overflow`. The save-time bounds make that unreachable for any real line.
 */
export type ComputedLeg = { legIndex: number; label: string; amountMinor: number; explain: RecipeFactorExplain | null; overflow?: true };

/** D177: every computed (`factor`) leg of a recipe with its amount on a line of `lineMinor`, in recipe order. */
export function computedLegsOf(legs: readonly RecipeLeg[], lineMinor: number): ComputedLeg[] {
  const out: ComputedLeg[] = [];
  for (let i = 0; i < legs.length; i += 1) {
    const a = (legs[i] as RecipeLeg).amount;
    if (a.kind !== 'factor') continue;
    const amount = factorAmountMinor(lineMinor, a.num, a.den);
    out.push({ legIndex: i, label: a.label, amountMinor: amount ?? 0, explain: a.explain ?? null, ...(amount === null ? { overflow: true as const } : {}) });
  }
  return out;
}

/** An optional short text input: absent or null is null, a blank string is null, a string is trimmed. */
function optionalShortText(value: unknown, field: string, max: number): { value: string | null } | { error: Err } {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== 'string') return { error: err('invalid_input', { field }) };
  const trimmed = value.trim();
  if (trimmed.length > max) return { error: err('invalid_input', { field, maxLength: max }) };
  return { value: trimmed.length === 0 ? null : trimmed };
}

/** Where the new row goes, and from what: the slot, the label shown, and the row an edit supersedes. */
interface SetTarget {
  key: string;
  direction: BankStandardDirection;
  counterpartyLabel: string;
  /** The account an `ignore` rule stores in the NOT NULL `account_id` (nothing books to it). */
  placeholderAccountId: string;
  edited: StandardRow | null;
}

/** The per-leg account and code checks (D167 `invalid_account`, `vat_not_applicable`), by recipe. */
function checkLegs(ctx: WorkspaceContext, legs: readonly RecipeLeg[], ledgers: ReadonlySet<string>): Err | null {
  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i] as RecipeLeg;
    const account = readAccount(ctx, leg.accountId);
    if (account === undefined) return err('not_found', { field: `legs[${i}].accountId`, accountId: leg.accountId });
    const invalid = invalidAccountReason(ctx, account, ledgers);
    if (invalid !== null) return invalidRecipe('invalid_account', { legIndex: i, accountId: account.id, accountNumber: account.number, reason: invalid });
    if (leg.taxCode !== null) {
      if (!taxCodeIsActive(ctx, leg.taxCode)) return invalidRecipe('invalid_tax_code', { legIndex: i, taxCode: leg.taxCode });
      if (!vatCanApplyToAccount(account, ledgers)) {
        return invalidRecipe('vat_not_applicable', { legIndex: i, accountId: account.id, accountNumber: account.number, taxCode: leg.taxCode });
      }
    }
  }
  return null;
}

/**
 * Save a Buchungsregel. A BANK rule is saved from one line (`bankTxnId`: its counterparty and direction), or
 * EDITS a live bank rule (`standardId`: its counterparty and direction, no line needed, D176). Called with
 * only `accountId` and `taxCode` it is exactly D167. A MANUAL Vorlage (D176) takes `label` and `legs` (every
 * leg with its side), never a line; `standardId` edits one. Either way the new row supersedes the live one of
 * its slot (and an edit the edited one) in the same transaction; the same recipe, label, text, Durchlaufkonto,
 * outcome and follow-up as the live row of the slot answers `unchanged: true` and writes nothing.
 */
export function setBankStandard(ctx: WorkspaceContext, input: SetBankStandardInput): Result<SetBankStandardOk> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const scopeRaw = input.scope ?? 'bank';
  if (!(BANK_RULE_SCOPES as readonly unknown[]).includes(scopeRaw)) return err('invalid_input', { field: 'scope', allowed: [...BANK_RULE_SCOPES] });
  const scope = scopeRaw as BankRuleScope;
  const outcomeRaw = input.outcome ?? 'legs';
  if (!(BANK_RULE_OUTCOMES as readonly unknown[]).includes(outcomeRaw)) return err('invalid_input', { field: 'outcome', allowed: [...BANK_RULE_OUTCOMES] });
  const outcome = outcomeRaw as BankRuleOutcome;
  const editing = input.standardId !== undefined && input.standardId !== null;
  const withLegs = input.legs !== undefined && input.legs !== null;

  const keyGuard = requireString(input.idempotencyKey, 'idempotencyKey');
  if (keyGuard) return keyGuard;
  if (editing) {
    const g = requireString(input.standardId, 'standardId');
    if (g) return g;
  }
  if (scope === 'manual') {
    // A Vorlage has no line: no counterparty, no direction, no text, no Durchlaufkonto, no other outcome.
    for (const field of ['bankTxnId', 'matchText', 'viaAccountId', 'followUpStandardId', 'ignoreReason', 'ignoreNote', 'accountId'] as const) {
      const v = input[field];
      if (v !== undefined && v !== null) return err('invalid_input', { field, reason: 'a Vorlage (scope manual) has no line, no text, no Durchlaufkonto, no follow-up and no single account: name its legs' });
    }
    if (outcome !== 'legs') return invalidRecipe('ignore_outcome', { reason: '"Nicht buchen" is a bank rule\'s outcome; a Vorlage books' });
    if (!withLegs) return invalidRecipe('legs_count', { reason: `${BANK_VORLAGE_MIN_LEGS} to ${BANK_RULE_MAX_LEGS} legs` });
    if (typeof input.label !== 'string' || input.label.trim().length === 0) return err('invalid_input', { field: 'label', reason: 'a Vorlage needs a name' });
  } else {
    if (editing === (input.bankTxnId !== undefined && input.bankTxnId !== null)) {
      return err('invalid_input', { field: 'bankTxnId', reason: 'save a bank rule from a line (bankTxnId) or edit one (standardId), exactly one of the two' });
    }
    if (!editing) {
      const g = requireString(input.bankTxnId, 'bankTxnId');
      if (g) return g;
    }
    if (outcome === 'ignore') {
      if (withLegs || (input.accountId !== undefined && input.accountId !== null) || (input.viaAccountId !== undefined && input.viaAccountId !== null)) {
        return invalidRecipe('ignore_outcome', { reason: 'a "Nicht buchen" rule books nothing: no legs, no account, no Durchlaufkonto' });
      }
      if (!(BANK_LINE_IGNORE_REASONS as readonly unknown[]).includes(input.ignoreReason)) {
        return invalidRecipe('ignore_outcome', { field: 'ignoreReason', allowed: [...BANK_LINE_IGNORE_REASONS] });
      }
    } else {
      if (input.ignoreReason !== undefined && input.ignoreReason !== null) return err('invalid_input', { field: 'ignoreReason', reason: 'only a "Nicht buchen" rule (outcome ignore) has a reason' });
      if (input.ignoreNote !== undefined && input.ignoreNote !== null) return err('invalid_input', { field: 'ignoreNote', reason: 'only a "Nicht buchen" rule (outcome ignore) has a note' });
      if (!withLegs) {
        const g = requireString(input.accountId, 'accountId');
        if (g) return g;
      }
    }
  }
  const rawCode = input.taxCode;
  if (!withLegs && rawCode !== undefined && rawCode !== null && (typeof rawCode !== 'string' || rawCode.trim().length === 0)) {
    return err('invalid_input', { field: 'taxCode', reason: 'a code, or null for no MWST' });
  }
  const label = optionalShortText(input.label, 'label', BANK_RULE_LABEL_MAX);
  if ('error' in label) return label.error;
  const rawText = optionalShortText(input.matchText, 'matchText', BANK_RULE_MATCH_TEXT_MAX);
  if ('error' in rawText) return rawText.error;
  // Critic D175-C4: a text is matched as whole tokens, so one without a letter or a digit could never match.
  // Critic D175-R2-2: it is STORED as its tokens joined by one space, the canonical form the match reads, so
  // two texts that match exactly the same lines ("muster shop", "Muster-Shop!") are one live slot of the
  // one-live index (`COALESCE(match_text, '')`) and the second supersedes the first.
  const textTokensOf = rawText.value === null ? null : textTokens(rawText.value);
  if (textTokensOf !== null && textTokensOf.length === 0) {
    return err('invalid_input', { field: 'matchText', reason: 'a match text needs at least one letter or digit' });
  }
  const matchText = textTokensOf === null ? null : textTokensOf.join(' ');
  const via = input.viaAccountId;
  if (via !== undefined && via !== null && (typeof via !== 'string' || via.length === 0)) return err('invalid_input', { field: 'viaAccountId' });
  const viaAccountId = typeof via === 'string' ? via : null;
  const note = optionalShortText(input.ignoreNote, 'ignoreNote', BANK_RULE_IGNORE_NOTE_MAX);
  if ('error' in note) return note.error;
  if (input.replace !== undefined && input.replace !== null) {
    return err('invalid_input', { field: 'replace', reason: 'name the Vorlage to replace with replaceStandardId (its id, as label_taken reports it)' });
  }
  const replaceRaw = input.replaceStandardId;
  if (replaceRaw !== undefined && replaceRaw !== null && (typeof replaceRaw !== 'string' || replaceRaw.length === 0)) {
    return err('invalid_input', { field: 'replaceStandardId', reason: 'the id of the Vorlage to replace' });
  }
  const replaceStandardId = typeof replaceRaw === 'string' ? replaceRaw : null;
  if (replaceStandardId !== null && scope !== 'manual') {
    return err('invalid_input', { field: 'replaceStandardId', reason: 'only a Vorlage (scope manual) replaces another by name' });
  }
  const follow = input.followUpStandardId;
  if (follow !== undefined && follow !== null && (typeof follow !== 'string' || follow.length === 0)) return err('invalid_input', { field: 'followUpStandardId' });
  const followUpStandardId = typeof follow === 'string' ? follow : null;
  let legs: RecipeLeg[];
  if (outcome === 'ignore') {
    legs = [];
  } else if (withLegs) {
    const shaped = shapeLegs(input.legs, scope);
    if ('error' in shaped) return shaped.error;
    legs = shaped.legs;
  } else {
    const code = typeof rawCode === 'string' ? rawCode.trim() : null;
    legs = [{ accountId: input.accountId as string, taxCode: code, amount: { kind: 'rest' } }];
  }
  let vorlageKey: string | null = null;
  if (scope === 'manual') {
    vorlageKey = vorlageKeyOf(label.value ?? '');
    if (vorlageKey === null) return err('invalid_input', { field: 'label', reason: 'a Vorlage\'s name needs at least one letter or digit' });
  }

  // The D175 replay key, byte for byte, for a rule saved from a line; an edit or a Vorlage memoises under its own.
  const scopedKey =
    !editing && scope === 'bank'
      ? JSON.stringify(['set_bank_standard', input.bankTxnId, input.idempotencyKey])
      : JSON.stringify(['set_bank_standard', scope, input.standardId ?? null, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result<SetBankStandardOk>>(ctx.workspaceId, scopedKey, 'set_bank_standard');
  if (replayed !== undefined) return replayed;

  // Where the row goes.
  let target: SetTarget;
  if (editing) {
    const edited = readLiveRule(ctx, input.standardId as string);
    if (edited === undefined) return err('rule_not_found', { standardId: input.standardId, reason: 'no live rule of this workspace has this id (another workspace\'s, or already superseded)' });
    if (edited.scope !== scope) {
      return err('wrong_scope', { standardId: edited.id, scope: edited.scope, reason: scope === 'manual' ? 'this is a bank rule, not a Vorlage' : 'this is a Vorlage, not a bank rule' });
    }
    target =
      scope === 'manual'
        ? { key: vorlageKey as string, direction: VORLAGE_DIRECTION, counterpartyLabel: label.value as string, placeholderAccountId: edited.account_id, edited }
        : {
            key: edited.counterparty_key,
            direction: edited.direction,
            counterpartyLabel: edited.counterparty_label,
            // Critic D176-C3: an ignore row's placeholder is always a Bankkonto ledger (§15.6). An ignore row
            // edited keeps its own; a rule that booked and becomes "Nicht buchen" by an edit has no line to
            // read it from, so it takes the ledger of the workspace's oldest Bankkonto (the one rule for edits).
            placeholderAccountId: edited.outcome === 'ignore' ? edited.account_id : oldestBankLedger(ctx),
            edited,
          };
  } else if (scope === 'manual') {
    target = { key: vorlageKey as string, direction: VORLAGE_DIRECTION, counterpartyLabel: label.value as string, placeholderAccountId: '', edited: null };
  } else {
    const row = readBankTxn(ctx, input.bankTxnId as string);
    if (row === undefined) return err('not_found', { bankTxnId: input.bankTxnId });
    const detail = readBankTxnDetail(ctx, row.id);
    const key = counterpartyKeyOf(row, detail);
    if (key === null) {
      return err('no_counterparty', { bankTxnId: row.id, reason: 'the line names no counterparty IBAN and no name, so a standard has nothing to recognise it by' });
    }
    const ledger = ctx.store.db.prepare('SELECT ledger_account_id FROM bank_account WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, row.bank_account_id) as
      | { ledger_account_id: string }
      | undefined;
    target = {
      key,
      direction: directionOf(row),
      counterpartyLabel: (detail?.counterparty_name ?? row.payer_name ?? '').trim() || (detail?.counterparty_iban ?? '').trim() || key,
      placeholderAccountId: ledger?.ledger_account_id ?? '',
      edited: null,
    };
  }

  const ledgers = bankLedgerIds(ctx);
  if (outcome === 'legs') {
    // D167's one-account path keeps D167's own refusal codes, byte for byte.
    if (!withLegs) {
      const leg = legs[0] as RecipeLeg;
      const account = readAccount(ctx, leg.accountId);
      if (account === undefined) return err('not_found', { accountId: leg.accountId });
      const invalid = invalidAccountReason(ctx, account, ledgers);
      if (invalid !== null) return err('invalid_account', { accountId: account.id, accountNumber: account.number, reason: invalid });
      if (leg.taxCode !== null) {
        if (!taxCodeIsActive(ctx, leg.taxCode)) return err('invalid_tax_code', { taxCode: leg.taxCode });
        if (!vatCanApplyToAccount(account, ledgers)) {
          return err('vat_not_applicable', { accountId: account.id, accountNumber: account.number, taxCode: leg.taxCode, reason: 'MWST cannot apply to a booking on this account' });
        }
      }
    } else {
      const bad = checkLegs(ctx, legs, ledgers);
      if (bad !== null) return bad;
    }
  }
  if (viaAccountId !== null) {
    const viaAccount = readAccount(ctx, viaAccountId);
    if (viaAccount === undefined) return err('not_found', { field: 'viaAccountId', accountId: viaAccountId });
    const invalid = invalidViaReason(ctx, viaAccount, ledgers);
    if (invalid !== null) return invalidRecipe('via_account', { accountId: viaAccount.id, accountNumber: viaAccount.number, reason: invalid });
    if (legs.some((l) => l.accountId === viaAccount.id)) {
      return invalidRecipe('via_account', { accountId: viaAccount.id, accountNumber: viaAccount.number, reason: 'via_is_a_leg' });
    }
  }
  if (followUpStandardId !== null) {
    // §H-TENANT: another workspace's id reads as no Vorlage, exactly like a gone one.
    const next = readLiveRule(ctx, followUpStandardId);
    if (next === undefined || next.scope !== 'manual') {
      return invalidRecipe('follow_up', { followUpStandardId, reason: 'the next step is a live Vorlage of this workspace' });
    }
  }
  if (outcome === 'ignore' && target.placeholderAccountId === '') {
    return err('needs_bank_account', { bankTxnId: input.bankTxnId, reason: 'the line\'s Bankkonto has no ledger account' });
  }
  const restAt = restLegIndex(legs);
  const rest = restAt >= 0 ? (legs[restAt] as RecipeLeg) : null;
  // A D167 call (no legs) stores no recipe JSON, so the row is exactly the D167 row it always was; an ignore
  // rule stores an empty recipe.
  const legsJson = outcome === 'ignore' ? '[]' : withLegs ? canonicalLegs(legs) : null;
  const ignoreReason = outcome === 'ignore' ? (input.ignoreReason as string) : null;
  const ignoreNote = outcome === 'ignore' ? note.value : null;

  const same = (live: StandardRow): boolean => {
    const liveLegs = recipeOfRow(live);
    return (
      liveLegs !== null &&
      canonicalLegs(liveLegs) === canonicalLegs(legs) &&
      live.label === label.value &&
      live.via_account_id === viaAccountId &&
      live.scope === scope &&
      live.outcome === outcome &&
      live.ignore_reason === ignoreReason &&
      live.ignore_note === ignoreNote &&
      live.follow_up_standard_id === followUpStandardId
    );
  };
  // Critic D176-C2: a new Vorlage, or a rename, onto a name ANOTHER live Vorlage holds would supersede that
  // one silently (and repoint the next steps that named it). It is refused, naming the holder, unless the
  // caller names that very holder in `replaceStandardId` (critic R2-1: the holder at WRITE time, so an
  // approval after the person edited the Vorlage refuses rather than replace the edit). An edit that keeps
  // its own name is no collision, and the very same Vorlage saved again is `unchanged`. Checked before the
  // memo, so a refusal is never memoised.
  if (scope === 'manual') {
    const holder = liveRuleFor(ctx, target.key, target.direction, null);
    if (holder !== undefined && holder.id !== target.edited?.id && !(target.edited === null && same(holder)) && holder.id !== replaceStandardId) {
      return err('label_taken', {
        standardId: holder.id,
        label: holder.label,
        ...(replaceStandardId !== null ? { expectedStandardId: replaceStandardId } : {}),
        reason:
          replaceStandardId !== null
            ? 'the Vorlage holding this name is not the one replaceStandardId names (it changed since); look again'
            : 'another Vorlage already has this name; name it in replaceStandardId to replace it, or choose another name',
      });
    }
  }

  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'set_bank_standard', () => {
    const accounts = accountsById(ctx);
    const slot = liveRuleFor(ctx, target.key, target.direction, matchText);
    // Unchanged: the slot's live row already says exactly this (and an edit names that very row).
    if (slot !== undefined && same(slot) && (target.edited === null || target.edited.id === slot.id)) {
      return ok<SetBankStandardOk>({ standard: toStandard(ctx, slot, accounts, ledgers), supersededId: null, unchanged: true });
    }
    const now = ctx.clock.now();
    const supersede = ctx.store.db.prepare(
      'UPDATE bank_standard SET superseded_at = ?, superseded_by = ? WHERE workspace_id = ? AND id = ? AND superseded_at IS NULL',
    );
    if (target.edited !== null) supersede.run(now, ctx.actor, ctx.workspaceId, target.edited.id);
    if (slot !== undefined && slot.id !== target.edited?.id) supersede.run(now, ctx.actor, ctx.workspaceId, slot.id);
    const id = ctx.ids.next('bstd');
    ctx.store.db
      .prepare(
        `INSERT INTO bank_standard (id, workspace_id, counterparty_key, counterparty_label, direction, account_id, tax_code, set_by, set_at,
                                    label, match_text, legs_json, via_account_id, scope, outcome, ignore_reason, ignore_note, follow_up_standard_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        target.key,
        target.counterpartyLabel,
        target.direction,
        rest !== null ? rest.accountId : target.placeholderAccountId,
        rest !== null ? rest.taxCode : null,
        ctx.actor,
        now,
        label.value,
        matchText,
        legsJson,
        viaAccountId,
        scope,
        outcome,
        ignoreReason,
        ignoreNote,
        followUpStandardId,
      );
    const written = readLiveRule(ctx, id) as StandardRow;
    return ok<SetBankStandardOk>({
      standard: toStandard(ctx, written, accounts, ledgers),
      supersededId: target.edited?.id ?? slot?.id ?? null,
      unchanged: false,
    });
  });
}

// --- clear_bank_standard -------------------------------------------------------------------------

export interface ClearBankStandardInput {
  standardId?: string;
  idempotencyKey?: string;
}

export type ClearBankStandardOk = { standardId: string; cleared: true } | { standardId: string; alreadyCleared: true };

/** Retire a rule (its supersession stamp, never a delete). An already retired one answers `alreadyCleared`. */
export function clearBankStandard(ctx: WorkspaceContext, input: ClearBankStandardInput): Result<ClearBankStandardOk> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const guard = requireString(input.standardId, 'standardId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const scopedKey = JSON.stringify(['clear_bank_standard', input.standardId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result<ClearBankStandardOk>>(ctx.workspaceId, scopedKey, 'clear_bank_standard');
  if (replayed !== undefined) return replayed;
  const row = ctx.store.db
    .prepare('SELECT id, superseded_at FROM bank_standard WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.standardId) as { id: string; superseded_at: string | null } | undefined;
  if (row === undefined) return err('not_found', { standardId: input.standardId });
  if (row.superseded_at !== null) return ok<ClearBankStandardOk>({ standardId: row.id, alreadyCleared: true });
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'clear_bank_standard', () => {
    const changed = ctx.store.db
      .prepare('UPDATE bank_standard SET superseded_at = ?, superseded_by = ? WHERE workspace_id = ? AND id = ? AND superseded_at IS NULL')
      .run(ctx.clock.now(), ctx.actor, ctx.workspaceId, row.id).changes;
    return changed === 1
      ? ok<ClearBankStandardOk>({ standardId: row.id, cleared: true })
      : ok<ClearBankStandardOk>({ standardId: row.id, alreadyCleared: true });
  });
}
