// The small durable-file helpers beside the ledger's durability code (src/core/store/sqlite-store.ts),
// shared by G04 bundles, the landscape control file, G08's config and journal, and E04's mbox rewrite.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { writeFileDurably, appendFileDurably, fsyncTree } from '../../dist/core/store/sqlite-store.js';
import { withFsEvents } from './fs-event-spy.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'till-durable-file-'));
}

test('writeFileDurably: temp in the same dir, fsync, rename, directory fsync; old content survives a failed rename', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'config.json');
    writeFileSync(path, 'old\n');
    const { events } = withFsEvents(() => writeFileDurably(path, 'new\n'));
    const rename = events.findIndex((e) => e.op === 'rename' && e.to === resolve(path));
    assert.ok(rename > 0);
    assert.ok(events.slice(0, rename).some((e) => e.op === 'fsync' && e.path === events[rename].from));
    assert.ok(events.slice(rename + 1).some((e) => e.op === 'fsync' && e.path === resolve(dir)));
    assert.equal(readFileSync(path, 'utf8'), 'new\n');

    assert.throws(() =>
      withFsEvents(() => writeFileDurably(path, 'torn\n'), {
        beforeRename: () => {
          throw new Error('crash');
        },
      }),
    );
    assert.equal(readFileSync(path, 'utf8'), 'new\n', 'the target keeps its last good content');
    assert.deepEqual(readdirSync(dir).sort(), ['config.json'], 'no temp file is left behind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFileDurably sets the exact mode asked for, and temp names never collide', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'Drafts');
    writeFileDurably(path, 'x', { mode: 0o600 });
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    const names = new Set();
    const { events } = withFsEvents(() => {
      for (let i = 0; i < 5; i += 1) writeFileDurably(path, String(i));
    });
    for (const e of events.filter((ev) => ev.op === 'rename')) names.add(e.from);
    assert.equal(names.size, 5, 'every write used its own temp file');
    assert.equal(readFileSync(path, 'utf8'), '4');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendFileDurably fsyncs the file, and the directory only when it created the file', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'log.jsonl');
    const created = withFsEvents(() => appendFileDurably(path, 'a\n')).events;
    assert.ok(created.some((e) => e.op === 'fsync' && e.path === resolve(path)));
    assert.ok(created.some((e) => e.op === 'fsync' && e.path === resolve(dir)), 'a new file gets its directory entry synced');
    const appended = withFsEvents(() => appendFileDurably(path, 'b\n')).events;
    assert.ok(appended.some((e) => e.op === 'fsync' && e.path === resolve(path)));
    assert.equal(appended.some((e) => e.op === 'fsync' && e.path === resolve(dir)), false);
    assert.equal(readFileSync(path, 'utf8'), 'a\nb\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fsyncTree syncs every file and every directory, deepest first, root last; read-only files included', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'a'), '1');
    writeFileSync(join(dir, 'b'), '2');
    mkdtempSync(join(dir, 'x-'));
    const nested = readdirSync(dir).find((n) => n.startsWith('x-'));
    writeFileSync(join(dir, nested, 'c'), '3');
    chmodSync(join(dir, 'b'), 0o444);
    const { events } = withFsEvents(() => fsyncTree(dir));
    const synced = events.filter((e) => e.op === 'fsync').map((e) => e.path);
    for (const p of [join(dir, 'a'), join(dir, 'b'), join(dir, nested, 'c'), join(dir, nested), dir]) {
      assert.ok(synced.includes(resolve(p)), `${p} was synced`);
    }
    assert.equal(synced[synced.length - 1], resolve(dir), 'the root directory is synced last');
    assert.ok(synced.indexOf(resolve(join(dir, nested))) < synced.indexOf(resolve(dir)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFileDurably removes a stale temp sibling whose writer pid is dead, and keeps one a live process still owns (critic R1-L5)', async () => {
  const { spawn, spawnSync } = await import('node:child_process');
  const dir = tempDir();
  const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  try {
    const path = join(dir, 'Drafts');
    writeFileSync(path, 'old\n');
    // A pid that is certainly dead: a child that already exited.
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const deadPid = Number(dead.stdout);
    const stale = `.Drafts.${deadPid}.0123456789ab.tmp`;
    const owned = `.Drafts.${live.pid}.ba9876543210.tmp`;
    const other = `.config.json.${deadPid}.0123456789ab.tmp`;
    for (const name of [stale, owned, other]) writeFileSync(join(dir, name), 'a full copy\n');
    writeFileDurably(path, 'new\n');
    const left = readdirSync(dir).sort();
    assert.equal(left.includes(stale), false, 'the dead writer`s temp copy is removed');
    assert.equal(left.includes(owned), true, 'a live writer`s temp is its own and stays');
    assert.equal(left.includes(other), true, 'only temps of THIS target are touched');
    assert.equal(readFileSync(path, 'utf8'), 'new\n');
  } finally {
    live.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
