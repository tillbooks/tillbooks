/**
 * D167: the Stufe a Vorschlag line shows is READ from the dial (`get_agent_dial`), never hard-coded.
 * The old card printed "Stufe: fragt immer" from a constant set, whatever the dial said. One read per
 * surface and workspace; an unreadable dial yields null and the line leaves the row out rather than
 * guessing a level.
 */
import { useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import type { DialLevel } from './model';

/** One capability's level as the engine resolved it (stored vs effective, D103). */
export interface DialInfo {
  effective: DialLevel;
  strongDefault: boolean;
}

export type DialLevels = ReadonlyMap<string, DialInfo>;

/** Parse `get_agent_dial`'s `rows`, defensively: an unreadable shape is null, never a guessed level. */
export function parseDialLevels(body: unknown): DialLevels | null {
  if (body === null || typeof body !== 'object') return null;
  const rows = (body as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return null;
  const map = new Map<string, DialInfo>();
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.capability !== 'string') continue;
    map.set(r.capability, { effective: r.effective === 'auto' ? 'auto' : 'ask', strongDefault: r.strongDefault === true });
  }
  return map;
}

/** The dial of the active workspace, re-read when `refreshKey` changes (a grant moves it). */
export function useDialLevels(enabled: boolean, refreshKey: unknown = 0): DialLevels | null {
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [levels, setLevels] = useState<DialLevels | null>(null);

  useEffect(() => {
    setLevels(null);
    if (!enabled || workspaceId === null) return;
    let live = true;
    void (async () => {
      const res = await client.call('get_agent_dial', { workspaceId });
      if (!live) return;
      setLevels(isErr(res.body) ? null : parseDialLevels(res.body));
    })();
    return () => {
      live = false;
    };
  }, [client, enabled, workspaceId, refreshKey]);

  return levels;
}
