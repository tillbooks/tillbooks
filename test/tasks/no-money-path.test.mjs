/**
 * E03's money-path ABSENCE, asserted rather than documented (spec §4 "Money correctness" and §8
 * "Compliance fixture"): a task never posts, never carries money, and never transmits.
 *
 *   1. The `task` table has ZERO `_rappen` (or `_minor`) columns, read off the live PRAGMA rather
 *      than off a list, so a migration that adds one reddens this file on the day it lands.
 *   2. The tasks engine imports no posting path: no `postEntry`, no `recordPayment`, no module
 *      from `ledger/` or `payments/`.
 *   3. The tasks engine imports no network, e-mail or push client of any kind: the OP4 delivery
 *      boundary is G06's to cross, never E03's. The local core makes zero network calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';

const TASKS_DIR = fileURLToPath(new URL('../../src/core/tasks/', import.meta.url));

test('E03: the task table carries no money column', () => {
  const store = new SqliteStore();
  const columns = store.db.prepare('PRAGMA table_info(task)').all().map((c) => c.name);
  assert.ok(columns.length >= 10, 'PRAGMA answered nothing: the probe is broken');
  const money = columns.filter((name) => name.includes('_rappen') || name.includes('_minor') || name.includes('amount'));
  assert.deepEqual(money, [], `the task table grew money columns: ${money.join(', ')}`);
});

test('E03: the tasks engine reaches no posting path and no transport', () => {
  const files = readdirSync(TASKS_DIR).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 5, `only ${files.length} engine files found: the probe is aimed wrong`);
  // Quoted specifiers and named symbols, not substrings, so a comment mentioning the boundary (as
  // this module's own docblocks do) cannot trip the probe.
  const forbidden = [
    /from '.*ledger\//, // postEntry and friends live here
    /from '.*payments\//, // recordPayment lives here
    /\bpostEntry\b\s*\(/,
    /\brecordPayment\b\s*\(/,
    /from 'node:http'/,
    /from 'node:https'/,
    /from 'node:net'/,
    /from 'node:dgram'/,
    /\bfetch\s*\(/,
    /emailRelay/,
    /nodemailer/,
  ];
  for (const file of files) {
    const source = readFileSync(`${TASKS_DIR}${file}`, 'utf8');
    for (const probe of forbidden) {
      assert.equal(probe.test(source), false, `${file} matches ${probe}: the money/transport boundary is crossed`);
    }
  }
  // Non-vacuous: the same probes MUST find their prey where it legitimately lives, or they match
  // nothing anywhere and every assertion above is empty.
  const payments = readFileSync(fileURLToPath(new URL('../../src/core/payments/payment.ts', import.meta.url)), 'utf8');
  assert.ok(/\bpostEntry\b\s*\(/.test(payments), 'the postEntry probe cannot find postEntry even in A14');
});
