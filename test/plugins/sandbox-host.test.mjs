/**
 * G02 §8 / DoD: the OS-KERNEL plugin jail (US-G02.6, the process half). Where `sandbox.test.mjs`
 * proves the in-engine data-reach boundary, THIS suite proves the KERNEL boundary is genuine by
 * spawning ACTUAL jailed child processes via `ProcessSandboxHost` and watching the kernel (Apple
 * Seatbelt on macOS, bubblewrap on Linux) deny them:
 *
 *   - a jailed plugin cannot read a host file outside its data dir (fs);
 *   - a jailed plugin cannot open the ledger via `node:sqlite` EVEN belt-off: the exact escape that
 *     defeated the JS-only jail (custom nodePath drops `--no-experimental-sqlite`, a competing ESM
 *     resolve hook short-circuits the guard) now fails because the KERNEL denies the open();
 *   - a jailed plugin cannot open a network connection (net egress);
 *   - a planted HARDLINK to an outside secret is refused at start (the fs allowlist would follow it);
 *   - an off-heap Buffer bomb is bounded (child dies, host survives);
 *   - the money-path P3 denylist + A24 scope check bind at the process boundary;
 *   - FAIL-CLOSED: forced to have no kernel sandbox, the host REFUSES to run the plugin and never runs
 *     it unsandboxed;
 *   - teardown leaves no orphan.
 *
 * NON-VACUITY IS PROVEN, NOT ASSUMED. For the fs, net and sqlite cases the SAME operation is also run
 * in an UNJAILED child (a bare `node`), which SUCCEEDS. So the jailed failure is the jail biting, not a
 * missing file or a broken fixture: remove the jail and these assertions flip. A benign echo plugin
 * exercises the happy path, so "blocked" is a real verdict and not "everything fails".
 *
 * PLATFORM HONESTY, NO SILENT SKIP. The bite tests run wherever a kernel sandbox is available (always
 * on macOS via `sandbox-exec`; on Linux when `bwrap` and unprivileged namespaces are present). Where a
 * platform has NONE, the suite does not quietly skip: it asserts the host FAILS CLOSED (refuses to run
 * any plugin), so a missing mechanism can never masquerade as a passing isolation test. The forced
 * fail-closed test runs on every platform regardless.
 *
 * These tests spawn real processes and are fully offline (loopback only).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { DatabaseSync } from 'node:sqlite';

// Wire the reserved money-path set at load (registerMoneyPathTools), same as sandbox.test.mjs.
import '../../dist/api/registry.js';
import { createProcessSandboxHost } from '../../dist/api/plugin-sandbox-host.js';
import { sandboxHost, pluginProcessDescriptor } from '../../dist/core/plugins/index.js';

const NODE = process.execPath;

// Is a real kernel sandbox available on THIS host? Ask the host itself (single source of truth), so
// the suite branches exactly the way production would.
const KERNEL = createProcessSandboxHost({ pluginRoot: tmpdir(), invoke: () => ({ ok: true }), resolveActor: () => 'x' }).sandboxStatus();
const KERNEL_AVAILABLE = KERNEL.active;

// --- fixtures -----------------------------------------------------------------------------------

const FIXTURES = {
  // Tries to read an arbitrary host path. Jailed: blocked. Unjailed: reads it.
  fsescape: `
    import { readFileSync } from 'node:fs';
    export async function handle(call) {
      try { return { read: readFileSync(call.input.secretPath, 'utf8') }; }
      catch (e) { return { blocked: e.code || e.message }; }
    }`,
  // Tries to open a TCP connection to a loopback port. Jailed: blocked. Unjailed: connects.
  netegress: `
    import net from 'node:net';
    export async function handle(call) {
      return await new Promise((resolve) => {
        const s = net.connect(call.input.port, '127.0.0.1');
        s.on('connect', () => { s.destroy(); resolve({ connected: true }); });
        s.on('error', (e) => resolve({ blocked: e.code || e.message }));
      });
    }`,
  // Reaches TILL data ONLY through host.call. The parent polices every such call (P3 + scopes + A24).
  moneypath: `
    export async function handle(call, host) {
      return { hostResult: await host.call(call.input.tool, call.input.args ?? {}) };
    }`,
  // Reports what host authority leaked into the process: env secrets, a ledger handle.
  envleak: `
    export async function handle() {
      return {
        secret: process.env.LEDGER_SECRET ?? null,
        keys: Object.keys(process.env).sort(),
        hasDb: typeof globalThis.__TILL_DB__,
      };
    }`,
  // Never returns: a runaway the host must time out and terminate.
  runaway: `export async function handle() { while (true) {} }`,
  // Allocates without bound OFF HEAP (Buffers) and TOUCHES the pages (.fill), so RSS actually grows:
  // --max-old-space-size does NOT bound this. The host (RLIMIT_AS on Linux, RSS watchdog on macOS,
  // and the wall-clock timeout on both) must stop it without dying itself.
  bufferbomb: `export async function handle() { const a = []; while (true) { a.push(Buffer.allocUnsafe(64 * 1024 * 1024).fill(7)); } }`,
  // THE HEADLINE ESCAPE, belt-off. Defeats the JS node:sqlite guard the way the critic did (a competing
  // ESM resolve hook that short-circuits before the guard, which runs most-recent-first), then opens the
  // ledger via node:sqlite through BOTH import and require. The Permission Model does not gate
  // node:sqlite, so ONLY the kernel can stop the open() here.
  sqliteescape: `
    import Module from 'node:module';
    export async function handle(call) {
      try {
        Module.registerHooks({
          resolve(spec, ctx, next) {
            if (spec === 'node:sqlite' || spec === 'sqlite') return { url: 'node:sqlite', shortCircuit: true };
            return next(spec, ctx);
          },
        });
      } catch { /* older node without registerHooks: import path below still exercised */ }
      const out = {};
      try { const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(call.input.ledgerPath); out.esm = db.prepare('SELECT secret FROM t').get(); }
      catch (e) { out.esm = 'blocked:' + (e.code || e.message); }
      try { const { createRequire } = await import('node:module'); const req = createRequire(import.meta.url); const { DatabaseSync } = req('node:sqlite'); const db = new DatabaseSync(call.input.ledgerPath); out.cjs = db.prepare('SELECT secret FROM t').get(); }
      catch (e) { out.cjs = 'blocked:' + (e.code || e.message); }
      return out;
    }`,
  // INNER-BELT (defence in depth, retained from the prior jail): the Node Permission Model must still
  // deny a child process, a worker thread and a runtime-created escaping symlink, under the kernel jail.
  cpdenial: `
    export async function handle() {
      try { const cp = await import('node:child_process'); cp.spawnSync('echo', ['x']); return { spawned: true }; }
      catch (e) { return { blocked: e.code || e.message }; }
    }`,
  workerdenial: `
    export async function handle() {
      try { const { Worker } = await import('node:worker_threads'); new Worker(new URL(import.meta.url)); return { worker: true }; }
      catch (e) { return { blocked: e.code || e.message }; }
    }`,
  symlinkcreate: `
    export async function handle(call) {
      try { const { symlinkSync, readFileSync } = await import('node:fs'); symlinkSync(call.input.target, 'rt-link'); return { read: readFileSync('rt-link', 'utf8') }; }
      catch (e) { return { blocked: e.code || e.message }; }
    }`,
  // RUNTIME hardlink creation (the twin of the pre-planted-at-start scan): the plugin tries to make a
  // NEW name, inside its own writable data dir, for an OUTSIDE secret's inode, then read it through
  // that allowlisted path. Creation must be denied so no readable second name is ever minted.
  hardlinkcreate: `
    export async function handle(call) {
      try { const { linkSync, readFileSync } = await import('node:fs'); linkSync(call.input.target, 'rt-hardlink'); return { read: readFileSync('rt-hardlink', 'utf8') }; }
      catch (e) { return { blocked: e.code || e.message }; }
    }`,
  // THE SEATBELT-INJECTION escape, belt-off. Identical to sqliteescape (defeats the JS resolve-hook
  // guard so node:sqlite LOADS and only the KERNEL can deny the open). Paired with a data-dir name
  // that is live SBPL grammar, it proves the profile is NOT string-interpolated: the malicious name
  // does not widen file-read*, so the outside ledger stays denied by the kernel.
  sqliteinject: `
    import Module from 'node:module';
    export async function handle(call) {
      try {
        Module.registerHooks({
          resolve(spec, ctx, next) {
            if (spec === 'node:sqlite' || spec === 'sqlite') return { url: 'node:sqlite', shortCircuit: true };
            return next(spec, ctx);
          },
        });
      } catch { /* older node without registerHooks: import path below still exercised */ }
      try { const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(call.input.ledgerPath); return { esm: db.prepare('SELECT secret FROM t').get() }; }
      catch (e) { return { esm: 'blocked:' + (e.code || e.message) }; }
    }`,
  // Benign happy path: echoes its input. Proves the pipeline works, so "blocked" means something.
  echo: `export async function handle(call) { return { echoed: call.input }; }`,
};

// --- harness ------------------------------------------------------------------------------------

const roots = [];
const hosts = [];

/** A fresh plugin root with the named fixtures written to `<root>/<id>/data/index.mjs`. */
function makeRoot(fixtureIds) {
  const root = mkdtempSync(path.join(tmpdir(), 'g02-jail-'));
  roots.push(root);
  for (const id of fixtureIds) {
    const dir = path.join(root, id, 'data');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'index.mjs'), FIXTURES[id]);
  }
  return root;
}

function makeHost(root, config = {}) {
  const host = createProcessSandboxHost({
    pluginRoot: root,
    invoke: config.invoke ?? (() => ({ ok: true })),
    resolveActor: config.resolveActor ?? (() => 'installer_member'),
    resolveGrantedScopes: config.resolveGrantedScopes,
    callTimeoutMs: config.callTimeoutMs ?? 5000,
    memoryLimitMb: config.memoryLimitMb,
    gracefulKillMs: config.gracefulKillMs ?? 200,
    requireKernelSandbox: config.requireKernelSandbox,
    sandboxMechanismOverride: config.sandboxMechanismOverride,
    nodePath: config.nodePath,
    memoryWatchdogIntervalMs: config.memoryWatchdogIntervalMs,
  });
  hosts.push(host);
  return host;
}

/** Start a plugin and await its ready handshake, asserting it came up. */
async function startReady(host, id, scopes) {
  host.start(pluginProcessDescriptor(id, scopes));
  const ready = await host.awaitReady(id, 8000);
  assert.equal(ready.ok, true, `plugin ${id} failed to start: ${JSON.stringify(ready)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A custom node path (a symlink to the real node) so the host DROPS --no-experimental-sqlite,
 * exactly the belt-off condition the critic used. Created lazily, cleaned up at the end. */
function customNodePath() {
  const dir = mkdtempSync(path.join(tmpdir(), 'g02-node-'));
  roots.push(dir);
  const link = path.join(dir, 'node');
  symlinkSync(NODE, link);
  return link;
}

test.after(() => {
  for (const h of hosts) h.shutdown();
  for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } }
});

// ================================================================================================
// ALWAYS-RUN: seam default, fail-closed, honest degradation (no kernel sandbox required)
// ================================================================================================

test('G02 jail: no host is registered by default (honest degradation)', () => {
  assert.equal(sandboxHost(), undefined);
});

test('G02 jail: sandboxStatus reports the platform mechanism honestly', () => {
  const s = KERNEL;
  assert.equal(s.platform, process.platform);
  assert.equal(s.active, s.mechanism !== 'none');
  if (process.platform === 'darwin') assert.equal(s.mechanism, 'seatbelt', 'macOS must have a kernel sandbox');
  if (s.active) assert.ok(s.denies.length > 0, 'an active mechanism must list what it denies');
});

test('G02 jail: FAIL-CLOSED: with no kernel sandbox the host REFUSES to run the plugin (never unsandboxed)', async () => {
  // Force the "no mechanism" world on ANY platform. requireKernelSandbox defaults true.
  const host = makeHost(makeRoot(['echo']), { sandboxMechanismOverride: 'none' });
  assert.equal(host.sandboxStatus().active, false);
  host.start(pluginProcessDescriptor('echo', []));
  // Nothing was spawned: no pid, not running.
  assert.equal(host.pidOf('echo'), undefined, 'a plugin process was spawned with NO kernel sandbox');
  assert.equal(host.isRunning('echo'), false);
  const ready = await host.awaitReady('echo', 1000);
  assert.equal(ready.ok, false);
  assert.equal(ready.error, 'plugin_sandbox_unavailable', `expected refusal, got ${JSON.stringify(ready)}`);
  const inv = await host.invoke('echo', 'ping', {});
  assert.equal(inv.ok, false);
  assert.equal(inv.error, 'plugin_sandbox_unavailable');
});

test('G02 jail: the process-boundary P3 check fails closed when the money-path set is unwired', async () => {
  const { runPluginToolCall, registerMoneyPathTools, moneyPathTools } = await import('../../dist/core/plugins/index.js');
  const saved = moneyPathTools();
  registerMoneyPathTools(undefined);
  let invoked = false;
  let res;
  try {
    res = runPluginToolCall(() => { invoked = true; return { ok: true }; }, {
      grantedScopes: ['mcp_tool:list_invoices'],
      pluginActor: 'installer',
      tool: 'list_invoices',
      input: {},
    });
  } finally {
    registerMoneyPathTools(saved !== undefined ? [...saved] : []);
  }
  assert.equal(res.ok, false);
  assert.equal(res.error, 'capability_forbidden');
  assert.equal(res.reason, 'guard_uninitialised');
  assert.equal(invoked, false, 'a call slipped through while the money-path guard was unwired');
});

test('G02 jail: invoking a plugin that was never started degrades honestly', async () => {
  const host = makeHost(makeRoot([]));
  const r = await host.invoke('ghost', 'x', {});
  assert.equal(r.ok, false);
  // Either sandbox-unavailable (no kernel) or host-unavailable (kernel present, never started): both honest.
  assert.ok(['plugin_host_unavailable', 'plugin_sandbox_unavailable'].includes(r.error), `got ${r.error}`);
});

// ================================================================================================
// BITE SUITE: runs where a kernel sandbox is available; asserts the KERNEL denies escapes.
// Where unavailable, a single guard test records the fail-closed reality (no silent skip).
// ================================================================================================

if (!KERNEL_AVAILABLE) {
  test(`G02 jail: NO kernel sandbox on ${process.platform} -> the bite suite is fail-closed, not skipped`, async () => {
    // Honest: on this host the kernel jail is unavailable, so a real plugin CANNOT run. Prove the host
    // refuses rather than pretending the escape tests passed. (macOS always has Seatbelt; a Linux box
    // without bwrap / unprivileged namespaces lands here.)
    const host = makeHost(makeRoot(['echo']));
    host.start(pluginProcessDescriptor('echo', []));
    const ready = await host.awaitReady('echo', 1000);
    assert.equal(ready.ok, false);
    assert.equal(ready.error, 'plugin_sandbox_unavailable');
    assert.equal(host.isRunning('echo'), false);
  });
} else {
  test('G02 jail: a benign plugin runs and answers over IPC (under the kernel sandbox)', async () => {
    const host = makeHost(makeRoot(['echo']));
    await startReady(host, 'echo', []);
    assert.equal(host.isRunning('echo'), true);
    const r = await host.invoke('echo', 'ping', { hello: 'world' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.result, { echoed: { hello: 'world' } });
  });

  test('G02 jail: the KERNEL blocks a jailed plugin from reading a host file outside its data dir (fs)', async () => {
    const root = makeRoot(['fsescape']);
    const secretPath = path.join(root, 'ledger-secret.txt');
    writeFileSync(secretPath, 'TOP-SECRET-LEDGER-KEY');

    // NON-VACUITY CONTROL: an unjailed node reads it.
    const control = spawnSync(NODE, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(secretPath)}, 'utf8'))`], { encoding: 'utf8' });
    assert.equal(control.stdout, 'TOP-SECRET-LEDGER-KEY', 'control: an unjailed process must read the secret');

    const host = makeHost(root);
    await startReady(host, 'fsescape', []);
    const r = await host.invoke('fsescape', 'probe', { secretPath });
    assert.equal(r.ok, true);
    assert.equal(r.result.read, undefined, 'the jailed plugin LEAKED a host file');
    assert.ok(typeof r.result.blocked === 'string', `expected fs denial, got ${JSON.stringify(r.result)}`);
  });

  test('G02 jail: the KERNEL blocks node:sqlite reading the ledger EVEN belt-off (the escape that beat the JS guard)', async () => {
    const root = makeRoot(['sqliteescape']);
    const ledgerPath = path.join(root, 'ledger.db');
    const seed = new DatabaseSync(ledgerPath);
    seed.exec('CREATE TABLE t (secret TEXT)');
    seed.prepare('INSERT INTO t (secret) VALUES (?)').run('LEDGER-ROW-SECRET');
    seed.close();

    // NON-VACUITY CONTROL: unjailed node:sqlite reads the ledger, so the db is valid + readable.
    const control = spawnSync(NODE, ['-e', `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(ledgerPath)});process.stdout.write(db.prepare('SELECT secret FROM t').get().secret)`], { encoding: 'utf8' });
    assert.equal(control.stdout, 'LEDGER-ROW-SECRET', `control: unjailed node:sqlite must read the ledger (stderr: ${control.stderr})`);

    // BELT-OFF: a custom nodePath makes the host DROP --no-experimental-sqlite, and the fixture defeats
    // the JS resolve-hook guard. The Permission Model never gated node:sqlite. So the ONLY thing that
    // can stop the open() is the KERNEL sandbox. It must.
    const host = makeHost(root, { nodePath: customNodePath() });
    await startReady(host, 'sqliteescape', []);
    const r = await host.invoke('sqliteescape', 'probe', { ledgerPath });
    assert.equal(r.ok, true);
    assert.equal(typeof r.result.esm, 'string', `node:sqlite LEAKED via import: ${JSON.stringify(r.result.esm)}`);
    // The ESM path DEFEATS the JS guard (competing resolve hook), so the module LOADS; the block must
    // therefore come from the KERNEL denying the file open (a SQLite/EPERM error), NOT from the JS guard
    // throwing `blocked_builtin` (which would make this test vacuous about the kernel).
    assert.ok(r.result.esm.startsWith('blocked:'), `esm import not blocked at all: ${r.result.esm}`);
    assert.ok(!/blocked_builtin/.test(r.result.esm), `esm blocked by the JS guard, not the kernel (vacuous): ${r.result.esm}`);
    assert.ok(/SQLITE|EPERM|ENOENT|ACCESS/i.test(r.result.esm), `esm block is not a kernel file-open denial: ${r.result.esm}`);
    // The CJS require path is stopped by the inner-belt Module._load patch (defence in depth): also blocked.
    assert.equal(typeof r.result.cjs, 'string', `node:sqlite LEAKED via require: ${JSON.stringify(r.result.cjs)}`);
    assert.ok(r.result.cjs.startsWith('blocked:'), `cjs require not blocked: ${r.result.cjs}`);
  });

  test('G02 jail: the KERNEL blocks a jailed plugin from opening a network connection (egress)', async () => {
    const root = makeRoot(['netegress']);
    const server = net.createServer((s) => s.destroy());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    // NON-VACUITY CONTROL: an unjailed node connects to the same port.
    const control = spawnSync(NODE, ['-e', `const net=require('net');const s=net.connect(${port},'127.0.0.1');s.on('connect',()=>{process.stdout.write('CONNECTED');s.destroy()});s.on('error',e=>process.stdout.write('ERR:'+e.code));`], { encoding: 'utf8' });
    assert.equal(control.stdout, 'CONNECTED', 'control: an unjailed process must connect');

    const host = makeHost(root);
    await startReady(host, 'netegress', []);
    const r = await host.invoke('netegress', 'probe', { port });
    assert.equal(r.ok, true);
    assert.equal(r.result.connected, undefined, 'the jailed plugin OPENED a network connection');
    assert.ok(typeof r.result.blocked === 'string', `expected net denial, got ${JSON.stringify(r.result)}`);

    server.close();
  });

  test('G02 jail: start REFUSES a plugin whose data dir holds a pre-planted HARDLINK to an outside secret', () => {
    const root = makeRoot(['echo']);
    const secretPath = path.join(root, 'planted-secret.txt');
    writeFileSync(secretPath, 'PLANTED-SECRET');
    // A hardlink is a SECOND NAME for the secret's inode, sitting at a path the fs allowlist permits;
    // the kernel authorizes by path, so only refusing at start closes it. Its nlink>1 is the signal.
    linkSync(secretPath, path.join(root, 'echo', 'data', 'ledger-hardlink'));
    const host = makeHost(root);
    assert.throws(() => host.start(pluginProcessDescriptor('echo', [])), /plugin_start_blocked|filesystem escape/);
    assert.equal(host.isRunning('echo'), false);
  });

  test('G02 jail: start REFUSES a plugin whose data dir holds a pre-planted escaping symlink', () => {
    const root = makeRoot(['echo']);
    const secretPath = path.join(root, 'planted-secret.txt');
    writeFileSync(secretPath, 'PLANTED-SECRET');
    symlinkSync(secretPath, path.join(root, 'echo', 'data', 'leak'));
    const host = makeHost(root);
    assert.throws(() => host.start(pluginProcessDescriptor('echo', [])), /plugin_start_blocked|filesystem escape/);
    assert.equal(host.isRunning('echo'), false);
  });

  test('G02 jail: an off-heap Buffer bomb is bounded without taking down the host', async () => {
    const host = makeHost(makeRoot(['bufferbomb']), { memoryLimitMb: 128, memoryWatchdogIntervalMs: 100 });
    await startReady(host, 'bufferbomb', []);
    const r = await host.invoke('bufferbomb', 'x', {}, { timeoutMs: 2000 });
    assert.equal(r.ok, false);
    assert.ok(['plugin_timeout', 'plugin_crashed'].includes(r.error), `unexpected error ${r.error}`);
    assert.equal(host.isRunning('bufferbomb'), false);
    // The host (this test process) is plainly still alive to run this assertion.
  });

  test('G02 jail: a reserved money-path call is REFUSED at the process boundary (P3), scopes bind', async () => {
    const root = makeRoot(['moneypath']);
    const invokerCalls = [];
    const invoke = (tool, input, actor) => {
      invokerCalls.push({ tool, actor });
      return { ok: true, echoed: tool };
    };
    const host = makeHost(root, {
      invoke,
      resolveActor: () => 'installer_member',
      resolveGrantedScopes: () => ['mcp_tool:post_entry', 'mcp_tool:list_invoices'],
    });
    await startReady(host, 'moneypath', ['post_entry', 'list_invoices']);

    const money = await host.invoke('moneypath', 'x', { tool: 'post_entry', args: { workspaceId: 'ws' } });
    assert.equal(money.result.hostResult.ok, false);
    assert.equal(money.result.hostResult.error, 'capability_forbidden');
    assert.equal(invokerCalls.some((c) => c.tool === 'post_entry'), false, 'post_entry reached the ledger invoker');

    const ungranted = await host.invoke('moneypath', 'x', { tool: 'list_contacts', args: {} });
    assert.equal(ungranted.result.hostResult.ok, false);
    assert.equal(ungranted.result.hostResult.error, 'forbidden');
    assert.equal(invokerCalls.some((c) => c.tool === 'list_contacts'), false);

    const granted = await host.invoke('moneypath', 'x', { tool: 'list_invoices', args: { workspaceId: 'ws' } });
    assert.equal(granted.result.hostResult.ok, true);
    assert.deepEqual(invokerCalls.filter((c) => c.tool === 'list_invoices'), [{ tool: 'list_invoices', actor: 'installer_member' }]);
  });

  test('G02 jail: a jailed plugin cannot read the host env or a ledger handle', async () => {
    process.env.LEDGER_SECRET = 'must-not-leak';
    const host = makeHost(makeRoot(['envleak']));
    await startReady(host, 'envleak', []);
    const r = await host.invoke('envleak', 'probe', {});
    assert.equal(r.ok, true);
    assert.equal(r.result.secret, null, 'a host env secret leaked into the jail');
    assert.equal(r.result.keys.includes('LEDGER_SECRET'), false);
    assert.equal(r.result.hasDb, 'undefined', 'a ledger handle was reachable from the jail');
    delete process.env.LEDGER_SECRET;
  });

  test('G02 jail: a runaway (infinite loop) is terminated by the timeout without taking down the host', async () => {
    const host = makeHost(makeRoot(['runaway']));
    await startReady(host, 'runaway', []);
    const pid = host.pidOf('runaway');
    assert.equal(typeof pid, 'number');
    const r = await host.invoke('runaway', 'x', {}, { timeoutMs: 400 });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'plugin_timeout');
    assert.equal(host.isRunning('runaway'), false, 'the runaway was not terminated');
    await sleep(500);
    assert.throws(() => process.kill(pid, 0), (e) => e.code === 'ESRCH', 'the runaway process was orphaned');
  });

  test('G02 jail: shutdown terminates every plugin process and leaves no orphan', async () => {
    const host = makeHost(makeRoot(['echo']));
    await startReady(host, 'echo', []);
    const pid = host.pidOf('echo');
    assert.equal(typeof pid, 'number');
    assert.equal(host.isRunning('echo'), true);
    host.shutdown();
    assert.equal(host.isRunning('echo'), false);
    assert.deepEqual(host.runningPluginIds(), []);
    await sleep(700);
    assert.throws(() => process.kill(pid, 0), (e) => e.code === 'ESRCH', 'a plugin process was orphaned after shutdown');
  });

  // --- inner belt still bites (defence in depth): Permission Model denies spawn/worker/symlink -----

  test('G02 jail (inner belt): a jailed plugin cannot spawn a child process', async () => {
    const host = makeHost(makeRoot(['cpdenial']));
    await startReady(host, 'cpdenial', []);
    const r = await host.invoke('cpdenial', 'probe', {});
    assert.equal(r.ok, true);
    assert.equal(r.result.spawned, undefined, 'the jailed plugin spawned a child process');
    assert.ok(typeof r.result.blocked === 'string', `expected denial, got ${JSON.stringify(r.result)}`);
  });

  test('G02 jail (inner belt): a jailed plugin cannot start a worker thread', async () => {
    const host = makeHost(makeRoot(['workerdenial']));
    await startReady(host, 'workerdenial', []);
    const r = await host.invoke('workerdenial', 'probe', {});
    assert.equal(r.ok, true);
    assert.equal(r.result.worker, undefined, 'the jailed plugin started a worker thread');
    assert.ok(typeof r.result.blocked === 'string', `expected denial, got ${JSON.stringify(r.result)}`);
  });

  test('G02 jail (inner belt): a jailed plugin cannot CREATE an escaping symlink at runtime', async () => {
    const root = makeRoot(['symlinkcreate']);
    const secretPath = path.join(root, 'runtime-secret.txt');
    writeFileSync(secretPath, 'RUNTIME-SECRET');
    const host = makeHost(root);
    await startReady(host, 'symlinkcreate', []);
    const r = await host.invoke('symlinkcreate', 'probe', { target: secretPath });
    assert.equal(r.ok, true);
    assert.equal(r.result.read, undefined, 'the jailed plugin created and read through an escaping symlink');
    assert.ok(typeof r.result.blocked === 'string', `expected denial, got ${JSON.stringify(r.result)}`);
  });

  test('G02 jail: a jailed plugin cannot CREATE a hardlink to an outside secret at RUNTIME (twin of the start-time scan)', async () => {
    const root = makeRoot(['hardlinkcreate']);
    const secretPath = path.join(root, 'runtime-hardlink-secret.txt');
    writeFileSync(secretPath, 'RUNTIME-HARDLINK-SECRET');

    // NON-VACUITY CONTROL: an unjailed node makes the SAME hardlink and reads the secret through it.
    // So the jailed failure is the sandbox biting, not a broken fixture: remove the jail and it reads.
    const ctlDest = path.join(root, 'control-hardlink');
    const control = spawnSync(NODE, ['-e', `const fs=require('fs');fs.linkSync(${JSON.stringify(secretPath)},${JSON.stringify(ctlDest)});process.stdout.write(fs.readFileSync(${JSON.stringify(ctlDest)},'utf8'))`], { encoding: 'utf8' });
    assert.equal(control.stdout, 'RUNTIME-HARDLINK-SECRET', `control: an unjailed process must create+read the hardlink (stderr: ${control.stderr})`);

    const host = makeHost(root);
    await startReady(host, 'hardlinkcreate', []);
    const r = await host.invoke('hardlinkcreate', 'probe', { target: secretPath });
    assert.equal(r.ok, true);
    // The escape is CLOSED: no readable second name for the outside inode was ever minted, so the
    // secret does not leak. On this stack the Node Permission Model (the inner belt) denies the
    // source access first and the kernel Seatbelt is the backstop; both deny, and the denial is a
    // real access error, never a silent success.
    assert.equal(r.result.read, undefined, 'the jailed plugin created and read through a runtime hardlink');
    assert.ok(typeof r.result.blocked === 'string', `expected a hardlink-creation denial, got ${JSON.stringify(r.result)}`);
    assert.ok(/EPERM|EACCES|EROFS|ERR_ACCESS_DENIED/.test(r.result.blocked), `expected a kernel/access denial code, got ${r.result.blocked}`);
  });

  test('G02 jail (Seatbelt): a data-dir name carrying live SBPL grammar does NOT widen the profile (paths are -D params, not interpolated)', async () => {
    // The data-dir path travels to sandbox-exec as a `-D DATA_DIR=` parameter, never string-spliced
    // into the profile. This id is a directory name that is live SBPL grammar: if DATA_DIR were
    // interpolated into (subpath "<DATA_DIR>"), the quote would close the string and (allow
    // file-read*) would globally re-open reads. (No slash: not permitted in a path component; the
    // quote + parens are enough to prove the point.)
    const evilId = 'inj") (allow file-read*) (deny nothing) ;#';
    const root = makeRoot([]);
    const dir = path.join(root, evilId, 'data');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'index.mjs'), FIXTURES.sqliteinject);

    const ledgerPath = path.join(root, 'ledger.db');
    const seed = new DatabaseSync(ledgerPath);
    seed.exec('CREATE TABLE t (secret TEXT)');
    seed.prepare('INSERT INTO t (secret) VALUES (?)').run('INJECTION-LEDGER-SECRET');
    seed.close();

    // NON-VACUITY CONTROL: unjailed node:sqlite reads the ledger, so the db is valid + readable and a
    // jailed denial means the kernel, not a missing/broken file.
    const control = spawnSync(NODE, ['-e', `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(ledgerPath)});process.stdout.write(db.prepare('SELECT secret FROM t').get().secret)`], { encoding: 'utf8' });
    assert.equal(control.stdout, 'INJECTION-LEDGER-SECRET', `control: unjailed node:sqlite must read the ledger (stderr: ${control.stderr})`);

    // Belt-off (custom nodePath drops --no-experimental-sqlite) + the resolve-hook defeat: node:sqlite
    // LOADS, so only the KERNEL can stop the open(). If the malicious dir name had widened the
    // profile, this read would SUCCEED.
    const host = makeHost(root, { nodePath: customNodePath() });
    // The plugin must still START under the injection-named data dir: a splice would either fail to
    // compile the profile (no start) or open reads (leak). Either way the assertions below bite.
    host.start(pluginProcessDescriptor(evilId, []));
    const ready = await host.awaitReady(evilId, 8000);
    assert.equal(ready.ok, true, `the injection-named plugin failed to start: ${JSON.stringify(ready)}`);

    const r = await host.invoke(evilId, 'probe', { ledgerPath });
    assert.equal(r.ok, true);
    assert.equal(typeof r.result.esm, 'string', `node:sqlite LEAKED the ledger through the injected name: ${JSON.stringify(r.result.esm)}`);
    assert.ok(r.result.esm.startsWith('blocked:'), `the outside ledger was NOT denied (profile widened by the dir name): ${r.result.esm}`);
    // The module LOADED (guard defeated), so the block must be the KERNEL denying the file open, not
    // the JS import guard (which would make this vacuous about the profile).
    assert.ok(!/blocked_builtin/.test(r.result.esm), `blocked by the JS guard, not the kernel (vacuous about the profile): ${r.result.esm}`);
    assert.ok(/SQLITE|EPERM|ENOENT|ACCESS/i.test(r.result.esm), `the block is not a kernel file-open denial: ${r.result.esm}`);
  });
}
