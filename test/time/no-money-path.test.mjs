/**
 * B01's money-path ABSENCE, asserted rather than documented (spec §4 "Money correctness"): time is
 * pre-financial. B01 posts nothing, settles nothing and transmits nothing.
 *
 *   1. The ONLY money columns on B01's two tables are the OP1 RATE snapshots (`rate_minor` and,
 *      since the B03 cost dimension, `cost_rate_minor`, on both the entry and the card), read off
 *      the live PRAGMA rather than off a list, so a migration that adds a stored VALUE column (the
 *      P2 violation: the line value is derived round-once by B02 and by `time_list`, never stored)
 *      reddens this file on the day it lands. A cost RATE is the same class as the bill rate: a
 *      price per hour, snapshotted at capture, from which every value is still derived at read.
 *   2. The time engine imports no posting path: no `postEntry`, no `recordPayment`, no module from
 *      `ledger/` or `payments/`.
 *   3. The time engine imports no network, e-mail or push client of any kind: the local core makes
 *      zero network calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';

const TIME_DIR = fileURLToPath(new URL('../../src/core/time/', import.meta.url));

test('B01: the only money columns are the rate snapshot, and no stored line value exists', () => {
  const store = new SqliteStore();
  const entryColumns = store.db.prepare('PRAGMA table_info(time_entry)').all().map((c) => c.name);
  assert.ok(entryColumns.length >= 15, 'PRAGMA answered nothing: the probe is broken');
  const entryMoney = entryColumns.filter((n) => n.includes('_rappen') || n.includes('_minor') || n.includes('amount'));
  assert.deepEqual(entryMoney, ['rate_minor', 'cost_rate_minor'], 'time_entry may carry the two rate SNAPSHOTS and nothing else');

  const cardColumns = store.db.prepare('PRAGMA table_info(rate_card)').all().map((c) => c.name);
  assert.ok(cardColumns.length >= 8, 'PRAGMA answered nothing: the probe is broken');
  const cardMoney = cardColumns.filter((n) => n.includes('_rappen') || n.includes('_minor') || n.includes('amount'));
  assert.deepEqual(cardMoney, ['rate_minor', 'cost_rate_minor'], 'rate_card carries the two rates and nothing else');
});

test('B01: the time engine reaches no posting path and no transport', () => {
  const files = readdirSync(TIME_DIR).filter((f) => f.endsWith('.ts'));
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
    const source = readFileSync(`${TIME_DIR}${file}`, 'utf8');
    for (const probe of forbidden) {
      assert.equal(probe.test(source), false, `${file} matches ${probe}: the money/transport boundary is crossed`);
    }
  }
  // Non-vacuous: the same probes MUST find their prey where it legitimately lives, or they match
  // nothing anywhere and every assertion above is empty.
  const payments = readFileSync(fileURLToPath(new URL('../../src/core/payments/payment.ts', import.meta.url)), 'utf8');
  assert.ok(/\bpostEntry\b\s*\(/.test(payments), 'the postEntry probe cannot find postEntry even in A14');
});
