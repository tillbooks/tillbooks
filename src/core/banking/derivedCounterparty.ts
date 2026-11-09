/**
 * D188 (A39 §21), THE DERIVED COUNTERPARTY of a bank line that names none.
 *
 * A debit-card purchase and a bank fee arrive with no counterparty name and no IBAN: the merchant sits only in
 * the booking text (`Online purchase ZKB Visa Debit card no. xxxx 5870, RENDER.COM 94107`), and a fee names
 * nobody at all (`Account maintenance`, `Fee for ZKB Visa Debit Card no. xxxx 5870`). A Buchungsregel, the
 * learned history and the rule miner are keyed by the counterparty, so such a line could never get a rule.
 * This module reads the counterparty the TEXT names, and nothing else.
 *
 * THE CLOSED-WORLD RULE (A39 §21.1, re-cut after critic FAILs r1 and r2). Both FAILs had ONE cause: a
 * heuristic that dropped or skipped a token by its meaning (a digit word, a currency code that is also a word,
 * a clause word, a suffix), and every such rule can merge two businesses. So nothing is dropped or skipped by
 * meaning. The key is the text the bank wrote, normalised; whatever does not fit gives NO key, and the person
 * books the line. Splitting one merchant into two keys is the safe direction (a rule is then silent, never
 * wrong); merging two is the one wrong answer.
 *
 *  - a CARD PURCHASE: a card word before a MASKED card number (`xxxx 5870`, `XXXX5870`, `****5870`,
 *    `4567XXXXXXXX1234`). The SEGMENT is the text after the number, its leading separators dropped, up to the
 *    next comma or the end; nothing after that comma is read, no other segment is ever tried. Its key is the
 *    segment verbatim after `cardKeyOf` (NFKC, lower case, every run that is not a letter, a digit or a mark
 *    of any script becomes one space; marks are kept). NO token is ever removed, not even a trailing postcode
 *    or terminal number (`HOTEL 4051` and `HOTEL 8001` are two hotels). No key for an empty segment, an
 *    amount or a date, a letterless one, one whose first token holds no letter, one with fewer than two
 *    letters, or one ending in a bare `*`;
 *  - a BANK FEE: the line's own bank-transaction code says charges (`SubFmlyCd` `CHRG`), or the WHOLE text
 *    matches a pattern of `bank.fee_texts` (a closed list; `<bank>` the bank's short name, `<card>` a masked
 *    card number, required in a card-fee pattern). The counterparty is the bank that keeps the account, keyed
 *    by the institution id of the account's own IBAN (a Swiss or Liechtenstein IBAN; the whole own IBAN
 *    otherwise);
 *  - anything else: no derived counterparty.
 *
 * DERIVED, NEVER STORED OVER THE BANK'S FACTS. The bank's own fields (`bank_txn_detail`, `bank_txn_fact`) are
 * never written; the derivation runs at read time over the text the line already holds, so a line imported
 * before this module has it too, and `bank.derive_counterparty` = `off` takes it away everywhere at once (a
 * rule saved under a derived key then simply stops speaking). A derived key never collides with a real one:
 * `card:<merchant>` and `bank:<institution>` beside `iban:` and `name:`.
 *
 * Pure except `derivedCounterpartyOf`, which reads the two settings and the line's own Bankkonto (§H-TENANT).
 */

import type { WorkspaceContext } from '../context.js';
import { getSetting } from '../settings/settings.js';
import { normalizeIban } from '../setup/iban.js';
import type { BankTxnDetailRow, BankTxnRow } from './bankLines.js';

/** The kinds of derived counterparty (closed, §H-ENUM). */
export const DERIVED_COUNTERPARTY_KINDS = ['card', 'bank_fee'] as const;
export type DerivedCounterpartyKind = (typeof DERIVED_COUNTERPARTY_KINDS)[number];

/** A counterparty read from a line's text. */
export interface DerivedCounterparty {
  kind: DerivedCounterpartyKind;
  /** What the person reads: the merchant segment as the text spells it, or the bank's short name. */
  label: string;
  /** The key body: the merchant's `cardKeyOf`, or the bank's institution id. */
  keyBody: string;
}

export { BANK_FEE_TEXTS_DEFAULT } from './feeTexts.js';

/** The longest text the derivation reads (a camt Ustrd is 140, an MT940 :86: 390): bounded work per line. */
const MAX_TEXT = 500;

/** Swiss institution ids whose short name the label may use; any other bank is labelled by the account. */
const IID_SHORT_NAMES: Readonly<Record<string, string>> = {
  '00700': 'ZKB',
  '09000': 'PostFinance',
};

/** A card word somewhere before the masked number: what makes `xxxx 1234` a card and not a reference. */
const CARD_WORD = /\b(?:card|cards|karte|karten|kartennr|kartennummer|debitkarte|kreditkarte|carte|carta|visa|mastercard|maestro|debit|v pay)\b/i;

/**
 * A masked card number: `xxxx 5870`, `XXXX5870`, `****5870`, `**** 5870`, `4567XXXXXXXX1234`, `4567 12XX XXXX
 * 1234`. Every repetition of a mask group is delimited by ONE space, so no run of x can be split two ways (a
 * bank text is a sender's free text: no input may make the pattern backtrack).
 */
const MASKED_SOURCE = String.raw`(?:\b\d{4,6}(?: \d{2})?[ ]?[xX*]{2,}(?: [xX*]{2,})*[ ]?\d{4}\b|(?:\b[xX]{2,}|\*{2,})(?: [xX*]{2,})*[ -]?\d{4}\b)`;
const MASKED_NUMBER = new RegExp(MASKED_SOURCE);

/** A segment that is a currency and an amount (`USD 19.54`) or a date (`01.07.2026`, `12.07.2026 14:02`). */
const AMOUNT_OR_DATE = /^(?:[A-Z]{3}\s?[\d'.,]{1,20}|[\d'.,]{1,20}\s?[A-Z]{3}|\d{1,4}[./-]\d{1,2}[./-]\d{1,4}(?:\s\d{1,2}:\d{2}(?::\d{2})?)?)$/u;

// --- The card key ----------------------------------------------------------------------------------------

/**
 * The key body of a card merchant: NFKC, lower case, every run of characters that are not a letter, a digit
 * or a combining mark (any script) becomes one space. Nothing is removed: `RENDER.COM` and `render com` are
 * one key, `Café` and `Cafe` two. Null when nothing is left.
 */
export function cardKeyOf(merchant: string): string | null {
  const folded = merchant
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((t) => t !== '')
    .join(' ');
  return folded === '' ? null : folded;
}

/**
 * The merchant of a card-purchase text (the segment as the text spells it, nothing removed), or
 * null: no card text, or a segment that gives no key (see the module note). Pure.
 */
export function cardMerchantOf(rawText: string | null | undefined): string | null {
  if (rawText === null || rawText === undefined) return null;
  const text = rawText.slice(0, MAX_TEXT).normalize('NFKC');
  const masked = MASKED_NUMBER.exec(text);
  if (masked === null) return null;
  if (!CARD_WORD.test(text.slice(0, masked.index))) return null;
  // THE segment: after the number, its leading separators dropped, up to the next comma. Nothing else is read.
  const rest = text.slice(masked.index + masked[0].length).replace(/^[\s,]+/u, '');
  const comma = rest.indexOf(',');
  const segment = (comma < 0 ? rest : rest.slice(0, comma)).trim();
  if (segment === '' || /\*\s*$/u.test(segment)) return null;
  // A currency amount or a date in the merchant's place names no merchant: no key (never the next segment).
  if (AMOUNT_OR_DATE.test(segment)) return null;
  // ZERO token removal (orchestrator, after the r2 re-cut): a trailing number stays (`HOTEL 4051` and
  // `HOTEL 8001` are two hotels). A merchant whose terminal number changes per charge splits, never merges.
  const merchant = segment.replace(/\s+/gu, ' ');
  const key = cardKeyOf(merchant);
  if (key === null) return null;
  const first = key.split(' ')[0] as string;
  if (!/\p{L}/u.test(first)) return null;
  if ((key.match(/\p{L}/gu) ?? []).length < 2) return null;
  return merchant.slice(0, 80).trim();
}

// --- The fee key -----------------------------------------------------------------------------------------

const UMLAUT_SPELLING: Readonly<Record<string, string>> = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue' };

/** The fold a fee text and a fee pattern are compared in: NFKC, lower case, one space, no final full stop. */
function foldFee(text: string, spellUmlauts: boolean): string {
  const t = text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim().replace(/\.$/u, '');
  return spellUmlauts ? t.replace(/[äöü]/gu, (c) => UMLAUT_SPELLING[c] ?? c) : t;
}

/** One compiled fee pattern: the whole text, anchored at both ends. */
export type FeePattern = RegExp;

/**
 * The patterns of a `bank.fee_texts` value (`;`-separated), each compiled in both umlaut spellings. A pattern
 * is literal words plus `<bank>` (the bank's short name: 1 to 40 characters, no comma or semicolon) and
 * `<card>` (a masked card number); everything else is matched literally, anchored at both ends.
 */
export function feePatternsOf(setting: string): FeePattern[] {
  const out: FeePattern[] = [];
  for (const raw of setting.split(';')) {
    if (raw.trim() === '') continue;
    for (const spell of [false, true]) {
      const folded = foldFee(raw, spell);
      const source = folded
        .split(/(<bank>|<card>)/u)
        .map((part) => (part === '<bank>' ? '[^,;]{1,40}?' : part === '<card>' ? MASKED_SOURCE : part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/ /gu, '\\s+')))
        .join('');
      out.push(new RegExp(`^${source}$`, 'iu'));
    }
  }
  return out;
}

/** Does the WHOLE text match one of the patterns (either umlaut spelling)? */
export function matchesFeeText(text: string, patterns: readonly FeePattern[]): boolean {
  if (text.trim() === '' || patterns.length === 0) return false;
  const variants = [foldFee(text.slice(0, MAX_TEXT), false), foldFee(text.slice(0, MAX_TEXT), true)];
  return patterns.some((p) => variants.some((v) => p.test(v)));
}

// --- The line ---------------------------------------------------------------------------------------------

/** The text a line is read by: its remittance (the one merged text the proposals read). */
function lineText(detail: BankTxnDetailRow | undefined): string {
  return (detail?.remittance_text ?? '').trim();
}

/** Is the derivation on (`bank.derive_counterparty`)? */
export function deriveCounterpartyOn(ctx: WorkspaceContext): boolean {
  return getSetting<string>(ctx, 'bank.derive_counterparty') !== 'off';
}

/** The bank behind one of the workspace's Bankkonten: its key body and its label. §H-TENANT. */
function ownBankOf(ctx: WorkspaceContext, bankAccountId: string): { keyBody: string; label: string } | null {
  const a = ctx.store.db
    .prepare('SELECT iban, name FROM bank_account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, bankAccountId) as { iban: string | null; name: string } | undefined;
  if (a === undefined || typeof a.iban !== 'string' || a.iban.trim() === '') return null;
  const iban = normalizeIban(a.iban);
  const swiss = /^(?:CH|LI)\d{2}(\d{5})/.exec(iban);
  const keyBody = swiss !== null ? (swiss[1] as string) : iban;
  const label = (swiss !== null ? IID_SHORT_NAMES[swiss[1] as string] : undefined) ?? a.name.trim();
  return { keyBody, label: label === '' ? keyBody : label };
}

/**
 * The derived counterparty of a line that names none (no IBAN, no name), or null: off, a line that does name
 * one, a text that is neither a card purchase nor a fee. A line that names a counterparty is never asked.
 */
export function derivedCounterpartyOf(ctx: WorkspaceContext, row: BankTxnRow, detail: BankTxnDetailRow | undefined): DerivedCounterparty | null {
  const iban = detail?.counterparty_iban ?? null;
  if (iban !== null && iban.trim() !== '') return null;
  const name = detail?.counterparty_name ?? row.payer_name;
  if (name !== null && name !== undefined && name.trim() !== '') return null;
  const text = lineText(detail);
  if (!deriveCounterpartyOn(ctx)) return null;
  // A fee pattern first: a card FEE carries the masked number too, and names the card, not a merchant.
  const isFee =
    row.btc_sub_family === 'CHRG' || (text !== '' && matchesFeeText(text, feePatternsOf(String(getSetting<string>(ctx, 'bank.fee_texts') ?? ''))));
  if (isFee) {
    const bank = ownBankOf(ctx, row.bank_account_id);
    return bank === null ? null : { kind: 'bank_fee', label: bank.label, keyBody: bank.keyBody };
  }
  const merchant = cardMerchantOf(text);
  if (merchant === null) return null;
  const key = cardKeyOf(merchant);
  return key === null ? null : { kind: 'card', label: merchant, keyBody: key };
}
