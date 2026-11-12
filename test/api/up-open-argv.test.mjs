/**
 * D162 point 3: a Studio link carries a one-time ticket (`/#t=`) or, from the dev bridge, the key
 * (`/#k=`) in its fragment, and that fragment must never reach a command line. An argument is readable
 * by every account on the machine through `ps` or `/proc/<pid>/cmdline`, and a browser the opener
 * cold-starts keeps it in its own command line while it runs.
 *
 * Every opener path is driven through a recording `spawn`: macOS through `osascript` stdin, macOS when
 * `osascript` cannot start, Linux, Windows, a link that is not ours, and a handoff that cannot be
 * written. No spawned argv may hold `#t=` or `#k=`, and the ticket reaches the browser only through
 * stdin or the owner-only handoff page. Every ticket below is minted for the test.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { openBrowser, openStudioLink, sweepStudioHandoffs, HANDOFF_DIR_PREFIX } from '../../dist/api/up.js';

const scratch = [];
const scratchDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-argv-'));
  scratch.push(dir);
  return dir;
};
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const ticket = () => randomBytes(32).toString('base64url');

/**
 * A recording `spawn`: every call is kept; `failing` commands emit `error` like a missing binary (twice
 * when `errorsTwice`), and `stdinFails` makes the child's stdin emit `EPIPE`.
 */
function recorder({ failing = [], errorsTwice = false, stdinFails = false } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    const call = { command, args: [...args], options, stdin: '' };
    calls.push(call);
    child.unref = () => {};
    const stdin = new EventEmitter();
    stdin.end = (chunk) => {
      call.stdin += chunk ?? '';
    };
    child.stdin = stdin;
    if (failing.includes(command)) {
      const fail = () => child.emit('error', Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }));
      queueMicrotask(fail);
      if (errorsTwice) queueMicrotask(fail);
    }
    if (stdinFails) queueMicrotask(() => stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
    return child;
  };
  return { calls, spawn };
}

function portsFor(platform, rec, dir = scratchDir()) {
  return { platform, spawn: rec.spawn, handoffDirs: [dir], handoffTtlMs: 60_000 };
}

const settle = () => new Promise((r) => setImmediate(r));

function assertNoFragmentOnArgv(calls) {
  assert.ok(calls.length > 0, 'something was spawned');
  for (const { command, args } of calls) {
    for (const part of [command, ...args]) {
      assert.ok(!part.includes('#t=') && !part.includes('#k='), `argv carries a fragment: ${command} ${args.join(' ')}`);
      assert.ok(!part.includes('#'), `argv carries a fragment: ${command} ${args.join(' ')}`);
    }
  }
}

/** The handoff the last opener call names: its file, its contents, and that it is owner-only. */
function readHandoff(call) {
  const target = call.args[call.args.length - 1];
  assert.match(target, /^file:\/\//, 'the opener got a file: URL, not the link');
  const file = fileURLToPath(target);
  const body = readFileSync(file, 'utf8');
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600, 'the handoff file is owner-only');
    assert.equal(statSync(join(file, '..')).mode & 0o777, 0o700, 'the handoff directory is owner-only');
  }
  return { file, body };
}

for (const fragment of ['t', 'k']) {
  const link = () => `http://127.0.0.1:8788/#${fragment}=${ticket()}`;

  test(`macOS: the #${fragment}= link goes to osascript on stdin, never on argv`, async () => {
    const rec = recorder();
    const url = link();
    openStudioLink(url, () => {}, portsFor('darwin', rec));
    await settle();
    assertNoFragmentOnArgv(rec.calls);
    assert.equal(rec.calls.length, 1);
    assert.deepEqual([rec.calls[0].command, rec.calls[0].args], ['/usr/bin/osascript', ['-']]);
    assert.equal(rec.calls[0].stdin, `open location "${url}"\n`);
  });

  test(`macOS, osascript cannot start: the #${fragment}= link goes through the handoff page, not argv`, async () => {
    const rec = recorder({ failing: ['/usr/bin/osascript'] });
    const url = link();
    openStudioLink(url, () => {}, portsFor('darwin', rec));
    await settle();
    assertNoFragmentOnArgv(rec.calls);
    assert.equal(rec.calls.length, 2, 'osascript, then exactly one fallback');
    assert.equal(rec.calls[1].command, 'open');
    assert.ok(readHandoff(rec.calls[1]).body.includes(JSON.stringify(url)));
  });

  test(`Linux: the #${fragment}= link goes through the handoff page given to xdg-open`, async () => {
    const rec = recorder();
    const url = link();
    openStudioLink(url, () => {}, portsFor('linux', rec));
    await settle();
    assertNoFragmentOnArgv(rec.calls);
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0].command, 'xdg-open');
    const { body } = readHandoff(rec.calls[0]);
    assert.ok(body.includes(`location.replace(${JSON.stringify(url)})`));
  });

  test(`Windows: the #${fragment}= link goes through the handoff page given to rundll32 as one argument`, async () => {
    const rec = recorder();
    const url = link();
    openStudioLink(url, () => {}, portsFor('win32', rec));
    await settle();
    assertNoFragmentOnArgv(rec.calls);
    assert.equal(rec.calls[0].command, 'rundll32');
    assert.equal(rec.calls[0].args.length, 2);
    assert.equal(rec.calls[0].args[0], 'url.dll,FileProtocolHandler');
    assert.ok(readHandoff(rec.calls[0]).body.includes(JSON.stringify(url)));
  });

  for (const platform of ['linux', 'win32', 'darwin']) {
    test(`${platform}: no handoff can be written, so the BARE URL opens, never the #${fragment}= link`, async () => {
      const rec = recorder({ failing: ['/usr/bin/osascript'] });
      const lines = [];
      openStudioLink(link(), (l) => lines.push(l), portsFor(platform, rec, join(scratchDir(), 'missing')));
      await settle();
      assertNoFragmentOnArgv(rec.calls);
      assert.equal(rec.calls[rec.calls.length - 1].args.at(-1), 'http://127.0.0.1:8788/');
    });

    test(`${platform}: openBrowser cuts the #${fragment}= fragment before the command line`, async () => {
      const rec = recorder();
      openBrowser(link(), () => {}, portsFor(platform, rec));
      await settle();
      assertNoFragmentOnArgv(rec.calls);
      assert.equal(rec.calls[0].args.at(-1), 'http://127.0.0.1:8788/');
    });

    test(`${platform}: a link that is not ours is opened bare and embedded nowhere`, async () => {
      const rec = recorder();
      const tmpDir = scratchDir();
      openStudioLink(`http://127.0.0.1:8788/#${fragment}=${ticket()}";do shell script "x`, () => {}, portsFor(platform, rec, tmpDir));
      await settle();
      assertNoFragmentOnArgv(rec.calls);
      assert.equal(rec.calls.length, 1);
      assert.notEqual(rec.calls[0].command, '/usr/bin/osascript');
      assert.equal(rec.calls[0].args.at(-1), 'http://127.0.0.1:8788/');
      assert.deepEqual(readdirSync(tmpDir), [], 'no handoff page for a link that is not ours');
    });
  }
}

test('a failed handoff open logs the http base, not the handoff page that is about to go', async () => {
  const rec = recorder({ failing: ['xdg-open'] });
  const lines = [];
  const t = ticket();
  openStudioLink(`http://127.0.0.1:8788/#t=${t}`, (l) => lines.push(l), portsFor('linux', rec));
  await settle();
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes(t) && !lines[0].includes('file:') && lines[0].includes('http://127.0.0.1:8788/'));
});

test('macOS: osascript reporting its failure twice still opens exactly one fallback', async () => {
  const rec = recorder({ failing: ['/usr/bin/osascript'], errorsTwice: true });
  openStudioLink(`http://127.0.0.1:8788/#t=${ticket()}`, () => {}, portsFor('darwin', rec));
  await settle();
  assertNoFragmentOnArgv(rec.calls);
  assert.equal(rec.calls.length, 2);
});

test('macOS: an osascript whose stdin breaks (EPIPE) does not throw', async () => {
  const rec = recorder({ stdinFails: true });
  assert.doesNotThrow(() => openStudioLink(`http://127.0.0.1:8788/#t=${ticket()}`, () => {}, portsFor('darwin', rec)));
  await settle();
  assertNoFragmentOnArgv(rec.calls);
});

test('the handoff goes into the first directory that takes it, in order (Linux: HOME before /tmp)', async () => {
  const rec = recorder();
  const first = join(scratchDir(), 'missing');
  const second = scratchDir();
  openStudioLink(`http://127.0.0.1:8788/#t=${ticket()}`, () => {}, { ...portsFor('linux', rec), handoffDirs: [first, second] });
  await settle();
  const { file } = readHandoff(rec.calls[0]);
  assert.ok(file.startsWith(second), 'an unwritable first choice falls through to the next');

  const rec2 = recorder();
  const home = scratchDir();
  openStudioLink(`http://127.0.0.1:8788/#t=${ticket()}`, () => {}, { ...portsFor('linux', rec2), handoffDirs: [home, second] });
  await settle();
  assert.ok(readHandoff(rec2.calls[0]).file.startsWith(home), 'the first writable choice wins');
  assert.ok(!HANDOFF_DIR_PREFIX.startsWith('.'), 'the handoff directory is not hidden: a snap browser cannot read a hidden one under HOME');
});

test('the sweep never follows or removes a symlink, even one shaped like a handoff', () => {
  const base = scratchDir();
  const target = scratchDir();
  writeFileSync(join(target, 'keep'), 'x');
  const link = join(base, `${HANDOFF_DIR_PREFIX}Ab12Cd`); // mkdtemp-shaped, so only the symlink check stops it
  symlinkSync(target, link);
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(target, old, old);
  sweepStudioHandoffs({ handoffDirs: [base], handoffTtlMs: 1 });
  assert.equal(existsSync(link), true, 'the symlink stays');
  assert.equal(existsSync(join(target, 'keep')), true, 'what it points at stays');
});

test('a failed open logs the bare URL only', async () => {
  const rec = recorder({ failing: ['xdg-open'] });
  const lines = [];
  const t = ticket();
  openBrowser(`http://127.0.0.1:8788/#t=${t}`, (l) => lines.push(l), portsFor('linux', rec));
  await settle();
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes(t) && lines[0].includes('http://127.0.0.1:8788/'));
});

test('a handoff left behind by an exited process is swept by the next open; a fresh one is kept', async () => {
  const tmpDir = scratchDir();
  // Real mkdtemp names, the shape `writeHandoff` makes (critic r1 F1).
  const stale = mkdtempSync(join(tmpDir, HANDOFF_DIR_PREFIX));
  const fresh = mkdtempSync(join(tmpDir, HANDOFF_DIR_PREFIX));
  for (const dir of [stale, fresh]) writeFileSync(join(dir, 'open-till.html'), 'x', { mode: 0o600 });
  const old = new Date(Date.now() - 120_000);
  utimesSync(stale, old, old);
  const rec = recorder();
  openStudioLink(`http://127.0.0.1:8788/#t=${ticket()}`, () => {}, portsFor('linux', rec, tmpDir));
  await settle();
  assert.equal(existsSync(stale), false, 'the stale handoff is gone');
  assert.equal(existsSync(fresh), true, 'a handoff still inside its lifetime is kept');
});

test('the page a second `till up` left behind (it exits before its timer) goes with the next sweep', async () => {
  const home = scratchDir();
  const rec = recorder();
  // The real write, with a timer that never fires inside this test: the process "exits" first.
  openStudioLink(`http://127.0.0.1:8788/#t=${ticket()}`, () => {}, { ...portsFor('linux', rec, home), handoffTtlMs: 600_000 });
  const { file } = readHandoff(rec.calls[0]);
  const dir = dirname(file);
  assert.match(basename(dir), /^till-open-[A-Za-z0-9]{6}$/, 'writeHandoff makes the shape the sweep recognises');
  const old = new Date(Date.now() - 120_000);
  utimesSync(dir, old, old);
  sweepStudioHandoffs({ handoffDirs: [home], handoffTtlMs: 30_000 });
  assert.equal(existsSync(dir), false, 'the next start removes the leftover handoff');
});

test('the sweep keeps a TILL-shaped directory that holds anything but the page, and any other name', () => {
  const home = scratchDir();
  const old = new Date(Date.now() - 3_600_000);
  const extra = mkdtempSync(join(home, HANDOFF_DIR_PREFIX));
  writeFileSync(join(extra, 'open-till.html'), 'x');
  writeFileSync(join(extra, 'notes.txt'), 'the person\'s own file');
  const nested = mkdtempSync(join(home, HANDOFF_DIR_PREFIX));
  mkdirSync(join(nested, 'open-till.html'));
  const named = join(home, `${HANDOFF_DIR_PREFIX}banking`);
  mkdirSync(named);
  writeFileSync(join(named, 'open-till.html'), 'x');
  for (const dir of [extra, nested, named]) utimesSync(dir, old, old);
  sweepStudioHandoffs({ handoffDirs: [home], handoffTtlMs: 30_000 });
  assert.equal(existsSync(join(extra, 'notes.txt')), true, 'a directory with more than the page stays whole');
  assert.equal(existsSync(join(extra, 'open-till.html')), true, 'and its page is not touched either');
  assert.equal(existsSync(join(nested, 'open-till.html')), true, 'a page that is not a plain file is not ours');
  assert.equal(existsSync(join(named, 'open-till.html')), true, 'a name not shaped by mkdtemp is not ours');
});

test('the handoff page is removed after its lifetime', async () => {
  const rec = recorder();
  const tmpDir = scratchDir();
  openStudioLink(`http://127.0.0.1:8788/#t=${ticket()}`, () => {}, { ...portsFor('linux', rec, tmpDir), handoffTtlMs: 20 });
  const { file } = readHandoff(rec.calls[0]);
  assert.equal(existsSync(file), true);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(existsSync(file), false, 'the ticket does not outlive the handoff');
  assert.deepEqual(readdirSync(tmpDir), []);
});
