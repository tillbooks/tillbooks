/**
 * WHERE A HUMAN APPROVES (beta launch P0.5b): the pointer an agent seat receives with every drafted
 * action and with every refusal to decide one itself.
 *
 * THE DEFECT. The first-run audit's agent called `post_entry` and got `drafted` back, then tried
 * `approve_drafted_action` and got `permission_denied` naming `manage_agent_dial`, with no hint where
 * the approval happens. On the documented npm path (`npx tillbooks mcp`) there was not even a Studio
 * to point at, so the draft could sit forever while the agent told its user nothing useful.
 *
 * WHAT IT SAYS. The Studio route (`/agent`, tab Vorschläge; the same drafts are listed in Pendenzen
 * at `/attention`) and, when one is reachable, the full URL of a Studio on THIS machine:
 *
 *   1. this process serves the Studio (`till up`): its own bound address;
 *   2. otherwise a live `till up` holds the single-instance lock in the support directory (the agent
 *      runs `till mcp` beside a Studio the human started): the URL the lock records, and whether that
 *      Studio has the SAME ledger open (the lock records its database path since P0.5);
 *   3. otherwise no URL, and the sentence says how to start one (`till up`).
 *
 * It reads module state and one small file and never throws: a pointer that cannot be computed is a
 * pointer without a URL, never a changed verb result.
 */

import { isIP } from 'node:net';
import { resolve } from 'node:path';

import { getDeliveryRuntime } from './runtime-state.js';
import { readLock, isProcessAlive } from './up-lock.js';
import { resolveSupportDir } from './db-path.js';

/** The Studio routes a human decides drafts on. `/agent` opens on the Vorschläge tab's surface. */
export const APPROVAL_PATH = '/agent';
export const APPROVAL_ALSO_PATH = '/attention';

export interface ApprovalPointer {
  /** Always `studio`: a human decides in the Studio, never an agent seat. */
  where: 'studio';
  /** The route: Agent > Vorschläge. */
  path: string;
  /** The same drafts, listed in Pendenzen. */
  alsoPath: string;
  /** The full URL of a Studio on this machine, or null when none is running. */
  url: string | null;
  /**
   * False when the running Studio has a DIFFERENT ledger open than this process (so the draft is not
   * there); true when it is the same file; null when that cannot be told (no Studio, or a lock
   * written before the path was recorded).
   */
  sameLedger: boolean | null;
  /** One sentence for the agent to relay to its human, in English (the agent-facing language). */
  hint: string;
}

function hostForUrl(host: string): string {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return isIP(bare) === 6 ? `[${bare}]` : host;
}

/** Two ledger paths name one file (resolved, so `./till.db` and its absolute spelling agree). */
export function samePath(a: string, b: string): boolean {
  if (a === ':memory:' || b === ':memory:') return false;
  return resolve(a) === resolve(b);
}

function locateStudio(supportDir: string | undefined, ownDbPath: string | null): { url: string | null; sameLedger: boolean | null } {
  const rt = getDeliveryRuntime();
  if (rt.studioServed && rt.host !== null && rt.port !== null) {
    return { url: `http://${hostForUrl(rt.host)}:${rt.port}`, sameLedger: true };
  }
  const lock = readLock(supportDir ?? resolveSupportDir());
  if (lock === null || lock.pid === process.pid || !isProcessAlive(lock.pid)) return { url: null, sameLedger: null };
  const sameLedger = typeof lock.dbPath === 'string' && ownDbPath !== null ? samePath(lock.dbPath, ownDbPath) : null;
  return { url: lock.url, sameLedger };
}

/**
 * The pointer for this process. `ownDbPath` is the file THIS process opened (`store.db.name`), used
 * only to tell whether a Studio found through the lock serves the same ledger.
 */
export function approvalPointer(input: { supportDir?: string | undefined; ownDbPath: string | null }): ApprovalPointer {
  let located: { url: string | null; sameLedger: boolean | null };
  try {
    located = locateStudio(input.supportDir, input.ownDbPath);
  } catch {
    located = { url: null, sameLedger: null };
  }
  const { url, sameLedger } = located;
  const where = 'Agent > Vorschläge (Proposals), also listed in Pendenzen (Attention)';
  let hint: string;
  if (url === null) {
    hint = `A human approves this in the TILL Studio under ${where}. No Studio is running on this machine: start one with \`till up\` (or \`npx -y tillbooks up\`) and open ${APPROVAL_PATH} at the address it prints.`;
  } else if (sameLedger === false) {
    hint = `A human approves this in the TILL Studio under ${where}, but the Studio running at ${url} has a different ledger open than this agent. Start the Studio on this agent's TILL_DB_PATH, then open ${url}${APPROVAL_PATH}.`;
  } else {
    hint = `A human approves this in the TILL Studio at ${url}${APPROVAL_PATH} (${where}).`;
  }
  return {
    where: 'studio',
    path: APPROVAL_PATH,
    alsoPath: APPROVAL_ALSO_PATH,
    url: url === null ? null : `${url}${APPROVAL_PATH}`,
    sameLedger,
    hint,
  };
}

/** The verbs only a human decides with (A26/A35: `manage_agent_dial`, owner-only by default). */
export const HUMAN_DECISION_CAPABILITY = 'manage_agent_dial';

/**
 * What `till mcp` prints on STDERR when it starts (P0.5c; stdout is the MCP channel and stays clean).
 * The human who wired an agent up sees which ledger it opened and where to approve what it drafts,
 * or that no Studio runs and how to start one.
 */
export function mcpStartLines(input: { dbPath: string; supportDir?: string | undefined }): string[] {
  const pointer = approvalPointer({ supportDir: input.supportDir, ownDbPath: input.dbPath });
  const lines = [`till mcp: MCP over stdio on the ledger ${input.dbPath}`];
  if (pointer.url === null) {
    lines.push('till mcp: no Studio is running on this machine. Run "till up" to open it; drafts wait there under Agent > Vorschläge (/agent).');
  } else if (pointer.sameLedger === false) {
    lines.push(`till mcp: a Studio runs at ${pointer.url}, but it has a DIFFERENT ledger open. Drafts from this agent will not show there.`);
  } else {
    lines.push(`till mcp: Studio at ${pointer.url} (approve drafts under Agent > Vorschläge)`);
  }
  return lines;
}
