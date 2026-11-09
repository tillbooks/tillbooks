/**
 * M02: a one-way "the publish dial flipped" signal, shared between the two Setup panels that read the
 * same `get_sync_contract`. `SyncHosting` owns the dial; `Trust` renders a line off the SAME contract
 * (whether the ledger stream is published) and used to read it at MOUNT only, so a flip on the dial
 * left the Trust line stale until a reload. This context closes that gap without either panel reaching
 * into the other: the panel that flips the dial raises the signal, and any sibling re-reads its own
 * contract when the version bumps. The read stays `get_sync_contract` (member-visible), so nothing here
 * changes who can see the line.
 *
 * The default is INERT: outside a provider `version` never moves and `notifyChange` is a no-op, so each
 * panel still renders and tests correctly in isolation (its own component test mounts it alone). The
 * live coupling exists only when `Setup` wraps both panels in `SyncSignalProvider`.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export interface SyncSignal {
  /** Increments on every dial flip, so a sibling panel can re-read the sync contract. */
  version: number;
  /** Raised by the panel that owns the dial, after a flip has landed. */
  notifyChange: () => void;
}

const INERT: SyncSignal = { version: 0, notifyChange: () => undefined };

const SyncSignalContext = createContext<SyncSignal | null>(null);

export function SyncSignalProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const notifyChange = useCallback(() => setVersion((v) => v + 1), []);
  const value = useMemo<SyncSignal>(() => ({ version, notifyChange }), [version]);
  return <SyncSignalContext.Provider value={value}>{children}</SyncSignalContext.Provider>;
}

/** Read the shared sync signal. Falls back to the inert default when no provider is mounted. */
export function useSyncSignal(): SyncSignal {
  return useContext(SyncSignalContext) ?? INERT;
}
