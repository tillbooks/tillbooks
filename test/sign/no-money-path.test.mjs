/**
 * E01's money-path ABSENCE, asserted rather than documented (spec §4 "Money correctness": E01 has
 * no financial effect, P3 is satisfied vacuously), and its DATA-LOCALITY (spec §8 compliance
 * fixture / revDSG / OP4): the OSS core produces the local artifact and stops.
 *
 *   1. The `sign_request` table has ZERO money columns, read off the live PRAGMA rather than off a
 *      list, so a migration that adds one reddens this file on the day it lands.
 *   2. The sign engine imports no posting path: no `postEntry`, no `recordPayment`, no module from
 *      `ledger/` or `payments/`. Its ONE delegation is E00's `newFileVersion` (asserted present, so
 *      the probe list is provably aimed at the real imports).
 *   3. The sign engine imports no network or transport of any kind: the transmit boundary is the
 *      injected `SignTransmitterPort`, supplied by a host, never by this module.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';

const SIGN_DIR = fileURLToPath(new URL('../../src/core/sign/', import.meta.url));

test('E01: the sign_request table carries no money column', () => {
  const store = new SqliteStore();
  const columns = store.db.prepare('PRAGMA table_info(sign_request)').all().map((c) => c.name);
  assert.ok(columns.length >= 15, 'PRAGMA answered nothing: the probe is broken');
  const money = columns.filter(
    (name) => name.includes('_rappen') || name.includes('_minor') || name.includes('amount'),
  );
  assert.deepEqual(money, [], `the sign_request table grew money columns: ${money.join(', ')}`);
});

test('E01: the sign engine reaches no posting path and no transport', () => {
  const files = readdirSync(SIGN_DIR).filter((f) => f.endsWith('.ts'));
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
    /\bfetch\s*\(/,
    /emailRelay/,
    /nodemailer/,
  ];
  for (const file of files) {
    const source = readFileSync(`${SIGN_DIR}${file}`, 'utf8');
    for (const probe of forbidden) {
      assert.equal(probe.test(source), false, `${file} matches ${probe}: the money/transport boundary is crossed`);
    }
  }
  // Non-vacuous, both ways: the probes MUST find their prey where it legitimately lives, and the
  // one delegation E01 is allowed must really be there (E00's newFileVersion, never raw bytes).
  const payments = readFileSync(fileURLToPath(new URL('../../src/core/payments/payment.ts', import.meta.url)), 'utf8');
  assert.ok(/\bpostEntry\b\s*\(/.test(payments), 'the postEntry probe cannot find postEntry even in A14');
  const engine = readFileSync(`${SIGN_DIR}signRequests.ts`, 'utf8');
  assert.ok(/\bnewFileVersion\b\s*\(/.test(engine), 'the E00 delegation is gone: who writes the signed bytes now?');
  assert.equal(
    /INSERT INTO stored_file\b/.test(engine),
    false,
    'the sign engine writes stored_file rows directly instead of delegating to E00',
  );
});
