/**
 * E07's structural ABSENCES, asserted rather than documented (spec §4, §6b, §7):
 *
 *   1. NO TABLE: E07 owns no table (a stored trust indicator can report STALE state). The engine
 *      registers no schema, so a fresh store has no `egress` table.
 *   2. NO MONEY PATH (P3 by absence): the egress engine imports no posting path (`postEntry`,
 *      `recordPayment`, `ledger/`, `payments/`) and carries no money.
 *   3. NO OP3 ENTITY KIND: there is no `egress` entity kind, so no custom field can attach to the
 *      probe or the indicator (spec §6b: a custom field on a trust indicator is a new place for a
 *      socket, or a misleading claim, to hide).
 *   4. NO AUTOMATION SURFACE: neither verb emits an automation event (both are reads, and an
 *      automation that fired on `egress.violated` and suppressed the indicator would defeat the one
 *      property this spec exists to prove).
 *
 * UNLIKE E06, THIS MODULE DELIBERATELY IMPORTS THE SOCKET SURFACE: `probe.ts` wraps `net`/`dgram`/
 * `dns`/`tls`/`http(s)`/`child_process` precisely so it can refuse them. So the "no net import" guard
 * that E06 carries is INVERTED here, and named as such, rather than absent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { ENTITY_KINDS } from '../../dist/core/customization/entities.js';
import { eventsEmittedBy } from '../../dist/core/automation/events.js';
import * as egress from '../../dist/core/egress/index.js';

const EGRESS_DIR = fileURLToPath(new URL('../../src/core/egress/', import.meta.url));

test('E07: the engine owns NO table (state is observed, never stored)', () => {
  const store = new SqliteStore();
  const egressTables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'egress%'")
    .all()
    .map((r) => r.name);
  assert.deepEqual(egressTables, [], 'E07 grew a table; a stored trust indicator can report stale state (spec §4)');
  // And the barrel exports no schema constant to register one.
  assert.equal(egress.EGRESS_SCHEMA_SQL, undefined, 'E07 must ship no schema');
  assert.equal(egress.EGRESS_TABLES, undefined, 'E07 must ship no table list');
});

test('E07: the egress engine reaches no posting path and carries no money', () => {
  const files = readdirSync(EGRESS_DIR).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 4, `only ${files.length} engine files found: the probe is aimed wrong`);
  const forbidden = [
    /from '.*ledger\//,
    /from '.*payments\//,
    /\bpostEntry\b/,
    /\brecordPayment\b/,
    /_rappen|_minor/,
  ];
  for (const file of files) {
    const src = readFileSync(new URL(file, `file://${EGRESS_DIR}`), 'utf8');
    // Strip line comments so the prose in a module header ("no postEntry, no recordPayment") does not
    // trip a guard that is about CODE.
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(code), `${file} reaches the money path (${pattern}); E07 posts nothing (P3 by absence)`);
    }
  }
});

test('E07: the socket surface IS imported (the guard is inverted here, not absent)', () => {
  const probe = readFileSync(new URL('probe.ts', `file://${EGRESS_DIR}`), 'utf8');
  // The one module in the product that must import the socket surface, because wrapping it is the job.
  for (const mod of ["node:net", "node:dgram", "node:dns", "node:tls", "node:http", "node:https", "node:child_process"]) {
    assert.ok(probe.includes(mod), `probe.ts must wrap ${mod}, which is exactly what makes the proof cover it`);
  }
});

test('E07: there is no egress entity kind, so no custom field can attach to the probe or indicator', () => {
  const ids = ENTITY_KINDS.map((k) => (typeof k === 'string' ? k : k.kind));
  assert.ok(!ids.includes('egress'), 'an egress entity kind would be a new place for a socket or a claim to hide (spec §6b)');
});

test('E07: neither verb emits an automation event (the automation surface is empty)', () => {
  assert.deepEqual(eventsEmittedBy('egress_self_test'), [], 'egress_self_test must emit no event');
  assert.deepEqual(eventsEmittedBy('egress_status'), [], 'egress_status must emit no event');
});
