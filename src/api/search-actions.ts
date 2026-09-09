/**
 * G07's one verb: `search_global`, the cross-entity read over every searchable kind.
 *
 * `kind: 'read'`, so it carries `readOnlyHint` on MCP and no `idempotencyKey` (a read needs none,
 * P5). It owns no table and posts nothing: the engine fans a tenant-scoped query out across the
 * declarative `SEARCHABLE_ENTITY_KINDS` roster plus the G00 custom-field values at call time, and
 * `test/search/search-global.test.mjs` asserts it writes not one row.
 *
 * THE A24 POSTURE IS PER RESULT, NOT PER VERB (US-G07.5, the F00 `dashboard_overview` shape): the
 * boundary declares `ungated('asserted_in_engine', ...)` and the engine fences each kind by that
 * kind's own read capability, silently omitting what the caller could not open. A caller holding
 * zero read domains gets `{ok:true, results:[]}`, indistinguishable from "nothing matches".
 *
 * Defined here rather than inline in `registry.ts` for the reason every sibling module states: the
 * registry is the one append-only tool list and several agents append to it at once, so the smaller
 * the hunk the cheaper the merge. The helpers arrive as a parameter to keep the module graph acyclic.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { searchGlobal, SEARCH_MIN_QUERY_LENGTH, SEARCH_MAX_LIMIT } from '../core/search/index.js';

export interface SearchActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The G07 verb, spread into `ACTIONS` as one line. */
export function searchActions(h: SearchActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT } = h;
  const STR_LIST = { type: 'array', items: STR } as const;

  return [
    ctxAction(
      'search_global',
      'read',
      `Die globale Suche (global search): one query across every searchable record kind at once (Kontakte, Artikel, Belege, Projekte, Deals, Aufgaben, Lieferantenrechnungen, Aufträge, Bestellungen), including workspace-defined custom fields of type text/select/multiselect, findable the moment a value is set (no reindex exists). Results are grouped hits {entityKind, entityId, title, snippet?, matchedVia, route}, ranked exact > prefix > contains > custom-field-only (no relevance score is invented), deduped, paged by limit/cursor with hasMore/nextCursor. Every kind is fenced by that kind's own read capability: a kind the caller cannot read is silently absent, never counted, never hinted at, so an empty result set is indistinguishable from "no such record". q under ${SEARCH_MIN_QUERY_LENGTH} characters answers query_too_short; an entityKinds value outside the searchable roster answers unknown_entity_kind naming the roster; limit is capped at ${SEARCH_MAX_LIMIT}; savedViewId re-runs a saved global search (its stored q/entityKinds merge under any explicitly named field), so either q or savedViewId must be present. Reads only the local database and never local correspondence (mail, voice, drafts): those kinds are structurally absent from the roster. A pure read: writes nothing, needs no idempotencyKey.`,
      ctxSchema({ q: STR, entityKinds: STR_LIST, limit: INT, cursor: STR, savedViewId: STR }, []),
      (ctx, input) => searchGlobal(ctx, as(input)),
    ),
  ];
}
