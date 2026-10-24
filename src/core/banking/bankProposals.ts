/**
 * A39, the proposal on an open bank line (spec §4.3): what the inbox pre-fills, how sure it is, and why,
 * as stable keys the Studio renders (the engine returns no prose, P11).
 *
 * THE PRIORITY IS THE POINT. The strongest fact wins, and each rung only speaks when every stronger one
 * is silent:
 *   (a) an entry ALREADY on the bank ledger account that no line accounts for, same signed amount,
 *       within 10 days: the money is booked, only the link is missing (`sure` when a reference proves
 *       it: a TILL payment with the line's QR/SCOR reference, an A18 item's EndToEndId, its run's
 *       PmtInfId; `check` otherwise, because an amount and a date alone could be a second payment);
 *   (b) a reference: an A18 run in the line's currency by an item's EndToEndId or the run's PmtInfId,
 *       the A21 QR score of a credit, the A36 vendor-bill ranking of a debit (`sure` only when a
 *       reference and the amount agree);
 *   (c) the counterparty IBAN is one of the workspace's own Bankkonten: a transfer, ALWAYS `check`
 *       (D139): the first side proposes the transfer entry, the other side then matches that entry;
 *   (c2) D167/D175: the person's BUCHUNGSREGEL for this counterparty and direction (`bankStandards.ts`):
 *       one complete rule is `sure` (owner pick 1A: it counts for the one bulk button because a person
 *       made it; setting `bank.buchungsregel_mode` = `suggest` makes it `check`), a rule that asks for an
 *       amount is `check` (`rule_needs_amount`), several candidates are the person's pick (`several_rules`);
 *       D176: a "Nicht buchen" rule proposes ignoring the line with its reason and note (`rule_ignore`,
 *       `check`, or `sure` under `bank.buchungsregel_ignore_mode` = `bulk`); D177: a rule whose only unknowns
 *       are computed amounts proposes them (`rule_computed`, `check`, or `sure` under
 *       `bank.buchungsregel_computed_mode` = `bulk`);
 *   (d) history: the account and VAT code this counterparty was booked to last time, with the count:
 *       `learned`;
 *   (d2) D167: the journal: the newest posted entry on this bank ledger, same direction, whose text
 *       carries the counterparty's normalised name, `check` (a migrated book suggests from day one);
 *   (d') D144 (spec §12): a calibrated model's recorded choice among code-built candidate accounts
 *       (`bankModelRung.ts`), ALWAYS `check` (a probability is not a reference), and only while the
 *       model that recorded it is the one registered now; with no fit model the rung is silent;
 *   (e) nothing: `open`.
 *
 * `sure` IS RESERVED FOR A REFERENCE-PROVEN MATCH (owner answer 2: "Alle sicheren buchen" stays
 * limited to reference-proven matches), with ONE exception since D167: a complete rule the person set (c2), and since D176 a "Nicht buchen" rule when the person chose `bulk` for it. A reversal-flagged line is capped at `check`: a returned
 * movement is always a human's call.
 *
 * Pure reads, §H-TENANT on every query. One `ProposalContext` per inbox page, so the claimed-entry set,
 * the own-account IBANs and the history index are read once, not once per line.
 */

import type { WorkspaceContext } from '../context.js';
import { normalizeIban } from '../setup/iban.js';
import type { Result } from '../result.js';
import { resolveRole, isRejection } from '../payments/accounts.js';
import { matchIncomingByQrr } from './qrMatch.js';
import { rankDebitCandidates, readCamtMatchConfig } from './debitRanking.js';
import type { CamtMatchConfig } from './debitRanking.js';
import { HAS_REVERSAL_SQL, bankLegsOf, claimedLegs, lineBookingDate, signedAmountOf } from './bankLines.js';
import type { BankLineIgnoreReason, BankTxnDetailRow, BankTxnRow, BookBankLineTarget, ClaimedLegs } from './bankLines.js';
import { modelRungContext, modelRungProposal } from './bankModelRung.js';
import type { ModelRungContext } from './bankModelRung.js';
import { computedLegsOf, liveRulesIndex, restLegIndex, standardKeyOfLine, suggestionTargetUsable, VAT_ACCOUNT_NUMBERS } from './bankStandards.js';
import type { LiveRule } from './bankStandards.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { getSetting } from '../settings/settings.js';
import { readLineFee } from './statementFacts.js';
import { duplicatePendingIds } from './statementDedupe.js';
import type { BankLineLeg } from './bankLines.js';

export const BANK_PROPOSAL_CERTAINTIES = ['sure', 'learned', 'check', 'open'] as const;
export type BankProposalCertainty = (typeof BANK_PROPOSAL_CERTAINTIES)[number];

export const BANK_PROPOSAL_REASONS = [
  'existing_entry_reference',
  'existing_entry_amount_date',
  'qr_reference_exact',
  'qr_reference_amount_differs',
  'payment_batch_reference',
  'payment_batch_total_differs',
  'payment_batch_item',
  'payment_batch_item_amount_differs',
  'vendor_bill_reference',
  'vendor_bill_amount',
  'own_account_transfer',
  'own_account_transfer_booked',
  'standard',
  // D175 (A39 §14.3): one rule that asks for an amount (`check`, never bulk-booked), and the person's pick
  // among several rules (or rules none of whose text the line carries).
  'rule_needs_amount',
  'several_rules',
  // D176 (A39 §15.3): a "Nicht buchen" rule proposes ignoring the line with its reason and note (`check`
  // by default, `sure` under `bank.buchungsregel_ignore_mode` = `bulk`); A36 always asks a person.
  'rule_ignore',
  // D177 (A39 §16.1): one rule whose only unknowns are COMPUTED amounts (`factor` legs, nothing asked):
  // target { kind: 'rule', standardId, asks: {} }, `check` by default, `sure` under
  // `bank.buchungsregel_computed_mode` = `bulk`; `reasonParams.computed` names each computed leg.
  'rule_computed',
  'history',
  'journal_history',
  'model_suggested',
  'no_proposal',
] as const;
export type BankProposalReason = (typeof BANK_PROPOSAL_REASONS)[number];

/** One asked leg of a rule a proposal names (D175): its index in the recipe and its label. */
export type BankProposalAsk = { legIndex: number; label: string };

/**
 * D177 (A39 §16.1): one COMPUTED leg of a rule a proposal names: its index in the recipe, its label, the
 * amount the engine computed on THIS line (positive Rappen, round-half-up(|line| x num / den)), and the
 * words the recipe gave it (`explain`, null when none).
 */
export type BankProposalComputed = {
  legIndex: number;
  label: string;
  amountMinor: number;
  explain: { vatBp?: number; feeBp?: number } | null;
  /** Critic D177-C5: present (true) only when the amount is beyond a safe integer; `amountMinor` is then 0. */
  overflow?: true;
};

export type BankProposalParamValue =
  | string
  | number
  | boolean
  | null
  | readonly string[]
  | readonly BankProposalAsk[]
  | readonly BankProposalComputed[];

export type BankProposalParams = Record<string, BankProposalParamValue>;

/** D175 (A39 §14.4): the values of `bank.buchungsregel_mode` (the registry entry is the schema). */
export type BankRuleMode = 'bulk' | 'suggest';

/**
 * D176 (A39 §15.3): what a "Nicht buchen" rule proposes. NOT a `book_bank_line` target: the line is decided
 * by `ignore_bank_line { reason, note, standardId }`, which the proposal carries.
 */
export type BankIgnoreProposalTarget = { kind: 'ignore'; reason: BankLineIgnoreReason; note: string | null; standardId: string };

/** What a proposal may name: a `book_bank_line` target, or (D176) the ignore a "Nicht buchen" rule proposes. */
export type BankProposalTarget = BookBankLineTarget | BankIgnoreProposalTarget;

export type BankLineProposal = {
  target: BankProposalTarget | null;
  certainty: BankProposalCertainty;
  reasonCode: BankProposalReason;
  reasonParams: BankProposalParams;
  vatCode: string | null;
  /**
   * D178 point 3 (A39 §19, A20 §11.5): present only on a DEBIT whose statement names a fee inside its
   * amount, under `bank.fx_mode` `propose_split` or `prefill_split`. Absent otherwise (no key).
   */
  feeSplit?: BankFeeSplit;
};

/** D178 (A20 §11.5): the values of `bank.fx_mode` (the registry entry is the schema). */
export const BANK_FX_MODES = ['propose_split', 'prefill_split', 'facts_only', 'transaction_currency'] as const;
export type BankFxMode = (typeof BANK_FX_MODES)[number];

/**
 * D178 point 3 (A20 §11.5): the fee of a card payment split off the line: the fee on the workspace's
 * bank-charges account, the rest on the account the ladder proposed (keeping its MWST code; the fee has
 * none, a bank charge being an exempt financial service, Art. 21 Abs. 2 Ziff. 19 MWSTG).
 */
export type BankFeeSplit = {
  mode: 'propose_split' | 'prefill_split';
  /** Positive, in the line's currency; with `restMinor` it sums to the line. */
  feeMinor: number;
  restMinor: number;
  currency: string;
  /** The bank-charges account (setting `bank.fee_account`, else 6940, else 6900), or null when the chart has none. */
  feeAccountId: string | null;
  /** The account the ladder proposed for the line, or null when it proposed none. */
  restAccountId: string | null;
  restTaxCode: string | null;
  /** The two `accounts` legs, ready for `book_bank_line`, when both accounts are known; else null. */
  legs: BankLineLeg[] | null;
  /** True when the proposal's target IS the split (`prefill_split` on a one-leg accounts proposal). */
  applied: boolean;
  /** Where the fee was read: the statement's charges, or the card text. */
  origin: 'charges' | 'text';
};

/**
 * D178 (A20 §11.5): the bank-charges account resolved in the CHART, never by an id: the account numbers
 * that play the role, in order. 6940 Bankspesen is the KMU chart's bank-charges account; TILL's core
 * seed ships none and carries bank charges on 6900 Finanzaufwand (`kmuSeed.ts`, D142).
 */
export const BANK_FEE_ROLE_NUMBERS: readonly string[] = ['6940', '6900'];

/** The existing-entry window (spec §4.3 (a)): an entry dated within this many days of the line. */
export const EXISTING_ENTRY_WINDOW_DAYS = 10;

interface OwnAccount {
  bankAccountId: string;
  ledgerAccountId: string;
  iban: string;
}

interface HistoryHit {
  accountId: string;
  taxCode: string | null;
  date: string;
}

export interface ProposalContext {
  config: CamtMatchConfig;
  claimed: ClaimedLegs;
  ownAccounts: OwnAccount[];
  history: Map<string, HistoryHit[]>;
  ledgerOf: Map<string, { ledgerAccountId: string; openingEntryId: string | null }>;
  /** D144: the registered model's recorded decisions, or null when no fit model is registered. */
  model: ModelRungContext | null;
  /**
   * D167: what only the two new rungs read, built on FIRST USE and memoised here (`standardsOf`,
   * `journalOf`, `baseCurrencyOfPc`). A context whose lines are all placed by an earlier rung, and the
   * per-line context `lineNeedsReview` builds on import, never pay for the journal read.
   */
  lazy: {
    readonly accounts: readonly { ledger_account_id: string; opening_entry_id: string | null }[];
    /** False: the ladder without the journal rung (d2), what A36's review signal reads (critic D167-1). */
    readonly withJournal: boolean;
    standards?: Map<string, LiveRule[]>;
    journal?: JournalHit[];
    baseCurrency?: string;
    /** D175: the workspace's `bank.buchungsregel_mode`, read once per context. */
    ruleMode?: BankRuleMode;
    /** D176: the workspace's `bank.buchungsregel_ignore_mode`, read once per context. */
    ignoreMode?: BankRuleMode;
    /** D177: the workspace's `bank.buchungsregel_computed_mode`, read once per context. */
    computedMode?: BankRuleMode;
    /** D178: the workspace's `bank.fx_mode`, read once per context. */
    fxMode?: BankFxMode;
    /** D178: the bank-charges account id (null: the chart has none), resolved once per context. */
    feeAccountId?: string | null;
    /** D178 point 19: the lines flagged as a possible duplicate and not decided "Kein Duplikat". */
    duplicatePending?: ReadonlySet<string>;
  };
}

/** D178: `bank.fx_mode` (memoised); an unknown stored value reads as the default. */
function fxModeOf(ctx: WorkspaceContext, pc: ProposalContext): BankFxMode {
  if (pc.lazy.fxMode === undefined) {
    const v = getSetting<string>(ctx, 'bank.fx_mode');
    pc.lazy.fxMode = (BANK_FX_MODES as readonly string[]).includes(v) ? (v as BankFxMode) : 'propose_split';
  }
  return pc.lazy.fxMode;
}

/** D178: a live (non-archived) account of this workspace by its number, or null. §H-TENANT. */
function liveAccountIdByNumber(ctx: WorkspaceContext, number: string): string | null {
  const row = ctx.store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ? AND archived = 0')
    .get(ctx.workspaceId, number) as { id: string } | undefined;
  return row?.id ?? null;
}

/** D178 (A20 §11.5): the setting `bank.fee_account`, else the chart's role numbers in order (memoised). */
function feeAccountOf(ctx: WorkspaceContext, pc: ProposalContext): string | null {
  if (pc.lazy.feeAccountId === undefined) {
    // Critic L3: every candidate passes the ladder's own guard (`suggestionTargetUsable`): an account a
    // person could book the line to, never the bank ledger itself or another account `book_bank_line`
    // refuses. A configured number that fails it falls back exactly like one that names no live account.
    const usable = (id: string | null): string | null => (id !== null && suggestionTargetUsable(ctx, id, null) ? id : null);
    const configured = String(getSetting<string>(ctx, 'bank.fee_account') ?? '').trim();
    let id = configured === '' ? null : usable(liveAccountIdByNumber(ctx, configured));
    for (const n of BANK_FEE_ROLE_NUMBERS) {
      if (id !== null) break;
      id = usable(liveAccountIdByNumber(ctx, n));
    }
    pc.lazy.feeAccountId = id;
  }
  return pc.lazy.feeAccountId;
}

/**
 * D178 point 3 (A20 §11.5): after every rung, a DEBIT whose statement names a fee INSIDE its amount
 * (smaller than it, in its currency) gets `feeSplit`. `propose_split` offers it beside the proposal;
 * `prefill_split` makes it the target when the ladder proposed exactly one accounts leg (the certainty
 * never changes, so the bulk button books only what it already would have); `facts_only` and, until its
 * node lands, `transaction_currency` add nothing. A settlement, a rule, an ignore and an existing split are
 * left as they are; a credit (a fee deducted from money in) gets none.
 */
function withFeeSplit(ctx: WorkspaceContext, pc: ProposalContext, row: BankTxnRow, p: BankLineProposal): BankLineProposal {
  if (row.credit_debit !== 'DBIT') return p;
  const mode = fxModeOf(ctx, pc);
  if (mode !== 'propose_split' && mode !== 'prefill_split') return p;
  if (p.target !== null && p.target.kind !== 'accounts') return p;
  if (p.target !== null && p.target.legs.length !== 1) return p;
  const fee = readLineFee(ctx, row.id);
  if (fee === null || fee.included !== true || fee.currency !== row.currency) return p;
  if (fee.amountMinor <= 0 || fee.amountMinor >= row.amount_minor) return p;
  const leg = p.target === null ? null : (p.target.legs[0] as BankLineLeg);
  const feeAccountId = feeAccountOf(ctx, pc);
  // A line the ladder already books to the bank-charges account is a fee line: nothing to split off it.
  if (leg !== null && leg.accountId === feeAccountId) return p;
  const restMinor = row.amount_minor - fee.amountMinor;
  const restTaxCode = leg?.taxCode ?? null;
  const legs: BankLineLeg[] | null =
    leg !== null && feeAccountId !== null
      ? [
          { ...leg, amountMinor: restMinor },
          { accountId: feeAccountId, amountMinor: fee.amountMinor },
        ]
      : null;
  const applied = mode === 'prefill_split' && legs !== null && p.target !== null;
  const split: BankFeeSplit = {
    mode,
    feeMinor: fee.amountMinor,
    restMinor,
    currency: row.currency,
    feeAccountId,
    restAccountId: leg?.accountId ?? null,
    restTaxCode,
    legs,
    applied,
    origin: fee.origin,
  };
  if (applied && p.target !== null && p.target.kind === 'accounts') {
    return { ...p, target: { ...p.target, legs: legs as BankLineLeg[] }, feeSplit: split };
  }
  return { ...p, feeSplit: split };
}

/** D167/D175: every live rule of the context's workspace, keyed `<counterpartyKey>|<direction>`, newest first (memoised). */
export function standardsOf(ctx: WorkspaceContext, pc: ProposalContext): Map<string, LiveRule[]> {
  return (pc.lazy.standards ??= liveRulesIndex(ctx));
}

/** D175: `bank.buchungsregel_mode` (memoised): `bulk` lets a complete rule be `sure`, `suggest` never. */
function ruleModeOf(ctx: WorkspaceContext, pc: ProposalContext): BankRuleMode {
  return (pc.lazy.ruleMode ??= getSetting<string>(ctx, 'bank.buchungsregel_mode') === 'suggest' ? 'suggest' : 'bulk');
}

/** D177: `bank.buchungsregel_computed_mode` (memoised): `bulk` lets a computed-only rule be `sure`; `suggest` (the default) never. */
function computedModeOf(ctx: WorkspaceContext, pc: ProposalContext): BankRuleMode {
  return (pc.lazy.computedMode ??= getSetting<string>(ctx, 'bank.buchungsregel_computed_mode') === 'bulk' ? 'bulk' : 'suggest');
}

/** D176: `bank.buchungsregel_ignore_mode` (memoised): `bulk` lets a "Nicht buchen" rule be `sure`; `suggest` (the default) never. */
function ignoreModeOf(ctx: WorkspaceContext, pc: ProposalContext): BankRuleMode {
  return (pc.lazy.ignoreMode ??= getSetting<string>(ctx, 'bank.buchungsregel_ignore_mode') === 'bulk' ? 'bulk' : 'suggest');
}

/** D167: the journal rung's index (memoised). */
function journalOf(ctx: WorkspaceContext, pc: ProposalContext): JournalHit[] {
  return (pc.lazy.journal ??= journalIndex(ctx, pc.lazy.accounts));
}

/** The workspace's base currency (memoised): a taxed suggestion on a line in another currency drops its code. */
function baseCurrencyOfPc(ctx: WorkspaceContext, pc: ProposalContext): string {
  return (pc.lazy.baseCurrency ??= baseCurrencyOf(ctx));
}

/** One posted entry on a bank ledger, as the journal rung (d2) reads it. */
interface JournalHit {
  entryId: string;
  date: string;
  /** Every bank ledger the entry moves, with the sign of that movement (+1 debit, money in). */
  ledgerSigns: Map<string, 1 | -1>;
  /** The folded tokens of the entry's text. */
  tokens: Set<string>;
  /** The main leg: the largest leg off every bank ledger and VAT account, never a control account. */
  accountId: string;
  taxCode: string | null;
}

/** The journal rung's bound: the newest entries on the bank ledgers it reads (a hint, not an audit). */
export const JOURNAL_HISTORY_LIMIT = 2000;

const LEGAL_FORM_STOPWORDS = new Set(['ag', 'gmbh', 'sa', 'sarl', 'sagl', 'ltd', 'inc', 'the', 'und', 'co', 'kg']);

/** Lowercase, fold diacritics, collapse whitespace: the ONE text form history compares in. */
export function foldText(s: string | null | undefined): string {
  if (s === null || s === undefined) return '';
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** The normalised counterparty name history groups by: folded, legal forms dropped, tokens joined. */
export function normalisedName(name: string | null): string | null {
  const folded = foldText(name);
  if (folded.length === 0) return null;
  const tokens = folded.split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !LEGAL_FORM_STOPWORDS.has(t));
  return tokens.length === 0 ? null : tokens.join(' ');
}

/** The counterparty key of a line (IBAN, else the normalised name), or null when it has neither. */
export function counterpartyKeyOf(row: BankTxnRow, detail: BankTxnDetailRow | undefined): string | null {
  const iban = detail?.counterparty_iban ?? null;
  if (iban !== null && iban.length > 0) return `iban:${normalizeIban(iban)}`;
  const name = normalisedName(detail?.counterparty_name ?? row.payer_name);
  return name === null ? null : `name:${name}`;
}

/**
 * Build the per-page context once. `withModel: false` builds the ladder WITHOUT the model rung: what
 * `suggest_bank_lines` reads to find the lines that end at `open` today. `withJournal: false` builds it
 * without the journal rung (d2): what A36's review signal reads (D167, critic D167-1).
 */
export function proposalContext(ctx: WorkspaceContext, opts: { withModel?: boolean; withJournal?: boolean } = {}): ProposalContext {
  const accounts = ctx.store.db
    .prepare('SELECT id, iban, ledger_account_id, opening_entry_id FROM bank_account WHERE workspace_id = ?')
    .all(ctx.workspaceId) as { id: string; iban: string; ledger_account_id: string; opening_entry_id: string | null }[];
  const ledgerOf = new Map<string, { ledgerAccountId: string; openingEntryId: string | null }>();
  for (const a of accounts) ledgerOf.set(a.id, { ledgerAccountId: a.ledger_account_id, openingEntryId: a.opening_entry_id });
  return {
    config: readCamtMatchConfig(ctx),
    claimed: claimedLegs(ctx),
    ownAccounts: accounts.map((a) => ({ bankAccountId: a.id, ledgerAccountId: a.ledger_account_id, iban: normalizeIban(a.iban) })),
    history: historyIndex(ctx),
    ledgerOf,
    model: opts.withModel === false ? null : modelRungContext(ctx),
    lazy: { accounts, withJournal: opts.withJournal !== false },
  };
}

/** The tokens a text is matched in: folded, split on everything that is not a letter or a digit. */
function tokensOf(text: string | null): Set<string> {
  // The journal rung (d2) keeps `foldText` as it is: it compares with `normalisedName`, which strips the
  // diaeresis ("muller"), so the rule text's umlaut spelling below must not reach it.
  return new Set(foldText(text).split(/[^a-z0-9]+/).filter((t) => t.length > 0));
}

/** The German umlauts, written as the two letters a Swiss bank text transliterates them to. */
const UMLAUT_SPELLING: Readonly<Record<string, string>> = {
  'ä': 'ae',
  'ö': 'oe',
  'ü': 'ue',
  'Ä': 'ae',
  'Ö': 'oe',
  'Ü': 'ue',
};

/**
 * The tokens of a Buchungsregel's match text and of a line's remittance, in order (D175, A39 §14.3). The same
 * folding as `foldText`, except that an umlaut becomes its two-letter spelling FIRST (critic D175-R2-3): a
 * camt remittance often arrives transliterated, so a rule saved as "Gebühr" and the bank's two-letter form
 * of it must give the same token, on both sides. Only the rule rung reads this.
 */
export function textTokens(text: string | null | undefined): string[] {
  if (text === null || text === undefined) return [];
  const spelled = text.normalize('NFC').replace(/[äöüÄÖÜ]/g, (c) => UMLAUT_SPELLING[c] ?? c);
  return foldText(spelled).split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

/**
 * D175 (A39 §14.3, critic D175-C4): does `haystack` carry `needle` as WHOLE, CONSECUTIVE tokens? "shop"
 * matches "MUSTER SHOP 7" but never "WORKSHOP KURSGELD"; an empty needle matches nothing.
 */
export function containsTokenRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0) return false;
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    if (needle.every((t, k) => haystack[i + k] === t)) return true;
  }
  return false;
}

/**
 * D167 (spec §13.2 (d2)): the newest posted entries, not a reversal and not reversed, that move a bank
 * ledger account, each with its text tokens, the sign it moves each bank ledger with, and its main leg
 * chosen exactly as `historyIndex` does (largest leg first; the bank ledgers and VAT accounts are passed
 * over; an entry whose main leg is a control account is left out). The opening entries of the Bankkonten
 * are left out (an opening balance names no counterparty). One read for the entries, one per 500 for
 * their legs.
 */
function journalIndex(ctx: WorkspaceContext, accounts: readonly { ledger_account_id: string; opening_entry_id: string | null }[]): JournalHit[] {
  const ledgers = [...new Set(accounts.map((a) => a.ledger_account_id))];
  if (ledgers.length === 0) return [];
  const openings = new Set(accounts.map((a) => a.opening_entry_id).filter((id): id is string => id !== null));
  // From the bank-ledger legs (`journal_line_account`) to their entries, with ONE anti-join on
  // `reverses_entry_id` (its index) for "not reversed", rather than a correlated EXISTS per entry.
  const entries = ctx.store.db
    .prepare(
      `SELECT e.id AS id, e.date AS date, e.description AS description
         FROM journal_entry e
         LEFT JOIN journal_entry rv
           ON rv.workspace_id = e.workspace_id AND rv.reverses_entry_id = e.id AND rv.status = 'posted'
        WHERE e.id IN (SELECT b.entry_id FROM journal_line b WHERE b.account_id IN (${ledgers.map(() => '?').join(', ')}))
          AND e.workspace_id = ? AND e.status = 'posted' AND e.reverses_entry_id IS NULL AND rv.id IS NULL
        GROUP BY e.id
        ORDER BY e.date DESC, e.rowid DESC
        LIMIT ${JOURNAL_HISTORY_LIMIT}`,
    )
    .all(...ledgers, ctx.workspaceId) as { id: string; date: string; description: string | null }[];
  const ledgerSet = new Set(ledgers);
  const vatAccounts = new Set(
    (
      ctx.store.db
        .prepare(`SELECT id FROM account WHERE workspace_id = ? AND number IN (${VAT_ACCOUNT_NUMBERS.map(() => '?').join(', ')})`)
        .all(ctx.workspaceId, ...VAT_ACCOUNT_NUMBERS) as { id: string }[]
    ).map((r) => r.id),
  );
  const controlAccounts = new Set(
    (['receivable', 'payable'] as const)
      .map((role) => resolveRole(ctx, role))
      .filter((r): r is Exclude<ReturnType<typeof resolveRole>, Result> => !isRejection(r))
      .map((r) => r.id),
  );
  const legsByEntry = new Map<string, { accountId: string; taxCode: string | null; debit: number; credit: number }[]>();
  const ids = entries.filter((e) => !openings.has(e.id)).map((e) => e.id);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const found = ctx.store.db
      .prepare(
        `SELECT entry_id AS entryId, account_id AS accountId, tax_code AS taxCode, debit_minor AS debit, credit_minor AS credit
           FROM journal_line WHERE entry_id IN (${chunk.map(() => '?').join(', ')})
          ORDER BY entry_id, (debit_minor + credit_minor) DESC, rowid`,
      )
      .all(...chunk) as { entryId: string; accountId: string; taxCode: string | null; debit: number; credit: number }[];
    for (const l of found) {
      const list = legsByEntry.get(l.entryId) ?? [];
      list.push({ accountId: l.accountId, taxCode: l.taxCode, debit: l.debit, credit: l.credit });
      legsByEntry.set(l.entryId, list);
    }
  }
  const hits: JournalHit[] = [];
  for (const e of entries) {
    const legs = legsByEntry.get(e.id);
    if (legs === undefined) continue;
    const net = new Map<string, number>();
    for (const l of legs) if (ledgerSet.has(l.accountId)) net.set(l.accountId, (net.get(l.accountId) ?? 0) + l.debit - l.credit);
    const ledgerSigns = new Map<string, 1 | -1>();
    for (const [ledger, n] of net) if (n !== 0) ledgerSigns.set(ledger, n > 0 ? 1 : -1);
    if (ledgerSigns.size === 0) continue;
    const main = legs.find((l) => !ledgerSet.has(l.accountId) && !vatAccounts.has(l.accountId));
    if (main === undefined || controlAccounts.has(main.accountId)) continue;
    hits.push({ entryId: e.id, date: e.date, ledgerSigns, tokens: tokensOf(e.description), accountId: main.accountId, taxCode: main.taxCode });
  }
  return hits;
}

/**
 * (c2) D167/D175: the person's Buchungsregel for this counterparty and direction. Silent when there is no
 * live rule or every one went stale (an account archived or no longer a valid target, a code gone or
 * archived): the line falls through to history.
 *
 * WHICH RULE (A39 §14.3). The candidates are the valid rules for the line's key and direction; a rule with a
 * match text is a candidate only when the line's FOLDED REMITTANCE TEXT contains it (never the payer name:
 * two businesses can share one payer, D175 point 3), and once any text rule is a candidate the rules
 * without text drop out. One candidate speaks; several, or valid rules none of which is a candidate, are
 * the person's pick (`several_rules`, no target).
 *
 * WHAT IT SAYS. A complete rule (nothing asked, so its one leg is the rest) proposes `accounts` with the
 * full amount, via its Durchlaufkonto when it has one, `sure` under `bank.buchungsregel_mode` = `bulk` and
 * `check` under `suggest`. A rule with asked legs proposes the `rule` target with no amounts filled,
 * `check`, reason `rule_needs_amount`: not bookable until the asks are filled, never bulk-booked. A taxed
 * rule on a line outside the base currency reads `check` with `vatDropped` (a complete rule drops its code:
 * `book_bank_line` refuses VAT there, and nothing may book gross by itself).
 */
function standardProposal(ctx: WorkspaceContext, pc: ProposalContext, row: BankTxnRow, detail: BankTxnDetailRow | undefined): BankLineProposal | null {
  const key = standardKeyOfLine(row, detail);
  if (key === null) return null;
  const live = standardsOf(ctx, pc).get(key) ?? [];
  if (live.length === 0) return null;
  // Critic D175-C1: the text decides WHICH rule a line belongs to before validity is asked. The match runs
  // over every live rule; a matching text rule that went invalid (an archived account, a gone code) keeps
  // the rung silent, and its line never falls back to the text-less rule, which may be another business's
  // account behind the same payer (D175 point 3).
  // Critic D175-C4: whole consecutive tokens of the folded remittance, never a substring.
  const text = textTokens(detail?.remittance_text);
  const byText = live.filter((r) => r.matchText !== null && containsTokenRun(text, textTokens(r.matchText)));
  const candidates = byText.length > 0 ? byText : live.filter((r) => r.matchText === null);
  if (candidates.some((r) => !r.usable)) return null;
  const rules = live.filter((r) => r.usable);
  if (rules.length === 0) return null;
  if (candidates.length !== 1) {
    return {
      target: null,
      certainty: 'check',
      reasonCode: 'several_rules',
      reasonParams: { standardIds: (candidates.length > 1 ? candidates : rules).map((r) => r.id) },
      vatCode: null,
    };
  }
  const rule = candidates[0]!;
  // D176 (A39 §15.3): a "Nicht buchen" rule proposes the ignore, never a booking. `check` unless the person
  // chose `bulk` for it (an ignored line never reaches the ledger, so a mistaken bulk ignore hides money).
  if (rule.outcome === 'ignore') {
    return {
      target: { kind: 'ignore', reason: rule.ignoreReason ?? 'other', note: rule.ignoreNote, standardId: rule.id },
      certainty: ignoreModeOf(ctx, pc) === 'bulk' ? 'sure' : 'check',
      reasonCode: 'rule_ignore',
      reasonParams: { standardId: rule.id, reason: rule.ignoreReason ?? 'other', note: rule.ignoreNote },
      vatCode: null,
    };
  }
  const vatDropped = rule.legs.some((l) => l.taxCode !== null) && row.currency !== baseCurrencyOfPc(ctx, pc);
  const asks = rule.legs.flatMap((l, legIndex) => (l.amount.kind === 'ask' ? [{ legIndex, label: l.amount.label }] : []));
  // D177 (A39 §16.1): the computed legs, with their amounts on THIS line.
  const computed = computedLegsOf(rule.legs, row.amount_minor);
  if (asks.length > 0) {
    return {
      target: { kind: 'rule', standardId: rule.id, asks: {} },
      certainty: 'check',
      reasonCode: 'rule_needs_amount',
      reasonParams: { standardId: rule.id, asks, ...(computed.length > 0 ? { computed } : {}), ...(vatDropped ? { vatDropped: true } : {}) },
      vatCode: null,
    };
  }
  if (computed.length > 0) {
    // D177: nothing asked, every unknown computed. The `rule` target with no asks books the computed amounts
    // (`expandRule`); `check` under `bank.buchungsregel_computed_mode` = `suggest` (the default: an estimate
    // deserves a look) and `sure` under `bulk`. A proposal the booking would refuse as it stands (a line too
    // small for a fraction, a rest of 0) or one whose code a foreign-currency line drops is always `check`.
    const restAt = restLegIndex(rule.legs);
    const signed = computed.reduce((sum, c) => sum + (rule.legs[c.legIndex]?.against === true ? -c.amountMinor : c.amountMinor), 0);
    const bookable = restAt >= 0 && computed.every((c) => c.amountMinor > 0) && row.amount_minor - signed !== 0;
    return {
      target: { kind: 'rule', standardId: rule.id, asks: {} },
      certainty: bookable && !vatDropped && computedModeOf(ctx, pc) === 'bulk' ? 'sure' : 'check',
      reasonCode: 'rule_computed',
      reasonParams: { standardId: rule.id, computed, ...(vatDropped ? { vatDropped: true } : {}) },
      vatCode: null,
    };
  }
  // Nothing asked and nothing computed: every other kind needs an asked leg (`same` names one), so the recipe
  // is its ONE rest leg. Read it by the rest index, never by position (D177: the old `legs[0]`).
  const restAt = restLegIndex(rule.legs);
  if (restAt < 0 || rule.legs.length !== 1) return null;
  const leg = rule.legs[restAt]!;
  const taxCode = vatDropped ? null : leg.taxCode;
  return {
    target: {
      kind: 'accounts',
      legs: [
        {
          accountId: leg.accountId,
          amountMinor: row.amount_minor,
          ...(taxCode !== null ? { taxCode } : {}),
          ...(leg.description !== undefined ? { description: leg.description } : {}),
        },
      ],
      ...(rule.viaAccountId !== null ? { viaAccountId: rule.viaAccountId } : {}),
    },
    certainty: vatDropped || ruleModeOf(ctx, pc) === 'suggest' ? 'check' : 'sure',
    reasonCode: 'standard',
    reasonParams: {
      standardId: rule.id,
      accountId: leg.accountId,
      taxCode: leg.taxCode,
      ...(rule.viaAccountId !== null ? { viaAccountId: rule.viaAccountId } : {}),
      ...(vatDropped ? { vatDropped: true } : {}),
    },
    vatCode: taxCode,
  };
}

/**
 * (d2) D167: the newest posted entry on THIS line's bank ledger, moving it in the line's direction, whose
 * text carries every token of the line's normalised counterparty name. Always `check`.
 */
function journalProposal(ctx: WorkspaceContext, pc: ProposalContext, row: BankTxnRow, detail: BankTxnDetailRow | undefined): BankLineProposal | null {
  if (!pc.lazy.withJournal) return null;
  const name = normalisedName(detail?.counterparty_name ?? row.payer_name);
  const ledger = pc.ledgerOf.get(row.bank_account_id);
  if (name === null || ledger === undefined) return null;
  const wanted = name.split(' ');
  const sign = row.credit_debit === 'CRDT' ? 1 : -1;
  const matches = (h: JournalHit): boolean => h.ledgerSigns.get(ledger.ledgerAccountId) === sign && wanted.every((t) => h.tokens.has(t));
  const journal = journalOf(ctx, pc);
  const at = journal.findIndex(matches);
  if (at === -1) return null;
  const hit = journal[at]!;
  // Critic D167-5: a ONE-token name ("MIGROS") is also a word in unrelated texts ("Migros Bank
  // Hypothekarzins"), so it speaks only when CORROBORATED: the next older matching entry books the same
  // account. A recurring counterparty of a migrated book has many entries; a stray hit stays silent.
  if (wanted.length === 1) {
    let second: JournalHit | undefined;
    for (let i = at + 1; i < journal.length && second === undefined; i += 1) if (matches(journal[i]!)) second = journal[i];
    if (second === undefined || second.accountId !== hit.accountId) return null;
  }
  // Critic D167-3: the standard rung's guards. A main leg on an account that is archived or no longer a
  // valid target (or a code that is gone, archived or cannot apply there) keeps the rung silent rather
  // than prefill what `book_bank_line` refuses; a migrated book is the one that holds such entries.
  if (!suggestionTargetUsable(ctx, hit.accountId, hit.taxCode)) return null;
  // On a line outside the base currency the code is dropped, as (c2) does: no code can be booked there.
  const vatDropped = hit.taxCode !== null && row.currency !== baseCurrencyOfPc(ctx, pc);
  const taxCode = vatDropped ? null : hit.taxCode;
  return {
    target: {
      kind: 'accounts',
      legs: [{ accountId: hit.accountId, amountMinor: row.amount_minor, ...(taxCode !== null ? { taxCode } : {}) }],
    },
    certainty: 'check',
    reasonCode: 'journal_history',
    reasonParams: { accountId: hit.accountId, taxCode: hit.taxCode, entryId: hit.entryId, date: hit.date, ...(vatDropped ? { vatDropped: true } : {}) },
    vatCode: taxCode,
  };
}

/**
 * Every live `accounts` booking (and every adopted pre-A39 camt entry A20 created from a line), read off
 * the DECISION's declared `entry_id` (never a link's `target_id`, critic A39R2-1), grouped by the line's
 * counterparty key, newest first, each with the account and VAT code of the booking's
 * largest non-bank, non-VAT leg. Bounded to the most recent 2000 bookings: history is a hint, not an
 * audit.
 */
function historyIndex(ctx: WorkspaceContext): Map<string, HistoryHit[]> {
  const rows = ctx.store.db
    .prepare(
      `SELECT t.id AS txnId, t.payer_name, d2.counterparty_name, d2.counterparty_iban,
              e.id AS entryId, e.date AS date, t.bank_account_id AS bankAccountId
         FROM bank_line_decision d
         JOIN bank_txn t ON t.workspace_id = d.workspace_id AND t.id = d.bank_txn_id
         JOIN journal_entry e ON e.workspace_id = d.workspace_id AND e.id = d.entry_id
         LEFT JOIN bank_txn_detail d2 ON d2.workspace_id = t.workspace_id AND d2.bank_txn_id = t.id
        WHERE d.workspace_id = ? AND d.superseded_at IS NULL
          AND (d.target_kind = 'accounts' OR (d.target_kind = 'legacy' AND d.state = 'booked' AND e.source = 'camt'))
        ORDER BY e.date DESC, d.rowid DESC
        LIMIT 2000`,
    )
    .all(ctx.workspaceId) as {
    txnId: string;
    payer_name: string | null;
    counterparty_name: string | null;
    counterparty_iban: string | null;
    entryId: string;
    date: string;
    bankAccountId: string;
  }[];
  const vatAccounts = new Set(
    (
      ctx.store.db
        .prepare("SELECT id FROM account WHERE workspace_id = ? AND number IN ('1170', '1171', '2200')")
        .all(ctx.workspaceId) as { id: string }[]
    ).map((r) => r.id),
  );
  const bankLedger = new Map(
    (
      ctx.store.db.prepare('SELECT id, ledger_account_id FROM bank_account WHERE workspace_id = ?').all(ctx.workspaceId) as {
        id: string;
        ledger_account_id: string;
      }[]
    ).map((r) => [r.id, r.ledger_account_id]),
  );
  // Critic A39-9: every booking's legs in ONE read per 500 entries (the index used to query once per
  // booking, up to 2000 queries each time a context was built).
  const controlAccounts = new Set(
    (['receivable', 'payable'] as const)
      .map((role) => resolveRole(ctx, role))
      .filter((r): r is Exclude<ReturnType<typeof resolveRole>, Result> => !isRejection(r))
      .map((r) => r.id),
  );
  const legsByEntry = new Map<string, { accountId: string; taxCode: string | null; amount: number }[]>();
  const entryIds = [...new Set(rows.map((r) => r.entryId))];
  for (let i = 0; i < entryIds.length; i += 500) {
    const chunk = entryIds.slice(i, i + 500);
    const found = ctx.store.db
      .prepare(
        `SELECT entry_id AS entryId, account_id AS accountId, tax_code AS taxCode, debit_minor + credit_minor AS amount
           FROM journal_line WHERE entry_id IN (${chunk.map(() => '?').join(', ')})
          ORDER BY entry_id, (debit_minor + credit_minor) DESC, rowid`,
      )
      .all(...chunk) as { entryId: string; accountId: string; taxCode: string | null; amount: number }[];
    for (const l of found) {
      const list = legsByEntry.get(l.entryId) ?? [];
      list.push({ accountId: l.accountId, taxCode: l.taxCode, amount: l.amount });
      legsByEntry.set(l.entryId, list);
    }
  }
  const index = new Map<string, HistoryHit[]>();
  for (const r of rows) {
    const key =
      r.counterparty_iban !== null && r.counterparty_iban.length > 0
        ? `iban:${normalizeIban(r.counterparty_iban)}`
        : (() => {
            const n = normalisedName(r.counterparty_name ?? r.payer_name);
            return n === null ? null : `name:${n}`;
          })();
    if (key === null) continue;
    const bank = bankLedger.get(r.bankAccountId);
    const main = (legsByEntry.get(r.entryId) ?? []).find((l) => l.accountId !== bank && !vatAccounts.has(l.accountId));
    if (main === undefined) continue;
    // Critic A39-11: history never pre-fills a control-account booking (settling is open_item).
    if (controlAccounts.has(main.accountId)) continue;
    const list = index.get(key) ?? [];
    list.push({ accountId: main.accountId, taxCode: main.taxCode, date: r.date });
    index.set(key, list);
  }
  return index;
}

function sameReference(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const x = a.replace(/\s+/g, '').toUpperCase();
  const y = b.replace(/\s+/g, '').toUpperCase();
  return x.length > 0 && x === y;
}

/** Do two ISO dates fall in the same calendar month (the unit `transfer_crosses_period` refuses on)? */
function sameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

function dayDistance(a: string, b: string): number {
  return Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000));
}

/** (a) an unclaimed entry on the bank ledger account with the line's signed amount, within the window. */
function existingEntryProposal(
  ctx: WorkspaceContext,
  pc: ProposalContext,
  row: BankTxnRow,
  detail: BankTxnDetailRow | undefined,
): BankLineProposal | null {
  const bank = pc.ledgerOf.get(row.bank_account_id);
  if (bank === undefined) return null;
  const date = lineBookingDate(row);
  const signed = signedAmountOf(row);
  const candidates = ctx.store.db
    .prepare(
      `SELECT jl.id AS lineId, jl.entry_id AS entryId, e.date AS date, e.description AS description,
              (jl.debit_minor - jl.credit_minor) AS signed
         FROM journal_line jl JOIN journal_entry e ON e.id = jl.entry_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND jl.account_id = ? AND jl.currency = ?
          AND e.reverses_entry_id IS NULL
          AND e.date BETWEEN date(?, '-${EXISTING_ENTRY_WINDOW_DAYS} days') AND date(?, '+${EXISTING_ENTRY_WINDOW_DAYS} days')
          AND NOT ${HAS_REVERSAL_SQL('e.id', 'e.workspace_id')}
        ORDER BY e.date, jl.rowid`,
    )
    .all(ctx.workspaceId, bank.ledgerAccountId, row.currency, date, date) as {
    lineId: string;
    entryId: string;
    date: string;
    description: string | null;
    signed: number;
  }[];
  // Leg-level (critic A39-1): an entry whose OTHER bank leg another account's line already claims (the
  // far side of an own-account transfer) still offers THIS account's leg.
  const open = candidates.filter((c) => c.signed === signed && c.entryId !== bank.openingEntryId && !pc.claimed.lineIds.has(c.lineId));
  if (open.length === 0) return null;
  open.sort((a, b) => dayDistance(a.date, date) - dayDistance(b.date, date));

  // The TILL payment behind each candidate, and the A18 item behind that payment.
  const paymentOf = ctx.store.db.prepare('SELECT id, reference_value FROM payment WHERE workspace_id = ? AND journal_entry_id = ?');
  // The item's EndToEndId and its run's PmtInfId are read as FROZEN on the rows (A18 F9), never derived
  // from an id: a restore or env_copy re-mints the ids, and the camt.053 reports what the bank was sent.
  const itemOf = ctx.store.db.prepare(
    `SELECT i.id AS id, i.batch_id AS batch_id, i.end_to_end_id AS end_to_end_id, b.pmt_inf_id AS pmt_inf_id
       FROM payment_batch_item i JOIN payment_batch b ON b.workspace_id = i.workspace_id AND b.id = i.batch_id
      WHERE i.workspace_id = ? AND i.posted_payment_id = ?`,
  );
  const facts = open.map((c) => {
    const payment = paymentOf.get(ctx.workspaceId, c.entryId) as { id: string; reference_value: string | null } | undefined;
    const item =
      payment === undefined
        ? undefined
        : (itemOf.get(ctx.workspaceId, payment.id) as
            | { id: string; batch_id: string; end_to_end_id: string | null; pmt_inf_id: string | null }
            | undefined);
    return { candidate: c, payment, item };
  });
  // Critic H1 (lean): a line that names an A18 item by TILL's own EndToEndId is THAT item's payment, never
  // the nearest-dated sibling of the same amount in the same run.
  const e2e = detail?.end_to_end_id ?? null;
  const named =
    e2e !== null
      ? facts.find((f) => f.item !== undefined && f.item.end_to_end_id === e2e)
      : facts.find((f) => f.payment !== undefined && sameReference(f.payment.reference_value, row.reference_value));
  const chosen = named ?? facts[0]!;
  const best = chosen.candidate;

  // A reference proves it: a TILL payment on this entry with the line's QR/SCOR reference, or the A18
  // item behind that payment carrying the line's EndToEndId. The run's PmtInfId proves the RUN, so it
  // proves an item only when the line names no EndToEndId and the item is the run's ONE open payment of
  // this amount (critic H1). An own account's IBAN never proves anything (D139: a transfer is never
  // `sure`): it names the reason only.
  let proven = false;
  const { payment, item } = chosen;
  if (item !== undefined && e2e !== null) {
    proven = e2e === item.end_to_end_id;
  } else if (payment !== undefined && sameReference(payment.reference_value, row.reference_value)) {
    proven = true;
  } else if (item !== undefined && row.batch_pmt_inf_id !== null && row.batch_pmt_inf_id === item.pmt_inf_id) {
    proven = facts.filter((f) => f.item !== undefined && f.item.batch_id === item.batch_id).length === 1;
  }
  let transfer: OwnAccount | undefined;
  const ownIban = detail?.counterparty_iban ? normalizeIban(detail.counterparty_iban) : null;
  if (!proven && ownIban !== null) {
    const own = pc.ownAccounts.find((a) => a.iban === ownIban && a.bankAccountId !== row.bank_account_id);
    if (own !== undefined) {
      const touches = ctx.store.db
        .prepare('SELECT 1 AS p FROM journal_line WHERE entry_id = ? AND account_id = ? LIMIT 1')
        .get(best.entryId, own.ledgerAccountId);
      if (touches !== undefined) transfer = own;
    }
  }
  if (transfer !== undefined) {
    // Re-critic L3 (lean): side one booked in ANOTHER month refuses `transfer_crosses_period` at the
    // match, so the proposal names that entry and offers nothing to book.
    const crossesMonth = !sameMonth(best.date, date);
    return {
      target: crossesMonth ? null : { kind: 'existing_entry', entryId: best.entryId },
      certainty: 'check',
      reasonCode: 'own_account_transfer_booked',
      reasonParams: {
        otherBankAccountId: transfer.bankAccountId,
        entryId: best.entryId,
        entryDate: best.date,
        daysApart: dayDistance(best.date, date),
        candidates: open.length,
        crossesMonth,
      },
      vatCode: null,
    };
  }
  return {
    target: { kind: 'existing_entry', entryId: best.entryId },
    certainty: proven && row.reversal_ind !== 1 ? 'sure' : 'check',
    reasonCode: proven ? 'existing_entry_reference' : 'existing_entry_amount_date',
    reasonParams: {
      entryId: best.entryId,
      entryDate: best.date,
      description: best.description,
      daysApart: dayDistance(best.date, date),
      candidates: open.length,
    },
    vatCode: null,
  };
}

/**
 * (b) an A18 run on this Bankkonto, in the LINE's currency (spec L6), generated or paid: by an item's
 * EndToEndId (the value A18 froze on `payment_batch_item.end_to_end_id` and sent, one payment per camt.053
 * line "mit Details"), else by the run's PmtInfId (`payment_batch.pmt_inf_id`; the line is the run total).
 * Both are read from the stored columns, never derived from an id (A18 F9: a restore re-mints ids). `sure` on the item's EndToEndId with its amount,
 * or on the PmtInfId with the total. A paid run whose leg another line already accounts for is not
 * proposed again (critic A39-2: the claim set the booking guard reads).
 */
function batchProposal(ctx: WorkspaceContext, pc: ProposalContext, row: BankTxnRow, detail: BankTxnDetailRow | undefined): BankLineProposal | null {
  if (row.credit_debit !== 'DBIT') return null;
  const e2e = detail?.end_to_end_id ?? null;
  const pmtInfId = row.batch_pmt_inf_id !== null && row.batch_pmt_inf_id.length > 0 ? row.batch_pmt_inf_id : null;
  if (e2e === null && pmtInfId === null) return null;
  const batches = ctx.store.db
    .prepare(
      `SELECT id, status, ctrl_sum_minor, pmt_inf_id FROM payment_batch
        WHERE workspace_id = ? AND bank_account_id = ? AND status IN ('generated', 'paid')`,
    )
    .all(ctx.workspaceId, row.bank_account_id) as { id: string; status: string; ctrl_sum_minor: number | null; pmt_inf_id: string | null }[];
  const ledger = pc.ledgerOf.get(row.bank_account_id);
  const itemsOf = (batchId: string) =>
    ctx.store.db
      .prepare(
        `SELECT i.id AS id, i.amount_minor AS amountMinor, i.currency AS currency, i.end_to_end_id AS endToEndId,
                p.journal_entry_id AS entryId
           FROM payment_batch_item i LEFT JOIN payment p ON p.workspace_id = i.workspace_id AND p.id = i.posted_payment_id
          WHERE i.workspace_id = ? AND i.batch_id = ? ORDER BY i.seq, i.rowid`,
      )
      .all(ctx.workspaceId, batchId) as { id: string; amountMinor: number; currency: string; endToEndId: string | null; entryId: string | null }[];
  const takenBy = (entryIds: (string | null)[]): boolean =>
    ledger !== undefined && bankLegsOf(ctx, ledger.ledgerAccountId, entryIds).some((l) => pc.claimed.lineIds.has(l.lineId));
  for (const b of batches) {
    const items = itemsOf(b.id);
    if (items.length === 0 || items[0]!.currency !== row.currency) continue;
    const item = e2e === null ? undefined : items.find((i) => i.endToEndId === e2e);
    if (item !== undefined) {
      if (b.status === 'paid' && takenBy([item.entryId])) continue;
      const exact = item.amountMinor === row.amount_minor;
      // Critic M5 (lean): a differing amount always refuses `amount_mismatch` through `payment_batch`, so
      // the proposal names the run and carries no target to book; the reason says the way out.
      return {
        target: exact ? { kind: 'payment_batch', batchId: b.id } : null,
        certainty: exact && row.reversal_ind !== 1 ? 'sure' : 'check',
        reasonCode: exact ? 'payment_batch_item' : 'payment_batch_item_amount_differs',
        reasonParams: { batchId: b.id, batchStatus: b.status, itemId: item.id, itemAmountMinor: item.amountMinor, lineAmountMinor: row.amount_minor },
        vatCode: null,
      };
    }
    if (pmtInfId === null || b.pmt_inf_id !== pmtInfId) continue;
    if (b.status === 'paid' && takenBy(items.map((i) => i.entryId))) continue;
    const total = b.ctrl_sum_minor ?? items.reduce((sum, i) => sum + i.amountMinor, 0);
    const totalMatches = total === row.amount_minor;
    return {
      target: totalMatches ? { kind: 'payment_batch', batchId: b.id } : null,
      certainty: totalMatches && row.reversal_ind !== 1 ? 'sure' : 'check',
      reasonCode: totalMatches ? 'payment_batch_reference' : 'payment_batch_total_differs',
      reasonParams: { batchId: b.id, batchStatus: b.status, batchTotalMinor: total, lineAmountMinor: row.amount_minor },
      vatCode: null,
    };
  }
  return null;
}

/** (b) the A21 QR score of a credit. */
function qrProposal(ctx: WorkspaceContext, row: BankTxnRow): BankLineProposal | null {
  if (row.credit_debit !== 'CRDT') return null;
  const scored = matchIncomingByQrr(ctx, {
    reference: row.reference_value,
    amountMinor: row.amount_minor,
    currency: row.currency,
  });
  if (!scored.ok || scored.match.invoiceId === null || scored.match.confidence === 'none') return null;
  const m = scored.match;
  const exact = m.confidence === 'high';
  return {
    target: { kind: 'open_item', documentId: m.invoiceId as string },
    certainty: exact && row.reversal_ind !== 1 ? 'sure' : 'check',
    reasonCode: exact ? 'qr_reference_exact' : 'qr_reference_amount_differs',
    reasonParams: {
      documentId: m.invoiceId,
      documentNumber: m.invoiceNumber,
      contactName: m.contactName,
      openMinor: m.invoiceOpenMinor,
      dunningFeeMinor: m.dunningFeeMinor,
      totalDueMinor: m.totalDueMinor,
      deltaMinor: m.deltaMinor,
      scoreReason: m.reason,
    },
    vatCode: null,
  };
}

/** The shortest supplier reference that can prove a bill on its own (critic L12 lean). */
const MIN_PROVING_REFERENCE = 6;

/**
 * Does the line quote the bill's reference WHOLE: at least `MIN_PROVING_REFERENCE` characters, bounded
 * on both sides by a non-alphanumeric character (or the text's end) in the line's reference, remittance
 * or EndToEndId? A36's ranking signal is a substring of 3 characters, which ranks but proves nothing.
 */
function quotesWholeReference(ctx: WorkspaceContext, row: BankTxnRow, detail: BankTxnDetailRow | undefined, billId: string): boolean {
  const bill = ctx.store.db
    .prepare('SELECT vendor_reference AS ref FROM vendor_bill WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, billId) as { ref: string | null } | undefined;
  const ref = (bill?.ref ?? '').trim().toLowerCase();
  if (ref.length < MIN_PROVING_REFERENCE) return false;
  const text = [row.reference_value, detail?.remittance_text, detail?.end_to_end_id, row.entry_ref]
    .filter((x): x is string => typeof x === 'string')
    .join(' ')
    .toLowerCase();
  for (let at = text.indexOf(ref); at !== -1; at = text.indexOf(ref, at + 1)) {
    const before = at === 0 ? '' : text[at - 1]!;
    const after = text[at + ref.length] ?? '';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
  }
  return false;
}

/** (b) the A36 vendor-bill ranking of a debit: `sure` only when the line quotes the bill's reference whole. */
function vendorBillProposal(ctx: WorkspaceContext, pc: ProposalContext, row: BankTxnRow, detail: BankTxnDetailRow | undefined): BankLineProposal | null {
  if (row.credit_debit !== 'DBIT') return null;
  const ranked = rankDebitCandidates(ctx, row, pc.config);
  if (ranked === null || ranked.kind !== 'vendor_bill') return null;
  const byReference = (ranked.signals ?? []).includes('reference');
  const proven = byReference && ranked.confidence === 'high' && quotesWholeReference(ctx, row, detail, ranked.targetId);
  return {
    target: { kind: 'open_item', documentId: ranked.targetId },
    certainty: proven && row.reversal_ind !== 1 ? 'sure' : 'check',
    reasonCode: byReference ? 'vendor_bill_reference' : 'vendor_bill_amount',
    reasonParams: { documentId: ranked.targetId, confidence: ranked.confidence, signals: (ranked.signals ?? []).join(',') },
    vatCode: null,
  };
}

/**
 * (c) the counterparty IBAN is one of our own Bankkonten: a transfer to its ledger account, ALWAYS
 * `check` (D139: nothing moves between own accounts unattended). NEVER a new transfer while one is
 * already on the books (critic A39-1): an unclaimed leg on THIS account's ledger with the line's signed
 * amount, in an entry that also books the other own account, is the transfer the other side already
 * booked, whatever its date; this rung proposes matching it (`own_account_transfer_booked`).
 */
function ownAccountProposal(ctx: WorkspaceContext, pc: ProposalContext, row: BankTxnRow, detail: BankTxnDetailRow | undefined): BankLineProposal | null {
  const iban = detail?.counterparty_iban ? normalizeIban(detail.counterparty_iban) : null;
  if (iban === null) return null;
  const own = pc.ownAccounts.find((a) => a.iban === iban && a.bankAccountId !== row.bank_account_id);
  if (own === undefined) return null;
  const mine = pc.ledgerOf.get(row.bank_account_id);
  if (mine !== undefined) {
    const booked = ctx.store.db
      .prepare(
        `SELECT jl.id AS lineId, jl.entry_id AS entryId, e.date AS date
           FROM journal_line jl JOIN journal_entry e ON e.id = jl.entry_id
          WHERE e.workspace_id = ? AND e.status = 'posted' AND jl.account_id = ? AND jl.currency = ?
            AND (jl.debit_minor - jl.credit_minor) = ? AND e.reverses_entry_id IS NULL
            AND EXISTS (SELECT 1 FROM journal_line o WHERE o.entry_id = e.id AND o.account_id = ?)
            AND NOT ${HAS_REVERSAL_SQL('e.id', 'e.workspace_id')}
          ORDER BY abs(julianday(e.date) - julianday(?)), jl.rowid`,
      )
      .all(ctx.workspaceId, mine.ledgerAccountId, row.currency, signedAmountOf(row), own.ledgerAccountId, lineBookingDate(row)) as {
      lineId: string;
      entryId: string;
      date: string;
    }[];
    const free = booked.filter((b) => !pc.claimed.lineIds.has(b.lineId) && b.entryId !== mine.openingEntryId);
    if (free.length > 0) {
      const best = free[0]!;
      const crossesMonth = !sameMonth(best.date, lineBookingDate(row));
      return {
        target: crossesMonth ? null : { kind: 'existing_entry', entryId: best.entryId },
        certainty: 'check',
        reasonCode: 'own_account_transfer_booked',
        reasonParams: {
          otherBankAccountId: own.bankAccountId,
          entryId: best.entryId,
          entryDate: best.date,
          daysApart: dayDistance(best.date, lineBookingDate(row)),
          candidates: free.length,
          crossesMonth,
        },
        vatCode: null,
      };
    }
  }
  // D139 (replacing A39R2-2's `sure` on the money-leaving side): both sides read `check`, so "Alle
  // sicheren buchen" never posts a transfer; a person confirms side one, side two then matches it.
  return {
    target: { kind: 'accounts', legs: [{ accountId: own.ledgerAccountId, amountMinor: row.amount_minor }] },
    certainty: 'check',
    reasonCode: 'own_account_transfer',
    reasonParams: { otherBankAccountId: own.bankAccountId, accountId: own.ledgerAccountId },
    vatCode: null,
  };
}

/**
 * Every rung in order; the first that speaks is the proposal. D178 (A20 §11.5): then the fee split of a
 * card payment, under `bank.fx_mode`.
 */
export function proposeForLine(
  ctx: WorkspaceContext,
  pc: ProposalContext,
  row: BankTxnRow,
  detail: BankTxnDetailRow | undefined,
): BankLineProposal {
  return duplicateCap(ctx, pc, row, withFeeSplit(ctx, pc, row, ladderForLine(ctx, pc, row, detail)));
}

/**
 * D178 point 19 (critic R2-1): a line flagged as a possible duplicate waits for the person's decision. Its
 * proposal is never `sure` nor `learned` (it becomes `check`, as a reversal is capped), so it is never
 * "sicher", never in "Alle sicheren buchen", and the Übersicht band counts it as needing the person; the
 * booking itself refuses it until the decision (`duplicateDecisionPending`). The target stays, so the
 * person sees what booking it would be once it is "Kein Duplikat".
 */
function duplicateCap(ctx: WorkspaceContext, pc: ProposalContext, row: BankTxnRow, p: BankLineProposal): BankLineProposal {
  pc.lazy.duplicatePending ??= duplicatePendingIds(ctx);
  if (!pc.lazy.duplicatePending.has(row.id)) return p;
  return p.certainty === 'sure' || p.certainty === 'learned' ? { ...p, certainty: 'check' } : p;
}

function ladderForLine(
  ctx: WorkspaceContext,
  pc: ProposalContext,
  row: BankTxnRow,
  detail: BankTxnDetailRow | undefined,
): BankLineProposal {
  const reversalCap = (p: BankLineProposal): BankLineProposal =>
    row.reversal_ind === 1 && p.certainty === 'sure' ? { ...p, certainty: 'check' } : p;

  const a = existingEntryProposal(ctx, pc, row, detail);
  if (a !== null) return reversalCap(a);
  const b = batchProposal(ctx, pc, row, detail) ?? qrProposal(ctx, row) ?? vendorBillProposal(ctx, pc, row, detail);
  if (b !== null) return reversalCap(b);
  const c = ownAccountProposal(ctx, pc, row, detail);
  if (c !== null) return reversalCap(c);
  // (c2) D167/D175: the person's Buchungsregel, before any history.
  const c2 = standardProposal(ctx, pc, row, detail);
  if (c2 !== null) return reversalCap(c2);

  const key = counterpartyKeyOf(row, detail);
  const hits = key === null ? undefined : pc.history.get(key);
  if (hits !== undefined && hits.length > 0) {
    const last = hits[0]!;
    const count = hits.filter((h) => h.accountId === last.accountId && h.taxCode === last.taxCode).length;
    return {
      target: {
        kind: 'accounts',
        legs: [{ accountId: last.accountId, amountMinor: row.amount_minor, ...(last.taxCode !== null ? { taxCode: last.taxCode } : {}) }],
      },
      certainty: 'learned',
      reasonCode: 'history',
      reasonParams: { accountId: last.accountId, taxCode: last.taxCode, count, lastDate: last.date },
      vatCode: last.taxCode,
    };
  }

  // (d2) D167: the journal, so a migrated book suggests from day one; always `check`.
  const d2 = journalProposal(ctx, pc, row, detail);
  if (d2 !== null) return d2;

  // (d') D144: a recorded model choice, never `sure` (A39 §12).
  const m = pc.model === null ? null : modelRungProposal(pc.model, row);
  if (m !== null) {
    return {
      target: m.target,
      certainty: 'check',
      reasonCode: 'model_suggested',
      reasonParams: {
        accountId: m.accountId,
        probability: m.probability,
        decisionId: m.decisionId,
        modelRef: m.modelRef,
        candidates: m.candidates,
        ece: m.ece,
      },
      vatCode: m.vatCode,
    };
  }

  return { target: null, certainty: 'open', reasonCode: 'no_proposal', reasonParams: {}, vatCode: null };
}
