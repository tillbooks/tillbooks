/**
 * CRITIC PROBES (bank-parity E1, the Belegnummer, D178 point 2), round 1, finding L1. Written by the
 * non-author critic; kept as REGRESSION TESTS by the author after the fix, with the assertions' intent
 * unchanged: two posted entries never read the same Beleg-Nr., and every number as shown is findable by the
 * Beleg-Nr. filter. Synthetic by construction.
 *
 * The fix (A02 §4b.1 / §4b.5): `ledger.belegnummer_prefix` has a closed shape (no blank, `A-Z a-z 0-9 . _ / -`,
 * no trailing digit), a mode / start / prefix change that could repeat an existing display is refused with
 * the clash named, and `UNIQUE (workspace_id, display)` is the storage backstop.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { setup, simpleEntry } from '../ledger/support.mjs';
import { postEntry, listJournal } from '../../dist/core/ledger/index.js';
import { settingsSet, settingsReset } from '../../dist/core/settings/index.js';

function must(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

const trySet = (t, key, value, k) => settingsSet(t.ctx, { key, value, reason: 'Test', idempotencyKey: `${key}-${k}` });
const setPrefix = (t, value, k) => trySet(t, 'ledger.belegnummer_prefix', value, k);
const dupes = (t) =>
  t.store.db
    .prepare('SELECT display, COUNT(*) AS n FROM journal_entry_number WHERE workspace_id = ? GROUP BY display HAVING n > 1')
    .all('ws_1');

test('[PROBE e1-L1a] two posted entries never read the same Beleg-Nr.', () => {
  const t = setup();
  // The critic's route to a shared display: prefix `1` (11 .. 19), then no prefix (10, 11, 12). A prefix
  // ending in a digit is refused now, and nothing was written.
  const one = setPrefix(t, '1', 'one');
  assert.equal(one.ok, false);
  assert.equal(one.error, 'belegnummer_prefix_invalid');
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM workspace_setting_change').get().n, 0);
  for (let i = 1; i <= 12; i += 1) must(postEntry(t.ctx, simpleEntry(t.accounts, 100 + i, `a${i}`)));
  assert.deepEqual(dupes(t), []);
  const hit = must(listJournal(t.ctx, { number: '11' })).entries;
  assert.equal(hit.length, 1, `the Beleg-Nr. filter "11" answers ${hit.length} entries`);
});

test('[e1-L1 clash] a change that could repeat an existing Beleg-Nr. is refused, naming it; a harmless one passes', () => {
  const t = setup();
  // Per fiscal year from 1000: 2026-1000, 2026-1001.
  must(trySet(t, 'ledger.belegnummer_mode', 'per_fiscal_year', 'fy'));
  must(trySet(t, 'ledger.belegnummer_start', 1000, 'start'));
  const first = must(postEntry(t.ctx, simpleEntry(t.accounts, 100, 'a'))).entryId;
  must(postEntry(t.ctx, simpleEntry(t.accounts, 100, 'b')));
  // A prefix of `2026-` while per fiscal year is harmless (2026-2026-1002 ...).
  must(setPrefix(t, '2026-', 'p'));
  // Switching to one continuous run from 1000 would hand out `2026-1000` again: refused, the clash named.
  const refused = trySet(t, 'ledger.belegnummer_mode', 'from_start', 'cont');
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'belegnummer_display_clash');
  assert.equal(refused.display, '2026-1000');
  assert.equal(refused.entryId, first);
  assert.match(refused.reason, /2026-1000/);
  // Nothing moved: the mode is still per fiscal year, the next number continues that run.
  const next = must(postEntry(t.ctx, simpleEntry(t.accounts, 100, 'c'))).entryId;
  assert.equal(t.store.db.prepare('SELECT display FROM journal_entry_number WHERE entry_id = ?').get(next).display, '2026-2026-1002');
  // A reset of the prefix back to empty is judged too (the continuous family is not in play, so it passes).
  must(settingsReset(t.ctx, { key: 'ledger.belegnummer_prefix', reason: 'zurück', idempotencyKey: 'reset-p' }));
  assert.deepEqual(dupes(t), []);
});

test('[PROBE e1-L1b] a number with a blank-led prefix is findable by the Beleg-Nr. filter', () => {
  const t = setup();
  // A prefix with a blank at its edge (or inside) is refused, so every number as shown is typeable.
  for (const [value, k] of [[' B', 'lead'], ['B ', 'trail'], ['B 1-', 'inner'], ['Bü', 'umlaut'], ['-B', 'dash-first']]) {
    const r = setPrefix(t, value, k);
    assert.equal(r.ok, false, `prefix ${JSON.stringify(value)} must be refused`);
    assert.equal(r.error, 'belegnummer_prefix_invalid');
  }
  must(setPrefix(t, 'B-', 'ok'));
  const id = must(postEntry(t.ctx, simpleEntry(t.accounts, 100, 'x'))).entryId;
  const display = t.store.db.prepare('SELECT display FROM journal_entry_number WHERE entry_id = ?').get(id).display;
  assert.equal(display, 'B-1');
  const hit = must(listJournal(t.ctx, { number: display })).entries;
  assert.equal(hit.length, 1, `typing the shown number ${JSON.stringify(display)} finds ${hit.length} entries`);
});

test('[e1-L1 backstop] the storage refuses a second reader of a number or display, unless both are adopted pieces of ONE voucher', () => {
  const t = setup();
  const a = must(postEntry(t.ctx, simpleEntry(t.accounts, 100, 'a'))).entryId;
  const b = must(postEntry(t.ctx, simpleEntry(t.accounts, 100, 'b'))).entryId;
  const c = must(postEntry(t.ctx, simpleEntry(t.accounts, 100, 'c'))).entryId;
  const db = t.store.db;
  assert.equal(db.prepare('SELECT display FROM journal_entry_number WHERE entry_id = ?').get(a).display, '1');
  // Hand-made rows, guards for the wipe dropped: b and c lose their numbers.
  db.exec('DROP TRIGGER journal_entry_number_no_delete');
  db.prepare('DELETE FROM journal_entry_number WHERE entry_id IN (?, ?)').run(b, c);
  const insert = db.prepare(
    'INSERT INTO journal_entry_number (id, workspace_id, entry_id, series, number, display, origin, voucher_ref, assigned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  // Another series reading '1' again: taken.
  assert.throws(() => insert.run('dup', 'ws_1', b, '2026', 1, '1', 'assigned', null, 'x'), /entry_number_taken/);
  // An adopted number equal to an assigned one: taken.
  assert.throws(() => insert.run('dup2', 'ws_1', b, 'all', 1, '1', 'adopted', 'Bank Buchung 9001 (1)', 'x'), /entry_number_taken/);
  // Two pieces of ONE bexio voucher may share 900; a different voucher may not.
  insert.run('v1', 'ws_1', b, 'all', 900, '900', 'adopted', 'Bank Buchung 5 (900)', 'x');
  assert.throws(() => insert.run('v2', 'ws_1', c, 'all', 900, '900', 'adopted', 'Manuelle Buchung 7 (900)', 'x'), /entry_number_taken/);
  // A plain-integer adoption (no voucher_ref) never shares either.
  assert.throws(() => insert.run('v3', 'ws_1', c, 'all', 900, '900', 'adopted', null, 'x'), /entry_number_taken/);
  insert.run('v4', 'ws_1', c, 'all', 900, '900', 'adopted', 'Bank Buchung 5 (900)', 'x');
  assert.deepEqual(
    db.prepare("SELECT entry_id FROM journal_entry_number WHERE number = 900 ORDER BY entry_id").all().map((r) => r.entry_id),
    [b, c].sort(),
  );
  // voucher_ref belongs to an adopted number only.
  db.prepare('DELETE FROM journal_entry_number WHERE entry_id = ?').run(c);
  assert.throws(() => insert.run('v5', 'ws_1', c, 'all', 77, '77', 'assigned', 'Bank Buchung 5 (77)', 'x'), /CHECK constraint failed/);
});

test('[e1-L1 adoption] a year-like prefix after a per-fiscal-year run: the adopted and assigned numbers never repeat a display', () => {
  const t = setup();
  // A per-fiscal-year book with prefix `R`: R2026-0001.
  must(trySet(t, 'ledger.belegnummer_mode', 'per_fiscal_year', 'fy'));
  must(setPrefix(t, 'R', 'r'));
  must(postEntry(t.ctx, simpleEntry(t.accounts, 100, 'fy1')));
  // Back to the continuous default with prefix R2026-: the continuous run has not started, so ANY number could
  // be adopted there; the existing `R2026-0001` leaves `0001`, which no number reads (no leading zero), so the
  // change passes. (Adoption also skips an old number whose display is taken: defence in depth behind this.)
  must(setPrefix(t, 'R2026-', 'r2'));
  must(trySet(t, 'ledger.belegnummer_mode', 'continue_migrated', 'cm'));
  const imp = must(
    postEntry(t.ctx, {
      ...simpleEntry(t.accounts, 100, 'imp'),
      source: 'import',
      ref: '7',
    }),
  ).entryId;
  must(postEntry(t.ctx, simpleEntry(t.accounts, 100, 'native')));
  assert.equal(t.store.db.prepare('SELECT display FROM journal_entry_number WHERE entry_id = ?').get(imp).display, 'R2026-7');
  assert.deepEqual(dupes(t), []);
});
