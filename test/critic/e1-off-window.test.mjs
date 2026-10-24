/**
 * CRITIC PROBES (bank-parity E1, the Belegnummer, D178 point 2). Non-author. Synthetic by construction.
 *
 * A test that FAILS here is a finding; a passing one is evidence the claim holds.
 *
 * PROBE: A02 §4b.3 / US-A02.8 say the catch-up makes "numbering is on" ALWAYS mean "every posted entry has
 * a number". The catch-up runs at the next numbered POSTING, not when the mode leaves `off`, so between
 * switching numbering on and the next booking the book reads mode on with unnumbered posted entries.
 *
 * And the off-mode statutory reading (OR 957a Abs. 2 Ziff. 2 and 5, GeBüV Art. 3): the backlog is
 * numbered after the run's current counter in (date, created_at, id) order, so a number can be
 * non-monotone in date relative to entries numbered before, exactly as a backdated booking already is.
 * That half PASSES and is recorded as sound: unique, append-only and gap-free per series still hold.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { setup, simpleEntry } from '../ledger/support.mjs';
import { postEntry, journalNumberingPlan } from '../../dist/core/ledger/index.js';
import { settingsSet } from '../../dist/core/settings/index.js';

function must(r) {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}
const setMode = (t, value, k) => must(settingsSet(t.ctx, { key: 'ledger.belegnummer_mode', value, reason: 'Probe', idempotencyKey: `m-${k}` }));
const on = (t, date, k) => must(postEntry(t.ctx, { ...simpleEntry(t.accounts, 1000, k), date })).entryId;
const numberOf = (t, id) => t.store.db.prepare('SELECT display FROM journal_entry_number WHERE entry_id = ?').get(id)?.display ?? null;

test('[PROBE e1-L2] once numbering is switched back on, no posted entry reads without a number', () => {
  const t = setup();
  on(t, '2026-03-01', 'a');
  setMode(t, 'off', 'off');
  on(t, '2026-03-02', 'b');
  setMode(t, 'continue_migrated', 'on');
  const plan = must(journalNumberingPlan(t.ctx));
  assert.equal(plan.settings.mode, 'continue_migrated');
  assert.equal(plan.counts.unnumbered, 0, `mode is on, yet ${plan.counts.unnumbered} posted entry reads without a number until the next booking`);
});

test('[PROBE e1-off-order, sound] the off backlog is numbered after the run, unique and gap-free; a date before an earlier number is allowed', () => {
  const t = setup();
  const jan = on(t, '2026-01-10', 'jan');
  const mar = on(t, '2026-03-10', 'mar');
  setMode(t, 'off', 'off');
  const feb = on(t, '2026-02-10', 'feb-backdated-while-off');
  const apr = on(t, '2026-04-10', 'apr-while-off');
  setMode(t, 'continue_migrated', 'on');
  const may = on(t, '2026-05-10', 'may');
  assert.deepEqual([jan, mar, feb, apr, may].map((id) => numberOf(t, id)), ['1', '2', '3', '4', '5']);
  const rows = t.store.db.prepare("SELECT number FROM journal_entry_number WHERE workspace_id = 'ws_1' ORDER BY number").all().map((r) => r.number);
  assert.deepEqual(rows, [1, 2, 3, 4, 5]);
});

// Author, after critic r1 L3: the sentence was reworded to what the code does (A02 §4b.4: an unnumbered entry
// outside the two catch-up states is NOT healed by the next posting; the positive guard keeps such entries from
// existing, and the plan shows one). The probe now asserts that documented behaviour instead of the old claim.
test('[PROBE e1-L3] A02 §4b.4: a hand-made unnumbered posted entry is not healed by the next posting, and the plan shows it', () => {
  const t = setup();
  on(t, '2026-03-01', 'first');
  // "Somehow": a posted row that never met the flip, written draft-then-flipped by hand (lines included).
  const db = t.store.db;
  db.prepare("INSERT INTO journal_entry (id, workspace_id, date, status, idempotency_key, source, created_at) VALUES ('stray', 'ws_1', '2026-03-02', 'draft', 'stray', 'manual', '2026-07-16T00:00:00.000Z')").run();
  db.prepare("INSERT INTO journal_line (id, entry_id, account_id, debit_minor, credit_minor, currency, base_debit_minor, base_credit_minor) VALUES ('sl1', 'stray', ?, 100, 0, 'CHF', 100, 0)").run(t.accounts['6500']);
  db.prepare("INSERT INTO journal_line (id, entry_id, account_id, debit_minor, credit_minor, currency, base_debit_minor, base_credit_minor) VALUES ('sl2', 'stray', ?, 0, 100, 'CHF', 0, 100)").run(t.accounts['1000']);
  db.prepare("UPDATE journal_entry SET status = 'posted' WHERE id = 'stray'").run();
  const next = on(t, '2026-03-03', 'next');
  assert.equal(numberOf(t, 'stray'), null, 'the hot path numbers only the entry it posted; it never scans the ledger');
  assert.equal(numberOf(t, next), '2');
  // Visible, not silent: the plan counts it and says what a catch-up would give it.
  const plan = must(journalNumberingPlan(t.ctx));
  assert.equal(plan.counts.unnumbered, 1);
  assert.equal(plan.pending, false);
  assert.deepEqual(plan.wouldAssign.map((w) => [w.entryId, w.display]), [['stray', '3']]);
});
