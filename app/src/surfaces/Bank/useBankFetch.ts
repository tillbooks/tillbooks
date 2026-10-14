/**
 * D142: "Kontoauszüge abrufen", the ONE press both doors share: the `/bank` header and the Übersicht's
 * Bankeingang band ("Jetzt abrufen"). One `bank_sync` per active EBICS connection, each with a fresh
 * idempotency key (a press is a new question), summed into one answer: how many statements landed, how
 * many wait, the number jumps they named, and the first refusal.
 *
 * Under `till up` the sync runs in a worker thread (A36 §12), so the Studio stays usable while the call
 * is out; `busy` is only this door's own press. A sync another caller runs (the 07:00 run, the other
 * door) is refused `sync_in_progress`, which arrives here as the refusal it is.
 */
import { useCallback, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { jumpsOfSync, type NumberJump } from '../BankAccounts/channelWording';

export interface BankFetchSummary {
  imported: number;
  waiting: number;
  jumps: NumberJump[];
  /** The first refusal of the press, or null when every connection answered. */
  error: Err | null;
}

export function useBankFetch(workspaceId: string | null) {
  const client = useClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err | null>(null);

  const run = useCallback(
    async (connectionIds: readonly string[]): Promise<BankFetchSummary | null> => {
      if (workspaceId === null || connectionIds.length === 0) return null;
      setBusy(true);
      setError(null);
      let imported = 0;
      let waiting = 0;
      let first: Err | null = null;
      const jumps: NumberJump[] = [];
      for (const connectionId of connectionIds) {
        const { body } = await client.call('bank_sync', {
          workspaceId,
          connectionId,
          idempotencyKey: `a36-press-${connectionId}-${Date.now()}`,
        });
        if (isErr(body)) {
          first ??= body;
          continue;
        }
        const statements = ((body as Record<string, unknown>).statements as { final?: boolean; outcome?: string; notice?: unknown; jump?: unknown }[] | undefined) ?? [];
        imported += statements.filter((x) => x.outcome === 'imported').length;
        waiting += statements.filter((x) => x.final !== true).length;
        jumps.push(...jumpsOfSync(statements));
      }
      setBusy(false);
      setError(first);
      return { imported, waiting, jumps, error: first };
    },
    [client, workspaceId],
  );

  const clearError = useCallback(() => setError(null), []);
  return { busy, error, run, clearError };
}
