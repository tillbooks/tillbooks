// A43 section 5, the docs stay true: the example connector of "Write a connector" is run as printed. It must
// produce a document the reader takes, and serve it under the path and token the page describes.
// SYNTHETIC DATA ONLY (the page's own invented sales).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkSettlementText } from '../../dist/api/settlement-format-actions.js';

const PAGE = readFileSync(new URL('../../site-docs/formats/write-a-connector.mdx', import.meta.url), 'utf8');
const block = /```js title="connector\.mjs"\n([\s\S]*?)```/.exec(PAGE);

test('the example script is on the page, short, and prints a document the reader accepts', () => {
  assert.ok(block, 'the page carries the script');
  const code = block[1];
  assert.ok(code.trim().split('\n').length <= 40, 'a short script');
  const dir = mkdtempSync(join(tmpdir(), 'till-connector-'));
  try {
    writeFileSync(join(dir, 'connector.mjs'), code);
    const run = spawnSync(process.execPath, [join(dir, 'connector.mjs'), 'print'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const answer = checkSettlementText(run.stdout, 'CHF');
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(answer.valid, true);
    assert.equal(answer.events.readable, 2);
    assert.deepEqual(answer.events.byKind.sale, { count: 2, amountMinor: 16215 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the example script serves the feed under /feed with the bearer token and the range', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-connector-'));
  const file = join(dir, 'connector.mjs');
  writeFileSync(file, block[1]);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [file], { stdio: 'ignore', env: { ...process.env, PORT: String(port) } });
  try {
    const base = `http://127.0.0.1:${port}`;
    let res;
    for (let i = 0; i < 50 && res === undefined; i += 1) {
      try {
        res = await fetch(`${base}/feed?from=2026-07-01&to=2026-07-05`, { headers: { authorization: 'Bearer a-long-random-token-0123456789' } });
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.ok(res, 'the script listens');
    assert.equal(res.status, 200);
    const body = await res.text();
    const answer = checkSettlementText(body, 'CHF');
    assert.equal(answer.valid, true);
    assert.equal(answer.events.readable, 1, 'the range keeps only the first sale');
    assert.equal((await fetch(`${base}/feed`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
