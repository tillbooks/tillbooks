/**
 * D167: what a Vorschlag (and a trace row) says about its arguments, in words. The owner's verdict on
 * the old Details ("I just get code") is the law here: NOTHING in this module ever returns JSON, a raw
 * snake_case key or a bare Rappen integer. A value it cannot humanise is left out, never dumped.
 *
 *  - `keyFigure`: the ONE figure the line shows on its face, the most telling one per verb kind.
 *  - `argumentRows`: the label and value pairs the Details disclosure shows, for a drafted payload
 *    and for a trace call's arguments alike.
 *  - `periodLabel`: a VAT or reporting period as words, "2026-Q1 (Jan. bis März)".
 *  - `bankLineOf`: the bank line a bank-line Vorschlag acts on, for the "Zur Bankzeile" link.
 */
import { formatDate, formatMoney, type Locale } from '../../i18n';
import { formatMonth } from '../../lib/format';
import { LABELLED_FIELDS, type DraftedAction } from './model';

type T = (key: string, params?: Record<string, string | number>) => string;

/** One read-back row: a human label, a formatted value, and the raw value as tooltip where a name replaced it. */
export interface DetailRow {
  key: string;
  label: string;
  value: string;
  /** The raw value a resolved name replaced (an id), shown as the row's tooltip, never as text. */
  title?: string;
  /** Money renders with tabular figures. */
  money?: boolean;
  /** A way to change what the row says (the Freigabe row links to the agent's Berechtigungen). */
  link?: { to: string; label: string };
}

/** The payload keys whose text names the THING a Vorschlag is about (D167 polish 11). */
export const TITLE_KEYS: readonly string[] = ['description', 'text', 'memo', 'purpose'];

/**
 * D167 polish 11: a Vorschlag is titled by the thing it is about ("Büromaterial Papeterie Lindengrund"),
 * the entry's or payment's own text when the payload has one; the verb then moves to the meta line.
 */
export function payloadTitle(payload: Record<string, unknown>): { key: string; text: string } | null {
  for (const key of TITLE_KEYS) {
    const v = payload[key];
    if (typeof v === 'string' && v.trim() !== '') return { key, text: v.trim() };
  }
  return null;
}

/** Keys that are transport plumbing, never a fact about the proposal. */
const PLUMBING: ReadonlySet<string> = new Set(['workspaceId', 'idempotencyKey', 'confirmed']);

/** The bank-line verbs that carry a "Zur Bankzeile" link (A39). */
const BANK_LINE_VERBS: ReadonlySet<string> = new Set(['book_bank_line', 'ignore_bank_line', 'reopen_bank_line']);

/** The A39 booking targets the Studio names in words (`target.kind`). */
const TARGET_KINDS: ReadonlySet<string> = new Set(['accounts', 'open_item', 'payment_batch', 'existing_entry']);

/** How many rows one array (posting lines, booking legs) contributes before the rest are counted. */
const MAX_LIST_ROWS = 7;

const PERIOD = /^(\d{4})-(Q[1-4]|H[12])$/;

/**
 * An account's internal id ("acc_7be45fed-…"): never a fact a person reads (D167 browser walk: Details
 * printed "Konto acc_7be45fed-…"). One the chart could not name is left out. A CONTACT id the engine
 * could not name deliberately still shows (critic phase0-installable r2: whose IBAN is redirected must
 * stay visible), so only account ids are dropped.
 */
const INTERNAL_ID = /^acc_[0-9a-f]{6,}[0-9a-f-]*$/i;

/** Id to "6500 Verwaltungs- und Bürokosten", as `useAccountNames` reads the chart. */
export type AccountNameMap = ReadonlyMap<string, string>;

const NO_ACCOUNTS: AccountNameMap = new Map();


/**
 * A period label as words: a quarter or half-year names its months ("2026-Q1 (Jan. bis März)"), a
 * month reads "März 2026". Anything else comes back unchanged (it is already what the engine said).
 */
export function periodLabel(t: T, locale: Locale, period: string): string {
  const m = PERIOD.exec(period);
  if (m !== null) {
    const part = m[2] as string;
    const [from, to] =
      part === 'H1' ? [1, 6] : part === 'H2' ? [7, 12] : [(Number(part.slice(1)) - 1) * 3 + 1, Number(part.slice(1)) * 3];
    return t('agent.line.period', { period, from: t(`agent.line.month.${from}`), to: t(`agent.line.month.${to}`) });
  }
  if (/^\d{4}-\d{2}$/.test(period)) return formatMonth(period, locale);
  return period;
}

/** A payload key as a label: its `agent.field.*` entry, else the key spaced and capitalised (never snake_case). */
export function fieldLabel(t: T, key: string): string {
  if (LABELLED_FIELDS.has(key)) return t(`agent.field.${key}`);
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function isMoneyKey(key: string): boolean {
  return /Minor$/.test(key) || /Rappen$/.test(key);
}

/** A primitive value in words, or null when it is not one this module can say honestly. */
function valueOf(t: T, locale: Locale, key: string, value: unknown, currency: string): { text: string; money: boolean } | null {
  if (typeof value === 'number') {
    if (isMoneyKey(key)) return { text: formatMoney(value, currency), money: true };
    return { text: String(value), money: false };
  }
  if (typeof value === 'boolean') return { text: t(value ? 'agent.line.yes' : 'agent.line.no'), money: false };
  if (typeof value === 'string') {
    if (value.length === 0) return null;
    if (key === 'period' || key === 'periodLabel') return { text: periodLabel(t, locale, value), money: false };
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return { text: formatDate(value), money: false };
    if (key === 'kind' && TARGET_KINDS.has(value)) return { text: t(`agent.line.targetKind.${value}`), money: false };
    // An entry's source in the Journal's own words ("manual" reads "Manuell", as the Quelle column says).
    if (key === 'source') {
      const said = t(`journal.source.${value}`);
      if (said !== `journal.source.${value}`) return { text: said, money: false };
    }
    if (INTERNAL_ID.test(value)) return null;
    return { text: value, money: false };
  }
  return null;
}

interface LineLike {
  account?: unknown;
  accountId?: unknown;
  debit?: unknown;
  credit?: unknown;
  amountMinor?: unknown;
  taxCode?: unknown;
}

function listRows(t: T, key: string, list: unknown[], currency: string, accounts: AccountNameMap): DetailRow[] {
  const rows: DetailRow[] = [];
  list.slice(0, MAX_LIST_ROWS).forEach((raw, index) => {
    if (raw === null || typeof raw !== 'object') return;
    const line = raw as LineLike;
    const account = typeof line.account === 'string' ? line.account : typeof line.accountId === 'string' ? line.accountId : null;
    if (account === null) return;
    // D167 polish 11: each leg is ONE line, "Soll · 6500 Verwaltungs- und Bürokosten · CHF 48.50": the side
    // as its label, the account in words and the money as its value; the id rides only as the tooltip.
    let side: string | null = null;
    let money: number | null = null;
    if (typeof line.debit === 'number' && line.debit > 0) [side, money] = [t('agent.field.soll'), line.debit];
    else if (typeof line.credit === 'number' && line.credit > 0) [side, money] = [t('agent.field.haben'), line.credit];
    else if (typeof line.amountMinor === 'number') [side, money] = [t('agent.field.accountId'), Math.abs(line.amountMinor)];
    if (side === null || money === null) return;
    const name = accounts.get(account) ?? t('agent.field.accountId');
    let value = `${name} · ${formatMoney(money, currency)}`;
    if (typeof line.taxCode === 'string' && line.taxCode.length > 0) value = `${value} · ${line.taxCode}`;
    rows.push({ key: `${key}-${index}`, label: side, value, title: account });
  });
  if (list.length > MAX_LIST_ROWS) {
    rows.push({ key: `${key}-more`, label: '', value: t('agent.line.moreRows', { n: list.length - MAX_LIST_ROWS }) });
  }
  return rows;
}

/**
 * The arguments of a proposal or a call as label and value pairs. Primitives are labelled and
 * formatted; a posting's `lines` and a booking's `target.legs` read as account plus amount; a nested
 * object (a bank booking's `target`) is read one level down; whatever is left that is not a fact a
 * person can read (a deeper structure) is left out rather than printed as code.
 */
export function argumentRows(
  t: T,
  locale: Locale,
  args: Record<string, unknown>,
  names: Record<string, string> = {},
  omit: ReadonlySet<string> = new Set(),
  accounts: AccountNameMap = NO_ACCOUNTS,
): DetailRow[] {
  const currency = typeof args.currency === 'string' && args.currency.length === 3 ? args.currency : 'CHF';
  const rows: DetailRow[] = [];
  const visit = (record: Record<string, unknown>, prefix: string) => {
    for (const [key, value] of Object.entries(record)) {
      if (PLUMBING.has(key) || omit.has(key)) continue;
      if (Array.isArray(value)) {
        rows.push(...listRows(t, `${prefix}${key}`, value, currency, accounts));
        continue;
      }
      if (value !== null && typeof value === 'object') {
        if (prefix === '') visit(value as Record<string, unknown>, `${key}.`);
        continue;
      }
      const name = names[key];
      if (name !== undefined && name.length > 0) {
        rows.push({ key: `${prefix}${key}`, label: fieldLabel(t, key), value: name, title: String(value) });
        continue;
      }
      const account = typeof value === 'string' ? accounts.get(value) : undefined;
      if (account !== undefined) {
        rows.push({ key: `${prefix}${key}`, label: fieldLabel(t, key), value: account, title: value as string });
        continue;
      }
      const said = valueOf(t, locale, key, value, currency);
      if (said === null) continue;
      rows.push({ key: `${prefix}${key}`, label: fieldLabel(t, key), value: said.text, money: said.money });
    }
  };
  visit(args, '');
  return rows;
}

/** The money a payload moves when no figure was pinned: a posting's debits, a booking's legs, an amount. */
export function payloadAmount(payload: Record<string, unknown>): number | null {
  const lines = Array.isArray(payload.lines) ? (payload.lines as LineLike[]) : [];
  if (lines.length > 0) {
    const debits = lines.reduce((sum, l) => sum + (typeof l.debit === 'number' ? l.debit : 0), 0);
    return debits > 0 ? debits : null;
  }
  const target = payload.target;
  if (target !== null && typeof target === 'object' && Array.isArray((target as { legs?: unknown }).legs)) {
    const legs = (target as { legs: LineLike[] }).legs;
    const sum = legs.reduce((s, l) => s + (typeof l.amountMinor === 'number' ? l.amountMinor : 0), 0);
    return sum !== 0 ? Math.abs(sum) : null;
  }
  if (typeof payload.amountMinor === 'number') return payload.amountMinor;
  return null;
}

/**
 * The ONE figure on the line's face. The pinned figures lead (D162: they are what the approval is
 * pinned to): the total a document comes to, else its amount, with the counterparty as context; then a
 * period (a VAT filing is about a period); then the money the payload moves. Null when there is none:
 * an absent figure is honest, an invented one is not.
 */
export function keyFigure(t: T, locale: Locale, action: DraftedAction): string | null {
  const f = action.figures ?? null;
  const parts: string[] = [];
  if (f !== null) {
    const currency = f.currency ?? 'CHF';
    const money = f.grossMinor ?? f.amountMinor;
    if (f.counterparty !== null) parts.push(f.counterparty);
    if (money !== null) parts.push(formatMoney(money, currency));
    else if (f.number !== null) parts.push(f.number);
    if (parts.length > 0) return parts.join(' · ');
  }
  const period = action.payload.period;
  if (typeof period === 'string' && period.length > 0) return periodLabel(t, locale, period);
  const amount = payloadAmount(action.payload);
  if (amount !== null) {
    const currency = typeof action.payload.currency === 'string' ? action.payload.currency : 'CHF';
    return formatMoney(amount, currency);
  }
  return null;
}

/** "6500 Verwaltungs- und Bürokosten", else "Konto": an account in words, never its id (item 7). */
function accountWords(t: T, accounts: AccountNameMap, id: unknown): string {
  return typeof id === 'string' ? (accounts.get(id) ?? t('agent.field.accountId')) : t('agent.field.accountId');
}

/**
 * D162 point 1 at the line's face (security review of D167): WHAT YOU APPROVE IS WHAT RUNS, so the
 * pinned essentials of an act that books or moves money are on the line itself, never only behind
 * Details: the accounts in words ("6500 Büromaterial an 1020 Bank", or "3 Konten" past two legs; a
 * bank booking "auf 6570 Informatik"), the counterparty and the recipient the pin names, and the total.
 * The pinned figures (D162) lead; where nothing is pinned the payload is read, its accounts resolved
 * through the chart's names. Null when the act carries none of these: the line then shows `keyFigure`.
 */
export function essentials(t: T, locale: Locale, action: DraftedAction, accounts: AccountNameMap = NO_ACCOUNTS): string | null {
  const parts: string[] = [];
  const p = action.payload;
  const lines = Array.isArray(p.lines) ? (p.lines as LineLike[]).filter((l) => l !== null && typeof l === 'object') : [];
  const target = p.target !== null && typeof p.target === 'object' ? (p.target as { kind?: unknown; legs?: unknown }) : null;
  const legs = target !== null && Array.isArray(target.legs) ? (target.legs as LineLike[]).filter((l) => l !== null && typeof l === 'object') : [];
  if (lines.length === 2) {
    const debit = lines.find((l) => typeof l.debit === 'number' && l.debit > 0) ?? lines[0];
    const credit = lines.find((l) => l !== debit) ?? lines[1];
    parts.push(t('agent.line.essentials.pair', { debit: accountWords(t, accounts, debit?.account ?? debit?.accountId), credit: accountWords(t, accounts, credit?.account ?? credit?.accountId) }));
  } else if (lines.length > 2) {
    parts.push(t('agent.line.essentials.many', { count: lines.length }));
  } else if (legs.length === 1) {
    parts.push(t('agent.line.essentials.onto', { account: accountWords(t, accounts, legs[0]?.accountId ?? legs[0]?.account) }));
  } else if (legs.length > 1) {
    parts.push(t('agent.line.essentials.many', { count: legs.length }));
  }
  const f = action.figures ?? null;
  if (f !== null && f.counterparty !== null) parts.push(f.counterparty);
  if (f !== null && f.recipient !== null) parts.push(t('agent.line.essentials.recipient', { recipient: f.recipient }));
  // The total leads (D167 follow-up): the meta line cuts from the end, and the money is the one figure a
  // person must see before Genehmigen.
  const pinned = f !== null ? (f.grossMinor ?? f.amountMinor) : null;
  if (pinned !== null && f !== null) parts.unshift(formatMoney(pinned, f.currency ?? 'CHF'));
  else {
    const amount = payloadAmount(p);
    if (amount !== null) parts.unshift(formatMoney(amount, typeof p.currency === 'string' ? p.currency : 'CHF'));
  }
  void locale;
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** The bank line a bank-line Vorschlag acts on, or null for any other verb. */
export function bankLineOf(action: DraftedAction): string | null {
  if (!BANK_LINE_VERBS.has(action.actionTool)) return null;
  const id = action.payload.bankTxnId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
