/**
 * M00's single-instance lock: the advisory guard that stops two `till up` processes running two
 * schedulers against one database.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireLock, readLock, releaseLock, isProcessAlive, lockPath } from '../../dist/api/up-lock.js';

const freshDir = () => mkdtempSync(join(tmpdir(), 'till-uplock-'));
const lock = (pid, port = 8788) => ({ pid, host: '127.0.0.1', port, url: `http://127.0.0.1:${port}`, startedAt: '2026-07-16T00:00:00.000Z' });

test('isProcessAlive: true for this process, false for a dead pid and a nonsense one', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(2_147_480_000), false); // no such process
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
});

test('acquire writes the lock and readLock round-trips it', () => {
  const dir = freshDir();
  const res = acquireLock(dir, lock(process.pid, 8801));
  assert.equal(res.acquired, true);
  assert.ok(existsSync(lockPath(dir)));
  assert.deepEqual(readLock(dir), lock(process.pid, 8801));
});

test('a live holder refuses a second acquirer and hands back the holder', () => {
  const dir = freshDir();
  // Seat this (alive) process as the holder, then a different pid tries to take it.
  acquireLock(dir, lock(process.pid, 8802));
  const res = acquireLock(dir, lock(424242, 8899));
  assert.equal(res.acquired, false);
  assert.equal(res.holder.pid, process.pid);
  assert.equal(res.holder.url, 'http://127.0.0.1:8802');
});

test('a stale lock (dead pid) is reclaimed', () => {
  const dir = freshDir();
  writeFileSync(lockPath(dir), JSON.stringify(lock(2_147_480_000, 8803)));
  const res = acquireLock(dir, lock(process.pid, 8804));
  assert.equal(res.acquired, true);
  assert.equal(readLock(dir).pid, process.pid);
});

test('a corrupt lock is treated as no lock', () => {
  const dir = freshDir();
  writeFileSync(lockPath(dir), 'not json at all');
  assert.equal(readLock(dir), null);
  assert.equal(acquireLock(dir, lock(process.pid)).acquired, true);
});

test('releaseLock removes only our own lock', () => {
  const dir = freshDir();
  acquireLock(dir, lock(process.pid, 8805));
  // A different pid must not delete a lock it does not own.
  releaseLock(dir, 999);
  assert.ok(existsSync(lockPath(dir)));
  releaseLock(dir, process.pid);
  assert.equal(existsSync(lockPath(dir)), false);
});
