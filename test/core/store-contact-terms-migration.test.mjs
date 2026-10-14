// M-3 generation 10 (D163, owner pick 04.10.2026: workspace default terms):
// `contact.payment_terms_days` becomes NULLABLE and every stored 0 becomes NULL, once.
//
// Until generation 10 the column was `NOT NULL DEFAULT 0` and `createContact` wrote 0 whenever no
// terms were given, so 0 meant both "no terms of its own" and "due immediately". D163 separates them:
// NULL takes the workspace default, 0 is due on the document date. The stored rows cannot say which a
// 0 was, the create default is overwhelmingly the common case, so the migration reads every 0 as
// "not set". A contact somebody DELIBERATELY set to 0 takes the workspace default afterwards; that is
// a stated behaviour change (D163), asserted here so it can never happen silently twice.
//
// The fixture is a REAL old-shape file on disk, derived from the shipped schema with the one column
// put back the way it was, and opened by the real store. Everything is asserted against rows and
// PRAGMAs read back out of SQLite.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { SCHEMA_SQL, SCHEMA_GENERATION } from '../../dist/core/store/schema.js';

const AT = '2026-07-16T00:00:00.000Z';

/** The `CREATE TABLE ... contact (...)` block of a schema string. */
function contactBlock(schemaSql) {
  const block = /CREATE TABLE IF NOT EXISTS contact \([\s\S]*?\n\);/.exec(schemaSql);
  assert.ok(block, 'the schema string has no contact table block at all');
  return block[0];
}

/** The schema as it stood before generation 10: the terms column NOT NULL DEFAULT 0 again. */
const PRE_D163_SCHEMA = SCHEMA_SQL.replace(/CREATE TABLE IF NOT EXISTS contact \([\s\S]*?\n\);/, (block) =>
  block.replace(/^(\s*payment_terms_days\s+INTEGER),$/m, '$1 NOT NULL DEFAULT 0,'),
);

function termsColumn(db) {
  return db.prepare('PRAGMA table_info(contact)').all().find((c) => c.name === 'payment_terms_days');
}

function contactsOnDisk(db) {
  return db.prepare('SELECT rowid AS rid, id, name, payment_terms_days AS days FROM contact ORDER BY rowid').all();
}

/**
 * A pre-generation-10 file: four contacts (the create default 0, a deliberate 30, a column that was
 * never named so the old DEFAULT filled it, a deliberate 0) and an invoice that references one of
 * them, so the foreign key into `contact` is on disk when the column is replaced.
 */
function makeOldFile() {
  const dir = mkdtempSync(join(tmpdir(), 'till-contact-terms-'));
  const file = join(dir, 'till.db');
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.exec(PRE_D163_SCHEMA);
  db.prepare('INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'ws_1',
    'Muster Grafik GmbH',
    'CHF',
    '01-01',
    AT,
  );
  const insert = db.prepare(
    `INSERT INTO contact (id, workspace_id, party_role, name, default_currency, payment_terms_days, created_at)
     VALUES (?, 'ws_1', ?, ?, 'CHF', ?, ?)`,
  );
  insert.run('ct_default', 'customer', 'Ohne Frist AG', 0, AT);
  insert.run('ct_thirty', 'customer', 'Dreissig AG', 30, AT);
  // Names no terms column at all: only the OLD default lets this row exist with a value, which proves
  // the file really is the old shape.
  db.prepare(
    `INSERT INTO contact (id, workspace_id, party_role, name, created_at) VALUES ('ct_unnamed', 'ws_1', 'vendor', 'Lieferant GmbH', ?)`,
  ).run(AT);
  insert.run('ct_zero', 'both', 'Sofort AG', 0, AT);
  db.prepare(
    `INSERT INTO document (id, workspace_id, type, status, contact_id, currency, created_at)
     VALUES ('doc_1', 'ws_1', 'invoice', 'draft', 'ct_thirty', 'CHF', ?)`,
  ).run(AT);
  db.pragma('user_version = 9');
  const before = contactsOnDisk(db);
  const column = termsColumn(db);
  db.close();
  return { dir, file, before, column };
}

test('gen 10: the fixture really is the OLD shape, and the shipped schema really is the new one', () => {
  assert.equal(
    /payment_terms_days\s+INTEGER NOT NULL DEFAULT 0/.test(contactBlock(SCHEMA_SQL)),
    false,
    'the shipped schema still forces 0 on contact.payment_terms_days',
  );
  assert.equal(
    /payment_terms_days\s+INTEGER NOT NULL DEFAULT 0/.test(contactBlock(PRE_D163_SCHEMA)),
    true,
    'the derived old schema did not get NOT NULL DEFAULT 0 back, so the fixture is not an old file',
  );
  assert.equal(
    PRE_D163_SCHEMA.replace(contactBlock(PRE_D163_SCHEMA), contactBlock(SCHEMA_SQL)),
    SCHEMA_SQL,
    'the derivation changed something outside the contact block',
  );
  assert.ok(SCHEMA_GENERATION >= 10, `SCHEMA_GENERATION is ${SCHEMA_GENERATION}: the migration will never run`);
});

test('gen 10: every 0 becomes null, every other value survives, the rows and rowids stay put', () => {
  const { dir, file, before, column } = makeOldFile();
  try {
    assert.equal(column.notnull, 1, 'the fixture column is not NOT NULL');
    assert.equal(before.find((c) => c.id === 'ct_unnamed').days, 0, 'the old default did not fill the unnamed row');

    const store = new SqliteStore({ location: file });
    try {
      assert.equal(termsColumn(store.db).notnull, 0, 'the column is still NOT NULL after the migration');
      assert.equal(store.db.pragma('user_version', { simple: true }), SCHEMA_GENERATION);
      const after = contactsOnDisk(store.db);
      assert.equal(after.length, 4);
      assert.deepEqual(
        after.map((c) => [c.rid, c.id, c.days]),
        before.map((c) => [c.rid, c.id, c.days === 0 ? null : c.days]),
        'every 0 reads as "no terms of its own" and nothing else moved',
      );
      // D163's stated behaviour change: the deliberate 0 is indistinguishable and becomes null too.
      assert.equal(after.find((c) => c.id === 'ct_zero').days, null);
      assert.equal(after.find((c) => c.id === 'ct_thirty').days, 30);
      // The reference into contact survived the column swap, and nothing dangles.
      assert.equal(store.db.prepare("SELECT contact_id FROM document WHERE id = 'doc_1'").get().contact_id, 'ct_thirty');
      assert.deepEqual(store.db.pragma('foreign_key_check'), []);
      // The workspace default column arrived by ADDITIVE_COLUMNS, unset: no default is invented.
      assert.equal(store.db.prepare("SELECT default_payment_terms_days AS d FROM workspace WHERE id = 'ws_1'").get().d, null);
      // After the migration 0 is a value a contact can hold again, distinct from null.
      store.db.prepare("UPDATE contact SET payment_terms_days = 0 WHERE id = 'ct_zero'").run();
      store.db.prepare(
        `INSERT INTO contact (id, workspace_id, party_role, name, created_at) VALUES ('ct_new', 'ws_1', 'customer', 'Neu AG', ?)`,
      ).run(AT);
      assert.equal(store.db.prepare("SELECT payment_terms_days AS d FROM contact WHERE id = 'ct_zero'").get().d, 0);
      assert.equal(store.db.prepare("SELECT payment_terms_days AS d FROM contact WHERE id = 'ct_new'").get().d, null);
    } finally {
      store.close?.();
    }

    // A second open is a no-op: the generation is already 10 and the column already nullable.
    const again = new SqliteStore({ location: file });
    try {
      assert.equal(again.db.prepare("SELECT payment_terms_days AS d FROM contact WHERE id = 'ct_zero'").get().d, 0);
      assert.equal(again.db.prepare("SELECT payment_terms_days AS d FROM contact WHERE id = 'ct_thirty'").get().d, 30);
    } finally {
      again.close?.();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gen 10: a fresh database is born nullable and the migration finds nothing to do', () => {
  const store = new SqliteStore({});
  try {
    assert.equal(termsColumn(store.db).notnull, 0);
    assert.equal(termsColumn(store.db).dflt_value, null);
  } finally {
    store.close?.();
  }
});
