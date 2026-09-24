/**
 * E04's structural ABSENCES, asserted rather than documented (spec §4 "Money correctness", §7,
 * §8 "Compliance fixture"):
 *
 *   1. INDEX, NEVER COPY: none of the four mail tables carries a body/excerpt/raw column, read
 *      off the live PRAGMA so a migration that adds one reddens this file the day it lands.
 *   2. NO CREDENTIAL: `mail_account` has no password/token/secret column. The schema is the
 *      assertion of the OP6 claim, not the documentation of it.
 *   3. NO MONEY: zero `_rappen`/`_minor`/`amount` columns anywhere in the cluster, and the mail
 *      engine imports no posting path (`postEntry`, `recordPayment`, `ledger/`, `payments/`).
 *   4. NO SOCKET, STATICALLY: the mail engine imports no `net`/`tls`/`http(s)`/`dgram`/`dns`
 *      module and calls no `fetch`. (The RUNTIME half of the same claim is the egress probe that
 *      wraps `mailstore.test.mjs`.)
 *   5. NO SEND: no send verb exists in the mail engine and no SMTP client is imported. P8 holds
 *      by construction because there is no code path that transmits (US-E04.4).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { MAIL_TABLES } from '../../dist/core/mail/schema.js';

const MAIL_DIR = fileURLToPath(new URL('../../src/core/mail/', import.meta.url));

test('E04: all four mail tables exist and none carries a body, credential, or money column', () => {
  const store = new SqliteStore();
  assert.deepEqual([...MAIL_TABLES].sort(), ['mail_account', 'mail_draft', 'mail_message', 'mail_thread']);
  for (const table of MAIL_TABLES) {
    const columns = store.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    assert.ok(columns.length >= 5, `PRAGMA answered nothing for ${table}: the probe is broken`);
    const bodies = columns.filter((name) => /body|excerpt|raw|content|text/.test(name) && name !== 'body_sha256');
    assert.deepEqual(bodies, [], `${table} grew a body-shaped column: ${bodies.join(', ')} (OP6 index-never-copy)`);
    const money = columns.filter((name) => name.includes('_rappen') || name.includes('_minor') || name.includes('amount'));
    assert.deepEqual(money, [], `${table} grew money columns: ${money.join(', ')}`);
    // `thread_key` is a threading fact, not a secret, so the probe names secret SHAPES only.
    const secrets = columns.filter((name) => /credential|password|token|secret|oauth|api_key|auth/.test(name));
    assert.deepEqual(secrets, [], `${table} grew a credential column: ${secrets.join(', ')}`);
  }
  // Non-vacuous: the body probe must find a body column where one legitimately lives.
  const activity = store.db.prepare('PRAGMA table_info(contact_activity)').all().map((c) => c.name);
  assert.ok(activity.includes('body'), 'the body probe cannot see contact_activity.body: it is aimed wrong');
});

test('E04: the mail engine reaches no posting path, no transport, and exports no send verb', () => {
  const files = readdirSync(MAIL_DIR).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 4, `only ${files.length} engine files found: the probe is aimed wrong`);
  const forbidden = [
    /from '.*ledger\//,
    /from '.*payments\//,
    /\bpostEntry\b\s*\(/,
    /\brecordPayment\b\s*\(/,
    /from 'node:http'/,
    /from 'node:https'/,
    /from 'node:net'/,
    /from 'node:tls'/,
    /from 'node:dgram'/,
    /from 'node:dns'/,
    /\bfetch\s*\(/,
    /emailRelay/,
    // Import-specifier form, not a bare substring: a docblock SAYING "no SMTP" must not trip the
    // probe that enforces it (the E03 suite's own lesson).
    /from '.*nodemailer/,
    /from '.*smtp/i,
    /require\(.*smtp/i,
  ];
  for (const file of files) {
    const source = readFileSync(`${MAIL_DIR}${file}`, 'utf8');
    for (const probe of forbidden) {
      assert.equal(probe.test(source), false, `${file} matches ${probe}: the OP6/money boundary is crossed`);
    }
    // The no-send assertion (spec §7): drafts are written, nothing is ever transmitted, and no
    // exported symbol may even be NAMED like a send so a later "helpful" verb cannot slide in.
    for (const match of source.matchAll(/export (?:function|const) (\w+)/g)) {
      assert.equal(/send/i.test(match[1] ?? ''), false, `${file} exports a send-shaped symbol: ${match[1]}`);
    }
  }
  // Non-vacuous: the same probes find their prey where it legitimately lives.
  const payments = readFileSync(fileURLToPath(new URL('../../src/core/payments/payment.ts', import.meta.url)), 'utf8');
  assert.ok(/\bpostEntry\b\s*\(/.test(payments), 'the postEntry probe cannot find postEntry even in A14');
});
