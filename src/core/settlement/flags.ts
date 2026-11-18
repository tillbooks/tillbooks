/**
 * D198 re-cut R1: WHICH EVENTS ARE TEST EVENTS. The owner's answer of 12.11.2026: "be sure we don't record or
 * book test transactions as actual transactions".
 *
 * THE FACT. A producer marks every event of a test payment `refs.test: true` (decided per payment) and ties
 * the events of one transaction together by a TRANSACTION KEY: any of `refs.chargeId`, `refs.paymentIntentId`,
 * `refs.paymentId`, `refs.transferId` (`TRANSACTION_KEY_KINDS`). `import_settlement`, the one door for a pull
 * and for a file, writes what it saw into the append-only `settlement_feed_flag` (`recordFlags`), BEFORE its
 * per-event loop and in one transaction: one row per (event, key) and one keyless row per event, each with
 * the sighting's `test`, read from the RAW event (refs over the size cap are stored truncated, the flag is
 * not). A unique index over every column makes a repeated sighting add nothing and keeps a later `true`
 * beside an earlier `false`.
 *
 * THE RULE. An event is a TEST event when any flag row of its own id says `test`, or any flag row sharing one
 * of its key values (by value, any document of the same source) says `test`, unless the TEST TRACK of a
 * person says `not_test` for it (R6). Sticky otherwise: a later sighting never clears it.
 *
 * THE TEST TRACK (`settlement_test_resolution`, R6): for an event E, the LATEST row that names E, or whose key
 * values intersect E's, decides. A row's key values are the union of the values it stored and the values
 * observed for its named event NOW (paper critic r8 L7: a key the producer adds later is covered).
 * `not_test` clears; `reopen_test` returns E to its flags. The track never marks an event booked (D198
 * stateless check S5): there is no booking track.
 *
 * THE SETTINGS (D172, both human-only): `settlement.test_events` `skip` (default, and the fallback when the
 * setting cannot be read) | `book`; and `settlement.test_fees` `book` (default and fallback, the owner's
 * answer "Book as real fees") | `skip`: under `test_events = skip`, a test event of kind `processing_fee` or
 * `service_fee` is still booked like a non-test fee, so the clearing account follows the processor balance.
 *
 * §H-TENANT: every query names the workspace, the system and the processor.
 */

import type { WorkspaceContext } from '../context.js';
import { getSetting } from '../settings/index.js';

/** The refs keys that tie the events of one transaction together (the D198 contract). */
export const TRANSACTION_KEY_KINDS = ['chargeId', 'paymentIntentId', 'paymentId', 'transferId'] as const;
export type TransactionKeyKind = (typeof TRANSACTION_KEY_KINDS)[number];

/** The kinds `settlement.test_fees` books under `settlement.test_events = skip`. */
export const TEST_FEE_KINDS: ReadonlySet<string> = new Set(['processing_fee', 'service_fee']);

/** The kinds the import warns about when they carry no key: they cannot be tied to a test payment. */
export const KEYLESS_WARNED_KINDS: ReadonlySet<string> = new Set(['third_party_payout', 'third_party_payout_reversal', 'processing_fee']);

const KEY_MAX = 200;
const ID_MAX = 200;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Object.prototype.toString.call(v) === '[object Object]';
}

/** One raw event as the flag store reads it: its id (as the reader trims it), its kind, its keys and `test`. */
export interface RawFlagEvent {
  id: string;
  kind: string | null;
  keys: { kind: TransactionKeyKind; value: string }[];
  test: boolean;
  /** `refs.payoutId`, read raw (refs over the size cap are stored truncated). */
  payoutId: string | null;
}

/** The events of a raw document the flag store can read (an event without a usable id is skipped). */
export function rawFlagEventsOf(raw: unknown): RawFlagEvent[] {
  if (!isPlainObject(raw) || !Array.isArray(raw['events'])) return [];
  const out: RawFlagEvent[] = [];
  for (const e of raw['events'] as unknown[]) {
    if (!isPlainObject(e) || typeof e['id'] !== 'string') continue;
    const id = e['id'].trim();
    if (id.length === 0 || id.length > ID_MAX) continue;
    const refs = isPlainObject(e['refs']) ? e['refs'] : null;
    const keys: RawFlagEvent['keys'] = [];
    for (const kind of TRANSACTION_KEY_KINDS) {
      const v = refs?.[kind];
      if (typeof v === 'string' && v.trim().length > 0 && v.trim().length <= KEY_MAX) keys.push({ kind, value: v.trim() });
    }
    const payout = refs?.['payoutId'];
    out.push({
      id,
      kind: typeof e['kind'] === 'string' ? e['kind'] : null,
      keys,
      test: refs?.['test'] === true,
      payoutId: typeof payout === 'string' && payout.trim().length > 0 && payout.trim().length <= KEY_MAX ? payout.trim() : null,
    });
  }
  return out;
}

/**
 * Write the flags of every event of a document (module header). Runs inside the caller's transaction; a
 * sighting already recorded adds nothing (`INSERT OR IGNORE` on the all-column unique index).
 */
export function recordFlags(ctx: WorkspaceContext, system: string, processor: string, events: readonly RawFlagEvent[]): void {
  const insert = ctx.store.db.prepare(
    `INSERT OR IGNORE INTO settlement_feed_flag (id, workspace_id, source_system, source_processor, event_id, key_kind, key_value, test, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = ctx.clock.now();
  for (const e of events) {
    const test = e.test ? 1 : 0;
    insert.run(ctx.ids.next('stlflag'), ctx.workspaceId, system, processor, e.id, null, null, test, now);
    for (const k of e.keys) insert.run(ctx.ids.next('stlflag'), ctx.workspaceId, system, processor, e.id, k.kind, k.value, test, now);
  }
}

/**
 * Every `refs.payoutId` of a document's events, on EVERY sighting (critic r1 F5: a producer may add the link
 * on a later document, and the observed record is first-sighting only). `pullId` is null for a file import.
 */
export function recordPayoutRefs(ctx: WorkspaceContext, system: string, processor: string, events: readonly RawFlagEvent[], pullId: string | null): void {
  const link = ctx.store.db.prepare(
    `INSERT OR IGNORE INTO settlement_feed_payout_ref (id, workspace_id, source_system, source_processor, event_id, payout_ref, pull_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = ctx.clock.now();
  for (const e of events) if (e.payoutId !== null) link.run(ctx.ids.next('stlfpr'), ctx.workspaceId, system, processor, e.id, e.payoutId, pullId, now);
}

/** Every key value observed for one event, on any sighting. */
export function keyValuesOf(ctx: WorkspaceContext, system: string, processor: string, eventId: string): string[] {
  return (
    ctx.store.db
      .prepare(
        'SELECT DISTINCT key_value FROM settlement_feed_flag WHERE workspace_id = ? AND source_system = ? AND source_processor = ? AND event_id = ? AND key_value IS NOT NULL ORDER BY key_value',
      )
      .all(ctx.workspaceId, system, processor, eventId) as { key_value: string }[]
  ).map((r) => r.key_value);
}

/** By its FLAGS alone (no person's resolution): any own row, or any row sharing a key value, says test. */
export function flaggedTest(ctx: WorkspaceContext, system: string, processor: string, eventId: string): boolean {
  const row = ctx.store.db
    .prepare(
      `SELECT 1 AS t FROM settlement_feed_flag
        WHERE workspace_id = ? AND source_system = ? AND source_processor = ? AND test = 1
          AND (event_id = ? OR key_value IN (
                SELECT key_value FROM settlement_feed_flag
                 WHERE workspace_id = ? AND source_system = ? AND source_processor = ? AND event_id = ? AND key_value IS NOT NULL))
        LIMIT 1`,
    )
    .get(ctx.workspaceId, system, processor, eventId, ctx.workspaceId, system, processor, eventId) as { t: number } | undefined;
  return row !== undefined;
}

export interface TestResolutionRow {
  id: string;
  event_id: string;
  resolution: 'not_test' | 'reopen_test';
  key_values_json: string;
  reason: string;
  actor: string;
  at: string;
}

/** The test track of one source, newest first. */
export function testResolutionsOf(ctx: WorkspaceContext, system: string, processor: string): TestResolutionRow[] {
  return ctx.store.db
    .prepare(
      `SELECT id, event_id, resolution, key_values_json, reason, actor, at FROM settlement_test_resolution
        WHERE workspace_id = ? AND source_system = ? AND source_processor = ? ORDER BY rowid DESC`,
    )
    .all(ctx.workspaceId, system, processor) as TestResolutionRow[];
}

function storedKeys(row: TestResolutionRow): string[] {
  try {
    const v = JSON.parse(row.key_values_json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The test-track row that decides for an event (the newest naming it or sharing a key value with it), given
 * the event's key values and a reader of the CURRENT key values of a named event. Null when none applies.
 */
export function decidingTestResolution(
  rows: readonly TestResolutionRow[],
  eventId: string,
  eventKeys: readonly string[],
  keysOfNamed: (namedEventId: string) => readonly string[],
): TestResolutionRow | null {
  const mine = new Set(eventKeys);
  for (const row of rows) {
    if (row.event_id === eventId) return row;
    if (mine.size === 0) continue;
    const theirs = new Set([...storedKeys(row), ...keysOfNamed(row.event_id)]);
    for (const k of theirs) if (mine.has(k)) return row;
  }
  return null;
}

/** R1: is this event a TEST event (its flags, unless a person's latest test-track row says `not_test`). */
export function isTestEvent(ctx: WorkspaceContext, system: string, processor: string, eventId: string): boolean {
  if (!flaggedTest(ctx, system, processor, eventId)) return false;
  const rows = testResolutionsOf(ctx, system, processor);
  if (rows.length === 0) return true;
  const deciding = decidingTestResolution(rows, eventId, keyValuesOf(ctx, system, processor, eventId), (named) => keyValuesOf(ctx, system, processor, named));
  return deciding === null || deciding.resolution !== 'not_test';
}

/** `settlement.test_events`: `skip` (the default) unless the setting reads `book`; `skip` when unreadable. */
export function testEventsModeOf(ctx: WorkspaceContext): 'skip' | 'book' {
  try {
    return getSetting<string>(ctx, 'settlement.test_events') === 'book' ? 'book' : 'skip';
  } catch {
    return 'skip';
  }
}

/** `settlement.test_fees`: `book` (the default, the owner's answer) unless the setting reads `skip`; `book` when unreadable. */
export function testFeesModeOf(ctx: WorkspaceContext): 'book' | 'skip' {
  try {
    return getSetting<string>(ctx, 'settlement.test_fees') === 'skip' ? 'skip' : 'book';
  } catch {
    return 'book';
  }
}

/**
 * Does the import leave a test event off the books, for these modes: every test event under `skip`, except a
 * processor fee while `test_fees` is `book`. (The caller decides first whether the event IS a test event.)
 */
export function testSkips(kind: string, modes: { events: 'skip' | 'book'; fees: 'book' | 'skip' }): boolean {
  if (modes.events === 'book') return false;
  if (TEST_FEE_KINDS.has(kind) && modes.fees === 'book') return false;
  return true;
}

/**
 * A preloaded reader of one source's test status, for a read that walks many events (the pre-filing check).
 * The same rule as `isTestEvent`, from one read of the flags and the test track.
 */
export interface TestIndex {
  isTest(eventId: string): boolean;
  keysOf(eventId: string): readonly string[];
}

export function loadTestIndex(ctx: WorkspaceContext, system: string, processor: string): TestIndex {
  const rows = ctx.store.db
    .prepare('SELECT event_id, key_value, test FROM settlement_feed_flag WHERE workspace_id = ? AND source_system = ? AND source_processor = ?')
    .all(ctx.workspaceId, system, processor) as { event_id: string; key_value: string | null; test: number }[];
  const keys = new Map<string, Set<string>>();
  const ownTest = new Set<string>();
  const testValues = new Set<string>();
  for (const r of rows) {
    if (r.key_value !== null) {
      const s = keys.get(r.event_id) ?? new Set<string>();
      s.add(r.key_value);
      keys.set(r.event_id, s);
    }
    if (r.test === 1) {
      ownTest.add(r.event_id);
      if (r.key_value !== null) testValues.add(r.key_value);
    }
  }
  const resolutions = testResolutionsOf(ctx, system, processor);
  const keysOf = (id: string): readonly string[] => [...(keys.get(id) ?? [])];
  return {
    keysOf,
    isTest(eventId: string): boolean {
      const flagged = ownTest.has(eventId) || keysOf(eventId).some((k) => testValues.has(k));
      if (!flagged) return false;
      const deciding = decidingTestResolution(resolutions, eventId, keysOf(eventId), keysOf);
      return deciding === null || deciding.resolution !== 'not_test';
    },
  };
}
