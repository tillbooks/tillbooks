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
import { ok } from '../result.js';
import type { Result } from '../result.js';
import { CAPABILITIES } from '../access/capabilities.js';
import type { AttentionItem, AttentionQueueSummary, AttentionUrgency, QueueProvider } from './types.js';
import { ATTENTION_LIST_CAP, URGENCY_RANK } from './types.js';
import { ATTENTION_PROVIDERS, ROUTED_SURFACES } from './providers.js';

/** The `attention_list` page size when the caller names none. */
const LIST_PAGE_SIZE = 20;

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
  }
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
    .map((r) => ({ queueId: r.provider.queueId, area: r.provider.area, count: r.count, topUrgency: topUrgencyOf(r.items) }));
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
}

/**
 * `attention_list`: page one queue or one area. Same providers, same capability filter, same collapse
 * and ranking as the summary, so the two faces cannot describe the queue differently. The cursor is an
 * opaque offset over the ranked, collapsed result.
 */
export function attentionList(
  ctx: WorkspaceContext,
  input: AttentionListInput = {},
  providers: readonly QueueProvider[] = ATTENTION_PROVIDERS,
): Result {
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
