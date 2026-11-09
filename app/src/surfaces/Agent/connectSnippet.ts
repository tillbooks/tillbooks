/**
 * The MCP client config the Verbindung tab offers, generated from the RUNNING instance (beta launch
 * P0.5a).
 *
 * THE DEFECT. The tab showed a fixed block, `"till": {"command": "till", "args": ["mcp"]}`, which
 * contradicted the docs (`"tillbooks"`, `npx -y tillbooks mcp`) and carried NO database path. The
 * first-run audit ran the Studio on a custom `TILL_DB_PATH`; an agent configured from that block
 * would have opened `~/.till/till.db`, a DIFFERENT ledger, and posted where the human never looks.
 * That quietly breaks the product's central claim (one ledger, two faces, D12).
 *
 * WHAT IT GENERATES. The docs' form (server key `tillbooks`, `npx -y`, `mcp`) plus two facts only the
 * running instance knows:
 *
 *   - `env.TILL_DB_PATH`: the file this process ACTUALLY opened, read off the live handle by
 *     `delivery_status.dbPath` (not re-resolved from env), so the agent and the Studio cannot open
 *     two different books;
 *   - the package version pinned (`tillbooks@<version>`): npx otherwise runs whatever npm's `latest`
 *     is, and a beta install whose `latest` is an older release would hand the agent an engine that
 *     refuses (or misreads) a book a newer build wrote. The pin keeps agent and Studio on one build.
 *
 * An in-memory ledger (`:memory:`) cannot be shared with a second process at all, so there is no
 * stdio block for it: the panel points at the HTTP endpoint of this very process instead.
 */

/** The server key the docs, the README and the MCP registry entry use. */
export const MCP_SERVER_KEY = 'tillbooks';

/** A release-shaped version (`1.0.0`, `1.0.0-beta.1`): only such a version is worth pinning. */
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface ConnectSnippetInput {
  /** `delivery_status.dbPath`: the open ledger file, `:memory:` for an ephemeral run, null if unread. */
  dbPath: string | null;
  /** The build's version (`__TILL_VERSION__`), or null when it is not known. */
  version: string | null;
}

export type ConnectSnippet =
  | { kind: 'stdio'; json: string; dbPath: string | null; pinned: string | null }
  /** The ledger lives only in this process's memory: a second process cannot open it. */
  | { kind: 'memory' };

export function connectSnippet(input: ConnectSnippetInput): ConnectSnippet {
  if (input.dbPath === ':memory:') return { kind: 'memory' };
  const pinned = input.version !== null && RELEASE_VERSION.test(input.version) ? input.version : null;
  const entry: { command: string; args: string[]; env?: Record<string, string> } = {
    command: 'npx',
    args: ['-y', pinned !== null ? `tillbooks@${pinned}` : 'tillbooks', 'mcp'],
  };
  const dbPath = input.dbPath !== null && input.dbPath.trim() !== '' ? input.dbPath : null;
  if (dbPath !== null) entry.env = { TILL_DB_PATH: dbPath };
  const json = JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: entry } }, null, 2);
  return { kind: 'stdio', json, dbPath, pinned };
}

/** The build's own version, baked in by Vite; null under vitest, where no `define` runs. */
export function studioVersion(): string | null {
  return typeof __TILL_VERSION__ === 'string' && __TILL_VERSION__.length > 0 ? __TILL_VERSION__ : null;
}
