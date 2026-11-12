// Critic round 5 probe for claude/aux-durability-beta5 (ad37b9bf6): what `till up` (the Studio face)
// reports for a 0-byte adopted book. Synthetic support dir and book in a temp directory only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../bin/till.mjs', import.meta.url));

test('[FINDING R5-L1] till up on a 0-byte adopted book reports it unopenable (the file is there), not missing, and writes nothing to it', { skip: process.platform === 'win32' ? 'POSIX only' : false }, async () => {
  const support = mkdtempSync(join(tmpdir(), 'till-crit-r5-'));
  const book = join(support, 'Buchhaltung.till');
  writeFileSync(book, '');
  writeFileSync(join(support, 'book.json'), JSON.stringify({ dbPath: book }));
  chmodSync(join(support, 'book.json'), 0o600);
  const port = String(18000 + Math.floor(Math.random() * 2000));
  const child = spawn(process.execPath, [BIN, 'up', '--no-open'], {
    env: { ...process.env, TILL_SUPPORT_DIR: support, TILL_PORT: port, TILL_NO_OPEN: '1', TILL_DB_PATH: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  child.stdout.on('data', (d) => (err += d));
  try {
    const until = Date.now() + 20000;
    while (!/not reachable \(/.test(err) && Date.now() < until && child.exitCode === null) await new Promise((r) => setTimeout(r, 100));
    const reason = /not reachable \((\w+)\)/.exec(err)?.[1];
    assert.ok(reason !== undefined, `non-vacuity: till up logged its unavailable book (${err.slice(0, 400)})`);
    assert.equal(statSync(book).size, 0, 'nothing was written to the 0-byte book');
    assert.equal(reason, 'unopenable', `till up told the Studio "${reason}" ("TILL cannot find the file any more ... moved, or its drive is not connected") for a file that is there: ${err.split('\n').find((l) => /not reachable/.test(l))}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    rmSync(support, { recursive: true, force: true });
  }
});
