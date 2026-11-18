/**
 * A42, `settlement_review`: the Umsatz review. One period of a settlement source, each event with who paid,
 * what the import will do with it, the person's answer (include or ignore), the totals the books will carry
 * and two checks, before anything is booked.
 *
 * THE REVIEW IS THE IMPORT, ROLLED BACK (paper critic r1 H3, the D177 dry run `bankBooking.ts`). The document
 * (a file the person loaded, or the feed's answer fetched now through the pull's own fetch, nothing booked) is
 * handed to the REAL `import_settlement` inside a transaction that is always rolled back
 * (`discardingChanges`). So every row's status, every total and both checks read what the import actually
 * did: the test flags it records, the comparison, the stored lookup, the override and the ignore, the
 * from-date, the template, the posting's own refusals (a locked period, the VAT gate) and the entries it
 * posts, read line by line before the rollback. No second decision exists to drift from the import's.
 *
 * WHAT THE PERSON BOOKS IS WHAT THEY SAW (code critic r1 H1/H2, a chokepoint, not an enumeration). The answer
 * names `reviewSha256`, which the IMPORT computes from what it does (`outcomeDigestOf`: every event's outcome,
 * figures and booked lines). A file is booked with `import_settlement` and the part of it dated in the period
 * (`periodPartOf`, the same part the review read); the feed with `pull_settlement` over the same range. Both pass
 * `expectReviewSha256`, and the import refuses `review_stale`, rolling everything back, when it would now do
 * anything else, whatever moved (the document, an answer, a setting, the template, the from-date, a lock).
 *
 * ROWS: every event of the reviewed document (every event the import would book is shown), placed where its
 * VAT lands: the date of its entry when booked before, else its own day. An event outside the period (a producer
 * that answered more than the range) is shown, flagged `outsidePeriod`, and kept out of the period's totals.
 *
 * THE TOTALS: the events the books will carry (booked before and standing through the period's end, or booked
 * by the dry run): turnover excl. VAT (the contra lines of `sale` and `refund` events), output VAT (account
 * 2200) and input VAT (1170 / 1171), each with the form lines of the tax codes behind it. What stays off is
 * counted beside them (ignored, test, otherwise not booked), never hidden.
 *
 * CHECK (a) PAYOUTS: every `bank_payout` of the period whose members the producer states exactly
 * (`compositionOf` basis `refs`: the events stating its `payoutId` explain it to the Rappen) must be explained
 * by the members the books carry: their clearing amounts plus the payout are 0. `differs` names each payout and
 * its rest; a payout without an exact composition is `unknown` (no fake figure), and while one exists the check is
 * never `ok`: its unexplained gap is shown beside the producer's warnings (a movement on the processor account the
 * producer does not emit, which it warns about, owner 13.11.2026). The feed states no processor
 * balance (`till-settlement/v1` has no such field), so this is the stateless check of the clearing account
 * against what the processor paid out; a stated balance is a later, additive field.
 *
 * CHECK (b) VAT AS BOOKED: over the period's INCLUDED events carrying VAT (and every sale and refund), less the
 * ones the import never books by design (before the source's from-date, a kind the template skips: counted),
 * the VAT the file states equals the VAT the books carry for them through the period's end (a Q3 entry
 * reversed in Q4 still counts in Q3). `differs` lists each event that differs (refused, locked, amended,
 * reversed, waiting for a person).
 *
 * BOOKED EVENTS THE DOCUMENT LACKS (paper critic r2 M2): an event the import booked earlier whose entry date
 * lies in the period, but that the document under review does not carry (the producer moved its day, or
 * stopped listing it), is shown too, `booked`, reason `not_in_document`: the totals are the books.
 *
 * DERIVATION (13.11.2026, additive refs): each row carries how the producer derived it (platform fee taken or
 * waived, processing fee, coach payout, self-bill, VAT rule, ids) and two verdicts on it, the producer's
 * `derivationOk` and TILL's own stateless re-check (`derivation.ts`). Null when the refs state none. Display only.
 *
 * PRIVACY. `refs.counterpartyEmail` and the payer's name are shown to a person; a governed seat sees both masked
 * unless the human-only setting `settlement.agent_sees_email` is `shown` (paper critic M8: an agent's context
 * reaches its model). The email is never logged, audited or put in a URL; the dry run's writes are rolled back.
 *
 * NO SOURCE (D203 point 3): no file, no source named and none saved answers `mode: 'none'`, no rows, nothing
 * to book: a calm start the page offers a file and a source from, never `settlement_source_missing`.
 *
 * WHO. Needs `post` (it runs the import, rolled back). Only a PERSON reviews the feed (paper critic r2 M1: a read
 * is not dialled, and the fetch spends the owner's token; an agent's pull is drafted): a governed seat reviews a
 * file it is given, and is refused `feed_review_person_only` without one.
 * §H-TENANT on every query. Writes nothing.
 */

import { randomBytes } from 'node:crypto';

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { isGovernedSeat } from '../access/index.js';
import { getSetting } from '../settings/index.js';
import { computeLineTax } from '../vat/applyVat.js';
import { reversalChainOf, isLiveNowChain, signedCountThrough } from '../ledger/reversalChain.js';
import { zurichParts } from '../banking/ebics/autoSync.js';
import { isSettlementDay, readSettlementDocument } from './format.js';
import type { SettlementDocument } from './format.js';
import { readSource, readStoredTemplate, TEMPLATE_KIND_DEFAULTS } from './template.js';
import type { SettlementKind } from './format.js';
import { importSettlement, SETTLEMENT_MAX_BYTES, SETTLEMENT_OUTCOME_TEXT } from './importSettlement.js';
import type { ImportSettlementOk, SettlementEventOutcome } from './importSettlement.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { fetchFeedDocument, listSourceRows, preparePull } from './source.js';
import { compositionOf } from './payoutLink.js';
import type { FeedEventRow } from './payoutLink.js';
import { isTestEvent, testSkips, testEventsModeOf, testFeesModeOf } from './flags.js';
import { handledOutsideOf, latestInclusionsOf } from './overrides.js';
import { derivationOf } from './derivation.js';
import type { SettlementDerivation } from './derivation.js';

export const REVIEW_PERIODS = ['quarter', 'month', 'year'] as const;
export type ReviewPeriodUnit = (typeof REVIEW_PERIODS)[number];

export interface SettlementReviewInput {
  system?: unknown;
  processor?: unknown;
  from?: unknown;
  to?: unknown;
  settlement?: unknown;
  content?: unknown;
  /** D206: the days of a whole-day file a person says are complete, handed to the dry run's import unchanged. */
  confirmEdgeDays?: unknown;
  /** D206 (critic r1 M2): the whole file's first and last day, a person's input, handed to the import unchanged. */
  fileDays?: unknown;
}

export type ReviewStatus = 'booked' | 'to_book' | 'skipped' | 'refused';

export interface ReviewRow {
  /**
   * The row's identity, unique by construction (code critic r7 H1): `id:<eventId>` for an event with an id, and
   * `standin:<part|whole>:<position>` for an event the reader refused for having none.
   */
  rowKey: string;
  /** The producer's event id; empty for an event without one (the reader never accepts an empty id). */
  eventId: string;
  kind: string;
  /** Where its VAT lands: its entry's date when booked before, else its own day. */
  day: string;
  /** A row the document carries outside the period (shown, never counted in the period's totals). */
  outsidePeriod: boolean;
  amountMinor: number;
  netMinor: number;
  vatMinor: number | null;
  counterparty: { email: string | null; name: string | null; masked: boolean; document: string | null; chargeId: string | null };
  test: boolean;
  /** The person's answer in force: the import books the event only when `included`. */
  included: boolean;
  inclusion: { state: 'ignored' | 'included'; source: 'booked' | 'handled_outside' | 'override' | 'test_default' | 'default'; reason: string | null; actor: string | null; at: string | null };
  /** What the import does with it (the dry run): `booked` before, `to_book` now, or skipped / refused. */
  status: ReviewStatus;
  reason: string | null;
  code: string | null;
  sentence: string | null;
  /** The entry of an event the import booked BEFORE this review (a dry run's entry does not survive). */
  entryId: string | null;
  /** The VAT the books carry for it (output positive, input negative, like the file), through the period's end. */
  vatPostedMinor: number;
  /** Whether a person may answer it here, and how an include is given (`not_test` for a test event). */
  toggleable: boolean;
  includeVia: 'inclusion' | 'not_test';
  /**
   * How the producer derived it (platform fee, processing fee, coach payout, self-bill, ids) and the verdicts on
   * it, read from the optional derivation refs (`derivation.ts`); null when the refs state none. Display only:
   * the import books the event's own figures.
   */
  derivation: SettlementDerivation | null;
  /**
   * What the producer states for this event now could not be read (a reader refusal): never booked from this
   * document, and check (b) fails closed on it. A booked event re-sent unreadable keeps its booked row with this
   * flag (one row per event).
   */
  unreadable: boolean;
}

export interface ReviewTotals {
  events: number;
  turnoverNetMinor: number;
  outputVat: { amountMinor: number; formLines: string[] };
  inputVat: { amountMinor: number; formLines: string[] };
  /** What stays off the books, counted with its stated VAT. */
  ignored: { events: number; vatMinor: number };
  test: { events: number; vatMinor: number };
  notBooked: { events: number; vatMinor: number };
}

export interface PayoutCheck {
  eventId: string;
  day: string;
  amountMinor: number;
  basis: 'refs' | 'partial' | 'none';
  /**
   * The payout plus its members on the books, plus its TEST members the import leaves off (they are reported
   * apart in `testRestMinor`, D198 already counts them): 0 when the books explain the payout. Null when
   * `basis` is not `refs`.
   */
  restMinor: number | null;
  /** The members the import leaves off as test events (their amounts; paper critic r2 M3). */
  testRestMinor: number;
  /**
   * The members the import leaves off by design other than tests (judged by its outcome: a zero amount, or a kind
   * skipped by default and by the template, such as a reserve hold that stays on the clearing account): reported
   * apart like the test members, never a gap.
   */
  skippedRestMinor: number;
  /**
   * The members dated before the source's from-date (`before_from_date`): the clearing account's opening balance
   * carries them, which TILL cannot see, so they are their own figure (code critic r3 L1), never a gap.
   */
  openingRestMinor: number;
  /**
   * `partial` or `none`: what the payout's stated members leave unexplained (the payout plus their amounts; the
   * whole payout when no event names it), shown so a gap is never silently passed; the document's `warnings` are
   * the producer's stated causes, if it states any. Null for `refs`.
   */
  unexplainedMinor: number | null;
}

export type SettlementReviewOk = {
  /**
   * `file` (a document the caller gave), `feed` (the saved source fetched now) or `none` (D203: no file, no
   * source named and none saved; a calm start with no rows, never a refusal).
   */
  mode: 'file' | 'feed' | 'none';
  system: string;
  processor: string;
  period: { from: string; to: string; unit: ReviewPeriodUnit | 'custom' };
  reviewSha256: string;
  rows: ReviewRow[];
  toBook: number;
  totals: ReviewTotals;
  checks: {
    payouts: { state: 'ok' | 'differs' | 'unknown'; payouts: PayoutCheck[] };
    vat: { state: 'ok' | 'differs' | 'unknown'; statedMinor: number; bookedMinor: number; differing: string[]; outOfScope: number };
  };
  warnings: string[];
  /** Events of the document the reader refused (no id, no day, a bad amount): the import refuses them too. */
  unreadable: number;
  /** The other sources a person may review (system and processor), when the workspace has several. */
  sources: { system: string; processor: string }[];
};

function isErr<T>(x: T | Err): x is Err {
  return (x as { ok?: unknown }).ok === false;
}

/** `settlement.review_period`: `quarter` (default and fallback) | `month` | `year`. */
export function reviewPeriodOf(ctx: WorkspaceContext): ReviewPeriodUnit {
  try {
    const v = getSetting<string>(ctx, 'settlement.review_period');
    return v === 'month' || v === 'year' ? v : 'quarter';
  } catch {
    return 'quarter';
  }
}

/** `settlement.agent_sees_email`: `masked` (default and fallback) | `shown`. */
export function agentSeesEmail(ctx: WorkspaceContext): boolean {
  try {
    return getSetting<string>(ctx, 'settlement.agent_sees_email') === 'shown';
  } catch {
    return false;
  }
}

/** The period of `unit` around a Swiss day. */
export function periodAround(day: string, unit: ReviewPeriodUnit): { from: string; to: string } {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const lastDay = (yy: number, mm: number): string => String(new Date(Date.UTC(yy, mm, 0)).getUTCDate()).padStart(2, '0');
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (unit === 'year') return { from: `${y}-01-01`, to: `${y}-12-31` };
  if (unit === 'month') return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${lastDay(y, m)}` };
  const q0 = Math.floor((m - 1) / 3) * 3 + 1;
  return { from: `${y}-${pad(q0)}-01`, to: `${y}-${pad(q0 + 2)}-${lastDay(y, q0 + 2)}` };
}

/**
 * The part of a settlement document the review reads, and the Studio books, for a period: the same document
 * with only the events whose `day` lies in it (code critic r1 H2). The Studio's `reviewedPart` is the same rule.
 */
export function periodPartOf(raw: unknown, period: { from: string; to: string }): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const doc = raw as Record<string, unknown>;
  const events = Array.isArray(doc['events']) ? (doc['events'] as unknown[]) : [];
  return {
    ...doc,
    events: events.filter((e) => {
      const day = e !== null && typeof e === 'object' ? (e as Record<string, unknown>)['day'] : undefined;
      return typeof day === 'string' && day >= period.from && day <= period.to;
    }),
  };
}

/** A plausible email: a string of at most 254 characters with one `@`, no whitespace. */
export function emailOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s.length === 0 || s.length > 254 || /\s/.test(s)) return null;
  const at = s.indexOf('@');
  if (at <= 0 || at !== s.lastIndexOf('@') || at === s.length - 1) return null;
  return s;
}

function textOf(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 && s.length <= max ? s : null;
}

function refsOfJson(json: string | null): Record<string, unknown> {
  if (json === null) return {};
  try {
    const v = JSON.parse(json) as unknown;
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The sentence of a booked event the document under review does not carry. */
const NOT_IN_DOCUMENT = 'booked by an earlier import; the document under review does not carry it (the producer moved its day or no longer lists it)';

/** Who paid, from the refs and the event's own texts; the payer's email and name masked when `showPerson` is false. */
function counterpartyOf(refs: Record<string, unknown>, counterparty: string | null, documentNumber: string | null, showPerson: boolean): ReviewRow['counterparty'] {
  const email = emailOf(refs['counterpartyEmail']);
  const name = textOf(refs['counterpartyName'], 200) ?? counterparty;
  return {
    email: showPerson ? email : null,
    name: showPerson ? name : null,
    masked: !showPerson && (email !== null || name !== null),
    document: documentNumber ?? textOf(refs['invoiceNumber'], 200),
    chargeId: textOf(refs['chargeId'], 200),
  };
}

/** Thrown out of the dry run to roll it back and carry what it read. */
class ReviewDone extends Error {
  constructor(readonly payload: Gathered | Err) {
    super('settlement review dry run');
  }
}

interface EntryFigures {
  /** The entry's own date: the VAT period it lands in. */
  date: string;
  /** Contra lines (neither the clearing account nor a VAT account), credit positive. */
  netMinor: number;
  /** 2200, credit positive. */
  outputVatMinor: number;
  /** 1170 / 1171, debit positive. */
  inputVatMinor: number;
  outputCodes: string[];
  inputCodes: string[];
  /** The clearing account's movement, debit positive. */
  clearingMinor: number;
  /** 1 when the entry stands through the period's end, else 0 (its reversal chain). */
  standsThroughEnd: number;
  standsNow: boolean;
}

interface Gathered {
  report: ImportSettlementOk;
  /** Event id: the import's row after the dry run (entry and figures). */
  stored: Map<string, { entryId: string; amountMinor: number }>;
  storedBefore: Set<string>;
  entries: Map<string, EntryFigures>;
  test: Set<string>;
  payouts: { row: FeedEventRow; basis: 'refs' | 'partial' | 'none'; residualMinor: number; members: { eventId: string; kind: string; day: string; amountMinor: number; test: boolean }[] }[];
  formLine: Map<string, string | null>;
}

const VAT_OUTPUT_NUMBERS = new Set(['2200']);
const VAT_INPUT_NUMBERS = new Set(['1170', '1171']);

function entryFigures(ctx: WorkspaceContext, entryId: string, clearingAccountId: string, periodEnd: string): EntryFigures {
  const lines = ctx.store.db
    .prepare(
      `SELECT l.account_id, a.number, l.base_debit_minor AS d, l.base_credit_minor AS c, l.tax_code
         FROM journal_line l JOIN account a ON a.id = l.account_id AND a.workspace_id = ?
        WHERE l.entry_id = ?`,
    )
    .all(ctx.workspaceId, entryId) as { account_id: string; number: string; d: number; c: number; tax_code: string | null }[];
  const dated = ctx.store.db.prepare('SELECT date FROM journal_entry WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, entryId) as { date: string } | undefined;
  const f: EntryFigures = { date: dated?.date ?? '', netMinor: 0, outputVatMinor: 0, inputVatMinor: 0, outputCodes: [], inputCodes: [], clearingMinor: 0, standsThroughEnd: 0, standsNow: false };
  const codes: string[] = [];
  for (const l of lines) {
    if (l.account_id === clearingAccountId) f.clearingMinor += l.d - l.c;
    else if (VAT_OUTPUT_NUMBERS.has(l.number)) f.outputVatMinor += l.c - l.d;
    else if (VAT_INPUT_NUMBERS.has(l.number)) f.inputVatMinor += l.d - l.c;
    else {
      f.netMinor += l.c - l.d;
      if (l.tax_code !== null) codes.push(l.tax_code);
    }
  }
  if (f.outputVatMinor !== 0) f.outputCodes = codes;
  if (f.inputVatMinor !== 0) f.inputCodes = codes;
  const chain = reversalChainOf(ctx, entryId);
  f.standsThroughEnd = signedCountThrough(chain, periodEnd) >= 1 ? 1 : 0;
  f.standsNow = isLiveNowChain(chain);
  return f;
}

/** The document under review: a file the person gave, or the feed's answer fetched now (nothing booked). */
function documentUnderReview(
  ctx: WorkspaceContext,
  input: SettlementReviewInput,
  period: { from: string; to: string } | null,
): { mode: 'file' | 'feed'; raw: unknown; doc: SettlementDocument; from: string | null; to: string | null } | Err {
  const hasObject = input.settlement !== undefined && input.settlement !== null;
  const hasText = typeof input.content === 'string' && input.content.length > 0;
  if (hasObject && hasText) return err('invalid_input', { field: 'settlement', reason: 'at most one of settlement (the JSON object) or content (its text)' }) as Err;
  if (hasObject || hasText) {
    let raw: unknown = input.settlement;
    if (hasText) {
      const text = (input.content as string).replace(/^﻿/, '');
      if (Buffer.byteLength(text, 'utf8') > SETTLEMENT_MAX_BYTES) return err('invalid_input', { field: 'content', reason: `at most ${SETTLEMENT_MAX_BYTES} bytes` }) as Err;
      try {
        raw = JSON.parse(text) as unknown;
      } catch {
        return err('invalid_settlement', { field: 'content', reason: 'the content is not JSON' }) as Err;
      }
    }
    const read = readSettlementDocument(raw, baseCurrencyOf(ctx));
    if (!read.ok) return err(read.error, { ...(read.field !== undefined ? { field: read.field } : {}), reason: read.reason }) as Err;
    return { mode: 'file', raw, doc: read.document, from: null, to: null };
  }
  // THE FEED: the pull's own range rules and fetch (`preparePull`, `fetchFeedDocument`), nothing written.
  let named: { system: string; processor: string };
  if (input.system === undefined && input.processor === undefined) {
    const rows = listSourceRows(ctx);
    if (rows.length === 0) return err('settlement_source_missing', { reason: 'no settlement source is saved: load a settlement file, or save the source and its token' }) as Err;
    if (rows.length > 1) return err('source_ambiguous', { reason: 'several settlement sources are saved: name system and processor', sources: rows.map((r) => ({ system: r.source_system, processor: r.source_processor })) }) as Err;
    named = { system: (rows[0] as { source_system: string }).source_system, processor: (rows[0] as { source_processor: string }).source_processor };
  } else {
    const n = readSource(input);
    if (isErr(n)) return n;
    named = n;
  }
  const prepared = preparePull(ctx, { ...named, ...(period !== null ? { from: period.from, to: period.to } : {}), idempotencyKey: 'settlement_review' });
  if (isErr(prepared)) return prepared;
  const fetched = fetchFeedDocument(ctx, prepared.source, prepared.from, prepared.to);
  if (isErr(fetched)) return fetched;
  return { mode: 'feed', raw: fetched.raw, doc: fetched.read.document, from: prepared.from, to: prepared.to };
}

/** D203 point 3: the answer with no document to review (no file, no source saved). */
export function noneReview(period: SettlementReviewOk['period']): SettlementReviewOk {
  const zero = { events: 0, vatMinor: 0 };
  return {
    mode: 'none',
    system: '',
    processor: '',
    period,
    reviewSha256: '',
    rows: [],
    toBook: 0,
    totals: { events: 0, turnoverNetMinor: 0, outputVat: { amountMinor: 0, formLines: [] }, inputVat: { amountMinor: 0, formLines: [] }, ignored: { ...zero }, test: { ...zero }, notBooked: { ...zero } },
    checks: { payouts: { state: 'unknown', payouts: [] }, vat: { state: 'unknown', statedMinor: 0, bookedMinor: 0, differing: [], outOfScope: 0 } },
    warnings: [],
    unreadable: 0,
    sources: [],
  };
}

/** `settlement_review` (module header). */
export function settlementReview(ctx: WorkspaceContext, input: SettlementReviewInput): Result<SettlementReviewOk> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable as Result<SettlementReviewOk>;
  if ((input.from === undefined) !== (input.to === undefined)) return err('invalid_input', { field: input.from === undefined ? 'from' : 'to', reason: 'give both from and to, or neither' }) as Err;
  if (input.from !== undefined && (!isSettlementDay(input.from) || !isSettlementDay(input.to))) return err('invalid_input', { field: 'from', reason: 'YYYY-MM-DD' }) as Err;
  if (input.from !== undefined && (input.from as string) > (input.to as string)) return err('invalid_input', { field: 'to', reason: 'to lies before from' }) as Err;
  const isFile = (input.settlement !== undefined && input.settlement !== null) || (typeof input.content === 'string' && input.content.length > 0);
  const governed = isGovernedSeat(ctx.store, ctx.actor);
  if (!isFile && governed) {
    return err('feed_review_person_only', { reason: 'only a person reviews the feed (it is fetched with the stored token); an agent reviews a settlement file it is given, or proposes pull_settlement' }) as Err;
  }
  const unit = reviewPeriodOf(ctx);
  const today = zurichParts(ctx.clock.now()).date;
  const asked = input.from !== undefined ? { from: input.from as string, to: input.to as string } : null;
  const defaultFeed = periodAround(today, unit);
  // D203 point 3: no file, no source named and none saved is a CALM START, not a refusal. The answer names the
  // period and carries no row, nothing to book and no check; the page offers a file and a source from here.
  if (!isFile && input.system === undefined && input.processor === undefined && listSourceRows(ctx).length === 0) {
    return ok(noneReview(asked !== null ? { ...asked, unit: 'custom' } : { ...defaultFeed, unit }));
  }
  const docd = documentUnderReview(ctx, input, isFile ? null : (asked ?? defaultFeed));
  if (isErr(docd)) return docd;
  const { doc, raw } = docd;
  const days = doc.events.map((e) => e.day).sort();
  const period =
    asked !== null
      ? { ...asked, unit: 'custom' as const }
      : isFile
        ? // A file defaults to the period of `settlement.review_period` around its FIRST day (a pack that runs
          // 01.07 to 12.11 opens on Q3, never on both quarters at once); the person steps to the next one.
          { ...periodAround(days[0] ?? today, unit), unit }
        : { ...defaultFeed, unit };
  const system = doc.system;
  const processor = doc.processor;
  // A FILE IS REVIEWED, AND BOOKED, BY ITS PERIOD (code critic r1 H2): the dry run reads only the events of the
  // file dated in the period (`periodPartOf`), and the Studio books exactly that part, so no event of the file
  // outside the period shown is booked. A feed is fetched for the period already.
  const reviewed = isFile ? periodPartOf(raw, period) : raw;
  const reviewedRead = isFile ? readSettlementDocument(reviewed, baseCurrencyOf(ctx)) : null;
  if (reviewedRead !== null && !reviewedRead.ok) return err(reviewedRead.error, { reason: reviewedRead.reason }) as Err;
  const events = reviewedRead !== null && reviewedRead.ok ? reviewedRead.document.events : doc.events;

  // Before the dry run: what the import booked earlier (its entries survive the rollback) and what TILL had
  // observed (a test event is included with `not_test`, which answers only an observed event).
  const bookedRows = ctx.store.db
    .prepare(
      'SELECT event_id, kind, day, amount_minor, net_minor, vat_minor, counterparty, document_number, refs_json FROM settlement_event WHERE workspace_id = ? AND source_system = ? AND source_processor = ?',
    )
    .all(ctx.workspaceId, system, processor) as {
    event_id: string;
    kind: string;
    day: string;
    amount_minor: number;
    net_minor: number;
    vat_minor: number | null;
    counterparty: string | null;
    document_number: string | null;
    refs_json: string | null;
  }[];
  const storedBefore = new Set(bookedRows.map((r) => r.event_id));
  const observedBefore = new Set(
    (
      ctx.store.db.prepare('SELECT event_id FROM settlement_feed_event WHERE workspace_id = ? AND source_system = ? AND source_processor = ?').all(ctx.workspaceId, system, processor) as {
        event_id: string;
      }[]
    ).map((r) => r.event_id),
  );

  let payload: Gathered | Err | undefined;
  try {
    ctx.store.discardingChanges(() =>
      ctx.store.tx(() => {
        // D206: the person's answer that a first or last day is complete reaches the dry run as it reaches the import.
        const ran = importSettlement(ctx, {
          settlement: reviewed,
          idempotencyKey: `settlement_review:${randomBytes(12).toString('hex')}`,
          ...(input.confirmEdgeDays !== undefined && input.confirmEdgeDays !== null ? { confirmEdgeDays: input.confirmEdgeDays } : {}),
          ...(input.fileDays !== undefined && input.fileDays !== null ? { fileDays: input.fileDays } : {}),
        });
        if (!ran.ok) throw new ReviewDone(ran as Err);
        const report = ran as unknown as ImportSettlementOk;
        const clearing = report.reconciliation.clearingAccountId;
        const stored = new Map(
          (
            ctx.store.db
              .prepare('SELECT event_id, entry_id, amount_minor FROM settlement_event WHERE workspace_id = ? AND source_system = ? AND source_processor = ?')
              .all(ctx.workspaceId, system, processor) as { event_id: string; entry_id: string; amount_minor: number }[]
          ).map((r) => [r.event_id, { entryId: r.entry_id, amountMinor: r.amount_minor }]),
        );
        const entries = new Map<string, EntryFigures>();
        for (const [, s] of stored) if (!entries.has(s.entryId)) entries.set(s.entryId, entryFigures(ctx, s.entryId, clearing, period.to));
        const test = new Set(doc.events.filter((e) => isTestEvent(ctx, system, processor, e.id)).map((e) => e.id));
        const payouts: Gathered['payouts'] = [];
        const payoutRows = ctx.store.db
          .prepare(
            `SELECT rowid, source_system, source_processor, event_id, kind, day, amount_minor, net_minor, vat_minor, payout_ref, test, refs_json
               FROM settlement_feed_event WHERE workspace_id = ? AND source_system = ? AND source_processor = ? AND kind = 'bank_payout' AND day >= ? AND day <= ?
              ORDER BY day, rowid`,
          )
          .all(ctx.workspaceId, system, processor, period.from, period.to) as FeedEventRow[];
        for (const row of payoutRows) {
          const c = compositionOf(ctx, row);
          payouts.push({ row, basis: c.basis, residualMinor: c.residualMinor, members: c.events.map((m) => ({ eventId: m.eventId, kind: m.kind, day: m.day, amountMinor: m.amountMinor, test: m.test })) });
        }
        const formLine = new Map<string, string | null>();
        for (const f of entries.values()) {
          for (const code of [...f.outputCodes, ...f.inputCodes]) {
            if (formLine.has(code)) continue;
            const probe = computeLineTax(ctx, { amountMinor: 10000, amountIsGross: false, taxCode: code, supplyDate: period.to });
            formLine.set(code, probe.ok ? (((probe as unknown as { formLine?: string | null }).formLine ?? null) as string | null) : null);
          }
        }
        throw new ReviewDone({ report, stored, storedBefore, entries, test, payouts, formLine });
      }),
    );
  } catch (x) {
    if (!(x instanceof ReviewDone)) throw x;
    payload = x.payload;
  }
  if (payload === undefined) return err('internal_error', { reason: 'the dry run answered nothing' }) as Err;
  if (isErr(payload)) return payload as Result<SettlementReviewOk>;
  const g = payload;

  const handled = handledOutsideOf(ctx, system, processor);
  const answers = latestInclusionsOf(ctx, system, processor);
  const showPerson = !governed || agentSeesEmail(ctx);
  const outcomeById = new Map<string, SettlementEventOutcome>();
  for (const o of g.report.events) if (o.id !== null) outcomeById.set(o.id, o);

  const rows: ReviewRow[] = [];
  for (const e of events) {
    const o = outcomeById.get(e.id);
    const before = g.storedBefore.has(e.id);
    const s = g.stored.get(e.id);
    const figures = s !== undefined ? g.entries.get(s.entryId) : undefined;
    // A row sits where its VAT lands (code critic r1 H2): the date of its entry when the import booked it before,
    // else its own day (the date its entry would carry). Every event of the document is a row; one outside the
    // period (a producer that answered more than the range) is shown, flagged, and kept out of the totals.
    const day = before && figures !== undefined && figures.date.length > 0 ? figures.date : e.day;
    let status: ReviewStatus;
    // ONE DISPOSITION per event (the property test, 13.11.2026): an event the book holds is `booked`, whatever the
    // producer states now; an amended restatement keeps its code and sentence (`event_amended`) and check (b)
    // lists it, but the row never reads `refused` for VAT the books carry.
    if (before) status = 'booked';
    else if (o?.outcome === 'booked') status = 'to_book';
    else if (o?.outcome === 'skipped') status = 'skipped';
    else status = 'refused';
    const refs = refsOfJson(e.refsJson);
    const isTest = g.test.has(e.id);
    const h = handled.get(e.id);
    const a = answers.get(e.id);
    let inclusion: ReviewRow['inclusion'];
    if (before) inclusion = { state: 'included', source: 'booked', reason: null, actor: null, at: null };
    else if (h !== undefined) inclusion = { state: 'ignored', source: 'handled_outside', reason: h.reason, actor: h.actor, at: h.at };
    else if (a?.state === 'ignored') inclusion = { state: 'ignored', source: 'override', reason: a.reason, actor: a.actor, at: a.at };
    else if (o?.reason === 'test_event') inclusion = { state: 'ignored', source: 'test_default', reason: null, actor: null, at: null };
    else if (a !== undefined) inclusion = { state: 'included', source: 'override', reason: a.reason, actor: a.actor, at: a.at };
    else inclusion = { state: 'included', source: 'default', reason: null, actor: null, at: null };
    const neverBooked = o?.reason === 'template_skip' || o?.reason === 'needs_attention';
    const vatPosted = figures !== undefined && (before || status === 'to_book') ? (figures.outputVatMinor - figures.inputVatMinor) * figures.standsThroughEnd : 0;
    rows.push({
      rowKey: `id:${e.id}`,
      eventId: e.id,
      kind: e.kind,
      day,
      outsidePeriod: day < period.from || day > period.to,
      amountMinor: e.amountMinor,
      netMinor: e.netMinor,
      vatMinor: e.vatMinor,
      counterparty: counterpartyOf(refs, e.counterparty, e.documentNumber, showPerson),
      test: isTest,
      included: inclusion.state === 'included',
      inclusion,
      status,
      reason: o?.reason ?? null,
      code: o?.code ?? null,
      sentence: o?.sentence ?? (o?.reason !== undefined ? (SETTLEMENT_OUTCOME_TEXT[o.reason] ?? null) : null),
      entryId: before ? (s?.entryId ?? null) : null,
      vatPostedMinor: vatPosted,
      // A test event is included with `not_test`, which answers only an event TILL observed (r2 M4): a test event
      // of a document never imported has no toggle until it is booked once (its import records it).
      toggleable: !before && inclusion.source !== 'handled_outside' && !neverBooked && o?.reason !== 'before_from_date' && (inclusion.source !== 'test_default' || observedBefore.has(e.id)),
      includeVia: inclusion.source === 'test_default' ? 'not_test' : 'inclusion',
      derivation: derivationOf(refs, e.vatRate),
      unreadable: false,
    });
  }
  // EVERY EVENT THE DOCUMENT STATES IS A ROW (code critic r4 H1, a chokepoint, not a second list). The rows above
  // come from the events the reader could read; an event the reader REFUSED (an amount that does not add up, a
  // duplicate id, a bad kind) is in the import's own outcomes, which the dry run returned: each becomes a row,
  // status `refused`, its code and sentence, never booked, and check (b) fails closed on it. A file event whose day
  // is not a date never reaches the period's part (`periodPartOf` filters by day), so it is read from the whole
  // file: shown in every period until the producer fixes it, never silently absent.
  // THE MERGE KEY IS AN IDENTITY, NEVER A DISPLAY ID (code critic r7 H1): `rowKey`. A refused event WITH an id merges
  // with its id's other rows; one WITHOUT an id is keyed by its source and position and shows an empty event id
  // (the reader never accepts an empty id), so it never merges with a real event, whatever that id reads, nor with
  // another event without an id.
  const unreadableRow = (u: { id: string | null; index: number; kind: string | null; day: string | null; amountMinor: number | null; code?: string; sentence?: string }, source: 'part' | 'whole'): ReviewRow => {
    const day = u.day ?? period.from;
    const row: ReviewRow = {
      rowKey: u.id !== null ? `id:${u.id}` : `standin:${source}:${u.index + 1}`,
      eventId: u.id ?? '',
      kind: u.kind ?? 'other',
      day,
      outsidePeriod: day < period.from || day > period.to,
      amountMinor: u.amountMinor ?? 0,
      netMinor: 0,
      vatMinor: null,
      counterparty: { email: null, name: null, masked: false, document: null, chargeId: null },
      test: false,
      included: true,
      inclusion: { state: 'included', source: 'default', reason: null, actor: null, at: null },
      status: 'refused',
      reason: null,
      code: u.code ?? 'invalid_event',
      sentence: u.sentence ?? null,
      entryId: null,
      vatPostedMinor: 0,
      toggleable: false,
      includeVia: 'inclusion',
      derivation: null,
      unreadable: true,
    };
    return row;
  };
  const readIndexes = new Set(events.map((e) => e.index));
  for (const o of g.report.events) {
    if (o.outcome === 'refused' && !readIndexes.has(o.index)) rows.push(unreadableRow({ ...o, ...(o.code !== undefined ? { code: o.code } : {}), ...(o.sentence !== undefined ? { sentence: o.sentence } : {}) }, 'part'));
  }
  if (isFile) {
    const whole = Array.isArray((raw as Record<string, unknown> | null)?.['events']) ? ((raw as Record<string, unknown>)['events'] as unknown[]) : [];
    for (const r of doc.refused) {
      if (r.day !== null) continue;
      const rawDay = whole[r.index] !== null && typeof whole[r.index] === 'object' ? (whole[r.index] as Record<string, unknown>)['day'] : undefined;
      if (typeof rawDay === 'string' && rawDay >= period.from && rawDay <= period.to) continue; // in the part: already a row
      rows.push(unreadableRow({ id: r.id, index: r.index, kind: r.kind, day: null, amountMinor: r.amountMinor, code: r.code, sentence: r.reason }, 'whole'));
    }
  }

  // BOOKED EVENTS THE DOCUMENT LACKS (module header, r2 M2).
  const inDocument = new Set(events.map((e) => e.id));
  for (const b of bookedRows) {
    if (inDocument.has(b.event_id)) continue;
    const s = g.stored.get(b.event_id);
    const figures = s !== undefined ? g.entries.get(s.entryId) : undefined;
    const day = figures !== undefined && figures.date.length > 0 ? figures.date : b.day;
    if (day < period.from || day > period.to) continue;
    rows.push({
      rowKey: `id:${b.event_id}`,
      eventId: b.event_id,
      kind: b.kind,
      day,
      outsidePeriod: false,
      amountMinor: b.amount_minor,
      netMinor: b.net_minor,
      vatMinor: b.vat_minor,
      counterparty: counterpartyOf(refsOfJson(b.refs_json), b.counterparty, b.document_number, showPerson),
      test: false,
      included: true,
      inclusion: { state: 'included', source: 'booked', reason: null, actor: null, at: null },
      status: 'booked',
      reason: 'not_in_document',
      code: null,
      sentence: NOT_IN_DOCUMENT,
      entryId: s?.entryId ?? null,
      vatPostedMinor: figures !== undefined ? (figures.outputVatMinor - figures.inputVatMinor) * figures.standsThroughEnd : 0,
      toggleable: false,
      includeVia: 'inclusion',
      derivation: derivationOf(refsOfJson(b.refs_json), null),
      unreadable: false,
    });
  }
  // ONE ROW PER EVENT, ONE SOURCE FOR EVERY SUM (root cause of code critic r4 and r5, docs/planning/
  // A42-rows-root-cause.md). The candidates above come from overlapping sources (the readable events, the reader's
  // refusals, the booked events the document lacks), and a patch to one source broke another (r5: a booked event
  // re-sent unreadable counted twice). They are merged into ONE row per event id, by a fixed precedence: what the
  // books carry (booked) first, then what the producer states readably, then an unreadable statement. A dropped
  // unreadable candidate marks the kept row `unreadable` (its code and sentence), so it is never silent. The totals
  // and check (b) below are plain sums over this one set and join a booked entry only through a row that is booked
  // or to be booked; check (a) reads the books, never the rows.
  const rank = (r: ReviewRow): number => (r.status === 'booked' ? 0 : r.unreadable ? 2 : 1);
  const single = new Map<string, ReviewRow>();
  for (const r of rows) {
    const key = r.rowKey;
    const prev = single.get(key);
    if (prev === undefined) {
      single.set(key, r);
      continue;
    }
    const [keep, drop] = rank(r) < rank(prev) ? [r, prev] : [prev, r];
    if (drop.unreadable && !keep.unreadable) {
      keep.unreadable = true;
      keep.code = drop.code;
      keep.sentence = drop.sentence;
      if (keep.status === 'booked') keep.reason = 'resent_unreadable';
    }
    single.set(key, keep);
  }
  rows.length = 0;
  rows.push(...single.values());
  rows.sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : x.eventId < y.eventId ? -1 : x.eventId > y.eventId ? 1 : 0));

  // THE TOTALS (module header): the entries the books will carry for the period's events.
  const totals: ReviewTotals = {
    events: rows.filter((r) => !r.outsidePeriod).length,
    turnoverNetMinor: 0,
    outputVat: { amountMinor: 0, formLines: [] },
    inputVat: { amountMinor: 0, formLines: [] },
    ignored: { events: 0, vatMinor: 0 },
    test: { events: 0, vatMinor: 0 },
    notBooked: { events: 0, vatMinor: 0 },
  };
  const outLines = new Set<string>();
  const inLines = new Set<string>();
  for (const r of rows) {
    if (r.outsidePeriod) continue;
    // A row built from a reader refusal never joins a booked entry by its id (code critic r5 H1: a booked event
    // re-sent unreadable would count the entry's figures again, once per copy); it is counted as not booked below.
    const s = r.unreadable && r.status !== 'booked' ? undefined : g.stored.get(r.eventId);
    const f = s !== undefined && (g.storedBefore.has(r.eventId) || r.status === 'to_book') ? g.entries.get(s.entryId) : undefined;
    if (f !== undefined && f.standsThroughEnd === 1) {
      if (r.kind === 'sale' || r.kind === 'refund') totals.turnoverNetMinor += f.netMinor;
      totals.outputVat.amountMinor += f.outputVatMinor;
      totals.inputVat.amountMinor += f.inputVatMinor;
      for (const c of f.outputCodes) outLines.add(g.formLine.get(c) ?? '');
      for (const c of f.inputCodes) inLines.add(g.formLine.get(c) ?? '');
      continue;
    }
    // A kind the template never books (payouts, reserves) is no gap: left out of every bucket (KISS, r2).
    if (r.reason === 'template_skip') continue;
    const bucket = r.inclusion.source === 'test_default' ? totals.test : r.inclusion.state === 'ignored' ? totals.ignored : totals.notBooked;
    bucket.events += 1;
    bucket.vatMinor += r.vatMinor ?? 0;
  }
  totals.outputVat.formLines = [...outLines].filter((l) => l.length > 0).sort();
  totals.inputVat.formLines = [...inLines].filter((l) => l.length > 0).sort();

  // CHECK (b), VAT AS BOOKED (module header).
  let stated = 0;
  let booked = 0;
  let outOfScope = 0;
  const differing: string[] = [];
  let inScope = 0;
  for (const r of rows) {
    if (!r.included || r.outsidePeriod) continue;
    // An event the reader refused states figures TILL could not read: whatever VAT it carries is never booked, so
    // the check fails closed on it (code critic r4 H1), whatever its kind.
    if (r.unreadable) {
      inScope += 1;
      // What the books carry for it still counts on the booked side (r7 L1); what it states cannot be read.
      booked += r.vatPostedMinor;
      differing.push(r.eventId !== '' ? r.eventId : r.rowKey);
      continue;
    }
    if (r.kind !== 'sale' && r.kind !== 'refund' && (r.vatMinor ?? 0) === 0) continue;
    // Out of scope only when the import never booked it by design (r4 L3: a booked event whose kind the template
    // skips today still carries its VAT on the books and stays in scope).
    if (r.status !== 'booked' && (r.reason === 'before_from_date' || r.reason === 'template_skip')) {
      outOfScope += 1;
      continue;
    }
    inScope += 1;
    stated += r.vatMinor ?? 0;
    booked += r.vatPostedMinor;
    if ((r.vatMinor ?? 0) !== r.vatPostedMinor) differing.push(r.eventId);
  }
  const vatState: 'ok' | 'differs' | 'unknown' = inScope === 0 ? 'unknown' : differing.length === 0 ? 'ok' : 'differs';

  // CHECK (a), PAYOUTS (module header).
  // A member the books do not carry is reported apart, never a gap, only when the import leaves it off BY DESIGN
  // (the class behind r2 M3, found again on a reserve hold 13.11.2026, and narrowed by code critic r2 M2/M3):
  //  - judged by WHAT THE IMPORT DID with it in this dry run (its outcome reason), never by a flag alone: a test
  //    member (`test_event`), a member before the source's from-date (`before_from_date`: the opening balance
  //    carries it), a zero amount, or a kind the template skips that is skipped by default too (a reserve hold, a
  //    payout: they stay on the clearing account);
  //  - a member this run did not see (an earlier period) is judged by the CURRENT facts the import would apply
  //    now (code critic r3 M1: never by its test flag alone, never by a stale stored outcome); a person's ignore or
  //    handled-outside answer is never by design; a member before the from-date is its own figure
  //    (`openingRestMinor`, r3 L1).
  // Anything else the books do not carry (ignored, handled outside, refused, waiting for a person, a kind the
  // owner's template skips although it is booked by default) stays in the rest and turns the check red.
  const storedTemplate = readStoredTemplate(ctx, system, processor);
  const sourceRow = listSourceRows(ctx).find((r) => r.source_system === system && r.source_processor === processor);
  const fromDate = sourceRow?.from_date ?? null;
  const skippedByDefault = (kind: string): boolean =>
    TEMPLATE_KIND_DEFAULTS[kind as SettlementKind]?.action === 'skip' &&
    (storedTemplate?.template.kinds[kind as SettlementKind] ?? TEMPLATE_KIND_DEFAULTS[kind as SettlementKind])?.action === 'skip';
  type LeftOff = 'test' | 'design' | 'opening' | null;
  // One rule for an outcome reason, whether the dry run just produced it or an earlier import stored it.
  const byReason = (reason: string | null | undefined, kind: string): LeftOff => {
    if (reason === 'test_event') return 'test';
    if (reason === 'before_from_date') return 'opening';
    if (reason === 'zero_amount') return 'design';
    if (reason === 'template_skip' && skippedByDefault(kind)) return 'design';
    return null;
  };
  // A member this run did not see (an earlier period; code critic r3 M1 and its paper attack): judged by the
  // CURRENT facts the import would apply to it now, in the import's own order (a person's answer, the from-date,
  // the test check under today's settings and resolutions, the template), never by its test flag alone and never
  // by a stored outcome, which records the facts of an older import (a later `not_test`, a changed setting or
  // from-date would leave it stale).
  const testModes = { events: testEventsModeOf(ctx), fees: testFeesModeOf(ctx) };
  const leftOffByDesign = (m: { eventId: string; kind: string; day: string; amountMinor: number; test: boolean }): LeftOff => {
    const o = outcomeById.get(m.eventId);
    if (o !== undefined) return byReason(o.reason, m.kind);
    if (handled.has(m.eventId) || answers.get(m.eventId)?.state === 'ignored') return null;
    if (fromDate !== null && m.day < fromDate) return 'opening';
    if (testSkips(m.kind, testModes) && isTestEvent(ctx, system, processor, m.eventId)) return 'test';
    if (skippedByDefault(m.kind)) return 'design';
    if (m.amountMinor === 0) return 'design';
    return null;
  };
  const payoutChecks: PayoutCheck[] = [];
  for (const p of g.payouts) {
    let rest: number | null = null;
    let testRest = 0;
    let skippedRest = 0;
    let openingRest = 0;
    if (p.basis === 'refs') {
      rest = p.row.amount_minor;
      for (const m of p.members) {
        const s = g.stored.get(m.eventId);
        const f = s !== undefined ? g.entries.get(s.entryId) : undefined;
        if (f !== undefined && f.standsNow) {
          rest += f.clearingMinor;
          continue;
        }
        const left = leftOffByDesign(m);
        if (left === 'test') {
          // A test member the import leaves off (r2 M3): reported apart, so a test payment never turns the check red.
          rest += m.amountMinor;
          testRest += m.amountMinor;
        } else if (left === 'design') {
          rest += m.amountMinor;
          skippedRest += m.amountMinor;
        } else if (left === 'opening') {
          rest += m.amountMinor;
          openingRest += m.amountMinor;
        }
      }
    }
    payoutChecks.push({
      eventId: p.row.event_id,
      day: p.row.day,
      amountMinor: p.row.amount_minor,
      basis: p.basis,
      restMinor: rest,
      testRestMinor: testRest,
      skippedRestMinor: skippedRest,
      openingRestMinor: openingRest,
      // `partial` and `none` (code critic r2 M1): what the stated members leave unexplained, the whole payout
      // when no event names it.
      unexplainedMinor: p.basis === 'refs' ? null : p.residualMinor,
    });
  }
  const known = payoutChecks.filter((p) => p.restMinor !== null);
  // A payout its stated members do not explain (`partial`, or `none`: no event names it) is never passed silently
  // (owner 13.11.2026, code critic r2 M1): the check is `unknown` while one exists, with its gap and the producer's
  // warnings shown; never `ok`, and never `differs` on a gap TILL cannot attribute (a member outside the period,
  // a movement the producer does not emit).
  const payoutState: 'ok' | 'differs' | 'unknown' =
    known.some((p) => p.restMinor !== 0) ? 'differs' : known.length === 0 || payoutChecks.some((p) => p.basis !== 'refs') ? 'unknown' : 'ok';

  return ok<SettlementReviewOk>({
    mode: docd.mode,
    system,
    processor,
    period,
    reviewSha256: g.report.reviewSha256,
    rows,
    toBook: g.report.booked,
    totals,
    checks: { payouts: { state: payoutState, payouts: payoutChecks }, vat: { state: vatState, statedMinor: stated, bookedMinor: booked, differing, outOfScope } },
    warnings: g.report.warnings,
    unreadable: (reviewedRead !== null && reviewedRead.ok ? reviewedRead.document : doc).refused.length,
    sources: listSourceRows(ctx).map((r) => ({ system: r.source_system, processor: r.source_processor })),
  });
}
