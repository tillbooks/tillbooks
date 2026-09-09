/**
 * G02's ten verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `notificationActions` precedent), so several agents appending to the append-only registry at once
 * collide over a line rather than a block.
 *
 * Five writes (install/enable/disable/uninstall/compat-refresh) and five reads (preview/list/get and
 * the two registry-discovery reads). Every write carries `workspaceId` + `idempotencyKey`
 * (§H-IDEMPOTENT) and asserts `manage_plugins` (A24, owner-only by default); the reads ride
 * `read_master_data` so a plugin panel is browsable read-only by any member (US-G02.1).
 *
 * As with `fx-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  previewInstall,
  installPlugin,
  listPlugins,
  getPlugin,
  enablePlugin,
  disablePlugin,
  uninstallPlugin,
  refreshPluginCompat,
  searchRegistry,
  getRegistryEntry,
  sandboxHost,
  pluginProcessDescriptor,
} from '../core/plugins/index.js';

export interface PluginActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
}

/** The registry's documented cast: the JSON input is handed to the verb as its typed input. */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

const OBJ = { type: 'object' } as const;
const ARR = { type: 'array' } as const;

/**
 * Reconcile the OS-process sandbox to a plugin's persisted status after a lifecycle verb (US-G02.2/3).
 * The synchronous engine verb owns the DB truth; the process is reconciled here, at the api layer,
 * where an async, `child_process`-spawning jail belongs. It is BEST-EFFORT and NEVER changes the
 * verb's Result: the manifest is already enabled/disabled, and when no host is registered
 * (`sandboxHost()` undefined, the OSS-core default) this is a pure no-op, so the offline gate spawns
 * nothing. A registered host runs the plugin's process for `status:'installed'` and stops it otherwise.
 */
function reconcileHostStatus(result: Result): Result {
  const host = sandboxHost();
  if (host === undefined || result.ok !== true) return result;
  const plugin = (result as unknown as { plugin?: { id?: unknown; status?: unknown; granted?: unknown } }).plugin;
  if (plugin === undefined || typeof plugin.id !== 'string') return result;
  const grantedScopes = Array.isArray(plugin.granted) ? plugin.granted.filter((s): s is string => typeof s === 'string') : [];
  try {
    if (plugin.status === 'installed') host.start(pluginProcessDescriptor(plugin.id, grantedScopes));
    else host.stop(plugin.id);
  } catch {
    // A host that fails to (re)start a process must not fail an already-committed enable/disable; the
    // process is reconciled out of band and the plugin's next tool call degrades honestly (US-G02.6).
  }
  return result;
}

/** Stop a plugin's process after uninstall (whose Result carries only the id, not a status view). */
function reconcileHostStopped(result: Result, pluginId: unknown): Result {
  const host = sandboxHost();
  if (host === undefined || result.ok !== true || typeof pluginId !== 'string') return result;
  try {
    host.stop(pluginId);
  } catch {
    // Best-effort teardown; the manifest row is already gone.
  }
  return result;
}

/** The G02 verbs, in append order (the §5 table order). */
export function pluginActions(h: PluginActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT } = h;

  return [
    ctxAction(
      'preview_plugin_install',
      'read',
      'Prüfe eine Erweiterung vor der Installation (US-G02.1): parse a `.tillplugin` bundle`s manifest and return its name, version, declared capabilities (which MCP tools, Studio screens, report sources, automation actions it registers) and requested permission scopes, plus whether it is compatible with the current core, WITHOUT persisting anything and WITHOUT starting a sandbox. A malformed manifest answers invalid_manifest naming what failed to parse.',
      ctxSchema({ source: STR, packageRef: OBJ }, ['source', 'packageRef']),
      (ctx, input) => previewInstall(ctx, as(input)),
    ),
    ctxAction(
      'install_plugin',
      'write',
      'Installiere eine Erweiterung (US-G02.1): check the pinned sha256 against the bundle (manifest_checksum_failed on a mismatch, nothing persisted), REJECT any capability naming a reserved money-path tool (capability_forbidden, no_second_posting_path, the WHOLE install fails, P3) or colliding with an existing tool/screen/source name (capability_name_conflict), store permissions.granted as the INTERSECTION of grantedScopes and the manifest`s requested scopes (never a superset), resolve compat_range against the core version, and persist a plugin_manifests row (status installed, or incompatible when the range fails). A newer version of an already-installed plugin supersedes the row in place and writes an audit_log entry before it changes.',
      ctxSchema({ source: STR, packageRef: OBJ, grantedScopes: ARR, idempotencyKey: STR }, ['source', 'packageRef', 'idempotencyKey']),
      (ctx, input) => installPlugin(ctx, as(input)),
    ),
    ctxAction(
      'list_plugins',
      'read',
      'Die installierten Erweiterungen (P5, US-G02.2/3/4): every plugin manifest for the workspace newest first, each with its status, capability count, requested/granted scopes and compat verdict. savedViewId applies a stored G00 view over the plugin kind (filter by status or capability kind); its filters merge underneath any status named explicitly here.',
      ctxSchema({ status: STR, savedViewId: STR }),
      (ctx, input) => listPlugins(ctx, as(input)),
    ),
    ctxAction(
      'get_plugin',
      'read',
      'Lies eine Erweiterung (US-G02.2/3/4): one plugin manifest with its granted permission set and the precise list of capability registrations it currently holds (empty when disabled or incompatible).',
      ctxSchema({ pluginId: STR }, ['pluginId']),
      (ctx, input) => getPlugin(ctx, as(input)),
    ),
    ctxAction(
      'enable_plugin',
      'write',
      'Aktiviere eine Erweiterung (US-G02.2/3): register every capability the still-persisted manifest declares (its MCP tools, Studio screen, report source, automation actions) and start its sandbox, flipping status to installed. Refuses an incompatible plugin (plugin_incompatible, no run-anyway override, §6b) and a capability whose name another plugin has since taken (capability_name_conflict).',
      ctxSchema({ pluginId: STR, idempotencyKey: STR }, ['pluginId', 'idempotencyKey']),
      (ctx, input) => reconcileHostStatus(enablePlugin(ctx, as(input))),
    ),
    ctxAction(
      'disable_plugin',
      'write',
      'Deaktiviere eine Erweiterung ohne sie zu deinstallieren (US-G02.3): sweep every capability registration the plugin holds (its MCP tools vanish, its Studio screen unmounts, its report source and automation actions stop resolving), stop its sandbox, and flip status to disabled, keeping the manifest and granted permissions so a later enable_plugin needs no re-install. History (audit rows, past automation runs) is untouched.',
      ctxSchema({ pluginId: STR, idempotencyKey: STR }, ['pluginId', 'idempotencyKey']),
      (ctx, input) => reconcileHostStatus(disablePlugin(ctx, as(input))),
    ),
    ctxAction(
      'uninstall_plugin',
      'write',
      'Deinstalliere eine Erweiterung (US-G02.3): disable it first (sweep its registrations), record the removal in the append-only audit_log before the row is gone, then delete the manifest row (plugin manifests are not §H-AUDIT financial data, so a real delete is correct). Traceability rides the audit chain, not an append-only manifest table.',
      ctxSchema({ pluginId: STR, idempotencyKey: STR }, ['pluginId', 'idempotencyKey']),
      (ctx, input) => reconcileHostStopped(uninstallPlugin(ctx, as(input)), (input as { pluginId?: unknown }).pluginId),
    ),
    ctxAction(
      'refresh_plugin_compat',
      'write',
      'Prüfe die Kompatibilität neu (US-G02.4): compare the plugin`s compat_range against the current core version with standard semver range semantics and persist the verdict. A range that no longer matches flips status to incompatible and sweeps the plugin`s capabilities (its manifest and granted permissions retained); a range that matches again flips it back to installed and re-registers. Never a crash, only the badge (P9).',
      ctxSchema({ pluginId: STR, idempotencyKey: STR }, ['pluginId', 'idempotencyKey']),
      (ctx, input) => reconcileHostStatus(refreshPluginCompat(ctx, as(input))),
    ),
    ctxAction(
      'search_plugin_registry',
      'read',
      'Durchsuche das Erweiterungs-Verzeichnis (US-G02.5): query a configured registry through the OSS core`s registryClient seam and return a page of results (publisher, capability summary, requested permissions) that route into the same install-review flow as a local file. The OSS core wires NO client, so this answers needs_registry (never a hardcoded remote host); a configured registry that does not respond answers registry_unreachable (P9).',
      ctxSchema({ query: STR, page: INT }),
      (ctx, input) => searchRegistry(ctx, as(input)),
    ),
    ctxAction(
      'get_plugin_registry_entry',
      'read',
      'Lies einen Verzeichnis-Eintrag (US-G02.5): resolve one registry reference to its full entry (its requested scopes drive the install-review dialog). needs_registry when no registry is configured, registry_unreachable when a configured one does not respond (P9).',
      ctxSchema({ registryRef: STR }, ['registryRef']),
      (ctx, input) => getRegistryEntry(ctx, as(input)),
    ),
  ];
}
