/**
 * E01's one table, kept in E01's own module and concatenated onto `SCHEMA_SQL` at the store (the
 * A14/A19/A24/G00/C00/E00/E03 pattern): a capability's DDL sits beside the code that writes it.
 *
 * NO `_rappen` COLUMN ANYWHERE, asserted by `test/sign/no-money-path.test.mjs` rather than merely
 * stated (spec §4 "Money correctness": E01 has no financial effect, so P3 is satisfied by having
 * nothing to delegate). Every row carries `workspace_id` (§H-TENANT). `status` and
 * `signature_level` are the §H-ENUM enums enforced by the engine, not CHECK constraints (the single
 * source of truth is `enums.ts`, the E03/C00 pattern).
 *
 * `document_sha256` is the INTEGRITY ANCHOR (spec §6b, fixed): the sha256 of the E00 file version
 * the signer was asked to sign, captured at create time. `complete` refuses a signed upload whose
 * `originalSha256` does not match it (`document_hash_mismatch`), so a swapped file can never
 * complete a request. `local_artifact_json` is the provider-agnostic OP4 envelope, persisted ON the
 * row: local-first, nothing is written outside the database and nothing leaves the device.
 *
 * `signed_file_id` points at the E00 `stored_file` row `newFileVersion` minted on completion. E01
 * never writes file bytes itself; the version chain, hashing and retention are E00's.
 */

export const SIGN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sign_request (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspace(id),
  file_id             TEXT NOT NULL REFERENCES stored_file(id),
  signer_contact_id   TEXT NOT NULL REFERENCES contact(id),
  signature_level     TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'draft',
  message             TEXT,
  expires_at          TEXT,
  sent_at             TEXT,
  viewed_at           TEXT,
  signed_at           TEXT,
  declined_reason     TEXT,
  expired_reason      TEXT,
  provider_ref        TEXT,
  document_sha256     TEXT NOT NULL,
  local_artifact_json TEXT NOT NULL,
  signed_file_id      TEXT REFERENCES stored_file(id),
  requested_by        TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- The drawer list (sign_requests_list filtered on file_id) and the open-request guard both ask
-- "which requests hang on this file", per workspace.
CREATE INDEX IF NOT EXISTS sign_request_file
ON sign_request (workspace_id, file_id, status);

-- The tracking list (sign_requests_list filtered on status, the "Offene Signaturen" filter) and the
-- lazy-expiry sweep both scan by status; the sweep additionally reads expires_at.
CREATE INDEX IF NOT EXISTS sign_request_status
ON sign_request (workspace_id, status, expires_at);
`;
