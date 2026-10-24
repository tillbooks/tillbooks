/**
 * D178 point 19 (owner, 21.10.2026; spec A20 §11.4): IS A NEW BANK LINE ALREADY ON THE BOOKS? "keep
 * cross-format and have a mechanism where you flag possible duplicates to be approved by the user. same
 * amount, date, vendor/buyer, etc." The person decides; nothing across formats is dropped on a guess.
 *
 * ONLY THE SAME FORMAT'S EXACT KEY drops a line on import (D81 for camt, `m9:`/`m9c:` for MT940, `csv:` for
 * CSV), checked by the caller before this module is asked. Across formats the setting
 * `bank.cross_format_duplicates` decides:
 *  - `ask` (the default): nothing is dropped. Every possible duplicate is imported and FLAGGED, even one
 *    that shares the bank's own reference.
 *  - `auto_strong`: a stored line of another format with the same reference the BANK issued (the camt
 *    `AcctSvcrRef` and the MT940 `//` reference, 61-8, are one number, SPS 2.3 p.76), the same direction,
 *    amount and currency AND the same booking date drops the new line (`cross_format_duplicate`). Two
 *    DIFFERENT bank references never drop (critic R2-2: the bank says they are two postings), and an
 *    EndToEndId is the payer's, never the bank's: neither is proof. Everything weaker is still flagged.
 *
 * A CANDIDATE is a stored line of ANOTHER format (a CSV also of its own format, see below) with the same
 * direction, amount and currency, the same counterparty, and a date near:
 *  - the counterparty: the IBAN when both lines carry one (they must be equal); else the normalised name
 *    when both carry one (a shared word, legal forms and titles left out); when either side names nobody
 *    (a CSV without a counterparty column, an MT940 with a bare text), money and date alone make it;
 *  - the date: a date of one line (booking or value) within `NEAR_DAYS` of a date of the other, the
 *    minimum over both dates of each side. Comparing both dates already covers the purchase-to-booking
 *    gap of a card payment whenever one side carries both (camt always does; an MT940 always has its value
 *    date); the three days cover one format dating a posting by its booking day and another by the next
 *    business day across a weekend (Friday to Monday).
 *  - the SAME format, and every re-delivery or overlapping period, is decided by coverage first
 *    (statementCoverage.ts, the round 3 re-cut): an overlapping delivery's lines are matched one to one on
 *    their movement (`same_movement`) or flagged `covered_period_new_line`. This module adds point 19's
 *    cross-format candidates on top, for every line.
 * EVERY candidate is named on the new line (`bank_txn_duplicate_candidate`, the nearest first, at most
 * `MAX_CANDIDATES`), and the nearest is its flag (`bank_txn_possible_duplicate`). Naming never uses a stored
 * line up: it may be named for several new lines, today's or a later file's (critic R2-6: a near-date name
 * on Thursday must not hide Wednesday's real duplicate arriving later).
 *
 * A flagged line NEEDS A DECISION (`resolve_possible_duplicate`): until the person says "Duplikat" (the line
 * is ignored with that reason) or "Kein Duplikat" (it is a normal line again), it is never `sure`, never in
 * "Alle sicheren buchen", and `book_bank_line` refuses it (`duplicate_decision_pending`, critic R2-1).
 *
 * NEAR-LINEAR (critic M5): stored lines are indexed by reference and by (direction, amount, currency, day);
 * each new line looks up at most `2 x (2 x NEAR_DAYS + 1)` day buckets and reads at most `BUCKET_SCAN`
 * lines of each.
 */

import type { WorkspaceContext } from '../context.js';
import { err } from '../result.js';
import type { Err } from '../result.js';
import { normalizeIban } from '../setup/iban.js';
import { getSetting } from '../settings/settings.js';
import type { ParsedCamtEntry } from './camt.js';

/** Why a stored line is named as a possible duplicate of a new one (closed, §H-ENUM). */
export const POSSIBLE_DUPLICATE_REASONS = ['shared_reference', 'same_movement', 'same_date', 'near_date', 'covered_period_new_line'] as const;
export type PossibleDuplicateReason = (typeof POSSIBLE_DUPLICATE_REASONS)[number];

/** The setting `bank.cross_format_duplicates` (D178 point 19). */
export const CROSS_FORMAT_DUPLICATE_MODES = ['ask', 'auto_strong'] as const;
export type CrossFormatDuplicateMode = (typeof CROSS_FORMAT_DUPLICATE_MODES)[number];

/** The person's answer to a flagged line (closed, §H-ENUM). */
export const DUPLICATE_DECISIONS = ['duplicate', 'distinct'] as const;
export type DuplicateDecision = (typeof DUPLICATE_DECISIONS)[number];

/** A stored line a new line may be, and why it is named. */
export interface PossibleDuplicate {
  bankTxnId: string;
  reason: PossibleDuplicateReason;
}

/** A line's flag: why it waits for the person, and the stored line it names first (null: none, `covered_period_new_line`). */
export interface DuplicateFlag {
  bankTxnId: string | null;
  reason: PossibleDuplicateReason;
}

/** Under `auto_strong`, a bank reference proves the movement only on the same booking date (0 days apart). */
export const ABSORB_BOOKING_DAYS = 0;

/** The window a resemblance is named in (and the stored lines read around a file's dates). */
export const NEAR_DAYS = 3;

/** The most candidates one new line names (the nearest first). */
export const MAX_CANDIDATES = 10;

/** The most lines of one day bucket a new line reads (a day of a thousand identical amounts stays linear). */
const BUCKET_SCAN = 512;

/** The format family a statement row belongs to: camt.053 and camt.054 are one family. */
export function formatFamilyOf(messageType: string): string {
  return messageType.startsWith('camt') ? 'camt' : messageType;
}

/** The workspace's `bank.cross_format_duplicates`, `ask` unless set otherwise. */
export function crossFormatModeOf(ctx: WorkspaceContext): CrossFormatDuplicateMode {
  const v = getSetting<string>(ctx, 'bank.cross_format_duplicates');
  return v === 'auto_strong' ? 'auto_strong' : 'ask';
}

const PLACEHOLDER_REFS = new Set(['', 'NONREF', 'NOTPROVIDED', 'NOREF']);

/** A reference worth comparing, or null for an empty or placeholder one. */
function realRef(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  return PLACEHOLDER_REFS.has(t.toUpperCase()) ? null : t;
}

/** The bank reference a stored key carries (`asr:R`, `asr:R#1`, `m9:R`, `m9:R~dup1`), for lines whose facts predate D178. */
function refOfKey(key: string): string | null {
  const prefix = key.startsWith('asr:') ? 4 : key.startsWith('m9:') ? 3 : -1;
  if (prefix < 0) return null;
  let body = key.slice(prefix);
  const dup = body.indexOf('~dup');
  if (dup >= 0) body = body.slice(0, dup);
  const hash = body.lastIndexOf('#');
  if (hash >= 0 && /^\d+$/.test(body.slice(hash + 1))) body = body.slice(0, hash);
  return realRef(body);
}

function dayOf(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.round(ms / 86_400_000);
}

function shiftIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Words a counterparty name shares with every other: legal forms, titles, joiners. */
const NAME_NOISE = new Set([
  'ag', 'gmbh', 'sa', 'sarl', 'sagl', 'ltd', 'llc', 'inc', 'kg', 'ohg', 'co', 'cie', 'und', 'and', 'et', 'the', 'der', 'die',
  'das', 'herr', 'frau', 'mr', 'mrs', 'ms', 'dr', 'mme', 'm', 'von', 'van', 'de', 'du', 'la', 'le',
]);

/** A counterparty name as its significant words: lower case, accents folded, legal forms and titles out. */
export function nameTokens(name: string | null | undefined): ReadonlySet<string> | null {
  if (name === null || name === undefined) return null;
  const folded = name
    .slice(0, 200)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  const words = folded.split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !NAME_NOISE.has(w));
  return words.length === 0 ? null : new Set(words);
}

function normalizedIban(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const compact = v.replace(/\s+/g, '').toUpperCase();
  return compact.length <= 34 && /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(compact) ? normalizeIban(compact) : null;
}

/** The two lines' counterparties do not contradict: the IBANs agree when both carry one, else a name word is shared, else either names nobody. */
function counterpartyAgrees(a: { iban: string | null; names: ReadonlySet<string> | null }, b: { iban: string | null; names: ReadonlySet<string> | null }): boolean {
  if (a.iban !== null && b.iban !== null) return a.iban === b.iban;
  if (a.names !== null && b.names !== null) {
    for (const w of a.names) if (b.names.has(w)) return true;
    return false;
  }
  return true;
}

/** A line already on the Bankkonto, as the rule reads it. */
export interface StoredLine {
  id: string;
  order: number;
  family: string;
  bookingDay: number | null;
  valueDay: number | null;
  /** ISO dates, for the CSV period check. */
  bookingDate: string | null;
  valueDate: string | null;
  money: string;
  /** The bank's own reference (camt AcctSvcrRef, MT940 `//`), or null; a CSV has none. */
  bankRef: string | null;
  iban: string | null;
  names: ReadonlySet<string> | null;
}

/** A new line whose own exact key is new, as the rule reads it. */
export interface IncomingLine {
  index: number;
  bookingDay: number | null;
  valueDay: number | null;
  money: string;
  bankRef: string | null;
  iban: string | null;
  names: ReadonlySet<string> | null;
}

export type LineDecision = { kind: 'absorb'; existingBankTxnId: string } | { kind: 'flag'; candidates: PossibleDuplicate[] };

function moneyOf(creditDebit: string, amountMinor: number, currency: string): string {
  return `${creditDebit}|${amountMinor}|${currency}`;
}

/**
 * A parsed line as the rule reads it. Only camt and MT940 carry a bank reference (the camt `AcctSvcrRef`,
 * the MT940 `//`); a CSV column is the person's mapping, never the bank's word.
 */
export function incomingOf(entry: ParsedCamtEntry, index: number, family: string): IncomingLine {
  const strong = family === 'camt' || family === 'mt940';
  return {
    index,
    bookingDay: dayOf(entry.bookingDate),
    valueDay: dayOf(entry.valueDate),
    money: moneyOf(entry.creditDebit, entry.amountMinor, entry.currency),
    bankRef: strong ? realRef(entry.facts?.refs.accountServicerRef ?? null) : null,
    iban: normalizedIban(entry.counterpartyIban),
    names: nameTokens(entry.counterpartyName ?? entry.payerName),
  };
}

interface StoredRow {
  id: string;
  booking_date: string | null;
  value_date: string | null;
  amount_minor: number;
  currency: string;
  credit_debit: string;
  entry_key: string;
  payer_name: string | null;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  acct_svcr_ref: string | null;
  message_type: string;
}

/**
 * The lines of one Bankkonto point 19 compares an import with (§H-TENANT): any date of theirs inside
 * [from, to], the OTHER formats' lines only (the same format is coverage's, statementCoverage.ts).
 */
export function readStoredLines(ctx: WorkspaceContext, bankAccountId: string, family: string, from: string, to: string): StoredLine[] {
  const formatFilter = family === 'camt' ? `AND s.message_type NOT LIKE 'camt%'` : 'AND s.message_type <> ?';
  const params: unknown[] = [ctx.workspaceId, bankAccountId, from, to, from, to];
  if (family !== 'camt') params.push(family);
  const rows = ctx.store.db
    .prepare(
      `SELECT t.id, t.booking_date, t.value_date, t.amount_minor, t.currency, t.credit_debit, t.entry_key, t.payer_name,
              d.counterparty_name, d.counterparty_iban, f.acct_svcr_ref, s.message_type
         FROM bank_txn t
         JOIN bank_statement s ON s.workspace_id = t.workspace_id AND s.id = t.statement_id
         LEFT JOIN bank_txn_detail d ON d.workspace_id = t.workspace_id AND d.bank_txn_id = t.id
         LEFT JOIN bank_txn_fact f ON f.workspace_id = t.workspace_id AND f.bank_txn_id = t.id
        WHERE t.workspace_id = ? AND t.bank_account_id = ?
          AND ((t.booking_date >= ? AND t.booking_date <= ?) OR (t.value_date >= ? AND t.value_date <= ?))
          ${formatFilter}
        ORDER BY COALESCE(t.booking_date, t.value_date), t.rowid`,
    )
    .all(...params) as StoredRow[];
  return rows.map(storedLineOf);
}

function storedLineOf(r: StoredRow, order: number): StoredLine {
  const fam = formatFamilyOf(r.message_type);
  const strong = fam === 'camt' || fam === 'mt940';
  return {
    id: r.id,
    order,
    family: fam,
    bookingDay: dayOf(r.booking_date),
    valueDay: dayOf(r.value_date),
    bookingDate: r.booking_date,
    valueDate: r.value_date,
    money: moneyOf(r.credit_debit, r.amount_minor, r.currency),
    bankRef: strong ? (realRef(r.acct_svcr_ref) ?? refOfKey(r.entry_key)) : null,
    iban: normalizedIban(r.counterparty_iban),
    names: nameTokens(r.counterparty_name ?? r.payer_name),
  };
}

/** The date window around a statement's lines the stored lines are read in, or null with no dated line. */
export function storedWindowOf(entries: readonly ParsedCamtEntry[]): { from: string; to: string } | null {
  let min: string | null = null;
  let max: string | null = null;
  for (const e of entries) {
    for (const d of [e.bookingDate, e.valueDate]) {
      if (d === null) continue;
      if (min === null || d < min) min = d;
      if (max === null || d > max) max = d;
    }
  }
  return min === null || max === null ? null : { from: shiftIso(min, -NEAR_DAYS), to: shiftIso(max, NEAR_DAYS) };
}

/** The smallest distance in days between any date of one side and any date of the other, or null. */
function distance(a: IncomingLine, b: StoredLine): number | null {
  let best: number | null = null;
  for (const x of [a.bookingDay, a.valueDay]) {
    if (x === null) continue;
    for (const y of [b.bookingDay, b.valueDay]) {
      if (y === null) continue;
      const d = Math.abs(x - y);
      if (best === null || d < best) best = d;
    }
  }
  return best;
}

export interface DecideInput {
  /** The family of the statement being imported. */
  family: string;
  /** `bank.cross_format_duplicates`. */
  mode: CrossFormatDuplicateMode;
  stored: readonly StoredLine[];
  incoming: readonly IncomingLine[];
  /** Stored lines an exact key of this file already IS: never a candidate in this import. */
  exactClaimed: ReadonlySet<string>;
}

/** Strongest first: the bank's own reference, the one-to-one movement, the same day, a near day; a bare coverage flag last. */
export const REASON_RANK: Readonly<Record<PossibleDuplicateReason, number>> = { shared_reference: 0, same_movement: 1, same_date: 2, near_date: 3, covered_period_new_line: 4 };

/**
 * For each incoming line index: absorbed (`auto_strong` only: the stored line it IS), flagged (every
 * candidate, the nearest first), or absent (a new movement). A stored line absorbs at most one line of an
 * import; naming never uses it up.
 */
export function decideLines(input: DecideInput): Map<number, LineDecision> {
  const out = new Map<number, LineDecision>();
  if (input.stored.length === 0 || input.incoming.length === 0) return out;

  const byRef = new Map<string, StoredLine[]>();
  // money -> day -> the stored lines with a date on that day, in stored order.
  const byDay = new Map<string, Map<number, StoredLine[]>>();
  const pushDay = (s: StoredLine, day: number): void => {
    let days = byDay.get(s.money);
    if (days === undefined) {
      days = new Map();
      byDay.set(s.money, days);
    }
    const list = days.get(day);
    if (list === undefined) days.set(day, [s]);
    else list.push(s);
  };
  for (const s of input.stored) {
    if (input.exactClaimed.has(s.id) || s.family === input.family) continue;
    if (s.bankRef !== null) {
      const list = byRef.get(s.bankRef);
      if (list === undefined) byRef.set(s.bankRef, [s]);
      else list.push(s);
    }
    if (s.bookingDay !== null) pushDay(s, s.bookingDay);
    if (s.valueDay !== null && s.valueDay !== s.bookingDay) pushDay(s, s.valueDay);
  }

  // `auto_strong`: proof by the bank's own reference on the same booking date. One-to-one: a stored line
  // absorbs one line of this import at most (a second line with the reference is flagged).
  if (input.mode === 'auto_strong') {
    const absorbed = new Set<string>();
    for (const line of input.incoming) {
      if (line.bankRef === null || line.bookingDay === null) continue;
      const hit = (byRef.get(line.bankRef) ?? []).find(
        (s) => !absorbed.has(s.id) && s.money === line.money && s.bookingDay !== null && Math.abs(s.bookingDay - (line.bookingDay as number)) <= ABSORB_BOOKING_DAYS,
      );
      if (hit !== undefined) {
        absorbed.add(hit.id);
        out.set(line.index, { kind: 'absorb', existingBankTxnId: hit.id });
      }
    }
  }

  // Every candidate of every other line is named; nothing is used up.
  for (const line of input.incoming) {
    if (out.has(line.index)) continue;
    const found = new Map<string, { s: StoredLine; d: number; reason: PossibleDuplicateReason }>();
    const consider = (s: StoredLine, reason: PossibleDuplicateReason | null): void => {
      if (found.has(s.id) || s.money !== line.money) return;
      const d = distance(line, s);
      if (d === null || d > NEAR_DAYS) return;
      // The bank's own reference is the strongest word there is: it names the line whatever the names say.
      if (reason !== 'shared_reference' && !counterpartyAgrees(line, s)) return;
      found.set(s.id, { s, d, reason: reason ?? (d === 0 ? 'same_date' : 'near_date') });
    };
    if (line.bankRef !== null) for (const s of byRef.get(line.bankRef) ?? []) consider(s, 'shared_reference');
    const days = byDay.get(line.money);
    if (days !== undefined) {
      const lineDays = line.valueDay !== null && line.valueDay !== line.bookingDay ? [line.bookingDay, line.valueDay] : [line.bookingDay ?? line.valueDay];
      // Nearest first: every day bucket at distance k (from either date of the line) before any at k + 1,
      // so the first lines found are the nearest, and the read stops once `MAX_CANDIDATES` are named.
      for (let k = 0; k <= NEAR_DAYS && found.size < MAX_CANDIDATES; k += 1) {
        for (const day of lineDays) {
          if (day === null) continue;
          for (const off of k === 0 ? [0] : [-k, k]) {
            const bucket = days.get(day + off);
            if (bucket === undefined) continue;
            const end = Math.min(bucket.length, BUCKET_SCAN);
            for (let i = 0; i < end && found.size < MAX_CANDIDATES; i += 1) consider(bucket[i] as StoredLine, null);
          }
        }
      }
    }
    if (found.size === 0) continue;
    const candidates = [...found.values()]
      .sort((a, b) => REASON_RANK[a.reason] - REASON_RANK[b.reason] || a.d - b.d || a.s.order - b.s.order)
      .slice(0, MAX_CANDIDATES)
      .map((c) => ({ bankTxnId: c.s.id, reason: c.reason }));
    out.set(line.index, { kind: 'flag', candidates });
  }
  return out;
}

// --- Storage: the flag, its candidates, the person's decisions (DDL in camtSchema.ts) ------------------

/**
 * Record that a new line waits for the person (once, at import, inside the import's transaction): its flag
 * (the primary reason, the first candidate or none) and every candidate beside it. §H-TENANT.
 */
export function writePossibleDuplicates(ctx: WorkspaceContext, bankTxnId: string, reason: PossibleDuplicateReason, candidates: readonly PossibleDuplicate[]): void {
  const first = candidates[0];
  const now = ctx.clock.now();
  ctx.store.db
    .prepare(
      `INSERT INTO bank_txn_possible_duplicate (bank_txn_id, workspace_id, existing_bank_txn_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(bankTxnId, ctx.workspaceId, first?.bankTxnId ?? null, reason, now);
  const insert = ctx.store.db.prepare(
    `INSERT INTO bank_txn_duplicate_candidate (bank_txn_id, workspace_id, existing_bank_txn_id, reason, rank, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  candidates.forEach((c, rank) => insert.run(bankTxnId, ctx.workspaceId, c.bankTxnId, c.reason, rank, now));
}

function asReason(r: string): PossibleDuplicateReason {
  return (POSSIBLE_DUPLICATE_REASONS as readonly string[]).includes(r) ? (r as PossibleDuplicateReason) : 'covered_period_new_line';
}

/** The flags of several lines in one query (the inbox page), keyed by line id: the reason and the first candidate. §H-TENANT. */
export function readPossibleDuplicateMap(ctx: WorkspaceContext, bankTxnIds: readonly string[]): Map<string, DuplicateFlag> {
  const out = new Map<string, DuplicateFlag>();
  for (let i = 0; i < bankTxnIds.length; i += 500) {
    const chunk = bankTxnIds.slice(i, i + 500);
    const rows = ctx.store.db
      .prepare(
        `SELECT bank_txn_id, existing_bank_txn_id, reason FROM bank_txn_possible_duplicate
          WHERE workspace_id = ? AND bank_txn_id IN (${chunk.map(() => '?').join(', ')})`,
      )
      .all(ctx.workspaceId, ...chunk) as { bank_txn_id: string; existing_bank_txn_id: string | null; reason: string }[];
    for (const r of rows) out.set(r.bank_txn_id, { bankTxnId: r.existing_bank_txn_id, reason: asReason(r.reason) });
  }
  return out;
}

/** One candidate as the inbox shows it: the stored line, why, its format, its date and its signed amount. */
export interface DuplicateCandidateView {
  bankTxnId: string;
  reason: PossibleDuplicateReason;
  /** `camt`, `mt940` or `csv`: the format the stored line came in through. */
  format: string;
  /** The stored line's booking date, else its value date. */
  date: string | null;
  /** Signed, in Rappen of `currency`: + money in, - money out. */
  amountMinor: number;
  currency: string;
}

/** Every candidate of several lines in one query, nearest first, keyed by line id. §H-TENANT. */
export function readDuplicateCandidatesMap(ctx: WorkspaceContext, bankTxnIds: readonly string[]): Map<string, DuplicateCandidateView[]> {
  const out = new Map<string, DuplicateCandidateView[]>();
  for (let i = 0; i < bankTxnIds.length; i += 500) {
    const chunk = bankTxnIds.slice(i, i + 500);
    const rows = ctx.store.db
      .prepare(
        `SELECT c.bank_txn_id, c.existing_bank_txn_id, c.reason, s.message_type, t.booking_date, t.value_date,
                t.amount_minor, t.credit_debit, t.currency
           FROM bank_txn_duplicate_candidate c
           JOIN bank_txn t ON t.workspace_id = c.workspace_id AND t.id = c.existing_bank_txn_id
           JOIN bank_statement s ON s.workspace_id = t.workspace_id AND s.id = t.statement_id
          WHERE c.workspace_id = ? AND c.bank_txn_id IN (${chunk.map(() => '?').join(', ')})
          ORDER BY c.bank_txn_id, c.rank`,
      )
      .all(ctx.workspaceId, ...chunk) as {
      bank_txn_id: string;
      existing_bank_txn_id: string;
      reason: string;
      message_type: string;
      booking_date: string | null;
      value_date: string | null;
      amount_minor: number;
      credit_debit: string;
      currency: string;
    }[];
    for (const r of rows) {
      const list = out.get(r.bank_txn_id) ?? [];
      list.push({
        bankTxnId: r.existing_bank_txn_id,
        reason: asReason(r.reason),
        format: formatFamilyOf(r.message_type),
        date: r.booking_date ?? r.value_date,
        amountMinor: r.credit_debit === 'CRDT' ? r.amount_minor : -r.amount_minor,
        currency: r.currency,
      });
      out.set(r.bank_txn_id, list);
    }
  }
  return out;
}

/** The person's latest answer on a flagged line. */
export interface DuplicateDecisionView {
  decision: DuplicateDecision;
  otherBankTxnId: string | null;
  decidedBy: string;
  decidedAt: string;
}

/** The latest decision of several lines, keyed by line id. §H-TENANT. */
export function readDuplicateDecisionMap(ctx: WorkspaceContext, bankTxnIds: readonly string[]): Map<string, DuplicateDecisionView> {
  const out = new Map<string, DuplicateDecisionView>();
  for (let i = 0; i < bankTxnIds.length; i += 500) {
    const chunk = bankTxnIds.slice(i, i + 500);
    const rows = ctx.store.db
      .prepare(
        `SELECT bank_txn_id, decision, other_bank_txn_id, decided_by, decided_at FROM bank_txn_duplicate_decision
          WHERE workspace_id = ? AND bank_txn_id IN (${chunk.map(() => '?').join(', ')})
          ORDER BY decided_at, rowid`,
      )
      .all(ctx.workspaceId, ...chunk) as { bank_txn_id: string; decision: string; other_bank_txn_id: string | null; decided_by: string; decided_at: string }[];
    for (const r of rows) {
      out.set(r.bank_txn_id, {
        decision: r.decision === 'distinct' ? 'distinct' : 'duplicate',
        otherBankTxnId: r.other_bank_txn_id,
        decidedBy: r.decided_by,
        decidedAt: r.decided_at,
      });
    }
  }
  return out;
}

/**
 * SQL, true when the line `t` NEEDS the person's duplicate decision: it is flagged and its latest answer is
 * not "Kein Duplikat" (`distinct`). A "Duplikat" answer ignores the line; reopened, it needs a decision
 * again. Combine with the line being open. Tenant-bound through the line.
 */
export function DUPLICATE_PENDING_SQL(t: string): string {
  return `(EXISTS (SELECT 1 FROM bank_txn_possible_duplicate pd WHERE pd.workspace_id = ${t}.workspace_id AND pd.bank_txn_id = ${t}.id)
    AND COALESCE((SELECT dd.decision FROM bank_txn_duplicate_decision dd
                   WHERE dd.workspace_id = ${t}.workspace_id AND dd.bank_txn_id = ${t}.id
                   ORDER BY dd.decided_at DESC, dd.rowid DESC LIMIT 1), '') <> 'distinct')`;
}

/** The lines of the workspace that are flagged and not decided `distinct` (the proposal ladder caps them). §H-TENANT. */
export function duplicatePendingIds(ctx: WorkspaceContext): Set<string> {
  // From the flags, not the lines: a workspace of a hundred thousand lines has a handful of flags.
  const rows = ctx.store.db
    .prepare(
      `SELECT pd.bank_txn_id AS id FROM bank_txn_possible_duplicate pd
        WHERE pd.workspace_id = ?
          AND COALESCE((SELECT dd.decision FROM bank_txn_duplicate_decision dd
                         WHERE dd.workspace_id = pd.workspace_id AND dd.bank_txn_id = pd.bank_txn_id
                         ORDER BY dd.decided_at DESC, dd.rowid DESC LIMIT 1), '') <> 'distinct'`,
    )
    .all(ctx.workspaceId) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/**
 * The booking's guard (critic R2-1): a flagged line without "Kein Duplikat" is not booked, by any path.
 * Null when the line may be booked. The refusal names the candidates and the way out. §H-TENANT.
 */
export function duplicateDecisionPending(ctx: WorkspaceContext, bankTxnId: string): Err | null {
  const pending = ctx.store.db
    .prepare(`SELECT 1 AS p FROM bank_txn t WHERE t.workspace_id = ? AND t.id = ? AND ${DUPLICATE_PENDING_SQL('t')}`)
    .get(ctx.workspaceId, bankTxnId) as { p: number } | undefined;
  if (pending === undefined) return null;
  const candidates = readDuplicateCandidatesMap(ctx, [bankTxnId]).get(bankTxnId) ?? [];
  const named = candidates
    .slice(0, 3)
    .map((c) => `a ${c.format === 'camt' ? 'camt' : c.format === 'mt940' ? 'MT940' : 'CSV'} line of ${c.date ?? 'no date'}`)
    .join(', ');
  const what =
    named !== ''
      ? `this line may be the same movement as ${named}`
      : 'this line arrived for days the books already hold a statement for, and no line there matches it';
  return err('duplicate_decision_pending', {
    bankTxnId,
    possibleDuplicates: candidates.map((c) => c.bankTxnId),
    reason: `${what}: decide first (resolve_possible_duplicate: duplicate ignores it, distinct keeps it as its own line), then book it`,
  });
}

