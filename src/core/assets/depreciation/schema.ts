/**
 * H03, the depreciation-method ENABLEMENT table. The pure engine (OP12) holds no state; the ONLY thing
 * persisted for H03 is a per-workspace enable/disable flag per method, so a workspace can hide a method
 * from the H00 category picker without a code change. ABSENCE MEANS ENABLED: a workspace that never
 * toggled anything sees all four methods, so the common path writes nothing (the read verbs stay inert,
 * conformance rule 4).
 *
 * Its own module so a concurrent asset-cluster branch never edits H00/H01's schema string. Every row
 * carries `workspace_id` (§H-TENANT). The engine's method registry, not this table, is the source of
 * WHICH methods exist; this table only records which of them a workspace has switched off.
 */

export const DEPRECIATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS asset_depreciation_method_setting (
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  method_key    TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT NOT NULL,
  updated_by    TEXT,
  PRIMARY KEY (workspace_id, method_key)
);
`;
