/**
 * React binding for the REST client.
 *
 * `TillClientProvider` puts a `TillClient` on the context; `useClient()` reads it. Surfaces and tests
 * inject a client built over any `Transport`, so a test can drive a fake transport with no network.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { TillClient, defaultClient } from './client';

const ClientContext = createContext<TillClient | null>(null);

export function TillClientProvider({
  client,
  children,
}: {
  /** Inject a client (real or fake). Omit to use the default same-origin fetch client. */
  client?: TillClient;
  children: ReactNode;
}) {
  const value = useMemo(() => client ?? defaultClient(), [client]);
  return <ClientContext.Provider value={value}>{children}</ClientContext.Provider>;
}

/** Access the client. Throws outside a provider, which is a wiring bug, not a runtime state. */
export function useClient(): TillClient {
  const ctx = useContext(ClientContext);
  if (ctx === null) throw new Error('useClient must be used within a TillClientProvider.');
  return ctx;
}
