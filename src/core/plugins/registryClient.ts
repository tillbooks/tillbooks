/**
 * The registry-client seam (spec §3, Pattern OP4 applied to an INBOUND seam).
 *
 * The OSS core declares a `registryClient` interface and ships NO implementation, the same declare-
 * the-seam-ship-nothing technique the email relay and the e-sign transmitter use, except this is a
 * network-CAPABLE seam rather than a zero-egress one: nothing about OP6's no-socket guarantee is
 * claimed for it. Absent a configured client, `search_plugin_registry` / `get_plugin_registry_entry`
 * degrade to `needs_registry` (P9), never a crash and NEVER a hardcoded remote host. A hosted
 * marketplace, if one ever answers this seam, is cloud-tier and owner-gated (§I).
 *
 * The client is process-global (registered by a host at startup), not per-request, because it is
 * infrastructure the whole process shares, exactly like the absence of one is. A test may register a
 * fake to exercise the answered path and clear it to exercise the honest-degradation path.
 */

/** One registry search result: enough to render a card and route into the install review flow. */
export interface RegistryEntry {
  registryRef: string;
  name: string;
  version: string;
  publisher: string;
  summary: string;
  requestedScopes: readonly string[];
  compatRange: string;
}

export interface RegistrySearchResult {
  entries: readonly RegistryEntry[];
  page: number;
  hasMore: boolean;
}

/**
 * The seam a host fills. `search` answers a page of results for a query; `fetchEntry` resolves one
 * `registryRef` to a full entry (the preview flow reads its `requestedScopes`). Either may throw or
 * answer nothing; the engine treats a throw as `registry_unreachable` and keeps the last result set.
 */
export interface RegistryClient {
  search(query: string, page: number): RegistrySearchResult;
  fetchEntry(registryRef: string): RegistryEntry | null;
}

let _client: RegistryClient | undefined;

/** Register (or, with `undefined`, clear) the process-wide registry client. Called by a host. */
export function registerRegistryClient(client: RegistryClient | undefined): void {
  _client = client;
}

/** The configured client, or `undefined` when none is wired (the OSS-core default). */
export function registryClient(): RegistryClient | undefined {
  return _client;
}
