/**
 * G02's three §H-ENUM points, single-sourced here (the G06 `enums.ts` shape): where a plugin came
 * from, its lifecycle status, and the four kinds of capability a manifest may register.
 *
 * `PLUGIN_CAPABILITY_KINDS` is FIXED by design (spec §6b): the manifest schema is the contract 33
 * dependent specs compile against, so a new kind is a new core release, never a per-workspace value.
 * Every consumer (`plugin_manifests.source`/`.status`, `plugin_capability_registrations.kind`)
 * validates against these sets in the engine, not via SQLite CHECK constraints, so the single source
 * of truth is this file.
 */

/** Where a manifest was obtained (spec §4): a local file or a configured registry. */
export const PLUGIN_SOURCES = ['local', 'registry'] as const;
export type PluginSource = (typeof PLUGIN_SOURCES)[number];

export function isPluginSource(value: unknown): value is PluginSource {
  return typeof value === 'string' && (PLUGIN_SOURCES as readonly string[]).includes(value);
}

/**
 * The plugin lifecycle (spec §4): `installed` (persisted and active), `disabled` (paused, its
 * capabilities swept but its manifest and granted permissions retained), `incompatible` (its
 * `compat_range` no longer matches `CORE_CONTRACT_VERSION`, swept but retained for a one-click
 * re-enable after a plugin update). This is a STATUS field, not A10's document lifecycle (spec §4).
 */
export const PLUGIN_STATUSES = ['installed', 'disabled', 'incompatible'] as const;
export type PluginStatus = (typeof PLUGIN_STATUSES)[number];

export function isPluginStatus(value: unknown): value is PluginStatus {
  return typeof value === 'string' && (PLUGIN_STATUSES as readonly string[]).includes(value);
}

/**
 * The four registries a manifest capability may join (spec §4). An `mcp_tool` joins the MCP tool
 * registry (with the plugin's own REST twin, P4), a `studio_screen` mounts a sandboxed iframe route,
 * a `report_source` joins F01's source list (read-only, P5), an `automation_action` joins the OP8
 * action registry. FIXED: a fifth kind is a new core release, never a workspace setting.
 */
export const PLUGIN_CAPABILITY_KINDS = [
  'mcp_tool',
  'studio_screen',
  'report_source',
  'automation_action',
] as const;
export type PluginCapabilityKind = (typeof PLUGIN_CAPABILITY_KINDS)[number];

export function isPluginCapabilityKind(value: unknown): value is PluginCapabilityKind {
  return typeof value === 'string' && (PLUGIN_CAPABILITY_KINDS as readonly string[]).includes(value);
}

/**
 * The kinds that REGISTER a new name into a shared namespace and therefore must not collide with an
 * existing core or plugin name (US-G02.2 boundary, `capability_name_conflict`). `automation_action`
 * is deliberately absent: its `name` is a REFERENCE to an existing tool (one of the plugin's own or
 * an existing core tool, spec §4), so naming an existing tool is legal for it, not a conflict. The
 * reserved money-path check (P3) still applies to it, because referencing a posting tool is exactly
 * the second path P3 forecloses.
 */
export const REGISTERING_CAPABILITY_KINDS: readonly PluginCapabilityKind[] = [
  'mcp_tool',
  'studio_screen',
  'report_source',
];

/**
 * The core-contract version a manifest's `compat_range` is resolved against (spec §4). This suite
 * bumps it whenever the MCP tool registry shape, the Studio screen-mount contract, the F01
 * report-source contract, or the OP8 automation-action contract changes in a breaking way. It is a
 * plain semver string so `plugin.checkCompat` can be table-tested directly (spec §8).
 */
export const CORE_CONTRACT_VERSION = '1.0.0';
