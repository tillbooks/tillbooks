/**
 * CRITIC PROBES, round 2 (bank-parity E1, the Belegnummer, D178 point 2 and point 18). Non-author.
 * Synthetic by construction: invented bexio-shaped refs (`Manuelle Buchung <n> (<n>)`), accounts and amounts.
 *
 * A test that FAILS here is a finding; a passing one is evidence the claim holds.
 *
 * PROBE: A02 §4b.3 states the rule-b residual (a late voucher at or above the run's next number takes TILL's
 * next number, which may equal an old voucher number not imported yet) and claims "Rule a makes the ordinary
 * cutover (the whole old journal before the first native booking) free of it". Two engine acts that are NOT a
 * native booking start the continuous run in the middle of an import, so the ordinary cutover falls into the
 * residual:
 *  - the REVERSAL of a wrongly imported entry (source `reversal`, the documented way to correct an import);
 *  - a CHANGE of a numbering setting (critic r1 L2's catch-up), e.g. choosing `suffix` for split vouchers after
 *    reading `journal_numbering_plan` half-way through the import, which is what the plan is for.
 * Either way a later bexio voucher gets a TILL Beleg-Nr. that is ANOTHER bexio voucher's number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { setup } from '../ledger/support.mjs';
import { postEntry, reverseEntry, listJournal, journalNumberingPlan } from '../../dist/core/ledger/index.js';
import { settingsSet } from '../../dist/core/settings/index.js';

function must(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

/** One bexio voucher, migrated: source import, the bexio ref shape, an invented amount. */
function voucher(t, n, date) {
  return must(
    postEntry(t.ctx, {
      date,
      source: 'import',
      ref: `Manuelle Buchung ${n} (${n})`,
      idempotencyKey: `bx-${n}`,
      lines: [
        { account: t.accounts['6500'], debit: 1000 + n },
        { account: t.accounts['1020'], credit: 1000 + n },
      ],
    }),
  ).entryId;
}

const numberOf = (t, id) => t.store.db.prepare('SELECT display FROM journal_entry_number WHERE entry_id = ?').get(id)?.display ?? null;

/** Every migrated voucher whose Beleg-Nr. is a DIFFERENT bexio voucher's number. */
function misnamed(t) {
  return t.store.db
    .prepare(
      `SELECT e.ref, n.display FROM journal_entry e JOIN journal_entry_number n ON n.entry_id = e.id
        WHERE e.source = 'import' AND e.ref LIKE 'Manuelle Buchung %' ORDER BY n.number`,
    )
    .all()
    .filter((r) => {
      const own = /\((\d+)\)$/.exec(r.ref)?.[1];
      return own !== r.display;
    })
    .map((r) => `${r.ref} reads Beleg-Nr. ${r.display}`);
}

test('[R2 PROBE M1-residual, reversal] correcting an import by reversal mid-import must not misnumber the rest of the old journal', () => {
  const t = setup();
  // Chunk 1 of the bexio journal.
  voucher(t, 1, '2025-01-03');
  const wrong = voucher(t, 2, '2025-01-04');
  voucher(t, 3, '2025-01-05');
  // Voucher 2 was imported onto the wrong account: the importer reverses it (and would re-post it).
  must(reverseEntry(t.ctx, { entryId: wrong, date: '2025-01-04', idempotencyKey: 'fix-2' }));
  // Chunk 2 of the SAME old journal: no native booking has been made yet.
  voucher(t, 4, '2025-01-06');
  voucher(t, 5, '2025-01-07');
  voucher(t, 6, '2025-01-08');
  const bad = misnamed(t);
  const hit = must(listJournal(t.ctx, { number: '5' })).entries.map((e) => e.ref);
  assert.deepEqual(bad, [], `a reversal started the run mid-import; Beleg-Nr. 5 now names ${JSON.stringify(hit)}`);
});

test('[R2 PROBE M1-residual, setting] choosing the split mode after reading the plan mid-import must not misnumber the rest', () => {
  const t = setup();
  voucher(t, 1, '2025-01-03');
  voucher(t, 2, '2025-01-04');
  voucher(t, 3, '2025-01-05');
  // Half-way through the import the owner reads the dry run and picks `suffix` for split vouchers.
  const plan = must(journalNumberingPlan(t.ctx));
  assert.equal(plan.pending, true, 'premise: the imports wait (rule a)');
  must(settingsSet(t.ctx, { key: 'ledger.belegnummer_split_voucher', value: 'suffix', reason: 'Probe', idempotencyKey: 'split' }));
  // Chunk 2 arrives in bexio's export order, which is not voucher order (7 before 4, 5; 6 was deleted in bexio).
  voucher(t, 7, '2025-01-06');
  voucher(t, 4, '2025-01-07');
  voucher(t, 5, '2025-01-08');
  const bad = misnamed(t);
  assert.deepEqual(bad, [], 'a split-mode change started the run mid-import');
});
