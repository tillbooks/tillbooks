/**
 * A24's nine verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` precedent).
 *
 * Eight are `ctxAction` registrations. `accept_invite` is the exception and has to be: the accepter
 * is not a member of anything yet, so there is no workspace on the input to resolve a capability
 * against and no capability to resolve. The TOKEN is the authorisation, exactly as it is in every
 * invite flow, and it expires. That makes it a `depsAction`, the same shape `create_workspace` uses
 * for the same structural reason.
 *
 * `whoami` IS THE ONLY VERB IN THIS REPO THAT ANSWERS A PERMISSION QUESTION, and that is a
 * deliberate constraint rather than an accident of scope. Three Studio gates used to read
 * `body.canPost`, `body.canManage` and `body.canUnlock` off `list_journal` and `list_period_locks`;
 * no payload has ever carried any of the three, so each read `undefined !== false` and every gate
 * stood open in every build that shipped. Bolting a permission field onto whatever list happens to
 * be on screen is what made that possible. One verb whose job is the answer is what stops it.
 *
 * As with `fx-actions.ts` and `support-actions.ts`, the helpers arrive as a parameter rather than an
 * import, so the module graph stays acyclic: `registry.ts` imports this file and this file must not
 * import it back.
 */

import type { ActionDef, ActionInput, ApiDeps, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  acceptInvite,
  archiveRole,
  defineRole,
  inviteMember,
  listMembers,
  listRoles,
  revokeMember,
  setRole,
  whoami,
} from '../core/access/index.js';

export interface PermissionActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  depsAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (deps: ApiDeps, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  depsSchema(props: Record<string, unknown>, required: string[]): JsonSchema;
  STR: { readonly type: 'string' };
}

/** The A24 verbs, in append order. */
export function permissionActions(h: PermissionActionHelpers): readonly ActionDef[] {
  const { ctxAction, depsAction, ctxSchema, depsSchema, STR } = h;
  const CAPABILITY_LIST = { type: 'array', items: STR } as const;

  return [
    ctxAction(
      'whoami',
      'read',
      'Report who this session is in a workspace: the actor, the role it holds, and the exact capabilities that role resolves to. The ONE source a client may use to pre-disable a write control. For the governed agent seat it also carries agentDial, the effective approval-dial level per capability (auto executes, ask drafts), so an agent can predict whether a write will post or wait for approval without holding the owner-only get_agent_dial.',
      ctxSchema(),
      (ctx) => whoami(ctx),
    ),
    ctxAction(
      'list_members',
      'read',
      'List everyone bound to this workspace, pending invites included and labelled as pending (a pending member holds no capability at all).',
      ctxSchema(),
      (ctx) => listMembers(ctx),
    ),
    ctxAction(
      'list_roles',
      'read',
      'List every assignable role with its resolved capability bundle and its member count, plus the capability registry itself so a client can render the whole matrix.',
      ctxSchema(),
      (ctx) => listRoles(ctx),
    ),
    ctxAction(
      'invite_member',
      'write',
      'Invite someone to this workspace with a role. Writes a pending membership and PREPARES the invite; TILL has no transport and never claims a send, so the token is handed back for the operator to deliver. kind (human, the default, or agent) says what the invitee is: an agent member is the governed seat, its writes draft under the approval dial and its calls land in the trace, on every door including a served one.',
      ctxSchema({ email: STR, role: STR, displayName: STR, kind: STR, idempotencyKey: STR }, [
        'email',
        'role',
        'idempotencyKey',
      ]),
      (ctx, input) => inviteMember(ctx, input),
    ),
    depsAction(
      'accept_invite',
      'write',
      'Redeem an invite token: bind this session actor to the invited identity and activate the membership. Pre-workspace, because the accepter is not a member yet.',
      depsSchema({ token: STR }, ['token']),
      (deps, input) => acceptInvite(deps, input),
    ),
    ctxAction(
      'set_role',
      'write',
      "Change a member's role. It takes effect on their next call: nothing caches a capability resolution. Demoting the only remaining owner is refused (last_owner).",
      ctxSchema({ memberId: STR, role: STR }, ['memberId', 'role']),
      (ctx, input) => setRole(ctx, input),
    ),
    ctxAction(
      'revoke_member',
      'write',
      "Remove a member's access to this workspace. The person's identity survives, so re-inviting them restores their history. Revoking the only remaining owner is refused (last_owner).",
      ctxSchema({ memberId: STR }, ['memberId']),
      (ctx, input) => revokeMember(ctx, input),
    ),
    ctxAction(
      'define_role',
      'write',
      'Create a custom role, or reshape one of the three editable built-ins, as a named subset of the capability registry. A name outside the registry is refused (unknown_capability): a role can only ever recombine capabilities that already gate a real verb.',
      ctxSchema({ roleId: STR, name: STR, capabilities: CAPABILITY_LIST, idempotencyKey: STR }, [
        'capabilities',
        'idempotencyKey',
      ]),
      (ctx, input) => defineRole(ctx, input),
    ),
    ctxAction(
      'archive_role',
      'write',
      'Soft-flag a custom role so it stops being offered. Never a delete, so historical attributions still resolve, and refused while any member still holds it (role_in_use).',
      ctxSchema({ roleId: STR, idempotencyKey: STR }, ['roleId', 'idempotencyKey']),
      (ctx, input) => archiveRole(ctx, input),
    ),
  ];
}
