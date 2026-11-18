/**
 * D198, THE SETTLEMENT FEED: where TILL pulls a producer's `till-settlement/v1` document from, and the pull.
 *
 * A SOURCE is one live row per (workspace, system, processor), the `settlement_template` shape: the
 * producer's base URL, the first day TILL ever pulls (`from_date`), and `token_ref`, a LOCATOR into the
 * host's secret store (`SettlementFeedPort`, the macOS Keychain in the shipped host). The token itself is
 * never in the book, a file, a log, an answer or a process argument list. Every save is kept in
 * `settlement_source_change` (old and new, without any token) and the audit chain.
 *
 * THE PULL (`pull_settlement`): `GET {baseUrl}/api/accounting/till-settlement?from=&to=` with the bearer
 * token, then the document goes to `import_settlement` UNCHANGED: the same template, the same per-event
 * idempotency on workspace + system + processor + event id, the same refusals. A re-pull books nothing
 * twice. Every event the document carries is also kept as OBSERVED (`settlement_feed_event`), the kinds
 * the template skips included, for the payout link and the pre-filing check. The pull is logged in
 * `settlement_pull`; the watermark and the last result are read from that log.
 *
 * D198 RE-CUT (R2, R3): the fetch runs OUTSIDE any transaction; then ONE transaction, the pull's memo, holds
 * the import (which writes the flags, the observed record, the payout links and one outcome row per event:
 * the import is their one writer) and the log row. A whole-file refusal is checked before the memo; an inner
 * one (a template saved meanwhile) throws, is caught outside the memo and answered, so a refused pull writes
 * nothing. A document the producer marks `complete: false` is checked FIRST: the pull writes only its flags
 * and payout links (never an observed row, so no figure is frozen from it), logs the pull `incomplete`
 * (coverage and the daily done-for-the-day check count only `ok`), and answers ok with `complete: false`
 * and `import: null`.
 *
 * NOTHING IS FETCHED WITHOUT A SAVED TEMPLATE: the pull checks the template before it opens the feed, so
 * neither a manual nor a daily pull ever books by a default. A refused pull writes nothing (the scheduler
 * logs its own failed attempts, `recordFailedPull`).
 */

import { randomBytes } from 'node:crypto';

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { isGovernedSeat } from '../access/index.js';
import { getSetting } from '../settings/index.js';
import { isSettlementDay, readSettlementDocument, SETTLEMENT_SCHEMA } from './format.js';
import { readSource, readStoredTemplate } from './template.js';
import { importSettlement, prevalidateImportSettlement, SETTLEMENT_MAX_BYTES } from './importSettlement.js';
import { rawFlagEventsOf, recordFlags, recordPayoutRefs } from './flags.js';
import type { ImportSettlementOk } from './importSettlement.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { zurichParts } from '../banking/ebics/autoSync.js';

/** The path every producer serves the feed under (the D198 contract). */
export const SETTLEMENT_FEED_PATH = '/api/accounting/till-settlement';
/** The longest range one pull asks for, in days inclusive (the producer answers 400 beyond 366). */
export const SETTLEMENT_PULL_MAX_DAYS = 366;
/** The default of `settlement.pull_overlap_days`: how far a default pull reaches back before the watermark. */
export const SETTLEMENT_PULL_OVERLAP_DAYS = 7;
/** How long one fetch may take. */
export const SETTLEMENT_FETCH_TIMEOUT_MS = 30_000;
/** The values of `settlement.pull_mode` (the registry entry is the schema). */
export const SETTLEMENT_PULL_MODES = ['manual', 'daily'] as const;
export type SettlementPullMode = (typeof SETTLEMENT_PULL_MODES)[number];

/**
 * A token TILL will store: 16 to 512 characters of the base64url, base64 and hex alphabets (plus `.` and
 * `~`). The shape keeps the value from ever breaking out of the secret store's command line.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{16,512}$/;
const BASE_URL_MAX = 500;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** One sentence per refusal of the feed verbs, for an agent reading the answer. */
export const SETTLEMENT_PULL_REFUSALS: Readonly<Record<string, string>> = {
  settlement_source_missing: 'no settlement source is saved for this system and processor: a person saves one with set_settlement_source',
  settlement_template_missing: 'no booking template for this source: nothing is fetched or booked until one is saved with set_settlement_template',
  token_missing: 'the secret store holds no token for this source: a person saves it with set_settlement_source',
  feed_transport_missing: 'this TILL has no way to reach a settlement feed (no secret store on this host)',
  review_stale: 'what the pull would book differs from the review you booked from: review the period again before booking',
  secret_store_unavailable: 'this TILL has no secret store for the token on this host, so it cannot keep one',
  secret_store_failed: 'the secret store refused to keep the token',
  feed_unreachable: 'the feed did not answer (no connection, a certificate problem or a timeout)',
  feed_unauthorized: 'the feed refused the token (HTTP 401): save the current token again',
  feed_bad_request: 'the feed refused the range (HTTP 400): a bad date or more than 366 days',
  feed_http_error: 'the feed answered with an error status',
  feed_path_invalid: 'the saved feed path does not stay under the producer\'s address: save the source again with a plain path',
  feed_schema: `the feed did not answer a readable ${SETTLEMENT_SCHEMA} document`,
  feed_source_mismatch: 'the feed answered a document of another system or processor than the source',
  human_only: 'only a person may save a settlement source; an agent can neither save nor propose it',
};

export interface SourceRow {
  id: string;
  source_system: string;
  source_processor: string;
  base_url: string;
  from_date: string;
  token_ref: string | null;
  /** A43: NULL means the default `SETTLEMENT_FEED_PATH`. */
  feed_path: string | null;
  updated_by: string;
  updated_at: string;
}

interface PullRow {
  id: string;
  range_from: string;
  range_to: string;
  outcome: string;
  error_code: string | null;
  trigger_kind: string;
  events_seen: number;
  events_new: number;
  amended_seen: number;
  booked: number;
  already_imported: number;
  skipped: number;
  refused: number;
  actor: string;
  at: string;
}

function isErr<T>(x: T | Err): x is Err {
  return (x as { ok?: unknown }).ok === false;
}

function refuse(code: string, extra: Record<string, unknown> = {}): Err {
  return err(code, { ...extra, reason: SETTLEMENT_PULL_REFUSALS[code] ?? code }) as Err;
}

/** A fresh secret store locator: random, of a shape any store accepts, minted when a token is first stored. */
export function mintTokenRef(): string {
  return `stl-${randomBytes(20).toString('hex')}`;
}

/** A producer base URL TILL accepts: https (http only to a loopback host), no credentials, no query. */
export function readBaseUrl(value: unknown): string | Err {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > BASE_URL_MAX) {
    return err('invalid_input', { field: 'baseUrl', reason: `the producer's address, https, at most ${BASE_URL_MAX} characters` }) as Err;
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return err('invalid_input', { field: 'baseUrl', reason: 'not a URL' }) as Err;
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return err('invalid_input', { field: 'baseUrl', reason: 'https only (http is accepted for a producer on this computer: localhost)' }) as Err;
  }
  if (url.username !== '' || url.password !== '') return err('invalid_input', { field: 'baseUrl', reason: 'no user or password in the address: the token goes in the token field' }) as Err;
  if (url.search !== '' || url.hash !== '') return err('invalid_input', { field: 'baseUrl', reason: 'the base address, without a query or a fragment' }) as Err;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/** The longest feed path TILL keeps. */
export const FEED_PATH_MAX = 200;
/**
 * A feed path TILL accepts (A43 section 4): a path only, starting with one slash. A query or a fragment refuses
 * `invalid_input` (the range is TILL's own query), and so does anything that is not a plain path.
 */
export function readFeedPath(value: unknown): string | Err {
  const bad = (reason: string): Err => err('invalid_input', { field: 'feedPath', reason }) as Err;
  if (typeof value !== 'string' || value.length === 0 || value.length > FEED_PATH_MAX) return bad(`a path of 1 to ${FEED_PATH_MAX} characters, for example ${SETTLEMENT_FEED_PATH}`);
  if (value.includes('?') || value.includes('#')) return bad('a path only, without a query or a fragment');
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(value)) return bad('a path starting with one slash, in URL path characters');
  if (value.startsWith('//')) return bad('a path starting with one slash');
  if (value.split('/').some((seg) => seg === '..' || seg === '.')) return bad('no . or .. segments');
  // A percent-encoded dot or separator is a dot segment to a URL parser (`/%2e%2e/x` climbs out of the base path).
  if (/%(2e|2f|5c)/i.test(value)) return bad('no encoded dot, slash or backslash (%2e, %2f, %5c)');
  return value;
}

/**
 * The feed URL of one range, built with the URL parser and CHECKED: the origin must be the base's and the path
 * the base path plus the feed path, exactly. Null when the pair does not compose (a dot segment the parser
 * collapsed, another host), so a stored path can never reach beyond the producer's base address.
 */
export function composeFeedUrl(baseUrl: string, feedPath: string, range?: { from: string; to: string }): string | null {
  try {
    const base = new URL(baseUrl);
    const basePath = base.pathname.replace(/\/+$/, '');
    const url = new URL(`${base.origin}${basePath}${feedPath}`);
    if (url.origin !== base.origin || url.pathname !== `${basePath}${feedPath}` || url.search !== '' || url.hash !== '') return null;
    if (range !== undefined) url.search = `?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
    return url.href;
  } catch {
    return null;
  }
}

/** The feed path of a stored row: NULL (or a row from before the column) is the default. */
export function effectiveFeedPath(row: { feed_path?: string | null }): string {
  return row.feed_path ?? SETTLEMENT_FEED_PATH;
}

/** Add `days` to an ISO day. */
function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Days from `a` to `b` (b - a). */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) / 86_400_000);
}

function readSourceRow(ctx: WorkspaceContext, system: string, processor: string): SourceRow | undefined {
  return ctx.store.db
    .prepare(
      'SELECT id, source_system, source_processor, base_url, from_date, token_ref, feed_path, updated_by, updated_at FROM settlement_source WHERE workspace_id = ? AND source_system = ? AND source_processor = ?',
    )
    .get(ctx.workspaceId, system, processor) as SourceRow | undefined;
}

/** Every source of the workspace. */
export function listSourceRows(ctx: WorkspaceContext): SourceRow[] {
  return ctx.store.db
    .prepare(
      'SELECT id, source_system, source_processor, base_url, from_date, token_ref, feed_path, updated_by, updated_at FROM settlement_source WHERE workspace_id = ? ORDER BY source_system, source_processor',
    )
    .all(ctx.workspaceId) as SourceRow[];
}

/**
 * What one successful pull COVERED: its range, but never the day it ran nor any later day (critic r1 F2).
 * Events of the pull's own day may still be coming, so a pull at 10:00 on the 5th covers up to the 4th.
 */
function coveredRangesOf(ctx: WorkspaceContext, sourceId: string): { from: string; to: string }[] {
  const rows = ctx.store.db
    .prepare("SELECT range_from, range_to, at FROM settlement_pull WHERE workspace_id = ? AND source_id = ? AND outcome = 'ok' ORDER BY range_from")
    .all(ctx.workspaceId, sourceId) as { range_from: string; range_to: string; at: string }[];
  const out: { from: string; to: string }[] = [];
  for (const r of rows) {
    const dayBefore = addDays(zurichParts(r.at).date, -1);
    const to = r.range_to < dayBefore ? r.range_to : dayBefore;
    if (to >= r.range_from) out.push({ from: r.range_from, to });
  }
  return out;
}

/** The last day the successful pulls of a source covered (`coveredRangesOf`): the watermark. */
export function watermarkOf(ctx: WorkspaceContext, sourceId: string): string | null {
  let w: string | null = null;
  for (const r of coveredRangesOf(ctx, sourceId)) if (w === null || r.to > w) w = r.to;
  return w;
}

/** The ranges the successful pulls of a source covered, for the coverage check. */
export function pulledRangesOf(ctx: WorkspaceContext, sourceId: string): { from: string; to: string }[] {
  return coveredRangesOf(ctx, sourceId);
}

function lastPullOf(ctx: WorkspaceContext, sourceId: string): PullRow | undefined {
  return ctx.store.db
    .prepare(
      `SELECT id, range_from, range_to, outcome, error_code, trigger_kind, events_seen, events_new, amended_seen, booked, already_imported, skipped, refused, actor, at
         FROM settlement_pull WHERE workspace_id = ? AND source_id = ? ORDER BY at DESC, rowid DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, sourceId) as PullRow | undefined;
}

function pullView(row: PullRow): Record<string, unknown> {
  return {
    pullId: row.id,
    from: row.range_from,
    to: row.range_to,
    outcome: row.outcome,
    errorCode: row.error_code,
    trigger: row.trigger_kind,
    eventsSeen: row.events_seen,
    eventsNew: row.events_new,
    amendedSeen: row.amended_seen,
    booked: row.booked,
    alreadyImported: row.already_imported,
    skipped: row.skipped,
    refused: row.refused,
    actor: row.actor,
    at: row.at,
  };
}

/**
 * The workspace's `settlement.pull_overlap_days` (R2): how far a default pull reaches back before the
 * watermark. The registry default (7) when it cannot be read.
 */
export function pullOverlapDaysOf(ctx: WorkspaceContext): number {
  try {
    const v = getSetting<number>(ctx, 'settlement.pull_overlap_days');
    return Number.isInteger(v) && v >= 1 && v <= 60 ? v : SETTLEMENT_PULL_OVERLAP_DAYS;
  } catch {
    return SETTLEMENT_PULL_OVERLAP_DAYS;
  }
}

/** The workspace's `settlement.pull_mode`, `manual` when it cannot be read. */
export function pullModeOf(ctx: WorkspaceContext): SettlementPullMode {
  try {
    return getSetting<string>(ctx, 'settlement.pull_mode') === 'daily' ? 'daily' : 'manual';
  } catch {
    return 'manual';
  }
}

/** The source as an answer reads it: never the token, only whether one is stored. */
function sourceView(ctx: WorkspaceContext, row: SourceRow): Record<string, unknown> {
  const port = ctx.settlementFeed;
  const tokenStored = row.token_ref !== null && port !== undefined ? port.hasToken(row.token_ref) : false;
  const last = lastPullOf(ctx, row.id);
  return {
    sourceId: row.id,
    system: row.source_system,
    processor: row.source_processor,
    baseUrl: row.base_url,
    feedPath: effectiveFeedPath(row),
    fromDate: row.from_date,
    tokenStored,
    secretStore: port?.secretStore ?? null,
    watermark: watermarkOf(ctx, row.id),
    lastPull: last === undefined ? null : pullView(last),
    pullMode: pullModeOf(ctx),
    templateSaved: readStoredTemplate(ctx, row.source_system, row.source_processor) !== null,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

// --- set_settlement_source -------------------------------------------------------------------------

export interface SetSettlementSourceInput {
  system?: unknown;
  processor?: unknown;
  baseUrl?: unknown;
  /** A43 section 4: the path the feed is served under; default, and when omitted on an existing source the saved path, `SETTLEMENT_FEED_PATH`. */
  feedPath?: unknown;
  fromDate?: unknown;
  /** The feed token. Named `feedToken`, not `token`: a `token` field marks a portal-token call to the N01 claim (critic r1 F7). */
  feedToken?: unknown;
  clearToken?: unknown;
  idempotencyKey?: unknown;
}

interface PreparedSource {
  system: string;
  processor: string;
  baseUrl: string;
  feedPath: string | null;
  fromDate: string;
  token: string | null;
  clearToken: boolean;
}

/** `human_only` for a governed seat (the local agent, a served agent member, a plugin), else null. */
function refuseGovernedSeat(ctx: WorkspaceContext): Err | null {
  return isGovernedSeat(ctx.store, ctx.actor) ? refuse('human_only') : null;
}

function prepareSetSource(ctx: WorkspaceContext, input: SetSettlementSourceInput): PreparedSource | Err {
  const human = refuseGovernedSeat(ctx);
  if (human !== null) return human;
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable as Err;
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) return err('invalid_input', { field: 'idempotencyKey' }) as Err;
  const source = readSource(input);
  if (isErr(source)) return source;
  const base = readBaseUrl(input.baseUrl);
  if (isErr(base)) return base;
  const held = readSourceRow(ctx, source.system, source.processor);
  let feedPath = held === undefined ? SETTLEMENT_FEED_PATH : effectiveFeedPath(held);
  if (input.feedPath !== undefined && input.feedPath !== null) {
    const read = readFeedPath(input.feedPath);
    if (isErr(read)) return read;
    feedPath = read;
  }
  // The token is bound to the FULL address: base and path are one stored value, so a moved path drops it.
  if (composeFeedUrl(base, feedPath) === null) return err('invalid_input', { field: 'feedPath', reason: 'the path must stay under the base address' }) as Err;
  const baseUrl = base;
  // NULL in the column is the default, so a save of the default path keeps the column NULL.
  const storedPath = feedPath === SETTLEMENT_FEED_PATH ? null : feedPath;
  if (!isSettlementDay(input.fromDate)) return err('invalid_input', { field: 'fromDate', reason: 'the first day to pull, YYYY-MM-DD' }) as Err;
  // The OLD name of the token field (critic r1 F7 renamed it `feedToken`): refused, never echoed and never
  // ignored, so a token sent under it is neither stored nor silently dropped (security review, 12.11.2026).
  if ((input as Record<string, unknown>)['token'] !== undefined) {
    return err('invalid_input', { field: 'token', reason: 'the feed token goes in feedToken' }) as Err;
  }
  const clearToken = input.clearToken === true;
  if (input.clearToken !== undefined && typeof input.clearToken !== 'boolean') return err('invalid_input', { field: 'clearToken' }) as Err;
  let token: string | null = null;
  if (input.feedToken !== undefined && input.feedToken !== null) {
    if (typeof input.feedToken !== 'string' || !TOKEN_SHAPE.test(input.feedToken.trim())) {
      // The answer never echoes what was typed.
      return err('invalid_input', { field: 'feedToken', reason: '16 to 512 characters of letters, digits and . _ ~ + / = -' }) as Err;
    }
    token = input.feedToken.trim();
  }
  if (token !== null && clearToken) return err('invalid_input', { field: 'clearToken', reason: 'either a new token or clearToken, not both' }) as Err;
  if ((token !== null || clearToken) && ctx.settlementFeed === undefined) return refuse('secret_store_unavailable');
  return { system: source.system, processor: source.processor, baseUrl, feedPath: storedPath, fromDate: input.fromDate as string, token, clearToken };
}

export type SetSettlementSourceOk = {
  sourceId: string;
  changed: boolean;
  tokenChanged: boolean;
  /** True when the save moved the source to another address without a new token, so the stored one was dropped. */
  tokenDroppedUrlMoved: boolean;
  source: Record<string, unknown>;
};

/**
 * `set_settlement_source`: save (replace) one source. A PERSON only: a governed seat is refused
 * `human_only` before anything (the transport seam runs the same check before it drafts). The token, when
 * given, goes to the secret store FIRST; when the store refuses, nothing is written.
 */
export function setSettlementSource(ctx: WorkspaceContext, input: SetSettlementSourceInput): Result<SetSettlementSourceOk> {
  const prepared = prepareSetSource(ctx, input);
  if (isErr(prepared)) return prepared;
  const { system, processor, baseUrl, feedPath, fromDate, token, clearToken } = prepared;
  // The scoped key carries no token: the idempotency record must never hold it.
  const scopedKey = JSON.stringify(['set_settlement_source', system, processor, input.idempotencyKey]);
  const replay = ctx.store.recallIdempotent<Result<SetSettlementSourceOk>>(ctx.workspaceId, scopedKey, 'set_settlement_source');
  if (replay !== undefined) return replay;
  const port = ctx.settlementFeed;
  // A TOKEN IS BOUND TO THE ADDRESS IT WAS SAVED FOR (security review, 12.11.2026). A save that changes the
  // base URL without a new token drops the stored one: otherwise a person who may save sources but never
  // saw the token could point it at an address (or a path) of their choosing.
  // THE LOCATOR IS MINTED, NEVER DERIVED: a random value per stored token, kept in `token_ref`, and the
  // store is only ever addressed through the locator this row holds. A copied book (its `token_ref` nulled
  // by the secret floor) can therefore never overwrite or delete the original book's Keychain item.
  const before = readSourceRow(ctx, system, processor);
  const heldRef = before?.token_ref ?? null;
  const urlMoved = before !== undefined && heldRef !== null && (before.base_url !== baseUrl || (before.feed_path ?? null) !== feedPath);
  const dropToken = clearToken || (urlMoved && token === null);
  const tokenRef = token !== null ? (heldRef ?? mintTokenRef()) : heldRef;
  if (token !== null && port !== undefined && tokenRef !== null) {
    const stored = port.storeToken(tokenRef, token);
    if (!stored.ok) return refuse('secret_store_failed', { detail: stored.reason });
  }
  if (dropToken && port !== undefined && heldRef !== null) {
    const cleared = port.deleteToken(heldRef);
    if (!cleared.ok) return refuse('secret_store_failed', { detail: cleared.reason });
  }
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'set_settlement_source', () => {
    const now = ctx.clock.now();
    const existing = readSourceRow(ctx, system, processor);
    // The row may have changed between the first read and this transaction: whether the address moved, and so
    // whether the token drops, is decided HERE against the row this write replaces (critic L5).
    const movedNow = existing !== undefined && existing.token_ref !== null && (existing.base_url !== baseUrl || (existing.feed_path ?? null) !== feedPath);
    const dropNow = clearToken || (movedNow && token === null);
    if (dropNow && !dropToken && port !== undefined && existing?.token_ref != null) {
      // Best effort: the row no longer names the locator either way, so the token cannot be used from the book.
      port.deleteToken(existing.token_ref);
    }
    const nextRef = dropNow ? null : token !== null ? tokenRef : (existing?.token_ref ?? null);
    const config = (r: { base_url: string; feed_path: string | null; from_date: string; token_ref: string | null }): string =>
      JSON.stringify({ baseUrl: r.base_url, feedPath: r.feed_path ?? SETTLEMENT_FEED_PATH, fromDate: r.from_date, tokenRef: r.token_ref });
    const nextJson = config({ base_url: baseUrl, feed_path: feedPath, from_date: fromDate, token_ref: nextRef });
    const oldJson = existing === undefined ? null : config(existing);
    let sourceId: string;
    if (existing === undefined) {
      sourceId = ctx.ids.next('stlsrc');
      ctx.store.db
        .prepare(
          'INSERT INTO settlement_source (id, workspace_id, source_system, source_processor, base_url, feed_path, from_date, token_ref, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(sourceId, ctx.workspaceId, system, processor, baseUrl, feedPath, fromDate, nextRef, ctx.actor, now);
    } else {
      sourceId = existing.id;
    }
    const tokenChanged = token !== null || (dropNow && existing !== undefined && existing.token_ref !== null);
    // A new token under the same locator changes no column, yet it is a change a person made: record it.
    const changed = oldJson !== nextJson || tokenChanged;
    if (existing !== undefined && changed) {
      ctx.store.db
        .prepare('UPDATE settlement_source SET base_url = ?, feed_path = ?, from_date = ?, token_ref = ?, updated_by = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
        .run(baseUrl, feedPath, fromDate, nextRef, ctx.actor, now, ctx.workspaceId, sourceId);
    }
    if (changed) {
      const recordJson = (json: string, tokenNote: string | null): string => JSON.stringify({ ...(JSON.parse(json) as object), ...(tokenNote !== null ? { token: tokenNote } : {}) });
      ctx.store.db
        .prepare('INSERT INTO settlement_source_change (id, workspace_id, source_id, old_json, new_json, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(
          ctx.ids.next('stlschg'),
          ctx.workspaceId,
          sourceId,
          oldJson,
          recordJson(nextJson, token !== null ? 'replaced' : clearToken ? 'cleared' : dropNow ? 'cleared_url_moved' : null),
          ctx.actor,
          now,
        );
      ctx.audit.record({ entityKind: 'settlement_source', entityId: sourceId, action: existing === undefined ? 'create' : 'update', actor: ctx.actor, at: now });
    }
    const row = readSourceRow(ctx, system, processor) as SourceRow;
    return ok<SetSettlementSourceOk>({ sourceId, changed, tokenChanged, tokenDroppedUrlMoved: movedNow && token === null && !clearToken, source: sourceView(ctx, row) });
  });
}

/** D158: the save's own validation, nothing written (the human-only check included). */
export function prevalidateSetSettlementSource(ctx: WorkspaceContext, input: SetSettlementSourceInput): Result | undefined {
  const prepared = prepareSetSource(ctx, input);
  return isErr(prepared) ? prepared : undefined;
}

// --- get_settlement_source -------------------------------------------------------------------------

/** `get_settlement_source`: one source, or every source of the workspace. Never the token. */
export function getSettlementSource(ctx: WorkspaceContext, input: { system?: unknown; processor?: unknown }): Result {
  const capable = ctx.capabilities.assert('read_books');
  if (!capable.ok) return capable;
  let rows: SourceRow[];
  if (input.system === undefined && input.processor === undefined) {
    rows = listSourceRows(ctx);
  } else {
    const source = readSource(input);
    if (isErr(source)) return source;
    const row = readSourceRow(ctx, source.system, source.processor);
    rows = row === undefined ? [] : [row];
  }
  return ok({ sources: rows.map((r) => sourceView(ctx, r)), pullMode: pullModeOf(ctx), feedAvailable: ctx.settlementFeed !== undefined });
}

// --- pull_settlement -------------------------------------------------------------------------------

export interface PullSettlementInput {
  system?: unknown;
  processor?: unknown;
  from?: unknown;
  to?: unknown;
  idempotencyKey?: unknown;
  /**
   * `daily` when the scheduler runs the pull under `settlement.pull_mode` daily; anything else is a manual
   * pull. A LABEL on the log row only: it decides nothing.
   */
  trigger?: unknown;
  /**
   * A42: the `reviewSha256` of the Umsatz review the person booked from. Given, the import inside the pull
   * refuses `review_stale` when what it would book differs from what the review showed, and the whole pull is
   * rolled back (nothing written).
   */
  expectReviewSha256?: unknown;
}

export interface PreparedPull {
  source: SourceRow;
  from: string;
  to: string;
  more: boolean;
  trigger: 'manual' | 'daily';
}

/** The Swiss calendar day of the context's clock. */
function todayOf(ctx: WorkspaceContext): string {
  return zurichParts(ctx.clock.now()).date;
}

/** Everything the pull decides before it opens the feed; shared with the pre-draft check. */
/** The pull's checks and its range, nothing written (shared with the Umsatz review, A42). */
export function preparePull(ctx: WorkspaceContext, input: PullSettlementInput): PreparedPull | Err {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable as Err;
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) return err('invalid_input', { field: 'idempotencyKey' }) as Err;
  const named = readSource(input);
  if (isErr(named)) return named;
  const source = readSourceRow(ctx, named.system, named.processor);
  if (source === undefined) return refuse('settlement_source_missing', { system: named.system, processor: named.processor });
  if (readStoredTemplate(ctx, named.system, named.processor) === null) {
    return refuse('settlement_template_missing', { system: named.system, processor: named.processor });
  }
  if (input.from !== undefined && !isSettlementDay(input.from)) return err('invalid_input', { field: 'from', reason: 'YYYY-MM-DD' }) as Err;
  if (input.to !== undefined && !isSettlementDay(input.to)) return err('invalid_input', { field: 'to', reason: 'YYYY-MM-DD' }) as Err;
  const today = todayOf(ctx);
  let from: string;
  if (input.from !== undefined) {
    from = input.from as string;
  } else {
    const watermark = watermarkOf(ctx, source.id);
    from = watermark === null ? source.from_date : addDays(watermark, 0 - pullOverlapDaysOf(ctx));
  }
  if (from < source.from_date) from = source.from_date;
  // Never past today (critic r1 F2): a range into the future would claim days nobody has seen yet.
  let to = input.to !== undefined && (input.to as string) < today ? (input.to as string) : today;
  if (to < from) return err('invalid_input', { field: 'to', reason: 'to lies before from (the from-date of the source, or the from you gave)', from, to }) as Err;
  let more = false;
  if (daysBetween(from, to) + 1 > SETTLEMENT_PULL_MAX_DAYS) {
    if (input.to !== undefined && input.from !== undefined) {
      return err('invalid_input', { field: 'to', reason: `at most ${SETTLEMENT_PULL_MAX_DAYS} days per pull` }) as Err;
    }
    to = addDays(from, SETTLEMENT_PULL_MAX_DAYS - 1);
    more = true;
  }
  const port = ctx.settlementFeed;
  if (port === undefined) return refuse('feed_transport_missing');
  if (source.token_ref === null || !port.hasToken(source.token_ref)) return refuse('token_missing', { system: named.system, processor: named.processor });
  return { source, from, to, more, trigger: input.trigger === 'daily' ? 'daily' : 'manual' };
}

export type PullSettlementOk = {
  pullId: string;
  system: string;
  processor: string;
  from: string;
  to: string;
  /** True when the range was cut at 366 days: another pull is due. */
  more: boolean;
  eventsSeen: number;
  eventsNew: number;
  amendedSeen: number;
  /** False when the producer said the document is incomplete (R3): nothing was imported, `import` is null. */
  complete: boolean;
  import: ImportSettlementOk | null;
};

/** The feed URL of one range, or null when the path does not stay under the base. No engine caller: the pull uses `composeFeedUrl`. */
export function feedUrlOf(baseUrl: string, from: string, to: string, feedPath: string = SETTLEMENT_FEED_PATH): string | null {
  return composeFeedUrl(baseUrl, feedPath, { from, to });
}

/** The text of an error body, cut short and stripped of control characters, for a person to read. */
function bodyExcerpt(body: string): string {
  // Critic r1 F6, r2 N2: a producer, a proxy or a debug page may echo the request headers, in any spelling
  // (escaped, encoded, split). An answer that mentions a credential at all is WITHHELD, never redacted
  // piecemeal; anything else is cut of long token-like runs. The host also blanks the token itself.
  if (/authori[sz]ation|bearer|token|secret|api[-_ ]?key|password|cookie/i.test(body)) return '[withheld: the answer mentions a credential]';
  return body
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[A-Za-z0-9._~+/=\\%-]{24,}/g, '[redacted]')
    .trim()
    .slice(0, 200);
}

/**
 * The pull's fetch and whole-document checks, nothing written (D198 R2: outside any transaction): the GET
 * through the host port, the status, JSON, the reader, and the source match. Shared with the Umsatz review
 * (A42), which reviews the fetched document before anything is booked.
 */
export function fetchFeedDocument(
  ctx: WorkspaceContext,
  source: SourceRow,
  from: string,
  to: string,
): { raw: unknown; read: Extract<ReturnType<typeof readSettlementDocument>, { ok: true }> } | Err {
  const port = ctx.settlementFeed;
  if (port === undefined) return refuse('feed_transport_missing');
  const feedUrl = composeFeedUrl(source.base_url, effectiveFeedPath(source), { from, to });
  if (feedUrl === null) return refuse('feed_path_invalid', { system: source.source_system, processor: source.source_processor });
  const fetched = port.fetchFeed({
    url: feedUrl,
    tokenRef: source.token_ref as string,
    timeoutMs: SETTLEMENT_FETCH_TIMEOUT_MS,
    maxBytes: SETTLEMENT_MAX_BYTES,
  });
  const where = { system: source.source_system, processor: source.source_processor, from, to };
  if (fetched.kind === 'no_token') return refuse('token_missing', where);
  if (fetched.kind === 'unreachable') return refuse('feed_unreachable', { ...where, detail: fetched.reason.slice(0, 200) });
  if (fetched.status === 401 || fetched.status === 403) return refuse('feed_unauthorized', { ...where, status: fetched.status });
  if (fetched.status === 400) return refuse('feed_bad_request', { ...where, status: 400, detail: bodyExcerpt(fetched.body) });
  if (fetched.status !== 200) return refuse('feed_http_error', { ...where, status: fetched.status, detail: bodyExcerpt(fetched.body) });

  let raw: unknown;
  try {
    raw = JSON.parse(fetched.body.replace(/^\uFEFF/, '')) as unknown;
  } catch {
    return refuse('feed_schema', { ...where, detail: 'the answer is not JSON' });
  }
  const read = readSettlementDocument(raw, baseCurrencyOf(ctx));
  if (!read.ok) return refuse('feed_schema', { ...where, cause: { code: read.error, ...(read.field !== undefined ? { field: read.field } : {}), detail: read.reason } });
  if (read.document.system !== source.source_system || read.document.processor !== source.source_processor) {
    return refuse('feed_source_mismatch', { ...where, documentSystem: read.document.system, documentProcessor: read.document.processor });
  }
  return { raw, read };
}

/**
 * `pull_settlement`: fetch one range of a source's feed and import it (module header). Needs `post`, like
 * `import_settlement`, which it calls unchanged.
 */
export function pullSettlement(ctx: WorkspaceContext, input: PullSettlementInput): Result<PullSettlementOk> {
  const prepared = preparePull(ctx, input);
  if (isErr(prepared)) return prepared;
  const { source, from, to, more, trigger } = prepared;
  const scopedKey = JSON.stringify(['pull_settlement', source.source_system, source.source_processor, input.idempotencyKey]);
  const replay = ctx.store.recallIdempotent<Result<PullSettlementOk>>(ctx.workspaceId, scopedKey, 'pull_settlement');
  if (replay !== undefined) return replay;

  const fetchedDoc = fetchFeedDocument(ctx, source, from, to);
  if (isErr(fetchedDoc)) return fetchedDoc;
  const { raw, read } = fetchedDoc;

  const pullId = ctx.ids.next('stlpull');
  const doc = read.document;
  const logPull = (outcome: 'ok' | 'incomplete', counts: { seen: number; fresh: number; amended: number; report: ImportSettlementOk | null }): void => {
    ctx.store.db
      .prepare(
        `INSERT INTO settlement_pull (id, workspace_id, source_id, range_from, range_to, outcome, error_code, trigger_kind, events_seen, events_new, amended_seen,
           booked, already_imported, skipped, refused, actor, at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pullId,
        ctx.workspaceId,
        source.id,
        from,
        to,
        outcome,
        trigger,
        counts.seen,
        counts.fresh,
        counts.amended,
        counts.report?.booked ?? 0,
        counts.report?.alreadyImported ?? 0,
        counts.report?.skipped ?? 0,
        counts.report?.refused ?? 0,
        ctx.actor,
        ctx.clock.now(),
      );
  };

  // R3: an INCOMPLETE document is checked FIRST. Only its flags and payout links are kept (never an observed
  // row: no figure is frozen from it), the pull is logged `incomplete`, and nothing is imported.
  if ((raw as Record<string, unknown>)['complete'] === false) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'pull_settlement', () => {
      const rawEvents = rawFlagEventsOf(raw);
      recordFlags(ctx, source.source_system, source.source_processor, rawEvents);
      recordPayoutRefs(ctx, source.source_system, source.source_processor, rawEvents, pullId);
      logPull('incomplete', { seen: doc.events.length, fresh: 0, amended: 0, report: null });
      return ok<PullSettlementOk>({
        pullId,
        system: source.source_system,
        processor: source.source_processor,
        from,
        to,
        more,
        eventsSeen: doc.events.length,
        eventsNew: 0,
        amendedSeen: 0,
        complete: false,
        import: null,
      });
    });
  }

  // R1: the import decides about test events on both doors; the pull hands it the document UNCHANGED.
  // A42: the review's digest rides into the import, which refuses `review_stale` (rolling the pull back with it)
  // when what it would book differs from what the person reviewed.
  const importInput = {
    settlement: raw,
    idempotencyKey: `pull:${source.id}:${String(input.idempotencyKey)}`,
    ...(input.expectReviewSha256 !== undefined ? { expectReviewSha256: input.expectReviewSha256 } : {}),
  };
  // Critic r1 F8: a whole-file refusal of the import (no template, an unmapped kind, an invalid template) is
  // answered BEFORE anything is memoised, so the pull writes nothing and the same key works once it is fixed.
  const importRefusal = prevalidateImportSettlement(ctx, importInput);
  if (importRefusal !== undefined) return importRefusal as Result<PullSettlementOk>;

  try {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'pull_settlement', () => {
      // Which events are new to the observed record, and which come back with other figures: read from the
      // record BEFORE the import (its one writer) adds this document's first sightings.
      const seen = ctx.store.db.prepare(
        'SELECT kind, day, amount_minor, net_minor, vat_minor FROM settlement_feed_event WHERE workspace_id = ? AND source_system = ? AND source_processor = ? AND event_id = ?',
      );
      let fresh = 0;
      let amendedSeen = 0;
      for (const e of doc.events) {
        const before = seen.get(ctx.workspaceId, source.source_system, source.source_processor, e.id) as
          | { kind: string; day: string; amount_minor: number; net_minor: number; vat_minor: number | null }
          | undefined;
        if (before === undefined) fresh += 1;
        else if (before.kind !== e.kind || before.day !== e.day || before.amount_minor !== e.amountMinor || before.net_minor !== e.netMinor || before.vat_minor !== e.vatMinor) {
          amendedSeen += 1;
        }
      }
      // The import, unchanged, under a key derived from this pull's and held in this composite's own
      // idempotency scope (no public `import_settlement` call can squat it). Its per-event idempotency is what
      // makes a re-pull a no-op. All of it and the log row commit in this one transaction, or none of it does.
      const imported = ctx.store.innerWrite('pull_settlement', () => importSettlement(ctx, importInput, { pullId }));
      // R2: an INNER whole-file refusal (a template saved between the check above and here) throws, so the
      // memo rolls back with everything the import wrote; it is answered outside.
      if (!imported.ok) throw new PullAbort(imported as Err);
      const report = stripOk(imported as unknown as ImportSettlementOk & { ok: true });
      logPull('ok', { seen: doc.events.length, fresh, amended: amendedSeen, report });
      return ok<PullSettlementOk>({
        pullId,
        system: source.source_system,
        processor: source.source_processor,
        from,
        to,
        more,
        eventsSeen: doc.events.length,
        eventsNew: fresh,
        amendedSeen,
        complete: true,
        import: report,
      });
    });
  } catch (x) {
    if (x instanceof PullAbort) return x.refusal as Result<PullSettlementOk>;
    throw x;
  }
}

/** Thrown inside the pull's memo to roll it back and answer an inner refusal outside it. */
class PullAbort extends Error {
  constructor(readonly refusal: Err) {
    super(refusal.error);
  }
}

/** The refs of an event as an object, or null. */
export function refsOf(refsJson: string | null): Record<string, unknown> | null {
  if (refsJson === null) return null;
  try {
    const v = JSON.parse(refsJson) as unknown;
    return Object.prototype.toString.call(v) === '[object Object]' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stripOk(report: ImportSettlementOk & { ok?: unknown }): ImportSettlementOk {
  const { ok: _ok, ...rest } = report as ImportSettlementOk & { ok?: unknown };
  return rest as ImportSettlementOk;
}

/** D158: the pull's own validation with nothing fetched or written. */
export function prevalidatePullSettlement(ctx: WorkspaceContext, input: PullSettlementInput): Result | undefined {
  const prepared = preparePull(ctx, input);
  return isErr(prepared) ? prepared : undefined;
}

/**
 * The scheduler's record of a FAILED daily attempt (a refused pull writes nothing itself), so the last
 * result shows it. `actor` is who the attempt ran as, or `system` when nobody could.
 */
export function recordFailedPull(ctx: WorkspaceContext, sourceId: string, range: { from: string; to: string }, code: string, actor: string): void {
  ctx.store.db
    .prepare(
      `INSERT INTO settlement_pull (id, workspace_id, source_id, range_from, range_to, outcome, error_code, trigger_kind, actor, at)
       VALUES (?, ?, ?, ?, ?, 'failed', ?, 'daily', ?, ?)`,
    )
    .run(ctx.ids.next('stlpull'), ctx.workspaceId, sourceId, range.from, range.to, code.slice(0, 100), actor, ctx.clock.now());
}

/** How many daily attempts a source had on one Swiss day (success or failure). */
export function dailyAttemptsOn(ctx: WorkspaceContext, sourceId: string, day: string): { ok: boolean; attempts: number } {
  const rows = ctx.store.db
    .prepare("SELECT outcome, at FROM settlement_pull WHERE workspace_id = ? AND source_id = ? AND trigger_kind = 'daily'")
    .all(ctx.workspaceId, sourceId) as { outcome: string; at: string }[];
  const todays = rows.filter((r) => zurichParts(r.at).date === day);
  return { ok: todays.some((r) => r.outcome === 'ok'), attempts: todays.length };
}

/** The day a daily pull of this source covers: the watermark window up to today. */
export function dailyRangeOf(ctx: WorkspaceContext, source: { id: string; from_date: string }): { from: string; to: string } {
  const watermark = watermarkOf(ctx, source.id);
  const from = watermark === null ? source.from_date : addDays(watermark, 0 - pullOverlapDaysOf(ctx));
  return { from: from < source.from_date ? source.from_date : from, to: todayOf(ctx) };
}

export { todayOf as settlementTodayOf };
