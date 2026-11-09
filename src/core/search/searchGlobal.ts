/**
 * G07, `searchGlobal`: one query, fanned out across every searchable kind (P1, P5).
 *
 * A PURE READ MODEL. Every call re-queries the live tables at call time: there is no index to
 * rebuild, no cache to go stale, and no reindex step to forget, which is why a custom field is
 * findable on the very next call after `set_field_value` (US-G07.2). It writes not one row, and
 * the conformance harness holds that with a whole-database snapshot.
 *
 * RBAC IS PER KIND, NEVER A TOP-LEVEL GATE (US-G07.5, the F00 dashboards posture). Each kind is
 * fenced by its own registry `readCapability` through `ctx.capabilities`; a refused kind
 * contributes zero rows and no signal (no count, no placeholder), so search can never disclose the
 * existence of a record the caller could not open. An actor holding no read domain at all gets a
 * plain `{ok:true, results:[]}`, indistinguishable from "nothing matches".
 *
 * RANKING IS DETERMINISTIC AND UNSCORED (data honesty): exact title match, then title prefix, then
 * title contains (which also covers matches on a non-title column such as an email or a note),
 * then custom-field-only, ties broken by `created_at` DESC then id. No numeric relevance figure is
 * computed, so none can be misread as one.
 *
 * ONE ADAPTER FAILING NEVER FAILS THE SEARCH (P9): the kind is dropped and named in `failedKinds`,
 * so the GUI renders its honest partial-failure notice while every other group still answers.
 */

import type { WorkspaceContext } from '../context.js';
import { applySavedView } from '../customization/views.js';
import { err, ok, type Result } from '../result.js';
import {
  SEARCHABLE_ENTITY_KINDS,
  SEARCHABLE_KIND_IDS,
  searchableKindDef,
  type SearchableKindDef,
} from './registry.js';

/** Below this the palette shows a hint and the verb refuses: one character matches everything. */
export const SEARCH_MIN_QUERY_LENGTH = 2;

/** The default and maximum page sizes over the ranked, merged list. */
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;

/** The custom-field types that free-text match. `money|date|bool|contact_ref|entity_ref` never do
 *  (a Rappen integer or a ULID has no meaningful substring), asserted by test so a future type
 *  never silently starts matching raw internal values (US-G07.2 boundary). */
export const SEARCHED_FIELD_TYPES: readonly string[] = ['text', 'select', 'multiselect'];

export interface SearchGlobalInput {
  /** Required unless a savedViewId supplies it: below 2 characters the verb refuses. */
  q?: string;
  entityKinds?: string[];
  limit?: number;
  cursor?: string;
  /** A saved global search (G00, `entityKind:'global_search'`): its stored `{q, entityKinds}` merge
   *  UNDER the explicit fields, so a value named in the request always wins (US-G07.4). */
  savedViewId?: string;
}

export interface SearchResultRow {
  entityKind: string;
  entityId: string;
  title: string;
  snippet?: string;
  matchedVia: 'field' | 'custom_field';
  route: string;
}

interface Candidate extends SearchResultRow {
  rank: number;
  createdAt: string;
}

/** Escape LIKE metacharacters so a literal `%`/`_` in the query stays literal. */
function likePattern(q: string): string {
  return `%${q.replace(/([\\%_])/g, '\\$1')}%`;
}

/** The rank of a FIELD match, judged against the title the person will see. */
function fieldRank(title: string, q: string): number {
  const t = title.toLowerCase();
  const needle = q.toLowerCase();
  if (t === needle) return 0;
  if (t.startsWith(needle)) return 1;
  return 2;
}

const CUSTOM_FIELD_RANK = 3;

/** One kind's adapter: a single tenant-scoped SELECT off the registry row's declared facts. */
function adapterRows(
  ctx: WorkspaceContext,
  def: SearchableKindDef,
  pattern: string,
): { id: string; title: string | null; created_at: string }[] {
  const match = def.matchColumns.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ');
  const extra = def.extraWhere === undefined ? '' : ` AND (${def.extraWhere})`;
  const sql =
    `SELECT id, ${def.titleSql} AS title, created_at ` +
    `FROM ${def.table} WHERE workspace_id = ? AND (${match})${extra} ` +
    `ORDER BY created_at DESC, id LIMIT 200`;
  const args = [ctx.workspaceId, ...def.matchColumns.map(() => pattern)];
  return ctx.store.db.prepare(sql).all(...args) as { id: string; title: string | null; created_at: string }[];
}

/** Resolve a custom-field-only candidate's title through its kind's own base row (registry facts). */
function resolveTitle(
  ctx: WorkspaceContext,
  def: SearchableKindDef,
  entityId: string,
): { title: string | null; created_at: string } | undefined {
  const extra = def.extraWhere === undefined ? '' : ` AND (${def.extraWhere})`;
  const sql =
    `SELECT ${def.titleSql} AS title, created_at FROM ${def.table} ` +
    `WHERE workspace_id = ? AND id = ?${extra}`;
  return ctx.store.db.prepare(sql).get(ctx.workspaceId, entityId) as
    | { title: string | null; created_at: string }
    | undefined;
}

/** A decoded custom-field value's searchable strings: the value for text/select, the members for multiselect. */
function decodedStrings(valueJson: string): string[] {
  try {
    const value: unknown = JSON.parse(valueJson);
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
    return [];
  } catch {
    return [];
  }
}

/** The label a snippet renders: the def's de-CH label, then en, then the stable key. */
function fieldLabel(labelI18nJson: string, key: string): string {
  try {
    const labels: unknown = JSON.parse(labelI18nJson);
    if (labels !== null && typeof labels === 'object') {
      const map = labels as Record<string, unknown>;
      const deCh = map['de-CH'];
      if (typeof deCh === 'string') return deCh;
      const en = map['en'];
      if (typeof en === 'string') return en;
    }
  } catch {
    // fall through to the key
  }
  return key;
}

/**
 * The verb. `(ctx, input) -> Result`, returns its rejections (P9), scopes every query to
 * `ctx.workspaceId` (§H-TENANT), and never writes.
 */
export function searchGlobal(ctx: WorkspaceContext, input: SearchGlobalInput): Result {
  // The G00 seam, one unconditional call, exactly as `listAccounts` makes it: a saved search is
  // stored filters re-RUN live (P5), never a cached result set.
  const viewed = applySavedView(ctx, 'global_search', input);
  if (!viewed.ok) return viewed;
  input = viewed.filter;

  const q = typeof input.q === 'string' ? input.q.trim() : '';
  if (q.length < SEARCH_MIN_QUERY_LENGTH) {
    return err('query_too_short', { minLength: SEARCH_MIN_QUERY_LENGTH });
  }

  let requested: readonly SearchableKindDef[];
  if (input.entityKinds === undefined) {
    requested = SEARCHABLE_ENTITY_KINDS;
  } else {
    const defs: SearchableKindDef[] = [];
    for (const kind of input.entityKinds) {
      const def = searchableKindDef(kind);
      if (def === undefined) {
        return err('unknown_entity_kind', { entityKind: kind, known: [...SEARCHABLE_KIND_IDS] });
      }
      defs.push(def);
    }
    requested = defs;
  }

  const rawLimit = typeof input.limit === 'number' ? Math.floor(input.limit) : SEARCH_DEFAULT_LIMIT;
  if (rawLimit < 1) return err('invalid_limit', { limit: input.limit, max: SEARCH_MAX_LIMIT });
  const limit = Math.min(rawLimit, SEARCH_MAX_LIMIT);

  let offset = 0;
  if (input.cursor !== undefined) {
    offset = Number.parseInt(input.cursor, 10);
    if (Number.isNaN(offset) || offset < 0) return err('invalid_cursor', { cursor: input.cursor });
  }

  // The per-kind RBAC fence (US-G07.5): a kind the actor cannot read is dropped SILENTLY, before
  // any query touches its table. This is the only capability check in the verb, deliberately: a
  // top-level gate could not state a nine-domain rule without lying in one direction or the other.
  const readable = requested.filter((def) => ctx.capabilities.assert(def.readCapability).ok);

  const pattern = likePattern(q);
  const byKey = new Map<string, Candidate>();
  const failedKinds: string[] = [];

  for (const def of readable) {
    try {
      for (const row of adapterRows(ctx, def, pattern)) {
        const title = row.title ?? '';
        byKey.set(`${def.kind}:${row.id}`, {
          entityKind: def.kind,
          entityId: row.id,
          title,
          matchedVia: 'field',
          route: def.route,
          rank: fieldRank(title, q),
          createdAt: row.created_at,
        });
      }
    } catch {
      // P9: one adapter failing must not fail the whole search. Named, never silent.
      failedKinds.push(def.kind);
    }
  }

  // The OP7 branch (US-G07.2): live custom-field values, joined to their LIVE defs (not draft, not
  // archived), free-text types only. The SQL LIKE over the JSON-encoded value is a prefilter; the
  // decoded value is re-checked in JS so a match on JSON punctuation never surfaces.
  const readableKinds = new Set(readable.map((d) => d.kind));
  if (readableKinds.size > 0) {
    const placeholders = [...readableKinds].map(() => '?').join(', ');
    const needle = q.toLowerCase();
    try {
      const valueRows = ctx.store.db
        .prepare(
          `SELECT v.entity_kind, v.entity_id, v.value, d.key, d.label_i18n
             FROM custom_field_value v
             JOIN custom_field_def d ON d.id = v.field_def_id
            WHERE v.workspace_id = ?
              AND d.workspace_id = ?
              AND d.archived = 0 AND d.draft = 0
              AND d.type IN (${SEARCHED_FIELD_TYPES.map(() => '?').join(', ')})
              AND v.entity_kind IN (${placeholders})
              AND v.value LIKE ? ESCAPE '\\'
            LIMIT 400`,
        )
        .all(
          ctx.workspaceId,
          ctx.workspaceId,
          ...SEARCHED_FIELD_TYPES,
          ...readableKinds,
          pattern,
        ) as { entity_kind: string; entity_id: string; value: string; key: string; label_i18n: string }[];

      for (const row of valueRows) {
        const matched = decodedStrings(row.value).find((s) => s.toLowerCase().includes(needle));
        if (matched === undefined) continue;
        const key = `${row.entity_kind}:${row.entity_id}`;
        const existing = byKey.get(key);
        const snippet = `${fieldLabel(row.label_i18n, row.key)}: ${matched}`;
        if (existing !== undefined) {
          // Already a field match: keep its rank, add the richer snippet if it has none.
          if (existing.snippet === undefined) existing.snippet = snippet;
          continue;
        }
        const def = searchableKindDef(row.entity_kind);
        if (def === undefined) continue;
        const base = resolveTitle(ctx, def, row.entity_id);
        // A value whose base row is gone, archived away or merged resolves to nothing: dropped.
        if (base === undefined) continue;
        byKey.set(key, {
          entityKind: def.kind,
          entityId: row.entity_id,
          title: base.title ?? '',
          snippet,
          matchedVia: 'custom_field',
          route: def.route,
          rank: CUSTOM_FIELD_RANK,
          createdAt: base.created_at,
        });
      }
    } catch {
      failedKinds.push('custom_field');
    }
  }

  const ranked = [...byKey.values()].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    if (a.entityKind !== b.entityKind) return a.entityKind < b.entityKind ? -1 : 1;
    return a.entityId < b.entityId ? -1 : 1;
  });

  const page = ranked.slice(offset, offset + limit).map((c): SearchResultRow => {
    const row: SearchResultRow = {
      entityKind: c.entityKind,
      entityId: c.entityId,
      title: c.title,
      matchedVia: c.matchedVia,
      route: c.route,
    };
    if (c.snippet !== undefined) row.snippet = c.snippet;
    return row;
  });

  const hasMore = offset + limit < ranked.length;
  return ok({
    q,
    results: page,
    total: ranked.length,
    hasMore,
    ...(hasMore ? { nextCursor: String(offset + limit) } : {}),
    failedKinds,
  });
}
