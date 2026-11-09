/**
 * A02 §4b.3, the bexio reference shape and split vouchers (D178 point 2 follow-up, owner 21.10.2026).
 *
 * A migrated bexio entry's ref reads `<label> <per-type counter> (<Belegnummer>)`, and the number in
 * parentheses is bexio's continuous voucher series. One bexio voucher may have been migrated as several TILL
 * entries, all with the identical ref: a SPLIT voucher, numbered by `ledger.belegnummer_split_voucher`
 * (`share` default, `suffix`, `first_keeps`). The assigned run continues after the highest adopted number.
 *
 * Every ref, label counter and amount here is SYNTHETIC: invented numbers in the shape the owner described,
 * on an in-memory store. No real book was read.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { setup } from './support.mjs';
import { postEntry, reverseEntry, listJournal, journalNumberingPlan } from '../../dist/core/ledger/index.js';
import { settingsSet } from '../../dist/core/settings/index.js';
import { migratedVoucherOf, BEXIO_REF_LABELS, isMigrationPosting } from '../../dist/core/ledger/entryNumber.js';
import { DATA_MIGRATIONS } from '../../dist/core/store/migrations.js';
import { ENTRY_NUMBER_SCHEMA_SQL } from '../../dist/core/ledger/entryNumberSchema.js';
import { systemIdGen } from '../../dist/core/ids.js';

const G17 = DATA_MIGRATIONS.find((m) => m.generation === 17);

function must(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

function post(t, { date, key, source = 'manual', ref, amount = 1000 }) {
  return must(
    postEntry(t.ctx, {
      date,
      source,
      idempotencyKey: key,
      ...(ref === undefined ? {} : { ref }),
      lines: [
        { account: t.accounts['6500'], debit: amount },
        { account: t.accounts['1020'], credit: amount },
      ],
    }),
  ).entryId;
}
const bexio = (t, ref, date, key, amount = 1000) => post(t, { date, key, source: 'import', ref, amount });
const setSplit = (t, value, k = value) =>
  must(settingsSet(t.ctx, { key: 'ledger.belegnummer_split_voucher', value, reason: 'Test', idempotencyKey: `split-${k}` }));

const numberOf = (t, id) => t.store.db.prepare('SELECT display FROM journal_entry_number WHERE entry_id = ?').get(id)?.display ?? null;
const originOf = (t, id) => t.store.db.prepare('SELECT origin FROM journal_entry_number WHERE entry_id = ?').get(id)?.origin ?? null;

/**
 * A cutover in the owner's shape: an opening balance, bexio vouchers 301, 302, a split voucher 303 (three
 * entries), 305, a migrated free text `Rechnung (12)`, then the first native booking that starts the run.
 */
function cutover(t) {
  const ids = {
    ob: post(t, { date: '2026-01-01', key: 'opening-balances:x', source: 'import' }),
    v301: bexio(t, 'Bank Buchung 11 (301)', '2026-01-02', 'v301'),
    v302: bexio(t, 'Manuelle Buchung 21 (302)', '2026-01-03', 'v302'),
    s1: bexio(t, 'Bank Buchung 12 (303)', '2026-01-04', 's1', 1201),
    s2: bexio(t, 'Bank Buchung 12 (303)', '2026-01-04', 's2', 1202),
    s3: bexio(t, 'Bank Buchung 12 (303)', '2026-01-04', 's3', 1203),
    v305: bexio(t, 'Manuelle Buchung 22 (305)', '2026-01-06', 'v305'),
    text: bexio(t, 'Rechnung (12)', '2026-01-07', 'text'),
  };
  // Nothing is numbered yet (rule a): the imports wait for the first native booking.
  for (const id of Object.values(ids)) assert.equal(numberOf(t, id), null);
  ids.native = post(t, { date: '2026-02-01', key: 'native' });
  return ids;
}

test('the bexio ref shape: the number in parentheses, only after a known label and a counter; free text never', () => {
  assert.deepEqual(BEXIO_REF_LABELS, ['Manuelle Buchung', 'Bank Buchung']);
  assert.deepEqual(migratedVoucherOf('Manuelle Buchung 4711 (8801)'), { number: 8801, key: 'Manuelle Buchung 4711 (8801)', splittable: true });
  assert.deepEqual(migratedVoucherOf('Bank Buchung 912 (8802)'), { number: 8802, key: 'Bank Buchung 912 (8802)', splittable: true });
  assert.deepEqual(migratedVoucherOf('501'), { number: 501, key: '501', splittable: false });
  for (const ref of [
    'Rechnung (12)', // free text with a number in parentheses
    'Rechnung 5 (12)', // an unknown label
    'Manuelle Buchung (12)', // no per-type counter
    'Manuelle Buchung 4 (012)', // a leading zero
    'Manuelle Buchung 4 (12) ', // a trailing blank
    'manuelle buchung 4 (12)', // the label's case
    'Bank Buchung 4 (12a)',
    null,
  ]) {
    assert.equal(migratedVoucherOf(ref), null, `${JSON.stringify(ref)} names no voucher`);
  }
});

test('share (default): every entry of a split voucher reads its number; the run continues after the highest adopted; free text and natives follow', () => {
  const t = setup();
  const ids = cutover(t);
  assert.deepEqual(
    Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, numberOf(t, id)])),
    { ob: '306', v301: '301', v302: '302', s1: '303', s2: '303', s3: '303', v305: '305', text: '307', native: '308' },
  );
  assert.deepEqual([ids.s1, ids.s2, ids.s3].map((id) => originOf(t, id)), ['adopted', 'adopted', 'adopted']);
  // The Beleg-Nr. filter finds the voucher's three entries.
  assert.deepEqual(new Set(must(listJournal(t.ctx, { number: '303' })).entries.map((e) => e.id)), new Set([ids.s1, ids.s2, ids.s3]));
  // The ASSIGNED run stays unique and gap-free: 306, 307, 308.
  const assigned = t.store.db.prepare("SELECT number FROM journal_entry_number WHERE origin = 'assigned' ORDER BY number").all().map((r) => r.number);
  assert.deepEqual(assigned, [306, 307, 308]);
});

test('suffix: 303, 303.2, 303.3 in entry order', () => {
  const t = setup();
  setSplit(t, 'suffix');
  const ids = cutover(t);
  assert.deepEqual([ids.s1, ids.s2, ids.s3].map((id) => numberOf(t, id)), ['303', '303.2', '303.3']);
  assert.equal(numberOf(t, ids.native), '308');
  // Every piece keeps the voucher's number in the number column, so typing 303 finds all three.
  assert.equal(must(listJournal(t.ctx, { number: '303' })).entries.length, 3);
  assert.deepEqual(must(listJournal(t.ctx, { number: '303.2' })).entries.map((e) => e.id), [ids.s2]);
});

test('first_keeps: the first entry keeps 303, the others take the next assigned numbers in date order', () => {
  const t = setup();
  setSplit(t, 'first_keeps');
  const ids = cutover(t);
  assert.deepEqual(
    Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, numberOf(t, id)])),
    // After the highest adopted (305), in (date, created_at, rowid) order: ob 01-01, s2 and s3 01-04, text 01-07.
    { ob: '306', v301: '301', v302: '302', s1: '303', s2: '307', s3: '308', v305: '305', text: '309', native: '310' },
  );
  assert.deepEqual([ids.s1, ids.s2, ids.s3].map((id) => originOf(t, id)), ['adopted', 'assigned', 'assigned']);
});

test('the run starts after the highest adopted bexio number (a synthetic range: 8101 .. 8159 gives 8160)', () => {
  const t = setup();
  bexio(t, 'Bank Buchung 7 (8101)', '2026-01-02', 'a');
  bexio(t, 'Manuelle Buchung 7 (8159)', '2026-03-30', 'b');
  const n = post(t, { date: '2026-04-01', key: 'n' });
  assert.equal(numberOf(t, n), '8160');
});

test('a voucher number claimed by two DIFFERENT bexio vouchers is adopted by neither; a native with a bexio-shaped ref is never adopted', () => {
  const t = setup();
  const a = bexio(t, 'Bank Buchung 11 (310)', '2026-01-02', 'a');
  const b = bexio(t, 'Manuelle Buchung 30 (310)', '2026-01-03', 'b');
  const own = post(t, { date: '2026-01-04', key: 'own', ref: 'Manuelle Buchung 9 (350)' });
  // The run starts above the highest CLAIMED old number (310, withheld), so no TILL number reads it (L3C-1).
  assert.deepEqual([a, b, own].map((id) => numberOf(t, id)), ['311', '312', '313']);
  const plan = must(journalNumberingPlan(t.ctx));
  assert.deepEqual(plan.migrated.duplicates, [{ ref: 310, reason: 'conflict', entryIds: [a, b], keptBy: null }]);
  assert.deepEqual(plan.migrated.splitVouchers, []);
});

test('rule b with bexio refs: a later piece shares (share) or suffixes (suffix) or takes the next number (first_keeps); a later free voucher below the run is adopted', () => {
  for (const [mode, expectPiece] of [['share', '303'], ['suffix', '303.4'], ['first_keeps', '311']]) {
    const t = setup();
    setSplit(t, mode);
    const ids = cutover(t);
    const nextBefore = t.store.db.prepare("SELECT next_value FROM document_number_seq WHERE type = 'journal' AND year = 'all'").get().next_value;
    const piece = bexio(t, 'Bank Buchung 12 (303)', '2026-01-04', 'late-piece', 1204);
    const free = bexio(t, 'Manuelle Buchung 23 (304)', '2026-01-05', 'late-free');
    const rival = bexio(t, 'Manuelle Buchung 99 (303)', '2026-01-08', 'late-rival');
    const firstKeepsShift = mode === 'first_keeps' ? 1 : 0;
    assert.equal(numberOf(t, piece), expectPiece, `${mode}: a later piece of voucher 303`);
    assert.equal(numberOf(t, free), '304', `${mode}: a later free voucher below the run keeps its number`);
    assert.equal(numberOf(t, rival), String(nextBefore + firstKeepsShift), `${mode}: a different voucher claiming 303 takes the next number`);
    assert.ok(numberOf(t, ids.native) !== null);
  }
});

test('the plan names the bexio refs, the split vouchers, the highest number and the free text', () => {
  const t = setup();
  const ids = cutover(t);
  const plan = must(journalNumberingPlan(t.ctx));
  assert.equal(plan.settings.split, 'share');
  assert.equal(plan.migrated.entries, 7, 'the opening balance is the engine\'s own import');
  assert.equal(plan.migrated.bexioRefs, 6);
  assert.equal(plan.migrated.plainIntegerRefs, 0);
  assert.equal(plan.migrated.highestMigratedNumber, 305);
  assert.deepEqual(plan.migrated.splitVouchers, [{ number: 303, ref: 'Bank Buchung 12 (303)', entryIds: [ids.s1, ids.s2, ids.s3] }]);
  assert.deepEqual(plan.migrated.nonNumeric, [{ entryId: ids.text, ref: 'Rechnung (12)' }]);
});

test('the generation-17 backfill on a book migrated before this build: bexio refs adopted, the split shared, the run after the highest', () => {
  const t = setup();
  const ids = cutover(t);
  // Back to a book this build never numbered.
  const db = t.store.db;
  for (const trig of ['journal_entry_number_no_delete', 'journal_number_seq_no_delete', 'journal_number_withheld_no_delete']) db.exec(`DROP TRIGGER IF EXISTS ${trig}`);
  db.exec("DELETE FROM journal_entry_number; DELETE FROM document_number_seq WHERE type = 'journal'; DELETE FROM journal_numbering_pending; DELETE FROM journal_number_withheld;");
  db.exec(ENTRY_NUMBER_SCHEMA_SQL);
  G17.apply(db);
  assert.deepEqual(
    Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, numberOf(t, id)])),
    { ob: '306', v301: '301', v302: '302', s1: '303', s2: '303', s3: '303', v305: '305', text: '307', native: '308' },
  );
});

test('a change of the split setting applies forward only: pieces already numbered keep their numbers', () => {
  const t = setup();
  const ids = cutover(t);
  setSplit(t, 'suffix');
  const late = bexio(t, 'Bank Buchung 12 (303)', '2026-01-04', 'late', 1204);
  assert.deepEqual([ids.s1, ids.s2, ids.s3, late].map((id) => numberOf(t, id)), ['303', '303', '303', '303.4']);
});

test('rule a covers the corrections of a cutover: a reversal of an import, its re-reversal and a setting change all wait; the first native booking starts the run (critic r2 M2-1)', () => {
  const t = setup();
  const v1 = bexio(t, 'Manuelle Buchung 1 (401)', '2025-01-03', 'v401');
  const v2 = bexio(t, 'Manuelle Buchung 2 (402)', '2025-01-04', 'v402');
  const v3 = bexio(t, 'Manuelle Buchung 3 (403)', '2025-01-05', 'v403');
  const rev = must(reverseEntry(t.ctx, { entryId: v2, date: '2025-01-10', idempotencyKey: 'fix-402' })).reversalId;
  const rerev = must(reverseEntry(t.ctx, { entryId: rev, date: '2025-01-11', idempotencyKey: 'undo-fix-402' })).reversalId;
  setSplit(t, 'suffix');
  const v4 = bexio(t, 'Manuelle Buchung 4 (404)', '2025-01-06', 'v404');
  for (const id of [v1, v2, v3, rev, rerev, v4]) assert.equal(numberOf(t, id), null, 'a migration posting waits');
  assert.equal(must(journalNumberingPlan(t.ctx)).pending, true);
  // The engine's predicate: a reversal is a migration posting exactly when its chain leads back to an import.
  const scope = { db: t.store.db, workspaceId: 'ws_1' };
  const entryOf = (id) => t.store.db.prepare('SELECT source, reverses_entry_id FROM journal_entry WHERE id = ?').get(id);
  assert.deepEqual([v1, rev, rerev].map((id) => isMigrationPosting(scope, entryOf(id))), [true, true, true]);
  const native = post(t, { date: '2025-02-01', key: 'native' });
  const nativeRev = must(reverseEntry(t.ctx, { entryId: native, date: '2025-02-02', idempotencyKey: 'rv-native' })).reversalId;
  assert.equal(isMigrationPosting(scope, entryOf(nativeRev)), false, 'the reversal of a native booking is native');
  assert.deepEqual(
    [v1, v2, v3, v4, rev, rerev, native, nativeRev].map((id) => numberOf(t, id)),
    ['401', '402', '403', '404', '405', '406', '407', '408'],
  );
});

test('identical content is a piece, never a decided double: an entry repeating a piece under the same bexio ref is numbered as a piece in every split mode, and the plan flags the group, in one batch and after the start (critic r3 L3-1)', () => {
  for (const split of ['share', 'suffix', 'first_keeps']) {
    const t = setup();
    setSplit(t, split);
    // Voucher 501 has two different pieces, and an entry with piece A's exact content: a re-run import, or a
    // second equal row of the voucher. By content TILL cannot tell, so it decides nothing.
    const a = bexio(t, 'Bank Buchung 5 (501)', '2025-01-03', 'run-1:a', 2101);
    const b = bexio(t, 'Bank Buchung 5 (501)', '2025-01-03', 'run-1:b', 2102);
    const aAgain = bexio(t, 'Bank Buchung 5 (501)', '2025-01-03', 'run-2:a', 2101);
    const plan = must(journalNumberingPlan(t.ctx));
    assert.deepEqual(plan.migrated.splitVouchers, [{ number: 501, ref: 'Bank Buchung 5 (501)', entryIds: [a, b, aAgain] }], split);
    assert.deepEqual(plan.migrated.duplicates, [{ ref: 501, reason: 'identical_content', entryIds: [a, aAgain], keptBy: null }], split);
    const native = post(t, { date: '2025-02-01', key: 'native' });
    const expected = {
      share: ['501', '501', '501', '502'],
      suffix: ['501', '501.2', '501.3', '502'],
      first_keeps: ['501', '502', '503', '504'],
    }[split];
    assert.deepEqual([a, b, aAgain, native].map((id) => numberOf(t, id)), expected, split);
    // After the start (rule b): an entry with piece B's content joins the voucher like any later piece.
    const bAgain = bexio(t, 'Bank Buchung 5 (501)', '2025-01-03', 'run-3:b', 2102);
    assert.equal(numberOf(t, bAgain), { share: '501', suffix: '501.4', first_keeps: '505' }[split], split);
    const after = must(journalNumberingPlan(t.ctx));
    assert.deepEqual(
      after.migrated.duplicates,
      [
        { ref: 501, reason: 'identical_content', entryIds: [a, aAgain], keptBy: null },
        { ref: 501, reason: 'identical_content', entryIds: [b, bAgain], keptBy: null },
      ],
      split,
    );
  }
});

test('the plan lists only the claims that do not read the number, from the outcome: an early claim that adopted is the keeper, never a duplicate (critic r2 L2-3)', () => {
  const t = setup();
  const early = post(t, { date: '2025-01-05', key: 'a7', source: 'import', ref: '7' });
  post(t, { date: '2025-03-01', key: 'n1' }); // the run starts: 7 adopted
  const late = post(t, { date: '2025-01-06', key: 'b7', source: 'import', ref: '7' });
  const rival = bexio(t, 'Manuelle Buchung 3 (7)', '2025-01-07', 'c7');
  assert.deepEqual([early, late, rival].map((id) => originOf(t, id)), ['adopted', 'assigned', 'assigned']);
  const plan = must(journalNumberingPlan(t.ctx));
  assert.deepEqual(plan.migrated.duplicates, [{ ref: 7, reason: 'conflict', entryIds: [late, rival], keptBy: early }]);
  // In one batch (before the start) neither of two plain-integer claims adopts, and the plan says so.
  const u = setup();
  const x = post(u, { date: '2025-01-05', key: 'x', source: 'import', ref: '9' });
  const y = post(u, { date: '2025-01-06', key: 'y', source: 'import', ref: '9' });
  assert.deepEqual(must(journalNumberingPlan(u.ctx)).migrated.duplicates, [{ ref: 9, reason: 'conflict', entryIds: [x, y], keptBy: null }]);
});

test('the order is the order of writing, never the random id: with production ids every split mode and the identical-content flag follow the import order (critic r2 L2-4)', () => {
  const runs = 10;
  for (const split of ['suffix', 'first_keeps']) {
    for (let i = 0; i < runs; i += 1) {
      // The production generator: random UUID ids, and all three pieces in one millisecond (the fixed clock).
      const t = setup({ ids: systemIdGen });
      setSplit(t, split);
      const pieces = [2301, 2302, 2303].map((amount, k) => bexio(t, 'Bank Buchung 8 (600)', '2025-01-03', `p${k}`, amount));
      const again = bexio(t, 'Bank Buchung 8 (600)', '2025-01-03', 'again', 2301);
      post(t, { date: '2025-02-01', key: 'native' });
      const want = split === 'suffix' ? ['600', '600.2', '600.3', '600.4'] : ['600', '601', '602', '603'];
      assert.deepEqual([...pieces, again].map((id) => numberOf(t, id)), want, `${split}, run ${i}`);
      assert.deepEqual(
        must(journalNumberingPlan(t.ctx)).migrated.duplicates,
        [{ ref: 600, reason: 'identical_content', entryIds: [pieces[0], again], keptBy: null }],
        `${split}, run ${i}: the identical pair is named in import order`,
      );
    }
  }
});

test('a withheld number stays withheld: neither a late copy of a conflicting voucher nor a third voucher takes it, and the plan names them (critic r3 L3-2)', () => {
  const t = setup();
  // Two DIFFERENT vouchers claim 300 in the first batch: neither adopts, and 300 is withheld.
  const v1 = bexio(t, 'Manuelle Buchung 5 (300)', '2025-01-03', 'run-1:a', 1111);
  const v2 = bexio(t, 'Bank Buchung 9 (300)', '2025-01-04', 'run-1:b', 2222);
  bexio(t, 'Bank Buchung 1 (400)', '2025-01-05', 'run-1:c', 3333);
  post(t, { date: '2025-02-01', key: 'native' }); // the run starts after 400
  assert.deepEqual([v1, v2].map((id) => originOf(t, id)), ['assigned', 'assigned']);
  assert.ok(t.store.db.prepare("SELECT 1 FROM journal_number_withheld WHERE workspace_id = 'ws_1' AND series = 'all' AND number = 300").get());
  // Later claimants of 300, each in its own batch: a byte-identical copy of v1, then a third voucher.
  const copy = bexio(t, 'Manuelle Buchung 5 (300)', '2025-01-03', 'run-2:a', 1111);
  const third = bexio(t, 'Manuelle Buchung 77 (300)', '2025-01-06', 'run-2:z', 4444);
  assert.deepEqual([copy, third].map((id) => originOf(t, id)), ['assigned', 'assigned'], 'nobody settles the conflict by arriving later');
  assert.equal(must(listJournal(t.ctx, { number: '300' })).entries.length, 0, 'Beleg-Nr. 300 names no entry');
  const plan = must(journalNumberingPlan(t.ctx));
  assert.deepEqual(plan.migrated.duplicates, [
    { ref: 300, reason: 'conflict', entryIds: [v1, copy, v2, third], keptBy: null },
    { ref: 300, reason: 'identical_content', entryIds: [v1, copy], keptBy: null },
  ]);
  // A free voucher number nobody contested is still adopted later (rule b is otherwise unchanged).
  const free = bexio(t, 'Bank Buchung 2 (350)', '2025-01-08', 'run-2:free', 5555);
  assert.deepEqual([numberOf(t, free), originOf(t, free)], ['350', 'adopted']);
});
