/**
 * G06's money-path ABSENCE and no-socket boundary, asserted rather than documented (spec §4
 * "Money correctness" and §7): a notification never posts, never carries money, and the OSS core
 * never transmits one.
 *
 *   1. The three G06 tables have ZERO `_rappen` (or `_minor` or `amount`) columns, read off the
 *      live PRAGMA rather than off a list, so a migration that adds one reddens this file the day
 *      it lands.
 *   2. The notifications engine imports no posting path: no `postEntry`, no `recordPayment`, no
 *      module from `ledger/` or `payments/`.
 *   3. The notifications engine imports no network, e-mail or push client of any kind, MODULE-WIDE
 *      and not just outside `runDigest`: the OSS core wires no notification transmitter at all
 *      (reconciled §0.7), so the US-G06.5 no-socket guarantee is a static fact about the imports,
 *      stronger than the spec's original "only runDigest may". The carve-in arrives with the
 *      cloud-tier transmitter port, and THIS test is what forces that arrival to be argued.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';

const NOTIFICATIONS_DIR = fileURLToPath(new URL('../../src/core/notifications/', import.meta.url));

test('G06: the three notification tables carry no money column', () => {
  const store = new SqliteStore();
  for (const table of ['inbox_item', 'notification_pref', 'digest_run']) {
    const columns = store.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    assert.ok(columns.length >= 5, `PRAGMA answered nothing for ${table}: the probe is broken`);
    const money = columns.filter((name) => name.includes('_rappen') || name.includes('_minor') || name.includes('amount'));
    assert.deepEqual(money, [], `${table} grew money columns: ${money.join(', ')}`);
  }
});

test('G06: the notifications engine reaches no posting path and no transport', () => {
  const files = readdirSync(NOTIFICATIONS_DIR).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 3, `only ${files.length} engine files found: the probe is aimed wrong`);
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
    /from 'node:tls'/,
    /\bfetch\s*\(/,
    /emailRelay/,
    /signTransmitter/,
    /nodemailer/,
  ];
  for (const file of files) {
    const source = readFileSync(`${NOTIFICATIONS_DIR}${file}`, 'utf8');
    for (const probe of forbidden) {
      assert.equal(probe.test(source), false, `${file} matches ${probe}: the money/transport boundary is crossed`);
    }
  }
  // Non-vacuous: the same probes MUST find their prey where it legitimately lives, or they match
  // nothing anywhere and every assertion above is empty.
  const payments = readFileSync(fileURLToPath(new URL('../../src/core/payments/payment.ts', import.meta.url)), 'utf8');
  assert.ok(/\bpostEntry\b\s*\(/.test(payments), 'the postEntry probe cannot find postEntry even in A14');
  const invoice = readFileSync(fileURLToPath(new URL('../../src/core/sales/invoice.ts', import.meta.url)), 'utf8');
  assert.ok(/emailRelay/.test(invoice), 'the emailRelay probe cannot find the relay even in A11');
});
