/**
 * A36 §4.7 (D150) on /bank: the open statement gaps of every Bankkonto, for the balance line's card.
 *
 * The read is the one the Übersicht band and the repair dialog already make, the `bank_inbox` tile of
 * `dashboard_tile`: its `statementGaps` carries every open gap of every Bankkonto, fed by EBICS or
 * imported by hand (`bank_channel_status` carries only the gaps of accounts routed through a channel).
 * No new engine verb.
 *
 * A read that fails or is refused says nothing here: the balance line stays as it was, and the gap
 * still shows on the Übersicht, in Pendenzen and under Bankkonten. The read is repeated when the
 * latest statement of an account in view changes (`refreshKey`) and when anything announces that the
 * attention changed (an import, a fetch, a confirmed or filled gap all do).
 */
import { useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { ATTENTION_CHANGED_EVENT } from '../Attention/attentionSummary';
import { parseStatementGaps, type StatementGapDto } from './statementGaps';

const NONE: ReadonlyMap<string, readonly StatementGapDto[]> = new Map();

/** The open gaps by Bankkonto id. An account without one is absent from the map. */
export function useStatementGaps(refreshKey: string): ReadonlyMap<string, readonly StatementGapDto[]> {
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [gaps, setGaps] = useState<readonly StatementGapDto[]>([]);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const again = () => setNonce((n) => n + 1);
    window.addEventListener(ATTENTION_CHANGED_EVENT, again);
    return () => window.removeEventListener(ATTENTION_CHANGED_EVENT, again);
  }, []);

  useEffect(() => {
    if (workspaceId === null) return undefined;
    let live = true;
    const today = new Date().toISOString().slice(0, 10);
    client
      .call('dashboard_tile', { workspaceId, tile: 'bank_inbox', from: today, to: today })
      .then(({ body }) => {
        if (!live) return;
        const tile = isErr(body) ? null : (body as { tile?: { ok?: unknown; statementGaps?: unknown } | null }).tile;
        setGaps(tile !== null && tile !== undefined && tile.ok === true ? parseStatementGaps(tile.statementGaps) : []);
      })
      .catch(() => {
        if (live) setGaps([]);
      });
    return () => {
      live = false;
    };
  }, [client, workspaceId, refreshKey, nonce]);

  return useMemo(() => {
    if (gaps.length === 0) return NONE;
    const byAccount = new Map<string, StatementGapDto[]>();
    for (const g of gaps) byAccount.set(g.bankAccountId, [...(byAccount.get(g.bankAccountId) ?? []), g]);
    return byAccount;
  }, [gaps]);
}

/** The refresh key for the balances in view: each account's latest statement. */
export function statementKeyOf(balances: readonly { bankAccountId: string; statementId: string | null }[]): string {
  return balances.map((b) => `${b.bankAccountId}:${b.statementId ?? ''}`).join('|');
}
