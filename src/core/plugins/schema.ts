/**
 * G02's two owned tables, kept in G02's own module and concatenated onto `SCHEMA_SQL` at the store,
 * the pattern G06/G04/E03/C00/G00 established: a capability's DDL sits beside the code that writes
 * it, so concurrent capability branches never all edit one long string in `store/schema.ts`.
 *
 * NO `_rappen` (or `_minor`) COLUMN ANYWHERE (spec §4/§7), asserted by
 * `test/plugins/no-money-path.test.mjs` rather than merely stated: G02's job is to guarantee no
 * plugin ever gets a path to money, not to compute money, so P3 is satisfied by having nothing to
 * delegate. Every row carries `workspace_id` (§H-TENANT), a ULID `id`, and `created_at`/`updated_at`.
 * The enum columns (`source`, `status`, `kind`) are §H-ENUM sets enforced by the engine, not by CHECK
 * constraints: the single source of truth is `enums.ts` (the G06 pattern).
 *
 * `plugin_manifests` is UNIQUE on `(workspace_id, name)`: a plugin identity is its name within a
 * workspace, and a new version SUPERSEDES the row in place (US-G02.1 boundary), so the manifest table
 * is NOT append-only (spec §7). The traceability of a supersede or an uninstall rides A03's
 * hash-chained `audit_log` instead (spec §4), which is the append-only surface.
 *
 * `plugin_capability_registrations` is the precise sweep list `enable`/`disable`/`uninstall` read and
 * write (US-G02.2/3): one row per registered capability, so a disable returns every touched registry
 * to its pre-install state exactly.
 */

export const PLUGINS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS plugin_manifests (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspace(id),
  name                 TEXT NOT NULL,
  version              TEXT NOT NULL,
  source               TEXT NOT NULL,
  capabilities         TEXT NOT NULL DEFAULT '[]',
  permissions          TEXT NOT NULL DEFAULT '{"requested":[],"granted":[]}',
  status               TEXT NOT NULL DEFAULT 'installed',
  compat_range         TEXT NOT NULL,
  installed_by         TEXT NOT NULL,
  sha256               TEXT NOT NULL,
  registry_ref         TEXT,
  last_compat_check_at TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

-- A plugin's identity is its name within a workspace: the supersede key install resolves against.
CREATE UNIQUE INDEX IF NOT EXISTS plugin_manifests_name
ON plugin_manifests (workspace_id, name);

-- The installed-list read model (list_plugins), newest first.
CREATE INDEX IF NOT EXISTS plugin_manifests_list
ON plugin_manifests (workspace_id, created_at);

CREATE TABLE IF NOT EXISTS plugin_capability_registrations (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  plugin_id     TEXT NOT NULL REFERENCES plugin_manifests(id),
  kind          TEXT NOT NULL,
  name          TEXT NOT NULL,
  registered_at TEXT NOT NULL
);

-- The sweep read model (disable/uninstall): every row a plugin registered, by plugin.
CREATE INDEX IF NOT EXISTS plugin_capability_registrations_by_plugin
ON plugin_capability_registrations (workspace_id, plugin_id);

-- The name-conflict read model (install/enable): is a REGISTERING name already taken in this
-- workspace? A unique index would also refuse a plugin re-registering its OWN name on re-enable, so
-- the conflict check is done in the engine against a filtered query, not enforced here.
CREATE INDEX IF NOT EXISTS plugin_capability_registrations_by_name
ON plugin_capability_registrations (workspace_id, kind, name);
`;
