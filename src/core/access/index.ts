/**
 * A24, access control: the single authorization decision point and the membership it decides from.
 *
 * The barrel is the only thing `src/api/` imports from, the same rule every other engine module
 * follows. `capabilityFor` is the one resolver; a second one is what §6b forbids outright.
 */

export {
  CAPABILITIES,
  CAPABILITY_IDS,
  RESERVED_CAPABILITIES,
  BUILTIN_ROLE_DEFAULTS,
  EDITABLE_BUILTIN_ROLES,
  FIXED_ROLES,
  OWNER_ROLE,
  VIEWER_ROLE,
  // Exported for `test/access/permission-boundary.test.mjs`, which derives "may a viewer legitimately
  // pass this verb's gate" rather than assuming every gated write refuses one. A hand-kept list in
  // the suite would drift from the bundle the engine actually resolves.
  VIEWER_CAPABILITIES,
  defaultCapabilitiesFor,
  isBuiltinRole,
  isCapability,
  isFixedRole,
} from './capabilities.js';
export type { Capability, CapabilityGroup, BuiltinRole } from './capabilities.js';

export {
  SEATED_ACTORS,
  AGENT_ACTOR,
  isSeatedActor,
  seatingOrder,
  SERVED_MEMBER_ACTOR_PREFIX,
  servedMemberActor,
  SERVED_STRANGER_ACTOR,
  IDENTITY_SOURCES,
  MEMBER_KINDS,
  isMemberKind,
} from './actors.js';
export type { IdentitySource, MemberKind } from './actors.js';

export {
  assertCapability,
  capabilityFor,
  capabilityPort,
  isProvisioned,
  memberFor,
  parseCapabilities,
  resolveCapabilities,
  isGovernedSeat,
} from './capability.js';
export type { MemberBinding } from './capability.js';

export {
  CAPABILITY_FOR_ACTION,
  assertActionInvokersAreGated,
  assertEveryActionIsGated,
  assertEveryEntityKindHasAReadDomain,
  isUngated,
  readCapabilityForKind,
  requiredCapabilitiesFor,
  ungated,
} from './actionCapabilities.js';
export type { CapabilityRule, ExemptionShape, GatedAction, Ungated } from './actionCapabilities.js';

export {
  archiveRole,
  capabilitiesOfRole,
  defineRole,
  isAssignableRole,
  listRoles,
  seedBuiltinRoles,
} from './roles.js';
export type { RoleView, DefineRoleInput, ArchiveRoleInput } from './roles.js';

export {
  INVITE_VALIDITY_DAYS,
  acceptInvite,
  holdsAnyMembership,
  inviteMember,
  listMembers,
  revokeMember,
  seatFirstOwner,
  setRole,
  whoami,
} from './members.js';
export type { MemberView, InviteMemberInput, SetRoleInput, AcceptInviteDeps } from './members.js';

export { ACCESS_SCHEMA_SQL } from './schema.js';
