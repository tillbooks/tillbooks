#!/usr/bin/env node
/**
 * The pre-push gate (D136, 23.09.2026). Called by `.githooks/pre-push` with git's push lines on stdin.
 *
 * CI is disabled (the org hit its Actions billing cap), so this hook is the gate between a push and
 * `develop`/`staging`/`main`. It used to run the whole gate, blocking, for every push: ~6 minutes on
 * a quiet box, 20+ when parallel sessions gated at once, so a one-file markdown push once took ~22
 * minutes. The model now (rules in `scripts/lib/push-gate.mjs`, unit-tested):
 *
 *   staging / main              FULL gate, blocking (skipped when this exact tree already passed)
 *   develop, engine touched     FULL gate, blocking (src/, bin/, root deps: the money path)
 *   develop, anything else      FAST lane (~1 to 3 min), then the FULL gate in the BACKGROUND
 *
 * The background gate runs in a fresh detached worktree at the pushed commit (not your working tree),
 * gates the newest develop tip that contains it, records the tree green, moves
 * `refs/till/develop-green`, and sends a macOS notification either way. The next push warns loudly
 * while develop is red: fix forward.
 *
 * Every full gate, blocking or background, and every `npm run gate`, holds ONE lock in the shared git
 * dir, so parallel sessions queue instead of slowing each other into timeouts.
 *
 * Modes:
 *   (hook)                        node scripts/pre-push-gate.mjs  < git push lines
 *   npm run gate:plan             show what pushing HEAD to develop would run (--ref, --from, --to, --run)
 *   npm run gate:status           the last background verdict and where develop-green points
 *   --with-lock <cmd...>          run a command under the gate lock (used by `npm run gate`)
 *   --record <kind>               record the HEAD tree green for <kind> (used by `postgate`)
 *   --background <sha>            the background full gate (spawned by the hook)
 *
 * Bypass (bootstrap, or a deliberate known-red push): git push --no-verify
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEVELOP_REF,
  classifyPath,
  fastPhases,
  gatedUpdates,
  isZeroSha,
  parsePushLines,
  planLane,
  satisfiedByCache,
  selectTests,
  stricterLane,
} from './lib/push-gate.mjs';

const SELF = fileURLToPath(import.meta.url);

// ---- The environment: no GIT_* reaches any child. ------------------------------------------------
// Inside a hook git exports GIT_DIR (and may export GIT_WORK_TREE, GIT_INDEX_FILE,
// GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_COMMON_DIR, GIT_PREFIX, GIT_NAMESPACE,
// GIT_CONFIG*, GIT_QUARANTINE_PATH ...). Every child of the gate (npm run gate, the web build,
// check:aeo, the background gate, and every temp repository a test creates under them) inherited
// them, so a test's `git init <tmp>` re-initialised the REAL repository as bare and its
// `git -C <tmp> config core.hooksPath ...` disabled this gate for every session (2026-09-24). So every
// GIT_* variable except the transport ones is removed from this process FIRST (the hook already did,
// this covers a stale hook), the repository is found from the working directory (git runs a hook from
// the worktree root, and the hook enters it before this script), and every git call and child gets
// the clean environment explicitly and runs from that root.
const GIT_TRANSPORT = new Set(['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_ASKPASS', 'GIT_TERMINAL_PROMPT', 'GIT_PROXY_COMMAND', 'GIT_HTTP_USER_AGENT']);
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_') && !GIT_TRANSPORT.has(key)) delete process.env[key];
const ROOT = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return process.cwd();
  }
})();
process.chdir(ROOT);

/** @param {string[]} args @param {string} [cwd] */

/** The nearest existing `rel` directory: this checkout, the main checkout (for linked worktrees), then ancestors. */
function nearestModules(rel) {
  const candidates = [process.cwd()];
  const common = tryGit(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common) candidates.push(dirname(common));
  for (let d = dirname(process.cwd()); d !== dirname(d); d = dirname(d)) candidates.push(d);
  for (const base of candidates) {
    const p = join(base, rel);
    if (existsSync(p)) return resolve(p);
  }
  return null;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** @param {string[]} args @param {string} [cwd] */
function tryGit(args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

const COMMON = resolve(git(['rev-parse', '--git-common-dir']));
const CACHE = join(COMMON, 'till-gate-green');
const LOCK = join(COMMON, 'till-gate.lock');
const STATUS = join(COMMON, 'till-gate-status.json');
const RUNS = join(COMMON, 'till-gate-runs');
const GREEN_REF = 'refs/till/develop-green';
const CACHE_KEEP = 200;

/** @param {number} ms */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** @param {string} sha */
function treeOf(sha) {
  return git(['rev-parse', `${sha}^{tree}`]);
}

/** @param {string} sha */
function subjectOf(sha) {
  return tryGit(['log', '-1', '--format=%h %s', sha]) ?? sha.slice(0, 10);
}

// ---- The green cache: one line per (tree, kind) that passed. -------------------------------------

/** @param {string} tree */
function greenKinds(tree) {
  /** @type {Set<string>} */
  const kinds = new Set();
  if (!existsSync(CACHE)) return kinds;
  for (const line of readFileSync(CACHE, 'utf8').split('\n')) {
    const [t, kind] = line.split(' ');
    if (t === tree && kind) kinds.add(kind);
  }
  return kinds;
}

/** @param {string} tree @param {string} kind */
function recordTree(tree, kind) {
  appendFileSync(CACHE, `${tree} ${kind} ${new Date().toISOString()}\n`);
  const lines = readFileSync(CACHE, 'utf8').split('\n').filter(Boolean);
  if (lines.length > CACHE_KEEP) writeFileSync(CACHE, `${lines.slice(-CACHE_KEEP).join('\n')}\n`);
}

/** True when the working tree IS the commit under test: HEAD is `sha`, nothing uncommitted or untracked. */
/** @param {string} sha */
function workingTreeIs(sha) {
  return tryGit(['rev-parse', 'HEAD']) === sha && git(['status', '--porcelain']) === '';
}

/** @param {string} sha @param {string} kind */
function record(sha, kind) {
  if (!workingTreeIs(sha)) return false;
  recordTree(treeOf(sha), kind);
  return true;
}

// ---- The gate lock: one full gate at a time per repository, across every worktree and session. ---

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

let holdingLock = false;

/** @param {string} label */
function acquireLock(label) {
  let announced = false;
  for (;;) {
    try {
      mkdirSync(LOCK);
      writeFileSync(join(LOCK, 'owner'), JSON.stringify({ pid: process.pid, label, at: new Date().toISOString() }));
      holdingLock = true;
      return;
    } catch {
      /** @type {{ pid?: number, label?: string, at?: string }} */
      let owner = {};
      try {
        owner = JSON.parse(readFileSync(join(LOCK, 'owner'), 'utf8'));
      } catch {
        // Just created, owner not written yet: give it a moment. Older than 30s: abandoned.
        const age = existsSync(LOCK) ? Date.now() - statSync(LOCK).mtimeMs : 0;
        if (age > 30_000) rmSync(LOCK, { recursive: true, force: true });
        sleep(1000);
        continue;
      }
      if (!owner.pid || !alive(owner.pid)) {
        rmSync(LOCK, { recursive: true, force: true });
        continue;
      }
      if (!announced) {
        console.log(`gate: waiting for the gate lock (${owner.label ?? 'a gate'}, pid ${owner.pid}, since ${owner.at ?? '?'})`);
        announced = true;
      }
      sleep(5000);
    }
  }
}

function releaseLock() {
  if (!holdingLock) return;
  holdingLock = false;
  rmSync(LOCK, { recursive: true, force: true });
}

process.on('exit', releaseLock);
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
  process.on(signal, () => {
    releaseLock();
    process.exit(130);
  });
}

/**
 * Run `fn` under the lock. Reentrant through TILL_GATE_LOCK_HELD, which is set for every child.
 * @template T @param {string} label @param {() => T} fn @returns {T}
 */
function withLock(label, fn) {
  if (process.env.TILL_GATE_LOCK_HELD === '1') return fn();
  acquireLock(label);
  process.env.TILL_GATE_LOCK_HELD = '1';
  try {
    return fn();
  } finally {
    delete process.env.TILL_GATE_LOCK_HELD;
    releaseLock();
  }
}

// ---- Status and notification. ---------------------------------------------------------------------

/** @returns {{ state?: string, sha?: string, subject?: string, log?: string, at?: string, reason?: string }} */
function readStatus() {
  try {
    return JSON.parse(readFileSync(STATUS, 'utf8'));
  } catch {
    return {};
  }
}

/** @param {Record<string, string>} status */
function writeStatus(status) {
  writeFileSync(STATUS, `${JSON.stringify({ ...status, at: new Date().toISOString() }, null, 2)}\n`);
}

/** @param {string} title @param {string} message */
function notify(title, message) {
  spawnSync('osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`], {
    stdio: 'ignore',
  });
}

function warnIfDevelopRed() {
  const status = readStatus();
  if (status.state === 'red') {
    console.log(`pre-push: WARNING develop is RED since ${status.at}: ${status.subject}`);
    console.log(`pre-push:         fix forward first. Log: ${status.log}`);
  } else if (status.state === 'running') {
    console.log(`pre-push: a background full gate is running for ${status.subject}`);
  }
}

// ---- Change sets and phases. ------------------------------------------------------------------------

/**
 * The paths a push changes, or null when they cannot be computed (then the lane is `full`).
 * @param {{ localSha: string, remoteSha: string }} update
 */
function changedPaths(update) {
  let base = update.remoteSha;
  if (isZeroSha(base)) base = tryGit(['merge-base', update.localSha, 'origin/develop']) ?? '';
  if (!base || tryGit(['cat-file', '-e', `${base}^{commit}`]) === null) return null;
  const out = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, update.localSha], {
    env: cleanEnv(),
    encoding: 'utf8',
  });
  return out.split('\0').filter(Boolean);
}

/** test/*.test.mjs plus test/<dir>/*.test.mjs, the same set `scripts/run-node-tests.mjs` runs. */
function allNodeTests() {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync('test', { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.test.mjs')) files.push(`test/${entry.name}`);
    else if (entry.isDirectory()) {
      for (const name of readdirSync(join('test', entry.name))) {
        if (name.endsWith('.test.mjs')) files.push(`test/${entry.name}/${name}`);
      }
    }
  }
  return files.sort();
}

/**
 * @param {string} label @param {string} cmd @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string> }} [options]
 */
function phase(label, cmd, args, options = {}) {
  const started = Date.now();
  console.log(`pre-push: ${label} ...`);
  const result = spawnSync(cmd, args, { cwd: options.cwd ? resolve(ROOT, options.cwd) : ROOT, stdio: 'inherit', env: { ...cleanEnv(), ...options.env } });
  const secs = Math.round((Date.now() - started) / 1000);
  if (result.status !== 0) {
    console.error(`pre-push: ${label} FAILED after ${secs}s`);
    return false;
  }
  console.log(`pre-push: ${label} ok (${secs}s)`);
  return true;
}

/** The fast lane: what a non-engine change to develop can break directly. */
/** @param {string[]} paths @param {string} tip */
function runFast(paths, tip) {
  const plan = fastPhases(paths);
  if (!phase('check:style', 'npm', ['run', 'check:style'])) return false;
  if (plan.appTypecheck && !phase('Studio typecheck', 'npx', ['tsc', '-b'], { cwd: 'app' })) return false;
  const vitest = ['vitest', 'run', '--maxWorkers=4', '--minWorkers=1'];
  if (plan.appAll) {
    if (!phase('Studio tests (all: a non-source Studio file changed)', 'npx', vitest, { cwd: 'app' })) return false;
  } else {
    const related = plan.appTests.filter((file) => existsSync(join('app', file)));
    const args = ['vitest', 'related', '--run', '--passWithNoTests', '--maxWorkers=4', '--minWorkers=1', ...related];
    if (related.length > 0 && !phase(`Studio tests related to ${related.length} changed file(s)`, 'npx', args, { cwd: 'app' })) {
      return false;
    }
  }
  if (plan.node) {
    const suites = selectTests(paths, allNodeTests(), (file) => readFileSync(file, 'utf8')).filter((f) => existsSync(f));
    if (!phase('dist build', 'npm', ['run', 'build'])) return false;
    const env = { TILL_SUPPORT_DIR: resolve('.tmp-support') };
    if (!phase(`node suites (${suites.length} this change can reach)`, 'node', ['scripts/run-node-tests.mjs', ...suites], { env })) {
      return false;
    }
  }
  if (plan.web) {
    if (!phase('web build', 'npm', ['run', 'build', '--prefix', 'web'])) return false;
    if (!phase('check:aeo', 'npm', ['run', 'check:aeo', '--prefix', 'web'])) return false;
  }
  record(tip, 'fast');
  return true;
}

/** The full gate, blocking, under the lock. Exactly the gate this hook always ran. */
/** @param {Set<string>} kinds @param {string} tip */
function runFull(kinds, tip) {
  return withLock('full gate (push)', () => {
    // `npm run gate` records `gate` itself through `postgate`.
    if (!kinds.has('gate') && !phase('npm run gate', 'npm', ['run', 'gate'])) return false;
    if (!kinds.has('web')) {
      if (!phase('web build', 'npm', ['run', 'build', '--prefix', 'web'])) return false;
      if (!phase('check:aeo', 'npm', ['run', 'check:aeo', '--prefix', 'web'])) return false;
      record(tip, 'web');
    }
    return true;
  });
}

// ---- The background full gate. ------------------------------------------------------------------

/** Environment for a child that must see the worktree it runs in, not the hook's git dir. */
function cleanEnv() {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if ((!key.startsWith('GIT_') || GIT_TRANSPORT.has(key)) && value !== undefined) env[key] = value;
  }
  return env;
}

/** @param {string} sha */
function queueBackground(sha) {
  mkdirSync(RUNS, { recursive: true });
  const log = join(RUNS, `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${sha.slice(0, 10)}.log`);
  const fd = openSync(log, 'a');
  const child = spawn(process.execPath, [SELF, '--background', sha], {
    detached: true,
    stdio: ['ignore', fd, fd],
    cwd: process.cwd(),
    env: { ...cleanEnv(), TILL_GATE_LOG: log },
  });
  child.unref();
  console.log('pre-push: the full gate now runs in the BACKGROUND; you get a notification when it is done.');
  console.log(`pre-push: npm run gate:status   (log: ${log})`);
}

/** @param {string} sha */
function markGreen(sha) {
  tryGit(['update-ref', GREEN_REF, sha]);
  writeStatus({ state: 'green', sha, subject: subjectOf(sha), log: process.env.TILL_GATE_LOG ?? '' });
  notify('TILL gate: develop is green', subjectOf(sha));
}

/** @param {string} sha */
function markRed(sha) {
  const log = process.env.TILL_GATE_LOG ?? '';
  writeStatus({ state: 'red', sha, subject: subjectOf(sha), log });
  notify('TILL gate: develop is RED', `${subjectOf(sha)}. Fix forward. Log: ${log}`);
}

/** @param {string} sha */
function background(sha) {
  // The hook runs before git sends anything: wait until the push has landed on origin/develop.
  let landed = false;
  for (let i = 0; i < 60 && !landed; i += 1) {
    tryGit(['fetch', '-q', 'origin', 'develop']);
    const tip = tryGit(['rev-parse', 'origin/develop']);
    landed = tip !== null && tryGit(['merge-base', '--is-ancestor', sha, tip]) !== null;
    if (!landed) sleep(5000);
  }
  if (!landed) {
    writeStatus({ state: 'skipped', sha, subject: subjectOf(sha), reason: 'the push never landed on origin/develop' });
    return 0;
  }
  return withLock('background full gate', () => {
    // Coalesce: while this waited for the lock, later pushes may have landed. Gate the newest tip.
    tryGit(['fetch', '-q', 'origin', 'develop']);
    const target = tryGit(['rev-parse', 'origin/develop']) ?? sha;
    const tree = treeOf(target);
    if (satisfiedByCache('full', greenKinds(tree))) {
      markGreen(target);
      return 0;
    }
    writeStatus({ state: 'running', sha: target, subject: subjectOf(target), log: process.env.TILL_GATE_LOG ?? '' });
    console.log(`background gate: ${subjectOf(target)}`);
    const dir = mkdtempSync(join(tmpdir(), 'till-gate-'));
    try {
      git(['worktree', 'add', '--detach', dir, target]);
      // A push from a linked worktree has no node_modules of its own (it resolves them from the main
      // checkout), so look in this checkout, then the main checkout, then every ancestor directory.
      for (const modules of ['node_modules', 'app/node_modules', 'web/node_modules']) {
        const found = nearestModules(modules);
        if (found !== null) symlinkSync(found, join(dir, modules));
      }
      const options = { cwd: dir };
      const ok =
        phase('npm run gate', 'npm', ['run', 'gate'], options) &&
        phase('web build', 'npm', ['run', 'build', '--prefix', 'web'], options) &&
        phase('check:aeo', 'npm', ['run', 'check:aeo', '--prefix', 'web'], options);
      if (ok) {
        // A fresh detached checkout of `target` is by construction the commit under test.
        recordTree(tree, 'gate');
        recordTree(tree, 'web');
        markGreen(target);
        return 0;
      }
      markRed(target);
      return 1;
    } finally {
      tryGit(['worktree', 'remove', '--force', dir]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ---- Entry points. --------------------------------------------------------------------------------

function status() {
  const s = readStatus();
  const green = tryGit(['rev-parse', GREEN_REF]);
  tryGit(['fetch', '-q', 'origin', 'develop']);
  const tip = tryGit(['rev-parse', 'origin/develop']);
  console.log(`last background gate: ${s.state ?? 'none yet'}${s.subject ? `  ${s.subject}` : ''}${s.at ? `  (${s.at})` : ''}`);
  if (s.log) console.log(`log: ${s.log}`);
  if (s.reason) console.log(`reason: ${s.reason}`);
  console.log(`develop-green: ${green ? subjectOf(green) : 'not set yet'}`);
  if (tip) console.log(`origin/develop: ${subjectOf(tip)}${green === tip ? '  (green)' : '  (not yet proven green)'}`);
  return 0;
}

/**
 * @param {ReturnType<typeof gatedUpdates>} updates
 * @param {boolean} runIt
 * @param {boolean} fromHook only a real push queues the background gate
 */
function gate(updates, runIt, fromHook) {
  if (updates.length === 0) return 0;
  warnIfDevelopRed();

  /** @type {'none' | 'fast' | 'full'} */
  let lane = 'none';
  /** @type {string[]} */
  const paths = [];
  for (const update of updates) {
    const changed = changedPaths(update);
    lane = stricterLane(lane, planLane(changed, update.remoteRef));
    if (changed) paths.push(...changed);
  }
  const unique = [...new Set(paths)];
  if (lane === 'none') return 0;

  const toDevelop = updates.some((u) => u.remoteRef === DEVELOP_REF);
  const engine = unique.filter((p) => classifyPath(p) === 'engine');
  const why =
    lane === 'fast'
      ? 'no engine change'
      : !toDevelop || updates.some((u) => u.remoteRef !== DEVELOP_REF)
        ? 'promotion to staging/main'
        : engine.length > 0
          ? `engine change, the money path (${engine.slice(0, 3).join(', ')}${engine.length > 3 ? ', ...' : ''})`
          : 'the change set could not be computed';
  console.log(`pre-push: ${lane.toUpperCase()} lane: ${unique.length} changed file(s), ${why}`);

  const tip = updates[updates.length - 1]?.localSha ?? '';
  const kinds = updates.length === 1 ? greenKinds(treeOf(tip)) : new Set();
  if (satisfiedByCache(lane, kinds)) {
    console.log('pre-push: this exact tree already passed this lane, nothing to re-run');
  } else {
    if (!workingTreeIs(tip)) {
      console.log('pre-push: WARNING the working tree is not the pushed commit (HEAD differs, or there are');
      console.log('pre-push:         uncommitted/untracked files). The blocking checks run on the working tree.');
    }
    if (!runIt) {
      if (lane === 'full') console.log('pre-push: would run: npm run gate, then web build + check:aeo (blocking)');
      else {
        const plan = fastPhases(unique);
        const suites = plan.node ? selectTests(unique, allNodeTests(), (f) => readFileSync(f, 'utf8')) : [];
        console.log('pre-push: would run (blocking): check:style' +
          (plan.appTypecheck ? ', Studio typecheck' : '') +
          (plan.appAll ? ', all Studio tests' : plan.appTests.length ? `, Studio tests related to ${plan.appTests.length} file(s)` : '') +
          (plan.node ? `, dist build + ${suites.length} node suites` : '') +
          (plan.web ? ', web build + check:aeo' : ''));
      }
      if (toDevelop) console.log('pre-push: then: the full gate in the background');
      return 0;
    }
    const started = Date.now();
    const ok = lane === 'full' ? runFull(kinds, tip) : runFast(unique, tip);
    const secs = Math.round((Date.now() - started) / 1000);
    if (!ok) {
      console.error(`pre-push: gate FAILED (${lane} lane, ${secs}s) - push blocked. Fix, or override with: git push --no-verify`);
      return 1;
    }
    console.log(`pre-push: gate PASSED (${lane} lane, ${secs}s)`);
  }
  if (toDevelop && fromHook) queueBackground(tip);
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  const value = (/** @type {string} */ name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  if (argv[0] === '--with-lock') {
    const [cmd, ...args] = argv.slice(1);
    if (!cmd) return 2;
    return withLock(`${cmd} ${args.join(' ')}`, () => spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: cleanEnv() }).status ?? 1);
  }
  if (argv[0] === '--record') {
    const kind = value('--record') ?? '';
    const head = tryGit(['rev-parse', 'HEAD']);
    const ok = kind !== '' && head !== null && record(head, kind);
    console.log(ok ? `gate: recorded this tree green (${kind})` : `gate: not recorded (${kind || 'no kind'}): the working tree has uncommitted or untracked changes`);
    return 0;
  }
  if (argv[0] === '--background') return background(value('--background') ?? '');
  if (argv[0] === '--status') return status();
  if (argv[0] === '--plan') {
    const from = git(['rev-parse', value('--from') ?? 'origin/develop']);
    const to = git(['rev-parse', value('--to') ?? 'HEAD']);
    const ref = value('--ref') ?? 'develop';
    return gate([{ localRef: 'HEAD', localSha: to, remoteRef: `refs/heads/${ref}`, remoteSha: from }], argv.includes('--run'), false);
  }
  return gate(gatedUpdates(parsePushLines(readFileSync(0, 'utf8'))), true, true);
}

process.exitCode = main();
