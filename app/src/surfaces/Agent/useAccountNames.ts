/**
 * D167: a Vorschlag's Details name an account the way a person knows it, "6500 Verwaltungs- und
 * Bürokosten", never by its internal id. The engine's `payloadLabels` name contacts only, so the
 * surfaces that show Vorschlag lines read the chart once (`list_accounts`) while a line is shown and
 * hand the names down. An unreadable chart yields an empty map: the Details then say "Konto" without
 * the name, never the raw id.
 *
 * D207 (the owner saw "Konto" on an Übersicht suggestion with the card sheet open): two causes, both closed.
 *  - A drafted payload names an account by its id OR by its NUMBER (`ACCOUNT_REF`: "account id or number";
 *    an agent writing through MCP often sends "6570"). The map knew ids only, so a numbered leg read
 *    "Konto". It now answers by id and by number alike (the two never collide: an id is never all digits).
 *  - The map started empty on every mount, so a card the page remounts (the sheet's route, a re-arranged
 *    grid) said "Konto" until its own read came back. The names of a workspace are kept once read and shared
 *    by every line, so a remount names its accounts at once; a fresh read replaces them.
 */
import { useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';

export type AccountNames = ReadonlyMap<string, string>;

/** `list_accounts`' `accounts` as id (and number) to "number name", defensively. */
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
    if (name === '') continue;
    map.set(a.id, name);
    // A payload may name the account by its number (`ACCOUNT_REF`); an id wins where both could match.
    if (typeof a.number === 'string' && a.number !== '' && !map.has(a.number)) map.set(a.number, name);
  }
  return map;
}

const EMPTY: AccountNames = new Map();

/** The last names read per client and workspace, shared by every line on every surface. */
const shared = new WeakMap<object, Map<string, AccountNames>>();

function sharedOf(client: object): Map<string, AccountNames> {
  let byWorkspace = shared.get(client);
  if (byWorkspace === undefined) {
    byWorkspace = new Map();
    shared.set(client, byWorkspace);
  }
  return byWorkspace;
}

/** The active workspace's account names, read once while `enabled`. */
export function useAccountNames(enabled: boolean): AccountNames {
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const known = workspaceId !== null ? (sharedOf(client).get(workspaceId) ?? EMPTY) : EMPTY;
  const [names, setNames] = useState<AccountNames>(known);

  useEffect(() => {
    // A workspace switch never shows the previous book's names (D153).
    setNames(workspaceId !== null ? (sharedOf(client).get(workspaceId) ?? EMPTY) : EMPTY);
  }, [client, workspaceId]);

  useEffect(() => {
    if (!enabled || workspaceId === null) return;
    let live = true;
    void (async () => {
      try {
        const res = await client.call('list_accounts', { workspaceId });
        if (isErr(res.body)) return;
        const parsed = parseAccountNames(res.body);
        sharedOf(client).set(workspaceId, parsed);
        if (live) setNames(parsed);
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
