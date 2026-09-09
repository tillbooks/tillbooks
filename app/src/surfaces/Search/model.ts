/**
 * G07's Studio-side kind metadata.
 *
 * MIRRORED, NOT INVENTED: `SEARCHABLE_KIND_IDS` restates `SEARCHABLE_KIND_IDS` in
 * `src/core/search/registry.ts`, and `test/style/studio-mirrors-engine-enums.test.mjs` holds the
 * two equal as sets, so a kind added to the engine roster reddens the gate until this file and the
 * display map below learn it. The browser deliberately does not import engine code (better-sqlite3
 * is native and Node-only), which is why the mirror exists at all.
 *
 * `readCapability` is the COURTESY half of US-G07.3's rights-filtered scope chips: the engine is
 * the enforcement (a refused kind is silently absent from results), this map only keeps a chip the
 * actor cannot use off the screen. The values restate each kind's registry row.
 *
 * `icon` reuses each kind's OWN rail glyph (spec §6: never a bespoke G07 icon set). The two kinds
 * whose surfaces share a glyph (sales orders ride `documents`, purchase orders ride `bills` in the
 * rail) reuse exactly those shared glyphs here too.
 */
import type { NavIconName } from '../../app/nav';

export const SEARCHABLE_KIND_IDS = [
  'contact',
  'item',
  'document',
  'project',
  'deal',
  'task',
  'vendor_bill',
  'sales_order',
  'po',
] as const;

export type SearchableKind = (typeof SEARCHABLE_KIND_IDS)[number];

export interface KindDisplay {
  labelKey: string;
  icon: NavIconName;
  readCapability: string;
}

export const KIND_DISPLAY: Record<SearchableKind, KindDisplay> = {
  contact: { labelKey: 'search.kind.contact', icon: 'contacts', readCapability: 'read_master_data' },
  item: { labelKey: 'search.kind.item', icon: 'items', readCapability: 'read_master_data' },
  document: { labelKey: 'search.kind.document', icon: 'documents', readCapability: 'read_sales' },
  project: { labelKey: 'search.kind.project', icon: 'projects', readCapability: 'read_master_data' },
  deal: { labelKey: 'search.kind.deal', icon: 'deals', readCapability: 'deals.read' },
  task: { labelKey: 'search.kind.task', icon: 'tasks', readCapability: 'tasks.read' },
  vendor_bill: { labelKey: 'search.kind.vendor_bill', icon: 'bills', readCapability: 'read_books' },
  sales_order: { labelKey: 'search.kind.sales_order', icon: 'documents', readCapability: 'read_sales' },
  po: { labelKey: 'search.kind.po', icon: 'bills', readCapability: 'read_master_data' },
};

/** One result row, as `search_global` answers it. Parsed defensively at the read site. */
export interface SearchHit {
  entityKind: SearchableKind;
  entityId: string;
  title: string;
  snippet?: string;
  matchedVia: 'field' | 'custom_field';
  route: string;
}

/** Narrow an unknown payload row to a hit this surface can render. */
export function parseHit(row: unknown): SearchHit | null {
  const r = row as Record<string, unknown> | null;
  if (r === null || typeof r !== 'object') return null;
  if (typeof r.entityId !== 'string' || typeof r.title !== 'string' || typeof r.route !== 'string') return null;
  const kind = r.entityKind;
  if (typeof kind !== 'string' || !(SEARCHABLE_KIND_IDS as readonly string[]).includes(kind)) return null;
  const hit: SearchHit = {
    entityKind: kind as SearchableKind,
    entityId: r.entityId,
    title: r.title,
    matchedVia: r.matchedVia === 'custom_field' ? 'custom_field' : 'field',
    route: r.route,
  };
  if (typeof r.snippet === 'string') hit.snippet = r.snippet;
  return hit;
}

export interface SearchModel {
  hits: SearchHit[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  failedKinds: string[];
}

/** Read a `search_global` success defensively: a shape this surface cannot read is a failed READ. */
export function parseSearch(body: unknown): SearchModel | null {
  const b = body as Record<string, unknown> | null;
  if (b === null || typeof b !== 'object' || !Array.isArray(b.results)) return null;
  return {
    hits: (b.results as unknown[]).map(parseHit).filter((h): h is SearchHit => h !== null),
    total: typeof b.total === 'number' ? b.total : 0,
    hasMore: b.hasMore === true,
    nextCursor: typeof b.nextCursor === 'string' ? b.nextCursor : null,
    failedKinds: Array.isArray(b.failedKinds) ? (b.failedKinds as unknown[]).filter((k): k is string => typeof k === 'string') : [],
  };
}

/** A saved global search, as G00's `list_saved_views` answers it (filters carry q + entityKinds). */
export interface SavedSearch {
  viewId: string;
  name: string;
  q: string;
  entityKinds: SearchableKind[];
}

export function parseSavedSearches(body: unknown): SavedSearch[] {
  const views = (body as { savedViews?: unknown } | null)?.savedViews;
  if (!Array.isArray(views)) return [];
  const out: SavedSearch[] = [];
  for (const view of views as Record<string, unknown>[]) {
    if (view === null || typeof view !== 'object') continue;
    if (typeof view.viewId !== 'string' || typeof view.name !== 'string') continue;
    const filters = (view.filters ?? {}) as Record<string, unknown>;
    const q = typeof filters.q === 'string' ? filters.q : '';
    if (q.length === 0) continue;
    const kinds = Array.isArray(filters.entityKinds)
      ? (filters.entityKinds as unknown[]).filter(
          (k): k is SearchableKind => typeof k === 'string' && (SEARCHABLE_KIND_IDS as readonly string[]).includes(k),
        )
      : [];
    out.push({ viewId: view.viewId, name: view.name, q, entityKinds: kinds });
  }
  return out;
}
