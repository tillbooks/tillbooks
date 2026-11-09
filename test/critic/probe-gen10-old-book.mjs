// Critic probe (default-terms): open a REAL old-generation book written by develop 60302c09 with this
// branch's store, and compare everything about `contact` and the book before and after.
// Usage: node test/critic/probe-gen10-old-book.mjs <old.db>
import Database from 'better-sqlite3';
import { copyFileSync } from 'node:fs';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';

const src = process.argv[2];
const file = src + '.probe.db';
copyFileSync(src, file);

function facts(db) {
  return {
    gen: db.pragma('user_version', { simple: true }),
    cols: db.pragma('table_info(contact)').map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt: c.dflt_value, pk: c.pk })),
    indexes: db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='contact' ORDER BY name").all(),
    triggers: db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND (tbl_name='contact' OR sql LIKE '%contact%') ORDER BY name").all(),
    fkInto: db.prepare("SELECT m.name AS t FROM sqlite_master m WHERE m.type='table'").all()
      .flatMap((r) => db.pragma(`foreign_key_list("${r.t}")`).filter((f) => f.table === 'contact').map((f) => `${r.t}.${f.from}->${f.to}`)).sort(),
    fkOut: db.pragma('foreign_key_list(contact)').map((f) => `${f.from}->${f.table}.${f.to}`).sort(),
    rows: db.prepare('SELECT rowid AS __rid, * FROM contact ORDER BY rowid').all(),
    docs: db.prepare('SELECT id, type, status, issue_date, due_date FROM document ORDER BY rowid').all(),
    bills: db.prepare('SELECT id, bill_date, due_date FROM vendor_bill ORDER BY rowid').all(),
    tableCount: db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n,
    objects: db.prepare("SELECT type, name FROM sqlite_master ORDER BY type, name").all().map((o) => `${o.type}:${o.name}`),
  };
}

const old = new Database(file, { readonly: true });
const before = facts(old);
old.close();

const store = new SqliteStore({ location: file });
const after = facts(store.db);
const problems = [];
const say = (m) => problems.push(m);
if (after.gen !== 10) say(`generation ${after.gen}`);
const termsBefore = before.cols.find((c) => c.name === 'payment_terms_days');
const termsAfter = after.cols.find((c) => c.name === 'payment_terms_days');
console.log('terms col before', termsBefore, 'after', termsAfter);
console.log('column order before', before.cols.map((c) => c.name).join(','));
console.log('column order after ', after.cols.map((c) => c.name).join(','));
const strip = (cols) => cols.filter((c) => c.name !== 'payment_terms_days');
if (JSON.stringify(strip(before.cols)) !== JSON.stringify(strip(after.cols))) say('other column definitions changed');
if (JSON.stringify(before.indexes) !== JSON.stringify(after.indexes)) say('contact indexes changed: ' + JSON.stringify({ b: before.indexes, a: after.indexes }));
if (JSON.stringify(before.triggers) !== JSON.stringify(after.triggers)) say('triggers mentioning contact changed');
if (JSON.stringify(before.fkInto) !== JSON.stringify(after.fkInto)) say('FKs into contact changed');
if (JSON.stringify(before.fkOut) !== JSON.stringify(after.fkOut)) say('FKs out of contact changed');
const extraObjects = after.objects.filter((o) => !before.objects.includes(o));
const lostObjects = before.objects.filter((o) => !after.objects.includes(o));
console.log('schema objects lost', lostObjects, 'gained', extraObjects);
if (before.rows.length !== after.rows.length) say('row count changed');
let zeroToNull = 0, kept = 0;
for (const [i, b] of before.rows.entries()) {
  const a = after.rows[i];
  for (const k of Object.keys(b)) {
    if (k === 'payment_terms_days') {
      const exp = b[k] === 0 ? null : b[k];
      if (a[k] !== exp) say(`contact ${b.id} terms ${b[k]} -> ${a[k]}`);
      if (b[k] === 0) zeroToNull++; else kept++;
    } else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) say(`contact ${b.id} column ${k} changed ${b[k]} -> ${a[k]}`);
  }
}
console.log(`contacts ${before.rows.length}: ${zeroToNull} zero->null, ${kept} kept`);
if (JSON.stringify(before.docs) !== JSON.stringify(after.docs)) say('document due/issue dates changed on open');
if (JSON.stringify(before.bills) !== JSON.stringify(after.bills)) say('vendor bill due dates changed on open');
console.log('invoices with null due_date (untouched):', after.docs.filter((d) => d.type === 'invoice' && d.due_date === null).length);
const ic = store.db.pragma('integrity_check', { simple: true });
if (ic !== 'ok') say('integrity_check ' + ic);
const fkc = store.db.pragma('foreign_key_check');
if (fkc.length) say('foreign_key_check ' + JSON.stringify(fkc.slice(0, 5)));
store.close?.();
// Reopen: idempotent
const again = new SqliteStore({ location: file });
const after2 = facts(again.db);
if (JSON.stringify(after2.rows) !== JSON.stringify(after.rows)) say('second open changed contact rows');
again.close?.();
console.log(problems.length === 0 ? 'PROBE OK' : 'PROBLEMS:\n' + problems.join('\n'));
process.exit(problems.length === 0 ? 0 : 1);
