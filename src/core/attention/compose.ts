/**
 * G15's two read verbs and the registry guards behind them (Pattern P1 + P5).
 *
 * `attention_summary` paints the whole first screen from one call: the per-queue counts AND the same
 * `top[]` rows the screen leads with. `attention_list` pages one queue or one area. Both are pure
 * reads over the providers; both compose OTHER modules' existing reads and open no second read of the
 * ledger they do not own.
 *
 * THE PERMISSION ANSWER IS THE UNION OF THE PROVIDERS' (design §6a): a queue whose `readCapability`
 * the actor lacks contributes nothing to either payload, and an actor holding none of them gets
 * `{ visibleQueues: 0, total: null, queues: [], top: [] }`, which the Studio renders as the padlock
 * and never as "Alles erledigt". §H-TENANT holds because every provider read is workspace-scoped and
 * the capability check runs against the ctx actor.
 *
 * `failed` IS NOT AN ERROR (design §6a): one provider throwing does not fail the call. The verb
 * returns what it could read, names what it could not, and sets `incomplete`, so the hub is never
 * less reliable than the ten screens it replaces.
 */

import type { WorkspaceContext } from '../context.js';
import { err, ok } from '../result.js';
import type { Result } from '../result.js';
import { CAPABILITIES } from '../access/capabilities.js';
import { getSetting } from '../settings/index.js';
import type {
  AttentionGrouping,
  AttentionItem,
  AttentionKind,
  AttentionQueueSummary,
  AttentionSection,
  AttentionUrgency,
  QueueProvider,
} from './types.js';
import { ATTENTION_AREA_ORDER, ATTENTION_GROUPINGS, ATTENTION_KINDS, ATTENTION_LIST_CAP, URGENCY_RANK } from './types.js';
import { ATTENTION_PROVIDERS, ROUTED_SURFACES } from './providers.js';

/** The `attention_list` page size when the caller names none. */
const LIST_PAGE_SIZE = 20;

/** D178: the page size of ONE section of the grouped list when the caller names none. */
export const SECTION_PAGE_SIZE = 25;

/** D178: the workspace setting that says how Pendenzen batches bank approvals (D172 registry). */
export const APPROVAL_BATCH_MODE_SETTING = 'attention.approval_batch_mode';

/**
 * D178: the entity kind of the one remainder row a queue gets when its list yields fewer units than its
 * true COUNT. Hoisted (the audit-vocabulary scraper must not read the hub as an audit emitter).
 */
export const REMAINDER_ENTITY_KIND = 'attention_remainder';

/** Every capability id the registry knows, for the registration guard. */
const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(CAPABILITIES.map((c) => c.id));

/**
 * A queue that is SHOWN is a queue that is REAL (design §6b). Refuses at load a provider whose read
 * capability does not resolve (a section gated on a name nobody enforces is not gated) or whose deep
 * link is not routed (which designs the row 2.3 dead end out of existence). Called from `index.ts` at
 * module load, so a bad provider is a crash on import with the queue named, not a Placeholder in
 * production.
 */
export function assertProvidersRegistrable(
  providers: readonly QueueProvider[],
  routed: ReadonlySet<string> = ROUTED_SURFACES,
  known: ReadonlySet<string> = KNOWN_CAPABILITIES,
): void {
  const problems: string[] = [];
  for (const p of providers) {
    if (!known.has(p.readCapability)) {
      problems.push(`${p.queueId} names read capability '${p.readCapability}', which does not resolve in capabilities.ts`);
    }
    if (!routed.has(p.deepLinkRoute)) {
      problems.push(`${p.queueId} deep-links to '${p.deepLinkRoute}', which is not a routed surface`);
    }
    // D178 point 11: every registered queue says what it asks of the person (`withKind` at the
    // registration line for a module the hub does not own).
    if (p.kind === undefined || !(ATTENTION_KINDS as readonly string[]).includes(p.kind)) {
      problems.push(`${p.queueId} declares no kind (approve | do | note)`);
    }
  }
  const ids = providers.map((p) => p.queueId);
  const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (twice.length > 0) problems.push(`these queue ids register twice: ${[...new Set(twice)].join(', ')}`);
  if (problems.length > 0) {
    throw new Error(`G15: these attention providers cannot register: ${problems.join('; ')}.`);
  }
}

/** The providers the actor may READ. A denied queue contributes nothing to either face (§6c). */
function visibleProviders(ctx: WorkspaceContext, providers: readonly QueueProvider[]): QueueProvider[] {
  return providers.filter((p) => ctx.capabilities.assert(p.readCapability).ok);
}

/** Rank map by queueId, so an item can be ordered by its provider's declared rank. */
function rankOf(providers: readonly QueueProvider[]): Map<string, number> {
  return new Map(providers.map((p) => [p.queueId, p.rank]));
}

/**
 * Rank ACROSS queues only: declared urgency, then a fixed queue rank, then `since` (design §5c
 * guarantee 5). The hub never reorders WITHIN a queue, so the provider's own order is the final
 * tie-break, preserved because the sort is stable and the input arrives in provider order.
 */
function rankItems(items: AttentionItem[], rank: Map<string, number>): AttentionItem[] {
  return [...items].sort((a, b) => {
    const u = URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency];
    if (u !== 0) return u;
    const r = (rank.get(a.queueId) ?? 0) - (rank.get(b.queueId) ?? 0);
    if (r !== 0) return r;
    return a.since < b.since ? -1 : a.since > b.since ? 1 : 0;
  });
}

/**
 * One entity, one row (design §5c guarantee 11). Items sharing `entityKind`+`entityId` collapse to
 * the highest-ranked queue's row (the LOWER rank number), with the other queue named on the survivor.
 * Each queue's own count is untouched: this only affects the rendered list, never the totals. The
 * input MUST already be ranked, so the first occurrence of a key is the survivor.
 */
function collapseSameEntity(rankedItems: AttentionItem[], rank: Map<string, number>): AttentionItem[] {
  const byKey = new Map<string, AttentionItem>();
  const out: AttentionItem[] = [];
  for (const item of rankedItems) {
    const key = `${item.entityKind}::${item.entityId}`;
    const seen = byKey.get(key);
    if (seen === undefined) {
      byKey.set(key, item);
      out.push(item);
      continue;
    }
    // The survivor is the higher-ranked (lower rank number) queue; ranking already placed it first,
    // so `seen` wins. Name the collapsed queue on it, once.
    if (seen.collapsedWithQueueId === undefined && seen.queueId !== item.queueId) {
      const idx = out.indexOf(seen);
      const named: AttentionItem = { ...seen, collapsedWithQueueId: item.queueId };
      out[idx] = named;
      byKey.set(key, named);
    }
  }
  // `rank` is accepted for symmetry with the ordering contract even though the pre-sort makes it
  // unnecessary here; referencing it keeps the invariant legible and satisfies the lint.
  void rank;
  return out;
}

/** The max urgency present in a set of items, or `open` when there are none. */
function topUrgencyOf(items: AttentionItem[]): AttentionUrgency {
  let best: AttentionUrgency = 'open';
  for (const item of items) {
    if (URGENCY_RANK[item.urgency] > URGENCY_RANK[best]) best = item.urgency;
  }
  return best;
}

interface ProviderRead {
  provider: QueueProvider;
  count: number;
  items: AttentionItem[];
}

/** Read every visible provider, isolating a thrown provider into `failed` (design §6a). */
function readProviders(
  ctx: WorkspaceContext,
  providers: QueueProvider[],
  limit: number,
): { reads: ProviderRead[]; failed: string[] } {
  const reads: ProviderRead[] = [];
  const failed: string[] = [];
  for (const provider of providers) {
    try {
      const count = provider.count(ctx);
      const items = provider.list(ctx, { limit });
      reads.push({ provider, count, items });
    } catch {
      failed.push(provider.queueId);
    }
  }
  return { reads, failed };
}

export interface AttentionSummaryInput {
  topLimit?: number;
}

/**
 * `attention_summary`: the whole first screen in one call. Returns per-queue counts plus the ranked,
 * collapsed `top[]`. `total` is the sum of `queues[].count` and is `null`, never `0`, when the actor
 * may read no queue (an actor told nothing must not be told a total of zero, §6a guarantee 4).
 */
export function attentionSummary(
  ctx: WorkspaceContext,
  input: AttentionSummaryInput = {},
  providers: readonly QueueProvider[] = ATTENTION_PROVIDERS,
): Result {
  const topLimit =
    typeof input.topLimit === 'number' && input.topLimit > 0 ? Math.floor(input.topLimit) : ATTENTION_LIST_CAP;
  const computedAt = ctx.clock.now();
  const visible = visibleProviders(ctx, providers);

  // An actor holding no read capability of any provider: the padlock case. `total` is null, not 0.
  if (visible.length === 0) {
    return ok({ computedAt, visibleQueues: 0, total: null, incomplete: false, queues: [], top: [], failed: [] });
  }

  const rank = rankOf(providers);
  const { reads, failed } = readProviders(ctx, visible, topLimit);

  // A queue with zero pending items has no row (guarantee 4); a failed queue is not here at all (it
  // is in `failed`). The total sums only what actually answered.
  const queues: AttentionQueueSummary[] = reads
    .filter((r) => r.count > 0)
    .map((r) => ({
      queueId: r.provider.queueId,
      labelKey: r.provider.labelKey,
      area: r.provider.area,
      ...(r.provider.kind !== undefined ? { kind: r.provider.kind } : {}),
      count: r.count,
      topUrgency: topUrgencyOf(r.items),
    }));
  const total = queues.reduce((sum, q) => sum + q.count, 0);

  const allItems = reads.flatMap((r) => r.items);
  const top = collapseSameEntity(rankItems(allItems, rank), rank).slice(0, topLimit);

  return ok({
    computedAt,
    visibleQueues: visible.length,
    total,
    incomplete: failed.length > 0,
    queues,
    top,
    failed,
  });
}

export interface AttentionListInput {
  queueId?: string;
  area?: string;
  urgency?: string;
  limit?: number;
  cursor?: string;
  /** D178: cut the WHOLE list into sections (`by_area` | `by_kind`); absent keeps the flat page. */
  grouping?: string;
  /** D178, with `grouping`: answer this one section from `cursor`. */
  section?: string;
}

// --- D178 point 11, the grouped list -----------------------------------------------------------------

/** How many units a row stands for: its declared `count`, else 1. */
export function unitsOf(item: Pick<AttentionItem, 'count'>): number {
  return typeof item.count === 'number' && Number.isInteger(item.count) && item.count > 0 ? item.count : 1;
}

/** A queue's kind. The registration guard holds every REGISTERED queue to one; a test fake may have none. */
function kindOf(p: QueueProvider): AttentionKind {
  return p.kind ?? 'note';
}

/** The order of an area among the sections: the fixed order first, any other area after it. */
function areaIndex(area: string | undefined, extra: readonly string[]): number {
  const fixed = ATTENTION_AREA_ORDER.indexOf(area ?? '');
  if (fixed >= 0) return fixed;
  const later = extra.indexOf(area ?? '');
  return ATTENTION_AREA_ORDER.length + (later >= 0 ? later : extra.length);
}

/**
 * One entity, one row, for the grouped list: the survivor is the queue with the LOWER rank number (the
 * collapse tie-break, independent of urgency), it names the collapsed queue, and it takes over the
 * collapsed row's units, so no unit is lost and none is counted twice.
 */
function collapseByRank(items: AttentionItem[], rank: Map<string, number>): AttentionItem[] {
  const byRank = items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (rank.get(a.item.queueId) ?? 0) - (rank.get(b.item.queueId) ?? 0) || a.i - b.i);
  const survivors = new Map<string, { item: AttentionItem; i: number }>();
  for (const entry of byRank) {
    const key = `${entry.item.entityKind}::${entry.item.entityId}`;
    const seen = survivors.get(key);
    if (seen === undefined) {
      survivors.set(key, entry);
      continue;
    }
    seen.item = {
      ...seen.item,
      count: unitsOf(seen.item) + unitsOf(entry.item),
      ...(seen.item.collapsedWithQueueId === undefined && seen.item.queueId !== entry.item.queueId ? { collapsedWithQueueId: entry.item.queueId } : {}),
    };
  }
  // Back to the input order (provider order, each queue's own order), which the section sort keeps stable.
  return [...survivors.values()].sort((a, b) => a.i - b.i).map((e) => e.item);
}

/**
 * The row that carries the units a queue's list did not yield (D178: "every counted unit is reachable").
 * It opens the owning surface, where the rest are, and names how many. None of today's queues needs it on
 * a normal book; it is the honest answer to a list with an internal cap.
 */
function remainderRow(p: QueueProvider, missing: number, urgency: AttentionUrgency): AttentionItem {
  const deepLink = { route: p.deepLinkRoute, params: {} };
  return {
    queueId: p.queueId,
    entityKind: REMAINDER_ENTITY_KIND,
    entityId: `${p.queueId}:remainder`,
    titleKey: 'attention.remainder.title',
    titleParams: { count: missing, queueId: p.queueId },
    count: missing,
    since: '',
    urgency,
    deepLink,
    decisionOptions: [{ id: 'open', verb: null, labelKey: 'attention.remainder.open', role: 'link', input: {}, deepLink }],
    reasonCode: null,
    reasonKey: null,
    consequenceKey: null,
    consequence: null,
  };
}

/**
 * The order inside a section (the owner's words: "Bank transactions must be all the way on top"): under
 * `by_kind` the area order first (Bank, Buchhaltung, Verkauf, System); then the Vorschläge; then the area's
 * lead queue (the bank lines inside Bank); then urgency, queue rank and `since`. The sort is stable, so a
 * queue's own order survives inside it.
 */
function sectionComparator(grouping: AttentionGrouping, rank: Map<string, number>, lead: ReadonlySet<string>, extraAreas: readonly string[]) {
  return (a: AttentionItem, b: AttentionItem): number => {
    if (grouping === 'by_kind') {
      const area = areaIndex(a.area, extraAreas) - areaIndex(b.area, extraAreas);
      if (area !== 0) return area;
    }
    // The approvals first, then the Vorschläge that can no longer be approved (beside their siblings,
    // before the lines), then the lead queue, then the rest.
    const head = (i: AttentionItem): number => (i.kind === 'approve' ? 0 : i.entityKind === 'agent_action' ? 1 : 2);
    const approve = head(a) - head(b);
    if (approve !== 0) return approve;
    const leading = (lead.has(a.queueId) ? 0 : 1) - (lead.has(b.queueId) ? 0 : 1);
    if (leading !== 0) return leading;
    const u = URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency];
    if (u !== 0) return u;
    const r = (rank.get(a.queueId) ?? 0) - (rank.get(b.queueId) ?? 0);
    if (r !== 0) return r;
    return a.since < b.since ? -1 : a.since > b.since ? 1 : 0;
  };
}

/** The workspace's batch mode for bank approvals, the default when the setting cannot be read. */
function approvalBatchMode(ctx: WorkspaceContext): string {
  try {
    return getSetting<string>(ctx, APPROVAL_BATCH_MODE_SETTING);
  } catch {
    return 'tick';
  }
}

/**
 * `attention_list { grouping }` (D178 point 11): EVERY item of every visible queue, cut into sections.
 * Each provider is read completely (its list asked for as many rows as its true COUNT), so the rows ARE
 * the queue; a list that falls short gets one remainder row for the difference. A section's `count` is
 * the units of all its rows; `total` is the sum of the sections and equals `attention_summary.total`.
 */
function groupedList(ctx: WorkspaceContext, input: AttentionListInput, providers: readonly QueueProvider[]): Result {
  const grouping = input.grouping as AttentionGrouping;
  if (!(ATTENTION_GROUPINGS as readonly string[]).includes(grouping)) {
    return err('invalid_input', { field: 'grouping', allowed: [...ATTENTION_GROUPINGS] });
  }
  const computedAt = ctx.clock.now();
  const batchMode = approvalBatchMode(ctx);
  const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.floor(input.limit) : SECTION_PAGE_SIZE;
  const offset = typeof input.cursor === 'string' && /^\d+$/.test(input.cursor) ? Number(input.cursor) : 0;

  let visible = visibleProviders(ctx, providers);
  // An actor holding no read capability of any provider: the padlock, never an empty list.
  if (visible.length === 0) {
    return ok({ computedAt, grouping, visibleQueues: 0, total: null, incomplete: false, failed: [], approvalBatchMode: batchMode, sections: [] });
  }
  const visibleQueues = visible.length;
  if (typeof input.queueId === 'string') visible = visible.filter((p) => p.queueId === input.queueId);
  if (typeof input.area === 'string') visible = visible.filter((p) => p.area === input.area);

  const rank = rankOf(providers);
  const lead = new Set(visible.filter((p) => p.lead === true).map((p) => p.queueId));
  const extraAreas = [...new Set(visible.map((p) => p.area).filter((a) => !ATTENTION_AREA_ORDER.includes(a)))];

  const items: AttentionItem[] = [];
  const failed: string[] = [];
  for (const p of visible) {
    let count: number;
    let listed: AttentionItem[];
    try {
      count = p.count(ctx);
      listed = count > 0 ? p.list(ctx, { limit: count }) : [];
    } catch {
      failed.push(p.queueId);
      continue;
    }
    const kind = kindOf(p);
    // The row's own kind wins (a Vorschlag that can no longer be approved is `do`); else the queue's.
    const rows = listed.map((item) => ({ ...item, area: p.area, kind: item.kind ?? kind }));
    const units = rows.reduce((n, item) => n + unitsOf(item), 0);
    if (units < count) {
      const urgency = rows.reduce<AttentionUrgency>((best, i) => (URGENCY_RANK[i.urgency] > URGENCY_RANK[best] ? i.urgency : best), 'open');
      rows.push({ ...remainderRow(p, count - units, urgency), area: p.area, kind });
    }
    items.push(...rows);
  }

  let all = collapseByRank(items, rank);
  if (typeof input.urgency === 'string') all = all.filter((i) => i.urgency === input.urgency);

  const keyOf = (item: AttentionItem): string => (grouping === 'by_area' ? (item.area ?? '') : (item.kind ?? 'note'));
  const order =
    grouping === 'by_area'
      ? [...ATTENTION_AREA_ORDER, ...extraAreas]
      : [...ATTENTION_KINDS];
  const compare = sectionComparator(grouping, rank, lead, extraAreas);

  const sections: AttentionSection[] = [];
  for (const key of order) {
    if (typeof input.section === 'string' && input.section !== key) continue;
    const rows = all.filter((i) => keyOf(i) === key).sort(compare);
    if (rows.length === 0) continue;
    const page = rows.slice(offset, offset + limit);
    const queueIds = new Set(rows.map((i) => i.queueId));
    sections.push({
      key,
      count: rows.reduce((n, i) => n + unitsOf(i), 0),
      queues: providers.map((p) => p.queueId).filter((id) => queueIds.has(id)),
      items: page,
      ...(rows.length > offset + limit ? { nextCursor: String(offset + limit) } : {}),
    });
  }
  // The total is the whole list's, whichever single section a paging call asked for.
  const total = all.reduce((n, i) => n + unitsOf(i), 0);

  return ok({
    computedAt,
    grouping,
    visibleQueues,
    total,
    incomplete: failed.length > 0,
    failed,
    approvalBatchMode: batchMode,
    sections,
  });
}

/**
 * `attention_list`: page one queue or one area. Same providers, same capability filter, same collapse
 * and ranking as the summary, so the two faces cannot describe the queue differently. The cursor is an
 * opaque offset over the ranked, collapsed result.
 *
 * D178 point 11: with `grouping`, the whole list in sections instead (`groupedList`).
 */
export function attentionList(
  ctx: WorkspaceContext,
  input: AttentionListInput = {},
  providers: readonly QueueProvider[] = ATTENTION_PROVIDERS,
): Result {
  if (input.grouping !== undefined) return groupedList(ctx, input, providers);
  const computedAt = ctx.clock.now();
  const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.floor(input.limit) : LIST_PAGE_SIZE;
  const offset = typeof input.cursor === 'string' && /^\d+$/.test(input.cursor) ? Number(input.cursor) : 0;

  let visible = visibleProviders(ctx, providers);
  if (typeof input.queueId === 'string') visible = visible.filter((p) => p.queueId === input.queueId);
  if (typeof input.area === 'string') visible = visible.filter((p) => p.area === input.area);

  const rank = rankOf(providers);
  // Read enough from each provider to fill the requested page from the far side of the offset.
  const { reads, failed } = readProviders(ctx, visible, offset + limit + 1);
  let all = collapseSameEntity(rankItems(reads.flatMap((r) => r.items), rank), rank);
  if (typeof input.urgency === 'string') all = all.filter((i) => i.urgency === input.urgency);

  const page = all.slice(offset, offset + limit);
  const hasMore = all.length > offset + limit;

  return ok({
    computedAt,
    items: page,
    ...(hasMore ? { nextCursor: String(offset + limit) } : {}),
    failed,
  });
}
