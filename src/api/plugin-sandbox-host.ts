/**
 * THE OS-KERNEL PLUGIN JAIL (spec §4, US-G02.6). The engine (`src/core/plugins/sandbox.ts`) declares
 * the `PluginSandboxHost` seam and ships none itself, so the synchronous, offline money-path engine
 * never spawns a process and the gate stays deterministic. This file is the runtime host that FILLS
 * that seam: it runs each enabled plugin in a fresh Node child process whose access to the filesystem,
 * the network and process-exec is denied by the OS KERNEL, below the language runtime, and lets the
 * plugin reach TILL data over ONE IPC channel the parent polices on every call.
 *
 * WHY A KERNEL SANDBOX AND NOT A NODE-RUNTIME ONE (the pivot, and it is load-bearing). An earlier
 * version of this jail enforced isolation with Node's Permission Model (`--permission`) plus a JS
 * module-load guard against `node:sqlite`. A security critic defeated it TWICE, and both escapes were
 * the same shape: a guarantee enforced INSIDE the language runtime can be unwound from inside the
 * language runtime.
 *
 *   1. `node:sqlite` is NOT gated by `--permission`. The JS defences (a `--no-experimental-sqlite`
 *      flag and a module-load hook) are bypassable: a custom `nodePath` drops the flag, and a plugin
 *      can register its own ESM resolve hook that short-circuits `node:sqlite` before ours (hooks run
 *      most-recent-first). The critic re-read the ledger bytes live. A file-opening builtin that the
 *      runtime does not gate is whack-a-mole by construction.
 *   2. A planted hardlink and off-heap (Buffer/ArrayBuffer) memory cannot be closed in-process.
 *
 * The durable answer is to move the boundary OUT of the runtime and into the kernel: deny the child
 * fs/network/exec access so that `node:sqlite` (or any other file-opener, known or not-yet-invented)
 * SIMPLY CANNOT OPEN THE BYTES. The Node Permission Model and the JS `node:sqlite` block are KEPT as
 * an inner belt (defence in depth), but they are no longer the guarantee.
 *
 * WHAT THE KERNEL DENIES THE CHILD, PER PLATFORM (each claim maps to a mechanism a test exercises):
 *
 *   - **macOS (darwin): Apple Seatbelt via `sandbox-exec -p '<profile>'`.** `sandbox-exec` is
 *     deprecated by Apple but is the only documented way to apply a Seatbelt policy to an arbitrary
 *     user-space process without App-Store entitlements, and it is functional on current macOS (built
 *     and proven on macOS 15 / Darwin 25). The profile (`SEATBELT_PROFILE`) is `(allow default)` with
 *     the SECURITY-RELEVANT surfaces flipped to deny-by-default and a minimal re-allow:
 *       · `(deny file-read*)` then re-allow ONLY the runtime's own files (`/usr`, `/System`,
 *         `/Library`, the dyld cache under `/private/var/db`, the node install prefix), the plugin's
 *         own data dir, this bootstrap file and its nearest `package.json`. The ledger DB, the repo,
 *         `/etc`, `$HOME` and every other path are DENIED. `file-read-metadata` (lstat/stat) is
 *         allowed globally so the loader can resolve paths: metadata exposes existence, never the
 *         ledger BYTES, which stay behind `file-read-data`.
 *       · `(deny file-write*)` then re-allow ONLY the data dir (plus `/dev/null`).
 *       · `(deny process-exec*)` then re-allow ONLY the one node binary (matched on its realpath).
 *       · `(deny network*)`: no bind, no outbound connect. The inherited IPC fd is an already-open
 *         pipe, not a new socket, so it is untouched.
 *     KNOWN LIMIT, disclosed: non-file syscalls (mach-lookup, sysctl, shared memory) are left allowed
 *     because node aborts at startup without them and NONE of them reaches the ledger bytes; the
 *     boundary this profile enforces is fs + network + exec, which is exactly the escape surface.
 *   - **Linux: bubblewrap (`bwrap`), an unprivileged mount+namespace jail.** A fresh mount namespace
 *     starts EMPTY and we bind back ONLY what the child needs read-only (`/usr`, `/bin`, `/lib*`, the
 *     node prefix, the bootstrap, its `package.json`) plus the data dir read-write, so the fs
 *     allowlist is deny-by-default by construction: the ledger is simply not in the namespace.
 *     `--unshare-all` (which includes `--unshare-net`) gives the child its own empty network namespace
 *     with only an isolated loopback, so it cannot reach the host's loopback listeners or anything
 *     else. `--die-with-parent` prevents an orphan. Bubblewrap was chosen over raw Landlock+seccomp
 *     because those require a native addon or a compiled helper to reach the syscalls from Node,
 *     whereas `bwrap` is a standard, widely-available system binary (it is what Flatpak and Claude
 *     Code's own sandbox use); no heavy native dependency is added. It is PROBED and SELF-TESTED at
 *     host construction (a throwaway `bwrap --unshare-net -- true`), so a box where unprivileged user
 *     namespaces are disabled (e.g. an AppArmor-restricted runner) is detected as `none`, never
 *     silently trusted.
 *   - **Memory.** Linux adds a hard `RLIMIT_AS` via `ulimit -v` in the launch wrapper, so an off-heap
 *     Buffer bomb hits the address-space ceiling and the allocation THROWS. That `ulimit` is FAIL-CLOSED:
 *     if the cap cannot be applied the wrapper prints a diagnostic and exits non-zero WITHOUT exec'ing
 *     node, so the host sees a crash rather than a silently-uncapped child (a swallowed `ulimit` failure
 *     was the one way an off-heap bomb could run bounded only by the wall-clock timeout, since the RSS
 *     watchdog does not run on Linux). macOS (Darwin) does not enforce `RLIMIT_AS` (verified: `ulimit -v`
 *     returns EINVAL), so on macOS the hard bound is a host-side RSS watchdog that polls the child and
 *     SIGKILLs it above the cap, plus the V8 heap cap (`--max-old-space-size`) and the per-call
 *     wall-clock timeout. Both platforms therefore bound an off-heap bomb; only Linux does it with a
 *     kernel limit, and this file says so rather than claiming a uniform guarantee.
 *
 * FAIL CLOSED (non-negotiable). If NO supported kernel sandbox can be applied on the current platform
 * (`sandbox-exec` missing on macOS, `bwrap` absent or its self-test failing on Linux, or an unknown
 * OS), the host REFUSES to run the plugin: `start` spawns NOTHING and every subsequent `awaitReady`
 * and `invoke` returns `plugin_sandbox_unavailable`. It NEVER runs a plugin unsandboxed while claiming
 * isolation. `sandboxStatus()` reports the platform, the active mechanism, and whether isolation is
 * genuinely in force, so the copy can never overclaim what the kernel is enforcing. `requireKernelSandbox`
 * defaults to true; a host may set it false ONLY for a trusted first-party plugin on a box with no
 * sandbox, and even then the status reports `active:false` honestly.
 *
 * DEFENCE IN DEPTH KEPT FROM THE PRIOR JAIL (still real, still tested): the scrubbed env (no inherited
 * secrets, no ledger handle), the P3 reserved money-path denylist + A24 scope check enforced PARENT-side
 * on every `host_call` (`runPluginToolCall`, fail-closed when the money-path set is unwired), the
 * pre-planted escaping-symlink refusal at start, the Node Permission Model + JS `node:sqlite` block as
 * the inner belt, the per-call timeout, and clean SIGTERM->SIGKILL teardown with no orphan.
 *
 * NEW at start, closing the hardlink gap the prior jail only documented: `start` also refuses to launch
 * a plugin whose data dir contains a regular file with `st_nlink > 1` (a hardlink, indistinguishable
 * from a real file by a symlink scan, that could name the ledger inode from a path the fs allowlist
 * permits). A benign plugin's files have `nlink == 1`; a planted hardlink to an outside secret has
 * `nlink >= 2`. Combined with the runtime denial of CREATING a hardlink, the planted-hardlink escape
 * is closed at start rather than merely disclosed.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { realpathSync, readdirSync, statSync, lstatSync, accessSync, constants as fsConstants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import type { Result } from '../core/result.js';
import { ok, err } from '../core/result.js';
import {
  runPluginToolCall,
  type PluginInvoker,
  type PluginProcessDescriptor,
  type PluginSandboxHost,
} from '../core/plugins/index.js';

/** Which kernel mechanism confines the child on this host, or `none` when none can be applied. */
export type SandboxMechanism = 'seatbelt' | 'bubblewrap' | 'none';

/** An honest, machine-readable statement of what the kernel is (and is not) enforcing on this host. */
export interface SandboxStatus {
  /** `process.platform` of the host. */
  platform: NodeJS.Platform;
  /** The kernel mechanism in force (`none` means no kernel jail is available). */
  mechanism: SandboxMechanism;
  /** True IFF a kernel sandbox will actually confine a spawned plugin (mechanism !== 'none'). */
  active: boolean;
  /** Whether the host refuses to run a plugin when no kernel sandbox is available (fail-closed). */
  requireKernelSandbox: boolean;
  /** Plain-language list of what the kernel denies the child on this platform. */
  denies: readonly string[];
  /** Honestly-disclosed residual limits of the active mechanism (empty when `none`). */
  residual: readonly string[];
}

/** How a host resolves the per-plugin facts the bare descriptor does not carry. */
export interface ProcessSandboxHostConfig {
  /**
   * The trusted, parent-side dispatch a `host_call` routes through. In production this is the shared
   * action registry's invoker (dispatch a tool as an actor); it is the SAME one an external agent's
   * calls go through, which is the whole point of US-G02.6.
   */
  invoke: PluginInvoker;
  /** Absolute base dir under which a plugin's data lives: `<pluginRoot>/<pluginId>/data`. */
  pluginRoot: string;
  /** The A24 actor a plugin's `host_call`s are attributed to (the member who installed it). */
  resolveActor: (pluginId: string) => string;
  /** The plugin's executable entry (absolute). Default: `<dataDir>/index.mjs`. */
  resolveEntry?: (pluginId: string, dataDir: string) => string;
  /**
   * The plugin's granted scope strings, for the `host_call` boundary check. Default: derived from the
   * descriptor's `allowedTools` as `mcp_tool:<name>` (the only scope kind the boundary check reads).
   */
  resolveGrantedScopes?: (pluginId: string, descriptor: PluginProcessDescriptor) => readonly string[];
  /** The compiled jail bootstrap. Default: the sibling `plugin-jail-bootstrap.js` next to this file. */
  bootstrapPath?: string;
  /** The Node binary to spawn. Default: `process.execPath`. */
  nodePath?: string;
  /** Heap cap (MB) via `--max-old-space-size`, an inner belt to the kernel/RSS bound. Default 128. */
  memoryLimitMb?: number;
  /** Per-`invoke` wall-clock budget (ms) before the process is terminated as a runaway. Default 5000. */
  callTimeoutMs?: number;
  /** How long to wait for the plugin's `ready` handshake (ms). Default 5000. */
  startTimeoutMs?: number;
  /** Grace (ms) between SIGTERM and SIGKILL on teardown. Default 300. */
  gracefulKillMs?: number;
  /** Extra env for the child, merged over the scrubbed minimal PATH. Rarely needed; keep it small. */
  extraEnv?: Record<string, string>;
  /**
   * FAIL-CLOSED switch (default TRUE). When true and no kernel sandbox can be applied, `start` refuses
   * to spawn and the plugin degrades as `plugin_sandbox_unavailable`. Set false ONLY to run a trusted
   * first-party plugin unsandboxed on a box with no mechanism; `sandboxStatus().active` still reports
   * the truth.
   */
  requireKernelSandbox?: boolean;
  /**
   * TEST SEAM: force the detected mechanism instead of probing the host. Lets a test drive the
   * fail-closed path (`'none'`) deterministically on any platform. Never set in production.
   */
  sandboxMechanismOverride?: SandboxMechanism;
  /** RSS watchdog poll interval (ms) on platforms without a kernel address-space limit. Default 200. */
  memoryWatchdogIntervalMs?: number;
}

/** The richer host the api layer drives, a superset of the engine's `PluginSandboxHost` seam. */
export interface ProcessSandboxHost extends PluginSandboxHost {
  /** Ask a running plugin to service a tool call; time-bounded, terminates a runaway. */
  invoke(pluginId: string, tool: string, input: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<Result>;
  /** Resolve once the plugin's entry has loaded (or the start times out / it crashes / it was refused). */
  awaitReady(pluginId: string, timeoutMs?: number): Promise<Result>;
  /** The plugin ids with a live process. */
  runningPluginIds(): string[];
  /** The OS pid of a plugin's process, or undefined when it is not running (teardown assertions). */
  pidOf(pluginId: string): number | undefined;
  /** The honest kernel-sandbox status of this host (what it denies, and whether it is active). */
  sandboxStatus(): SandboxStatus;
  /** Terminate every plugin process (teardown / process exit). */
  shutdown(): void;
}

interface PendingCall {
  resolve: (r: Result) => void;
  timer: NodeJS.Timeout;
}

interface ReadyWaiter {
  settle: (r: Result) => void;
  done: boolean;
}

interface Handle {
  child: ChildProcess;
  grantedScopes: readonly string[];
  actor: string;
  pending: Map<string, PendingCall>;
  readyWaiters: ReadyWaiter[];
  ready: boolean;
  exited: boolean;
  seq: number;
  memWatch?: NodeJS.Timeout;
}

interface Incoming {
  __g02?: unknown;
  id?: unknown;
  tool?: unknown;
  input?: unknown;
  ok?: unknown;
  result?: unknown;
  error?: unknown;
}

const DEFAULT_BOOTSTRAP = fileURLToPath(new URL('./plugin-jail-bootstrap.js', import.meta.url));

const SQLITE_DISABLE_FLAG = '--no-experimental-sqlite';
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/**
 * A path is safe to inline into an SBPL profile only if it is absolute and contains no character that
 * could break the quoted-string grammar. Data-dependent paths (the data dir, the bootstrap) travel as
 * `-D` parameters instead; only HOST-derived runtime roots (where node's own dylibs live, never a
 * plugin-controlled value) are inlined, and even those are validated here as defence.
 */
function sanitizeSbplPath(p: string): string {
  if (!path.isAbsolute(p) || /["\n\r\\]/.test(p)) {
    throw new Error(`plugin_sandbox_config: unsafe runtime path for Seatbelt profile: ${JSON.stringify(p)}`);
  }
  return p;
}

/**
 * The read-allowed roots where the node runtime and its dynamic libraries live. Derived from node's
 * own location, never from a plugin. Handles the Homebrew layout, where `node` resolves into
 * `<brew>/Cellar/node/<ver>/bin/node` but its dylibs are symlinks under `<brew>/opt/*`: the common
 * ancestor `<brew>` must be readable or dyld aborts the child at load time. For a system or nvm node
 * the `<bin>/..` prefix already covers the libraries.
 */
function computeRuntimeRoots(nodePath: string, nodeReal: string): string[] {
  const roots = new Set<string>();
  for (const p of [nodePath, nodeReal]) {
    roots.add(path.dirname(path.dirname(p)));
    const cellar = p.indexOf('/Cellar/');
    if (cellar > 0) roots.add(p.slice(0, cellar)); // the Homebrew prefix above /Cellar/
  }
  return [...roots].filter((r) => r.length > 1); // never '/' (would defeat deny-default reads)
}

/**
 * Build the Seatbelt profile applied to the child on macOS. `(allow default)` keeps the benign syscalls
 * node needs to boot (mach-lookup, sysctl, shared memory), then flips the SECURITY surfaces to
 * deny-by-default and re-allows a minimal set. The plugin-controlled paths (data dir, bootstrap) travel
 * as `-D` parameters so a data-dir name can never break out of the profile grammar; the host-derived
 * runtime roots are inlined (validated by `sanitizeSbplPath`). `file-read-metadata` is allowed globally
 * so the loader can lstat parent components; only `file-read-data` gates the ledger BYTES.
 */
function buildSeatbeltProfile(runtimeRoots: readonly string[]): string {
  const rootLines = runtimeRoots.map((r) => `  (subpath "${sanitizeSbplPath(r)}")`).join('\n');
  return `(version 1)
(allow default)
(deny process-exec*)
(allow process-exec (literal (param "NODE_REAL")))
(deny file-write*)
(allow file-write*
  (subpath (param "DATA_DIR"))
  (literal "/dev/null"))
(deny file-read*)
(allow file-read-metadata)
(allow file-read*
  (subpath "/usr")
  (subpath "/System")
  (subpath "/Library")
  (subpath "/private/var/db")
${rootLines}
  (subpath (param "DATA_DIR"))
  (literal (param "BOOTSTRAP"))
  (literal (param "PKG_JSON"))
  (literal "/")
  (literal "/dev/null")
  (literal "/dev/random")
  (literal "/dev/urandom")
  (literal "/dev/tty")
  (literal "/dev/dtracehelper"))
(deny network*)
`;
}

const SEATBELT_DENIES = [
  'read of any file outside the plugin data dir and the node runtime (ledger DB, repo, /etc, $HOME)',
  'write of any file outside the plugin data dir',
  'exec of any binary except the one node runtime',
  'all network: bind and outbound connect',
];
const SEATBELT_RESIDUAL = [
  'non-file syscalls (mach-lookup, sysctl, shared memory) are left allowed because node aborts at startup without them; none is a DIRECT read path to the ledger, but mach-lookup leaves a theoretical confused-deputy surface (a system service asked to act on the child\'s behalf) that a fully deny-default mach policy would remove at the cost of node no longer booting',
  'Darwin does not enforce RLIMIT_AS, so an off-heap bomb is bounded by the host-side RSS watchdog and the wall-clock timeout, not by a kernel address-space limit',
  'sandbox-exec is deprecated by Apple; it is the only documented arbitrary-process Seatbelt entrypoint and is functional on current macOS',
];
const BWRAP_DENIES = [
  'read/write of any path not bound into the mount namespace (ledger DB, repo, /etc, $HOME are simply absent)',
  'all network: the child gets its own empty network namespace (isolated loopback only)',
  'exec is confined to the bound read-only runtime paths',
];
const BWRAP_RESIDUAL = [
  'requires unprivileged user namespaces; a box that disables them is detected as `none` and fails closed',
  'the IPC fd is passed through bwrap; a bwrap build that dropped inherited fds would break the handshake (detected as a start timeout, never a silent unsandboxed run)',
  'the RLIMIT_AS address-space cap is applied via `ulimit -v` in the launch wrapper; if it cannot be set the wrapper refuses to exec node (fail-closed) rather than running the plugin uncapped, so the child crashes instead of running bounded only by the wall-clock timeout',
];

/**
 * True when the DEFAULT Node binary accepts `--no-experimental-sqlite` (it does on every Node where
 * `node:sqlite` is still experimental). Checked without spawning. When false (a custom `nodePath`, or a
 * future Node that dropped the flag), the spawn omits the flag and relies on the inner-belt import guard.
 */
function defaultNodeAcceptsSqliteFlag(): boolean {
  try {
    return process.allowedNodeEnvironmentFlags.has(SQLITE_DISABLE_FLAG);
  } catch {
    return false;
  }
}

/** Resolve a path to its realpath, falling back to the input when it does not yet exist. */
function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The nearest `package.json` at or above `startDir`, or undefined. Node determines a `.js` main
 * script's module type (ESM vs CJS) by reading the closest `package.json` "type"; the compiled
 * bootstrap is a `.js`, so the kernel allowlist must let the child READ that one file or an older Node
 * (< 22.7, before syntax detection) would refuse to load it as ESM. We resolve it once at start and
 * allow exactly that literal, nothing more of the repo.
 */
function nearestPackageJson(startDir: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < 64; i++) {
    const candidate = path.join(dir, 'package.json');
    try {
      statSync(candidate);
      return candidate;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * The first filesystem escape hatch under `realRoot`, or undefined when there is none:
 *   - a SYMLINK whose target escapes `realRoot` (the fs allowlist matches on realpath and would follow
 *     it out), or a dangling/unresolvable symlink (fail closed);
 *   - a regular FILE with `st_nlink > 1`, i.e. a HARDLINK: a second name for an inode that may live
 *     outside the jail, indistinguishable from a real file by target, so caught by its link count.
 * A plugin cannot CREATE either at runtime (the kernel jail plus the Permission Model deny it), so this
 * one-time scan at launch is race-free. The walk is bounded; exceeding the budget fails closed.
 */
function firstFsEscape(realRoot: string): string | undefined {
  const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  const stack: string[] = [realRoot];
  let budget = 50000;
  while (stack.length > 0) {
    if (budget-- <= 0) return '<scan-budget-exceeded>';
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let real: string;
        try {
          real = realpathSync(full);
        } catch {
          return full; // dangling/unresolvable: refuse rather than guess
        }
        if (real !== realRoot && !real.startsWith(prefix)) return full;
      } else if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          if (lstatSync(full).nlink > 1) return full; // a hardlink: a second name for this inode
        } catch {
          return full; // cannot stat: refuse rather than guess
        }
      }
    }
  }
  return undefined;
}

/** Is `p` an existing, executable file? (mechanism probe.) */
function isExecutable(p: string): boolean {
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Locate a system binary on PATH (no shell), returning its absolute path or undefined. */
function whichBinary(name: string): string | undefined {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
  if (which.status !== 0 || typeof which.stdout !== 'string') return undefined;
  const first = which.stdout.split('\n').map((s) => s.trim()).find((s) => s.length > 0);
  return first !== undefined && isExecutable(first) ? first : undefined;
}

/**
 * Detect the kernel sandbox mechanism this host can actually apply. macOS: `sandbox-exec` present.
 * Linux: `bwrap` present AND a throwaway self-test succeeds (proves unprivileged user + network
 * namespaces work here, so an AppArmor-restricted box is reported `none`, never silently trusted).
 * Cached by the caller. `override` short-circuits the probe for tests.
 */
function detectMechanism(override: SandboxMechanism | undefined): { mechanism: SandboxMechanism; bwrapPath?: string } {
  if (override !== undefined) return { mechanism: override };
  if (process.platform === 'darwin') {
    return { mechanism: isExecutable(SANDBOX_EXEC) ? 'seatbelt' : 'none' };
  }
  if (process.platform === 'linux') {
    const bwrapPath = whichBinary('bwrap');
    if (bwrapPath === undefined) return { mechanism: 'none' };
    // Self-test: a fresh net namespace + a trivial exec. If unprivileged namespaces are blocked this
    // exits non-zero, and we report `none` rather than trusting a jail the kernel will not grant.
    const probe = spawnSync(bwrapPath, ['--unshare-all', '--die-with-parent', '--ro-bind', '/', '/', '--', '/bin/true'], {
      timeout: 5000,
      stdio: 'ignore',
    });
    if (probe.status === 0) return { mechanism: 'bubblewrap', bwrapPath };
    return { mechanism: 'none' };
  }
  return { mechanism: 'none' };
}

/** Build the scrubbed child env: a minimal PATH (so libuv can exec node) and nothing inherited. */
function scrubbedEnv(nodePath: string, extra: Record<string, string> | undefined): Record<string, string> {
  const parts = [path.dirname(nodePath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const base: Record<string, string> = { PATH: parts.join(path.delimiter) };
  return extra === undefined ? base : { ...base, ...extra };
}

interface LaunchPlan {
  command: string;
  args: string[];
}

/**
 * Construct a process-jail sandbox host. Register the result with the engine seam
 * (`registerSandboxHost`) so `enable_plugin` / `disable_plugin` reconcile a real process, and drive
 * `invoke` for a live plugin tool call.
 */
export function createProcessSandboxHost(config: ProcessSandboxHostConfig): ProcessSandboxHost {
  const nodePath = config.nodePath ?? process.execPath;
  const nodeReal = realOrSelf(nodePath);
  // The read-allowed roots where the node runtime + its dylibs live: this is what lets a node under
  // $HOME (nvm), /opt (Homebrew) or /usr/local still boot even though those trees are otherwise denied.
  const runtimeRoots = computeRuntimeRoots(nodePath, nodeReal);
  const seatbeltProfile = buildSeatbeltProfile(runtimeRoots);
  const bootstrapPath = realOrSelf(config.bootstrapPath ?? DEFAULT_BOOTSTRAP);
  const pkgJson = nearestPackageJson(path.dirname(bootstrapPath)) ?? bootstrapPath;
  const memoryLimitMb = config.memoryLimitMb ?? 128;
  const callTimeoutMs = config.callTimeoutMs ?? 5000;
  const startTimeoutMs = config.startTimeoutMs ?? 5000;
  const gracefulKillMs = config.gracefulKillMs ?? 300;
  const requireKernelSandbox = config.requireKernelSandbox ?? true;
  const memWatchIntervalMs = config.memoryWatchdogIntervalMs ?? 200;
  const env = scrubbedEnv(nodePath, config.extraEnv);
  const disableSqliteFlag = nodePath === process.execPath && defaultNodeAcceptsSqliteFlag();

  const detected = detectMechanism(config.sandboxMechanismOverride);
  const mechanism = detected.mechanism;
  const bwrapPath = detected.bwrapPath;

  const handles = new Map<string, Handle>();
  const refused = new Set<string>();

  function sandboxStatus(): SandboxStatus {
    const denies = mechanism === 'seatbelt' ? SEATBELT_DENIES : mechanism === 'bubblewrap' ? BWRAP_DENIES : [];
    const residual = mechanism === 'seatbelt' ? SEATBELT_RESIDUAL : mechanism === 'bubblewrap' ? BWRAP_RESIDUAL : [];
    return {
      platform: process.platform,
      mechanism,
      active: mechanism !== 'none',
      requireKernelSandbox,
      denies,
      residual,
    };
  }

  /** The raw node argv (permission-model belt + heap cap) the wrapper hands to node. */
  function nodeArgs(realDataDir: string, entryPath: string, pluginId: string): string[] {
    const allowDir = realDataDir.endsWith(path.sep) ? realDataDir : realDataDir + path.sep;
    return [
      '--permission',
      ...(disableSqliteFlag ? [SQLITE_DISABLE_FLAG] : []),
      `--allow-fs-read=${bootstrapPath}`,
      `--allow-fs-read=${allowDir}`,
      `--allow-fs-write=${allowDir}`,
      `--max-old-space-size=${memoryLimitMb}`,
      bootstrapPath,
      realDataDir,
      realOrSelf(entryPath),
      pluginId,
    ];
  }

  /** Wrap the node argv in the platform kernel sandbox. Only reached when mechanism !== 'none'. */
  function planLaunch(realDataDir: string, nArgs: string[]): LaunchPlan {
    if (mechanism === 'seatbelt') {
      return {
        command: SANDBOX_EXEC,
        args: [
          '-p', seatbeltProfile,
          '-D', `DATA_DIR=${realDataDir}`,
          '-D', `NODE_REAL=${nodeReal}`,
          '-D', `BOOTSTRAP=${bootstrapPath}`,
          '-D', `PKG_JSON=${pkgJson}`,
          nodeReal,
          ...nArgs,
        ],
      };
    }
    // bubblewrap: an empty mount namespace with only the runtime + data dir bound, no network, a hard
    // RLIMIT_AS via the sh wrapper. `"$0" "$@"` carries the node binary and its args through sh with no
    // re-quoting hazard. The `ulimit -v` is FAIL-CLOSED: if the cap cannot be applied the wrapper exits
    // non-zero and NEVER execs node, so a silent `ulimit` failure can no longer let the child run
    // without the address-space bound (macOS has the RSS watchdog; Linux has ONLY this limit, so a
    // swallowed failure there would leave an off-heap bomb bounded by nothing but the wall-clock).
    const asKb = Math.max(1, memoryLimitMb) * 1024;
    const bind = [
      '--ro-bind', '/usr', '/usr',
      '--ro-bind-try', '/bin', '/bin',
      '--ro-bind-try', '/sbin', '/sbin',
      '--ro-bind-try', '/lib', '/lib',
      '--ro-bind-try', '/lib64', '/lib64',
      '--ro-bind-try', '/etc/alternatives', '/etc/alternatives',
      // The node runtime roots (Homebrew prefix / nvm dir / system prefix) read-only, so its dylibs load.
      ...runtimeRoots.flatMap((r) => ['--ro-bind-try', r, r]),
      '--ro-bind', nodeReal, nodeReal,
      '--ro-bind', bootstrapPath, bootstrapPath,
      '--ro-bind', pkgJson, pkgJson,
      '--bind', realDataDir, realDataDir,
      '--proc', '/proc',
      '--dev', '/dev',
    ];
    return {
      command: bwrapPath as string,
      args: [
        '--unshare-all',
        '--die-with-parent',
        '--new-session',
        ...bind,
        '--chdir', realDataDir,
        '--',
        // FAIL-CLOSED: apply the address-space cap or refuse to run. If `ulimit -v` cannot be set we do
        // NOT fall through to `exec` (which would run the plugin uncapped, the DoS the critic flagged);
        // instead we print a diagnostic and exit non-zero, so the host observes a crash / start timeout
        // rather than a silently-uncapped child. `2>/dev/null` hides sh's own terse message in favour of
        // the clearer one below; the `||` still fires on the non-zero exit.
        '/bin/sh', '-c', `ulimit -v ${asKb} 2>/dev/null || { echo "till_plugin_sandbox: RLIMIT_AS (ulimit -v ${asKb} kB) could not be applied; refusing to run the plugin without the address-space cap" >&2; exit 71; }; exec "$0" "$@"`, nodeReal, ...nArgs,
      ],
    };
  }

  function settleReady(handle: Handle, r: Result): void {
    for (const w of handle.readyWaiters) {
      if (!w.done) {
        w.done = true;
        w.settle(r);
      }
    }
    handle.readyWaiters = [];
  }

  function rejectPending(handle: Handle, r: Result): void {
    for (const [, p] of handle.pending) {
      clearTimeout(p.timer);
      p.resolve(r);
    }
    handle.pending.clear();
  }

  function teardown(handle: Handle, pluginId: string): void {
    if (handles.get(pluginId) === handle) handles.delete(pluginId);
    handle.exited = true;
    if (handle.memWatch !== undefined) {
      clearInterval(handle.memWatch);
      delete handle.memWatch;
    }
    rejectPending(handle, err('plugin_crashed', { pluginId }));
    settleReady(handle, err('plugin_crashed', { pluginId }));
    const child = handle.child;
    try {
      if (child.exitCode === null && child.signalCode === null && !child.killed) {
        child.kill('SIGTERM');
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone.
          }
        }, gracefulKillMs);
        (timer as { unref?: () => void }).unref?.();
      }
    } catch {
      // The child was already gone; nothing to terminate.
    }
  }

  /**
   * On a platform with no kernel address-space limit (macOS), poll the child's RSS and SIGKILL it if it
   * exceeds the cap, so an off-heap Buffer bomb cannot OOM the host. `ps -o rss=` is portable and reads
   * the true resident size, unlike the V8 heap cap. Unref'd so it never keeps the host alive.
   */
  function startMemoryWatchdog(handle: Handle): void {
    if (mechanism === 'bubblewrap') return; // Linux has the hard RLIMIT_AS; no watchdog needed.
    const capKb = memoryLimitMb * 1024;
    const timer = setInterval(() => {
      const pid = handle.child.pid;
      if (pid === undefined || handle.exited) return;
      const r = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
      const rssKb = Number((r.stdout ?? '').trim());
      if (Number.isFinite(rssKb) && rssKb > capKb) {
        try {
          handle.child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    }, memWatchIntervalMs);
    (timer as { unref?: () => void }).unref?.();
    handle.memWatch = timer;
  }

  function onMessage(pluginId: string, handle: Handle, raw: unknown): void {
    if (raw === null || typeof raw !== 'object') return;
    const m = raw as Incoming;
    switch (m.__g02) {
      case 'ready': {
        handle.ready = true;
        settleReady(handle, ok({ ready: true }));
        return;
      }
      case 'load_error': {
        settleReady(handle, err('plugin_load_failed', { pluginId, detail: typeof m.error === 'string' ? m.error : 'unknown' }));
        return;
      }
      case 'invoke_result': {
        const id = typeof m.id === 'string' ? m.id : '';
        const p = handle.pending.get(id);
        if (p !== undefined) {
          clearTimeout(p.timer);
          handle.pending.delete(id);
          p.resolve(m.ok === true ? ok({ result: m.result }) : err('plugin_error', { pluginId, detail: typeof m.error === 'string' ? m.error : 'unknown' }));
        }
        return;
      }
      case 'host_call': {
        // THE PROCESS BOUNDARY. The child asked for a tool call; the PARENT decides. The reserved
        // money-path denylist (P3) and the granted-scope + A24 check bind here, exactly as they bind
        // an external agent, because `runPluginToolCall` is the same door.
        const id = typeof m.id === 'string' ? m.id : '';
        const tool = typeof m.tool === 'string' ? m.tool : '';
        const input = m.input !== null && typeof m.input === 'object' ? (m.input as Record<string, unknown>) : {};
        const result = runPluginToolCall(config.invoke, {
          grantedScopes: handle.grantedScopes,
          pluginActor: handle.actor,
          tool,
          input,
        });
        try {
          handle.child.send({ __g02: 'host_result', id, result });
        } catch {
          // The child died between asking and answering; its pending call dies with it.
        }
        return;
      }
      default:
        return;
    }
  }

  const host: ProcessSandboxHost = {
    sandboxStatus,

    start(descriptor: PluginProcessDescriptor): void {
      const pluginId = descriptor.pluginId;
      const existing = handles.get(pluginId);
      if (existing !== undefined && !existing.exited && existing.child.exitCode === null) return; // already running

      const dataDir = path.join(config.pluginRoot, pluginId, 'data');
      const entryPath = config.resolveEntry !== undefined ? config.resolveEntry(pluginId, dataDir) : path.join(dataDir, 'index.mjs');
      const grantedScopes = config.resolveGrantedScopes !== undefined
        ? config.resolveGrantedScopes(pluginId, descriptor)
        : descriptor.allowedTools.map((t) => `mcp_tool:${t}`);
      const actor = config.resolveActor(pluginId);
      const realDataDir = realOrSelf(dataDir);

      // FAIL CLOSED: no kernel sandbox on this host and we require one. Spawn NOTHING; the plugin
      // degrades honestly as plugin_sandbox_unavailable. Never run a plugin while claiming isolation
      // the kernel is not enforcing.
      if (mechanism === 'none' && requireKernelSandbox) {
        refused.add(pluginId);
        return;
      }
      refused.delete(pluginId);

      // Fail closed on a pre-planted escaping symlink OR a hardlink in the data dir: the kernel fs
      // allowlist permits the data-dir PATH, so a symlink whose realpath escapes, or a hardlink that
      // is a second name for the ledger inode, would be readable through an allowed path. A plugin
      // cannot create either at runtime, so this one-time scan at launch is sufficient and race-free.
      const escape = firstFsEscape(realDataDir);
      if (escape !== undefined) {
        throw new Error(`plugin_start_blocked: filesystem escape in data dir (${escape})`);
      }

      const nArgs = nodeArgs(realDataDir, entryPath, pluginId);
      const plan = mechanism === 'none'
        ? { command: nodeReal, args: nArgs } // requireKernelSandbox === false: trusted, unsandboxed (status reports active:false)
        : planLaunch(realDataDir, nArgs);

      // cwd = the data dir so the child's getcwd() lands on an allowed path (node aborts at bootstrap
      // if getcwd fails). The kernel allowlist, not the cwd, is the boundary.
      const child = spawn(plan.command, plan.args, {
        cwd: realDataDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });

      const handle: Handle = {
        child,
        grantedScopes,
        actor,
        pending: new Map(),
        readyWaiters: [],
        ready: false,
        exited: false,
        seq: 0,
      };
      handles.set(pluginId, handle);

      child.on('message', (raw) => onMessage(pluginId, handle, raw));
      child.on('exit', () => teardown(handle, pluginId));
      child.on('error', () => teardown(handle, pluginId));
      child.stderr?.on('data', () => {});
      child.stdout?.on('data', () => {});
      startMemoryWatchdog(handle);
    },

    stop(pluginId: string): void {
      refused.delete(pluginId);
      const handle = handles.get(pluginId);
      if (handle === undefined) return;
      teardown(handle, pluginId);
    },

    isRunning(pluginId: string): boolean {
      const handle = handles.get(pluginId);
      return handle !== undefined && !handle.exited && handle.child.exitCode === null && handle.child.signalCode === null;
    },

    runningPluginIds(): string[] {
      const out: string[] = [];
      for (const id of handles.keys()) {
        if (this.isRunning(id)) out.push(id);
      }
      return out;
    },

    pidOf(pluginId: string): number | undefined {
      const handle = handles.get(pluginId);
      if (handle === undefined || handle.exited) return undefined;
      return handle.child.pid;
    },

    awaitReady(pluginId: string, timeoutMs?: number): Promise<Result> {
      if (refused.has(pluginId)) return Promise.resolve(err('plugin_sandbox_unavailable', { pluginId, platform: process.platform, mechanism }));
      const handle = handles.get(pluginId);
      if (handle === undefined) return Promise.resolve(err('plugin_host_unavailable', { pluginId, reason: 'not_started' }));
      if (handle.ready) return Promise.resolve(ok({ ready: true }));
      if (handle.exited) return Promise.resolve(err('plugin_crashed', { pluginId }));
      return new Promise<Result>((resolve) => {
        const waiter: ReadyWaiter = { done: false, settle: resolve };
        const timer = setTimeout(() => {
          if (!waiter.done) {
            waiter.done = true;
            this.stop(pluginId);
            resolve(err('plugin_start_timeout', { pluginId }));
          }
        }, timeoutMs ?? startTimeoutMs);
        (timer as { unref?: () => void }).unref?.();
        waiter.settle = (r: Result): void => {
          clearTimeout(timer);
          resolve(r);
        };
        handle.readyWaiters.push(waiter);
      });
    },

    invoke(pluginId: string, tool: string, input: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<Result> {
      if (refused.has(pluginId)) return Promise.resolve(err('plugin_sandbox_unavailable', { pluginId, platform: process.platform, mechanism }));
      const handle = handles.get(pluginId);
      if (handle === undefined || handle.exited || handle.child.exitCode !== null) {
        return Promise.resolve(err('plugin_host_unavailable', { pluginId, reason: 'not_running' }));
      }
      const timeoutMs = opts?.timeoutMs ?? callTimeoutMs;
      return new Promise<Result>((resolve) => {
        const id = `${pluginId}:inv:${++handle.seq}`;
        const timer = setTimeout(() => {
          handle.pending.delete(id);
          this.stop(pluginId);
          resolve(err('plugin_timeout', { pluginId, tool, timeoutMs }));
        }, timeoutMs);
        handle.pending.set(id, { resolve, timer });
        try {
          handle.child.send({ __g02: 'invoke', id, tool, input });
        } catch {
          clearTimeout(timer);
          handle.pending.delete(id);
          resolve(err('plugin_host_unavailable', { pluginId, reason: 'send_failed' }));
        }
      });
    },

    shutdown(): void {
      refused.clear();
      for (const [pluginId, handle] of [...handles.entries()]) {
        teardown(handle, pluginId);
      }
    },
  };

  return host;
}
