/**
 * CRITIC PROBES, round 3 (bank-parity E1, the Belegnummer, D178 point 2 and point 18). Non-author.
 * Synthetic by construction: invented bexio-shaped refs, accounts, texts and amounts.
 *
 * A test that FAILS here is a finding; a passing one is evidence the claim holds.
 *
 *  - [R3 PROBE L-identical] a GENUINE split voucher whose two pieces are byte-identical (one bexio voucher with
 *    two equal rows: same date, text, accounts and amount) cannot be told from a double import by content, and
 *    round 3 decides it IS one: the second piece does not share the voucher's number although the owner's
 *    default (`share`) says split pieces do, and the plan names a real booking `double_import`.
 *  - [R3 sound] a re-reversal chain of an import waits with it; a reversal of a native entry starts the run.
 *  - [R3 sound] a double import that arrives AFTER its original was numbered takes TILL's next number, and the
 *    plan names it with the entry that keeps the number. (ADAPTED by the author after the round-3 ruling: it
 *    now joins as a piece and the pair is flagged `identical_content`; see the test.)
 *  - [R3 sound] every way a book is built or upgraded ends with the same number-table objects, and every
 *    INDEXED BY in a trigger names an index that exists: fresh, a round-1 shape, a round-2 shape, a backup
 *    snapshot, a restored copy. And if the named index is ever missing, a posting fails whole (nothing half).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';

import { setup } from '../ledger/support.mjs';
import { postEntry, reverseEntry, journalNumberingPlan } from '../../dist/core/ledger/index.js';
import { createBackup, restoreBackup } from '../../dist/core/data/portability.js';
import { makeContext } from '../../dist/core/context.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { systemIdGen, sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';

function must(r, what = 'call') {
  assert.equal(r.ok, true, `${what}: ${JSON.stringify(r)}`);
  return r;
}

function imp(t, ref, key, amount, { date = '2025-10-25', description = 'Lohn Oktober' } = {}) {
  return must(
    postEntry(t.ctx, { date, source: 'import', ref, description, idempotencyKey: key, lines: [
      { account: t.accounts['6500'], debit: amount },
      { account: t.accounts['1020'], credit: amount },
    ] }),
    key,
  ).entryId;
}
const nat = (t, key) =>
  must(postEntry(t.ctx, { date: '2025-11-03', source: 'manual', idempotencyKey: key, lines: [
    { account: t.accounts['6500'], debit: 100 },
    { account: t.accounts['1000'], credit: 100 },
  ] }), key).entryId;
const num = (t, id) => t.store.db.prepare('SELECT display, origin FROM journal_entry_number WHERE entry_id = ?').get(id) ?? null;

test('[R3 PROBE L-identical] a genuine split voucher with two equal rows shares its number under the default `share`', () => {
  const t = setup();
  // ONE bexio voucher (8802) paying two equal wages from one text: two identical rows, imported in one run
  // under the importer's per-row keys.
  const rowA = imp(t, 'Manuelle Buchung 51 (8802)', 'bexio-run1:8802:row1', 420000);
  const rowB = imp(t, 'Manuelle Buchung 51 (8802)', 'bexio-run1:8802:row2', 420000);
  nat(t, 'n1');
  const plan = must(journalNumberingPlan(t.ctx));
  const listed = plan.migrated.duplicates.find((d) => d.ref === 8802);
  assert.deepEqual(
    [num(t, rowA)?.display, num(t, rowB)?.display],
    ['8802', '8802'],
    `piece B reads ${JSON.stringify(num(t, rowB))}; the plan lists it as ${JSON.stringify(listed)}`,
  );
  // FLIPPED to the orchestrator's ruling (D178 points 18 and 19, round 3): the pieces SHARE under the
  // default, and the plan FLAGS the pair as identical content, a possible double import for a person to look
  // at; it never asserts a double import and names no keeper.
  assert.deepEqual([num(t, rowA)?.origin, num(t, rowB)?.origin], ['adopted', 'adopted']);
  assert.deepEqual(plan.migrated.duplicates, [{ ref: 8802, reason: 'identical_content', entryIds: [rowA, rowB], keptBy: null }]);
  assert.ok(!plan.migrated.duplicates.some((d) => d.reason === 'double_import'));
  assert.deepEqual(plan.migrated.splitVouchers, [{ number: 8802, ref: 'Manuelle Buchung 51 (8802)', entryIds: [rowA, rowB] }]);
});

test('[R3 sound] a re-reversal chain of an import waits with it; a reversal of a native entry starts the run', () => {
  const t = setup();
  const i = imp(t, '41', 'i41', 1000, { description: 'Büro' });
  const r1 = must(reverseEntry(t.ctx, { entryId: i, idempotencyKey: 'r1' })).reversalId;
  const r2 = must(reverseEntry(t.ctx, { entryId: r1, idempotencyKey: 'r2' })).reversalId;
  assert.deepEqual([num(t, i), num(t, r1), num(t, r2)], [null, null, null], 'the whole chain is migration and waits');
  assert.equal(must(journalNumberingPlan(t.ctx)).pending, true);
  // A native entry reversed: the reversal is native and starts the run, with 41 adopted in the batch.
  const n = nat(t, 'n1');
  assert.equal(num(t, i).display, '41');
  assert.equal(num(t, i).origin, 'adopted');
  const rn = must(reverseEntry(t.ctx, { entryId: n, idempotencyKey: 'rn' })).reversalId;
  const assigned = t.store.db
    .prepare("SELECT number FROM journal_entry_number WHERE origin = 'assigned' ORDER BY number")
    .all()
    .map((r) => r.number);
  assert.deepEqual(assigned, [42, 43, 44, 45], 'r1, r2, n and its reversal: one gap-free run after 41');
  assert.equal(num(t, rn).display, '45');
});

test('[R3 sound] an identical copy that arrives after its original was numbered joins it as a piece and is flagged', () => {
  // ADAPTED by the author to the round-3 ruling (D178 points 18 and 19): by content a late re-run copy and a
  // late equal row of the same voucher cannot be told apart, so TILL treats it as a piece (`share`: it reads
  // 300 too) and flags the pair for a person, exactly as before the run started. It never takes a fresh number
  // on a guess and is never asserted a double import.
  const t = setup();
  const orig = imp(t, 'Bank Buchung 7 (300)', 'run1:300', 5550);
  nat(t, 'n1'); // run starts: 300 adopted, n1 = 301
  const again = imp(t, 'Bank Buchung 7 (300)', 'run2:300', 5550); // the import re-run under new keys
  assert.deepEqual(num(t, orig), { display: '300', origin: 'adopted' });
  assert.deepEqual(num(t, again), { display: '300', origin: 'adopted' });
  const listed = must(journalNumberingPlan(t.ctx)).migrated.duplicates.find((d) => d.ref === 300);
  assert.deepEqual(listed, { ref: 300, reason: 'identical_content', entryIds: [orig, again], keptBy: null });
});

/** The number table's indexes and triggers in `db`, by name, with every INDEXED BY a trigger names. */
function numberObjects(db) {
  const rows = db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'journal_entry_number' AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name")
    .all();
  const indexes = new Set(rows.filter((r) => r.type === 'index').map((r) => r.name));
  const missing = [];
  for (const r of rows.filter((x) => x.type === 'trigger')) {
    for (const m of r.sql.matchAll(/INDEXED BY (\w+)/g)) if (!indexes.has(m[1])) missing.push(`${r.name} -> ${m[1]}`);
  }
  return { objects: rows.map((r) => `${r.type}:${r.name}`), missing };
}

const ROUND1_TABLE = `
CREATE TABLE journal_entry_number (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id), entry_id TEXT NOT NULL UNIQUE REFERENCES journal_entry(id),
  series TEXT NOT NULL, number INTEGER NOT NULL CHECK (number >= 1), display TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('assigned', 'adopted')), assigned_at TEXT NOT NULL, UNIQUE (workspace_id, series, number));
CREATE INDEX journal_entry_number_display ON journal_entry_number (workspace_id, display);`;
const ROUND2_EXTRAS = `
CREATE UNIQUE INDEX journal_entry_number_assigned_unique ON journal_entry_number (workspace_id, series, number) WHERE origin = 'assigned';
CREATE UNIQUE INDEX journal_entry_number_assigned_display_unique ON journal_entry_number (workspace_id, display) WHERE origin = 'assigned';
CREATE INDEX journal_entry_number_by_series ON journal_entry_number (workspace_id, series, number);
CREATE INDEX journal_entry_number_by_display ON journal_entry_number (workspace_id, display);
CREATE TRIGGER journal_entry_number_shared_only_by_one_voucher BEFORE INSERT ON journal_entry_number
WHEN EXISTS (SELECT 1 FROM journal_entry_number o WHERE o.workspace_id = NEW.workspace_id
  AND ((o.series = NEW.series AND o.number = NEW.number) OR o.display = NEW.display)
  AND NOT (NEW.origin = 'adopted' AND o.origin = 'adopted' AND NEW.voucher_ref IS NOT NULL AND o.voucher_ref = NEW.voucher_ref))
BEGIN SELECT RAISE(ABORT, 'entry_number_taken'); END;`;

test('[R3 sound] fresh, round-1, round-2, backup snapshot and restored copy converge on one set of number-table objects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e1r3-objects-'));
  try {
    const fresh = new SqliteStore({ location: join(dir, 'fresh.db') });
    const want = numberObjects(fresh.db);
    assert.deepEqual(want.missing, []);
    assert.ok(want.objects.includes('trigger:journal_entry_number_one_reader'), want.objects.join(', '));
    fresh.close();

    // A book whose number table a pre-release build shaped (round 1, then round 2 on top), reopened.
    for (const [label, ddl] of [['round-1', ROUND1_TABLE], ['round-2', `${ROUND1_TABLE}\nALTER TABLE journal_entry_number ADD COLUMN voucher_ref TEXT;\n${ROUND2_EXTRAS}`]]) {
      const file = join(dir, `${label}.db`);
      new SqliteStore({ location: file }).close();
      const raw = new Database(file);
      for (const r of raw.prepare("SELECT type, name FROM sqlite_master WHERE tbl_name = 'journal_entry_number' AND type IN ('index', 'trigger') AND sql IS NOT NULL").all()) {
        raw.exec(`DROP ${r.type.toUpperCase()} "${r.name}"`);
      }
      raw.exec('DROP TABLE journal_entry_number;');
      raw.exec(ddl);
      raw.close();
      const reopened = new SqliteStore({ location: file });
      const got = numberObjects(reopened.db);
      reopened.close();
      // The round-1 table keeps its table-level UNIQUE autoindex (documented); otherwise the same objects.
      assert.deepEqual(got.objects.filter((o) => !o.startsWith('index:sqlite_autoindex')), want.objects, label);
      assert.deepEqual(got.missing, [], label);
    }

    // A backup snapshot and a restored copy of a book with numbers.
    const clock = fixedClock('2026-07-19T00:00:00.000Z');
    const store = new SqliteStore({ clock });
    const ws = must(createWorkspace({ store, clock, ids: systemIdGen }, { name: 'Quelle GmbH' })).workspaceId;
    const ctx = makeContext(store, { workspaceId: ws, actor: 'user_1', clock, ids: systemIdGen });
    const acc = (n) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, n).id;
    must(postEntry(ctx, { date: '2025-04-01', source: 'manual', idempotencyKey: 'n', lines: [
      { account: acc('6500'), debit: 700 },
      { account: acc('1020'), credit: 700 },
    ] }));
    const deps = { store, clock, ids: systemIdGen, actor: 'user_1', backupDir: join(dir, 'b') };
    const bkp = must(createBackup(deps, { workspaceId: ws, idempotencyKey: 'bk' }), 'backup');
    const snap = new Database(join(bkp.artifactRef, 'data.sqlite'), { readonly: true });
    const snapObjects = numberObjects(snap);
    snap.close();
    assert.deepEqual(snapObjects.objects, want.objects, 'the snapshot carries the same objects');
    assert.deepEqual(snapObjects.missing, []);
    const copy = must(restoreBackup(deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie GmbH', confirmed: true }), 'restore').workspaceId;
    const copyCtx = makeContext(store, { workspaceId: copy, actor: 'user_1', clock, ids: systemIdGen });
    const acc2 = (n) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(copy, n).id;
    must(postEntry(copyCtx, { date: '2025-04-02', source: 'manual', idempotencyKey: 'n2', lines: [
      { account: acc2('6500'), debit: 800 },
      { account: acc2('1020'), credit: 800 },
    ] }), 'post in the copy');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('[R3 sound] if a probe index named by INDEXED BY were missing, a posting fails whole and writes nothing', () => {
  const t = setup();
  const db = t.store.db;
  db.exec('DROP INDEX journal_entry_number_display_probe');
  const before = {
    entries: db.prepare('SELECT COUNT(*) AS n FROM journal_entry').get().n,
    numbers: db.prepare('SELECT COUNT(*) AS n FROM journal_entry_number').get().n,
  };
  let failed = null;
  try {
    const r = nat(t, 'x');
    failed = `posted ${r}`;
  } catch (e) {
    failed = String(e.message);
  }
  assert.match(failed, /no such index: journal_entry_number_display_probe/);
  // (see below for the conflict probe)
  assert.deepEqual(
    { entries: db.prepare('SELECT COUNT(*) AS n FROM journal_entry').get().n, numbers: db.prepare('SELECT COUNT(*) AS n FROM journal_entry_number').get().n },
    before,
  );
  assert.ok(sequenceIdGen);
});

test('[R3 PROBE L-copy] the mode setting text says what switching on does: imports and their reversals keep waiting for the first booking not from an import', async () => {
  const { settingsSet } = await import('../../dist/core/settings/index.js');
  const t = setup();
  must(settingsSet(t.ctx, { key: 'ledger.belegnummer_mode', value: 'off', reason: 'Probe', idempotencyKey: 'off' }));
  const i = imp(t, 'Bank Buchung 3 (77)', 'i77', 900, { description: 'Spesen' });
  // A reversal correcting it: per the registry text it "waits until the first other booking"; this IS one.
  must(reverseEntry(t.ctx, { entryId: i, idempotencyKey: 'fix' }));
  must(settingsSet(t.ctx, { key: 'ledger.belegnummer_mode', value: 'continue_migrated', reason: 'Probe', idempotencyKey: 'on' }));
  const unnumberedNow = () =>
    t.store.db
      .prepare("SELECT COUNT(*) AS n FROM journal_entry e WHERE e.status = 'posted' AND NOT EXISTS (SELECT 1 FROM journal_entry_number n WHERE n.entry_id = e.id)")
      .get().n;
  // FLIPPED by the author after L3-3 (critic's setup kept): the behaviour is rule a, and the TEXT now says it.
  // The import and its correcting reversal still wait after switching on; the first booking that does not
  // come from an import numbers them.
  assert.equal(unnumberedNow(), 2, 'the import and its reversal keep waiting (rule a)');
  assert.equal(must(journalNumberingPlan(t.ctx)).pending, true);
  const { settingDef } = await import('../../dist/core/settings/registry.js');
  const text = settingDef('ledger.belegnummer_mode').description;
  // Both locales name the reversal of an import and the wait that survives switching back on.
  assert.match(text.en, /reversals that correct an import/);
  assert.match(text.en, /When you switch numbering back on, entries without a number get one at once\. Imports and their reversals under continue_migrated still wait for the first booking that does not come from an import\./);
  assert.match(text['de-CH'], /Importe und Stornos, die einen Import korrigieren, bleiben vorerst ohne Nummer/);
  assert.match(text['de-CH'], /Importe und ihre Stornos unter continue_migrated warten aber weiter auf die erste Buchung, die nicht aus einem Import stammt/);
  // The round-2 sentences the critic quoted are gone.
  assert.doesNotMatch(text.en, /until the first other booking/);
  assert.doesNotMatch(text['de-CH'], /bis zur ersten anderen Buchung/);
  nat(t, 'first-own');
  assert.equal(unnumberedNow(), 0, 'the first booking that does not come from an import numbers everything waiting');
});

test('[R3 PROBE L-conflict-late] a number withheld for a conflict is not handed to a later claimant (no guessing)', () => {
  const t = setup();
  // Two DIFFERENT bexio vouchers claim 300 (a conflict: neither adopts), beside a clean voucher 400.
  const v1 = imp(t, 'Manuelle Buchung 5 (300)', 'run1:300a', 1111, { description: 'Miete' });
  const v2 = imp(t, 'Bank Buchung 9 (300)', 'run1:300b', 2222, { description: 'Gebühr' });
  imp(t, 'Bank Buchung 1 (400)', 'run1:400', 3333, { description: 'Material' });
  nat(t, 'n1'); // the run starts: 400 adopted, 300 withheld, v1 and v2 assigned after 400
  assert.equal(num(t, v1).origin, 'assigned');
  assert.equal(num(t, v2).origin, 'assigned');
  // The import is run again under new keys: v1 arrives a second time (a double import of a conflicting voucher).
  const again = imp(t, 'Manuelle Buchung 5 (300)', 'run2:300a', 1111, { description: 'Miete' });
  const plan = must(journalNumberingPlan(t.ctx));
  assert.notEqual(
    num(t, again).display,
    '300',
    `the double import of a conflicting voucher took 300 (${JSON.stringify(num(t, again))}); plan: ${JSON.stringify(plan.migrated.duplicates)}`,
  );
});
