/**
 * D13: who a session's calls are attributed to in the audit trail.
 *
 * The actor is declared ONCE, at `initialize`, by the client identity in the MCP handshake, and
 * every call in that session inherits it. Studio sessions land as `studio`, `till mcp` sessions as
 * `agent`. Without this, collapsing the Studio onto the MCP path (D12) would stamp every human
 * action as `agent` and hollow out the most useful column a Treuhänder reads.
 *
 * Two alternatives were rejected. A per-CALL actor lets a client claim any actor on any call, which
 * is no guarantee at all under an audit trail. Recording only the transport is honest but throws
 * away the human-versus-agent answer entirely.
 *
 * The mapping is a CLOSED registry of client names, so the set of actors the server will ever write
 * is the set it decided in advance. The value is a STRING, not a human/agent flag, which is what
 * lets a real named user (`treuhand:mueller`) drop in later behind authentication without touching a
 * single call site.
 *
 * THE SEATING RULE (F-08, 2026-09-05), stated once, here, and consumed by every host:
 *
 *   Over `/mcp` a client name in the closed map keeps its seat; ANY other name, and no name, is the
 *   governed `agent` seat. The Studio's own REST bridge stays `studio`, because the Studio is the
 *   human. Over the served door the seat is the member the proxy attested, and a member of kind
 *   `agent` is the governed seat (`isGovernedSeat`, core).
 *
 * The rule used to take a HOST-SUPPLIED fallback: `till up` and the Vite dev bridge passed `studio`
 * (their REST face's actor) and the MCP face inherited it, so an MCP client on `till up` that was not
 * literally `till-cli` (Claude Desktop, for one) was seated as the Studio and bypassed the A35 dial
 * and the trace entirely. Only `till serve` fell back to `agent`. `deps.actor` is therefore no longer
 * consulted by the MCP face at all: it is the REST face's actor and nothing else, which is what makes
 * the rule hold on every host without each host remembering it.
 */

import { AGENT_ACTOR, SEATED_ACTORS, SERVED_STRANGER_ACTOR, servedMemberActor } from '../core/access/index.js';
import type { SqliteStore } from '../core/store/sqlite-store.js';
import type { IdentitySource } from './served-mode.js';

/** The client name the Studio declares at `initialize`. */
export const STUDIO_CLIENT_NAME = 'till-studio';

/** The client name `till mcp` declares over stdio. */
export const AGENT_CLIENT_NAME = 'till-cli';

/** Client name -> audit actor. Closed on purpose: see the module note. */
const SESSION_ACTORS: ReadonlyMap<string, string> = new Map([
  [STUDIO_CLIENT_NAME, 'studio'],
  [AGENT_CLIENT_NAME, AGENT_ACTOR],
]);

/**
 * The mapping above and A24's `SEATED_ACTORS` must name the same actors, checked at module load.
 *
 * They live apart because the direction of the module graph says so: the client-name mapping is an
 * API-layer concern, while `seatFirstOwner` in core is what has to enumerate the actors a
 * provisioning seats. Under D50 a missing actor is no longer a cosmetic inconsistency: an actor this
 * file can mint but core does not seat is an actor that loses every write the moment someone invites
 * a colleague, which is exactly the silent lockout D50 was decided to end. So it is a crash on
 * import rather than a comment asking two files to be edited together.
 */
{
  const mapped = [...new Set(SESSION_ACTORS.values())].sort();
  const seated = [...SEATED_ACTORS].sort();
  if (mapped.join(',') !== seated.join(',')) {
    throw new Error(
      `D13/A24: the session actors [${mapped.join(', ')}] and the seated actors [${seated.join(', ')}] ` +
        'have drifted. An actor a session can mint but a provisioning does not seat loses every write ' +
        'the first time anyone is invited (see seatFirstOwner).',
    );
  }
}

/**
 * The actor for a session, from the client identity captured at `initialize`: the seating rule
 * above. An unrecognised client is an `agent`, unconditionally. That is the conservative reading:
 * the column exists so a human action can be told from a machine one, and guessing "human" is the
 * expensive mistake (it is also the mistake that seats the machine outside the dial).
 *
 * There is deliberately NO fallback parameter any more. A host has no business choosing who an
 * unknown MCP client is: the rule is the transport's, and the only two seats it can hand out are the
 * two the closed map names.
 */
export function resolveSessionActor(clientInfo: { name?: string } | undefined): string {
  const name = clientInfo?.name;
  if (name === undefined) return AGENT_ACTOR;
  return SESSION_ACTORS.get(name) ?? AGENT_ACTOR;
}

/**
 * M01: the served identity a proxy-attested subject resolves to. `identitySource` is always
 * `served_subject` here (this function is only reached in served mode); `known` distinguishes a seated
 * member from a stranger, and `subject` is echoed so `whoami` can name it.
 */
export interface ServedIdentity {
  readonly subject: string;
  /** `member:<user_id>` when the subject is a bound member, else `SERVED_STRANGER_ACTOR`. */
  readonly actor: string;
  readonly identitySource: IdentitySource;
  /** True iff a `user` row is bound to this subject (i.e. an invite was accepted in served mode). */
  readonly known: boolean;
}

/**
 * Map a proxy-attested subject onto the D13 actor slot, per D105. This is the drop-in the module note
 * describes: the actor is a STRING, so `member:<user_id>` occupies the same slot `studio`/`agent` do
 * and NO call site changes.
 *
 * A subject with a bound `user.subject` resolves to `member:<user_id>` (which equals that user's
 * `actor_id`, so `memberFor` resolves it with no new query). A subject bound to NO user is a stranger:
 * authenticated by the proxy but unknown to this deployment, resolved to `SERVED_STRANGER_ACTOR`, which
 * is seated nowhere and holds nothing (`capability.ts` denies it even on an unprovisioned workspace).
 * Nothing is auto-provisioned: a stranger becomes known only by accepting an invite.
 */
export function resolveServedActor(store: SqliteStore, subject: string): ServedIdentity {
  const row = store.db.prepare('SELECT id FROM user WHERE subject = ?').get(subject) as
    | { id: string }
    | undefined;
  if (row === undefined) {
    return { subject, actor: SERVED_STRANGER_ACTOR, identitySource: 'served_subject', known: false };
  }
  return { subject, actor: servedMemberActor(row.id), identitySource: 'served_subject', known: true };
}
