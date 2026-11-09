/**
 * `useSeatLabel`: a surface's way to name a seat or an actor on screen (K-38, D137), never "user_1".
 *
 * `lib/displayName.ts` owns the naming rule (a member's name, else the seat's own name, else
 * "Person <n>"); this hook only feeds it the roster, read once per workspace from `list_members`. A
 * viewer without the right to read the roster, or a failed read, still gets a human label: the rule
 * names a minted `user_<n>` "Person <n>" and a seated actor by its seat, so the raw id never becomes
 * the label either way. The raw id stays on the returned `SeatName` for a tooltip.
 *
 * It lives beside Zeit, its heaviest user (the Rapporte list named its person 60 times as "user_1"),
 * and the other operations surfaces that print an actor import it from here.
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { displayName, type SeatMember, type SeatName } from '../../lib/displayName';

export function useSeatLabel(): (id: string | null | undefined) => SeatName {
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const t = useT();
  const [members, setMembers] = useState<readonly SeatMember[]>([]);

  useEffect(() => {
    let live = true;
    if (workspaceId === null) {
      setMembers([]);
      return undefined;
    }
    void (async () => {
      const response = await client.call('list_members', { workspaceId });
      if (!live) return;
      setMembers(
        isErr(response.body) ? [] : ((response.body as unknown as { members?: readonly SeatMember[] }).members ?? []),
      );
    })();
    return () => {
      live = false;
    };
  }, [client, workspaceId]);

  return useCallback((id: string | null | undefined) => displayName(id, members, t), [members, t]);
}
