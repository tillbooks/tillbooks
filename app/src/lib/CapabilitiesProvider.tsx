/**
 * Reads `whoami` once per workspace and publishes it to the tree.
 *
 * Mounted in `Shell.tsx`, above `<Outlet />`, because a capability answer is a property of the
 * session and the workspace rather than of any one screen: three surfaces read it and the Members
 * surface writes the thing it reflects.
 *
 * IT RE-READS ON `workspaceId`, AND ON DEMAND. A role change takes effect on the member's NEXT
 * engine call (nothing caches a resolution server-side), so the browser is the only thing that
 * could go stale. `refresh()` is what the Members surface calls after `set_role` or `define_role`,
 * which is what makes "the Define field control unlocks with no re-invite and no re-login" true in
 * the Studio and not only in the engine.
 *
 * A FAILED READ PUBLISHES `null`, which `can()` reads as "allow" (see `./capabilities`). That is
 * deliberate: this gate is a courtesy that saves an operator a refused click, the engine is the gate
 * that matters, and greying out a working ledger because one read failed would be the more expensive
 * of the two mistakes.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { useClient } from './client-context';
import { useWorkspaceId } from '../app/workspace';
import { CapabilitiesContext, type Capabilities, type Whoami } from './capabilities';

export function CapabilitiesProvider({ children }: { children: ReactNode }) {
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [whoami, setWhoami] = useState<Whoami | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (workspaceId === null) {
      setWhoami(null);
      return;
    }
    let live = true;
    void (async () => {
      const response = await client.call('whoami', { workspaceId });
      if (!live) return;
      // The cast is the ordinary open-overload shape: `whoami` declares no payload type in the
      // engine, so `body` is the open `Result`. It is read, never widened: every field below is one
      // the verb demonstrably sends, and `test/api/conformance.test.mjs` drives the same call.
      setWhoami(response.body.ok ? (response.body as unknown as Whoami) : null);
    })();
    return () => {
      live = false;
    };
  }, [client, workspaceId, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const value = useMemo<Capabilities>(
    () => ({
      whoami,
      can: (capability: string) => whoami === null || whoami.capabilities.includes(capability),
      refresh,
    }),
    [whoami, refresh],
  );

  return <CapabilitiesContext.Provider value={value}>{children}</CapabilitiesContext.Provider>;
}
