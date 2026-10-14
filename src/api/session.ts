/**
 * D13: who a session's calls are attributed to in the audit trail.
 *
 * The actor is declared ONCE, when a session opens, and every call in that session inherits it.
 * Without this, collapsing the Studio onto the MCP path (D12) would stamp every human action as
 * `agent` and hollow out the most useful column a Treuhänder reads.
 *
 * Two alternatives were rejected. A per-CALL actor lets a client claim any actor on any call, which
 * is no guarantee at all under an audit trail. Recording only the transport is honest but throws
 * away the human-versus-agent answer entirely.
 *
 * The set of actors a local session can be seated as is CLOSED and decided in advance. The value is
 * a STRING, not a human/agent flag, which is what lets a real named user (`treuhand:mueller`) drop in
 * later behind authentication without touching a single call site.
 *
 * THE SEATING RULE (F-08, 2026-09-05; bound to the Studio key on 2026-10-12), stated once, here, and
 * consumed by every host:
 *
 *   The human `studio` seat is held ONLY by a request that presents this launch's STUDIO KEY,
 *   compared in constant time. Every other local caller is the governed `agent` seat over `/mcp`,
 *   whatever name it declares, and is refused on the REST bridge. Over the served door the seat is
 *   the member the proxy attested, and a member of kind `agent` is the governed seat
 *   (`isGovernedSeat`, core).
 *
 * WHY A KEY AND NOT A NAME (critic probe P6, 2026-10-12). Until then the Studio was whoever declared
 * `clientInfo.name: 'till-studio'` at `initialize`, and the REST twins on `till up` were `studio` for
 * ANY caller. A name is a claim the client CHOOSES, not a credential: any MCP client could name itself
 * `till-studio` and every governed write ran with no Vorschlag, and any local process could POST
 * `/api/issue_invoice` as the human. The Host/Origin guard (`local-guard.ts`) stops a browser page,
 * not a local program. The client name never GRANTS a seat: it is a label in the trace
 * (`agentClientLabel`), and the one thing it can still do is LOSE one: a local `/mcp` session that
 * declares the Studio's name without the key is refused (`studio_key_required`), so a Studio tab that
 * has no key says so instead of quietly working as the agent.
 *
 * THE STUDIO KEY, delivered OUT OF BAND (critic R3-B2, owner decision 2026-10-12, the Jupyter-token
 * pattern). A host that serves the Studio (`till up`, the Vite dev bridge) mints 32 random bytes at
 * start and hands them to the PERSON, never to the page: it prints and opens
 * `http://localhost:PORT/#k=<key>`. A URL fragment is never sent to a server, so the browser alone
 * learns the key; the Studio moves it into `sessionStorage` and strips the fragment. The served HTML
 * carries no key in any mode, so a program that fetches `/` (a fetch tool, a scraper, curl) learns
 * nothing. The first version wrote the key into the page as a `<meta>` tag, and any local HTTP client
 * could read it there and issue an invoice with 0 Vorschläge (R3-B2). The Studio sends the key back
 * in a request HEADER on every engine call (`STUDIO_KEY_HEADER`); `up.ts` says why a header beat a
 * cookie. A restart mints a new key, and an open tab then shows how to get back in (re-open the link).
 * What the key does NOT stop is stated as plainly: a process that can read this user's files or
 * drive this user's own browser tab can find the key, which is the approval claim's scope sentence.
 *
 * The rule used to take a HOST-SUPPLIED fallback: `till up` and the Vite dev bridge passed `studio`
 * (their REST face's actor) and the MCP face inherited it. `deps.actor` is not consulted by either
 * local face for the seat any more.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { AGENT_ACTOR, SEATED_ACTORS, SERVED_STRANGER_ACTOR, servedMemberActor } from '../core/access/index.js';
import type { SqliteStore } from '../core/store/sqlite-store.js';
import type { IdentitySource } from './served-mode.js';

/**
 * The client name the Studio declares at `initialize`. A LABEL, never a seat: declaring it buys a
 * client nothing (see the module note).
 */
export const STUDIO_CLIENT_NAME = 'till-studio';

/** The client name `till mcp` declares over stdio. */
export const AGENT_CLIENT_NAME = 'till-cli';

/** The human seat. Held only with the per-launch Studio key, never by a name. */
export const STUDIO_ACTOR = 'studio';

/**
 * The request header that carries the Studio key. A CUSTOM header on purpose: a cross-origin page
 * cannot attach one without a CORS preflight, and no face of this server answers a preflight, so the
 * key (unlike a cookie) never rides on a request another origin started.
 */
export const STUDIO_KEY_HEADER = 'x-till-studio-key';

/**
 * The URL-fragment parameter the launcher hands the key to the browser in: `/#k=<key>`. A fragment
 * never leaves the browser, which is the whole point (`app/src/lib/studio-key.ts` reads it).
 */
export const STUDIO_KEY_FRAGMENT = 'k';

/** The link a person opens the Studio through: the base URL plus the key in the fragment. */
export function studioLink(baseUrl: string, studioKey: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/#${STUDIO_KEY_FRAGMENT}=${studioKey}`;
}

/** The key's entropy in bytes: 256 bits. */
export const STUDIO_KEY_BYTES = 32;

/** Mint a fresh Studio key: 32 bytes from the OS CSPRNG, base64url so it is safe in HTML and HTTP. */
export function mintStudioKey(): string {
  return randomBytes(STUDIO_KEY_BYTES).toString('base64url');
}

/**
 * Is `key` acceptable as a Studio key a host was HANDED rather than minted (the dev bridge's
 * `TILL_STUDIO_KEY`)? base64url only, and at least as much entropy as a minted one, so a short or
 * hand-typed value cannot quietly weaken the seat.
 */
export function isWellFormedStudioKey(key: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(key) && Buffer.from(key, 'base64url').length >= STUDIO_KEY_BYTES;
}

/** What a request presented: this launch's key, no key at all, or a key that is not this launch's. */
export type StudioKeyCheck = 'valid' | 'absent' | 'invalid';

/** Just the header shape the check reads, so it takes a real `IncomingMessage` or a stub. */
export interface StudioKeyHeaders {
  [name: string]: string | string[] | undefined;
}

/**
 * Check the Studio key a request carries against the host's own, in CONSTANT TIME.
 *
 * Both sides are hashed to SHA-256 first, so `timingSafeEqual` always compares 32 bytes with 32 bytes:
 * neither the content nor the LENGTH of the real key leaks through how long a refusal takes. A host
 * with no key (`till serve`, which serves no Studio) treats ANY presented key as `invalid`: there is
 * no Studio on that host to be. A repeated header is `invalid`, never "the first one wins".
 */
export function checkStudioKey(headers: StudioKeyHeaders, hostKey: string | undefined): StudioKeyCheck {
  const raw = headers[STUDIO_KEY_HEADER];
  if (raw === undefined) return 'absent';
  if (Array.isArray(raw) || hostKey === undefined || hostKey === '') return 'invalid';
  const presented = createHash('sha256').update(raw, 'utf8').digest();
  const expected = createHash('sha256').update(hostKey, 'utf8').digest();
  return timingSafeEqual(presented, expected) ? 'valid' : 'invalid';
}

/**
 * Every actor a local session can be seated as: the key-bound human seat and the governed seat.
 *
 * It must name the same actors as A24's `SEATED_ACTORS`, checked at module load. They live apart
 * because the direction of the module graph says so: seating is an API-layer concern, while
 * `seatFirstOwner` in core is what has to enumerate the actors a provisioning seats. Under D50 a
 * missing actor is no longer a cosmetic inconsistency: an actor this file can mint but core does not
 * seat is an actor that loses every write the moment someone invites a colleague, which is exactly
 * the silent lockout D50 was decided to end. So it is a crash on import rather than a comment asking
 * two files to be edited together.
 */
const SESSION_ACTORS: readonly string[] = [STUDIO_ACTOR, AGENT_ACTOR];
{
  const mapped = [...new Set(SESSION_ACTORS)].sort();
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
 * The actor for a local session: the seating rule above. `studio` iff the session was opened with
 * this launch's Studio key; `agent` otherwise, unconditionally, WHATEVER the client declared. That is
 * the conservative reading: the column exists so a human action can be told from a machine one, and
 * guessing "human" is the expensive mistake (it is also the mistake that seats the machine outside the
 * dial).
 *
 * `clientInfo` is still accepted so a caller holding it can pass it, but it is NEVER read for the
 * seat: a name is a claim, the key is the credential. The key check defaults to `absent`, so a caller
 * that forgets to check the key fails closed onto the governed seat.
 */
export function resolveSessionActor(
  _clientInfo: { name?: string } | undefined,
  studioKey: StudioKeyCheck = 'absent',
): string {
  return studioKey === 'valid' ? STUDIO_ACTOR : AGENT_ACTOR;
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
 *
 * F-11 critic F2: the match is CASE-INSENSITIVE (`lower(subject)`), because `acceptInvite` already
 * treats the two casings as one identity (the attested subject is compared `toLowerCase()` against the
 * lowercased invite email). Matching exactly here while accepting case-insensitively made a member
 * attested `Bob@Treuhand.ch` a stranger when the IdP later sent `bob@treuhand.ch`, and locked whichever
 * casing was stored last out of every mandate at once. The partial `user_by_subject` index is over
 * `lower(subject)` so the lookup stays indexed and one identity cannot be bound to two case-variants.
 */
export function resolveServedActor(store: SqliteStore, subject: string): ServedIdentity {
  const row = store.db.prepare('SELECT id FROM user WHERE lower(subject) = lower(?)').get(subject) as
    | { id: string }
    | undefined;
  if (row === undefined) {
    return { subject, actor: SERVED_STRANGER_ACTOR, identitySource: 'served_subject', known: false };
  }
  return { subject, actor: servedMemberActor(row.id), identitySource: 'served_subject', known: true };
}
