/**
 * Critic r2 probes for D162 point 3 (`docs/critique/up-ticket-argv-beta5-critic-r2.md`): the
 * non-recursive handoff removal never reaches through a link to delete a file it did not write.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { openStudioLink, sweepStudioHandoffs, HANDOFF_DIR_PREFIX } from '../../dist/api/up.js';

const scratch = [];
const scratchDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-critic2-'));
  scratch.push(dir);
  return dir;
};
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function recorder() {
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ command, args: [...args] });
    const child = new EventEmitter();
    child.unref = () => {};
    child.stdin = Object.assign(new EventEmitter(), { end: () => {} });
    return child;
  };
  return { calls, spawn };
}

test('R2-1: the lifetime timer unlinks a page swapped for a symlink, never the file it points at', async () => {
  const base = scratchDir();
  const victim = join(scratchDir(), 'keep.txt');
  writeFileSync(victim, 'the person\'s own file');
  const rec = recorder();
  const t = randomBytes(32).toString('base64url');
  openStudioLink(`http://127.0.0.1:8788/#t=${t}`, () => {}, { platform: 'linux', spawn: rec.spawn, handoffDirs: [base], handoffTtlMs: 30 });
  const page = fileURLToPath(rec.calls[0].args.at(-1));
  unlinkSync(page);
  symlinkSync(victim, page); // swapped in after the write, before the timer
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(existsSync(victim), true, 'the link target survives');
  assert.equal(existsSync(dirname(page)), false, 'the handoff directory is gone');
});

test('R2-2: the sweep leaves a stale TILL-shaped directory whose page is a symlink, and its target', () => {
  const base = scratchDir();
  const victim = join(scratchDir(), 'keep.txt');
  writeFileSync(victim, 'x');
  const dir = mkdtempSync(join(base, HANDOFF_DIR_PREFIX));
  symlinkSync(victim, join(dir, 'open-till.html'));
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(dir, old, old);
  sweepStudioHandoffs({ handoffDirs: [base], handoffTtlMs: 30_000 });
  assert.equal(existsSync(victim), true);
  assert.equal(existsSync(dir), true, 'a page that is a symlink is not ours: the directory stays');
});
