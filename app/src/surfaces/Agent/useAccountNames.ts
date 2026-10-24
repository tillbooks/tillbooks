/**
 * D167: a Vorschlag's Details name an account the way a person knows it, "6500 Verwaltungs- und
 * Bürokosten", never by its internal id. The engine's `payloadLabels` name contacts only, so the
 * surfaces that show Vorschlag lines read the chart once (`list_accounts`) while a line is shown and
 * hand the names down. An unreadable chart yields an empty map: the Details then say "Konto" without
 * the name, never the raw id.
 */
import { useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';

export type AccountNames = ReadonlyMap<string, string>;

/** `list_accounts`' `accounts` as id to "number name", defensively. */
export function parseAccountNames(body: unknown): AccountNames {
  const map = new Map<string, string>();
  if (body === null || typeof body !== 'object') return map;
  const accounts = (body as { accounts?: unknown }).accounts;
  if (!Array.isArray(accounts)) return map;
  for (const raw of accounts) {
    if (raw === null || typeof raw !== 'object') continue;
    const a = raw as Record<string, unknown>;
    if (typeof a.id !== 'string') continue;
    const name = [typeof a.number === 'string' ? a.number : '', typeof a.name === 'string' ? a.name : ''].filter((s) => s !== '').join(' ');
    if (name !== '') map.set(a.id, name);
  }
  return map;
}

const EMPTY: AccountNames = new Map();

/** The active workspace's account names, read once while `enabled`. */
export function useAccountNames(enabled: boolean): AccountNames {
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [names, setNames] = useState<AccountNames>(EMPTY);

  useEffect(() => {
    if (!enabled || workspaceId === null) return;
    let live = true;
    void (async () => {
      try {
        const res = await client.call('list_accounts', { workspaceId });
        if (!live || isErr(res.body)) return;
        setNames(parseAccountNames(res.body));
      } catch {
        // A chart that cannot be read leaves the names out; the Details still never print an id.
      }
    })();
    return () => {
      live = false;
    };
  }, [client, enabled, workspaceId]);

  return names;
}
