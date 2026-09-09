/**
 * A24's four tables (data model §D0), and why all four live here.
 *
 * The spec depends on A23 for `workspace_member` and `user`. A23 is not built: there is no
 * workspace-lifecycle module, no such tables, and no spec file for it in the tree. So A24 mints
 * them rather than depending on a table nothing has written, and A23 inherits them when it lands.
 * Kept in A24's own module and concatenated onto `SCHEMA_SQL` at the store, the pattern A14
 * established for `core/payments/schema.ts`: the DDL a capability writes sits beside the code that
 * writes it, and concurrent capability branches do not all edit one long string.
 *
 * `user` IS THE ONE TABLE HERE WITHOUT A `workspace_id`, and that is not an §H-TENANT lapse. An
 * identity exists before it is a member of anything, and the same person is one identity across
 * every set of books on this machine; making the identity per-workspace would mean a Treuhänder
 * with four clients is four unrelated people, and no query could ever tell they were not. The
 * TENANT boundary is `workspace_member`, which is where a capability answer is actually resolved,
 * and every read in `capability.ts` and `members.ts` joins through it with the workspace in the
 * predicate rather than checked afterwards.
 *
 * `user.actor_id` IS THE WHOLE OF AUTHENTICATION IN THE LOCAL TIER, and it deserves to be said in
 * the schema rather than only in the spec. D13 (`src/api/session.ts`) resolves a CLOSED registry of
 * MCP client names to an actor string: the Studio declares `till-studio` and lands as `studio`,
 * `till mcp` declares `till-cli` and lands as `agent`, anything else is `agent` too. There is no
 * password, no token and no signature anywhere in the MIT core. So a grant is only ever as strong
 * as the transport that declared the actor, and the useful, honest thing this buys today is
 * US-A24.5: an owner binds the `agent` actor to a narrow role and every MCP call is bounded by it.
 * A cloud tier with real identity fills the same column from a verified subject and nothing above
 * this line changes.
 *
 * NO ROLE COLUMN CARRIES A CHECK CONSTRAINT, matching the §D0 convention the core schema states:
 * enum values are enforced by the engine at the single §H-ENUM source of truth (`capabilities.ts`),
 * so a capability that legitimately adds a role or a capability does it in one place with no
 * migration.
 */

export const ACCESS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user (
  id           TEXT PRIMARY KEY,
  -- The D13 session actor this identity is recognised by on this machine, or NULL until an invite
  -- is accepted. See the module note: this is the whole of local authentication.
  actor_id     TEXT,
  -- NULLABLE, deliberately. A local session actor has no email address: 'studio' and 'agent' are
  -- transports, not people, and minting 'studio@local' to satisfy a NOT NULL would be inventing an
  -- identifier that looks routable and is not. An invited human always has one.
  email        TEXT,
  display_name TEXT,
  -- M01 (served access): the proxy-attested subject this identity is recognised by in served mode,
  -- or NULL on a local install (where actor_id keeps doing its D13 job). Bound on accept_invite when
  -- an authenticating reverse proxy vouched for the accepting session (see src/api/served-mode.ts).
  -- The engine NEVER writes a password or a token: this is the whole of served authentication, and it
  -- is an opaque string the proxy chose (an email or an IdP sub), never parsed beyond the invite match.
  subject      TEXT,
  -- M01 US-M01.3 (F-08 d): 'human' or 'agent', set by the inviter and never by the session. A served
  -- member of kind 'agent' is the governed seat (the dial and the A35 trace apply to it exactly as to
  -- the local D13 agent actor). Defaulted, so every pre-existing identity reads as a person.
  kind         TEXT NOT NULL DEFAULT 'human',
  created_at   TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS user_by_actor ON user (actor_id) WHERE actor_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS user_by_email ON user (email) WHERE email IS NOT NULL;
-- M01: one served subject maps to at most one identity. Partial, because every local user carries a
-- NULL subject and must stay outside the index (a machine with no proxy has no subjects at all).
CREATE UNIQUE INDEX IF NOT EXISTS user_by_subject ON user (subject) WHERE subject IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_member (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  user_id      TEXT NOT NULL REFERENCES user(id),
  -- A built-in role id or a role_def.id. Never checked here: capabilities.ts is the enum.
  role         TEXT NOT NULL,
  invited_at   TEXT NOT NULL,
  -- NULL while the invite is pending. A pending member holds NO capability at all.
  accepted_at  TEXT,
  created_by   TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_member_one_per_user
  ON workspace_member (workspace_id, user_id);

CREATE INDEX IF NOT EXISTS workspace_member_by_role
  ON workspace_member (workspace_id, role);

CREATE TABLE IF NOT EXISTS invite (
  token        TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  email        TEXT NOT NULL,
  role         TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  accepted_at  TEXT,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS invite_by_workspace ON invite (workspace_id, email);

CREATE TABLE IF NOT EXISTS role_def (
  id                TEXT NOT NULL,
  workspace_id      TEXT NOT NULL REFERENCES workspace(id),
  name              TEXT NOT NULL,
  -- A JSON array of capability ids, every entry validated against the registry on write. Stored as
  -- text rather than as a join table because it is read whole on every capability resolution and
  -- never queried by member: a row IS the bundle.
  capabilities_json TEXT NOT NULL,
  is_builtin        INTEGER NOT NULL DEFAULT 0,
  archived          INTEGER NOT NULL DEFAULT 0,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS role_def_by_workspace ON role_def (workspace_id, archived, name);
`;
