// A11's receivable read-back is pinned to `journal_line_entry` with `INDEXED BY`, and this suite is
// what holds that in place.
//
// The store collects NO table statistics on purpose (ANALYZE is a write, and D12 puts a second
// writer on the file: see the note on `SqliteStore.close()`). Without them the planner cannot tell
// which of `entry_id` and `account_id` is the selective one, and it picks `journal_line_account`, so
// the read walks every line ever posted to the debtor account and gets slower as the book grows. The
// entry index is three rows, once.
//
// Re-measured on this branch rather than inherited. 10'000 entries / 30'000 lines, file-backed, four
// arms in ONE process on separate seeded databases, exercised in a rotating round (this machine runs
// several agents at once, so a sequential before/after measures the load as much as the change),
// 21 scored rounds of 500 calls each, median round:
//
//   as-is                                93.1 us
//   INDEXED BY journal_line_entry         2.6 us   36x
//   as-is after a full ANALYZE            7.5 us   the hint BEATS the statistics it stands in for
//
// The assertions below read the statement out of the COMPILED module rather than restating it, so
// deleting the hint from src/core/sales/invoice.ts turns this red instead of leaving a test that
// happily passes against a paraphrase of a statement nobody ships.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace, setCreditorProfile } from '../../dist/core/setup/index.js';
import { seedTaxCodes } from '../../dist/core/vat/index.js';
import { createDocument, issueInvoice } from '../../dist/core/sales/index.js';
import { recordExchangeRate } from '../../dist/core/fx/index.js';

const AT = '2026-07-16T00:00:00.000Z';

/** The statement as SHIPPED, lifted verbatim out of the compiled module that actually runs. */
function shippedReceivableSql() {
  const compiled = readFileSync(new URL('../../dist/core/sales/invoice.js', import.meta.url), 'utf8');
  const match = compiled.match(/`SELECT COALESCE\(SUM\(debit_minor\), 0\) AS txn[\s\S]*?`/);
  assert.ok(match, 'the receivable read-back must still be one template literal in dist/core/sales/invoice.js');
  const sql = match[0].slice(1, -1);
  assert.doesNotMatch(sql, /\$\{/, 'it must stay a literal statement: an interpolated one could not be planned here');
  return sql;
}

function planOf(db, sql, ...params) {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail)
    .join('\n');
}

/**
 * A ledger big enough for the read to have something to walk: 600 entries of 3 lines over 12
 * accounts, so the debtor account carries ~150 lines while any one entry carries 3. Written as raw
 * SQL, lines down while the entry is still a draft and the flip to 'posted' last, because
 * `journal_line_no_insert_posted` refuses a line under an already-posted entry. The fixture cannot
 * cheat past the trigger, which is the point of the trigger.
 */
function seedLedger(db, workspaceId = 'ws_1') {
  db.prepare('INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES (?, ?, ?, ?, ?)').run(
    workspaceId,
    'Acme GmbH',
    'CHF',
    '01-01',
    AT,
  );
  const insAccount = db.prepare('INSERT INTO account (id, workspace_id, number, name, type) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < 12; i++) {
    insAccount.run(`acc_${i}`, workspaceId, String(1000 + i * 10), `Konto ${i}`, i % 2 === 0 ? 'expense' : 'asset');
  }
  const insEntry = db.prepare(
    `INSERT INTO journal_entry (id, workspace_id, date, ref, description, status, source, created_at)
     VALUES (?, ?, '2026-03-01', ?, ?, 'draft', 'manual', ?)`,
  );
  const insLine = db.prepare(
    `INSERT INTO journal_line (id, entry_id, account_id, debit_minor, credit_minor, currency, base_debit_minor, base_credit_minor)
     VALUES (?, ?, ?, ?, ?, 'CHF', ?, ?)`,
  );
  const flip = db.prepare("UPDATE journal_entry SET status = 'posted' WHERE id = ?");
  const entryIds = [];
  for (let e = 0; e < 600; e++) {
    const id = `ent_${String(e).padStart(4, '0')}`;
    entryIds.push(id);
    insEntry.run(id, workspaceId, `B-${e}`, `Buchung ${e}`, AT);
    insLine.run(`lin_${id}_0`, id, `acc_${e % 12}`, 3000, 0, 3000, 0);
    insLine.run(`lin_${id}_1`, id, `acc_${(e + 1) % 12}`, 0, 2000, 0, 2000);
    insLine.run(`lin_${id}_2`, id, `acc_${(e + 2) % 12}`, 0, 1000, 0, 1000);
    flip.run(id);
  }
  return entryIds;
}

// --- what ships ----------------------------------------------------------------------------------

test('the receivable read-back SHIPS with INDEXED BY journal_line_entry, in the compiled module', () => {
  const sql = shippedReceivableSql();
  assert.match(
    sql,
    /FROM journal_line INDEXED BY journal_line_entry\s+WHERE entry_id = \? AND account_id = \?/,
    `the shipped statement lost its index lever:\n${sql}`,
  );
});

// --- what the planner does with it ----------------------------------------------------------------

test('the shipped statement SEARCHes journal_line_entry, and the same statement without the lever does not', () => {
  const store = new SqliteStore();
  const entryIds = seedLedger(store.db);
  const db = store.db;
  const shipped = shippedReceivableSql();
  const unhinted = shipped.replace(' INDEXED BY journal_line_entry', '');
  assert.notEqual(unhinted, shipped, 'the de-hinted arm must actually differ, or the comparison proves nothing');

  const shippedPlan = planOf(db, shipped, entryIds[3], 'acc_3');
  assert.match(shippedPlan, /SEARCH journal_line USING INDEX journal_line_entry \(entry_id=\?\)/, shippedPlan);
  assert.doesNotMatch(shippedPlan, /journal_line_account/, `the lever must WIN, not merely be present:\n${shippedPlan}`);

  // The premise, asserted rather than assumed: without the lever this really does land on the wrong
  // index. A lever that changed nothing would be cargo, and this is the assertion that would say so.
  const unhintedPlan = planOf(db, unhinted, entryIds[3], 'acc_3');
  assert.match(
    unhintedPlan,
    /SEARCH journal_line USING INDEX journal_line_account \(account_id=\?\)/,
    `with no statistics the bare statement is supposed to pick the ACCOUNT index:\n${unhintedPlan}`,
  );
  store.close();
});

test('the lever changes the PLAN and not the ANSWER: three plan-distinct arms agree to the Rappen', () => {
  const store = new SqliteStore();
  const entryIds = seedLedger(store.db);
  const db = store.db;
  const shipped = shippedReceivableSql();
  const unhinted = shipped.replace(' INDEXED BY journal_line_entry', '');
  // `NOT INDEXED` is the only form that produces a real scan. `+entry_id` would not: SQLite still
  // reads `+account_id = ?` as usable and simply moves to the other index, so a control arm built
  // that way would silently be comparing an index against an index.
  const scanned = shipped.replace('FROM journal_line INDEXED BY journal_line_entry', 'FROM journal_line NOT INDEXED');
  assert.match(planOf(db, scanned, entryIds[3], 'acc_3'), /SCAN journal_line/, 'the control arm must genuinely SCAN');

  for (const entryId of [entryIds[0], entryIds[7], entryIds[42], entryIds[599]]) {
    for (const account of ['acc_0', 'acc_3', 'acc_11']) {
      const viaLever = db.prepare(shipped).get(entryId, account);
      assert.deepEqual(db.prepare(unhinted).get(entryId, account), viaLever, `${entryId}/${account}`);
      assert.deepEqual(db.prepare(scanned).get(entryId, account), viaLever, `${entryId}/${account}`);
    }
  }
  // And the fixture must actually put money there, or every arm above agreed on zero.
  assert.equal(db.prepare(shipped).get(entryIds[42], 'acc_6').txn, 3000);
  store.close();
});

test('INDEXED BY is a HARD constraint: without journal_line_entry the statement refuses to prepare', () => {
  const store = new SqliteStore();
  const db = store.db;
  const shipped = shippedReceivableSql();
  // The index the lever names really is there to begin with (the index SET itself is pinned by an
  // exact-match assertion in test/core/journal-line-indexes.test.mjs, which is what makes leaning on
  // it safe).
  assert.ok(
    db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'index' AND name = 'journal_line_entry'").get().c === 1,
  );
  db.prepare(shipped); // prepares fine while the index exists

  db.exec('DROP INDEX journal_line_entry');
  assert.throws(
    () => db.prepare(shipped),
    /no such index: journal_line_entry/,
    'a dropped index must break this LOUDLY at prepare time, not degrade quietly at run time',
  );
  store.close();
});

// --- and the money is untouched -------------------------------------------------------------------

function invoiceSetup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const workspaceId = createWorkspace({ store, clock, ids }, { name: 'Nomadik GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  seedTaxCodes(ctx);
  store.db.prepare("UPDATE workspace SET vat_method = 'effektiv', vat_accounting = 'soll' WHERE id = ?").run(workspaceId);
  setCreditorProfile(ctx, {
    creditorName: 'Nomadik GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
  store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, address_street, address_house_no, address_zip, address_city, address_country, email, default_currency, payment_terms_days, created_at)
       VALUES ('ct_1', ?, 'customer', 'Muster AG', 'Musterstrasse', '5', '3000', 'Bern', 'CH', 'billing@muster.example', 'CHF', 30, ?)`,
    )
    .run(workspaceId, AT);
  return { ctx, store, workspaceId };
}

test('a CHF invoice issues on exactly the same figures the read-back fed before the lever', () => {
  const { ctx, store } = invoiceSetup();
  const doc = createDocument(ctx, {
    type: 'invoice',
    contactId: 'ct_1',
    currency: 'CHF',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
  });
  assert.ok(doc.ok, JSON.stringify(doc));
  const issued = issueInvoice(ctx, { invoiceId: doc.document.id, idempotencyKey: 'k-chf' });
  assert.ok(issued.ok, JSON.stringify(issued));

  // The read-back's own numbers, asked the way the shipped statement asks them, off the rows A02
  // posted: CHF 1'000.00 net + 81.00 VAT on 1100 Debitoren.
  const row = store.db
    .prepare(shippedReceivableSql())
    .get(
      issued.document.postedEntryId,
      store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ctx.workspaceId, '1100').id,
    );
  assert.equal(row.txn, 108100, "CHF 1'081.00 receivable, in Rappen");
  assert.equal(row.base, 108100, 'base currency IS the transaction currency here');
  assert.equal(issued.document.totalMinor, 108100, 'and the document agrees with the books');
  store.close();
});

test('a EUR invoice reports the base figure the lever read back: CHF 1017.44 on EUR 1081.00 at 0.9412', () => {
  const { ctx, store } = invoiceSetup();
  assert.ok(
    recordExchangeRate(ctx, {
      baseCurrency: 'EUR',
      rate: '0.9412',
      asOf: '2026-07-16',
      source: 'manual',
      method: 'daily',
      provenance: 'ESTV Tageskurs Verkauf (MWSTV Art. 45 Abs. 3)',
      idempotencyKey: 'fx-2026-07-16',
    }).ok,
  );
  const doc = createDocument(ctx, {
    type: 'invoice',
    contactId: 'ct_1',
    currency: 'EUR',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
  });
  assert.ok(doc.ok, JSON.stringify(doc));
  const issued = issueInvoice(ctx, { invoiceId: doc.document.id, idempotencyKey: 'k-eur' });
  assert.ok(issued.ok, JSON.stringify(issued));

  // The base figure a Swiss set of books is actually kept in, read back through the SHIPPED
  // statement, and cross-checked against the document read model that derives it independently. If
  // the lever had changed what the statement reads, these are the numbers that would move.
  const row = store.db
    .prepare(shippedReceivableSql())
    .get(
      issued.document.postedEntryId,
      store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ctx.workspaceId, '1100').id,
    );
  assert.equal(row.txn, 108100, "EUR 1'081.00 billed");
  assert.equal(row.base, 101744, "CHF 1'017.44 booked (1081.00 * 0.9412)");
  assert.equal(issued.document.totalMinor, 108100);
  assert.equal(issued.document.totalBaseMinor, 101744, 'the read model derives the same base total from the same rows');
  assert.equal(issued.document.baseCurrency, 'CHF');
  store.close();
});
