/**
 * D13's actor set, in core, because A24 provisioning has to seat all of it.
 *
 * WHY THE SET MOVED HERE. `src/api/session.ts` maps a client name to an actor and is the file that
 * decided the set. But `seatFirstOwner` in `core/access/members.ts` is what has to enumerate it, and
 * core importing `src/api/` would invert the dependency the whole module graph is arranged around.
 * So the SET lives here and `session.ts` is checked against it at load: the mapping still belongs to
 * the API layer, the membership question belongs to core, and the two cannot drift apart in silence.
 *
 * WHAT THIS SET MEANS, and it is narrower than it looks. These are TRANSPORTS, not people. `studio`
 * is a human at the Studio, `agent` is whatever reached the MCP socket. A24 has no authentication
 * and cannot acquire any inside an MIT local-first core: the closed set is the honest ceiling on how
 * finely this engine can attribute anything, and it is why a real named subject (`treuhand:mueller`)
 * is a string in this same slot rather than a new concept.
 */

/** The D13 actors a first provisioning seats as `owner`. See `seatFirstOwner` for why all of them. */
export const SEATED_ACTORS: readonly string[] = ['studio', 'agent'];

/**
 * M01: HOW the system established who a caller is. §H-ENUM, owned HERE next to the D13 actor set (this
 * IS "the D13 map" in core), because an audit row is forever and the vocabulary that describes how
 * identity was established cannot be workspace-configurable. `session.ts` resolves the actor; this
 * names the provenance the actor carries. The type lives in core so `WorkspaceContext` can carry it
 * without core importing the api layer; `src/api/served-mode.ts` re-exports it for api consumers.
 *
 *  - `local_client`: D13 resolution on this machine (`studio` / `agent` / an embedder actor). No proxy
 *    vouched for anyone.
 *  - `served_subject`: an authenticating reverse proxy attested the subject and served mode is on.
 */
export type IdentitySource = 'local_client' | 'served_subject';

/** Every legal identity source, for exhaustive rendering and validation. */
export const IDENTITY_SOURCES: readonly IdentitySource[] = ['local_client', 'served_subject'];

/**
 * THE GOVERNED SEAT (D13 / A35). `agent` is the actor every MCP client resolves to (and the
 * fallback for an unrecognised client), and since A35 wired the dial into the transport dispatch it
 * is the seat the dial GOVERNS. Named here so the one rule that depends on it, "the governed seat
 * never holds its own governor" (`manage_agent_dial`, see `capability.ts`), is written against a
 * constant and not a string literal.
 */
export const AGENT_ACTOR = 'agent';

/**
 * M01 US-M01.3 / F-08 (d): WHAT KIND OF PRINCIPAL A MEMBER IS. §H-ENUM, closed here beside the D13 set.
 *
 * `user.kind` says whether an identity is a person or a machine. It exists because the governed seat
 * is otherwise a property of ONE actor string: locally the machine is always `agent`, but over the
 * served door every member (person or agent) stamps `member:<user_id>`, and `isAgentSeat` written as
 * `actor === 'agent'` seated a served agent member OUTSIDE the dial and the trace (its `post_entry`
 * executed at `ask`, untraced). The kind is set at invite time by the human who invites the agent, is
 * never self-declared by the session, and is what `isGovernedSeat` (capability.ts) reads.
 */
export type MemberKind = 'human' | 'agent';

/** Every legal member kind, for validation and exhaustive rendering. */
export const MEMBER_KINDS: readonly MemberKind[] = ['human', 'agent'];

export function isMemberKind(value: unknown): value is MemberKind {
  return value === 'human' || value === 'agent';
}

const SEATED_SET: ReadonlySet<string> = new Set(SEATED_ACTORS);

export function isSeatedActor(actor: unknown): boolean {
  return typeof actor === 'string' && SEATED_SET.has(actor);
}

/**
 * M01 (served access): the actor string a served member stamps with.
 *
 * THE STRING IS `member:<user_id>`, DELIBERATELY, AND IT EQUALS `user.actor_id`. D13's actor was
 * always a STRING rather than a human/agent flag exactly so a real named subject could drop into the
 * same slot with no call site changing (see `session.ts`). A served member's actor is derived from
 * its `user.id` rather than from its email, so the stamp is STABLE across an email or subject change:
 * the `user` row carries the human-readable subject, the audit column carries the id. `acceptInvite`
 * in served mode writes exactly this string into `user.actor_id`, so `memberFor`'s existing
 * `user.actor_id = ?` join resolves a served member with no new query and no second resolver.
 */
export const SERVED_MEMBER_ACTOR_PREFIX = 'member:';

/** The actor a served member id resolves to. Single-sourced so `session.ts` and `members.ts` agree. */
export function servedMemberActor(userId: string): string {
  return `${SERVED_MEMBER_ACTOR_PREFIX}${userId}`;
}

/**
 * THE SERVED STRANGER. A request in served mode whose proxy-attested subject matches NO `user.subject`
 * is authenticated (the proxy vouched for it) but UNKNOWN to this deployment. It resolves to this one
 * reserved actor, which is not seated and is bound to no `user` row, so `memberFor` finds nothing and
 * every gate denies it.
 *
 * IT IS GUARDED IN `capability.ts` BEFORE THE UNPROVISIONED GRANT, which is the whole point: an
 * unrecognised subject must never be auto-provisioned into a privileged seat, not even on a workspace
 * nobody has claimed yet. A served deployment is provisioned LOCALLY first (holding the SQLite file is
 * the trust boundary), and membership is granted by invite, never by showing up authenticated. The
 * ungated `whoami` still answers (so the "signed in, not a member" state can render) and the
 * token-authenticated `accept_invite` still works (that is how a stranger becomes known).
 */
export const SERVED_STRANGER_ACTOR = 'served:stranger';

/**
 * Every actor a provisioning seats, with the CALLER first.
 *
 * The caller leads so its member id is the first one minted, which keeps the id a caller sees for
 * itself stable and keeps `inviteMember`'s own return value describing the person who called it. An
 * actor outside D13's closed set (an embedder that built its own context, `system`) is seated too
 * rather than being locked out of the workspace it just claimed.
 */
export function seatingOrder(callerActor: string): readonly string[] {
  return [callerActor, ...SEATED_ACTORS.filter((a) => a !== callerActor)];
}
