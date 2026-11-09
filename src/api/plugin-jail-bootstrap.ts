/**
 * THE JAIL BOOTSTRAP: the trusted TILL code that runs as pid 1 INSIDE a plugin's jailed OS process
 * (spec §4, US-G02.6). It is spawned by `ProcessSandboxHost` (`src/api/plugin-sandbox-host.ts`)
 * WRAPPED IN AN OS-KERNEL SANDBOX (Apple Seatbelt on macOS via `sandbox-exec`, bubblewrap on Linux),
 * roughly:
 *
 *     sandbox-exec -p '<deny-default profile>' \
 *       node --permission --allow-fs-read=<thisFile> --allow-fs-read=<dataDir> \
 *            --allow-fs-write=<dataDir> --max-old-space-size=<cap> \
 *            plugin-jail-bootstrap.js <dataDir> <entryPath> <pluginId>
 *
 * so by the time this file's first line runs the process has no ambient authority AT TWO LAYERS. The
 * GUARANTEE is the KERNEL sandbox: it denies every filesystem path outside `<dataDir>` and the node
 * runtime, denies all network, and denies exec, BELOW the language runtime, so a file-opening builtin
 * the runtime does not gate (`node:sqlite`) simply cannot open the ledger bytes. The INNER BELT is
 * Node's Permission Model (`--permission`, no `--allow-net`, fs scoped to `<dataDir>`, no child
 * process / worker / addon) plus the `node:sqlite` guard below: defence in depth, no longer the
 * boundary. The parent handed a scrubbed env (no inherited secrets) and NO `better-sqlite3` handle (a
 * native handle cannot cross a process boundary). This file adds NOTHING to the boundary and relies on
 * NONE of its own good behaviour: a malicious plugin that ignores this shim entirely still hits the
 * KERNEL wall. What this file DOES is wire the ONE sanctioned channel out: an IPC pipe to the parent.
 *
 * SELF-CONTAINED ON PURPOSE. It imports only `node:` builtins, never a project module, so it needs no
 * filesystem read beyond the plugin's own entry file (which lives inside the allowed `<dataDir>`). The
 * P3 money-path denylist and the A24/scope check are NOT re-implemented here: they are enforced by the
 * PARENT on every `host_call` (`runPluginToolCall`), because the parent is the only side that can be
 * trusted. This shim just forwards.
 *
 * THE PLUGIN CONTRACT. The plugin's entry module exports `handle(call, host)` (or a default export of
 * the same shape). `call` is `{ tool, input }` the host asked it to service; `host.call(tool, input)`
 * returns a Promise the plugin awaits to reach TILL data, and that call is exactly an MCP tool call
 * routed back over IPC to the parent, subject to the same A24 + P3 checks as any agent's call.
 *
 * THE `node:sqlite` GUARD BELOW IS AN INNER BELT, NOT THE FIX. Node's `--permission` gates `node:fs`,
 * network, `child_process`, `worker_threads`, addons, WASI, FFI and the inspector, but NOT
 * `node:sqlite`, which opens files through the bundled SQLite C library directly. A prior jail relied
 * on `--no-experimental-sqlite` plus the ESM `resolve` hook / CJS `Module._load` patch below to close
 * it, and a security critic DEFEATED that twice: a custom `nodePath` drops the flag, and a plugin can
 * register a competing resolve hook that short-circuits `node:sqlite` before this one (hooks run
 * most-recent-first). Those bypasses no longer reach the ledger, because the KERNEL sandbox denies the
 * open() whether or not the module loads (proven belt-off in `test/plugins/sandbox-host.test.mjs`). The
 * flag and the hooks are kept as cheap belt that stops the naive case; the load-bearing denial is the
 * kernel's.
 */

import process from 'node:process';
import Module from 'node:module';
import { pathToFileURL } from 'node:url';

// --- close the builtins the Permission Model leaves ungated (defense in depth) ------------------

/**
 * The builtins a jailed plugin must never load, because they reach files/resources the Permission
 * Model does not gate. Today that is exactly `node:sqlite` (a second, ungated door to the ledger
 * bytes). Kept as a set so a newly discovered ungated builtin is one entry, not a redesign.
 */
const DENIED_BUILTINS = new Set(['sqlite']);

function bareBuiltin(specifier: string): string {
  return specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
}

function isDeniedBuiltin(specifier: string): boolean {
  return DENIED_BUILTINS.has(bareBuiltin(specifier));
}

interface ModuleWithHooks {
  // The SYNCHRONOUS customization hooks (Node >= 22.15 / 23.5). They run in-thread, unlike
  // `module.register`, which spawns a worker thread the jail denies (`--allow-worker`), so this is the
  // only loader-hook API usable INSIDE the sandbox.
  registerHooks(hooks: { resolve?: (specifier: string, context: unknown, nextResolve: (s: string, c: unknown) => unknown) => unknown }): void;
  // The single CJS load entry, patched so require('node:sqlite') throws too.
  _load(request: string, parent: unknown, isMain: boolean): unknown;
}

function installBuiltinGuard(): void {
  const mod = Module as unknown as ModuleWithHooks;

  // ESM: a SYNCHRONOUS resolve hook (no worker thread) that refuses a denied builtin before it loads.
  if (typeof mod.registerHooks === 'function') {
    mod.registerHooks({
      resolve(specifier: string, context: unknown, nextResolve: (s: string, c: unknown) => unknown): unknown {
        if (isDeniedBuiltin(specifier)) throw new Error('blocked_builtin:' + specifier);
        return nextResolve(specifier, context);
      },
    });
  }

  // CJS: patch the single load entry so require('node:sqlite') and createRequire(...)('node:sqlite')
  // both throw. `node:module` is a singleton, so a plugin cannot re-import an unpatched copy.
  const originalLoad = mod._load.bind(Module);
  mod._load = (request: string, parent: unknown, isMain: boolean): unknown => {
    if (isDeniedBuiltin(String(request))) throw new Error('blocked_builtin:' + String(request));
    return originalLoad(request, parent, isMain);
  };
}

installBuiltinGuard();

interface PluginCall {
  tool: string;
  input: unknown;
}

interface PluginHost {
  call(tool: string, input?: Record<string, unknown>): Promise<unknown>;
}

type PluginHandler = (call: PluginCall, host: PluginHost) => unknown | Promise<unknown>;

interface Incoming {
  __g02?: unknown;
  id?: unknown;
  tool?: unknown;
  input?: unknown;
  result?: unknown;
}

const dataDir = process.argv[2] ?? '.';
const entryPath = process.argv[3] ?? '';
const pluginId = process.argv[4] ?? 'plugin';

function send(msg: Record<string, unknown>): void {
  try {
    process.send?.(msg);
  } catch {
    // The channel is gone (parent tore us down). Nothing we can or should do about it in here.
  }
}

// Outstanding host_call resolvers, keyed by the id we minted for each.
const pending = new Map<string, (result: unknown) => void>();
let seq = 0;

const host: PluginHost = {
  call(tool: string, input?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve) => {
      const id = `${pluginId}:hc:${++seq}`;
      pending.set(id, resolve);
      send({ __g02: 'host_call', id, tool, input: input ?? {} });
    });
  },
};

// Assigned once the plugin entry has loaded. Declared before the listener so the closure is in scope;
// an `invoke` never arrives before `ready`, so it is always set by the time it is read.
let handler: PluginHandler | undefined;

process.on('message', (raw: unknown) => {
  if (raw === null || typeof raw !== 'object') return;
  const m = raw as Incoming;
  if (m.__g02 === 'host_result') {
    const id = typeof m.id === 'string' ? m.id : '';
    const resolve = pending.get(id);
    if (resolve !== undefined) {
      pending.delete(id);
      resolve(m.result);
    }
    return;
  }
  if (m.__g02 === 'invoke') {
    const id = typeof m.id === 'string' ? m.id : '';
    const tool = typeof m.tool === 'string' ? m.tool : '';
    void (async () => {
      try {
        if (handler === undefined) throw new Error('plugin not ready');
        const result = await handler({ tool, input: m.input }, host);
        send({ __g02: 'invoke_result', id, ok: true, result });
      } catch (e) {
        send({ __g02: 'invoke_result', id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
  }
});

// Move the process cwd into the plugin's own data dir for convenience. This is NOT the security
// boundary (the `--allow-fs-*` allowlist is): a plugin that reaches outside `<dataDir>` is denied by
// the runtime whatever the cwd is. Best-effort, never fatal.
try {
  process.chdir(dataDir);
} catch {
  // chdir can be denied or the dir absent; the fs allowlist still holds regardless.
}

try {
  const mod: Record<string, unknown> = (await import(pathToFileURL(entryPath).href)) as Record<string, unknown>;
  const candidate = (mod.handle ?? mod.default) as unknown;
  if (typeof candidate !== 'function') {
    throw new Error('plugin entry exports no handle() function');
  }
  handler = candidate as PluginHandler;
  send({ __g02: 'ready' });
} catch (e) {
  send({ __g02: 'load_error', error: e instanceof Error ? e.message : String(e) });
}
