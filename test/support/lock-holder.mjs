// @ts-check
/**
 * THE D12 SECOND PROCESS, for the suites that assert what a write does while another TILL holds the
 * book's write lock (the Studio and a `till mcp` agent subprocess on one file).
 *
 * It has to be a real second PROCESS, not a second connection in this one: the engine is synchronous,
 * so a store that waits in SQLite's busy handler blocks this whole thread, and a lock held by a
 * connection on the same thread could never be released while it waits.
 *
 * `take()` is SYNCHRONOUS on purpose, so a suite can have the lock taken at one precise point INSIDE a
 * verb (from a wrapped `prepare`, say) and not only before it starts. The two processes meet through
 * two files: this side writes the trigger and polls for the ack; the holder polls for the trigger,
 * begins IMMEDIATE, writes the ack, holds the lock for `holdMs`, runs `inTransaction` (a newer TILL's
 * migration, for instance) and commits. When this side already holds the write lock itself, the holder
 * cannot take it, `take()` returns false after `waitMs`, and the holder takes the lock once this side
 * commits; that is the observable form of "the verb held the lock throughout".
 *
 * Every book it touches is synthetic, created by the calling suite in a temp directory.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const DRIVER = createRequire(import.meta.url).resolve('better-sqlite3');
const CELL = new Int32Array(new SharedArrayBuffer(4));

/** @param {number} ms */
function sleep(ms) {
  Atomics.wait(CELL, 0, 0, ms);
}

/**
 * Spawn a holder for the book at `path` and wait until it has opened it.
 *
 * @param {string} path
 * @param {{ holdMs?: number, inTransaction?: string }} [options] `inTransaction` is JavaScript run by
 *   the holder on its connection `db` after the hold and before COMMIT.
 * @returns {Promise<{ take: (waitMs?: number) => boolean, done: Promise<number | null> }>}
 */
export async function lockHolder(path, { holdMs = 300, inTransaction = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'till-lock-holder-'));
  const trigger = join(dir, 'go');
  const ack = join(dir, 'locked');
  const source = `
    const fs = require('node:fs');
    const Database = require(${JSON.stringify(DRIVER)});
    const cell = new Int32Array(new SharedArrayBuffer(4));
    const sleep = (ms) => Atomics.wait(cell, 0, 0, ms);
    const db = new Database(${JSON.stringify(path)}, { timeout: 20000 });
    fs.writeSync(1, 'ready\\n');
    const giveUp = Date.now() + 60000;
    while (!fs.existsSync(${JSON.stringify(trigger)})) {
      if (Date.now() > giveUp) process.exit(2);
      sleep(1);
    }
    db.exec('BEGIN IMMEDIATE');
    fs.writeFileSync(${JSON.stringify(ack)}, '1');
    sleep(${Number(holdMs)});
    ${inTransaction}
    db.exec('COMMIT');
    db.close();`;
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'inherit'] });
  const done = new Promise((resolve) => {
    child.once('exit', (code) => {
      rmSync(dir, { recursive: true, force: true });
      resolve(code);
    });
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.value !== 'ready') throw new Error(`the lock holder did not start: ${String(first.value)}`);
  return {
    take(waitMs = 20_000) {
      writeFileSync(trigger, '1');
      const end = Date.now() + waitMs;
      while (!existsSync(ack)) {
        if (Date.now() > end) return false;
        sleep(1);
      }
      return true;
    },
    done,
  };
}
