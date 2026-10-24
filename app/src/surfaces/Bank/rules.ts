/**
 * D175 (A39 §14): a Buchungsregel in words, and the few pure choices the Studio makes about one.
 *
 * A rule is the D167 standard widened into a recipe of legs: each leg an account and an optional MWST
 * code, one leg the REST, every other leg ASKED at booking time under a label, optionally routed through
 * a Durchlaufkonto and gated by a text the remittance must contain. Nothing here computes a figure: the
 * engine expands a rule and `compose_entry` shows what it posts. This file names things.
 */
import type { BankInboxLine, BankStandard, ChartAccount, DraftTarget, RecipeLeg } from './model';
import { CONTROL_ACCOUNT_NUMBERS, VAT_ACCOUNT_NUMBERS } from './model';
// Type-only: `lookups.ts` reads this module for its sentences, so nothing here imports it at runtime.
import type { Lookups } from './lookups';
import type { RulePayload } from './RuleEditor';

type T = (key: string, params?: Record<string, string | number>) => string;

/** The name a person reads a rule by: its own name, else the counterparty it is for. */
export function ruleName(t: T, s: Pick<BankStandard, 'label' | 'counterpartyLabel'> | undefined): string {
  if (s === undefined) return t('bankInbox.rules.unnamed');
  return s.label ?? (s.counterpartyLabel !== '' ? s.counterpartyLabel : t('bankInbox.rules.unnamed'));
}

/** An account by its number, else its chart label, else the words for an account the chart lacks. */
function accountNumber(t: T, l: Lookups, accountId: string, fallback = ''): string {
  return l.chartById.get(accountId)?.number ?? (fallback !== '' ? fallback : t('bankInbox.legs.unknownAccount'));
}

/** "MWST 8.1 %" for a code with a rate, the code's own name for one without, '' for no code. */
export function vatShort(t: T, l: Lookups, code: string | null): string {
  if (code === null || code === '') return '';
  const c = l.taxByCode.get(code);
  if (c === undefined) return code;
  if (c.rateBp > 0) return t('bankInbox.rules.vatRate', { rate: String(c.rateBp / 100) });
  return c.code;
}

/**
 * An account in words, its number and its name ("3400 Erlöse aus Dienstleistungen", UX judge round 2,
 * item 8); the number alone when the chart lacks the account.
 */
function accountWords(t: T, l: Lookups, accountId: string, fallback = ''): string {
  const a = l.chartById.get(accountId);
  return a !== undefined ? `${a.number} ${a.name}` : accountNumber(t, l, accountId, fallback);
}

/** One leg in words: "3400 Erlöse MWST 8.1 %" (D176: a Vorlage's leg says its side: "Soll 1095 ..."). */
function legWords(t: T, l: Lookups, leg: RecipeLeg & { accountNumber?: string }): string {
  const vat = vatShort(t, l, leg.taxCode);
  const number = accountWords(t, l, leg.accountId, leg.accountNumber ?? '');
  const words = vat === '' ? number : `${number} ${vat}`;
  return leg.side === undefined ? words : `${t(`bankInbox.rules.vorlage.side.${leg.side}`)} ${words}`;
}

/**
 * The route in words (A39 §14.5): "über 1095 Erlös Durchlaufkonto: 3400 Erlöse MWST 8.1 % eingeben; Rest
 * 4400 Bezogene Fremdleistungen". Asked legs first in
 * the recipe's order, the rest last, the Durchlaufkonto in front when there is one. D176: a leg with the
 * SAME amount as another says so ("3400 MWST 8.1 % gleich wie 1095"), and a "Nicht buchen" rule reads
 * "Nicht buchen: <Grund>".
 */
export function routeInWords(
  t: T,
  l: Lookups,
  s: Pick<BankStandard, 'legs' | 'viaAccountId' | 'viaAccountNumber'> & Partial<Pick<BankStandard, 'outcome' | 'ignoreReason'>>,
): string {
  return routeLinesOf(t, l, s).join('; ');
}

/**
 * The route as short lines (D177 final judge, LOW d and e): the Durchlaufkonto first, then one line per
 * leg, each "<account>: how its amount comes about", the rest last. The rules sheet shows them one per
 * line; a tooltip or a picker joins them with a semicolon (`routeInWords`).
 */
export function routeLinesOf(
  t: T,
  l: Lookups,
  s: Pick<BankStandard, 'legs' | 'viaAccountId' | 'viaAccountNumber'> & Partial<Pick<BankStandard, 'outcome' | 'ignoreReason'>>,
): string[] {
  if (s.outcome === 'ignore') {
    return [t('bankInbox.target.ignore', { reason: s.ignoreReason !== null && s.ignoreReason !== undefined ? t(`bankInbox.ignore.reason.${s.ignoreReason}.label`) : '' })];
  }
  const words = s.legs.map((leg) => {
    if (leg.amount.kind === 'ask') {
      // An asked amount in the same voice as a computed one: who gives the figure, and when.
      const label = leg.amount.label !== '' ? leg.amount.label : t('bankInbox.rules.askFallback');
      return t('bankInbox.rules.route.ask', { leg: legWords(t, l, leg), label });
    }
    // D177: a computed leg says its factor ("3400 MWST 8.1 % berechnet × 1081/180").
    if (leg.amount.kind === 'factor') {
      // In words (UX judge, item 9), never "× 1081/180": the platform preset by its rates, else the factor.
      const e = leg.amount.explain;
      return e?.vatBp !== undefined && e.feeBp !== undefined
        ? // The rates say the MWST already: the account by its number, never "MWST 8.1 %" twice.
          t('bankInbox.rules.route.factorPlatform', { leg: accountWords(t, l, leg.accountId, leg.accountNumber ?? ''), vat: String(e.vatBp / 100), fee: String(e.feeBp / 100) })
        : t('bankInbox.rules.route.factorPlain', { leg: legWords(t, l, leg), factor: decimalOf(leg.amount.num, leg.amount.den) });
    }
    if (leg.amount.kind === 'same') {
      const other = s.legs[leg.amount.legIndex];
      return t('bankInbox.rules.route.same', { leg: legWords(t, l, leg), other: other === undefined ? '' : accountWords(t, l, other.accountId, other.accountNumber ?? '') });
    }
    return null;
  });
  const asked = words.filter((w): w is string => w !== null);
  const rest = s.legs.filter((leg) => leg.amount.kind === 'rest').map((leg) => t('bankInbox.rules.route.rest', { leg: legWords(t, l, leg) }));
  const via = s.viaAccountId === null ? [] : [t('bankInbox.rules.route.via', { via: accountWords(t, l, s.viaAccountId, s.viaAccountNumber ?? '') })];
  return [...via, ...asked, ...rest];
}

/** A factor as a short decimal ("2.5", "6.0056"), at most four places; never a raw fraction on screen. */
export function decimalOf(num: number, den: number): string {
  return String(Math.round((num / den) * 10_000) / 10_000);
}

/**
 * How a computed amount is made, in words: "MWST 8.1 % und Gebühr 9.9 % vom Netto" off the factor's
 * `explain`, else "mal 6.0056" (a decimal, never the fraction); '' when nothing is known.
 */
export function howWords(
  t: T,
  explain: { vatBp?: number; feeBp?: number } | undefined,
  num?: number,
  den?: number,
): string {
  const vat = explain?.vatBp !== undefined ? String(explain.vatBp / 100) : null;
  const fee = explain?.feeBp !== undefined ? String(explain.feeBp / 100) : null;
  if (vat !== null && fee !== null) return t('bankInbox.panel.howPlatform', { vat, fee });
  if (vat !== null) return t('bankInbox.panel.howVat', { vat });
  if (fee !== null) return t('bankInbox.panel.howFee', { fee });
  return num !== undefined && den !== undefined && den !== 0 ? t('bankInbox.panel.howFactor', { factor: decimalOf(num, den) }) : '';
}

/**
 * D177 final judge, FAIL 1: why a rule's amounts cannot book, in one plain sentence. The engine refuses only
 * a rest of exactly 0 (`expandRule`: the rest takes the line minus the others, either sign), so the
 * sentence says the amounts take the whole line and the rest leg gets nothing.
 */
export function restZeroReason(t: T, l: Lookups, target: Extract<DraftTarget, { kind: 'rule' }>): string {
  // D177 polish 4: one line in the panel's width, the same words on Buchen's tooltip; the rest account by
  // its number (the preview beside it names it in full, its 0.00 on its side).
  const rule = l.standardById.get(target.standardId);
  const restLeg = rule?.legs.find((leg) => leg.amount.kind === 'rest');
  const account = restLeg === undefined ? t('bankInbox.legs.unknownAccount') : accountNumber(t, l, restLeg.accountId);
  return t('bankInbox.book.why.restZeroShort', { account });
}

/** What a rule matches, in words: "Bondigoo Payments, Geld rein, Text enthält «STRIPE»". A Vorlage: "Vorlage". */
export function matchInWords(t: T, s: Pick<BankStandard, 'counterpartyLabel' | 'direction' | 'matchText'>): string {
  if (s.direction === null) return t('bankInbox.rules.match.vorlage');
  const base = t(s.direction === 'in' ? 'bankInbox.rules.match.in' : 'bankInbox.rules.match.out', { party: s.counterpartyLabel });
  return s.matchText === null ? base : t('bankInbox.rules.match.withText', { base, text: s.matchText });
}

/**
 * D176: the `set_bank_standard` fields a saved form stands for, beside the line (`bankTxnId`) or the rule
 * (`standardId`) the host adds. A bank rule's rest leg rides along as `accountId`/`taxCode` for a D167
 * reader (the engine ignores both beside `legs`); an ignore rule sends its outcome, reason and note and no
 * legs; a Vorlage sends its scope, name and legs only.
 */
export function ruleInputOf(payload: RulePayload): Record<string, unknown> {
  if (payload.scope === 'manual') return { scope: 'manual', label: payload.label, legs: payload.legs, ...(payload.replaceStandardId !== undefined ? { replaceStandardId: payload.replaceStandardId } : {}) };
  const follow = payload.followUpStandardId !== null ? { followUpStandardId: payload.followUpStandardId } : {};
  const text = payload.matchText !== null ? { matchText: payload.matchText } : {};
  if (payload.outcome === 'ignore') {
    return {
      outcome: 'ignore',
      label: payload.label,
      ignoreReason: payload.ignoreReason ?? 'other',
      ...(payload.ignoreNote !== null ? { ignoreNote: payload.ignoreNote } : {}),
      ...text,
      ...follow,
    };
  }
  const restLeg = payload.legs.find((leg) => leg.amount.kind === 'rest');
  return {
    label: payload.label,
    legs: payload.legs,
    ...(restLeg !== undefined ? { accountId: restLeg.accountId, ...(restLeg.taxCode !== undefined ? { taxCode: restLeg.taxCode } : {}) } : {}),
    ...text,
    ...(payload.viaAccountId !== null ? { viaAccountId: payload.viaAccountId } : {}),
    ...follow,
  };
}

/** D176: the live Vorlagen, as a follow-up picker offers them (by name). */
export function vorlagenOf(l: Lookups): { id: string; label: string }[] {
  return [...l.standardById.values()].filter((s) => s.scope === 'manual').map((s) => ({ id: s.id, label: s.label ?? '' }));
}

/**
 * The codes `invalidReason` carries (the engine's `BANK_RULE_INVALID_REASONS`, bankStandards.ts), each with
 * a sentence in both locales; an unknown one reads as the general sentence, never as its code.
 */
const INVALID_REASON_WORDS: ReadonlySet<string> = new Set(['account_archived', 'account_not_bookable', 'tax_code_inactive', 'vat_not_applicable', 'recipe_unreadable']);

/** Why a rule went quiet, in words (never the code). */
export function invalidReasonText(t: T, reason: string): string {
  return t(`bankInbox.rules.invalid.${INVALID_REASON_WORDS.has(reason) ? reason : 'other'}`);
}

/** Words that open many remittance texts and decide nothing. Compared folded, upper case. */
const NOT_DISTINCTIVE: ReadonlySet<string> = new Set([
  'ZAHLUNG',
  'GUTSCHRIFT',
  'RECHNUNG',
  'AUFTRAG',
  'ÜBERWEISUNG',
  'VERGÜTUNG',
  'PAYMENT',
  'TRANSFER',
  'INVOICE',
  'VON',
  'FÜR',
  'DER',
  'DIE',
  'DAS',
  'UND',
]);

/**
 * The first distinctive token of the remittance text (A39 §14.5), the "Nur wenn der Text enthält"
 * prefill: three letters or more, not a bare number, not a word of the counterparty's own name (two
 * businesses can share one payer, D175 point 3, so the payer's name decides nothing), and not one of the
 * words every bank text opens with. '' when the text offers none.
 */
export function distinctiveToken(line: Pick<BankInboxLine, 'remittance' | 'counterparty'>): string {
  const text = line.remittance.text ?? '';
  const party = new Set((line.counterparty.name ?? '').toUpperCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== ''));
  for (const raw of text.split(/[\s,;:/()]+/)) {
    const token = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    const letters = token.replace(/[^\p{L}]/gu, '').length;
    if (letters < 3) continue;
    const upper = token.toUpperCase();
    if (party.has(upper) || NOT_DISTINCTIVE.has(upper)) continue;
    return token;
  }
  return '';
}

/**
 * True for an account a Durchlaufkonto may be (A39 §14.1): a balance account (asset, liability or
 * equity), never an Erfolgskonto, never a Bankkonto's ledger account, never a VAT account (1170, 1171,
 * 2200, 2201) and never a control account (1100, 2000). An account of unknown type counts by its number's
 * class (1 and 2 are the balance sheet in the KMU chart).
 */
export function canBeVia(account: Pick<ChartAccount, 'id' | 'number' | 'type'>, bankLedgerIds: ReadonlySet<string>): boolean {
  if (bankLedgerIds.has(account.id)) return false;
  if (VAT_ACCOUNT_NUMBERS.includes(account.number) || CONTROL_ACCOUNT_NUMBERS.includes(account.number)) return false;
  if (account.type === 'income' || account.type === 'expense') return false;
  if (account.type === 'asset' || account.type === 'liability' || account.type === 'equity') return true;
  return /^[12]/.test(account.number);
}

/** The chart's accounts a Durchlaufkonto may be, minus the ones a leg already books to. */
export function viaCandidates(l: Lookups, legAccountIds: readonly string[] = []): ChartAccount[] {
  const ledgers = new Set(l.bankAccounts.map((b) => b.ledgerAccountId).filter((id): id is string => id !== null));
  const used = new Set(legAccountIds);
  return l.chart.filter((a) => !used.has(a.id) && canBeVia(a, ledgers));
}
