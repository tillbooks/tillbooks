/**
 * The shell's reading of the environment landscape (D126 surface block 7.4, revised by D135 and by
 * K-01, D137).
 *
 * Since K-01 the rail footer is ONE row, and the environment is a single pill in it ("● Live · main"),
 * opening a menu that holds the switch between environments and "Umgebungen verwalten". The pill
 * itself is shell chrome (`app/RailStatusMenu.tsx`); this module is the Environments surface's half:
 * it reads the landscape and says what face the active environment wears, so the rules below stay
 * with the surface that owns environments.
 *
 * THE FACE (D135, unchanged):
 *   - a writable LOCAL `main` (the real books) is CALM: a neutral pill with a small green dot, never
 *     orange, never the "read only" wording;
 *   - a `test` or sandbox environment (NOT the real books) is LOUD, the orange marking, so a write is
 *     never mistaken for a write to live;
 *   - a SERVED (hosted / remote) face is genuinely read-only and says so, with a padlock.
 * "protected" (main's env-wide destructive-op lock) is ALWAYS on for main and is NOT the same as a
 * read-only face, so it does not drive the wording.
 *
 * It reads `env_list` (which carries the active pointer and every row) and DEGRADES silently: on a
 * transport that answers an unrelated shape (a Shell smoke test, a pre-landscape build) or an error,
 * the landscape is `null` and the pill shows the egress state alone. The active-env-missing fallback
 * names develop (the engine's own fallback) and flags it.
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { useWorkspaceId } from '../../app/workspace';
import { isErr } from '../../lib/client';
import { isReadOnlyFace, type EnvironmentRow, type EnvListOk } from './model';

/** The landscape as the shell needs it: every row and the active pointer. */
export interface Landscape {
  rows: readonly EnvironmentRow[];
  active: string;
}

/** Read the landscape, or null when it is unavailable or the payload is not the env_list shape. */
export function useLandscape(): Landscape | null {
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [data, setData] = useState<Landscape | null>(null);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setData(null);
      return;
    }
    const { body } = await client.call('env_list', { workspaceId });
    if (isErr(body)) {
      setData(null);
      return;
    }
    const ok = body as unknown as Partial<EnvListOk>;
    if (!Array.isArray(ok.environments) || typeof ok.active !== 'string') {
      setData(null);
      return;
    }
    setData({ rows: ok.environments, active: ok.active });
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  return data;
}

/** Which of the D135 faces the active environment wears. */
export type EnvironmentFace = 'live' | 'loud' | 'served' | 'missing';

/** The face of the landscape's active environment (see the module doc). */
export function environmentFace(data: Landscape): EnvironmentFace {
  const active = data.rows.find((r) => r.name === data.active);
  if (active === undefined) return 'missing';
  // `protected` is main's env-wide destructive-op lock (always on for main) and is NOT a read-only
  // face; only a SERVED runtime target is genuinely read-only.
  if (isReadOnlyFace(active)) return 'served';
  return active.guardTier === 'protected' ? 'live' : 'loud';
}

/** The locale key of the one word a face shows in the pill; `missing` shows the fallback name only. */
export const FACE_WORD_KEY: Record<Exclude<EnvironmentFace, 'missing'>, string> = {
  live: 'env.indicator.live',
  loud: 'env.indicator.test',
  served: 'env.indicator.served',
};

/** Switch the active environment. A full reload follows: every surface reads the new database. */
export async function switchEnvironment(
  client: ReturnType<typeof useClient>,
  workspaceId: string | null,
  name: string,
): Promise<void> {
  await client.call('env_switch', { workspaceId, name, confirmed: true, idempotencyKey: crypto.randomUUID() });
  // A full reload is the honest response: switching the active environment changes the DB every
  // surface reads from, so the whole app must re-read, not just this pill.
  if (typeof window !== 'undefined') window.location.reload();
}
