/**
 * A24 §4, membership: `whoami`, `listMembers`, `inviteMember`, `acceptInvite`, `setRole`,
 * `revokeMember`.
 *
 * `whoami` IS THE STUDIO'S ONLY PERMISSION SOURCE, and that is worth stating here because the
 * alternative already shipped and was wrong. Three Studio gates used to read `body.canPost`,
 * `body.canManage` and `body.canUnlock` off `list_journal` and `list_period_locks`. No payload has
 * ever carried any of the three, so each expression evaluated `undefined !== false` and every gate
 * stood open in every build. The lesson is not "declare the payload" (that is how they were found);
 * it is that a permission answer must come from ONE verb whose job is to answer it, rather than
 * being bolted onto whatever list happened to be on screen. `whoami` is that verb, and no other
 * payload in this repo will carry a permission field.
 *
 * A PENDING MEMBER HOLDS NOTHING. `accepted_at IS NULL` resolves exactly like "not a member" in
 * `capability.ts`, so an invite grants no access until it is redeemed. That matters more here than
 * it looks: the invite is delivered by the operator (P8, there is no transport in the MIT core), so
 * the window between writing the row and the invitee actually holding the grant can be days.
 */

import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { WorkspaceContext } from '../context.js';
import type { SqliteStore } from '../store/sqlite-store.js';
import type { Clock } from '../clock.js';
import type { IdGen } from '../ids.js';
import { requireString, optionalId, optionalText } from '../ledger/inputGuards.js';
import type { Capability } from './capabilities.js';
import { CAPABILITY_IDS, OWNER_ROLE } from './capabilities.js';
import { isMemberKind, MEMBER_KINDS, seatingOrder, SERVED_STRANGER_ACTOR, servedMemberActor } from './actors.js';
import type { MemberKind } from './actors.js';
import { isGovernedSeat, isProvisioned, memberFor, resolveCapabilities } from './capability.js';
import { isAssignableRole } from './roles.js';
import { DIAL_CAPABILITIES, effectiveDialLevel } from '../agent/dial.js';
import type { DialLevel } from '../agent/dial.js';

/** How long an unredeemed invite stays valid, in days. */
export const INVITE_VALIDITY_DAYS = 14;

export interface MemberView {
  memberId: string;
  userId: string;
  email: string | null;
  displayName: string | null;
  /** The D13 session actor this member is recognised by, or null while the invite is pending. */
  actorId: string | null;
  /** M01 US-M01.3: a person or a machine. An `agent` member is the governed seat (F-08 d). */
  kind: MemberKind;
  role: string;
  status: 'pending' | 'active';
  invitedAt: string;
  acceptedAt: string | null;
}

interface MemberRow {
  member_id: string;
  user_id: string;
  email: string | null;
  display_name: string | null;
  actor_id: string | null;
  kind: string;
  role: string;
  invited_at: string;
  accepted_at: string | null;
}

function toMemberView(row: MemberRow): MemberView {
  return {
    memberId: row.member_id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    actorId: row.actor_id,
    kind: isMemberKind(row.kind) ? row.kind : 'human',
    role: row.role,
    status: row.accepted_at === null ? 'pending' : 'active',
    invitedAt: row.invited_at,
    acceptedAt: row.accepted_at,
  };
}

/** §H-TENANT: the workspace is the whole predicate, never a filter applied afterwards. */
function readMembers(ctx: WorkspaceContext): MemberRow[] {
  return ctx.store.db
    .prepare(
      `SELECT m.id AS member_id, m.user_id, u.email, u.display_name, u.actor_id, u.kind,
              m.role, m.invited_at, m.accepted_at
         FROM workspace_member m
         JOIN user u ON u.id = m.user_id
        WHERE m.workspace_id = ?
        ORDER BY m.invited_at, m.id`,
    )
    .all(ctx.workspaceId) as MemberRow[];
}

/** How many ACCEPTED owners this workspace has. The `last_owner` rail reads exactly this. */
function acceptedOwnerCount(ctx: WorkspaceContext): number {
  const row = ctx.store.db
    .prepare(
      'SELECT COUNT(*) AS n FROM workspace_member WHERE workspace_id = ? AND role = ? AND accepted_at IS NOT NULL',
    )
    .get(ctx.workspaceId, OWNER_ROLE) as { n: number };
  return row.n;
}

/**
 * Does this actor hold an ACCEPTED membership in ANY workspace? (D111, served-mode create gate.)
 *
 * This is a membership-EXISTENCE query, deliberately NOT a second capability resolver (`capabilityFor`
 * stays the only place that answers "may this actor do X in workspace W"). It answers a different,
 * narrower question the pre-workspace `create_workspace` verb needs and cannot ask of `capabilityFor`,
 * because there is no workspace to resolve against yet: "is this subject seated ANYWHERE?"
 *
 * `accepted_at IS NOT NULL` is the same "seated, not merely pending" predicate `memberFor` uses: a
 * pending invitee holds nothing, so it is not "already seated in at least one workspace" (D111). The
 * join on `user.actor_id = ?` is the D13 seam A24 resolves on, so a served `member:<user_id>` matches
 * its own accepted rows and the `SERVED_STRANGER_ACTOR` sentinel (bound to no `user`) matches nothing.
 */
export function holdsAnyMembership(store: SqliteStore, actor: string): boolean {
  const row = store.db
    .prepare(
      `SELECT 1 AS present
         FROM workspace_member m
         JOIN user u ON u.id = m.user_id
        WHERE u.actor_id = ? AND m.accepted_at IS NOT NULL
        LIMIT 1`,
    )
    .get(actor) as { present: number } | undefined;
  return row !== undefined;
}

/**
 * Claim an unprovisioned workspace, seating EVERY D13 actor as an accepted `owner`.
 *
 * This is the one moment a workspace stops being ungated, and it is deliberately attached to the
 * FIRST INVITE rather than to a separate "claim" verb. An owner reaching for the Members screen to
 * add a bookkeeper is exactly the person who should be the owner, and asking them to first claim a
 * workspace they have been using alone for months is a step whose only content is a tautology. The
 * alternative, seating nobody, locks the operator out of their own books the instant the second
 * person is invited.
 *
 * WHY ALL OF THEM AND NOT JUST THE CALLER (D50, owner-decided 29.07.2026). Seating `ctx.actor` alone
 * was measurably a silent lockout, and it landed on the product's core promise. D13 models the actor
 * as the closed set `{studio, agent}`, so the owner's first invite FROM THE STUDIO made the matrix
 * authoritative with only `studio` in it, and every subsequent `till mcp` call lost every write:
 *
 *     agent post (unprovisioned) = true
 *     studio invite              = true
 *     agent post (after invite)  = false permission_denied capability=post role=null
 *
 * Nothing in the invite result, in `whoami` or on the Members surface said so. In an MCP-first
 * product that is the highest-traffic consequence of A24 landing at all.
 *
 * THE COST, WHICH IS REAL AND IS MADE VISIBLE RATHER THAN HIDDEN. The agent starts as an owner, so
 * whoever reaches the MCP socket holds every capability until the operator narrows them. That is
 * defensible only because holding the socket already means holding the SQLite file, which is the
 * same trust boundary the embedder argument in `capability.ts` rests on. It is NOT a reason to leave
 * anything else open, and it is not folklore: the agent is a row in `workspace_member`, so it shows
 * up on the Members surface with its own role selector and its own revoke button, exactly like a
 * person. Narrowing it to `agent` or `viewer`, or revoking it outright, is one click.
 *
 * IT COUNTS TOWARD `last_owner`, deliberately. The rail exists so a workspace can never reach a state
 * where nobody can grant `manage_members` again, and an accepted `owner` reachable over the MCP
 * socket is such a somebody. So after provisioning there are TWO accepted owners: the operator can
 * revoke the agent, and is then refused when they try to revoke themselves. That is the rail doing
 * its job, on a count that is now honest about who really holds the workspace.
 *
 * A no-op once any member row exists.
 */
export function seatFirstOwner(ctx: WorkspaceContext): string | undefined {
  if (isProvisioned(ctx.store, ctx.workspaceId)) return undefined;
  const now = ctx.clock.now();

  let callerMemberId: string | undefined;
  for (const actor of seatingOrder(ctx.actor)) {
    const memberId = seatOwner(ctx, actor, now);
    if (actor === ctx.actor) callerMemberId = memberId;
  }
  return callerMemberId;
}

/** One accepted `owner` row for one actor, reusing the actor's `user` row when it already has one. */
function seatOwner(ctx: WorkspaceContext, actor: string, now: string): string {
  const existing = ctx.store.db
    .prepare('SELECT id FROM user WHERE actor_id = ?')
    .get(actor) as { id: string } | undefined;
  const userId = existing?.id ?? ctx.ids.next('user');
  if (existing === undefined) {
    ctx.store.db
      .prepare('INSERT INTO user (id, actor_id, email, display_name, created_at) VALUES (?, ?, NULL, NULL, ?)')
      .run(userId, actor, now);
  }

  const memberId = ctx.ids.next('member');
  ctx.store.db
    .prepare(
      `INSERT INTO workspace_member (id, workspace_id, user_id, role, invited_at, accepted_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(memberId, ctx.workspaceId, userId, OWNER_ROLE, now, now, ctx.actor);
  // `actor` is who was SEATED; `ctx.actor` is who did the seating, and the audit column means the
  // latter. The seated identity is recoverable from the member row the entry points at.
  ctx.audit.record({
    entityKind: 'workspace_member',
    entityId: memberId,
    action: 'claim_owner',
    actor: ctx.actor,
    at: now,
  });
  return memberId;
}

/**
 * Who the caller is here, what role they hold, and exactly which capabilities that resolves to.
 *
 * `provisioned:false` is reported rather than hidden behind a synthetic owner grant, because the
 * Studio needs to say two different things: "you are the owner" and "nobody has claimed this
 * workspace yet, so everything is open and inviting anyone will make you the owner".
 */
export function whoami(ctx: WorkspaceContext): Result {
  // A35 critic F1: the ADVERTISEMENT stays honest with the decision point. `capabilityFor` runs a
  // step 0 that denies the governed seat its own governor (`manage_agent_dial`) before any role
  // resolution, so whoami subtracts the same capability for the same seat: a Studio (or any client)
  // reading whoami must never render a control the engine will refuse. F-08 (d): the seat is
  // `isGovernedSeat` (the local `agent` OR a served member of kind `agent`), the same rule step 0 reads.
  const governed = isGovernedSeat(ctx.store, ctx.actor);
  const advertise = (bundle: readonly Capability[]): readonly Capability[] =>
    governed ? bundle.filter((c) => c !== 'manage_agent_dial') : bundle;

  // F-08 / A35 critic F1's second honest route: THE GOVERNED SEAT MAY READ THE LEVELS THAT GOVERN IT,
  // without ever holding its governor. `get_agent_dial` stays denied to this seat (it is the owner's
  // view, rides `manage_agent_dial`, and carries the attribution rows); this is the levels ONLY, the
  // EFFECTIVE level per capability (what the next write will do: `auto` executes, `ask` drafts), and
  // it is attached to the one read every agent already makes first (J3.10, J5.1, J6.6 all open with
  // `whoami`). Chosen over a new verb because it adds no verb to the census, no second permission
  // question, and no round trip: the answer rides the call that asks "what may I do here". Absent for
  // every other seat, so a human's payload is byte-compatible with before.
  //
  // Governance critic F2 (2026-09-05): the dial is THIS workspace's configuration, and a governed seat
  // that is not seated here holds nothing (M01 F1, D111). So the levels are computed lazily and spread
  // on the SEATED branches only (the local unprovisioned owner and the accepted member), never on the
  // not-a-member branch: a served agent member of mandate A reading `whoami` on mandate B used to get
  // B's grants (`post: auto`) beside `role: null`, on `/mcp` and on the REST twin alike.
  const dialFor = (): { agentDial?: Record<string, DialLevel> } =>
    governed
      ? { agentDial: Object.fromEntries(DIAL_CAPABILITIES.map((c) => [c, effectiveDialLevel(ctx, c).effective])) }
      : {};

  // M01: the two additive fields every branch carries. `identitySource` defaults to `local_client`
  // (a laptop session), `subject` is the proxy-attested subject in served mode and null locally. Keys
  // are camelCase to match the existing `isMember`/`memberId` payload; the VALUES are the §H-ENUM
  // `IdentitySource` strings. Local payloads are byte-compatible except for these two fields.
  const identity = {
    identitySource: ctx.identitySource ?? 'local_client',
    subject: ctx.subject ?? null,
  } as const;

  // Read once and report the SAME value from every branch (§H-TENANT honesty): a served non-member of
  // an unprovisioned foreign workspace must not be told `provisioned:true`.
  const provisioned = isProvisioned(ctx.store, ctx.workspaceId);

  // M01: the SERVED STRANGER (authenticated by the proxy, matched to no `user.subject`) must read
  // exactly as "signed in, not a member", REGARDLESS of provisioning. `capabilityFor` denies it even
  // on an unprovisioned workspace (step 0-b), so advertising the open bundle here would be the exact
  // whoami-lies-to-the-Studio defect A35 F1 forbids. This is the one verb a stranger reaches, and it
  // must render the not-a-member state that names the subject and points at an invite (US-M01.4 error).
  if (ctx.actor === SERVED_STRANGER_ACTOR) {
    return ok({
      actor: ctx.actor,
      ...identity,
      provisioned,
      isMember: false,
      memberId: null,
      userId: null,
      role: null,
      capabilities: [] as readonly Capability[],
    });
  }

  // M01 critic F1: the unprovisioned OWNER advertisement is LOCAL-ONLY, mirroring `capabilityFor` step 1.
  // The open bundle exists for the persona-F solo owner who holds the SQLite file; a SERVED subject reaches
  // this engine across the proxy and does NOT hold the file, so a served member of ANOTHER mandate must
  // never be advertised owner on a workspace nobody has claimed yet. It falls through to `memberFor` below,
  // which finds no membership in THIS workspace and renders the not-a-member state. Advertising the owner
  // bundle to a served non-member here would be the whoami-lies-to-the-Studio defect A35 F1 forbids, and
  // the write it advertised would be refused by `capabilityFor` anyway.
  if (!provisioned && identity.identitySource === 'local_client') {
    return ok({
      actor: ctx.actor,
      ...identity,
      provisioned: false,
      isMember: false,
      memberId: null,
      userId: null,
      role: OWNER_ROLE,
      capabilities: advertise(CAPABILITY_IDS),
      ...dialFor(),
    });
  }

  const member = memberFor(ctx.store, ctx.workspaceId, ctx.actor);
  if (member === undefined || !member.accepted) {
    return ok({
      actor: ctx.actor,
      ...identity,
      provisioned,
      isMember: false,
      memberId: member?.memberId ?? null,
      userId: member?.userId ?? null,
      role: null,
      capabilities: [] as readonly Capability[],
      // No `agentDial` here (critic F2): a seat that holds nothing in this workspace reads none of
      // its configuration, the dial included.
    });
  }

  return ok({
    actor: ctx.actor,
    ...identity,
    provisioned,
    isMember: true,
    memberId: member.memberId,
    userId: member.userId,
    role: member.role,
    capabilities: advertise(resolveCapabilities(ctx.store, ctx.workspaceId, member.role)),
    ...dialFor(),
  });
}

/** Everyone bound to this workspace, pending invites included and labelled as such. */
export function listMembers(ctx: WorkspaceContext): Result {
  return ok({ members: readMembers(ctx).map(toMemberView) });
}

export interface InviteMemberInput {
  email?: string;
  role?: string;
  displayName?: string;
  /**
   * M01 US-M01.3 (F-08 d): `human` (default) or `agent`. The INVITER says what the invitee is; the
   * session that later accepts never declares it. An `agent` member is the governed seat wherever it
   * enters (the dial drafts its writes, the trace records its calls, it never holds `manage_agent_dial`).
   */
  kind?: string;
  idempotencyKey?: string;
}

/**
 * Write a pending membership and prepare the invite the OPERATOR delivers (P8, outbound).
 *
 * NOTHING IS SENT, and the answer says so. There is no transport in the MIT core (see
 * `EmailRelayPort` in `core/context.ts`: a local-first engine that shipped its own SMTP client
 * would be claiming a delivery guarantee it cannot make offline), so this returns the token and the
 * recipient and reports `delivery: 'prepared'`. Claiming a send TILL cannot observe is the exact
 * dishonesty `sendInvoice` already refuses.
 */
export function inviteMember(ctx: WorkspaceContext, input: InviteMemberInput): Result {
  const allowed = ctx.capabilities.assert('manage_members');
  if (!allowed.ok) return allowed;

  const guard =
    requireString(input.email, 'email') ??
    requireString(input.role, 'role') ??
    optionalText(input.displayName, 'displayName') ??
    optionalId(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const email = (input.email as string).trim().toLowerCase();
  const role = input.role as string;
  // §H-ENUM: an unknown kind is refused structurally (the `unknown_role` shape), never coerced.
  if (input.kind !== undefined && !isMemberKind(input.kind)) {
    return err('invalid_input', { field: 'kind', allowed: [...MEMBER_KINDS] });
  }
  const kind: MemberKind = isMemberKind(input.kind) ? input.kind : 'human';

  const key = input.idempotencyKey;
  const hasKey = typeof key === 'string' && key.length > 0;
  if (hasKey) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'invite_member');
    if (replayed !== undefined) return replayed;
  }

  if (!isAssignableRole(ctx, role)) return err('unknown_role', { role });

  // Before the duplicate check, so the caller is the owner of the workspace they are inviting into.
  seatFirstOwner(ctx);

  const existingUser = ctx.store.db
    .prepare('SELECT id, kind FROM user WHERE email = ?')
    .get(email) as { id: string; kind: string } | undefined;
  /**
   * F-11 / J8.8 (friction ledger, 2026-09-06): the pending member row a re-invite REPLACES.
   *
   * A pending membership whose every invite has expired is not "already a member", it is a dead
   * end: the invitee cannot redeem (`invite_expired`) and the owner could not re-invite
   * (`already_member`), so neither side had a way out. Such a row is replaced in place: the SAME
   * member id, a fresh token, the role of the new invite, `invited_at` moved to now. An ACCEPTED
   * membership, or a pending one whose invite is still live, stays `already_member` exactly as
   * before: this widens nothing for a seated member and mints no second token beside a live one.
   */
  let replacedPending: string | null = null;
  if (existingUser !== undefined) {
    const already = ctx.store.db
      .prepare('SELECT id, accepted_at FROM workspace_member WHERE workspace_id = ? AND user_id = ?')
      .get(ctx.workspaceId, existingUser.id) as { id: string; accepted_at: string | null } | undefined;
    if (already !== undefined) {
      const liveInvite = ctx.store.db
        .prepare(
          'SELECT token FROM invite WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL AND expires_at >= ? LIMIT 1',
        )
        .get(ctx.workspaceId, email, ctx.clock.now()) as { token: string } | undefined;
      if (already.accepted_at !== null || liveInvite !== undefined) {
        return err('already_member', { email, memberId: already.id });
      }
      replacedPending = already.id;
    }
    // The kind is a property of the IDENTITY, not of one membership: one email is one principal
    // across every mandate on this machine (see the schema note on `user`). An invite that would
    // re-declare a person as a machine, or a machine as a person, is refused rather than silently
    // rewriting whether the dial governs every workspace that identity already sits in.
    if (input.kind !== undefined && existingUser.kind !== kind) {
      return err('member_kind_mismatch', { email, kind: existingUser.kind, requested: kind });
    }
  }
  // What the identity IS after this invite: the stored kind for a known email (an invite without a
  // kind carries it, never resets it), the requested or default kind for a new one.
  const effectiveKind: MemberKind =
    existingUser !== undefined && isMemberKind(existingUser.kind) ? existingUser.kind : kind;

  const run = (): Result => {
    const now = ctx.clock.now();
    const userId = existingUser?.id ?? ctx.ids.next('user');
    if (existingUser === undefined) {
      ctx.store.db
        .prepare('INSERT INTO user (id, actor_id, email, display_name, kind, created_at) VALUES (?, NULL, ?, ?, ?, ?)')
        .run(userId, email, input.displayName ?? null, kind, now);
    }

    const memberId = replacedPending ?? ctx.ids.next('member');
    if (replacedPending !== null) {
      // The expired pending row is re-armed in place: same member, new role, invited again now.
      ctx.store.db
        .prepare('UPDATE workspace_member SET role = ?, invited_at = ?, created_by = ? WHERE id = ? AND accepted_at IS NULL')
        .run(role, now, ctx.actor, memberId);
    } else {
      ctx.store.db
        .prepare(
          `INSERT INTO workspace_member (id, workspace_id, user_id, role, invited_at, accepted_at, created_by)
           VALUES (?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(memberId, ctx.workspaceId, userId, role, now, ctx.actor);
    }

    const token = ctx.ids.next('invite');
    const expiresAt = addDays(now, INVITE_VALIDITY_DAYS);
    ctx.store.db
      .prepare(
        `INSERT INTO invite (token, workspace_id, email, role, expires_at, accepted_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(token, ctx.workspaceId, email, role, expiresAt, ctx.actor, now);

    ctx.audit.record({
      entityKind: 'workspace_member',
      entityId: memberId,
      action: 'invite',
      actor: ctx.actor,
      at: now,
    });
    return ok({
      memberId,
      userId,
      email,
      role,
      kind: effectiveKind,
      token,
      expiresAt,
      delivery: 'prepared',
      /** True when this invite re-armed a pending row whose earlier invite had expired (J8.8). */
      replacedExpired: replacedPending !== null,
    });
  };

  return hasKey
    ? ctx.store.rememberIdempotent(ctx.workspaceId, key as string, 'invite_member', run)
    : run();
}

/** ISO instant plus `days`, keeping the full timestamp so an expiry is comparable to `clock.now()`. */
function addDays(isoInstant: string, days: number): string {
  const base = new Date(isoInstant);
  if (Number.isNaN(base.getTime())) return isoInstant;
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

export interface AcceptInviteDeps {
  store: SqliteStore;
  clock: Clock;
  ids: IdGen;
  actor: string;
  /**
   * M01: the proxy-attested subject, present ONLY in served mode. Its presence is what switches
   * `acceptInvite` from D13 actor binding (local) to subject binding (served): the invited email must
   * match this subject (`invite_subject_mismatch`), and the accepted `user` is bound by `subject` +
   * `actor_id = member:<user_id>` rather than by the session's D13 actor. Absent on every local install.
   */
  subject?: string | undefined;
}

/**
 * Redeem an invite: bind the CALLING actor to the invited identity and activate the membership.
 *
 * PRE-WORKSPACE by necessity, which is why it is a `depsAction` and not a ctx verb: the accepter is
 * not a member of anything yet, so there is no capability to resolve and no workspace to resolve it
 * against. The token IS the authorisation, exactly as it is in every invite flow, and it expires.
 *
 * `actor_already_bound` is the one rejection worth explaining. In the local tier the actor set is
 * D13's closed registry (`studio`, `agent`), so two different invited people cannot both be `studio`
 * on one machine without one silently becoming the other. Refusing is the only honest answer
 * available without authentication, and it is the rejection a cloud tier with real subjects never
 * sees.
 *
 * `actor_already_member` IS NEW, AND D50 IS WHY. Provisioning now seats BOTH D13 actors, so on a
 * local install `studio` and `agent` are already accepted members before any invite is written, and
 * an accept from either of them can no longer succeed. That is not a regression to route around: it
 * is what "the agent is a seated member you narrow or revoke" means. What WOULD be a regression is
 * answering `actor_already_bound` ("this session belongs to another person, accept from the session
 * it was meant for") to an operator who is looking straight at the agent's own row on the Members
 * surface. So the case is told apart and named: this session already has access HERE, at this role,
 * and the move is `set_role` on the row it already has.
 *
 * The invite itself is untouched by the refusal. It stays pending and stays redeemable by an actor
 * that is not seated, which is the `treuhand:mueller`-shaped subject `src/api/session.ts` describes
 * and the shape a cloud tier will bring.
 */
export function acceptInvite(deps: AcceptInviteDeps, input: { token?: unknown }): Result {
  const guard = requireString(input.token, 'token');
  if (guard) return guard;
  const token = input.token as string;

  const invite = deps.store.db
    .prepare('SELECT token, workspace_id, email, role, expires_at, accepted_at FROM invite WHERE token = ?')
    .get(token) as
    | { token: string; workspace_id: string; email: string; role: string; expires_at: string; accepted_at: string | null }
    | undefined;
  if (invite === undefined) return err('invite_not_found', { token });

  // M01, SERVED MODE ONLY: the accepting session's proxy-attested subject must match the invited email
  // (case-insensitive; `invite.email` is stored lowercased). This is the rung A24 §3 could not reach on
  // a local install ("a member's identity is only as strong as the transport that declares it"): with a
  // proxy vouching for the subject, a bearer-token invite is no longer redeemable by any signed-in
  // stranger who holds the token (US-M01.2 error, Alice cannot redeem Bob's token). Checked BEFORE the
  // replay and expiry branches so a wrong subject learns nothing about the invite's state either.
  // `deps.subject` is present ONLY in served mode, so a local accept skips this entirely and behaves
  // exactly as before.
  if (deps.subject !== undefined) {
    const attested = deps.subject.trim().toLowerCase();
    if (attested !== invite.email) {
      return err('invite_subject_mismatch', { subject: deps.subject, email: invite.email });
    }
  }

  const now = deps.clock.now();
  if (invite.accepted_at !== null) {
    // A replay of a completed accept settles to the same state rather than rejecting: this verb is
    // absolute (§H-IDEMPOTENT) and carries no key, so the second call must be the first call's answer.
    //
    // F-11 critic F3: "settles to the same state" is only `ok` while that state is STILL a seat. A
    // redeemed token replayed after the member was revoked (no row) or revoked-then-re-invited (a new
    // PENDING row, `accepted_at IS NULL`) used to answer `ok` while seating nobody, and the Studio,
    // reading any `ok` as success, silently re-rendered the not-a-member page. So the replay settles to
    // `ok` ONLY when the membership for this email in this workspace is currently ACCEPTED; otherwise the
    // token is spent for a seat that no longer exists and the honest answer is the same "invalid code"
    // refusal a stranger's bad token gets.
    const member = deps.store.db
      .prepare(
        `SELECT m.id, m.accepted_at FROM workspace_member m JOIN user u ON u.id = m.user_id
          WHERE m.workspace_id = ? AND u.email = ?`,
      )
      .get(invite.workspace_id, invite.email) as { id: string; accepted_at: string | null } | undefined;
    if (member === undefined || member.accepted_at === null) {
      return err('invite_not_found', { token });
    }
    return ok({ workspaceId: invite.workspace_id, role: invite.role, memberId: member.id });
  }
  if (invite.expires_at < now) return err('invite_expired', { token, expiresAt: invite.expires_at });

  const user = deps.store.db
    .prepare('SELECT id, actor_id FROM user WHERE email = ?')
    .get(invite.email) as { id: string; actor_id: string | null } | undefined;
  if (user === undefined) return err('invite_not_found', { token });

  // Told apart BEFORE the generic clash, because after D50 this is the common case on a local
  // install and the generic answer would be actively misleading. See the module note.
  const seated = memberFor(deps.store, invite.workspace_id, deps.actor);
  if (seated !== undefined && seated.accepted) {
    return err('actor_already_member', {
      actor: deps.actor,
      memberId: seated.memberId,
      role: seated.role,
    });
  }

  const clash = deps.store.db
    .prepare('SELECT id FROM user WHERE actor_id = ? AND id <> ?')
    .get(deps.actor, user.id) as { id: string } | undefined;
  if (clash !== undefined) return err('actor_already_bound', { actor: deps.actor });

  const member = deps.store.db
    .prepare('SELECT id FROM workspace_member WHERE workspace_id = ? AND user_id = ?')
    .get(invite.workspace_id, user.id) as { id: string } | undefined;
  if (member === undefined) return err('invite_not_found', { token });

  // M01: in served mode the identity is the SUBJECT, so the user is bound by `subject` and stamps with
  // the stable `member:<user_id>` actor (which equals what `resolveServedActor` will compute on the
  // subject's next request, so `memberFor` resolves it). In local mode nothing above set `deps.subject`,
  // and the D13 actor (`studio`/`agent`/embedder) is bound into `actor_id` exactly as before.
  if (deps.subject !== undefined) {
    deps.store.db
      .prepare('UPDATE user SET actor_id = ?, subject = ? WHERE id = ?')
      .run(servedMemberActor(user.id), deps.subject.trim(), user.id);
  } else {
    deps.store.db.prepare('UPDATE user SET actor_id = ? WHERE id = ?').run(deps.actor, user.id);
  }
  deps.store.db
    .prepare('UPDATE workspace_member SET accepted_at = ? WHERE id = ?')
    .run(now, member.id);
  deps.store.db.prepare('UPDATE invite SET accepted_at = ? WHERE token = ?').run(now, token);

  return ok({ workspaceId: invite.workspace_id, role: invite.role, memberId: member.id });
}

export interface SetRoleInput {
  memberId?: string;
  role?: string;
}

/**
 * Change a member's role. Takes effect on their NEXT call, because nothing caches a resolution.
 *
 * `last_owner` fires on demoting the only accepted owner, for the same reason `revokeMember` has
 * the rail: a workspace with no owner cannot grant `manage_members` to anyone ever again, and no
 * verb in this engine can repair that from inside.
 */
export function setRole(ctx: WorkspaceContext, input: SetRoleInput): Result {
  const allowed = ctx.capabilities.assert('manage_members');
  if (!allowed.ok) return allowed;

  const guard = requireString(input.memberId, 'memberId') ?? requireString(input.role, 'role');
  if (guard) return guard;
  const memberId = input.memberId as string;
  const role = input.role as string;

  if (!isAssignableRole(ctx, role)) return err('unknown_role', { role });

  const row = ctx.store.db
    .prepare('SELECT role, accepted_at FROM workspace_member WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, memberId) as { role: string; accepted_at: string | null } | undefined;
  if (row === undefined) return err('member_not_found', { memberId });

  if (row.role === role) return ok({ memberId, role });

  if (row.role === OWNER_ROLE && row.accepted_at !== null && acceptedOwnerCount(ctx) === 1) {
    return err('last_owner', { memberId });
  }

  const now = ctx.clock.now();
  ctx.store.db
    .prepare('UPDATE workspace_member SET role = ? WHERE workspace_id = ? AND id = ?')
    .run(role, ctx.workspaceId, memberId);
  ctx.audit.record({
    entityKind: 'workspace_member',
    entityId: memberId,
    action: 'set_role',
    actor: ctx.actor,
    at: now,
  });
  return ok({ memberId, role });
}

/**
 * Remove a member's access.
 *
 * The row is DELETED rather than soft-flagged, which is the opposite of `archiveRole`, and the
 * asymmetry is deliberate. A role is referenced by historical `created_by` stamps and must stay
 * resolvable to a name; a membership is a live grant and nothing but the grant, and the audit trail
 * already holds who did what under it. Keeping a revoked grant as a row would leave a thing that
 * looks like access in the table access is read from, which is the wrong shape for the one table in
 * this schema whose absence is the security property.
 *
 * The `user` row survives, so re-inviting the same person restores their history.
 */
export function revokeMember(ctx: WorkspaceContext, input: { memberId?: string }): Result {
  const allowed = ctx.capabilities.assert('manage_members');
  if (!allowed.ok) return allowed;

  const guard = requireString(input.memberId, 'memberId');
  if (guard) return guard;
  const memberId = input.memberId as string;

  const row = ctx.store.db
    .prepare('SELECT role, accepted_at, user_id FROM workspace_member WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, memberId) as
    | { role: string; accepted_at: string | null; user_id: string }
    | undefined;
  // A replay of a completed revoke settles rather than rejecting (§H-IDEMPOTENT): this verb is
  // absolute, so the second call must answer what the first one made true.
  if (row === undefined) return ok({ memberId, revoked: true });

  if (row.role === OWNER_ROLE && row.accepted_at !== null && acceptedOwnerCount(ctx) === 1) {
    return err('last_owner', { memberId });
  }

  const now = ctx.clock.now();
  ctx.store.db
    .prepare('DELETE FROM workspace_member WHERE workspace_id = ? AND id = ?')
    .run(ctx.workspaceId, memberId);
  // F-11 critic F1: the grant is the row, but a PENDING member also holds a live invite TOKEN, and
  // deleting the row alone left that token redeemable. A later re-invite then minted a SECOND live
  // token beside it, and the revoked one still redeemed (`role` from the invite row) into the new
  // membership. So the revoke expires the address's un-accepted invite(s) too: exactly one live token
  // survives a re-invite, and the cancelled invitation cannot be redeemed. An accepted member has no
  // un-accepted invite (a re-invite is refused `already_member`), so this is a no-op for them. The
  // expiry is set STRICTLY in the past (not `now`): `acceptInvite` treats a token as expired only when
  // `expires_at < now`, and the invite-live check is `expires_at >= now`, so `now` itself would leave
  // the token redeemable at the revoke instant. A past instant expires it under both comparisons.
  const expired = addDays(now, -INVITE_VALIDITY_DAYS);
  ctx.store.db
    .prepare(
      `UPDATE invite SET expires_at = ?
        WHERE workspace_id = ? AND accepted_at IS NULL
          AND email = (SELECT email FROM user WHERE id = ?)`,
    )
    .run(expired, ctx.workspaceId, row.user_id);
  ctx.audit.record({
    entityKind: 'workspace_member',
    entityId: memberId,
    action: 'revoke',
    actor: ctx.actor,
    at: now,
  });
  return ok({ memberId, revoked: true });
}
