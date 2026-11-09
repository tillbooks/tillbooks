// Critic A41.3 r1 (non-author), probe group B: the invariants a mutation of the code left GREEN in the
// author's own suites (the mutation run is in the critic report). Each probe here holds today and goes red
// under the named mutation, so the invariant is asserted, not only documented.
//
//   M8  a governed seat's figure edit releases a person's row       -> B1
//   M10 the verdict no longer re-checks the assigned receipt         -> B2
//   M14 the append-only trigger lets a closed row move again          -> B3
//   M15 a person-held capture leaks back into the engine's pool       -> B4
//   M7  every decision consumes (never releases line_decided)         -> a41-3-r1-lifecycle L2, L3
//
// SYNTHETIC BY CONSTRUCTION: invented vendors, amounts and dates.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { grantRuleAutobook } from '../../dist/core/banking/autobook.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { must, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, autopilot, decisionOf, at, TELCO } from '../banking/n04-autobook-support.mjs';
import { receipt, confirmedReceipt, assignBeleg, activeOf, assignmentsOf } from '../banking/a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

const LATER = '2026-07-20T08:00:00.000Z';

function granted(tag) {
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: `grant-${tag}` }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'critic', idempotencyKey: `rb-${tag}` }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_scope', value: 'open_lines', reason: 'critic', idempotencyKey: `sc-${tag}` }));
  at(t, LATER);
  return { ...t, ap: autopilot(t) };
}
const dateOf = (t, line) => t.store.db.prepare('SELECT booking_date FROM bank_txn WHERE id = ?').get(line).booking_date;
const states = (t, line) => assignmentsOf(t, line).map((a) => [a.source, a.state, a.release_reason]);

test('B1 (M8): while a person\'s assignment stands, an agent\'s figure edit neither releases it nor stops the booking', () => {
  const t = granted('b1');
  const [line] = debits(t, [1810], { from: '2026-07-19' });
  const r = receipt(t, { amount: 1810, vendor: TELCO, date: '2026-03-01' });
  must(assignBeleg(t, line, [r.fileId]));
  must(getAction('capture_extract').run({ ...t.deps, actor: 'agent' }, { workspaceId: t.workspaceId, captureId: r.captureId, source: 'agent', fields: [{ key: 'amount', value: { minor: 9990, currency: 'CHF' }, confidence: 'high' }], idempotencyKey: 'b1-x' }));
  assert.deepEqual(states(t, line), [['person', 'active', null]], 'a governed edit is ignored while a person row stands');
  t.ap.tick();
  assert.equal(decisionOf(t, line)?.state, 'booked', 'the verdict judges the person\'s snapshot');
});

test('B2 (M10): a person-assigned receipt whose capture was discarded makes the line wait; nothing books', () => {
  const t = granted('b2');
  const [line] = debits(t, [1820], { from: '2026-07-19' });
  const r = receipt(t, { amount: 1820, vendor: TELCO, date: '2026-03-01' });
  must(assignBeleg(t, line, [r.fileId]));
  must(getAction('capture_discard').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, captureId: r.captureId, reason: 'probe', idempotencyKey: 'b2-d' }));
  t.ap.tick();
  assert.equal(decisionOf(t, line), undefined, 'the assigned receipt no longer stands');
  // Author, r1 fix R2 (orchestrator): the DISCARD (a person's act) now releases the person row itself,
  // capture_discarded, in its own transaction; the intent holds: the ENGINE never releases a person row.
  const rows = t.store.db.prepare('SELECT source, state, release_reason, closed_by FROM beleg_assignment WHERE workspace_id = ? AND bank_txn_id = ?').all(t.workspaceId, line);
  assert.deepEqual(rows.map((x) => [x.source, x.state, x.release_reason, x.closed_by]), [['person', 'released', 'capture_discarded', 'user_1']], 'the discard released it, never the engine');
});

test('B3 (M14): append-only, a released or consumed row never moves back, and its frozen snapshot never changes', () => {
  const t = granted('b3');
  const [line] = debits(t, [1830], { from: '2026-07-19' });
  confirmedReceipt(t, { amount: 1830, vendor: TELCO, date: dateOf(t, line) });
  t.ap.tick();
  assert.equal(decisionOf(t, line)?.state, 'booked');
  const consumed = assignmentsOf(t, line)[0];
  assert.equal(consumed.state, 'consumed');
  const db = t.store.db;
  assert.throws(() => db.prepare("UPDATE beleg_assignment SET state = 'active', closed_at = NULL, closed_by = NULL, entry_id = NULL WHERE id = ?").run(consumed.id), /only the state moves/);
  assert.throws(() => db.prepare("UPDATE beleg_assignment SET state = 'released', release_reason = 'person' WHERE id = ?").run(consumed.id), /only the state moves/);
  assert.throws(() => db.prepare('DELETE FROM beleg_assignment WHERE id = ?').run(consumed.id), /never deleted/);
  assert.throws(() => db.prepare('UPDATE beleg_assignment_file SET amount_minor = 1 WHERE assignment_id = ?').run(consumed.id), /frozen/);
  // A released row: never active, consumed or re-released again.
  const [other] = debits(t, [1840], { from: '2026-07-19' });
  must(assignBeleg(t, other, [receipt(t, { amount: 1840, vendor: TELCO, date: '2026-03-01' }).fileId]));
  must(getAction('release_beleg').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, bankTxnId: other, idempotencyKey: 'b3-r' }));
  const released = assignmentsOf(t, other)[0];
  assert.equal(released.state, 'released');
  for (const sql of [
    "UPDATE beleg_assignment SET state = 'active', release_reason = NULL, closed_at = NULL WHERE id = ?",
    "UPDATE beleg_assignment SET state = 'consumed', release_reason = NULL WHERE id = ?",
    "UPDATE beleg_assignment SET release_reason = 'line_decided' WHERE id = ?",
  ]) {
    assert.throws(() => db.prepare(sql).run(released.id), /only the state moves/, sql);
  }
  assert.throws(() => db.prepare('UPDATE beleg_assignment_file SET active = 1 WHERE assignment_id = ?').run(released.id), /frozen/);
});

test('B4 (M15): an agent unfiles a person-assigned receipt; the engine never pairs that capture with a second line, and the pass does not crash', () => {
  const t = granted('b4');
  const [held] = debits(t, [1850], { from: '2026-04-01' });
  const [fits] = debits(t, [1850], { from: '2026-07-19' });
  const r = confirmedReceipt(t, { amount: 1850, vendor: TELCO, date: dateOf(t, fits) });
  must(assignBeleg(t, held, [r.fileId]));
  // The agent moves the document off the line onto a contact (an open dial lets it file).
  must(getAction('set_agent_dial').run({ ...t.deps, actor: 'studio' }, { workspaceId: t.workspaceId, capability: 'close-period', level: 'auto', idempotencyKey: 'b4-dial' }));
  const contact = must(getAction('create_contact').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, partyRole: 'vendor', name: TELCO, idempotencyKey: 'b4-v' })).contact.id;
  const moved = handleRest('files_link', { workspaceId: t.workspaceId, fileId: r.fileId, entityKind: 'contact', entityId: contact, idempotencyKey: 'b4-mv' }, { ...t.deps, actor: 'agent' }).body;
  // Author, v3 (spec "A41.3 re-cut v3", point 4): the premise changes like r2 M3. A machine move of an assigned
  // row off its line is now refused; the pool exclusion this probe bites is reached by direct state setup.
  assert.equal(moved.error, 'receipt_assigned', JSON.stringify(moved));
  t.store.db.prepare("UPDATE stored_file SET entity_kind = 'contact', entity_id = ? WHERE id = ?").run(contact, r.fileId);
  assert.equal(t.store.db.prepare('SELECT entity_kind FROM stored_file WHERE id = ?').get(r.fileId).entity_kind, 'contact', 'precondition: the receipt is back in the pool by its filing');
  t.ap.tick();
  assert.deepEqual(assignmentsOf(t, fits), [], 'the capture a person holds is no other line\'s');
  assert.equal(decisionOf(t, fits), undefined);
  // The held line books with the person's receipt (the attach files it back on the line).
  assert.deepEqual(states(t, held), [['person', 'consumed', null]]);
  assert.equal(decisionOf(t, held)?.state, 'booked');
});
