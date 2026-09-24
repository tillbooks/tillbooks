/**
 * A24 §4, the single authorization decision point.
 *
 * `capabilityFor` is the ONLY place in this repo that answers "may this actor do this?", and
 * everything else (the registry boundary, the twelve in-engine `ctx.capabilities.assert(...)` call
 * sites, the Studio's pre-disabling) is a caller of it. A second resolver is the one thing §6b
 * forbids outright, because two resolvers drift the first time only one is corrected.
 *
 * THE RESOLUTION ORDER IS THE DESIGN, so it is written as a list and not as a paragraph:
 *
 *   1. The workspace has NO members at all       -> granted to a LOCAL actor only. See below.
 *   2. The actor is not an accepted member       -> denied, with `role: null`.
 *   3. The actor's role is `owner`               -> granted, without touching `role_def`.
 *   4. The actor's role is `viewer`              -> the READ domains, without touching `role_def`.
 *   5. Otherwise                                 -> the role's resolved capability array decides.
 *
 * Steps 3 and 4 are the two compile-time anchors, and they run BEFORE any query on purpose: a
 * `role_def` row named `owner` or `viewer` can therefore never shadow either, whether it arrived by
 * a bug, by a migration, or by someone editing the SQLite file with a text editor. `defineRole`
 * also rejects both by name, but that is the policy half; this ordering is the structural half, and
 * it is the half that still holds when the policy half is wrong.
 *
 * WHY AN UNPROVISIONED WORKSPACE GRANTS EVERYTHING (step 1), stated as a decision rather than left
 * as a default. A workspace with zero rows in `workspace_member` has never been claimed by anyone.
 * That is the state of every workspace that exists today, because this capability is the first
 * thing that ever writes such a row, and it is the persona-F solo-owner case the spec header calls
 * degenerate: one person, one machine, one file, and the file itself is the security boundary.
 * Denying there would lock every existing book out of its own ledger on the next release, and
 * inviting a phantom owner row into fifteen shipped capabilities' databases behind a migration
 * would be a worse answer to a question nobody asked. From the moment ONE member row exists the
 * matrix is authoritative, and `revoke_member` refuses `last_owner`, so a provisioned workspace can
 * never be walked back into the ungated state.
 *
 * THIS GRANT IS LOCAL-ONLY (M01 critic F1). "The file itself is the security boundary" is a fact about
 * the process that opened the SQLite file, so the unprovisioned grant is extended ONLY to a LOCAL actor
 * (`identitySource` absent or `local_client`). A SERVED subject reaches this engine across a proxy and
 * does NOT hold the file, so it is denied the grant and falls through to the membership resolution: a
 * served member of another mandate is a non-member of an unprovisioned workspace, not its owner.
 *
 * WHAT THIS DOES NOT DEFEND, said plainly. An embedder that builds its own `WorkspaceContext` with
 * `makeContext` and no `capabilities` override still gets `allowAllCapabilities` from
 * `core/ports.ts`. That is the trust boundary rather than a hole: a host holding the SQLite file
 * already holds the ledger, and an MIT library cannot defend a file from the process that opened
 * it. The surface this closes is the AGENT surface, which has exactly two doors (MCP stdio and the
 * REST twins) and both go through `src/api/registry.ts`.
 */

import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { SqliteStore } from '../store/sqlite-store.js';
import type { CapabilityPort } from '../ports.js';
import { AGENT_ACTOR, SERVED_STRANGER_ACTOR } from './actors.js';
import type { IdentitySource } from './actors.js';
import type { Capability } from './capabilities.js';
import {
  CAPABILITY_IDS,
  OWNER_ROLE,
  VIEWER_CAPABILITIES,
  VIEWER_ROLE,
  defaultCapabilitiesFor,
  isCapability,
} from './capabilities.js';

/** One accepted or pending membership, as the resolver reads it. */
export interface MemberBinding {
  memberId: string;
  userId: string;
  role: string;
  accepted: boolean;
}

/**
 * Has anyone claimed this workspace? §H-TENANT: the workspace is the whole predicate.
 *
 * ANY row counts, pending included, because `inviteMember` seats EVERY D13 actor as `owner` before
 * it writes the invitee's row (see `seatFirstOwner` in `members.ts`, and D50 for why all of them
 * rather than only the caller). So by the time a pending row exists there are always accepted owners
 * beside it, and "a workspace with a pending invite and nobody in charge" is a state this engine
 * cannot produce. `defineRole` deliberately does NOT provision: reshaping a bundle nobody holds yet
 * should not be the act that locks a workspace down.
 */
export function isProvisioned(store: SqliteStore, workspaceId: string): boolean {
  const row = store.db
    .prepare('SELECT 1 AS present FROM workspace_member WHERE workspace_id = ? LIMIT 1')
    .get(workspaceId) as { present: number } | undefined;
  return row !== undefined;
}

/**
 * The membership an ACTOR resolves to in a workspace, or undefined.
 *
 * The join is `user.actor_id = ?`, which is where D13's session actor meets A24's identity. A user
 * row whose `actor_id` is still NULL (invited, never accepted) matches nothing, which is the same
 * answer as "not a member" and is the right one: a pending invitee holds no capability.
 */
export function memberFor(
  store: SqliteStore,
  workspaceId: string,
  actor: string,
): MemberBinding | undefined {
  const row = store.db
    .prepare(
      `SELECT m.id AS member_id, m.user_id, m.role, m.accepted_at
         FROM workspace_member m
         JOIN user u ON u.id = m.user_id
        WHERE m.workspace_id = ? AND u.actor_id = ?`,
    )
    .get(workspaceId, actor) as
    | { member_id: string; user_id: string; role: string; accepted_at: string | null }
    | undefined;
  if (row === undefined) return undefined;
  return {
    memberId: row.member_id,
    userId: row.user_id,
    role: row.role,
    accepted: row.accepted_at !== null,
  };
}

/**
 * The capability array a ROLE resolves to, built-in or custom.
 *
 * `owner` and `viewer` never reach here from `capabilityFor` (they short-circuit above), but they
 * are answered anyway so `whoami` and the Roles tab can render the two fixed bundles without a
 * second code path that could disagree with the first.
 *
 * An editable built-in with no `role_def` row resolves to its code-level default. The row is a
 * MATERIALISATION of that default rather than a change of meaning, which is why the seed in
 * `roles.ts` is allowed to be lazy: a workspace created before this capability existed reads
 * exactly the same bundle whether or not anyone has opened the Roles tab yet.
 */
export function resolveCapabilities(
  store: SqliteStore,
  workspaceId: string,
  roleId: string,
): readonly Capability[] {
  if (roleId === OWNER_ROLE) return CAPABILITY_IDS;
  if (roleId === VIEWER_ROLE) return VIEWER_CAPABILITIES;

  const row = store.db
    .prepare('SELECT capabilities_json, archived FROM role_def WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, roleId) as { capabilities_json: string; archived: number } | undefined;

  if (row !== undefined) return parseCapabilities(row.capabilities_json);

  // No stored bundle. An editable built-in falls back to its shipped default; an unknown role id
  // (a custom role whose row was removed out from under a member) resolves to NOTHING rather than
  // to everything. Failing closed on a dangling grant is the only safe direction here.
  return defaultCapabilitiesFor(roleId) ?? [];
}

/**
 * Read a stored bundle, dropping any entry that is no longer a registry member.
 *
 * A stored capability the registry has since retired must not resolve. Silently dropping it is the
 * conservative reading and matches the fail-closed direction above: the alternative is a grant that
 * outlives the check it was named for.
 */
export function parseCapabilities(json: string): readonly Capability[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isCapability);
}

/**
 * THE GOVERNED SEAT (A35 / M01 US-M01.3 / F-08 d), the ONE rule every consumer reads.
 *
 * A seat is governed (the dial routes its writes, the trace records its calls, it never holds its own
 * governor) when it is the local D13 `agent` actor, OR when its `user` row is of kind `agent`: a
 * served agent member stamps `member:<user_id>` like any member (US-M01.3, so A03 attributes its rows
 * to IT), and it is the kind, not the actor string, that says it is a machine. Consumers:
 * `runGoverned` (the transport dispatch), step 0 below, `whoami`'s advertisement, and the dial
 * writer's self-grant refusals. Written once here so they cannot drift apart: the pre-F-08 defect was
 * exactly one of them (`isAgentSeat`) answering `actor === 'agent'` alone.
 *
 * One indexed lookup (`user_by_actor`); `agent` short-circuits before it. A stranger and an actor with
 * no `user` row are not governed (they hold nothing anyway).
 */
export function isGovernedSeat(store: SqliteStore, actor: string): boolean {
  if (actor === AGENT_ACTOR) return true;
  const row = store.db.prepare('SELECT kind FROM user WHERE actor_id = ?').get(actor) as { kind: string } | undefined;
  return row?.kind === 'agent';
}

/** The decision, in the order the module note lists. */
export function capabilityFor(
  store: SqliteStore,
  workspaceId: string,
  actor: string,
  capability: string,
  identitySource?: IdentitySource,
): boolean {
  // STEP 0 (A35 critic F1, 18.08.2026): THE GOVERNED SEAT NEVER HOLDS ITS OWN GOVERNOR.
  // `manage_agent_dial` arms and disarms unattended agent execution, approves and rejects drafted
  // actions, and erases conversation prose. Since A35 wired the dial into the transport dispatch,
  // this capability is the ONLY thing standing between the `agent` seat and an unapproved
  // `post_entry` / `vat_mark_filed` / `install_plugin`, so the seat it governs is denied it before
  // every other step: before the unprovisioned grant (a fresh workspace must not hand the agent its
  // own dial) and before any role resolution (`seatFirstOwner` seats `agent` as owner, and an owner
  // holds everything ELSE). This is the same actor-not-capability shape as the self-approve ban.
  // F-08 (d): the rule reads the GOVERNED SEAT, not the one actor string, so a served member of kind
  // `agent` is denied its governor exactly as the local `agent` is. Capability first, so the lookup
  // runs only on the one capability it decides.
  if (capability === 'manage_agent_dial' && isGovernedSeat(store, actor)) return false;

  // STEP 0-b (M01, served access): THE SERVED STRANGER HOLDS NOTHING, EVEN ON AN UNPROVISIONED
  // WORKSPACE. A request in served mode whose proxy-attested subject matches no `user.subject` is
  // authenticated but UNKNOWN to this deployment (see `SERVED_STRANGER_ACTOR`, `session.ts`). It must
  // never be auto-provisioned into a privileged seat, so it is denied BEFORE the unprovisioned grant:
  // a served deployment is provisioned locally first (holding the SQLite file is the trust boundary,
  // as `capabilityPort`'s note above spells out), and membership is granted by invite, never by
  // showing up authenticated. `whoami` still answers (it is ungated and short-circuits this), and
  // `accept_invite` is a pre-workspace `depsAction` that never reaches this decision, so a stranger
  // can still learn its state and redeem an invite. Nothing else resolves to anything.
  if (actor === SERVED_STRANGER_ACTOR) return false;

  // STEP 1 (M01 critic F1, 18.08.2026): AN UNPROVISIONED WORKSPACE GRANTS EVERYTHING ONLY TO A LOCAL
  // ACTOR, the operator who physically holds the SQLite file. The "unprovisioned => grant" degenerate
  // case (see the module note) is a LOCAL fact: "the file itself is the security boundary" is true only
  // of the process that opened the file, and that reasoning does NOT survive the served trust boundary.
  // A SERVED subject reaches this engine across an authenticating reverse proxy and does NOT hold the
  // file, so it must NEVER receive the blanket grant. Without this gate a served member of ONE mandate
  // (`member:<user_id>`, which is not the stranger denied at step 0-b) would fall through to the grant
  // and hold FULL OWNER on any workspace that had not yet had its first invite: the cross-tenant break
  // M01 exists to prevent (§H-TENANT). A served identity instead falls through to the A24 membership
  // resolution below, which denies a non-member of THIS workspace. `identitySource` is absent only on a
  // LOCAL path (the transports set it to `served_subject` for every served request), so `!== served`
  // preserves the local solo-owner first-run/create/restore/adopt behaviour exactly.
  if (!isProvisioned(store, workspaceId)) return identitySource !== 'served_subject';

  const member = memberFor(store, workspaceId, actor);
  if (member === undefined || !member.accepted) return false;

  if (member.role === OWNER_ROLE) return true;
  // NOT a flat `false` any more. Reads are gated as of D50, so a viewer that resolved to nothing
  // would be a read-only invite that reads nothing. Still a compile-time constant answered before
  // any `role_def` query, so the anchor is as unshadowable as it was when it was `false`.
  if (member.role === VIEWER_ROLE) return VIEWER_CAPABILITIES.includes(capability as Capability);

  return resolveCapabilities(store, workspaceId, member.role).includes(capability as Capability);
}

/**
 * The P9 rejection every denied call returns, on both faces, with the two fields a caller can act
 * on: WHICH capability was missing and WHICH role the actor holds. `role` is null when the actor is
 * not a member at all, which is a different fact from holding a role that lacks the capability, and
 * the Studio says the two differently.
 */
export function assertCapability(
  store: SqliteStore,
  workspaceId: string,
  actor: string,
  capability: string,
  identitySource?: IdentitySource,
): Result {
  if (capabilityFor(store, workspaceId, actor, capability, identitySource)) return ok();
  const member = memberFor(store, workspaceId, actor);
  return err('permission_denied', {
    capability,
    role: member !== undefined && member.accepted ? member.role : null,
  });
}

/**
 * The real `CapabilityPort`, replacing `allowAllCapabilities` at `ctxOf` in `src/api/registry.ts`.
 *
 * Bound per request to one store, one workspace and one actor, so the twelve engine call sites keep
 * their one-argument `assert(capability)` signature and not one of them changes.
 */
export function capabilityPort(
  store: SqliteStore,
  workspaceId: string,
  actor: string,
  identitySource?: IdentitySource,
): CapabilityPort {
  return {
    assert: (capability: string) => assertCapability(store, workspaceId, actor, capability, identitySource),
  };
}
