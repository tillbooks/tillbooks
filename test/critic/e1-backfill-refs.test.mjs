/**
 * CRITIC PROBES (bank-parity E1, the Belegnummer, D178 point 2). Non-author. Synthetic by construction.
 *
 * A test that FAILS here is a finding; a passing one is evidence the claim holds.
 *
 * PROBE: the backfill's ref rules on the shapes a bexio export can carry, run through the SAME catch-up
 * the generation-17 step runs (`numberUnnumberedEntries` on a book whose entries carry no number yet):
 *  - `1'204`, ` 42 `, `042`, `7.0` are never adopted; `2026` IS adopted (the hazard A02 §4b.3 states);
 *  - a native entry's integer ref never competes with a migrated one (only migrated refs are adopted);
 *  - a migrated ref above every native count puts the natives after it;
 *  - re-running writes nothing.
 * Every assertion here is the spec's stated rule; a pass records it as sound, including the hazard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { setup } from '../ledger/support.mjs';
import { postEntry, journalNumberingPlan } from '../../dist/core/ledger/index.js';
import { ENTRY_NUMBER_SCHEMA_SQL } from '../../dist/core/ledger/entryNumberSchema.js';
import { numberUnnumberedEntries } from '../../dist/core/ledger/entryNumber.js';
import { systemIdGen } from '../../dist/core/ids.js';

function must(r) {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

function post(t, date, key, source, ref) {
  return must(postEntry(t.ctx, { date, source, idempotencyKey: key, ...(ref === undefined ? {} : { ref }), lines: [
    { account: t.accounts['6500'], debit: 1000 },
    { account: t.accounts['1020'], credit: 1000 },
  ] })).entryId;
}

/** Back to the pre-upgrade state (the author's own recipe): no number rows, no journal counter, no marker. */
function unnumber(db) {
  for (const trig of ['journal_entry_number_no_delete', 'journal_number_seq_no_delete']) db.exec(`DROP TRIGGER IF EXISTS ${trig}`);
  db.exec("DELETE FROM journal_entry_number; DELETE FROM document_number_seq WHERE type = 'journal'; DELETE FROM journal_numbering_pending;");
  db.exec(ENTRY_NUMBER_SCHEMA_SQL);
}

const shown = (t, id) => {
  const r = t.store.db.prepare('SELECT display, origin FROM journal_entry_number WHERE entry_id = ?').get(id);
  return r === undefined ? null : `${r.display}${r.origin === 'adopted' ? '*' : ''}`;
};

test('[PROBE e1-refs, sound] the ref shapes, the native/migrated split, the 2026 hazard, and a re-run', () => {
  const t = setup();
  const ids = {
    apostrophe: post(t, '2025-01-02', 'r1', 'import', "1'204"),
    blanks: post(t, '2025-01-03', 'r2', 'import', ' 42 '),
    zero: post(t, '2025-01-04', 'r3', 'import', '042'),
    decimal: post(t, '2025-01-05', 'r4', 'import', '7.0'),
    five: post(t, '2025-01-06', 'r5', 'import', '5'),
    nativeFive: post(t, '2025-01-07', 'r6', 'manual', '5'),
    year: post(t, '2025-01-08', 'r7', 'import', '2026'),
    nativeLater: post(t, '2025-01-09', 'r8', 'manual'),
  };
  unnumber(t.store.db);
  const scope = { db: t.store.db, workspaceId: 'ws_1', at: '2026-10-21T00:00:00.000Z', ids: systemIdGen };
  numberUnnumberedEntries(scope);
  assert.deepEqual(
    Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, shown(t, id)])),
    {
      apostrophe: '2027',
      blanks: '2028',
      zero: '2029',
      decimal: '2030',
      five: '5*',
      nativeFive: '2031',
      year: '2026*',
      nativeLater: '2032',
    },
  );
  const plan = must(journalNumberingPlan(t.ctx));
  assert.equal(plan.migrated.highestMigratedNumber, 2026, 'the plan does surface the stray year as the highest migrated number');
  assert.equal(plan.migrated.nonNumericTotal, 4);
  // Re-run: nothing changes.
  const before = t.store.db.prepare('SELECT * FROM journal_entry_number ORDER BY number').all();
  assert.deepEqual(numberUnnumberedEntries(scope), []);
  assert.deepEqual(t.store.db.prepare('SELECT * FROM journal_entry_number ORDER BY number').all(), before);
});
