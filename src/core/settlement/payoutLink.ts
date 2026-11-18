/**
 * D198 point 6, THE PAYOUT LINK: which processor payout a bank line is, and what the payout is made of.
 *
 * A processor pays its balance out to the bank in one transfer. The bank line shows that transfer only;
 * the sales, refunds, transfers to third parties, fees and holds behind it happened inside the processor's
 * balance, and the settlement feed states them (`settlement_feed_event`, kept by `pull_settlement`).
 *
 * MATCHING A BANK LINE. A line coming IN (CRDT, the workspace currency) matches every observed
 * `bank_payout` event whose amount is the line's amount with the opposite sign (a payout leaves the
 * processor balance, so the file states it negative) and whose `day` (the arrival date) lies within
 * `PAYOUT_MATCH_DAYS` of the line's booking date, of every source whose template books on the given
 * clearing account (or of every source with a template). Nearest day first. `match` says `none`, `one` or
 * `several`; a caller proposes a booking only on `one`.
 *
 * THE COMPOSITION of a payout is EXACT ONLY (D198 re-cut R5): every observed event other than a payout kind
 * that states the payout's `payoutId` in ANY sighting (`settlement_feed_payout_ref`; the producer re-emits
 * every member in the document that carries the payout), test events included and flagged (`flags.ts`, the
 * live status). An event stating two payoutIds appears in both, with `conflict: true`. `basis`: `refs`
 * (members exist and explain the payout to the Rappen, residual 0), `partial` (members exist, residual not
 * 0), `none` (no member states it: a payout still in transit). Never presented as exact unless the residual
 * is 0. The day window of the first build is gone: it guessed which payout a sale went into (critic r3 O2).
 *
 * Pure reads. Nothing here writes, and nothing here books: the import books the events, the bank line
 * moves the clearing account.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { readStoredTemplate } from './template.js';
import { refsOf } from './source.js';
import { isTestEvent } from './flags.js';

/** How many days a payout's arrival day may lie from the bank line's booking date. */
export const PAYOUT_MATCH_DAYS = 3;

const PAYOUT_KINDS = ['bank_payout', 'bank_payout_summary'];

export interface FeedEventRow {
  rowid: number;
  source_system: string;
  source_processor: string;
  event_id: string;
  kind: string;
  day: string;
  amount_minor: number;
  net_minor: number;
  vat_minor: number | null;
  payout_ref: string | null;
  test: number;
  refs_json: string | null;
}

const EVENT_COLUMNS = 'rowid, source_system, source_processor, event_id, kind, day, amount_minor, net_minor, vat_minor, payout_ref, test, refs_json';

export interface CompositionEvent {
  eventId: string;
  kind: string;
  day: string;
  amountMinor: number;
  netMinor: number;
  vatMinor: number | null;
  feeWaived: boolean | null;
  test: boolean;
  coachVatRegistered: boolean | null;
  invoiceNumber: string | null;
  /** True when the event states another payoutId too (it appears in both compositions). */
  conflict: boolean;
}

export interface PayoutComposition {
  basis: 'refs' | 'partial' | 'none';
  events: CompositionEvent[];
  sumMinor: number;
  /** sum + payout amount: 0 when the composition explains the payout to the Rappen. */
  residualMinor: number;
  /** Per kind: how many events and their sum. */
  byKind: Record<string, { events: number; amountMinor: number }>;
}

export interface PayoutMatch {
  system: string;
  processor: string;
  clearingAccountId: string;
  payoutEventId: string;
  payoutId: string | null;
  day: string;
  amountMinor: number;
  dayDistance: number;
  composition: PayoutComposition;
}

function daysApart(a: string, b: string): number {
  return Math.abs(Math.round((Date.parse(`${a}T00:00:00.000Z`) - Date.parse(`${b}T00:00:00.000Z`)) / 86_400_000));
}

function boolRef(refs: Record<string, unknown> | null, key: string): boolean | null {
  const v = refs?.[key];
  return typeof v === 'boolean' ? v : null;
}

function strRef(refs: Record<string, unknown> | null, key: string): string | null {
  const v = refs?.[key];
  return typeof v === 'string' && v.length > 0 ? v.slice(0, 200) : null;
}

function compositionEvent(r: FeedEventRow, test: boolean, conflict: boolean): CompositionEvent {
  const refs = refsOf(r.refs_json);
  return {
    eventId: r.event_id,
    kind: r.kind,
    day: r.day,
    amountMinor: r.amount_minor,
    netMinor: r.net_minor,
    vatMinor: r.vat_minor,
    feeWaived: boolRef(refs, 'feeWaived'),
    test,
    coachVatRegistered: boolRef(refs, 'coachVatRegistered'),
    invoiceNumber: strRef(refs, 'invoiceNumber'),
    conflict,
  };
}

/** Every `refs.payoutId` any sighting stated on one event (critic r1 F5: not only the first sighting's). */
export function statedPayoutRefsOf(ctx: WorkspaceContext, system: string, processor: string, eventId: string): string[] {
  return (
    ctx.store.db
      .prepare('SELECT payout_ref FROM settlement_feed_payout_ref WHERE workspace_id = ? AND source_system = ? AND source_processor = ? AND event_id = ? ORDER BY rowid')
      .all(ctx.workspaceId, system, processor, eventId) as { payout_ref: string }[]
  ).map((r) => r.payout_ref);
}

/** The observed payouts of one source, oldest first (day, then the order they were seen). */
export function payoutsOf(ctx: WorkspaceContext, system: string, processor: string): FeedEventRow[] {
  return ctx.store.db
    .prepare(
      `SELECT ${EVENT_COLUMNS} FROM settlement_feed_event
        WHERE workspace_id = ? AND source_system = ? AND source_processor = ? AND kind IN ('bank_payout', 'bank_payout_summary')
        ORDER BY day, rowid`,
    )
    .all(ctx.workspaceId, system, processor) as FeedEventRow[];
}

/** What one observed payout is made of (module header). Exact only. */
export function compositionOf(ctx: WorkspaceContext, payout: FeedEventRow): PayoutComposition {
  const refs = statedPayoutRefsOf(ctx, payout.source_system, payout.source_processor, payout.event_id);
  const rows =
    refs.length === 0
      ? []
      : (ctx.store.db
          .prepare(
            `SELECT DISTINCT ${EVENT_COLUMNS.split(', ').map((c) => `f.${c}`).join(', ')}
               FROM settlement_feed_event f
               JOIN settlement_feed_payout_ref r
                 ON r.workspace_id = f.workspace_id AND r.source_system = f.source_system AND r.source_processor = f.source_processor AND r.event_id = f.event_id
              WHERE f.workspace_id = ? AND f.source_system = ? AND f.source_processor = ? AND r.payout_ref IN (${refs.map(() => '?').join(', ')})
                AND f.kind NOT IN ('bank_payout', 'bank_payout_summary')
              ORDER BY f.day, f.rowid`,
          )
          .all(ctx.workspaceId, payout.source_system, payout.source_processor, ...refs) as FeedEventRow[]);
  const mine = new Set(refs);
  const events = rows.map((r) => {
    const stated = statedPayoutRefsOf(ctx, r.source_system, r.source_processor, r.event_id);
    return compositionEvent(r, isTestEvent(ctx, r.source_system, r.source_processor, r.event_id), stated.some((x) => !mine.has(x)));
  });
  const sumMinor = events.reduce((s, e) => s + e.amountMinor, 0);
  const byKind: Record<string, { events: number; amountMinor: number }> = {};
  for (const e of events) {
    const k = (byKind[e.kind] ??= { events: 0, amountMinor: 0 });
    k.events += 1;
    k.amountMinor += e.amountMinor;
  }
  const residualMinor = sumMinor + payout.amount_minor;
  const basis: PayoutComposition['basis'] = events.length === 0 ? 'none' : residualMinor === 0 ? 'refs' : 'partial';
  return { basis, events, sumMinor, residualMinor, byKind };
}

/**
 * The observed payouts a bank line can be: same amount (sign turned), arrival within `PAYOUT_MATCH_DAYS`
 * days, of a source whose template books on `clearingAccountId` (every source with a template when it is
 * null). Nearest first.
 */
export function payoutsMatching(
  ctx: WorkspaceContext,
  line: { amountMinor: number; day: string },
  clearingAccountId: string | null,
): { row: FeedEventRow; clearingAccountId: string; dayDistance: number }[] {
  if (line.amountMinor <= 0) return [];
  const candidates = ctx.store.db
    .prepare(
      `SELECT ${EVENT_COLUMNS} FROM settlement_feed_event
        WHERE workspace_id = ? AND kind = 'bank_payout' AND amount_minor = ?
        ORDER BY day, rowid`,
    )
    .all(ctx.workspaceId, 0 - line.amountMinor) as FeedEventRow[];
  const out: { row: FeedEventRow; clearingAccountId: string; dayDistance: number }[] = [];
  const clearingOf = new Map<string, string | null>();
  for (const row of candidates) {
    const distance = daysApart(row.day, line.day);
    if (distance > PAYOUT_MATCH_DAYS) continue;
    const key = JSON.stringify([row.source_system, row.source_processor]);
    if (!clearingOf.has(key)) clearingOf.set(key, readStoredTemplate(ctx, row.source_system, row.source_processor)?.template.clearingAccountId ?? null);
    const clearing = clearingOf.get(key) ?? null;
    if (clearing === null) continue;
    if (clearingAccountId !== null && clearing !== clearingAccountId) continue;
    out.push({ row, clearingAccountId: clearing, dayDistance: distance });
  }
  return out.sort((a, b) => a.dayDistance - b.dayDistance || a.row.rowid - b.row.rowid);
}

interface BankLineRow {
  id: string;
  amount_minor: number;
  currency: string;
  credit_debit: string;
  booking_date: string | null;
  value_date: string | null;
  created_at: string;
}

export type SettlementPayoutForBankLineOk = {
  bankTxnId: string;
  direction: 'in' | 'out';
  amountMinor: number;
  day: string;
  match: 'none' | 'one' | 'several';
  matches: PayoutMatch[];
};

/** The bank line's day: its booking date, else its value date, else the day it was imported. */
function lineDay(row: BankLineRow): string {
  return row.booking_date ?? row.value_date ?? row.created_at.slice(0, 10);
}

/**
 * `settlement_payout_for_bank_line`: which observed processor payout this bank line is, with what it is
 * made of. A line going out, or in another currency than the workspace's, matches nothing. Needs
 * `read_books`.
 */
export function settlementPayoutForBankLine(ctx: WorkspaceContext, input: { bankTxnId?: unknown; clearingAccountId?: unknown }): Result<SettlementPayoutForBankLineOk> {
  const capable = ctx.capabilities.assert('read_books');
  if (!capable.ok) return capable;
  if (typeof input.bankTxnId !== 'string' || input.bankTxnId.length === 0) return err('invalid_input', { field: 'bankTxnId' });
  if (input.clearingAccountId !== undefined && input.clearingAccountId !== null && typeof input.clearingAccountId !== 'string') {
    return err('invalid_input', { field: 'clearingAccountId' });
  }
  const row = ctx.store.db
    .prepare('SELECT id, amount_minor, currency, credit_debit, booking_date, value_date, created_at FROM bank_txn WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.bankTxnId) as BankLineRow | undefined;
  if (row === undefined) return err('not_found', { entity: 'bank_txn', id: input.bankTxnId });
  const day = lineDay(row);
  const direction = row.credit_debit === 'CRDT' ? 'in' : 'out';
  const found =
    direction === 'in' && row.currency === baseCurrencyOf(ctx)
      ? payoutsMatching(ctx, { amountMinor: row.amount_minor, day }, typeof input.clearingAccountId === 'string' ? input.clearingAccountId : null)
      : [];
  const matches: PayoutMatch[] = found.map((f) => ({
    system: f.row.source_system,
    processor: f.row.source_processor,
    clearingAccountId: f.clearingAccountId,
    payoutEventId: f.row.event_id,
    payoutId: f.row.payout_ref,
    day: f.row.day,
    amountMinor: f.row.amount_minor,
    dayDistance: f.dayDistance,
    composition: compositionOf(ctx, f.row),
  }));
  return ok<SettlementPayoutForBankLineOk>({
    bankTxnId: row.id,
    direction,
    amountMinor: row.amount_minor,
    day,
    match: matches.length === 0 ? 'none' : matches.length === 1 ? 'one' : 'several',
    matches,
  });
}

/**
 * Has an observed payout reached a bank line: a line coming in, in the workspace currency, of the payout's
 * amount (sign turned), within `PAYOUT_MATCH_DAYS` days of its arrival day. The pre-filing check reads it.
 */
export function payoutReachedBank(ctx: WorkspaceContext, payout: Pick<FeedEventRow, 'amount_minor' | 'day'>): boolean {
  if (payout.amount_minor >= 0) return false;
  const rows = ctx.store.db
    .prepare(
      `SELECT booking_date, value_date, created_at FROM bank_txn
        WHERE workspace_id = ? AND credit_debit = 'CRDT' AND currency = ? AND amount_minor = ?`,
    )
    .all(ctx.workspaceId, baseCurrencyOf(ctx), 0 - payout.amount_minor) as Pick<BankLineRow, 'booking_date' | 'value_date' | 'created_at'>[];
  return rows.some((r) => daysApart(r.booking_date ?? r.value_date ?? r.created_at.slice(0, 10), payout.day) <= PAYOUT_MATCH_DAYS);
}

export { PAYOUT_KINDS as SETTLEMENT_PAYOUT_KINDS };
