/**
 * D178 point 4 (spec A20 §11.2): MT940, the SWIFT customer statement, read into the SAME parsed
 * statement shape camt has (`ParsedBankStatement`, `messageType: 'mt940'`), so one insertion, one inbox
 * and one cross-format rule serve every format. Pure: no store, no clock, no network.
 *
 * PINNED TO PRIMARY SOURCES, fetched 21.10.2026 and read directly:
 *
 *  - Zürcher Kantonalbank, "Kontoreporting MT940 und MT942" (November 2013). The field table: `:20:`
 *    16x (Referenznummer), `:25:` 35x (Kontobezeichnung: an account number such as `110001234567`,
 *    `1100-1234.567`, or an IBAN), `:28C:` 5n[/5n] (Auszugsnummer/Folgenummer), `:60a:` F or M
 *    (Vortagessaldo), `:61:` `6!n[4!n]2a[1!a]15d1!a3!c16x[//16x][34x]` (Kontoauszug-Zeile), `:86:` 6*65x,
 *    `:62a:` F or M (Neuer Saldo), `:64:`/`:65:` (Valutasaldo). Several MT940 are appended in one file;
 *    a Datalink file carries no trailer and a record ends with `}`. The `:86:` tags ZKB writes: `?ZKB:`
 *    (the business-case number, then a booking number), the free text (name and address, the payment
 *    reason, the bank's message), and the `?ZI:` block: `?0:` currency/original amount, `?1:` the
 *    ordering bank's rate, `?2:` currency/paid amount, `?3:` the ZKB rate, `?4:` to `?7:` the ordering
 *    bank's charges, `?8:` the ZKB charges, `?9:` the number of items, `?20:` to `?26:` the FX deal, `?ZX`
 *    no room for all of it. The example message (`:61:110708C688,35NTRFNONREF//7093070822670002`,
 *    `?ZI:?0:CHF700,35?4:CHF12,`) is reproduced in spirit by the synthetic suite, never verbatim.
 *  - BNP Paribas Germany, "MT940 Reporting Characteristics" (`mt940-details.pdf`): the `:61:` subfields
 *    (61-1 value date 6!n, 61-2 entry date [4!n], 61-3 debit/credit mark 2a, 61-4 funds code [1!a], 61-5
 *    amount 15d, 61-6 transaction type 1!a3!c, 61-7 reference for the account owner 16x, 61-8 the account
 *    servicing institution's reference [//16x], 61-9 supplementary details [34x]); the German structured
 *    `:86:` (a 3-digit GVC, `?00` posting text, `?20` to `?29` purpose with the keywords `EREF+`, `KREF+`,
 *    `SVWZ+`, `ABWA+`, `PURP+`, continued in `?60` to `?63`, `?30` counterparty BIC, `?31` counterparty
 *    account, `?32`/`?33` counterparty name, `?34` return reason); and the SWIFT-standard `:86:` keywords
 *    `/OCMT/` (original amount), `/CHGS/` (charges), `/EXCH/` (the rate applied to the original amount),
 *    `/REMI/` (remittance), `/EREF/`, `/ORDP/NAME/`, `/BENM/NAME/`.
 *
 * THE MARK (61-3). `C` money in, `D` money out; `RC` (reversal of a credit) is money out and `RD`
 * (reversal of a debit) money in, both reversals; `EC`/`ED` are EXPECTED entries (ZKB: "Dispomeldungen",
 * MT942 only) and are skipped as `pending`, never imported as booked facts, the camt PDNG rule.
 *
 * THE LINE KEY (A20 §11.4, re-cut D178 round 3): `m9:<bank reference>` when 61-8 is there (a reference
 * repeated inside one message keys `#<n>`, the A39 L7 (a) rule): the bank's own word, the only MT940 key
 * that may drop a line as already in the books. Else `m9c:<value date>|<entry date>|<mark>|<amount>|
 * <currency>#<n>`, `n` counting earlier lines of that signature in the message: a storage label, never an
 * identity. The statement number, the page and the file are the DELIVERY's identity (already_imported,
 * statement_amended), never part of a line key. Whether such a line is already in the books is decided by
 * coverage (statementCoverage.ts): an extending statement's lines are new, an overlapping one's are matched
 * one to one on their movement and flagged.
 *
 * THE PERIOD: the days after the opening balance's date (`:60F:`) up to the closing balance's date
 * (`:62F:`), or the closing date alone when the bank dates both alike. A line belongs to that period,
 * never to its value date (a card line carries the purchase day).
 *
 * A `:61:` of zero is skipped `zero_amount`, as a CSV row of zero is (critic L2): no zero line in the inbox.
 */

import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { CamtCreditDebit, ParsedBankStatement, ParsedCamtEntry, SkippedCamtEntry } from './camt.js';
import { deriveFacts, emptyFacts, parseDecimal, swissAmountToMinor } from './statementFacts.js';
import type { ChargeRecordFact, ParsedLineFacts } from './statementFacts.js';

/** One MT940 statement: the shared shape plus the raw `:25:` the importer checks the account against. */
export interface ParsedMt940Statement extends ParsedBankStatement {
  messageType: 'mt940';
  /** `:25:` as the bank wrote it (an account number, an IBAN, or BIC/account). */
  accountField: string;
  /** `:20:`, the message reference. */
  transactionReference: string | null;
}

interface Field {
  tag: string;
  value: string;
}

/** How far into a file the format is looked for (bounded: a pathological file never costs more). */
const DETECT_LINES = 200;
const DETECT_LINE_CHARS = 512;

/**
 * Is this text an MT940 (rather than a CSV)? A `:20:` and a `:25:`, `:61:` or `:60F:`/`:60M:` field at a
 * line start, among the first lines. Line by line with string operations only, so no input (a file of
 * newlines or spaces) can make the scan backtrack.
 */
export function looksLikeMt940(text: string): boolean {
  let trn = false;
  let body = false;
  let seen = 0;
  let start = 0;
  while (start <= text.length && seen < DETECT_LINES) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    seen += 1;
    let line = text.slice(start, Math.min(end, start + DETECT_LINE_CHARS)).trimStart();
    const env = line.lastIndexOf('{4:');
    if (env !== -1) line = line.slice(env + 3).trimStart();
    if (line.startsWith(':20:')) trn = true;
    if (line.startsWith(':25:') || line.startsWith(':61:') || line.startsWith(':60F:') || line.startsWith(':60M:')) body = true;
    if (trn && body) return true;
    start = end + 1;
  }
  return false;
}

/**
 * Remove the SWIFT envelope blocks (`{1:...}`, `{2:...}`, `{3:...}`, `{5:...}`, nested braces allowed)
 * and the `{4:` opener, in one linear scan rather than a regular expression.
 */
function stripEnvelope(text: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open === -1) {
      out.push(text.slice(i));
      break;
    }
    out.push(text.slice(i, open));
    const kind = text[open + 1] ?? '';
    if (text[open + 2] !== ':' || !'12345'.includes(kind) || kind === '') {
      out.push('{');
      i = open + 1;
      continue;
    }
    if (kind === '4') {
      out.push('\n');
      i = open + 3;
      continue;
    }
    let depth = 0;
    let j = open;
    for (; j < text.length; j += 1) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push('\n');
    i = j + 1;
  }
  return out.join('');
}

/** Strip the SWIFT envelope and split into fields, in order. */
function fieldsOf(text: string): Field[] {
  const body = stripEnvelope(text.replace(/\r\n?/g, '\n'));
  const fields: Field[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trimEnd();
    const m = /^:(\d{2}[A-Z]?):(.*)$/.exec(line);
    if (m !== null) {
      fields.push({ tag: m[1] as string, value: m[2] as string });
      continue;
    }
    if (/^-\}?$/.test(line.trim()) || line.trim() === '}') continue;
    const last = fields[fields.length - 1];
    if (last !== undefined && line.length > 0) last.value += `\n${line}`;
  }
  return fields;
}

/** A two-digit SWIFT year in this century (statements are never older than 2000 in this engine). */
function isoDate(yymmdd: string): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const y = 2000 + Number(yymmdd.slice(0, 2));
  const m = Number(yymmdd.slice(2, 4));
  const d = Number(yymmdd.slice(4, 6));
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** The entry date `MMDD` in the value date's year, moved across a year end when the months are far apart. */
function entryIso(mmdd: string, valueIso: string): string | null {
  const vy = Number(valueIso.slice(0, 4));
  const vm = Number(valueIso.slice(5, 7));
  const em = Number(mmdd.slice(0, 2));
  let year = vy;
  if (em - vm > 6) year -= 1;
  else if (vm - em > 6) year += 1;
  return isoDate(`${String(year).slice(2)}${mmdd}`);
}

/** `:60F:`/`:62F:` `1!a6!n3!a15d`: D or C, date, currency, amount with a decimal comma. */
function balanceOf(value: string): { minor: number; currency: string; date: string } | null {
  const m = /^([CD])(\d{6})([A-Z]{3})([\d,]+)$/.exec(value.trim());
  if (m === null) return null;
  const minor = swissAmountToMinor(m[4] as string, ',');
  const date = isoDate(m[2] as string);
  if (minor === null || date === null) return null;
  return { minor: m[1] === 'D' ? -minor : minor, currency: m[3] as string, date };
}

interface StatementLine {
  valueDate: string;
  entryDate: string | null;
  mark: 'C' | 'D' | 'RC' | 'RD' | 'EC' | 'ED';
  amountMinor: number;
  typeCode: string;
  customerRef: string | null;
  bankRef: string | null;
  supplementary: string | null;
}

/** `:61:` read subfield by subfield (61-1 to 61-9), or why not. */
function statementLineOf(value: string): StatementLine | { error: 'unreadable_date' | 'unreadable_amount' } {
  const [first = '', ...rest] = value.split('\n');
  let s = first;
  const valueDate = isoDate(s.slice(0, 6));
  if (valueDate === null) return { error: 'unreadable_date' };
  s = s.slice(6);
  let entryDate: string | null = null;
  if (/^\d{4}/.test(s)) {
    entryDate = entryIso(s.slice(0, 4), valueDate);
    if (entryDate === null) return { error: 'unreadable_date' };
    s = s.slice(4);
  }
  let mark: StatementLine['mark'];
  const two = s.slice(0, 2);
  if (two === 'RC' || two === 'RD' || two === 'EC' || two === 'ED') {
    mark = two;
    s = s.slice(2);
  } else if (s[0] === 'C' || s[0] === 'D') {
    mark = s[0];
    s = s.slice(1);
  } else return { error: 'unreadable_amount' };
  if (/^[A-Z]/.test(s)) s = s.slice(1); // 61-4 funds code
  const am = /^(\d+(?:,\d{0,2})?)/.exec(s);
  if (am === null) return { error: 'unreadable_amount' };
  const amountMinor = swissAmountToMinor(am[1] as string, ',');
  if (amountMinor === null) return { error: 'unreadable_amount' };
  s = s.slice((am[1] as string).length);
  const type = /^([NFS][A-Z0-9]{3})/.exec(s);
  if (type === null) return { error: 'unreadable_amount' };
  s = s.slice(4);
  const at = s.indexOf('//');
  const customer = (at === -1 ? s : s.slice(0, at)).trim();
  const bank = at === -1 ? '' : s.slice(at + 2).trim();
  const supplementary = rest.join(' ').trim();
  return {
    valueDate,
    entryDate,
    mark,
    amountMinor,
    typeCode: type[1] as string,
    customerRef: customer === '' || customer.toUpperCase() === 'NONREF' ? null : customer,
    bankRef: bank === '' ? null : bank,
    supplementary: supplementary === '' ? null : supplementary,
  };
}

/** What the `:86:` of one line says, in whichever of the three published structures it is written. */
interface Info86 {
  bankText: string | null;
  counterpartyName: string | null;
  counterpartyAccount: string | null;
  endToEndId: string | null;
  paymentInfoId: string | null;
  proprietary: string | null;
  issuer: string | null;
  instructed: { amountMinor: number; currency: string } | null;
  rate: string | null;
  charges: ChargeRecordFact[];
}

function emptyInfo(): Info86 {
  return {
    bankText: null,
    counterpartyName: null,
    counterpartyAccount: null,
    endToEndId: null,
    paymentInfoId: null,
    proprietary: null,
    issuer: null,
    instructed: null,
    rate: null,
    charges: [],
  };
}

/** `CHF700,35` / `USD60.78` / `CHF 12,`: a currency and an amount, or null. */
function currencyAmount(raw: string): { amountMinor: number; currency: string } | null {
  const v = raw.trim();
  if (v.length < 4 || v.length > 64) return null;
  const currency = v.slice(0, 3);
  const amount = v.slice(3).trim();
  if (!/^[A-Z]{3}$/.test(currency) || !/^[\d'.,]+$/.test(amount)) return null;
  const minor = swissAmountToMinor(amount, amount.includes(',') ? ',' : '.');
  return minor === null ? null : { amountMinor: minor, currency };
}

/** Drop trailing `/` characters with a loop (a `\/+$` pattern is quadratic on a long run of slashes). */
function trimSlashes(v: string): string {
  let end = v.length;
  while (end > 0 && v[end - 1] === '/') end -= 1;
  return v.slice(0, end);
}

function rateText(raw: string): string | null {
  const t = raw.trim().replace(',', '.');
  return parseDecimal(t) === null ? null : t;
}

const SEPA_KEYWORDS = ['EREF', 'KREF', 'MREF', 'CRED', 'DEBT', 'SVWZ', 'ABWA', 'ABWE', 'PURP', 'COAM', 'OAMT'];

/** The SEPA keyword values inside a German purpose text (`EREF+...SVWZ+...`). */
function sepaParts(purpose: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = new RegExp(`(${SEPA_KEYWORDS.join('|')})\\+`, 'g');
  const hits: { key: string; at: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(purpose)) !== null) hits.push({ key: m[1] as string, at: m.index, end: m.index + m[0].length });
  hits.forEach((h, i) => {
    const next = hits[i + 1];
    out.set(h.key, purpose.slice(h.end, next === undefined ? undefined : next.at).trim());
  });
  return out;
}

/** The SWIFT-standard `/KEY/value/` structure (`/OCMT/`, `/CHGS/`, `/EXCH/`, `/REMI/`, `/EREF/`, ...). */
const SWIFT_KEYS = new Set(['OCMT', 'CHGS', 'EXCH', 'REMI', 'EREF', 'ORDP', 'BENM', 'NAME', 'IREF', 'PREF', 'TYPE', 'CODE', 'BBK', 'OBK', 'INFO', 'ULTD', 'PURP', 'URGP', 'TR', 'EARM', 'RTRN']);

function swiftParts(text: string): Map<string, string> {
  const tokens = text.replace(/\n/g, '').split('/');
  const out = new Map<string, string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const key = tokens[i] as string;
    if (!SWIFT_KEYS.has(key)) continue;
    if ((key === 'ORDP' || key === 'BENM' || key === 'ULTD') && tokens[i + 1] === 'NAME') {
      out.set(key, (tokens[i + 2] ?? '').trim());
      i += 2;
      continue;
    }
    const values: string[] = [];
    let j = i + 1;
    while (j < tokens.length && !SWIFT_KEYS.has(tokens[j] as string)) {
      values.push(tokens[j] as string);
      j += 1;
    }
    out.set(key, trimSlashes(values.join('/')).trim());
    i = j - 1;
  }
  return out;
}

/** Read one `:86:` (ZKB `?ZKB:`/`?ZI:`, German GVC `?NN`, SWIFT `/KEY/`, or plain text). */
function info86(raw: string | null): Info86 {
  const info = emptyInfo();
  if (raw === null || raw.trim() === '') return info;
  const text = raw.replace(/\r/g, '');

  // ZKB: `?ZKB:<GVNR> <booking no>`, free text lines, then the `?ZI:` block of `?n:` tags.
  if (/\?ZKB:/.test(text)) {
    const head = /\?ZKB: {0,3}(\d{1,12})/.exec(text);
    info.proprietary = head === null ? null : (head[1] as string);
    info.issuer = 'ZKB';
    const ziAt = text.indexOf('?ZI:');
    const free = (ziAt === -1 ? text : text.slice(0, ziAt)).replace(/\?ZKB:[^\n]*/, '').replace(/\?ZX/g, '');
    const lines = free.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    info.counterpartyName = lines[0] ?? null;
    info.bankText = lines.length > 0 ? lines.join(' ') : null;
    if (ziAt !== -1) {
      const block = text.slice(ziAt + 4).replace(/\n/g, '').replace(/\?ZX/g, '');
      const tags = new Map<string, string>();
      const re = /\?(\d{1,2}):([^?]*)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(block)) !== null) tags.set(m[1] as string, (m[2] as string).trim());
      const original = tags.get('0');
      if (original !== undefined) info.instructed = currencyAmount(original);
      const rate = tags.get('3') ?? tags.get('1');
      if (rate !== undefined) info.rate = rateText(rate);
      for (const k of ['4', '5', '6', '7', '8']) {
        const c = tags.get(k);
        const amount = c === undefined ? null : currencyAmount(c);
        if (amount !== null) info.charges.push({ ...amount, creditDebit: null, included: null, type: k === '8' ? 'bank' : 'ordering_bank' });
      }
    }
    return info;
  }

  // German structured: a 3-digit GVC and `?NN` subfields (no colon); wrapped lines join without a space.
  const dk = /^(\d{3})\?/.exec(text.trim());
  if (dk !== null) {
    info.proprietary = dk[1] as string;
    info.issuer = 'DK';
    const flat = text.trim().replace(/\n/g, '');
    const parts = new Map<number, string>();
    const re = /\?(\d{2})([^?]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(flat)) !== null) {
      const n = Number(m[1]);
      parts.set(n, (parts.get(n) ?? '') + (m[2] as string));
    }
    const purpose = [...Array.from({ length: 10 }, (_, i) => parts.get(20 + i)), ...Array.from({ length: 4 }, (_, i) => parts.get(60 + i))]
      .filter((p): p is string => p !== undefined)
      .join('');
    const sepa = sepaParts(purpose);
    const swift = swiftParts(purpose);
    info.endToEndId = sepa.get('EREF') ?? swift.get('EREF') ?? null;
    if (info.endToEndId !== null && info.endToEndId.toUpperCase() === 'NOTPROVIDED') info.endToEndId = null;
    info.paymentInfoId = sepa.get('KREF') ?? null;
    const svwz = sepa.get('SVWZ');
    info.bankText = svwz ?? (sepa.size === 0 && swift.size === 0 ? purpose.trim() || null : null) ?? (parts.get(0)?.trim() || null);
    const name = `${parts.get(32) ?? ''}${parts.get(33) ?? ''}`.trim();
    info.counterpartyName = name === '' ? null : name;
    const account = (parts.get(31) ?? '').trim();
    info.counterpartyAccount = account === '' ? null : account;
    applySwiftAmounts(info, swift);
    return info;
  }

  // SWIFT standard keywords.
  if (/\/(OCMT|CHGS|EXCH|REMI|EREF|ORDP|BENM)\//.test(text)) {
    const swift = swiftParts(text);
    info.bankText = swift.get('REMI') ?? null;
    const e2e = swift.get('EREF') ?? null;
    info.endToEndId = e2e !== null && e2e.toUpperCase() !== 'NOTPROVIDED' && e2e !== '' ? e2e : null;
    info.counterpartyName = swift.get('ORDP') ?? swift.get('BENM') ?? null;
    applySwiftAmounts(info, swift);
    return info;
  }

  info.bankText = text.split('\n').map((l) => l.trim()).filter((l) => l !== '').join(' ') || null;
  return info;
}

/** `/OCMT/` the original amount, `/CHGS/` the charges, `/EXCH/` the rate applied to the original amount. */
function applySwiftAmounts(info: Info86, swift: Map<string, string>): void {
  const ocmt = swift.get('OCMT');
  if (ocmt !== undefined) info.instructed = currencyAmount(ocmt);
  const exch = swift.get('EXCH');
  if (exch !== undefined) info.rate = rateText(exch);
  const chgs = swift.get('CHGS');
  const charge = chgs === undefined ? null : currencyAmount(chgs);
  if (charge !== null) info.charges.push({ ...charge, creditDebit: null, included: null, type: 'charges' });
}

function isIban(v: string | null): boolean {
  return v !== null && v.length <= 64 && /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(v.replace(/\s+/g, '').toUpperCase());
}

export type ParseMt940Result = Result<{ statements: ParsedMt940Statement[] }>;

function nextIsoDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** The prefix of a content key (a line without a `//` bank reference). */
export const MT940_CONTENT_KEY = 'm9c:';

/** A content key's signature (all before `#n`) and its count, or null for any other key. */
export function contentKeyParts(key: string): { signature: string; n: number } | null {
  if (!key.startsWith(MT940_CONTENT_KEY) || key.includes('~dup')) return null;
  const hash = key.lastIndexOf('#');
  if (hash < 0) return null;
  const n = Number(key.slice(hash + 1));
  return Number.isSafeInteger(n) && n >= 0 ? { signature: key.slice(0, hash), n } : null;
}

/**
 * Parse one or more MT940 messages. Pure and total: never throws; `{ok:false}` is `schema_invalid`
 * naming why (a message without `:25:`, `:28C:`, an opening or a closing balance), the camt contract.
 */
export function parseMt940(input: unknown): ParseMt940Result {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return err('schema_invalid', { reason: 'the payload is not a non-empty MT940 text' });
  }
  const fields = fieldsOf(input);
  const messages: Field[][] = [];
  for (const f of fields) {
    if (f.tag === '20' || messages.length === 0) messages.push([]);
    (messages[messages.length - 1] as Field[]).push(f);
  }
  const statements: ParsedMt940Statement[] = [];
  for (let mi = 0; mi < messages.length; mi += 1) {
    const msg = messages[mi] as Field[];
    const where = `MT940 message ${mi + 1}`;
    const get = (tag: string): Field | undefined => msg.find((f) => f.tag === tag);
    const account = get('25');
    if (account === undefined) return err('schema_invalid', { reason: `${where}: :25: (the account) is mandatory and absent` });
    const number = get('28C') ?? get('28');
    const nm = number === undefined ? null : /^(\d+)(?:\/(\d+))?/.exec(number.value.trim());
    if (nm === null) return err('schema_invalid', { reason: `${where}: :28C: (statement number) is mandatory and unreadable` });
    const openField = get('60F') ?? get('60M');
    const closeField = get('62F') ?? get('62M');
    const opening = openField === undefined ? null : balanceOf(openField.value);
    const closing = closeField === undefined ? null : balanceOf(closeField.value);
    if (opening === null) return err('schema_invalid', { reason: `${where}: :60F: (opening balance) is mandatory and unreadable` });
    if (closing === null) return err('schema_invalid', { reason: `${where}: :62F: (closing balance) is mandatory and unreadable` });
    const currency = opening.currency;

    const entries: ParsedCamtEntry[] = [];
    const skipped: SkippedCamtEntry[] = [];
    const seenRefs = new Map<string, number>();
    const seenSignatures = new Map<string, number>();
    for (let fi = 0; fi < msg.length; fi += 1) {
      const f = msg[fi] as Field;
      if (f.tag !== '61') continue;
      const next = msg[fi + 1];
      const info = info86(next !== undefined && next.tag === '86' ? next.value : null);
      const line = statementLineOf(f.value);
      if ('error' in line) {
        skipped.push({ entryRef: null, reason: line.error });
        continue;
      }
      const ref = line.bankRef ?? line.customerRef;
      if (line.mark === 'EC' || line.mark === 'ED') {
        skipped.push({ entryRef: ref, reason: 'pending' });
        continue;
      }
      if (line.amountMinor === 0) {
        skipped.push({ entryRef: ref, reason: 'zero_amount' });
        continue;
      }
      const creditDebit: CamtCreditDebit = line.mark === 'C' || line.mark === 'RD' ? 'CRDT' : 'DBIT';
      const reversal = line.mark === 'RC' || line.mark === 'RD';
      let entryKey: string;
      if (line.bankRef !== null) {
        const repeats = seenRefs.get(line.bankRef) ?? 0;
        seenRefs.set(line.bankRef, repeats + 1);
        entryKey = `m9:${line.bankRef}${repeats > 0 ? `#${repeats}` : ''}`;
      } else {
        const signature = `${line.valueDate}|${line.entryDate ?? ''}|${line.mark}|${line.amountMinor}|${currency}`;
        const n = seenSignatures.get(signature) ?? 0;
        seenSignatures.set(signature, n + 1);
        entryKey = `${MT940_CONTENT_KEY}${signature}#${n}`;
      }
      const parsedFacts: ParsedLineFacts = {
        ...emptyFacts('mt940'),
        bankCode: { domain: null, family: null, subFamily: null, proprietary: info.proprietary ?? line.typeCode, issuer: info.proprietary !== null ? info.issuer : 'SWIFT' },
        bankText: info.bankText,
        additionalInfo: line.supplementary,
        refs: { endToEndId: info.endToEndId, accountServicerRef: line.bankRef, instructionId: null, transactionId: null },
        instructed: info.instructed,
        exchange:
          info.rate !== null && info.instructed !== null && info.instructed.currency !== currency
            ? { sourceCurrency: info.instructed.currency, targetCurrency: currency, unitCurrency: info.instructed.currency, rate: info.rate, effectiveRate: null, origin: 'structured' }
            : null,
        charges: info.charges.length > 0 ? { totalMinor: null, currency: info.charges[0]?.currency ?? null, records: info.charges, origin: 'structured' } : null,
      };
      const counterpartyIban = isIban(info.counterpartyAccount) ? (info.counterpartyAccount as string).replace(/\s+/g, '').toUpperCase() : null;
      entries.push({
        entryKey,
        entryRef: ref,
        amountMinor: line.amountMinor,
        currency,
        creditDebit,
        bookingDate: line.entryDate,
        valueDate: line.valueDate,
        reversalInd: reversal,
        btcDomain: null,
        btcFamily: null,
        btcSubFamily: null,
        batchPmtInfId: null,
        txPmtInfId: info.paymentInfoId,
        referenceKind: 'none',
        referenceValue: null,
        payerName: creditDebit === 'CRDT' ? info.counterpartyName : null,
        counterpartyName: info.counterpartyName,
        counterpartyIban,
        remittanceText: info.bankText ?? line.supplementary,
        endToEndId: info.endToEndId,
        facts: deriveFacts(parsedFacts, { amountMinor: line.amountMinor, currency, creditDebit }),
      });
    }
    // The statement's period from its balances: the day after the opening balance's date, else (both
    // dated alike) the closing date. A line's own dates never widen it.
    const periodFrom = opening.date < closing.date ? nextIsoDay(opening.date) : closing.date;
    // `:25:` is 35x by the standard; a longer value is cut before any pattern reads it.
    const accountField = account.value.trim().slice(0, 64);
    const ibanMatch = /[A-Z]{2}\d{2}[A-Z0-9]{11,30}/.exec(accountField.replace(/\s+/g, '').toUpperCase());
    const interim = openField?.tag === '60M' || closeField?.tag === '62M';
    statements.push({
      messageType: 'mt940',
      statementId: `mt940:${Number(nm[1])}:${closing.date}`,
      electronicSeqNb: null,
      pageNumber: nm[2] === undefined ? 1 : Number(nm[2]) || 1,
      lastPage: closeField?.tag !== '62M',
      splitPage: interim,
      iban: ibanMatch === null ? null : ibanMatch[0],
      fromDate: periodFrom,
      toDate: closing.date,
      // An `M` balance is an interim page's figure, never the statement's (the D81 rule for INTM).
      openingBalanceMinor: openField?.tag === '60F' ? opening.minor : null,
      closingBalanceMinor: closeField?.tag === '62F' ? closing.minor : null,
      balanceCurrency: currency,
      entries,
      skipped,
      accountField,
      transactionReference: get('20')?.value.trim() ?? null,
    });
  }
  if (statements.length === 0) return err('schema_invalid', { reason: 'no MT940 message (:20:) found' });
  return ok({ statements });
}
