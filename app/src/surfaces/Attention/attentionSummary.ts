/**
 * ONE live `attention_summary` per client and workspace, shared by every place that shows the waiting
 * work outside the hub: the rail count (tree and icon strip) and the Übersicht list. They used to read
 * it once each, on mount, and never again, so a count could sit stale for a whole session while the
 * bank switched the access on underneath it. Now they subscribe to one store that reads:
 *
 *  - on the first subscriber (a fresh workspace starts LOADING, never with another workspace's number);
 *  - every `ATTENTION_REFRESH_MS` while the tab is visible (a hidden tab does not poll);
 *  - when the tab becomes visible again or the window regains focus;
 *  - when anything announces a change (`announceAttentionChanged`, fired by the hub after an act).
 *
 * Every read is a QUIET refresh: the last answer stays on screen until the next one lands, so the count
 * never flickers to a skeleton every minute. A failed refresh replaces the number with the failure
 * (the rail rule: never a stale count presented as current). An answer that a newer read overtook is
 * discarded. The last subscriber leaving stops the timers and drops the entry.
 *
 * The engine is the only source of every figure: this module parses and forwards, it never counts.
 */
import { useCallback, useSyncExternalStore } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type TillClient } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';

/** How often a visible tab re-reads the waiting work. A pure read of live queues: cheap, and a minute is "live" for a person. */
export const ATTENTION_REFRESH_MS = 60_000;

/** How many leading rows the shared read asks for (the Übersicht shows up to this many). */
export const ATTENTION_TOP_LIMIT = 3;

/** The window event that asks every subscriber to re-read now. */
export const ATTENTION_CHANGED_EVENT = 'till:attention-changed';

/** Tell every live count that the waiting work may have changed (after an act, a confirm, a send). */
export function announceAttentionChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(ATTENTION_CHANGED_EVENT));
}

export type AttentionUrgency = 'overdue' | 'due' | 'open';

/** One leading row, as much of the engine's `AttentionItem` as a compact list needs. */
export interface AttentionTopItem {
  queueId: string;
  entityId: string;
  titleKey: string;
  titleParams: Record<string, string | number>;
  subtitleKey?: string;
  subtitleParams: Record<string, string | number>;
  urgency: AttentionUrgency;
  deepLink: { route: string; params: Record<string, string> };
}

export interface AttentionSummaryData {
  /** `null` when the actor may read no queue (the padlock case): never presented as zero. */
  total: number | null;
  visibleQueues: number;
  top: AttentionTopItem[];
}

export type AttentionSummaryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ok'; data: AttentionSummaryData };

const IDLE: AttentionSummaryState = { status: 'idle' };

function parseTopItem(raw: unknown): AttentionTopItem | null {
  if (raw === null || typeof raw !== 'object') return null;
  const n = raw as Record<string, unknown>;
  const link = n.deepLink as { route?: unknown; params?: unknown } | undefined;
  if (typeof n.queueId !== 'string' || typeof n.entityId !== 'string' || typeof n.titleKey !== 'string') return null;
  if (link === undefined || link === null || typeof link.route !== 'string') return null;
  return {
    queueId: n.queueId,
    entityId: n.entityId,
    titleKey: n.titleKey,
    titleParams: (n.titleParams ?? {}) as Record<string, string | number>,
    ...(typeof n.subtitleKey === 'string' ? { subtitleKey: n.subtitleKey } : {}),
    subtitleParams: (n.subtitleParams ?? {}) as Record<string, string | number>,
    urgency: n.urgency === 'overdue' || n.urgency === 'due' ? n.urgency : 'open',
    deepLink: {
      route: link.route,
      params: link.params !== null && typeof link.params === 'object' ? (link.params as Record<string, string>) : {},
    },
  };
}

/** Read the summary defensively: a shape this module cannot read is a failed read, never a guessed zero. */
export function parseAttentionSummary(body: unknown): AttentionSummaryData | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const total = typeof b.total === 'number' ? b.total : null;
  // The total is the one figure every reader needs; a body carrying neither it (or its honest null)
  // nor the queue count is not a summary.
  if (typeof b.visibleQueues !== 'number' && total === null && b.total !== null) return null;
  const top = Array.isArray(b.top) ? b.top.map(parseTopItem).filter((i): i is AttentionTopItem => i !== null) : [];
  return { total, visibleQueues: typeof b.visibleQueues === 'number' ? b.visibleQueues : 0, top };
}

interface Entry {
  state: AttentionSummaryState;
  listeners: Set<() => void>;
  /** Bumped per read; an answer whose number is not the latest is discarded. */
  seq: number;
  stop: (() => void) | null;
}

const STORES = new WeakMap<TillClient, Map<string, Entry>>();

function entryFor(client: TillClient, workspaceId: string): Entry {
  let byWorkspace = STORES.get(client);
  if (byWorkspace === undefined) {
    byWorkspace = new Map();
    STORES.set(client, byWorkspace);
  }
  let entry = byWorkspace.get(workspaceId);
  if (entry === undefined) {
    entry = { state: { status: 'loading' }, listeners: new Set(), seq: 0, stop: null };
    byWorkspace.set(workspaceId, entry);
  }
  return entry;
}

function publish(entry: Entry, state: AttentionSummaryState): void {
  entry.state = state;
  for (const listener of [...entry.listeners]) listener();
}

async function read(client: TillClient, workspaceId: string, entry: Entry): Promise<void> {
  const seq = ++entry.seq;
  const res = await client.call('attention_summary', { workspaceId, topLimit: ATTENTION_TOP_LIMIT });
  // A newer read overtook this one, or everyone left: this answer is not the current truth.
  if (seq !== entry.seq || entry.listeners.size === 0) return;
  if (isErr(res.body)) {
    publish(entry, { status: 'error' });
    return;
  }
  const data = parseAttentionSummary(res.body);
  publish(entry, data === null ? { status: 'error' } : { status: 'ok', data });
}

function start(client: TillClient, workspaceId: string, entry: Entry): () => void {
  const refresh = (): void => {
    void read(client, workspaceId, entry);
  };
  const whenVisible = (): void => {
    if (document.visibilityState === 'visible') refresh();
  };
  const timer = window.setInterval(() => {
    if (document.visibilityState !== 'hidden') refresh();
  }, ATTENTION_REFRESH_MS);
  window.addEventListener(ATTENTION_CHANGED_EVENT, refresh);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', whenVisible);
  refresh();
  return () => {
    window.clearInterval(timer);
    window.removeEventListener(ATTENTION_CHANGED_EVENT, refresh);
    window.removeEventListener('focus', refresh);
    document.removeEventListener('visibilitychange', whenVisible);
  };
}

function subscribe(client: TillClient, workspaceId: string, listener: () => void): () => void {
  const entry = entryFor(client, workspaceId);
  entry.listeners.add(listener);
  if (entry.stop === null) entry.stop = start(client, workspaceId, entry);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size > 0) return;
    entry.stop?.();
    entry.stop = null;
    entry.seq += 1; // an in-flight answer now lands on nobody
    STORES.get(client)?.delete(workspaceId);
  };
}

/**
 * The live waiting-work summary of the ACTIVE workspace. `idle` with no workspace (nothing is asked),
 * `loading` until the first answer of this workspace, then `ok` or `error`, refreshed in place.
 */
export function useAttentionSummary(): AttentionSummaryState {
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const subscribeFn = useCallback(
    (listener: () => void) => (workspaceId === null ? () => undefined : subscribe(client, workspaceId, listener)),
    [client, workspaceId],
  );
  const snapshot = useCallback(
    (): AttentionSummaryState => (workspaceId === null ? IDLE : entryFor(client, workspaceId).state),
    [client, workspaceId],
  );
  return useSyncExternalStore(subscribeFn, snapshot, snapshot);
}
