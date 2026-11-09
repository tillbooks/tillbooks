// Critic A41.3 r4 (non-author), the BUILT v3 ("one holder truth"): the reason table end to end, R4-1 (the bytes
// block), a machine smuggling `exceptAssignmentIds`, and divergence 4 (files_new_version under `move`).
//
// SYNTHETIC BY CONSTRUCTION: invented vendors, amounts and dates.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { reconcileEngineAssignments } from '../../dist/core/banking/belegAssignment.js';
import { STATEMENT_COVERS_SQL } from '../../dist/core/banking/bankInbox.js';
import { personBlocked } from '../../dist/core/banking/belegAssignmentStore.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { must, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, at, TELCO } from '../banking/n04-autobook-support.mjs';
import { receipt, confirmedReceipt, assignBeleg, activeOf, assignmentsOf, verb } from '../banking/a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

function world(tag) {
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'critic', idempotencyKey: `rb-${tag}` }));
  at(t, '2026-07-20T08:00:00.000Z');
  for (const capability of ['post', 'pay', 'close-period', 'customize']) {
    must(getAction('set_agent_dial').run({ ...t.deps, actor: 'studio' }, { workspaceId: t.workspaceId, capability, level: 'auto', idempotencyKey: `${tag}-dial-${capability}` }));
  }
  return t;
}
const reasons = (t, line) => assignmentsOf(t, line).map((a) => [a.source, a.state, a.release_reason]);
const agent = (t, name, input) => handleRest(name, { workspaceId: t.workspaceId, ...input }, { ...t.deps, actor: 'agent' }).body;
const pass = (t) => reconcileEngineAssignments(t.ctx, STATEMENT_COVERS_SQL);

test('V1 (held): the reason table end to end; a rejected receipt re-dropped as new bytes-identical file stays blocked (R4-1), even under agent trust', () => {
  const t = world('v1');
  must(settingsSet(t.ctx, { key: 'belege.autobook_figure_trust', value: 'agent', reason: 'critic: the widest trust', idempotencyKey: 'v1-ft' }));
  const [line] = debits(t, [90100], { from: '2026-07-19' });
  const bytes = Buffer.from('critic v1 beleg bytes').toString('base64');
  const intake = (k) => must(getAction('capture_document').run({ ...t.deps, actor: 'agent' }, { workspaceId: t.workspaceId, contentBase64: bytes, mime: 'application/pdf', filename: `${k}.pdf`, idempotencyKey: k }));
  const extract = (captureId, k) =>
    must(getAction('capture_extract').run({ ...t.deps, actor: 'agent' }, {
      workspaceId: t.workspaceId,
      captureId,
      source: 'agent',
      fields: [
        { key: 'amount', value: { minor: 90100, currency: 'CHF' }, confidence: 'high' },
        { key: 'vendor_name', value: TELCO, confidence: 'high' },
        { key: 'invoice_date', value: '2026-07-19', confidence: 'high' },
      ],
      idempotencyKey: k,
    }));
  const first = intake('v1-a');
  extract(first.captureId, 'v1-ax');
  pass(t);
  assert.equal(activeOf(t, line)?.source, 'engine_unique', 'precondition: under agent trust the engine pairs it');
  must(verb(t, 'release_beleg', { bankTxnId: line }));
  assert.deepEqual(reasons(t, line), [['engine_unique', 'released', 'person_rejected']], '"Lösen" of an engine row records person_rejected');
  // The agent discards the rejected capture and drops the very same bytes again: a NEW capture and a NEW file id.
  must(getAction('capture_discard').run({ ...t.deps, actor: 'agent' }, { workspaceId: t.workspaceId, captureId: first.captureId, reason: 'x', idempotencyKey: 'v1-d' }));
  const again = intake('v1-b');
  assert.notEqual(again.captureId, first.captureId);
  extract(again.captureId, 'v1-bx');
  const newFile = t.store.db.prepare('SELECT document_id FROM captures WHERE id = ?').get(again.captureId).document_id;
  assert.equal(personBlocked(t.ctx, line, newFile), true, 'the block follows the bytes');
  pass(t);
  pass(t);
  assert.equal(activeOf(t, line), undefined, 'the person said not this line; re-dropping the bytes does not undo it');
  // The named path back: a person's own assign_beleg lifts it.
  must(assignBeleg(t, line, [newFile]));
  assert.equal(activeOf(t, line)?.source, 'person');
  assert.equal(personBlocked(t.ctx, line, newFile), false);
});

test('V2 (held): implicit releases never block; capture_committed and person_overrode leave the pair free', () => {
  const t = world('v2');
  const [line] = debits(t, [90200], { from: '2026-07-19' });
  const r = confirmedReceipt(t, { amount: 90200, vendor: TELCO, date: '2026-07-19' });
  pass(t);
  assert.equal(activeOf(t, line)?.source, 'engine_unique');
  const vendor = must(getAction('create_contact').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, partyRole: 'vendor', name: TELCO, idempotencyKey: 'v2-v' })).contact.id;
  // A person attaches the engine-paired receipt to a draft bill: the engine row gives way, person_overrode.
  const bill = must(getAction('create_vendor_bill').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, vendorId: vendor, billDate: '2026-07-18', amountMinor: 90200, amountIsGross: true, expenseAccountId: t.acc('6570'), idempotencyKey: 'v2-b' })).vendorBillId;
  must(getAction('files_link').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, fileId: r.fileId, entityKind: 'vendor_bill', entityId: bill, idempotencyKey: 'v2-l' }));
  assert.deepEqual(reasons(t, line), [['engine_unique', 'released', 'person_overrode']]);
  assert.equal(personBlocked(t.ctx, line, r.fileId), false);
  // While the draft bill holds it, the engine never pairs it back.
  pass(t);
  assert.equal(activeOf(t, line), undefined, 'the draft bill holds the bytes');
});

test('V3 (held): an agent cannot smuggle exceptAssignmentIds through files_link', () => {
  const t = world('v3');
  const [held] = debits(t, [1930], { from: '2026-04-01' });
  const r = receipt(t, { amount: 1930, vendor: TELCO, date: '2026-03-01' });
  must(assignBeleg(t, held, [r.fileId]));
  const [booked] = debits(t, [1930], { from: '2026-05-01' });
  bookAsProposed(t, booked);
  const a = activeOf(t, held);
  const res = agent(t, 'files_link', { fileId: r.fileId, entityKind: 'bank_txn', entityId: booked, exceptAssignmentIds: [a.id], receipt: { exceptAssignmentIds: [a.id] }, idempotencyKey: 'v3-l' });
  assert.equal(res.error === 'receipt_assigned' || res.error === 'invalid_input', true, JSON.stringify(res));
  assert.deepEqual(reasons(t, held), [['person', 'active', null]]);
});

test('V4 (held, LOW gap recorded): under move, a person\'s new version of an assigned receipt stays filed on the line, unassignable; nothing books on its own', () => {
  const t = world('v4');
  must(settingsSet(t.ctx, { key: 'belege.assigned_move', value: 'move', reason: 'critic', idempotencyKey: 'v4-mv' }));
  const [held] = debits(t, [1940], { from: '2026-04-01' });
  const r = receipt(t, { amount: 1940, vendor: TELCO, date: '2026-03-01' });
  must(assignBeleg(t, held, [r.fileId]));
  const v = must(getAction('files_new_version').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, fileId: r.fileId, contentBase64: Buffer.from('bessere Fassung v4').toString('base64'), mime: 'image/png', idempotencyKey: 'v4-v' }));
  const head = v.file?.id ?? v.fileId;
  const onLine = t.store.db.prepare("SELECT id FROM stored_file WHERE workspace_id = ? AND entity_kind = 'bank_txn' AND entity_id = ?").all(t.workspaceId, held).map((x) => x.id);
  const reassign = assignBeleg(t, held, [head]);
  // Divergence 4 (author): the new head stays on the line. The spec text says the line then "holds no receipt and is
  // re-pairable"; the build keeps the person's new version where they put it, but no capture stands behind it, so
  // assign_beleg refuses beleg_not_captured and the engine never pairs it. Fail-closed: the line waits for a person's
  // manual booking. Pinned so that a change on either side is a decision, not an accident.
  assert.deepEqual(reasons(t, held), [['person', 'released', 'person_moved']]);
  assert.deepEqual(onLine, [head], 'the new head is filed on the line');
  assert.equal(reassign.error, 'beleg_not_captured');
  assert.equal(activeOf(t, held), undefined);
});
