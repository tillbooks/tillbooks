/**
 * THE SANDBOX (spec §4, the load-bearing decision of G02) and, honestly, the ONE place this build
 * forks from a literal reading of the spec. Read this whole note before trusting the boundary.
 *
 * WHAT THE SPEC ASKS FOR. An enabled plugin runs in its OWN OS process, spawned with filesystem
 * access scoped to `plugins/<plugin_id>/data` and no `import`/`require` path into `src/`, talking to
 * the host ONLY over a local IPC channel carrying the SAME MCP tool-call shape an external agent uses,
 * scoped to its granted `mcp_tool:*` permissions and checked against A24 on every call. A registered
 * Studio screen renders in a sandboxed iframe (`sandbox="allow-scripts"`, no `allow-same-origin`,
 * postMessage only).
 *
 * WHAT THIS REPO CAN AND CANNOT DO, AND WHERE THE LINE FALLS. A genuine OS-level jail (a real
 * filesystem boundary, a real process the kernel isolates) is not something a pure-Node module inside
 * a synchronous, deterministic money-path engine can provide: `child_process.fork` is async, would
 * make the offline gate flaky, and Node alone cannot jail a child's filesystem (that needs
 * seatbelt/landlock/a container). So G02 splits the boundary exactly the way the OSS core already
 * splits `EmailRelayPort`, `SignTransmitterPort` and the registry client:
 *
 *   - The ENGINE owns the SECURITY-DECIDING half, and it is real and tested: (1) a plugin's only data
 *     reach is `runPluginToolCall`, which routes EVERY call through the SAME action dispatch an
 *     external agent uses (the injected invoker), as the plugin's own actor, so A24 is re-checked
 *     live on every call and a plugin can never reach a verb its grant does not include; (2) a call
 *     to a tool outside the plugin's granted `mcp_tool:*` scopes is refused `forbidden` BEFORE the
 *     dispatch; (3) a call naming a reserved money-path tool is refused `capability_forbidden` as a
 *     belt to install-time's braces. This is the half that makes "sandboxed" a structural fact rather
 *     than a promise in the copy, and it does not depend on any process actually being spawned.
 *   - The HOST owns the PROCESS half, declared here as the `PluginSandboxHost` seam and SHIPPED WITH
 *     NO IMPLEMENTATION in the OSS core, exactly like the email relay. `pluginProcessDescriptor`
 *     states the precise spawn contract a host (the Studio runtime, a `till` CLI, a cloud tier)
 *     forks with: the scoped cwd, the empty module path into `src/`, the granted scopes. A host that
 *     wires a real jailed process satisfies the spec's letter; the OSS core, wiring none, degrades
 *     honestly (`plugin_host_unavailable`) rather than pretending a process is running.
 *
 * THE IFRAME half is fully realized in the Studio (a real `sandbox="allow-scripts"` frame with no
 * `allow-same-origin`, a CSP built from the granted `network:*` scopes, postMessage only);
 * `iframeSandboxDescriptor` is its single source of truth so the engine and the Studio agree on the
 * exact attribute string.
 *
 * THE PROCESS HALF IS NOW REAL AND KERNEL-ENFORCED, AND STILL A SEAM. The engine keeps declaring
 * `PluginSandboxHost` and ships none itself (so the offline, synchronous money-path engine never spawns
 * and the gate stays deterministic). A concrete OS-KERNEL jail lives ONE layer out, in the runtime/api
 * layer (`src/api/plugin-sandbox-host.ts`, `ProcessSandboxHost`): it spawns each enabled plugin in a
 * fresh Node process WRAPPED IN A KERNEL SANDBOX (Apple Seatbelt on macOS via `sandbox-exec`,
 * bubblewrap on Linux) that denies the child filesystem access outside its data dir + the node runtime,
 * denies network, and denies exec, BELOW the language runtime, so a builtin the runtime does not gate
 * (`node:sqlite`) cannot open the ledger bytes. Node's Permission Model + the `node:sqlite` guard are
 * kept as an inner belt (defence in depth). It talks to the child over an IPC channel ONLY, and routes
 * every inbound data request back through `runPluginToolCall` so the A24 check and the P3 money-path
 * denylist bind at the PROCESS boundary, not just in the copy. If NO kernel sandbox can be applied on
 * the platform, the host FAILS CLOSED (refuses to run the plugin, `plugin_sandbox_unavailable`), never
 * running it unsandboxed while claiming isolation. A host registers itself through `registerSandboxHost`;
 * absent a registered host the engine degrades honestly (`plugin_host_unavailable`).
 *
 * NET: the data-reach boundary (the thing a critic must trust) is enforced in-engine and asserted by
 * test; the OS-process isolation is a declared seam whose real implementation is the runtime host, and
 * the seam registration below is how the two meet.
 */

import type { Result } from '../result.js';
import { err } from '../result.js';
import { isReservedMoneyPathTool, moneyPathTools } from './reserved.js';

// --- Scopes -------------------------------------------------------------------------------------

/**
 * A parsed permission scope. A manifest requests, and a workspace grants, scope STRINGS of the form
 * `<kind>:<value>` (`mcp_tool:list_invoices`, `network:api.example.com`). The engine only ever needs
 * to reason about `mcp_tool` scopes (what a plugin may CALL) and `network` scopes (what its iframe
 * may reach); an unknown kind parses but grants nothing the engine acts on.
 */
export interface ParsedScope {
  kind: string;
  value: string;
}

export function parseScope(scope: unknown): ParsedScope | null {
  if (typeof scope !== 'string') return null;
  const idx = scope.indexOf(':');
  if (idx <= 0 || idx === scope.length - 1) return null;
  return { kind: scope.slice(0, idx), value: scope.slice(idx + 1) };
}

/** The tool names a granted scope set permits a plugin to call (its `mcp_tool:*` scopes). */
export function grantedToolNames(grantedScopes: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const s of grantedScopes) {
    const parsed = parseScope(s);
    if (parsed !== null && parsed.kind === 'mcp_tool') out.add(parsed.value);
  }
  return out;
}

/** The hosts a granted scope set permits the plugin's iframe to reach (its `network:*` scopes). */
export function grantedNetworkHosts(grantedScopes: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const s of grantedScopes) {
    const parsed = parseScope(s);
    if (parsed !== null && parsed.kind === 'network') out.push(parsed.value);
  }
  return out;
}

// --- The data-reach bridge (the enforced half) --------------------------------------------------

/**
 * The one door a plugin's code reaches TILL's data through: the same MCP tool-call shape an external
 * agent uses. An implementation dispatches `tool(input)` through the shared action registry AS
 * `asActor`, so A24 is resolved against the plugin's own grant on every call. Handed in from the api
 * layer (`src/api/registry.ts`) so `core/plugins` never imports the registry (acyclic).
 */
export type PluginInvoker = (tool: string, input: Record<string, unknown>, asActor: string) => Result;

/**
 * Run one plugin tool call through the bridge (US-G02.6). This is the enforcement point that makes a
 * plugin's data reach architecturally identical to an agent's:
 *
 *   1. a tool OUTSIDE the plugin's granted `mcp_tool:*` scopes is refused `forbidden` before dispatch
 *      (the install-time grant is not the only gate: a call requiring an ungranted scope fails at
 *      CALL time too, US-G02.2 permission-denied);
 *   2. a tool naming a reserved money-path verb is refused `capability_forbidden` (belt to install's
 *      braces, so P3 holds even if a manifest slipped one past install somehow);
 *   3. otherwise the call goes through the SAME dispatch an agent uses, AS the plugin's actor, so the
 *      §H-TENANT scope and the A24 capability check bind it exactly as they bind any other caller.
 *
 * `pluginActor` is the identity a plugin's calls are attributed to (and A24-resolved against): the
 * workspace member who installed it, so a plugin can never reach past what that member may do.
 */
export function runPluginToolCall(
  invoke: PluginInvoker,
  args: {
    grantedScopes: readonly string[];
    pluginActor: string;
    tool: string;
    input: Record<string, unknown>;
  },
): Result {
  // Fail CLOSED: if the reserved money-path set has not been wired yet (the registry not loaded), we
  // cannot verify P3, so we refuse EVERY call rather than admit one in the blind window. In practice
  // the set is always wired by the time any verb runs (the engine is only reachable through
  // `registry.ts`, which wires it at load); this is the belt to `plugin.install`'s braces
  // (`plugin_guard_uninitialised`), applied at the live call boundary too.
  if (moneyPathTools() === undefined) {
    return err('capability_forbidden', { reason: 'guard_uninitialised', tool: args.tool });
  }
  if (isReservedMoneyPathTool(args.tool)) {
    return err('capability_forbidden', { reason: 'no_second_posting_path', tool: args.tool });
  }
  if (!grantedToolNames(args.grantedScopes).has(args.tool)) {
    return err('forbidden', { tool: args.tool, reason: 'scope_not_granted' });
  }
  return invoke(args.tool, args.input, args.pluginActor);
}

// --- The process seam (the declared, unshipped half) --------------------------------------------

/**
 * The spawn contract a runtime host forks a plugin's OS process with (spec §4). Single-sourced here
 * so a host and the engine agree on the exact isolation shape rather than each inventing one.
 *
 * `cwd` is the plugin's ONLY writable filesystem territory; `noModulePathIntoSrc` records the
 * invariant a host must honour (no `NODE_PATH`, no `--experimental-loader`, nothing that would let the
 * child `require` a module under `src/`); `allowedTools` is the closed set the bridge will honour, so
 * a host that pre-filters gets the same answer the bridge gives.
 */
export interface PluginProcessDescriptor {
  pluginId: string;
  cwd: string;
  noModulePathIntoSrc: true;
  allowedTools: readonly string[];
}

export function pluginProcessDescriptor(
  pluginId: string,
  grantedScopes: readonly string[],
): PluginProcessDescriptor {
  return {
    pluginId,
    cwd: `plugins/${pluginId}/data`,
    noModulePathIntoSrc: true,
    allowedTools: [...grantedToolNames(grantedScopes)],
  };
}

/**
 * The iframe attributes a Studio screen a plugin registers mounts with (spec §4/§6b). The Studio uses
 * this so its frame and the engine's stated boundary cannot drift. `sandbox` never contains
 * `allow-same-origin` (that would defeat the whole boundary); the CSP `connect-src` is exactly the
 * plugin's granted `network:*` hosts and nothing else (`'none'` when it was granted none).
 */
export interface IframeSandboxDescriptor {
  sandbox: string;
  connectSrc: string;
}

export function iframeSandboxDescriptor(grantedScopes: readonly string[]): IframeSandboxDescriptor {
  const hosts = grantedNetworkHosts(grantedScopes);
  return {
    sandbox: 'allow-scripts',
    connectSrc: hosts.length === 0 ? "'none'" : hosts.join(' '),
  };
}

/**
 * The runtime host seam (OP4 shape). A host (the Studio runtime, a `till` CLI, a cloud tier) that can
 * genuinely jail an OS process implements this; the OSS core ships NONE, so an enabled plugin's
 * registrations exist but its process is not running, and a call to one of its tools degrades honestly
 * through the api layer (`plugin_host_unavailable`) rather than pretending. This is the declare-the-
 * seam-ship-nothing technique the email relay and the registry client already use.
 */
export interface PluginSandboxHost {
  /** Spawn (or confirm running) the plugin's jailed process. */
  start(descriptor: PluginProcessDescriptor): void;
  /** Terminate the plugin's process (on disable/uninstall/incompatible sweep, or a crash). */
  stop(pluginId: string): void;
  /** Is the plugin's process currently running? */
  isRunning(pluginId: string): boolean;
}

/**
 * The process-global registration seam for the sandbox host (mirrors `registerRegistryClient`). A
 * runtime host (the Studio runtime, a `till` CLI, a cloud tier) that can genuinely jail an OS process
 * registers its `PluginSandboxHost` here at startup; the engine and the api layer consult
 * `sandboxHost()` when a plugin is enabled or disabled.
 *
 * WHY A REGISTRATION SEAM AND NOT A DIRECT IMPORT. `core/plugins` must never import `src/api/*` (the
 * dependency runs the other way, which keeps the module graph acyclic), and the concrete jail is a
 * `child_process`-spawning, async thing that has no business inside the synchronous, offline money-path
 * engine. So the engine holds only the interface and a slot; the api layer fills the slot. Absent a
 * registered host, `sandboxHost()` is `undefined` and every consult degrades honestly rather than
 * pretending a process is running: the OSS-core default is no jail wired, exactly as before, and the
 * offline gate spawns nothing.
 */
let _sandboxHost: PluginSandboxHost | undefined;

/** Register (or, with `undefined`, clear) the process-wide sandbox host. Called by a runtime host. */
export function registerSandboxHost(host: PluginSandboxHost | undefined): void {
  _sandboxHost = host;
}

/** The registered sandbox host, or `undefined` when none is wired (the OSS-core default). */
export function sandboxHost(): PluginSandboxHost | undefined {
  return _sandboxHost;
}
