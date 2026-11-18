/**
 * THE REVERSAL CHAIN of a posted entry: the entry, the posted entry that reverses it, the posted entry that
 * reverses that one, and so on. One shared walk (D198 re-cut, paper critic r7 L7: the opening balances'
 * private `isLive` made public instead of copied), read by A04's opening position and by the settlement
 * feed's stateless pre-filing check (D198 S1).
 *
 * Two predicates are read off one walk, each rule naming which it uses:
 *
 *  - LIVE NOW (`isLiveNow`): the chain ends at an even reversal depth, whatever the dates. A reversed entry
 *    is dead; a reversed reversal revives it. This is what "the entry still stands" means today.
 *  - BOOKED THROUGH a day (`signedCountThrough`): the SUM, over the members dated on or before that day, of
 *    +1 for the entry and every even depth and -1 for every odd depth. A period figure is a sum, and nothing
 *    forbids a reversal dated before its target, so this is never a parity test (paper critic r7 L2).
 *
 * The append-only ledger guarantees at most one posted reversal per entry (`reverse_entry` refuses a second),
 * so the walk follows the first one it finds and stops at a cycle bound. §H-TENANT: every read names the
 * workspace.
 */

import type { WorkspaceContext } from '../context.js';

export interface ChainMember {
  entryId: string;
  date: string;
  /** 0 for the entry itself, 1 for its reversal, 2 for the reversal of the reversal, ... */
  depth: number;
}

/** A chain longer than this is a corrupt book, not a correction history: the walk stops there. */
const MAX_CHAIN = 64;

/**
 * The chain of `entryId` (the entry first), or an empty list when the entry is not in this workspace.
 * Only POSTED reversals count: a draft storno does not cancel anything.
 */
export function reversalChainOf(ctx: WorkspaceContext, entryId: string): ChainMember[] {
  const root = ctx.store.db.prepare('SELECT id, date FROM journal_entry WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, entryId) as
    | { id: string; date: string }
    | undefined;
  if (root === undefined) return [];
  const next = ctx.store.db.prepare(
    "SELECT id, date FROM journal_entry WHERE workspace_id = ? AND reverses_entry_id = ? AND status = 'posted' ORDER BY created_at, rowid LIMIT 1",
  );
  const out: ChainMember[] = [{ entryId: root.id, date: root.date, depth: 0 }];
  let current = root.id;
  for (let depth = 1; depth <= MAX_CHAIN; depth += 1) {
    const row = next.get(ctx.workspaceId, current) as { id: string; date: string } | undefined;
    if (row === undefined) break;
    out.push({ entryId: row.id, date: row.date, depth });
    current = row.id;
  }
  return out;
}

/** LIVE NOW: the chain ends at an even depth (an unreversed entry, or a reversed reversal). */
export function isLiveNowChain(chain: readonly ChainMember[]): boolean {
  if (chain.length === 0) return false;
  return (chain[chain.length - 1] as ChainMember).depth % 2 === 0;
}

/** LIVE NOW for one entry of this workspace (module header). */
export function isLiveNow(ctx: WorkspaceContext, entryId: string): boolean {
  return isLiveNowChain(reversalChainOf(ctx, entryId));
}

/** +1 for the entry and every even depth, -1 for every odd depth, over the members dated on or before `day`. */
export function signedCountThrough(chain: readonly ChainMember[], day: string): number {
  let sum = 0;
  for (const m of chain) if (m.date <= day) sum += m.depth % 2 === 0 ? 1 : -1;
  return sum;
}
