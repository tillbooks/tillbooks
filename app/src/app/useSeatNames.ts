/**
 * `useSeatNames`: the workspace roster, read once, as the `displayName` resolver (K-38, D137).
 *
 * `displayName` (lib/displayName.ts) is the one way to put a seat on screen: a member's name, a
 * seated actor's own name ("MCP-Agent"), "Person 3" for an unknown minted user, never the raw
 * `user_1`. It is pure and takes the roster; this hook is the roster read, so every surface in the
 * rail's governance and queue cluster (Aufgaben, Automationen, Review, Checklisten) names a seat the
 * same way without re-deriving the `list_members` call.
 *
 * Fail open: a viewer without `read_members` (or any read error) gets an empty roster, so seats still
 * resolve by their seat kind ("Person 1", "MCP-Agent"), never to the raw id.
 */
import { useEffect, useMemo, useState } from 'react';

import { useClient } from '../lib/client-context';
import { isErr } from '../lib/client';
import { displayName, type SeatMember, type SeatName } from '../lib/displayName';
import { useT } from '../i18n';
import { useWorkspaceId } from './workspace';

const EMPTY: readonly SeatMember[] = [];

export function useSeatNames(): (id: string | null | undefined) => SeatName {
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const t = useT();
  const [members, setMembers] = useState<readonly SeatMember[]>(EMPTY);

  useEffect(() => {
    let live = true;
    if (workspaceId === null) {
      setMembers(EMPTY);
      return undefined;
    }
    void client.call('list_members', { workspaceId }).then((response) => {
      if (!live) return;
      if (isErr(response.body)) {
        setMembers(EMPTY);
        return;
      }
      const rows = (response.body as unknown as { members?: readonly SeatMember[] }).members ?? [];
      setMembers(rows);
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId]);

  return useMemo(() => (id: string | null | undefined) => displayName(id, members, t), [members, t]);
}
