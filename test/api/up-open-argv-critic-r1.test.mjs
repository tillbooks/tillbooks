/**
 * Critic probes for D162 point 3 (`docs/critique/up-ticket-argv-beta5-critic-r1.md`). Each test states
 * what the code SHOULD do; a failing one is a finding, reproduced.
 *
 * P1: the handoff sweep runs on every `till up` start and every Studio open, and on Linux its first
 * directory is `$HOME`. It removes, recursively, ANY directory there whose name starts with
 * `till-open-` and whose mtime is older than 30 s, without checking that TILL made it. A person's own
 * `~/till-open-banking` project is deleted.
 *
 * P2: the argv guard only looks for `#`. A ticket that reaches argv without a `#` (percent-encoded, or
 * in a second argument) passes it. This probe asserts the ticket VALUE itself is on no argv.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { openBrowser, openStudioLink, sweepStudioHandoffs } from '../../dist/api/up.js';

const scratch = [];
const scratchDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-critic-'));
  scratch.push(dir);
  return dir;
};
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

test('P1: the sweep leaves a person\'s own ~/till-open-* directory alone (it did not make it)', () => {
  const home = scratchDir();
  const project = join(home, 'till-open-banking');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'main.ts'), 'the person\'s own work');
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(project, old, old);
  // Exactly what `startUp` and `writeHandoff` run on Linux, with HOME first.
  sweepStudioHandoffs({ handoffDirs: [home], handoffTtlMs: 30_000 });
  assert.equal(existsSync(join(project, 'src', 'main.ts')), true, 'the sweep deleted a directory TILL never made');
});

function recorder() {
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ command, args: [...args] });
    const child = new EventEmitter();
    child.unref = () => {};
    const stdin = new EventEmitter();
    stdin.end = () => {};
    child.stdin = stdin;
    return child;
  };
  return { calls, spawn };
}

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`P2 (${platform}): the ticket value itself is on no argv, in any encoding`, async () => {
    const t = randomBytes(32).toString('base64url');
    const rec = recorder();
    const ports = { platform, spawn: rec.spawn, handoffDirs: [scratchDir()], handoffTtlMs: 60_000 };
    openStudioLink(`http://127.0.0.1:8788/#t=${t}`, () => {}, ports);
    openBrowser(`http://127.0.0.1:8788/#t=${t}`, () => {}, ports);
    await new Promise((r) => setImmediate(r));
    for (const { command, args } of rec.calls) {
      for (const part of [command, ...args]) {
        assert.ok(!decodeURIComponent(part).includes(t), `ticket on argv: ${command} ${args.join(' ')}`);
      }
    }
  });
}
