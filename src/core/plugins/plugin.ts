/**
 * G02, the plugin manifest lifecycle and the registry-client reads (spec §4/§5).
 *
 * WHAT THIS MODULE OWNS. The manifest lifecycle (preview, install, list, get, enable, disable,
 * uninstall, the compat refresh) and the registry-discovery seam. It writes two tables and NOTHING on
 * the money path: no `_rappen` column, no `postEntry`, no `recordPayment`, no socket (asserted by
 * `test/plugins/no-money-path.test.mjs`). G02's whole job is to guarantee no plugin ever gets a path
 * to money, which is why P3 is enforced STRUCTURALLY here (the reserved-name check) rather than by any
 * money arithmetic (spec §4/§8).
 *
 * THE THREE LOAD-BEARING SAFETY PROPERTIES, all proven by test:
 *   - P3 / no second posting path: `install`/`enable` reject any capability naming a reserved
 *     money-path tool (`capability_forbidden`), single-sourced from the registry's OWN A02/A14 write
 *     set (`reserved.ts`), and the WHOLE install fails with zero rows written.
 *   - Grant is the INTERSECTION of requested and granted, never a superset: `install` stores
 *     `permissions.granted = requested ∩ granted_scopes`, computed once, here.
 *   - Sandboxed data reach: an enabled plugin reaches TILL only through the same MCP dispatch an agent
 *     uses, scoped to its granted `mcp_tool:*` permissions and re-checked against A24 per call
 *     (`sandbox.ts`, `runPluginToolCall`).
 *
 * THE TX-COMMIT-ON-ERR TRAP. Returning `{ok:false}` inside `ctx.store.tx(...)` COMMITS the partial
 * write (only a THROW rolls back). So every rejection that must leave the database untouched
 * (checksum mismatch, forbidden capability, name conflict, downgrade) is decided BEFORE the
 * transaction opens; inside the `run` closure there are only writes and a final `ok(...)`.
 */

import { createHash } from 'node:crypto';
import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result, Err } from '../result.js';
import { applySavedView } from '../customization/views.js';
import {
  PLUGIN_SOURCES,
  isPluginSource,
  isPluginCapabilityKind,
  isPluginStatus,
  REGISTERING_CAPABILITY_KINDS,
  CORE_CONTRACT_VERSION,
  type PluginSource,
  type PluginStatus,
  type PluginCapabilityKind,
} from './enums.js';
import { satisfies, isValidRange, parseVersion } from './compat.js';
import { moneyPathTools, isReservedMoneyPathTool, isCoreToolName } from './reserved.js';
import { registryClient } from './registryClient.js';

// --- Rows, manifests, and wire views ------------------------------------------------------------

interface ManifestRow {
  id: string;
  workspace_id: string;
  name: string;
  version: string;
  source: string;
  capabilities: string;
  permissions: string;
  status: string;
  compat_range: string;
  installed_by: string;
  sha256: string;
  registry_ref: string | null;
  last_compat_check_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One declared capability in a manifest: which registry it joins, and under what name. */
export interface PluginCapabilityDecl {
  kind: PluginCapabilityKind;
  name: string;
}

/** The parsed, validated manifest. The extension CONTRACT (spec §6b Fixed). */
export interface PluginManifest {
  name: string;
  version: string;
  compatRange: string;
  sha256: string;
  capabilities: PluginCapabilityDecl[];
  requested: string[];
}

/** The one wire shape every plugin verb answers a manifest with, so the faces cannot drift (P5). */
export interface PluginView {
  id: string;
  name: string;
  version: string;
  source: string;
  status: string;
  compatRange: string;
  coreVersion: string;
  compatible: boolean;
  sha256: string;
  installedBy: string;
  registryRef: string | null;
  requested: string[];
  granted: string[];
  capabilities: PluginCapabilityDecl[];
  capabilityCount: number;
  lastCompatCheckAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StoredPermissions {
  requested: string[];
  granted: string[];
}

function parsePermissions(json: string): StoredPermissions {
  try {
    const p: unknown = JSON.parse(json);
    if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
      const rec = p as Record<string, unknown>;
      const requested = Array.isArray(rec.requested) ? rec.requested.filter((s): s is string => typeof s === 'string') : [];
      const granted = Array.isArray(rec.granted) ? rec.granted.filter((s): s is string => typeof s === 'string') : [];
      return { requested, granted };
    }
  } catch {
    // A row written by this module always carries valid JSON; a hand-edited one reads as empty.
  }
  return { requested: [], granted: [] };
}

function parseCapabilities(json: string): PluginCapabilityDecl[] {
  try {
    const c: unknown = JSON.parse(json);
    if (Array.isArray(c)) {
      return c
        .filter((e): e is { kind: PluginCapabilityKind; name: string } =>
          e !== null && typeof e === 'object' && isPluginCapabilityKind((e as { kind?: unknown }).kind) && typeof (e as { name?: unknown }).name === 'string')
        .map((e) => ({ kind: e.kind, name: e.name }));
    }
  } catch {
    // As above.
  }
  return [];
}

function mapView(row: ManifestRow): PluginView {
  const permissions = parsePermissions(row.permissions);
  const capabilities = parseCapabilities(row.capabilities);
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    source: row.source,
    status: row.status,
    compatRange: row.compat_range,
    coreVersion: CORE_CONTRACT_VERSION,
    compatible: satisfies(CORE_CONTRACT_VERSION, row.compat_range),
    sha256: row.sha256,
    installedBy: row.installed_by,
    registryRef: row.registry_ref,
    requested: permissions.requested,
    granted: permissions.granted,
    capabilities,
    capabilityCount: capabilities.length,
    lastCompatCheckAt: row.last_compat_check_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readManifest(ctx: WorkspaceContext, pluginId: string): ManifestRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM plugin_manifests WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, pluginId) as ManifestRow | undefined;
}

function readManifestByName(ctx: WorkspaceContext, name: string): ManifestRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM plugin_manifests WHERE workspace_id = ? AND name = ?')
    .get(ctx.workspaceId, name) as ManifestRow | undefined;
}

// --- Manifest parsing & validation --------------------------------------------------------------

interface PluginBundle {
  manifest: PluginManifest;
  payload: string;
  registryRef: string | null;
}

/**
 * Parse and VALIDATE the bundle `packageRef` carries. Returns the typed bundle, or an `invalid_manifest`
 * rejection naming what failed to parse (a missing `name`/`version`/`compat_range`, malformed JSON, a
 * bad capability entry). Persists nothing; both `previewInstall` and `install` funnel through here.
 */
type ParseBundleResult = { ok: true; bundle: PluginBundle } | Err;

function parseBundle(packageRef: unknown): ParseBundleResult {
  if (packageRef === null || typeof packageRef !== 'object' || Array.isArray(packageRef)) {
    return err('invalid_manifest', { reason: 'package_ref is not an object' });
  }
  const ref = packageRef as Record<string, unknown>;
  const rawManifest = ref.manifest;
  if (rawManifest === null || typeof rawManifest !== 'object' || Array.isArray(rawManifest)) {
    return err('invalid_manifest', { reason: 'manifest missing' });
  }
  const m = rawManifest as Record<string, unknown>;

  if (typeof m.name !== 'string' || m.name.trim().length === 0) {
    return err('invalid_manifest', { field: 'name' });
  }
  if (parseVersion(m.version) === null) {
    return err('invalid_manifest', { field: 'version' });
  }
  if (typeof m.compat_range !== 'string' || !isValidRange(m.compat_range)) {
    return err('invalid_manifest', { field: 'compat_range' });
  }
  if (typeof m.sha256 !== 'string' || m.sha256.trim().length === 0) {
    return err('invalid_manifest', { field: 'sha256' });
  }
  if (!Array.isArray(m.capabilities)) {
    return err('invalid_manifest', { field: 'capabilities' });
  }
  const capabilities: PluginCapabilityDecl[] = [];
  for (const entry of m.capabilities) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return err('invalid_manifest', { field: 'capabilities', reason: 'entry is not an object' });
    }
    const e = entry as Record<string, unknown>;
    if (!isPluginCapabilityKind(e.kind)) {
      return err('invalid_manifest', { field: 'capabilities', reason: 'unknown kind', kind: e.kind });
    }
    if (typeof e.name !== 'string' || e.name.trim().length === 0) {
      return err('invalid_manifest', { field: 'capabilities', reason: 'capability name missing' });
    }
    capabilities.push({ kind: e.kind, name: e.name });
  }
  // permissions.requested is the declared scope set; absent means a zero-permission plugin, valid.
  let requested: string[] = [];
  if (m.permissions !== undefined) {
    if (m.permissions === null || typeof m.permissions !== 'object' || Array.isArray(m.permissions)) {
      return err('invalid_manifest', { field: 'permissions' });
    }
    const req = (m.permissions as Record<string, unknown>).requested;
    if (req !== undefined) {
      if (!Array.isArray(req) || !req.every((s) => typeof s === 'string')) {
        return err('invalid_manifest', { field: 'permissions.requested' });
      }
      requested = req as string[];
    }
  }

  const manifest: PluginManifest = {
    name: m.name.trim(),
    version: m.version as string,
    compatRange: m.compat_range,
    sha256: m.sha256.trim(),
    capabilities,
    requested,
  };
  const payload = typeof ref.payload === 'string' ? ref.payload : '';
  const registryRef = typeof ref.registryRef === 'string' ? ref.registryRef : null;
  return { ok: true, bundle: { manifest, payload, registryRef } };
}

/**
 * The reserved-name (P3) and name-conflict checks over a manifest's capabilities. Pure reads, run
 * BEFORE any transaction, so a rejection writes nothing. `selfPluginId` is excluded from the conflict
 * scan so a plugin re-registering its OWN capability on re-enable/supersede is never a conflict.
 *
 * Returns an `Err` (`capability_forbidden` / `capability_name_conflict`) or `undefined` when clean.
 */
function checkCapabilities(
  ctx: WorkspaceContext,
  capabilities: readonly PluginCapabilityDecl[],
  selfPluginId: string | undefined,
): Result | undefined {
  // P3, first and for EVERY kind: a capability naming a reserved money-path tool is the second
  // posting path this whole capability exists to foreclose.
  for (const cap of capabilities) {
    if (isReservedMoneyPathTool(cap.name)) {
      return err('capability_forbidden', { reason: 'no_second_posting_path', name: cap.name });
    }
  }
  // Name conflict, only for REGISTERING kinds (mcp_tool/studio_screen/report_source). An
  // `automation_action` is a REFERENCE to an existing tool, so naming one is legal for it.
  for (const cap of capabilities) {
    if (!REGISTERING_CAPABILITY_KINDS.includes(cap.kind)) continue;
    if (isCoreToolName(cap.name)) {
      return err('capability_name_conflict', { name: cap.name });
    }
    const collision = ctx.store.db
      .prepare(
        'SELECT 1 FROM plugin_capability_registrations WHERE workspace_id = ? AND name = ? AND plugin_id != ? LIMIT 1',
      )
      .get(ctx.workspaceId, cap.name, selfPluginId ?? '') as unknown;
    if (collision !== undefined) {
      return err('capability_name_conflict', { name: cap.name });
    }
  }
  return undefined;
}

/** The granted set is the INTERSECTION of requested and what the caller granted (never a superset). */
function intersectScopes(requested: readonly string[], grantedScopes: readonly string[]): string[] {
  const req = new Set(requested);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of grantedScopes) {
    if (req.has(s) && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

// --- Capability registration write helpers (run INSIDE a tx) ------------------------------------

function writeRegistrations(ctx: WorkspaceContext, pluginId: string, capabilities: readonly PluginCapabilityDecl[], now: string): void {
  const insert = ctx.store.db.prepare(
    'INSERT INTO plugin_capability_registrations (id, workspace_id, plugin_id, kind, name, registered_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const cap of capabilities) {
    insert.run(ctx.ids.next('plgc'), ctx.workspaceId, pluginId, cap.kind, cap.name, now);
  }
}

function sweepRegistrations(ctx: WorkspaceContext, pluginId: string): void {
  ctx.store.db
    .prepare('DELETE FROM plugin_capability_registrations WHERE workspace_id = ? AND plugin_id = ?')
    .run(ctx.workspaceId, pluginId);
}

// --- previewInstall (R) -------------------------------------------------------------------------

export type PreviewInstallOk = {
  name: string;
  version: string;
  capabilities: PluginCapabilityDecl[];
  requested: string[];
  compatible: boolean;
  compatRange: string;
  coreVersion: string;
};

export interface PreviewInstallInput {
  source?: string;
  packageRef?: unknown;
}

/** Parse and validate a manifest and return the review payload, WITHOUT persisting anything (US-G02.1). */
export function previewInstall(ctx: WorkspaceContext, input: PreviewInstallInput): Result {
  void ctx; // Preview parses only; it touches no store (US-G02.1: persists nothing).
  if (!isPluginSource(input.source)) {
    return err('invalid_input', { field: 'source', allowed: [...PLUGIN_SOURCES] });
  }
  const parsed = parseBundle(input.packageRef);
  if (!parsed.ok) return parsed;
  const { manifest } = parsed.bundle;
  return ok({
    name: manifest.name,
    version: manifest.version,
    capabilities: manifest.capabilities,
    requested: manifest.requested,
    compatible: satisfies(CORE_CONTRACT_VERSION, manifest.compatRange),
    compatRange: manifest.compatRange,
    coreVersion: CORE_CONTRACT_VERSION,
  });
}

// --- install (W) --------------------------------------------------------------------------------

export type InstallPluginOk = { plugin: PluginView };

export interface InstallPluginInput {
  source?: string;
  packageRef?: unknown;
  grantedScopes?: unknown;
  idempotencyKey?: string;
}

export function installPlugin(ctx: WorkspaceContext, input: InstallPluginInput): Result {
  if (!isPluginSource(input.source)) {
    return err('invalid_input', { field: 'source', allowed: [...PLUGIN_SOURCES] });
  }
  if (input.grantedScopes !== undefined && (!Array.isArray(input.grantedScopes) || !input.grantedScopes.every((s) => typeof s === 'string'))) {
    return err('invalid_input', { field: 'grantedScopes' });
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  // Fail CLOSED: without the reserved-name seam wired, P3 cannot be checked, so nothing installs.
  if (moneyPathTools() === undefined) {
    return err('plugin_guard_uninitialised', {});
  }

  const parsed = parseBundle(input.packageRef);
  if (!parsed.ok) return parsed;
  const { manifest, payload, registryRef } = parsed.bundle;

  // Integrity: the pinned sha256 must match the payload actually shipped. Persists nothing.
  const actual = createHash('sha256').update(payload).digest('hex');
  if (actual !== manifest.sha256) {
    return err('manifest_checksum_failed', { expected: manifest.sha256, actual });
  }

  // P3 + name-conflict, over the incoming manifest, against the existing row's OWN registrations only.
  const existing = readManifestByName(ctx, manifest.name);
  const capViolation = checkCapabilities(ctx, manifest.capabilities, existing?.id);
  if (capViolation !== undefined) return capViolation as Result;

  // Version supersede rule (US-G02.1 boundary): a strictly-newer version supersedes in place, an
  // equal version re-installs in place, an older version is refused. Decided BEFORE the tx.
  if (existing !== undefined) {
    const oldV = parseVersion(existing.version);
    const newV = parseVersion(manifest.version);
    if (oldV !== null && newV !== null) {
      const older = compareTriples(newV, oldV) < 0;
      if (older) {
        return err('plugin_downgrade_refused', { installed: existing.version, offered: manifest.version });
      }
    }
  }

  const grantedScopes = (input.grantedScopes as string[] | undefined) ?? [];
  const granted = intersectScopes(manifest.requested, grantedScopes);
  const compatible = satisfies(CORE_CONTRACT_VERSION, manifest.compatRange);
  const status: PluginStatus = compatible ? 'installed' : 'incompatible';
  const source = input.source as PluginSource;

  const run = (): Result => {
    const now = ctx.clock.now();
    const permissionsJson = JSON.stringify({ requested: manifest.requested, granted });
    const capabilitiesJson = JSON.stringify(manifest.capabilities);
    let pluginId: string;
    if (existing !== undefined) {
      // Supersede in place. Record the event in the append-only audit chain BEFORE the row changes,
      // so the superseded version stays traceable even though the manifest table is not append-only.
      ctx.audit.record({ entityKind: 'plugin', entityId: existing.id, action: 'update', actor: ctx.actor, at: now });
      sweepRegistrations(ctx, existing.id);
      ctx.store.db
        .prepare(
          `UPDATE plugin_manifests SET version = ?, source = ?, capabilities = ?, permissions = ?,
             status = ?, compat_range = ?, sha256 = ?, registry_ref = ?, last_compat_check_at = ?, updated_at = ?
           WHERE workspace_id = ? AND id = ?`,
        )
        .run(manifest.version, source, capabilitiesJson, permissionsJson, status, manifest.compatRange, manifest.sha256, registryRef, now, now, ctx.workspaceId, existing.id);
      pluginId = existing.id;
    } else {
      pluginId = ctx.ids.next('plg');
      ctx.store.db
        .prepare(
          `INSERT INTO plugin_manifests
             (id, workspace_id, name, version, source, capabilities, permissions, status, compat_range,
              installed_by, sha256, registry_ref, last_compat_check_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(pluginId, ctx.workspaceId, manifest.name, manifest.version, source, capabilitiesJson, permissionsJson, status, manifest.compatRange, ctx.actor, manifest.sha256, registryRef, now, now, now);
    }
    // Install of a COMPATIBLE plugin performs the initial registration (install implies enabled); an
    // incompatible one persists its manifest but registers nothing (US-G02.4).
    if (compatible) writeRegistrations(ctx, pluginId, manifest.capabilities, now);
    const row = readManifest(ctx, pluginId) as ManifestRow;
    return ok({ plugin: mapView(row) });
  };

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'install_plugin', run);
}

function compareTriples(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
  return 0;
}

// --- list (R) -----------------------------------------------------------------------------------

export interface ListPluginsInput {
  savedViewId?: string;
  status?: string;
}

export function listPlugins(ctx: WorkspaceContext, input: ListPluginsInput): Result {
  // The G00 seam (OP10): a stored view's filters merge underneath anything named explicitly here.
  const applied = applySavedView(ctx, 'plugin', { savedViewId: input.savedViewId, status: input.status });
  if (!applied.ok) return applied;
  const filter = applied.filter;
  if (filter.status !== undefined && !isPluginStatus(filter.status)) {
    return err('invalid_input', { field: 'status' });
  }
  let sql = 'SELECT * FROM plugin_manifests WHERE workspace_id = ?';
  const params: unknown[] = [ctx.workspaceId];
  if (filter.status !== undefined) {
    sql += ' AND status = ?';
    params.push(filter.status);
  }
  sql += ' ORDER BY created_at DESC, name ASC';
  const rows = ctx.store.db.prepare(sql).all(...params) as ManifestRow[];
  return ok({ plugins: rows.map(mapView) });
}

// --- get (R) ------------------------------------------------------------------------------------

export interface GetPluginInput {
  pluginId?: string;
}

export function getPlugin(ctx: WorkspaceContext, input: GetPluginInput): Result {
  if (typeof input.pluginId !== 'string' || input.pluginId.length === 0) {
    return err('invalid_input', { field: 'pluginId' });
  }
  const row = readManifest(ctx, input.pluginId);
  if (row === undefined) return err('plugin_not_found', { pluginId: input.pluginId });
  const registrations = ctx.store.db
    .prepare('SELECT kind, name, registered_at FROM plugin_capability_registrations WHERE workspace_id = ? AND plugin_id = ? ORDER BY registered_at ASC, name ASC')
    .all(ctx.workspaceId, input.pluginId) as { kind: string; name: string; registered_at: string }[];
  return ok({
    plugin: mapView(row),
    registrations: registrations.map((r) => ({ kind: r.kind, name: r.name, registeredAt: r.registered_at })),
  });
}

// --- enable (W) ---------------------------------------------------------------------------------

export interface EnableInput {
  pluginId?: string;
  idempotencyKey?: string;
}

export function enablePlugin(ctx: WorkspaceContext, input: EnableInput): Result {
  if (typeof input.pluginId !== 'string' || input.pluginId.length === 0) {
    return err('invalid_input', { field: 'pluginId' });
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const row = readManifest(ctx, input.pluginId);
  if (row === undefined) return err('plugin_not_found', { pluginId: input.pluginId });

  // An incompatible plugin cannot be enabled: the compat gate has no "run anyway" override (§6b).
  if (!satisfies(CORE_CONTRACT_VERSION, row.compat_range)) {
    return err('plugin_incompatible', { compatRange: row.compat_range, coreVersion: CORE_CONTRACT_VERSION });
  }
  // A name a DIFFERENT plugin registered while this one was disabled is a fresh conflict (decided
  // before the tx). Its own prior registrations are excluded.
  const capViolation = checkCapabilities(ctx, parseCapabilities(row.capabilities), row.id);
  if (capViolation !== undefined) return capViolation;

  const run = (): Result => {
    const now = ctx.clock.now();
    sweepRegistrations(ctx, row.id);
    writeRegistrations(ctx, row.id, parseCapabilities(row.capabilities), now);
    ctx.store.db
      .prepare("UPDATE plugin_manifests SET status = 'installed', updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(now, ctx.workspaceId, row.id);
    return ok({ plugin: mapView(readManifest(ctx, row.id) as ManifestRow) });
  };
  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'enable_plugin', run);
}

// --- disable (W) --------------------------------------------------------------------------------

export function disablePlugin(ctx: WorkspaceContext, input: EnableInput): Result {
  if (typeof input.pluginId !== 'string' || input.pluginId.length === 0) {
    return err('invalid_input', { field: 'pluginId' });
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const row = readManifest(ctx, input.pluginId);
  if (row === undefined) return err('plugin_not_found', { pluginId: input.pluginId });

  const run = (): Result => {
    const now = ctx.clock.now();
    sweepRegistrations(ctx, row.id);
    ctx.store.db
      .prepare("UPDATE plugin_manifests SET status = 'disabled', updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(now, ctx.workspaceId, row.id);
    return ok({ plugin: mapView(readManifest(ctx, row.id) as ManifestRow) });
  };
  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'disable_plugin', run);
}

// --- uninstall (W) ------------------------------------------------------------------------------

export type UninstallPluginOk = { uninstalled: boolean; pluginId: string };

export function uninstallPlugin(ctx: WorkspaceContext, input: EnableInput): Result {
  if (typeof input.pluginId !== 'string' || input.pluginId.length === 0) {
    return err('invalid_input', { field: 'pluginId' });
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  // Replay a completed uninstall BEFORE the existence guard: this verb deletes its own row, so a
  // second call under the same key would otherwise hit `plugin_not_found` instead of the stored
  // success (the `recallIdempotent` pattern for a self-deleting write, spec §H-IDEMPOTENT boundary).
  const replay = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'uninstall_plugin');
  if (replay !== undefined) return replay;
  const row = readManifest(ctx, input.pluginId);
  if (row === undefined) return err('plugin_not_found', { pluginId: input.pluginId });
  const pluginId = row.id;

  const run = (): Result => {
    const now = ctx.clock.now();
    // Disable first (sweep), then record the deletion in the append-only audit chain BEFORE the row
    // is gone, then delete the manifest (plugin manifests are not §H-AUDIT financial data, so a real
    // delete is correct; the audit row is what keeps it traceable, spec §4).
    sweepRegistrations(ctx, pluginId);
    ctx.audit.record({ entityKind: 'plugin', entityId: pluginId, action: 'delete', actor: ctx.actor, at: now });
    ctx.store.db.prepare('DELETE FROM plugin_manifests WHERE workspace_id = ? AND id = ?').run(ctx.workspaceId, pluginId);
    return ok({ uninstalled: true, pluginId });
  };
  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'uninstall_plugin', run);
}

// --- checkCompat (pure) + refresh (W) -----------------------------------------------------------

export interface CompatResult {
  compatible: boolean;
  compatRange: string;
  version: string;
  coreVersion: string;
}

/** Pure (spec §4): compare one installed plugin's `compat_range` against `CORE_CONTRACT_VERSION`. */
export function checkCompat(row: { compat_range: string; version: string }): CompatResult {
  return {
    compatible: satisfies(CORE_CONTRACT_VERSION, row.compat_range),
    compatRange: row.compat_range,
    version: row.version,
    coreVersion: CORE_CONTRACT_VERSION,
  };
}

export function refreshPluginCompat(ctx: WorkspaceContext, input: EnableInput): Result {
  if (typeof input.pluginId !== 'string' || input.pluginId.length === 0) {
    return err('invalid_input', { field: 'pluginId' });
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const row = readManifest(ctx, input.pluginId);
  if (row === undefined) return err('plugin_not_found', { pluginId: input.pluginId });
  const result = checkCompat(row);

  const run = (): Result => {
    const now = ctx.clock.now();
    if (!result.compatible && row.status === 'installed') {
      // Fell out of compat: sweep its capabilities but retain the manifest + granted permissions for
      // a one-click re-enable after a plugin update (US-G02.4).
      sweepRegistrations(ctx, row.id);
      ctx.store.db
        .prepare("UPDATE plugin_manifests SET status = 'incompatible', last_compat_check_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
        .run(now, now, ctx.workspaceId, row.id);
    } else if (result.compatible && row.status === 'incompatible') {
      // Came back into compat: re-register from the still-persisted manifest.
      sweepRegistrations(ctx, row.id);
      writeRegistrations(ctx, row.id, parseCapabilities(row.capabilities), now);
      ctx.store.db
        .prepare("UPDATE plugin_manifests SET status = 'installed', last_compat_check_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
        .run(now, now, ctx.workspaceId, row.id);
    } else {
      // No status change; still stamp the check time so the badge shows a fresh evaluation.
      ctx.store.db
        .prepare('UPDATE plugin_manifests SET last_compat_check_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
        .run(now, now, ctx.workspaceId, row.id);
    }
    return ok({ plugin: mapView(readManifest(ctx, row.id) as ManifestRow), compatible: result.compatible });
  };
  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'refresh_plugin_compat', run);
}

// --- registry discovery (R) ---------------------------------------------------------------------

export interface SearchRegistryInput {
  query?: string;
  page?: number;
}

export function searchRegistry(ctx: WorkspaceContext, input: SearchRegistryInput): Result {
  void ctx;
  const client = registryClient();
  if (client === undefined) {
    return err('needs_registry', {});
  }
  const query = typeof input.query === 'string' ? input.query : '';
  const page = typeof input.page === 'number' && Number.isInteger(input.page) && input.page >= 0 ? input.page : 0;
  try {
    const result = client.search(query, page);
    return ok({ entries: result.entries, page: result.page, hasMore: result.hasMore });
  } catch {
    return err('registry_unreachable', {});
  }
}

export interface GetRegistryEntryInput {
  registryRef?: string;
}

export function getRegistryEntry(ctx: WorkspaceContext, input: GetRegistryEntryInput): Result {
  void ctx;
  if (typeof input.registryRef !== 'string' || input.registryRef.length === 0) {
    return err('invalid_input', { field: 'registryRef' });
  }
  const client = registryClient();
  if (client === undefined) {
    return err('needs_registry', {});
  }
  try {
    const entry = client.fetchEntry(input.registryRef);
    if (entry === null) return err('registry_entry_not_found', { registryRef: input.registryRef });
    return ok({ entry });
  } catch {
    return err('registry_unreachable', {});
  }
}
