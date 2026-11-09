/**
 * CRITIC N3 (claude/rmap-land, coordinator ruling): A HUMAN-OWNED CHECKLIST STEP IS RECORDED BY A PERSON.
 *
 * The G22 templates give some steps to a human owner: the Abstimmung sign-off (`abstimmung_reviewed`), the
 * settlement sign-off (`settlement_booked`), the acknowledgement of a failed warn validation
 * (`validation_acknowledged`, e.g. `umsatzabstimmung` in the year close). `checklist_item_complete` is not
 * dial-governed for those evidence kinds, so the agent seat recorded them as its own with no Vorschlag.
 * Now every governed seat (the agent, a plugin call) is refused `needs_a_person` on a human-owned item,
 * before anything is written; agent- and system-owned items stay free, and a person records the step.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { runGoverned } from '../../dist/api/agent-gate.js';
import { runPluginToolCall } from '../../dist/core/plugins/sandbox.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

/** A fresh book; `at` moves the clock past a fiscal year's end so the year close can start. */
function world(seed, at) {
  const deps = at === undefined ? freshDeps() : { store: new SqliteStore({ clock: fixedClock(at) }), clock: fixedClock(at), ids: sequenceIdGen(), actor: 'agent' };
  const { workspaceId } = mintWorkspace(deps, 'Attest GmbH', `${seed}-ws`);
  const person = (name, input) => getAction(name).run({ ...deps, actor: 'studio' }, { workspaceId, ...input });
  const agent = (name, input) => runGoverned({ ...deps, actor: 'agent' }, getAction(name), { workspaceId, ...input });
  person('vat_seed_defaults', {});
  person('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  const signoffs = () => deps.store.db.prepare('SELECT kind, actor FROM checklist_signoff WHERE voided_at IS NULL').all().map((r) => ({ ...r }));
  return { deps, workspaceId, person, agent, signoffs };
}

const refusedForAPerson = (res, itemId) => {
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, 'capability_forbidden', JSON.stringify(res));
  assert.equal(res.reason, 'needs_a_person');
  assert.equal(res.itemId, itemId);
};

test('the agent seat is refused needs_a_person on the human sign-offs of the MWST-Periode, and nothing is recorded', () => {
  const w = world('vat');
  const runId = w.person('checklist_start', { templateId: 'vat_period', period: '2026-Q2', idempotencyKey: 's' }).runId;
  // The agent's own item stays free.
  const own = w.agent('checklist_item_complete', { runId, itemId: 'vat_return_computed', idempotencyKey: 'k4' });
  assert.equal(own.ok, true, JSON.stringify(own));
  for (const itemId of ['abstimmung_reviewed', 'settlement_booked']) {
    refusedForAPerson(w.agent('checklist_item_complete', { runId, itemId, evidence: { kind: 'signoff' }, idempotencyKey: `a-${itemId}` }), itemId);
  }
  assert.deepEqual(w.signoffs(), []);
  // A person records the step, and the sign-off names the person.
  const byPerson = w.person('checklist_item_complete', { runId, itemId: 'abstimmung_reviewed', evidence: { kind: 'signoff' }, idempotencyKey: 'p5' });
  assert.equal(byPerson.ok, true, JSON.stringify(byPerson));
  assert.deepEqual(w.signoffs(), [{ kind: 'abstimmung_reviewed', actor: 'studio' }]);
  w.deps.store.close();
});

test('a plugin call is a governed seat too: the human sign-off refuses it', () => {
  const w = world('plugin');
  const runId = w.person('checklist_start', { templateId: 'vat_period', period: '2026-Q2', idempotencyKey: 's' }).runId;
  w.person('checklist_item_complete', { runId, itemId: 'vat_return_computed', idempotencyKey: 'p4' });
  const invoke = (tool, input, actor) => getAction(tool).run({ ...w.deps, actor }, input);
  const res = runPluginToolCall(invoke, {
    grantedScopes: ['mcp_tool:checklist_item_complete'],
    pluginActor: 'studio',
    tool: 'checklist_item_complete',
    input: { workspaceId: w.workspaceId, runId, itemId: 'abstimmung_reviewed', evidence: { kind: 'signoff' }, idempotencyKey: 'pl5' },
  });
  refusedForAPerson(res, 'abstimmung_reviewed');
  assert.deepEqual(w.signoffs(), []);
  w.deps.store.close();
});

test('the acknowledgement of a human-owned validation (validation_acknowledged) refuses the agent seat', () => {
  const w = world('year', '2027-02-15T09:00:00.000Z');
  const run = w.person('checklist_start', { templateId: 'year_close', period: '2026', idempotencyKey: 'y' });
  assert.equal(run.ok, true, JSON.stringify(run));
  refusedForAPerson(
    w.agent('checklist_item_complete', { runId: run.runId, itemId: 'umsatzabstimmung', evidence: { kind: 'signoff', ref: 'Abweichung erklärt.' }, idempotencyKey: 'ack' }),
    'umsatzabstimmung',
  );
  assert.deepEqual(w.signoffs(), []);
  w.deps.store.close();
});
