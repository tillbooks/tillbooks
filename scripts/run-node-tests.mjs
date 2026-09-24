#!/usr/bin/env node
/**
 * The node test suite, run under a HARD WALL-CLOCK CAP.
 *
 * Why this exists: `node --test` waits forever on a test that hangs, and `--test-timeout` (per test)
 * does NOT catch every hang: a test whose teardown leaves the event loop busy, or whose async never
 * settles, can wedge the whole runner uninterruptibly. On 2026-09-18 that wedged the gate for ~17
 * hours. `--test-timeout` is still passed (it fails a runaway test cleanly where it can), but the
 * wall clock here is the backstop that guarantees the suite ALWAYS terminates: on the cap it SIGKILLs
 * the whole process group and exits non-zero, so a hang fails fast instead of hanging a session.
 *
 * `--test-concurrency=4` (not the 8-CPU default) keeps the many server-spinning suites from
 * overloading the box into a timeout cascade (measured load 36 at the default here).
 *
 * Tunables via env: TILL_TEST_WALL_MS (default 900000 = 15 min), TILL_TEST_CONCURRENCY (default 4),
 * TILL_TEST_TIMEOUT_MS (default 120000, the per-test timeout).
 *
 * `TILL_TEST_NO_FULLFSYNC=1` (default here; set it to 0 to run fully durable) lets the file-backed
 * stores the suites open skip macOS's F_FULLFSYNC drive-cache flush while keeping `synchronous=EXTRA`.
 * The store honours it only inside a node:test child process (a non-empty `NODE_TEST_CONTEXT`), never
 * in `till up` / `till serve` / `till mcp`; a process a TEST spawns inherits it, which is accepted
 * because it is still a test. The reasoning and the measurement are on `applyDurableSync` in
 * `src/core/store/sqlite-store.ts`, and `test/core/store-durability.test.mjs` asserts production
 * durability with it cleared.
 */

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const WALL_MS = Number(process.env.TILL_TEST_WALL_MS ?? 15 * 60 * 1000);
const CONCURRENCY = Number(process.env.TILL_TEST_CONCURRENCY ?? 4);
const PER_TEST_MS = Number(process.env.TILL_TEST_TIMEOUT_MS ?? 120000);

/** test/*.test.mjs plus test/<dir>/*.test.mjs, matching the original glob, resolved here so the
 *  spawn does not depend on the shell expanding a glob. */
function collectTestFiles() {
  const files = [];
  for (const entry of readdirSync('test', { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      files.push(join('test', entry.name));
    } else if (entry.isDirectory()) {
      for (const name of readdirSync(join('test', entry.name))) {
        if (name.endsWith('.test.mjs')) files.push(join('test', entry.name, name));
      }
    }
  }
  return files.sort();
}

// Explicit files on the command line run instead of the whole suite: the change-aware pre-push gate
// (`scripts/pre-push-gate.mjs`) passes only the suites a docs or web change can reach. No argument is
// the whole suite, exactly as before.
const files = process.argv.length > 2 ? process.argv.slice(2) : collectTestFiles();
if (files.length === 0) {
  console.error('[run-node-tests] no test files found under test/');
  process.exit(1);
}

const args = [
  '--test',
  `--test-concurrency=${CONCURRENCY}`,
  `--test-timeout=${PER_TEST_MS}`,
  ...files,
];

// detached: true makes the child a process-group leader, so a SIGKILL to -pid reaps every worker it
// spawned (a plain child.kill leaves the --test workers orphaned, which is the debris that squatted
// ports across the 17h incident).
const env = { ...process.env, TILL_TEST_NO_FULLFSYNC: process.env.TILL_TEST_NO_FULLFSYNC ?? '1' };
const child = spawn(process.execPath, args, { stdio: 'inherit', detached: true, env });

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  process.stderr.write(
    `\n[run-node-tests] WALL-CLOCK TIMEOUT after ${Math.round(WALL_MS / 1000)}s: the suite did not ` +
      `finish, a test is hanging. Killing the run (SIGKILL to the process group) and failing.\n`,
  );
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* group already gone */
  }
  child.kill('SIGKILL');
  // Give the OS a beat to reap, then hard-exit non-zero so the gate sees a failure, not a hang.
  setTimeout(() => process.exit(1), 2000);
}, WALL_MS);
// Do not let this timer itself keep the process alive.
timer.unref();

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  if (timedOut) return; // the timeout path owns the exit
  process.exit(signal ? 1 : (code ?? 1));
});

child.on('error', (err) => {
  clearTimeout(timer);
  console.error('[run-node-tests] failed to launch node --test:', err.message);
  process.exit(1);
});
