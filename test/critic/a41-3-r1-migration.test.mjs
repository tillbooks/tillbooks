// Critic A41.3 r1 (non-author), probe group G: the I-G migration's attribution SQL (generation 19). Only a
// filing whose filer is provably a person becomes a person assignment; an approval of ANOTHER filing never
// launders an agent's later move.
//
// SYNTHETIC BY CONSTRUCTION: invented vendors, amounts and dates.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { makeContext } from '../../dist/core/context.js';
import { enqueueDraftedAction } from '../../dist/core/agent/draftedActions.js';
import { DATA_MIGRATIONS } from '../../dist/core/store/migrations.js';
import { must, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { ruleWorld, debits, TELCO } from '../banking/n04-autobook-support.mjs';
import { receipt, assignmentsOf } from '../banking/a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

const migrate = (t) => {
  const m = DATA_MIGRATIONS.find((x) => x.generation === 19);
  t.store.db.transaction(() => m.apply(t.store.db))();
};
const legacy = (t, fileId) => t.store.db.prepare('UPDATE stored_file SET linked_by = NULL, linked_by_seat = NULL WHERE id = ?').run(fileId);

test('G1 (held): a person-approved files_link Vorschlag attributes its own filing; an agent\'s later move onto another line is not laundered by it', () => {
  const t = ruleWorld();
  const [approvedLine, movedTo] = debits(t, [1910, 1920], { from: '2026-07-10' });
  const a = receipt(t, { amount: 1910, vendor: TELCO, date: '2026-02-01' });
  const b = receipt(t, { amount: 1920, vendor: TELCO, date: '2026-02-01' });
  const agentCtx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: t.clock, ids: t.ids });
  const draft = (fileId, line, k) =>
    must(enqueueDraftedAction(agentCtx, { actionTool: 'files_link', payload: { workspaceId: t.workspaceId, fileId, entityKind: 'bank_txn', entityId: line, idempotencyKey: k }, dialCapability: null, idempotencyKey: `${k}-row` }));
  // A: the person approves the agent's filing of A on its line.
  must(getAction('approve_drafted_action').run({ ...t.deps, actor: 'studio' }, { workspaceId: t.workspaceId, actionId: draft(a.fileId, approvedLine, 'g1-a').actionId }));
  // B: the person approves B on the FIRST line; the agent then moves B to the second line on its own.
  must(getAction('approve_drafted_action').run({ ...t.deps, actor: 'studio' }, { workspaceId: t.workspaceId, actionId: draft(b.fileId, approvedLine, 'g1-b').actionId }));
  must(getAction('set_agent_dial').run({ ...t.deps, actor: 'studio' }, { workspaceId: t.workspaceId, capability: 'close-period', level: 'auto', idempotencyKey: 'g1-dial' }));
  const mv = handleRest('files_link', { workspaceId: t.workspaceId, fileId: b.fileId, entityKind: 'bank_txn', entityId: movedTo, idempotencyKey: 'g1-mv' }, { ...t.deps, actor: 'agent' }).body;
  assert.equal(mv.ok, true, JSON.stringify(mv));
  // A book from before this build: no recorded filer on either file.
  legacy(t, a.fileId);
  legacy(t, b.fileId);
  migrate(t);
  migrate(t);
  const rows = (line) => assignmentsOf(t, line).map((r) => [r.source, r.state, r.seat]);
  assert.deepEqual(rows(approvedLine), [['person', 'active', 'studio']], 'the approved filing becomes the approver\'s assignment, once');
  assert.deepEqual(rows(movedTo), [], 'an approval of B on another line does not attribute the agent\'s move');
});
