/**
 * F02's one table, kept in F02's own module and concatenated onto `SCHEMA_SQL` at the store (the
 * A14/A19/A24/G00/C00/E00/E01 pattern): a capability's DDL sits beside the code that writes it.
 *
 * F03 (vendor portal) SHARES this table: a grant carries `kind` (`customer|vendor`, §H-ENUM), so
 * the vendor side is one more enum value and no second table (spec §3/§4 OP4). F02 builds only the
 * customer side.
 *
 * NO `_rappen` / `_minor` COLUMN ANYWHERE, asserted by `test/portal/no-money-path.test.mjs` rather
 * than merely stated (spec §4 "Money correctness": F02 performs zero money arithmetic and opens no
 * posting path; open amounts come from the A11/A14 read models). Every row carries `workspace_id`
 * (§H-TENANT).
 *
 * THE TOKEN IS NEVER STORED IN PLAINTEXT. Only `token_hash` (SHA-256 of a CSPRNG >=256-bit token)
 * is persisted, and it is UNIQUE. `local_artifact_json` is the provider-agnostic OP4 envelope, and
 * it deliberately carries NO token and NO usable link: a full DB read can never yield a working
 * portal link (spec §3, asserted by `test/portal/token-security.test.mjs`). The one-time link is
 * returned by `portal_grant_create` exactly once and is never re-derivable.
 *
 * `scopes` is a JSON array of `{kind, id?}` (kinds single-sourced in `enums.ts`, §H-ENUM). The row
 * is NEVER deleted: revocation stamps `revoked_at` (§H-AUDIT spirit, the grant history is the revDSG
 * access trail). `sent_at` records the P8 hand-over (draft -> active); expiry is computed, never a
 * bespoke state machine.
 */

export const PORTAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS portal_grant (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspace(id),
  contact_id          TEXT NOT NULL REFERENCES contact(id),
  kind                TEXT NOT NULL DEFAULT 'customer',
  token_hash          TEXT NOT NULL UNIQUE,
  scopes              TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  sent_at             TEXT,
  revoked_at          TEXT,
  last_resolved_at    TEXT,
  local_artifact_json TEXT NOT NULL,
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- The Portal-Zugang panel lists grants per contact (portal_grant_list filtered on contact_id), and
-- the create-scope validation reads a contact's grants, both per workspace.
CREATE INDEX IF NOT EXISTS portal_grant_contact
ON portal_grant (workspace_id, contact_id);

-- portal_resolve / portal_quote_accept look a grant up by its token hash alone (the hosted page and
-- an agent testing a grant know only the token). The UNIQUE constraint already indexes token_hash;
-- this expresses the read intent.
CREATE INDEX IF NOT EXISTS portal_grant_token
ON portal_grant (token_hash);
`;
