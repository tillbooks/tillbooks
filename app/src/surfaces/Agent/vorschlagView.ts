/**
 * D197: what ONE Vorschlag says on its row, read once and shared by the Vorschläge list and the Pendenzen
 * row, so the same proposal reads the same on both screens. Pure: no React, no fetching.
 *
 * `parseVorschlaege` reads `list_drafted_actions` (the existing `parseDrafted`) plus the facts the engine
 * adds at read time for this screen (`src/api/vorschlag-facts.ts`): the bank line's signed amount, date and
 * counterparty, a supplier IBAN change's old and new IBAN, a settings change's name, the batch reach, and
 * the evidence certainty the engine always sent and the Studio used to drop (audit F-10).
 *
 * `rowFacts` turns one into the row's cells: subject, kind in words, date, signed amount, certainty, Beleg.
 * Nothing is guessed: an absent fact is an empty cell.
 */
import { formatDate, formatMoney, type Locale } from '../../i18n';
import { LABELLED_VERBS, parseDrafted, type DraftedAction } from './model';
import { accountsPhrase, payloadAmount, payloadTitle, periodLabel, type AccountNameMap } from './vorschlagDetails';

type T = (key: string, params?: Record<string, string | number>) => string;

export type Certainty = 'sure' | 'learned' | 'check' | 'open';
export type VorschlagStatusKey = 'pending' | 'executed' | 'rejected' | 'stale';

export interface LineFacts {
  date: string | null;
  counterparty: string | null;
  text: string | null;
  amountMinor: number;
  currency: string;
}

export interface BankDetail {
  contactName: string | null;
  oldIban: string | null;
  newIban: string | null;
  /** The seat may not read master data: the supplier and the current IBAN are withheld, never "none". */
  withheld: boolean;
}

export interface SettingChange {
  key: string;
  label: { en: string; 'de-CH': string } | null;
  value: unknown;
  current?: unknown;
}

/** A listed Vorschlag with the facts this screen reads (all optional: an older engine sends none). */
export interface VorschlagItem extends DraftedAction {
  lineFacts?: LineFacts | null;
  bankDetail?: BankDetail;
  setting?: SettingChange;
  batchable: boolean;
  /** The engine's evidence certainty on a pending `book_bank_line` row, else null. */
  certainty: Certainty | null;
  /** The engine's evidence reasons (`agrees`, `differs_from_engine`, ...), for the detail's evidence lines. */
  evidenceReasons: string[];
  resolvedAt: string | null;
  resolvedBy: string | null;
  closureKind: string | null;
  /** D196: the decision the agent took under the owner's grant (from the row's history), else null. */
  decidedUnderGrant?: DecidedUnderGrant | null;
  /** D209: the owner's words the agent approved this Vorschlag on (from the row's history), else null. */
  decidedOnOwnerWord?: DecidedOnOwnerWord | null;
}

/** D209: the owner's words, verbatim, when they were said, and who switched the setting on. */
export interface DecidedOnOwnerWord {
  quote: string;
  saidAt: string;
  grantedBy: string;
}

/** D209: the row history's `decided_on_owner_word` entry, or null (an absent or malformed history is none). */
export function decidedOnOwnerWordOf(history: unknown): DecidedOnOwnerWord | null {
  if (!Array.isArray(history)) return null;
  for (const raw of history) {
    const e = record(raw);
    if (e.event !== 'decided_on_owner_word') continue;
    if (typeof e.quote !== 'string' || typeof e.saidAt !== 'string' || typeof e.grantedBy !== 'string') continue;
    return { quote: e.quote, saidAt: e.saidAt, grantedBy: e.grantedBy };
  }
  return null;
}

/** D209: who decided a Vorschlag, as the "Entschieden" facet groups it; null while it is open. */
export function decidedByOf(item: Pick<VorschlagItem, 'resolvedAt' | 'decidedUnderGrant' | 'decidedOnOwnerWord'>): 'person' | 'agent' | 'ownerWord' | null {
  if (item.resolvedAt === null) return null;
  if (item.decidedOnOwnerWord) return 'ownerWord';
  if (item.decidedUnderGrant) return 'agent';
  return 'person';
}

/** D196: one decision the agent took under the owner's grant, and the grant it rode. */
export interface DecidedUnderGrant {
  decision: 'approved' | 'rejected';
  grantedBy: string;
  grantedAt: string;
}

/** D196: the row history's `decided_under_grant` entry, or null (an absent or malformed history is none). */
export function decidedUnderGrantOf(history: unknown): DecidedUnderGrant | null {
  if (!Array.isArray(history)) return null;
  for (const raw of history) {
    const e = record(raw);
    if (e.event !== 'decided_under_grant') continue;
    if ((e.decision !== 'approved' && e.decision !== 'rejected') || typeof e.grantedBy !== 'string' || typeof e.grantedAt !== 'string') continue;
    return { decision: e.decision, grantedBy: e.grantedBy, grantedAt: e.grantedAt };
  }
  return null;
}

/**
 * Who decided (or granted), in words, never the raw actor id (D197, DESIGN.md "humanize machine labels"): the
 * Studio seat, the agent, TILL itself, or a person. A served member's id is not a name, so it reads as a person.
 */
export function actorWords(t: T, actor: string | null): string {
  if (actor === 'studio') return t('agent.vq.who.studio');
  if (actor === 'agent') return t('agent.vq.who.agent');
  if (actor === 'system') return t('agent.vq.who.system');
  return t('agent.vq.who.person');
}

export interface VorschlaegeAnswer {
  items: VorschlagItem[];
  /** The setting `attention.approval_batch_mode`, as the engine reads it (default `tick`). */
  batchMode: 'tick' | 'single' | 'all_with_confirm';
}

/** The supplier IBAN change: never batchable, always confirmed (the fresh-eyes judge, D197). */
export const IBAN_CHANGE_VERB = 'set_creditor_bank_profile';

const CERTAINTIES: ReadonlySet<string> = new Set(['sure', 'learned', 'check', 'open']);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

function parseLineFacts(raw: unknown): LineFacts | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const f = record(raw);
  if (typeof f.amountMinor !== 'number' || !Number.isFinite(f.amountMinor) || typeof f.currency !== 'string') return null;
  return { date: str(f.date), counterparty: str(f.counterparty), text: str(f.text), amountMinor: f.amountMinor, currency: f.currency };
}

function parseBankDetail(raw: unknown): BankDetail | undefined {
  if (raw === undefined || raw === null) return undefined;
  const f = record(raw);
  return { contactName: str(f.contactName), oldIban: str(f.oldIban), newIban: str(f.newIban), withheld: f.withheld === true };
}

function parseSetting(raw: unknown): SettingChange | undefined {
  const f = record(raw);
  if (typeof f.key !== 'string') return undefined;
  const label = record(f.label);
  return {
    key: f.key,
    label: typeof label.en === 'string' && typeof label['de-CH'] === 'string' ? { en: label.en, 'de-CH': label['de-CH'] } : null,
    value: f.value,
    ...('current' in f ? { current: f.current } : {}),
  };
}

/** One listed Vorschlag's extra facts, from the raw row. */
export function itemOf(action: DraftedAction, raw: unknown): VorschlagItem {
  const r = record(raw);
  const evidence = record(r.evidence);
  const certainty = typeof evidence.certainty === 'string' && CERTAINTIES.has(evidence.certainty) ? (evidence.certainty as Certainty) : null;
  const lineFacts = parseLineFacts(r.lineFacts);
  const bankDetail = parseBankDetail(r.bankDetail);
  const setting = parseSetting(r.setting);
  return {
    ...action,
    ...(lineFacts !== undefined ? { lineFacts } : {}),
    ...(bankDetail !== undefined ? { bankDetail } : {}),
    ...(setting !== undefined ? { setting } : {}),
    // Never a supplier IBAN change, whatever a row says (the judge): it is confirmed one by one.
    batchable: r.batchable === true && action.actionTool !== IBAN_CHANGE_VERB,
    certainty,
    evidenceReasons: Array.isArray(evidence.reasons) ? evidence.reasons.filter((x): x is string => typeof x === 'string') : [],
    resolvedAt: str(r.resolvedAt),
    resolvedBy: str(r.resolvedBy),
    closureKind: str(r.closureKind),
    decidedUnderGrant: decidedUnderGrantOf(r.history),
    decidedOnOwnerWord: decidedOnOwnerWordOf(r.history),
  };
}

/** The whole answer: every row with its facts, and the batch setting. */
export function parseVorschlaege(body: unknown): VorschlaegeAnswer {
  const list = record(body).actions;
  const raws = Array.isArray(list) ? list : [];
  const parsed = parseDrafted(body);
  const mode = record(body).approvalBatchMode;
  return {
    items: parsed.map((a, i) => itemOf(a, raws[i])),
    batchMode: mode === 'single' || mode === 'all_with_confirm' ? mode : 'tick',
  };
}

/** A verb in words: its catalogue label, else the name spaced (never snake_case). */
export function verbWords(t: T, verb: string): string {
  return LABELLED_VERBS.has(verb) ? t(`agent.verb.${verb}`) : verb.replace(/_/g, ' ');
}

/** The enum values of the settings the agent proposes most, said in words (`agent.vq.settingValue.*`). */
const SETTING_VALUE_WORDS: ReadonlySet<string> = new Set([
  'suggest', 'book', 'bulk', 'off', 'on', 'tick', 'single', 'all_with_confirm', 'engine', 'refuse', 'warn', 'reverse', 'keep', 'guthaben', 'anzahlung', 'ask', 'auto',
]);

/**
 * A setting value in words: yes/no for a switch, a known enum value in words, a number as written; an enum
 * value the Studio has no words for is quoted, so it reads as a value and never as prose.
 */
export function settingValueWords(t: T, value: unknown): string {
  if (typeof value === 'boolean') return t(value ? 'agent.line.yes' : 'agent.line.no');
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    if (SETTING_VALUE_WORDS.has(value)) return t(`agent.vq.settingValue.${value}`);
    return t('agent.vq.quoted', { text: value.replace(/_/g, ' ') });
  }
  return String(value);
}

/** Straight quotes in a label become the locale's typographic ones: 'x' reads «x» (de-CH), “x” (en). */
export function typographicQuotes(locale: Locale, text: string): string {
  const [open, close] = locale === 'en' ? ['\u201c', '\u201d'] : ['\u00ab', '\u00bb'];
  return text.replace(/'([^']+)'/g, `${open}$1${close}`).replace(/"([^"]+)"/g, `${open}$1${close}`);
}

/** The last day of a period ("2026-Q1" -> "2026-03-31", "2026-H2" -> "2026-12-31", "2026-03" -> "2026-03-31"). */
export function periodEnd(period: string): string | null {
  const q = /^(\d{4})-(Q[1-4]|H[12])$/.exec(period);
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  let year: number;
  let month: number;
  if (q !== null) {
    year = Number(q[1]);
    const part = q[2] as string;
    month = part === 'H1' ? 6 : part === 'H2' ? 12 : Number(part.slice(1)) * 3;
  } else if (m !== null) {
    year = Number(m[1]);
    month = Number(m[2]);
  } else if (/^\d{4}$/.test(period)) {
    year = Number(period);
    month = 12;
  } else return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

const DATE_KEYS: readonly string[] = ['date', 'billDate', 'invoiceDate', 'documentDate', 'bookingDate', 'valueDate', 'issueDate'];

/**
 * The record's business date (D197 judge, point 10): the bank date of a bank line, the document date of a
 * posting or a bill, the end of a filed period. Null when the act has none (a setting, a contact, an IBAN):
 * the row then shows the proposal date, dim.
 */
export function businessDate(item: Pick<VorschlagItem, 'lineFacts' | 'payload'>): string | null {
  const line = item.lineFacts ?? null;
  if (line !== null && line.date !== null) return line.date;
  for (const key of DATE_KEYS) {
    const v = item.payload[key];
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  }
  const period = item.payload.period;
  if (typeof period === 'string') return periodEnd(period);
  return null;
}

/**
 * Where the record a Vorschlag acts on lives, for the "Zum Datensatz" way on of a changed one: the bank line,
 * the supplier's bills, the entry. Null when the record has no route.
 */
export function recordRouteOf(item: Pick<VorschlagItem, 'payload' | 'actionTool'>): string | null {
  const p = item.payload;
  if (typeof p.bankTxnId === 'string' && p.bankTxnId !== '') return `/bank?line=${encodeURIComponent(p.bankTxnId)}`;
  if (typeof p.entryId === 'string' && p.entryId !== '') return `/journal?entryId=${encodeURIComponent(p.entryId)}`;
  if (typeof p.vendorId === 'string' && p.vendorId !== '') return `/bills?vendor=${encodeURIComponent(p.vendorId)}`;
  return null;
}

/** The cells of one row. */
export interface RowFacts {
  /** The counterparty, the drafted thing's own text, the supplier, the setting: what it is about. */
  subject: string;
  /** What the agent wants to do, in words ("Bankzeile buchen"). */
  kind: string;
  /** `dd.mm.yyyy`, or null: the record's business date, else the proposal date. */
  date: string | null;
  /** The date is the proposal's (the record has no business date): it reads dim. */
  dateIsProposal?: boolean;
  /** Signed where the engine knows the direction (a bank line); null when the act moves no money. */
  amountMinor: number | null;
  currency: string;
  certainty: Certainty | null;
  hasBeleg: boolean;
  /** Money in or out, from a bank line's sign; null when unknown. */
  direction: 'in' | 'out' | null;
  /** The record changed since the proposal: approving would run nothing. */
  stale: boolean;
  /** A supplier IBAN change: its kind (old and new IBAN) stays on the face at every width (the judge). */
  ibanChange?: boolean;
}

/** The subject of a row, never the bare verb when anything better is known (audit F-03). */
export function subjectOf(t: T, locale: Locale, item: VorschlagItem): string {
  const line = item.lineFacts ?? null;
  if (line !== null && line.counterparty !== null) return line.counterparty;
  const thing = payloadTitle(item.payload);
  if (thing !== null) return thing.text;
  if (line !== null && line.text !== null) return line.text;
  if (item.bankDetail !== undefined) return item.bankDetail.contactName ?? item.payloadLabels?.vendorId ?? t('agent.vq.ibanUnknownSupplier');
  if (item.setting !== undefined) {
    const label = typographicQuotes(locale, item.setting.label?.[locale === 'en' ? 'en' : 'de-CH'] ?? item.setting.key);
    return t('agent.vq.settingSubject', { setting: label, value: settingValueWords(t, item.setting.value) });
  }
  const f = item.figures ?? null;
  if (f !== null && f.counterparty !== null) return f.counterparty;
  // The contact the act is about, as the engine named it (a supplier's bill, a customer's payment).
  const labels = item.payloadLabels ?? {};
  for (const key of ['vendorId', 'contactId', 'customerId', 'debtorId']) {
    const name = labels[key];
    if (typeof name === 'string' && name !== '') return name;
  }
  // A filing or a report is about a period: "2026-Q1 (Jan. bis März)", the act in words beside it.
  if (typeof item.payload.period === 'string' && item.payload.period !== '') return periodLabel(t, locale, item.payload.period);
  return verbWords(t, item.actionTool);
}

/**
 * What the row says beside its subject (D162 point 1: what you approve is on the face, never only behind
 * Details): the accounts an act books, the counterparty and the recipient the pin names (each once: not the
 * subject again), a supplier IBAN change's old and new IBAN (the judge); else the act in words.
 */
export function kindOf(t: T, item: VorschlagItem, accounts?: AccountNameMap, subject?: string): string {
  if (item.bankDetail !== undefined) {
    return t('agent.vq.ibanRow', { old: oldIbanText(t, item.bankDetail), new: item.bankDetail.newIban ?? '' });
  }
  const parts: string[] = [];
  const phrase = accountsPhrase(t, item, accounts, false);
  if (phrase !== null) parts.push(phrase);
  const f = item.figures ?? null;
  if (f !== null && f.counterparty !== null && f.counterparty !== subject) parts.push(f.counterparty);
  if (f !== null && f.recipient !== null) parts.push(t('agent.line.essentials.recipient', { recipient: f.recipient }));
  return parts.length > 0 ? parts.join(' · ') : verbWords(t, item.actionTool);
}

export function rowFacts(t: T, locale: Locale, item: VorschlagItem, accounts?: AccountNameMap, subjectOverride?: string): RowFacts {
  const line = item.lineFacts ?? null;
  const f = item.figures ?? null;
  let amountMinor: number | null = null;
  let currency = 'CHF';
  if (line !== null) {
    amountMinor = line.amountMinor;
    currency = line.currency;
  } else if (f !== null && (f.grossMinor ?? f.amountMinor) !== null) {
    amountMinor = f.grossMinor ?? f.amountMinor;
    currency = f.currency ?? 'CHF';
  } else {
    amountMinor = payloadAmount(item.payload);
    if (typeof item.payload.currency === 'string' && item.payload.currency.length === 3) currency = item.payload.currency;
  }
  const business = businessDate(item);
  const rawDate = business ?? item.createdAt;
  const date = typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? formatDate(rawDate.slice(0, 10)) : null;
  const subject = subjectOverride ?? subjectOf(t, locale, item);
  return {
    subject,
    kind: kindOf(t, item, accounts, subject),
    date,
    dateIsProposal: business === null,
    amountMinor,
    currency,
    certainty: item.certainty,
    hasBeleg: (item.belege?.length ?? 0) > 0,
    direction: line === null ? null : line.amountMinor < 0 ? 'out' : 'in',
    stale: item.status === 'pending' && item.changedSinceProposal === true,
    ibanChange: item.bankDetail !== undefined,
  };
}

/** The money a row shows, for search: "CHF -45.00" and "45.00" both find it. */
export function searchText(t: T, locale: Locale, item: VorschlagItem, accounts?: AccountNameMap): string {
  const r = rowFacts(t, locale, item, accounts);
  const money = r.amountMinor === null ? '' : `${formatMoney(r.amountMinor, r.currency)} ${formatMoney(Math.abs(r.amountMinor), r.currency)}`;
  return [r.subject, r.kind, verbWords(t, item.actionTool), r.date ?? '', money, item.agentReason ?? '', item.lineFacts?.text ?? ''].join(' ').toLowerCase();
}

/** The current IBAN as the row and the detail say it: the IBAN, "keine" when none is set, "nicht sichtbar" when withheld. */
export function oldIbanText(t: (key: string) => string, d: BankDetail): string {
  if (d.oldIban !== null) return d.oldIban;
  return d.withheld ? t('agent.vq.ibanWithheld') : t('agent.vq.ibanNone');
}
