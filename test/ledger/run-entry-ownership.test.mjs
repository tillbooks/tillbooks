/**
 * The raw `reverse_entry` refuses a depreciation run's and an inventory valuation run's journal
 * (governance check, 28.09.2026; owner decision: the row-backed sources WITH an undo verb join the
 * ownership map now). The sibling of `document-entry-ownership.test.mjs`.
 *
 * Measured before the fix: the raw Storno of a posted run's journal returned ok, the run still read
 * `posted`, and the run's own reverse (`asset_depreciation_run_reverse`, `inventory_valuation_reverse`)
 * then refused `already_reversed` for good. The asset kept an accumulated depreciation the journal no
 * longer carried; the next valuation measured its delta against a baseline that was gone.
 *
 * The worlds are the conformance contract's own seeds (`SCENARIOS.<verb>_reverse` hands back a POSTED
 * run and the owner verb's input), so this file cannot drift from the fixtures the gate already runs.
 *
 * HOW IT BITES: delete the `asset_depreciation` / `inventory_valuation` resolvers from
 * `OWNED_REVERSAL_SOURCES` and each raw refusal below turns into ok with the run left `posted`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { SCENARIOS, fixture } from '../api/conformance-contract.mjs';

function studio(fx, name, input) {
  return getAction(name).run({ ...fx.deps, actor: 'studio' }, { workspaceId: fx.workspaceId, ...input });
}

const CASES = [
  { owner: 'asset_depreciation_run_reverse', table: 'asset_depreciation_run' },
  { owner: 'inventory_valuation_reverse', table: 'inventory_valuation_run' },
];

for (const { owner, table } of CASES) {
  test(`raw reverse_entry on a posted ${table} journal refuses owned_by ${owner}; the owner still reverses it`, () => {
    const fx = fixture();
    const ownerInput = SCENARIOS[owner](fx);
    const run = () => fx.deps.store.db.prepare(`SELECT status, journal_entry_id AS e FROM ${table} WHERE workspace_id = ? AND id = ?`).get(fx.workspaceId, ownerInput.runId);
    assert.equal(run().status, 'posted', 'premise: the seed posted the run');
    const entryId = run().e;
    assert.equal(typeof entryId, 'string', 'premise: the run names its journal');

    const raw = studio(fx, 'reverse_entry', { entryId, idempotencyKey: 'raw' });
    assert.equal(raw.ok, false, `the raw Storno must not strand the run: ${JSON.stringify(raw)}`);
    assert.equal(raw.error, 'owned_by');
    assert.equal(raw.verb, owner);
    assert.equal(run().status, 'posted');

    const reversed = getAction(owner).run(fx.deps, ownerInput);
    assert.equal(reversed.ok, true, JSON.stringify(reversed));
    assert.equal(run().status, 'reversed');

    // The mirror is owned through the walk: reversing it raw would re-post the run's figures under a
    // run that reads reversed.
    const mirror = fx.deps.store.db.prepare('SELECT id FROM journal_entry WHERE workspace_id = ? AND reverses_entry_id = ?').get(fx.workspaceId, entryId);
    assert.ok(mirror, 'the owner minted the mirror');
    const rawMirror = studio(fx, 'reverse_entry', { entryId: mirror.id, idempotencyKey: 'raw-mirror' });
    assert.equal(rawMirror.ok, false, JSON.stringify(rawMirror));
    assert.equal(rawMirror.verb, owner);
    fx.deps.store.close();
  });
}

test('an opening inventory valuation is a posted run too: its journal refuses the raw Storno', () => {
  const fx = fixture();
  const opened = getAction('inventory_valuation_opening').run(fx.deps, SCENARIOS.inventory_valuation_opening(fx));
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const row = fx.deps.store.db
    .prepare("SELECT journal_entry_id AS e FROM inventory_valuation_run WHERE workspace_id = ? AND journal_entry_id IS NOT NULL")
    .get(fx.workspaceId);
  assert.ok(row, 'premise: the opening wrote a posted run naming its journal');
  const raw = studio(fx, 'reverse_entry', { entryId: row.e, idempotencyKey: 'raw' });
  assert.equal(raw.error, 'owned_by', JSON.stringify(raw));
  assert.equal(raw.verb, 'inventory_valuation_reverse');
  fx.deps.store.close();
});
