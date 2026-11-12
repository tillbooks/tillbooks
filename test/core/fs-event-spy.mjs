// Record the engine's explicit filesystem durability events (open, fsync, rename, write-file,
// truncate) in the ORDER they happen, by wrapping node:fs and repointing its live ESM bindings with
// `syncBuiltinESMExports`. The engine is not modified to be observed. SQLite's own syncs run in native
// code and never show up here, so what is recorded is exactly what TILL's TypeScript does.

import { createRequire, syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';

const fs = createRequire(import.meta.url)('node:fs');

/**
 * Run `fn` with node:fs instrumented and return `{ result, events }`. Each event is
 * `{ op: 'fsync', path }`, `{ op: 'rename', from, to }`, `{ op: 'writeFile', path }` (a whole-file
 * `writeFileSync`, which truncates in place) or `{ op: 'truncate', path }`. Paths are absolute.
 * Optional `hooks.beforeRename(from, to)` runs just before a rename (to simulate a crash or a racing
 * writer); throwing from it aborts the rename. Optional `hooks.afterFsync(path)` runs right after a
 * successful fsync (to simulate another writer acting between two steps).
 */
export function withFsEvents(fn, hooks = {}) {
  const original = {
    openSync: fs.openSync,
    fsyncSync: fs.fsyncSync,
    renameSync: fs.renameSync,
    writeFileSync: fs.writeFileSync,
    truncateSync: fs.truncateSync,
    ftruncateSync: fs.ftruncateSync,
  };
  const opened = new Map();
  const events = [];
  fs.openSync = function spyOpen(path, ...rest) {
    const fd = original.openSync.call(this, path, ...rest);
    opened.set(fd, resolve(String(path)));
    return fd;
  };
  fs.fsyncSync = function spyFsync(fd) {
    const path = opened.get(fd) ?? `fd:${fd}`;
    events.push({ op: 'fsync', path });
    const out = original.fsyncSync.call(this, fd);
    if (hooks.afterFsync !== undefined) hooks.afterFsync(path);
    return out;
  };
  fs.renameSync = function spyRename(from, to) {
    if (hooks.beforeRename !== undefined) hooks.beforeRename(resolve(String(from)), resolve(String(to)));
    events.push({ op: 'rename', from: resolve(String(from)), to: resolve(String(to)) });
    return original.renameSync.call(this, from, to);
  };
  fs.writeFileSync = function spyWriteFile(path, ...rest) {
    if (typeof path === 'string' || path instanceof URL) events.push({ op: 'writeFile', path: resolve(String(path)) });
    return original.writeFileSync.call(this, path, ...rest);
  };
  fs.truncateSync = function spyTruncate(path, ...rest) {
    events.push({ op: 'truncate', path: resolve(String(path)) });
    return original.truncateSync.call(this, path, ...rest);
  };
  fs.ftruncateSync = function spyFtruncate(fd, ...rest) {
    events.push({ op: 'truncate', path: opened.get(fd) ?? `fd:${fd}` });
    return original.ftruncateSync.call(this, fd, ...rest);
  };
  syncBuiltinESMExports();
  try {
    const result = fn();
    return { result, events };
  } finally {
    Object.assign(fs, original);
    syncBuiltinESMExports();
  }
}

/** The index of the first event matching `pred`, or -1. */
export function indexOfEvent(events, pred) {
  return events.findIndex(pred);
}
