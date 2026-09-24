// M-3: the A11 columns are ADDITIVE on an existing database. `CREATE TABLE IF NOT EXISTS` never
// alters an existing table, so a pre-A11 `~/.till/till.db` reopened with A11 lacked
// `workspace.email_relay`, `workspace.posting_auto_issue`, and `document.sent_to_email`, and
// `send_invoice` threw a raw `no such column`. Opening the store now applies an idempotent
// ALTER TABLE migration; this suite builds a REAL pre-A11 file and reopens it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { SCHEMA_SQL } from '../../dist/core/store/schema.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace, setCreditorProfile } from '../../dist/core/setup/index.js';
import { seedTaxCodes } from '../../dist/core/vat/index.js';
import { seedChartOfAccounts } from '../../dist/core/accounts/index.js';
import { createDocument, issueInvoice, sendInvoice, buildQrBill } from '../../dist/core/sales/index.js';
import { recordExchangeRate } from '../../dist/core/fx/index.js';

const AT = '2026-07-16T00:00:00.000Z';

/** The pre-A11 shapes of the two tables A11 later widened (verbatim minus the A11 columns). */
const PRE_A11_TABLES = `
CREATE TABLE workspace (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  legal_form        TEXT,
  base_currency     TEXT NOT NULL DEFAULT 'CHF',
  fiscal_year_start TEXT NOT NULL DEFAULT '01-01',
  vat_method        TEXT,
  vat_accounting    TEXT,
  vat_registered    INTEGER NOT NULL DEFAULT 0,
  creditor_name     TEXT,
  creditor_address  TEXT,
  qr_iban           TEXT,
  uid               TEXT,
  mwst_no           TEXT,
  created_at        TEXT NOT NULL,
  is_demo           INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE document (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspace(id),
  type               TEXT NOT NULL,
  number             TEXT,
  status             TEXT NOT NULL,
  contact_id         TEXT REFERENCES contact(id),
  currency           TEXT NOT NULL DEFAULT 'CHF',
  source_document_id TEXT REFERENCES document(id),
  posted_entry_id    TEXT REFERENCES journal_entry(id),
  subtotal_minor     INTEGER NOT NULL DEFAULT 0,
  tax_minor          INTEGER NOT NULL DEFAULT 0,
  total_minor        INTEGER NOT NULL DEFAULT 0,
  issue_date         TEXT,
  due_date           TEXT,
  notes              TEXT,
  created_at         TEXT NOT NULL
);
`;

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

test('M-3: reopening a pre-A11 database gains the new columns (idempotently) and send_invoice works', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-migration-'));
  const dbPath = join(dir, 'till.db');
  try {
    // 1. Build the OLD database: the two tables exist WITHOUT the A11 columns.
    const old = new Database(dbPath);
    old.exec(PRE_A11_TABLES);
    old.close();

    // 2. Reopen with the current store: the migration must ADD the columns, not throw.
    const clock = fixedClock(AT);
    const store = new SqliteStore({ location: dbPath, clock });
    try {
      assert.ok(columns(store.db, 'workspace').includes('email_relay'), 'workspace.email_relay added');
      assert.ok(columns(store.db, 'workspace').includes('posting_auto_issue'), 'workspace.posting_auto_issue added');
      assert.ok(columns(store.db, 'document').includes('sent_to_email'), 'document.sent_to_email added');

      // 3. The migrated database RUNS the A11 send path end to end (no raw `no such column`).
      const ids = sequenceIdGen();
      const deps = { store, clock, ids };
      const workspaceId = createWorkspace(deps, { name: 'Alt AG' }).workspaceId;
      const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
      seedTaxCodes(ctx);
      setCreditorProfile(ctx, {
        creditorName: 'Alt AG',
        address: { street: 'Altweg', buildingNo: '2', zip: '4000', town: 'Basel', country: 'CH' },
        qrIban: 'CH4431999123000889012',
      });
      store.db
        .prepare(
          `INSERT INTO contact (id, workspace_id, party_role, name, address_street, address_house_no, address_zip, address_city, address_country, email, default_currency, payment_terms_days, created_at)
           VALUES ('ct_1', ?, 'customer', 'Muster AG', 'Weg', '1', '3000', 'Bern', 'CH', 'kunde@muster.example', 'CHF', 30, ?)`,
        )
        .run(workspaceId, AT);
      const created = createDocument(ctx, {
        type: 'invoice',
        contactId: 'ct_1',
        lines: [{ description: 'Beratung', unitPriceMinor: 10000, taxCode: 'UST81' }],
      });
      assert.ok(created.ok, JSON.stringify(created));
      const issued = issueInvoice(ctx, { invoiceId: created.document.id, idempotencyKey: 'k-mig' });
      assert.ok(issued.ok, JSON.stringify(issued));
      ctx.emailRelay = { send: () => ({ ok: true }) };
      const sent = sendInvoice(ctx, { invoiceId: created.document.id, idempotencyKey: 'k-mig-send', confirmed: true });
      assert.ok(sent.ok, `send_invoice on the migrated DB: ${JSON.stringify(sent)}`);
      assert.equal(sent.transmitted, true);
      store.close();

      // 4. Idempotent: a SECOND open of the (now migrated) file must not throw on re-adding.
      const again = new SqliteStore({ location: dbPath, clock });
      assert.ok(columns(again.db, 'workspace').includes('posting_auto_issue'));
      again.close();
    } finally {
      if (store.db.open) store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- M-3, §H-FX: the exchange_rate TABLE on a real pre-FX database --------------------------------
//
// The A11 columns above are the ADDITIVE COLUMN case. A new TABLE is the other half of the same
// promise, and it is carried by `CREATE TABLE IF NOT EXISTS` in SCHEMA_SQL, which runs on every open.
// That makes the migration idempotent by construction, but "by construction" is a claim, so this
// suite proves it the same way: it builds a REAL pre-FX file, reopens it, and drives the whole
// multi-currency path end to end on the migrated database.
//
// The pre-FX schema is DERIVED from the shipped one by removing the exchange_rate DDL, rather than
// hand-copied. A hand-copied fixture drifts silently; a derived one cannot claim to be the old
// schema and be wrong about the rest of it.
const PRE_FX_SCHEMA = SCHEMA_SQL.replace(/CREATE TABLE IF NOT EXISTS exchange_rate \([\s\S]*?\);/, '').replace(
  /CREATE INDEX IF NOT EXISTS exchange_rate_resolution[\s\S]*?;/,
  '',
);

test('M-3 (§H-FX): a pre-FX database gains exchange_rate on open, idempotently, and posts in EUR', () => {
  assert.equal(
    /CREATE TABLE IF NOT EXISTS exchange_rate/.test(PRE_FX_SCHEMA),
    false,
    'the derived pre-FX schema really is missing the table (a fixture that still has it proves nothing)',
  );

  const dir = mkdtempSync(join(tmpdir(), 'till-fx-migration-'));
  const dbPath = join(dir, 'till.db');
  try {
    // 1. A REAL older database: everything the engine shipped before §H-FX, and no rate store.
    const old = new Database(dbPath);
    old.exec(PRE_FX_SCHEMA);
    const oldTables = old
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);
    assert.equal(oldTables.includes('exchange_rate'), false, 'the old file genuinely has no rate store');
    assert.ok(oldTables.includes('journal_line'), 'and it is otherwise a real TILL database');
    old.close();

    // 2. Reopening under the current engine ADDS the table rather than throwing.
    const clock = fixedClock(AT);
    const store = new SqliteStore({ location: dbPath, clock });
    try {
      const tables = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name);
      assert.ok(tables.includes('exchange_rate'), 'exchange_rate added on open');

      // 3. The migrated database runs the WHOLE multi-currency path: record a rate, issue a EUR
      //    invoice, and confirm the books hold CHF. No raw `no such table`, no half-built state.
      const ids = sequenceIdGen();
      const deps = { store, clock, ids };
      const workspaceId = createWorkspace(deps, { name: 'Alt AG' }).workspaceId;
      const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
      seedTaxCodes(ctx);
      setCreditorProfile(ctx, {
        creditorName: 'Alt AG',
        address: { street: 'Altweg', buildingNo: '2', zip: '4000', town: 'Basel', country: 'CH' },
        qrIban: 'CH4431999123000889012',
      });
      store.db
        .prepare(
          `INSERT INTO contact (id, workspace_id, party_role, name, address_street, address_house_no, address_zip, address_city, address_country, email, default_currency, payment_terms_days, created_at)
           VALUES ('ct_fx', ?, 'customer', 'Muster AG', 'Weg', '1', '3000', 'Bern', 'CH', 'kunde@muster.example', 'EUR', 30, ?)`,
        )
        .run(workspaceId, AT);

      const rate = recordExchangeRate(ctx, {
        baseCurrency: 'EUR',
        rate: '0.9412',
        asOf: '2026-07-16',
        source: 'manual',
        method: 'daily',
        provenance: 'ESTV Tageskurs Verkauf (MWSTV Art. 45 Abs. 3)',
        idempotencyKey: 'mig-rate',
      });
      assert.ok(rate.ok, `record_exchange_rate on the migrated DB: ${JSON.stringify(rate)}`);

      const created = createDocument(ctx, {
        type: 'invoice',
        contactId: 'ct_fx',
        currency: 'EUR',
        lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
      });
      assert.ok(created.ok, JSON.stringify(created));
      const issued = issueInvoice(ctx, { invoiceId: created.document.id, idempotencyKey: 'mig-eur' });
      assert.ok(issued.ok, `issue_invoice in EUR on the migrated DB: ${JSON.stringify(issued)}`);

      const posted = store.db
        .prepare('SELECT posted_entry_id FROM document WHERE id = ?')
        .get(created.document.id).posted_entry_id;
      const lines = store.db.prepare('SELECT * FROM journal_line WHERE entry_id = ?').all(posted);
      assert.equal(
        lines.reduce((sum, l) => sum + l.base_debit_minor, 0),
        101744,
        "CHF 1'017.44 in the books on a database that started life without a rate store",
      );
      assert.ok(lines.every((l) => l.currency === 'EUR' && l.fx_rate === '0.9412'), '§H-FX trace on every row');
      store.close();

      // 4. Idempotent: a SECOND open of the migrated file changes nothing and throws nothing.
      const again = new SqliteStore({ location: dbPath, clock });
      assert.equal(again.db.prepare('SELECT COUNT(*) AS n FROM exchange_rate').get().n, 1, 'the rate survived');
      again.close();

      // 5. An OLDER engine can still reopen the file. That is what an older engine does on open:
      //    it applies its own schema, which knows nothing about exchange_rate. A new TABLE is
      //    invisible to it, so this must be a clean no-op rather than a conflict.
      const older = new Database(dbPath);
      older.exec(PRE_FX_SCHEMA);
      const stillThere = older.prepare('SELECT COUNT(*) AS n FROM journal_line').get().n;
      assert.ok(stillThere > 0, 'the older engine reads the books it wrote');
      older
        .prepare(
          `INSERT INTO journal_entry (id, workspace_id, date, description, status, source, created_at)
           VALUES ('je_old', ?, '2026-07-17', 'gebucht von der alten Version', 'draft', 'manual', ?)`,
        )
        .run(workspaceId, AT);
      assert.equal(older.prepare("SELECT status FROM journal_entry WHERE id = 'je_old'").get().status, 'draft');
      older.close();
    } finally {
      if (store.db.open) store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- M-3, the creditor-IBAN rename: the RENAME case ----------------------------------------------
//
// `workspace.qr_iban` was named when it could hold only a QR-IBAN, because `setCreditorProfile`
// refused anything else. M-2 fixed that: the column accepts any valid IBAN and `buildQrBill` derives
// the reference type from it (QRR from a QR-IBAN, SCOR from a plain one). The name outlived the
// meaning and started misleading readers, so the column is now `creditor_iban`, next to
// `creditor_name` and `creditor_address`.
//
// A rename is neither of the two cases above. `ADDITIVE_COLUMNS` gives an old file the new column but
// leaves it NULL, and a new TABLE is invisible to old data. The value has to be CARRIED, and carried
// in a way that survives a replay: the store re-runs every migration above the file's generation, and
// a crash mid-run leaves the old generation, so the same migration must be able to run twice.
//
// The old schema is DERIVED from the shipped one by renaming the column back, not hand-copied, for
// the same reason PRE_FX_SCHEMA is: a hand-copied fixture claims to be the old schema and drifts.
const PRE_RENAME_SCHEMA = SCHEMA_SQL.replace(/\bcreditor_iban\b/g, 'qr_iban');

/** The QR-IID 31999 sits inside the reserved 30000-31999 range, so this is a real QR-IBAN. */
const OLD_QR_IBAN = 'CH4431999123000889012';

function insertOldWorkspace(db, id, iban) {
  db.prepare(
    `INSERT INTO workspace (id, name, base_currency, fiscal_year_start, vat_method, vat_accounting,
                            creditor_name, creditor_address, qr_iban, created_at)
     VALUES (?, 'Alt AG', 'CHF', '01-01', 'effektiv', 'soll', 'Alt AG', ?, ?, ?)`,
  ).run(id, JSON.stringify({ street: 'Altweg', buildingNo: '2', zip: '4000', town: 'Basel', country: 'CH' }), iban, AT);
}

test('M-3 (rename): a database written under workspace.qr_iban keeps its creditor IBAN, under the new name', () => {
  assert.equal(
    /\bcreditor_iban\b/.test(SCHEMA_SQL),
    true,
    'the shipped schema does not carry the new column name, so the derivation below rewrites nothing and the fixture is not an OLD schema at all',
  );
  assert.equal(/\bqr_iban\b/.test(PRE_RENAME_SCHEMA), true, 'the derived old schema really carries the OLD name');
  assert.equal(/creditor_iban/.test(PRE_RENAME_SCHEMA), false, 'and really does not carry the new one');

  const dir = mkdtempSync(join(tmpdir(), 'till-iban-rename-'));
  const dbPath = join(dir, 'till.db');
  try {
    // 1. A REAL old database, with a creditor IBAN already stored under the old column name.
    const old = new Database(dbPath);
    old.exec(PRE_RENAME_SCHEMA);
    insertOldWorkspace(old, 'ws_old', OLD_QR_IBAN);
    assert.equal(old.prepare('SELECT qr_iban FROM workspace WHERE id = ?').get('ws_old').qr_iban, OLD_QR_IBAN);
    old.close();

    // 2. Reopening under the current engine carries the value across. Asserted on the ROW, because a
    //    verb returning the right string proves nothing about what is on disk.
    const clock = fixedClock(AT);
    const store = new SqliteStore({ location: dbPath, clock });
    try {
      const cols = columns(store.db, 'workspace');
      assert.ok(cols.includes('creditor_iban'), 'the new column exists on the migrated file');
      assert.equal(
        store.db.prepare('SELECT creditor_iban FROM workspace WHERE id = ?').get('ws_old').creditor_iban,
        OLD_QR_IBAN,
        'the stored creditor IBAN survived the rename: losing it would silently unbill the workspace',
      );
      assert.equal(
        cols.includes('qr_iban'),
        false,
        'the old column is retired, not left behind: two creditor IBANs on one row is a wrong-bank-account bug waiting for the next edit',
      );

      // 3. The migrated value is not merely present, it still ROUTES: a QR-IBAN must still derive QRR.
      const ids = sequenceIdGen();
      const ctx = makeContext(store, { workspaceId: 'ws_old', actor: 'user_1', clock, ids });
      seedChartOfAccounts(ctx);
      seedTaxCodes(ctx);
      store.db
        .prepare(
          `INSERT INTO contact (id, workspace_id, party_role, name, address_street, address_house_no, address_zip, address_city, address_country, email, default_currency, payment_terms_days, created_at)
           VALUES ('ct_ren', 'ws_old', 'customer', 'Muster AG', 'Weg', '1', '3000', 'Bern', 'CH', 'kunde@muster.example', 'CHF', 30, ?)`,
        )
        .run(AT);
      const created = createDocument(ctx, {
        type: 'invoice',
        contactId: 'ct_ren',
        lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
      });
      assert.ok(created.ok, JSON.stringify(created));
      const issued = issueInvoice(ctx, { invoiceId: created.document.id, idempotencyKey: 'k-ren' });
      assert.ok(issued.ok, JSON.stringify(issued));
      const qr = buildQrBill(ctx, created.document.id);
      assert.ok(qr.ok, `the migrated IBAN must still build a QR-bill: ${JSON.stringify(qr)}`);
      // Asserted on the ENCODED payment part, not on an echoed input: the IG puts the IBAN in
      // element 4 (QRType, Version, Coding, IBAN), so this is the string a payer's bank would read.
      assert.equal(
        qr.qr.swissQrPayload.split('\r\n')[3],
        OLD_QR_IBAN,
        'the migrated IBAN is the one that reaches the payment part',
      );
      assert.equal(qr.qr.referenceType, 'QRR', 'a QR-IBAN still derives QRR: the rename changed no behaviour');
      store.close();
    } finally {
      if (store.db.open) store.close();
    }

    // 4. REPLAY. The migrations run inside one transaction with the version bump, so a crash leaves
    //    the OLD generation and the next open re-runs everything. Forcing the generation back to 0
    //    is exactly that crash, and the migration must be a no-op rather than a throw or a wipe.
    const crashed = new Database(dbPath);
    crashed.pragma('user_version = 0');
    crashed.close();

    const again = new SqliteStore({ location: dbPath, clock });
    try {
      assert.equal(
        again.db.prepare('SELECT creditor_iban FROM workspace WHERE id = ?').get('ws_old').creditor_iban,
        OLD_QR_IBAN,
        'replaying the rename must not blank the IBAN it already carried',
      );
      assert.equal(columns(again.db, 'workspace').includes('qr_iban'), false, 'and must not resurrect the old column');
    } finally {
      again.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M-3 (rename): an old row with NO creditor IBAN migrates to NULL, not to a fabricated value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-iban-rename-null-'));
  const dbPath = join(dir, 'till.db');
  try {
    const old = new Database(dbPath);
    old.exec(PRE_RENAME_SCHEMA);
    insertOldWorkspace(old, 'ws_empty', null);
    old.close();

    const store = new SqliteStore({ location: dbPath, clock: fixedClock(AT) });
    try {
      assert.equal(
        store.db.prepare('SELECT creditor_iban FROM workspace WHERE id = ?').get('ws_empty').creditor_iban,
        null,
        'an unconfigured creditor stays unconfigured; needs_qr_iban is the honest answer, an empty string is not',
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M-3 (rename): setCreditorProfile writes the creditor IBAN to the column that says so', () => {
  // Asserted on the ROW. The comment this replaces used the stale column name to justify reaching
  // around the verb with raw SQL, which is how a rename goes silently wrong in a test suite.
  const clock = fixedClock(AT);
  const store = new SqliteStore({ clock });
  try {
    const ids = sequenceIdGen();
    const { workspaceId } = createWorkspace({ store, clock, ids }, { name: 'Nomadik GmbH' });
    const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
    assert.ok(
      setCreditorProfile(ctx, {
        creditorName: 'Nomadik GmbH',
        address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
        iban: OLD_QR_IBAN,
      }).ok,
    );
    assert.equal(
      store.db.prepare('SELECT creditor_iban FROM workspace WHERE id = ?').get(workspaceId).creditor_iban,
      OLD_QR_IBAN,
    );
  } finally {
    store.close();
  }
});
