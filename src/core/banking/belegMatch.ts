/**
 * A41.1 (D184), THE BELEG-ABGLEICH: which captured receipt pays which bank line.
 *
 * A SUGGESTION, NEVER A LINK. This module reads; it writes nothing. A receipt is linked only when a person or
 * a booking attaches it through the existing doors: `book_bank_line attach:[{fileId}]` for an open line,
 * `files_link { entityKind: 'bank_txn' }` for a booked "Ohne Beleg" line (or an open one: the capture stays
 * pending until the line is booked). The A41.3 autobook receipt gate is re-cut pending (3 critic FAILs).
 *
 * WHY A FIELD ON THE LINE AND NOT A PROPOSAL REASON. `BANK_PROPOSAL_REASONS` name the booking TARGET, and the
 * certainty they carry drives `attentionOf`, "Alle sicheren buchen" and N04's `proposalVerdict`. A receipt
 * names no account. As a rung it would outrank a rule or move a reference-proven `sure`; and a booked line
 * that lacks its receipt has no proposal at all. So the candidates ride on the inbox line (`belegCandidates`)
 * beside `receiptCount`, and on a capture (`bankLineCandidates`), the same matcher read both ways.
 *
 * THE POOL. A capture under review (`needs_review`) whose document is the head of its chain, not pending
 * delete, not filed on a booking record, with a live `amount` `{ minor, currency }`, and whose bytes have no
 * live receipt holder (R1, `receiptHolders`, an ACTIVE assignment included): a receipt that already evidences a booking is never offered,
 * whatever `files.duplicate_beleg` says (a suggestion is not a person's confirmation). A capture is purchase
 * evidence (A31 commits to a vendor bill or an expense line), so it pairs with DEBIT lines only.
 *
 * THE MATCH, all three must hold:
 *  - AMOUNT. The receipt's currency is the line's: exact. A foreign receipt: exact against the statement's
 *    own transaction or instructed amount in that currency when the camt carries it (D178 E3, `facts`); else,
 *    on a line in the base currency, the receipt converted at the stored §H-FX rate of its date within
 *    `belege.match_fx_tolerance_pct` of the line; no rate, no match.
 *  - DATE. The nearer of the receipt's `invoice_date` and `due_date` (else the capture's own day) within
 *    `belege.match_date_window_days` of the line's booking date.
 *  - COUNTERPARTY. The receipt's IBAN is the line's, or a word of the receipt's vendor name (three letters or
 *    more, legal forms dropped, folded both ways a Swiss bank text may spell an umlaut) is in the line's
 *    counterparty name or remittance text. D188: a card line compares its MERCHANT only, and a long vendor word
 *    may match the start of a longer word of the counterparty or merchant (`name_prefix`, see
 *    `counterpartyMatch`), which the engine pairs unattended only under `belege.match_vendor_prefix` = `engine`.
 *
 * GROUPS. Candidates from one vendor with the same amount and currency, dated within the window of each other,
 * are ONE group: an invoice and its receipt evidence one payment. A group carries its files.
 *
 * Pure reads, §H-TENANT on every query.
 */

import type { WorkspaceContext } from '../context.js';
import { getSetting } from '../settings/settings.js';
import { IS_HEAD } from '../files/head.js';
import { RECEIPT_BOOKING_KINDS, receiptHolders } from '../files/receiptGuard.js';
import { baseCurrencyOf, resolveFxRate } from '../fx/rates.js';
import { RATE_ONE } from '../fx/rateMath.js';
import { normalizeIban } from '../setup/iban.js';
import { foldText, lineCounterpartyOf, normalisedName, textTokens } from './bankProposals.js';
import { lineBookingDate, LINE_STATE_EXPR, LINE_STATE_JOINS } from './bankLines.js';
import type { BankTxnDetailRow, BankTxnRow } from './bankLines.js';
import type { BankLineFacts } from './statementFacts.js';
import { readLineFactsMap } from './statementFacts.js';
import { calendarDay, engineFieldsOf, parseFieldRows, receiptFigures } from './belegFigures.js';

// --- Views ---------------------------------------------------------------------------------------------

/** One captured receipt as a candidate shows it. */
export interface BelegCandidateFile {
  fileId: string;
  captureId: string;
  filename: string;
  vendorName: string | null;
  invoiceDate: string | null;
  amountMinor: number;
  currency: string;
  /** A41.4: the VAT amount the receipt prints (`vat_amount`), in its currency, else null. */
  vatAmountMinor: number | null;
}

/** How a group matched the line (closed vocabularies, §H-ENUM). */
export const BELEG_AMOUNT_MATCHES = ['exact', 'transaction_currency', 'fx_tolerance'] as const;
export type BelegAmountMatch = (typeof BELEG_AMOUNT_MATCHES)[number];
// D188 (A39 §21): `name_prefix`, a vendor word the bank text spells joined to more ("MongoDB" in
// "MONGODBCLOUD"), read only against the line's counterparty or card merchant, never its whole text.
export const BELEG_COUNTERPARTY_MATCHES = ['iban', 'name', 'name_prefix'] as const;
export type BelegCounterpartyMatch = (typeof BELEG_COUNTERPARTY_MATCHES)[number];

/** A41.4: the receipt's VAT beside the VAT the engine computes for the booking. */
export interface VatComparison {
  belegMinor: number;
  computedMinor: number;
  /** belegMinor - computedMinor. */
  deltaMinor: number;
  toleranceMinor: number;
  withinTolerance: boolean;
  /** D188: the currency of `belegMinor` when it is not the line's (absent: the line's currency). */
  currency?: string;
  /** D188: the booking taxes no leg; `computedMinor` is 0 and the comparison is a note, never `check`. */
  untaxed?: true;
  /** D188: the receipt's VAT is in another currency than the line's: shown, never compared. */
  notCompared?: true;
}

/** One candidate group for one line: one or more receipts of one vendor, one amount. */
export interface BelegCandidateGroup {
  /** The group's files' ids, sorted, joined by `+`: stable across reads. */
  groupKey: string;
  files: BelegCandidateFile[];
  amountMinor: number;
  currency: string;
  vendorName: string | null;
  /** The group's earliest receipt date. */
  date: string;
  match: { amount: BelegAmountMatch; days: number; counterparty: BelegCounterpartyMatch };
  /** A41.4: filled by `belegEvidence.ts` when the receipt states a VAT amount and the booking taxes a leg. */
  vat: VatComparison | null;
}

/** One bank line a captured receipt fits, as the capture side shows it. */
export interface BankLineCandidate {
  bankTxnId: string;
  state: 'open' | 'booked';
  bookingDate: string;
  /** Signed, like the inbox: a debit is negative. */
  amountMinor: number;
  currency: string;
  counterparty: string | null;
  /** The line's group for this capture (it may hold the capture's twin too). */
  groupKey: string;
  /** D188: how the sender matched (`name_prefix` pairs unattended only under `belege.match_vendor_prefix` = `engine`). */
  counterpartyMatch: BelegCounterpartyMatch;
}

// --- Read rights (security review, 07.11.2026) -------------------------------------------------------

/**
 * The two halves of a pairing are two read domains: a captured receipt is the filing register
 * (`list_captures`, `files_search`: `read_master_data`), a bank line is the bank inbox (`list_bank_inbox`:
 * `read_sales`). A read that answers one half beside the other answers the second half ONLY to a seat that
 * holds its right too, asserted here in the engine (never only in the API layer): otherwise the list is
 * empty. The autobook step does not go through these reads: it books as the granter through
 * `book_bank_line`, whose attach seam asks its own rights.
 */
export const BELEG_READ_CAPABILITY = 'read_master_data';
export const BANK_LINE_READ_CAPABILITY = 'read_sales';

/** Does the seat hold `capability` (a read, so no refusal is returned)? */
export function holdsRead(ctx: WorkspaceContext, capability: string): boolean {
  return ctx.capabilities.assert(capability).ok;
}

// --- Settings ------------------------------------------------------------------------------------------

/** Is the Beleg-Abgleich on (`belege.match_mode` = `suggest`)? */
export function belegMatchOn(ctx: WorkspaceContext): boolean {
  return getSetting<string>(ctx, 'belege.match_mode') !== 'off';
}

interface MatchConfig {
  windowDays: number;
  fxTolerancePct: number;
  /** D188: whether a vendor word may match by prefix (`name_prefix`), and whether the engine may pair on it. */
  vendorPrefix: VendorPrefixMode;
}

function matchConfig(ctx: WorkspaceContext): MatchConfig {
  return {
    windowDays: getSetting<number>(ctx, 'belege.match_date_window_days'),
    fxTolerancePct: getSetting<number>(ctx, 'belege.match_fx_tolerance_pct'),
    vendorPrefix: vendorPrefixModeOf(ctx),
  };
}

/** D188: `belege.match_vendor_prefix` (`suggest` by default; an unknown stored value reads as it). */
export type VendorPrefixMode = 'suggest' | 'engine' | 'off';
export function vendorPrefixModeOf(ctx: WorkspaceContext): VendorPrefixMode {
  const v = getSetting<string>(ctx, 'belege.match_vendor_prefix');
  return v === 'engine' || v === 'off' ? v : 'suggest';
}

// --- The pool ------------------------------------------------------------------------------------------

/** One receipt of the pool, with what the match needs, read once per request. */
export interface PoolBeleg {
  file: BelegCandidateFile;
  sha256: string;
  iban: string | null;
  /** Folded vendor words (both umlaut spellings), three letters or more. */
  vendorWords: Set<string>;
  vendorKey: string | null;
  /** The dates the line date is measured against (invoice, due, else the capture's day). */
  dates: string[];
  /**
   * Critic A41.3 r2 F3: does the receipt state a date of its own (a real invoice or due date)? An undated one (a
   * QR bill states none) is measured from the capture's intake day, which is no evidence of the period it pays.
   */
  dated: boolean;
  /** The receipt's payment reference (QRR or SCOR, spaces dropped), or null. */
  reference: string | null;
}

interface PoolRow {
  capture_id: string;
  document_id: string;
  sha256: string;
  created_at: string;
  filename: string;
}

/** A capture's live fields, parsed. Shared by the pool and the evidence (`belegEvidence.ts`). */
export function fieldsOf(ctx: WorkspaceContext, captureId: string): Map<string, unknown> {
  const rows = ctx.store.db
    .prepare('SELECT key, value FROM capture_fields WHERE workspace_id = ? AND capture_id = ? AND superseded = 0')
    .all(ctx.workspaceId, captureId) as { key: string; value: string }[];
  return parseFieldRows(rows);
}

/**
 * THE ONE READING of a receipt's figures (critic A41 r1 E1: the pool and the evidence must agree), kept in the
 * leaf `belegFigures.ts` so the A41.3 assignment and the store's one-time migration read it the same way.
 */
export { receiptFigures };


/** The words a name or a text is compared in: every token, folded both ways an umlaut may arrive. */
function wordsOf(text: string | null | undefined, minLength: number): Set<string> {
  const out = new Set<string>();
  if (text === null || text === undefined) return out;
  for (const t of textTokens(text)) if (t.length >= minLength) out.add(t);
  for (const t of foldText(text).split(/[^a-z0-9]+/)) if (t.length >= minLength) out.add(t);
  return out;
}

/** Legal forms and fillers of three letters or more: never a vendor's own word. */
const NOT_A_VENDOR_WORD = new Set(['gmbh', 'sarl', 'sagl', 'ltd', 'inc', 'the', 'und', 'llc', 'corp', 'limited', 'company', 'incorporated', 'corporation']);

/**
 * D188: words too common to identify a vendor by their START. A prefix match on one ("swiss" in "SWISSCOM",
 * "service" in "SERVICEPLUS") would pair a receipt with another business, so these match only whole.
 */
const NO_PREFIX_WORDS = new Set([
  'swiss', 'schweiz', 'suisse', 'svizzera', 'international', 'services', 'service', 'group', 'gruppe', 'holding',
  'online', 'digital', 'solutions', 'systems', 'global', 'technologies', 'technology', 'software', 'cloud', 'store',
  'shop', 'market', 'markt', 'trading', 'consulting', 'management', 'partners', 'media', 'network', 'networks',
  'europe', 'payments', 'payment', 'finance', 'bank', 'america', 'north', 'south', 'east', 'west', 'general',
  'store', 'stores', 'travel', 'hotel', 'hotels', 'restaurant', 'apotheke', 'pharmacy',
]);

/** D188: the shortest vendor word (or joined vendor name) that may match the start of a longer word. */
export const VENDOR_PREFIX_MIN = 5;

/** The vendor's words: the name's tokens, three letters or more, legal forms dropped. */
function vendorWordsOf(name: string | null): Set<string> {
  const out = new Set<string>();
  for (const w of wordsOf(name, 3)) if (!NOT_A_VENDOR_WORD.has(w)) out.add(w);
  return out;
}

/** The receipts a line may be paired with (see the module note). One read per request. */
export function belegPool(ctx: WorkspaceContext, opts: { forEnginePass?: boolean } = {}): PoolBeleg[] {
  const marks = RECEIPT_BOOKING_KINDS.map(() => '?').join(', ');
  const rows = ctx.store.db
    .prepare(
      `SELECT c.id AS capture_id, c.document_id, c.sha256, c.created_at, f.filename
         FROM captures c
         JOIN stored_file f ON f.workspace_id = c.workspace_id AND f.id = c.document_id
        WHERE c.workspace_id = ? AND c.status = 'needs_review' AND f.pending_delete = 0 AND ${IS_HEAD('f')}
          AND (f.entity_kind IS NULL OR f.entity_kind NOT IN (${marks})
            -- Critic A41 r1 P4: a receipt filed on a line that was then IGNORED is free again.
            OR (f.entity_kind = 'bank_txn' AND EXISTS (
              SELECT 1 FROM bank_line_decision ign WHERE ign.workspace_id = f.workspace_id AND ign.bank_txn_id = f.entity_id
                 AND ign.superseded_at IS NULL AND ign.state = 'ignored')))
        ORDER BY c.created_at, c.rowid`,
    )
    .all(ctx.workspaceId, ...RECEIPT_BOOKING_KINDS) as PoolRow[];
  const base = baseCurrencyOf(ctx);
  const out: PoolBeleg[] = [];
  for (const r of rows) {
    // R1: a receipt that already evidences a live booking (or waits for another Vorschlag) is never offered.
    // A41.3 v3: ONE holder read. An active assignment holds its receipt against every other line (the inbox
    // candidates, list_captures, the engine pass); only the engine pass keeps a capture's OWN engine row in the
    // pool, because it re-validates that row.
    const own = opts.forEnginePass === true ? { keepEngineCaptureId: r.capture_id } : {};
    if (receiptHolders(ctx, r.sha256, { target: { kind: 'capture', id: r.capture_id }, exceptFileIds: [r.document_id], ...own }).length > 0) continue;
    const beleg = poolBelegOf(ctx, r, base);
    if (beleg !== null) out.push(beleg);
  }
  return out;
}

/** One capture read as the matcher reads it (the pool and the filed receipts of a line share it). */
function poolBelegOf(ctx: WorkspaceContext, r: PoolRow, base: string): PoolBeleg | null {
  // Critic A41.3 r1 S1/S2: the matcher reads a capture ONLY through the engine's field set, the very set a
  // person's confirmation (or the QR read) must cover for the engine to pair it.
  const fields = engineFieldsOf(fieldsOf(ctx, r.capture_id)) as ReadonlyMap<string, unknown>;
  const figures = receiptFigures(fields, base);
  if (figures === null) return null;
  const vendor = typeof fields.get('vendor_name') === 'string' ? (fields.get('vendor_name') as string) : null;
  const ibanRaw = typeof fields.get('iban') === 'string' ? (fields.get('iban') as string) : null;
  const iban = ibanRaw !== null && ibanRaw.trim() !== '' ? normalizeIban(ibanRaw) : null;
  const uid = typeof fields.get('vendor_uid') === 'string' ? (fields.get('vendor_uid') as string) : null;
  // Critic A41.3 r2 P1: the one date parser; a value that is no calendar day is no date.
  const invoiceDate = calendarDay(fields.get('invoice_date'));
  const dueDate = calendarDay(fields.get('due_date'));
  const dates = [invoiceDate, dueDate].filter((d): d is string => d !== null);
  const name = normalisedName(vendor);
  const reference = typeof fields.get('reference') === 'string' ? (fields.get('reference') as string).replace(/\s+/g, '') : '';
  return {
    dated: dates.length > 0,
    reference: reference === '' ? null : reference,
    file: {
      fileId: r.document_id,
      captureId: r.capture_id,
      filename: r.filename,
      vendorName: vendor,
      invoiceDate,
      amountMinor: figures.amountMinor,
      currency: figures.currency,
      vatAmountMinor: figures.vatMinor,
    },
    sha256: r.sha256,
    iban,
    vendorWords: vendorWordsOf(vendor),
    vendorKey: name !== null ? `name:${name}` : iban !== null ? `iban:${iban}` : uid !== null ? `uid:${uid.replace(/\D/g, '')}` : null,
    dates: dates.length > 0 ? dates : [r.created_at.slice(0, 10)],
  };
}

// --- The match -----------------------------------------------------------------------------------------

function dayDistance(a: string, b: string): number {
  return Math.abs(Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000));
}

/** The line in the shape the matcher reads it. */
export interface MatchLine {
  row: BankTxnRow;
  detail: BankTxnDetailRow | undefined;
  facts: BankLineFacts | null;
}

/**
 * Does the receipt's amount fit the line (A41.1 amount rule), and how? `fx` memoises rate lookups per
 * request. Exported for A41.2, which judges an ATTACHED receipt by the same rule.
 */
export function amountMatch(
  ctx: WorkspaceContext,
  cfg: { fxTolerancePct: number },
  line: Pick<MatchLine, 'row' | 'facts'>,
  receipt: { amountMinor: number; currency: string; date: string },
  fx: Map<string, bigint | null> = new Map(),
): BelegAmountMatch | null {
  const lineAbs = Math.abs(line.row.amount_minor);
  if (receipt.currency === line.row.currency) return receipt.amountMinor === lineAbs ? 'exact' : null;
  // D178 E3: the statement states the movement in the receipt's currency.
  for (const f of [line.facts?.transactionAmount ?? null, line.facts?.instructed ?? null]) {
    if (f !== null && f.currency === receipt.currency) return Math.abs(f.amountMinor) === receipt.amountMinor ? 'transaction_currency' : null;
  }
  const key = `${receipt.currency}|${receipt.date}`;
  if (!fx.has(key)) {
    const r = resolveFxRate(ctx, { currency: receipt.currency, date: receipt.date });
    fx.set(key, r.ok && r.resolved.baseCurrency === line.row.currency ? r.resolved.rateScaled : null);
  }
  const rate = fx.get(key) ?? null;
  if (rate === null) return null;
  const converted = (BigInt(receipt.amountMinor) * rate) / RATE_ONE;
  const delta = converted - BigInt(lineAbs);
  const abs = delta < 0n ? -delta : delta;
  return abs * 100n <= BigInt(lineAbs) * BigInt(cfg.fxTolerancePct) ? 'fx_tolerance' : null;
}

/**
 * The sender rule (A41.1), widened by D188 for the lines whose counterparty TILL read from the text:
 *  - the receipt's IBAN is the line's: `iban`;
 *  - a vendor word is a whole word of what the line names: `name`. For a CARD line (its merchant read from the
 *    text, `lineCounterpartyOf`) that is the MERCHANT only, never the card prefix around it, so a receipt of
 *    "Visa" or of the card's bank never fits every card line; any other line keeps its name and remittance;
 *  - `name_prefix` (unless `belege.match_vendor_prefix` is `off`): a vendor word of at least `VENDOR_PREFIX_MIN`
 *    letters that is not a common word (`NO_PREFIX_WORDS`), or the vendor's words joined, is the START of a
 *    longer word of the line's counterparty or merchant (never of its remittance): "MongoDB Limited" and
 *    "MONGODBCLOUD", "Mongo DB" and "MONGODB". Amount and date must hold besides, as for every match.
 */
/** What the sender rule reads of a line: its words, computed ONCE per line (not once per receipt of the pool). */
interface LineSender {
  iban: string | null;
  /** The counterparty name, or (a card line) the merchant TILL read from its text. */
  named: string;
  /** The whole words compared: the merchant alone on a card line, else the name and the remittance. */
  words: Set<string>;
  /** The words a vendor word may be the START of (`name_prefix`): the name or merchant only. */
  own: string[];
  namedWords: Set<string>;
}

function lineSenderOf(ctx: WorkspaceContext, line: MatchLine): LineSender {
  const lineIban = line.detail?.counterparty_iban ?? null;
  const cp = lineCounterpartyOf(ctx, line.row, line.detail);
  const card = cp?.derived?.kind === 'card';
  const named = card ? (cp?.label ?? '') : (line.detail?.counterparty_name ?? line.row.payer_name ?? '');
  return {
    iban: lineIban !== null && lineIban.trim() !== '' ? normalizeIban(lineIban) : null,
    named,
    words: card ? wordsOf(named, 3) : wordsOf(`${named} ${line.detail?.remittance_text ?? ''}`, 3),
    own: [...wordsOf(named, VENDOR_PREFIX_MIN + 1)],
    namedWords: wordsOf(named, 3),
  };
}

function counterpartyMatch(cfg: MatchConfig, sender: LineSender, beleg: PoolBeleg): BelegCounterpartyMatch | null {
  if (beleg.iban !== null && sender.iban !== null && sender.iban === beleg.iban) return 'iban';
  if (beleg.vendorWords.size === 0) return null;
  for (const w of beleg.vendorWords) if (sender.words.has(w)) return 'name';
  if (cfg.vendorPrefix === 'off') return null;
  const own = sender.own;
  const joined = [...beleg.vendorWords].join('');
  const stems = [...beleg.vendorWords].filter((w) => w.length >= VENDOR_PREFIX_MIN && !NO_PREFIX_WORDS.has(w));
  if (beleg.vendorWords.size > 1 && joined.length >= VENDOR_PREFIX_MIN) stems.push(joined);
  for (const stem of stems) for (const t of own) if (t.length > stem.length && t.startsWith(stem)) return 'name_prefix';
  if (joined.length >= VENDOR_PREFIX_MIN && beleg.vendorWords.size > 1 && sender.namedWords.has(joined)) return 'name_prefix';
  return null;
}

interface Hit {
  beleg: PoolBeleg;
  amount: BelegAmountMatch;
  days: number;
  counterparty: BelegCounterpartyMatch;
}

/** Group the hits of ONE line: one vendor, one amount and currency, dated within the window of each other. */
function groupHits(hits: readonly Hit[], windowDays: number): BelegCandidateGroup[] {
  const byKey = new Map<string, Hit[]>();
  for (const h of hits) {
    const k = `${h.beleg.vendorKey ?? `file:${h.beleg.file.fileId}`}|${h.beleg.file.currency}|${h.beleg.file.amountMinor}`;
    const list = byKey.get(k) ?? [];
    list.push(h);
    byKey.set(k, list);
  }
  const groups: BelegCandidateGroup[] = [];
  for (const list of byKey.values()) {
    const sorted = [...list].sort((a, b) => (a.beleg.dates[0]! < b.beleg.dates[0]! ? -1 : a.beleg.dates[0]! > b.beleg.dates[0]! ? 1 : 0));
    let current: Hit[] = [];
    const flush = (): void => {
      if (current.length === 0) return;
      const files = current.map((h) => h.beleg.file).sort((a, b) => (a.fileId < b.fileId ? -1 : 1));
      const first = current[0]!;
      groups.push({
        groupKey: files.map((f) => f.fileId).join('+'),
        files,
        amountMinor: first.beleg.file.amountMinor,
        currency: first.beleg.file.currency,
        vendorName: first.beleg.file.vendorName,
        date: first.beleg.dates[0]!,
        match: {
          amount: current.some((h) => h.amount === 'exact') ? 'exact' : current.some((h) => h.amount === 'transaction_currency') ? 'transaction_currency' : 'fx_tolerance',
          days: Math.min(...current.map((h) => h.days)),
          counterparty: current.some((h) => h.counterparty === 'iban') ? 'iban' : current.some((h) => h.counterparty === 'name') ? 'name' : 'name_prefix',
        },
        vat: null,
      });
      current = [];
    };
    for (const h of sorted) {
      if (current.length > 0 && dayDistance(current[0]!.beleg.dates[0]!, h.beleg.dates[0]!) > windowDays) flush();
      current.push(h);
    }
    flush();
  }
  // Nearest first, then the oldest receipt: one stable order.
  return groups.sort((a, b) => a.match.days - b.match.days || (a.date < b.date ? -1 : a.date > b.date ? 1 : a.groupKey < b.groupKey ? -1 : 1));
}

/** A request's shared state: the pool, the settings and the rate memo, read once. */
export interface BelegMatchContext {
  pool: PoolBeleg[];
  cfg: MatchConfig;
  fx: Map<string, bigint | null>;
}

/** The request context, or null when the Beleg-Abgleich is off. */
export function belegMatchContext(ctx: WorkspaceContext, opts: { forEnginePass?: boolean } = {}): BelegMatchContext | null {
  if (!belegMatchOn(ctx)) return null;
  return { pool: belegPool(ctx, opts), cfg: matchConfig(ctx), fx: new Map() };
}

/** The candidate groups of ONE debit line (an empty list for a credit, or when nothing fits). */
export function belegCandidatesForLine(ctx: WorkspaceContext, mc: BelegMatchContext, line: MatchLine): BelegCandidateGroup[] {
  if (line.row.credit_debit !== 'DBIT' || mc.pool.length === 0) return [];
  const lineDate = lineBookingDate(line.row);
  const sender = lineSenderOf(ctx, line);
  const hits: Hit[] = [];
  for (const beleg of mc.pool) {
    const days = Math.min(...beleg.dates.map((d) => dayDistance(d, lineDate)));
    if (days > mc.cfg.windowDays) continue;
    const counterparty = counterpartyMatch(mc.cfg, sender, beleg);
    if (counterparty === null) continue;
    const amount = amountMatch(ctx, mc.cfg, line, { amountMinor: beleg.file.amountMinor, currency: beleg.file.currency, date: beleg.dates[0]! }, mc.fx);
    if (amount === null) continue;
    hits.push({ beleg, amount, days, counterparty });
  }
  return groupHits(hits, mc.cfg.windowDays);
}


// --- The capture side ----------------------------------------------------------------------------------

/**
 * SQL, true when the booked line `t` is booked to accounts and holds no receipt (on the line or on its entry)
 * and its statement is not its voucher: the "Ohne Beleg" facet's own definition (`needsReceipt`), for a
 * line with active decision `d`. Tenant-bound through `t.workspace_id`.
 */
export function OHNE_BELEG_SQL(t: string, d: string, coversSql: string): string {
  return `(${d}.state = 'booked' AND ${d}.target_kind = 'accounts'
      AND NOT ${coversSql}
      AND NOT EXISTS (
        SELECT 1 FROM stored_file rf
         WHERE rf.workspace_id = ${t}.workspace_id AND ${IS_HEAD('rf')}
           AND ((rf.entity_kind = 'bank_txn' AND rf.entity_id = ${t}.id)
             OR (${d}.entry_id IS NOT NULL AND rf.entity_kind = 'journal_entry' AND rf.entity_id = ${d}.entry_id))))`;
}

/**
 * For each capture of the pool: the open or "Ohne Beleg" debit lines it fits, nearest first. One read of the
 * lines inside the pool's date range, then the same matcher per line. `coversSql(entryExpr, bankExpr, wsExpr)`
 * is the inbox's `STATEMENT_COVERS_SQL`, passed in so this module does not import the inbox.
 */
export function bankLineCandidatesForCaptures(
  ctx: WorkspaceContext,
  coversSql: (entryExpr: string, bankAccountExpr: string, wsExpr: string) => string,
): Map<string, BankLineCandidate[]> {
  // Security review: bank lines only for a seat that may read the bank inbox.
  if (!holdsRead(ctx, BANK_LINE_READ_CAPABILITY)) return new Map();
  return bankLineCandidatesForPool(ctx, belegMatchContext(ctx), coversSql);
}

/**
 * The capture side over a GIVEN pool, ungated: the inner read of `bankLineCandidatesForCaptures`.
 * Engine-internal; a caller that answers a seat goes through the gated wrapper.
 */
/** The debit lines between two days that hold no receipt: open, or booked "Ohne Beleg". Tenant-bound. */
function receiptlessDebitLines(
  ctx: WorkspaceContext,
  from: string,
  to: string,
  coversSql: (entryExpr: string, bankAccountExpr: string, wsExpr: string) => string,
): (BankTxnRow & BankTxnDetailRow & { line_state: string })[] {
  return ctx.store.db
    .prepare(
      `SELECT t.*, ${LINE_STATE_EXPR('t')} AS line_state, d2.counterparty_name, d2.counterparty_iban, d2.remittance_text, d2.end_to_end_id
         FROM bank_txn t ${LINE_STATE_JOINS('t')}
         LEFT JOIN bank_txn_detail d2 ON d2.workspace_id = t.workspace_id AND d2.bank_txn_id = t.id
         LEFT JOIN bank_line_decision ad ON ad.workspace_id = t.workspace_id AND ad.bank_txn_id = t.id AND ad.superseded_at IS NULL
        WHERE t.workspace_id = ? AND t.credit_debit = 'DBIT'
          AND COALESCE(t.booking_date, t.value_date, substr(t.created_at, 1, 10)) BETWEEN ? AND ?
          AND (${LINE_STATE_EXPR('t')} = 'open'
            OR (ad.link_id IS NOT NULL AND ${OHNE_BELEG_SQL('t', 'ad', coversSql('ad.entry_id', 't.bank_account_id', 't.workspace_id'))}))
        ORDER BY COALESCE(t.booking_date, t.value_date, t.created_at), t.rowid`,
    )
    .all(ctx.workspaceId, from, to) as (BankTxnRow & BankTxnDetailRow & { line_state: string })[];
}

/**
 * Critic A41.3 r2 F3: an UNDATED receipt (no invoice or due date of its own; a QR bill states none) proves no
 * period, so its date window is no evidence. Every receipt-less debit line of the same sender and amount
 * between `from` and `to` (the lookback), open or booked "Ohne Beleg", by the same sender and amount rules,
 * WITHOUT the date window. The engine pairs it unattended only when this is exactly one line.
 */
export function undatedClaimantLines(
  ctx: WorkspaceContext,
  mc: BelegMatchContext,
  beleg: PoolBeleg,
  from: string,
  to: string,
  coversSql: (entryExpr: string, bankAccountExpr: string, wsExpr: string) => string,
): string[] {
  const rows = receiptlessDebitLines(ctx, from, to, coversSql);
  const facts = readLineFactsMap(ctx, rows.map((r) => r.id));
  const out: string[] = [];
  for (const r of rows) {
    const detail: BankTxnDetailRow = { counterparty_name: r.counterparty_name, counterparty_iban: r.counterparty_iban, remittance_text: r.remittance_text, end_to_end_id: r.end_to_end_id };
    const line = { row: r, detail, facts: facts.get(r.id) ?? null };
    if (counterpartyMatch(mc.cfg, lineSenderOf(ctx, line), beleg) === null) continue;
    if (amountMatch(ctx, mc.cfg, line, { amountMinor: beleg.file.amountMinor, currency: beleg.file.currency, date: lineBookingDate(r) }, mc.fx) === null) continue;
    out.push(r.id);
  }
  return out;
}

export function bankLineCandidatesForPool(
  ctx: WorkspaceContext,
  mc: BelegMatchContext | null,
  coversSql: (entryExpr: string, bankAccountExpr: string, wsExpr: string) => string,
): Map<string, BankLineCandidate[]> {
  const out = new Map<string, BankLineCandidate[]>();
  if (mc === null || mc.pool.length === 0) return out;
  const all = mc.pool.flatMap((b) => b.dates);
  const shift = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const from = shift([...all].sort()[0]!, -mc.cfg.windowDays);
  const to = shift([...all].sort().at(-1)!, mc.cfg.windowDays);
  const rows = receiptlessDebitLines(ctx, from, to, coversSql);
  const facts = readLineFactsMap(ctx, rows.map((r) => r.id));
  for (const r of rows) {
    const detail: BankTxnDetailRow = {
      counterparty_name: r.counterparty_name,
      counterparty_iban: r.counterparty_iban,
      remittance_text: r.remittance_text,
      end_to_end_id: r.end_to_end_id,
    };
    for (const g of belegCandidatesForLine(ctx, mc, { row: r, detail, facts: facts.get(r.id) ?? null })) {
      for (const f of g.files) {
        const list = out.get(f.captureId) ?? [];
        list.push({
          bankTxnId: r.id,
          state: r.line_state === 'open' ? 'open' : 'booked',
          bookingDate: lineBookingDate(r),
          amountMinor: -r.amount_minor,
          currency: r.currency,
          counterparty: r.counterparty_name ?? r.payer_name ?? lineCounterpartyOf(ctx, r, detail)?.label ?? null,
          groupKey: g.groupKey,
          counterpartyMatch: g.match.counterparty,
        });
        out.set(f.captureId, list);
      }
    }
  }
  return out;
}
