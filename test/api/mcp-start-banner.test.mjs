/**
 * P0.5c: `till mcp` says on STDERR which ledger it opened and where a human approves what the agent
 * drafts (a running Studio's URL, or how to start one). STDOUT stays the clean MCP channel.
 *
 * The first-run audit's agent path had no way back to a human: `npx tillbooks mcp` started silently,
 * and nothing told the person who wired it up that drafts wait in a Studio, or that none was running.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mcpStartLines } from '../../dist/api/approval-pointer.js';
import { resetDeliveryRuntime } from '../../dist/api/runtime-state.js';

const CLI = fileURLToPath(new URL('../../bin/till.mjs', import.meta.url));

function lockIn(supportDir, lock) {
  mkdirSync(supportDir, { recursive: true });
  writeFileSync(join(supportDir, 'up.lock'), JSON.stringify(lock));
}

test('with no Studio running, the banner names the ledger and how to start one', () => {
  resetDeliveryRuntime();
  const supportDir = mkdtempSync(join(tmpdir(), 'till-banner-none-'));
  const lines = mcpStartLines({ dbPath: '/tmp/till-banner/book.db', supportDir });
  assert.match(lines[0], /ledger \/tmp\/till-banner\/book\.db/);
  assert.match(lines[1], /no Studio is running/);
  assert.match(lines[1], /till up/);
  assert.match(lines[1], /\/agent/);
});

test('beside a live till up on the same ledger it prints the Studio URL; on another ledger it warns', () => {
  resetDeliveryRuntime();
  const supportDir = mkdtempSync(join(tmpdir(), 'till-banner-lock-'));
  const lock = { pid: process.ppid, host: '127.0.0.1', port: 8793, url: 'http://127.0.0.1:8793', startedAt: '2026-09-30T08:00:00.000Z' };
  lockIn(supportDir, { ...lock, dbPath: '/tmp/till-banner/book.db' });
  assert.match(mcpStartLines({ dbPath: '/tmp/till-banner/book.db', supportDir })[1], /Studio at http:\/\/127\.0\.0\.1:8793\/agent/);
  assert.match(mcpStartLines({ dbPath: '/tmp/till-banner/other.db', supportDir })[1], /DIFFERENT ledger/);
});

test('the real `till mcp` prints the banner on stderr and nothing on stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-banner-cli-'));
  const dbPath = join(dir, 'book.db');
  const supportDir = join(dir, 'support');
  // A live holder that is not the child: this test process.
  lockIn(supportDir, { pid: process.pid, host: '127.0.0.1', port: 8794, url: 'http://127.0.0.1:8794', startedAt: '2026-09-30T08:00:00.000Z', dbPath });
  const env = { ...process.env, TILL_DB_PATH: dbPath, TILL_SUPPORT_DIR: supportDir };
  const child = spawn(process.execPath, [CLI, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (c) => (stderr += c));
  child.stdout.on('data', (c) => (stdout += c));
  try {
    const deadline = Date.now() + 60_000;
    while (!/Studio at /.test(stderr)) {
      if (child.exitCode !== null) assert.fail(`till mcp exited ${child.exitCode}: ${stderr}`);
      if (Date.now() > deadline) assert.fail(`no banner within 60 s: ${stderr}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.match(stderr, new RegExp(`ledger ${dbPath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
    assert.match(stderr, /Studio at http:\/\/127\.0\.0\.1:8794\/agent/);
    assert.equal(stdout, '', 'stdout is the MCP channel: the banner never lands there');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => {
      if (child.exitCode !== null) r();
      else child.once('exit', r);
    });
  }
});
