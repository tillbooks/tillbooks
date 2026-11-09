// Critic A41.3 r1 (non-author), probe group L: every door that decides a line consumes or releases the
// line's assignment (I-D), and a consumed assignment leaves no receipt half-settled.
//
// SYNTHETIC BY CONSTRUCTION: invented vendors, amounts and dates.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { reconcileEngineAssignments } from '../../dist/core/banking/belegAssignment.js';
import { STATEMENT_COVERS_SQL } from '../../dist/core/banking/bankInbox.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { must, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, autopilot, at, proposalOf, decisionOf, TELCO } from '../banking/n04-autobook-support.mjs';
import { receipt, confirmedReceipt, assignBeleg, activeOf, assignmentsOf } from '../banking/a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

const LATER = '2026-07-20T08:00:00.000Z';

function world(tag) {
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'critic', idempotencyKey: `rb-${tag}` }));
  at(t, LATER);
  return { ...t, ap: autopilot(t) };
}
const dateOf = (t, line) => t.store.db.prepare('SELECT booking_date FROM bank_txn WHERE id = ?').get(line).booking_date;
const states = (t, line) => assignmentsOf(t, line).map((a) => [a.source, a.state, a.release_reason, a.entry_id !== null]);
const captureStatus = (t, id) => t.store.db.prepare('SELECT status FROM captures WHERE id = ?').get(id).status;
const book = (t, line, extra, k) =>
  must(getAction('book_bank_line').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, bankTxnId: line, target: proposalOf(t, line).target, idempotencyKey: k, ...extra }));

test('L1 (held): a person books a line with its engine-assigned receipt attached: consumed with the entry, the capture settled', () => {
  const t = world('l1');
  const [line] = debits(t, [1710], { from: '2026-07-19' });
  const r = confirmedReceipt(t, { amount: 1710, vendor: TELCO, date: dateOf(t, line) });
  reconcileEngineAssignments(t.ctx, STATEMENT_COVERS_SQL);
  assert.equal(activeOf(t, line)?.source, 'engine_unique');
  book(t, line, { attach: [{ fileId: r.fileId }] }, 'l1-b');
  assert.deepEqual(states(t, line), [['engine_unique', 'consumed', null, true]]);
  assert.equal(captureStatus(t, r.captureId), 'committed');
});

test('L2 (held): a person books it WITHOUT the receipt: released line_decided, and the receipt is free for another line', () => {
  const t = world('l2');
  const [line] = debits(t, [1720], { from: '2026-07-19' });
  const r = confirmedReceipt(t, { amount: 1720, vendor: TELCO, date: dateOf(t, line) });
  reconcileEngineAssignments(t.ctx, STATEMENT_COVERS_SQL);
  book(t, line, {}, 'l2-b');
  assert.deepEqual(states(t, line), [['engine_unique', 'released', 'line_decided', false]]);
  assert.equal(captureStatus(t, r.captureId), 'needs_review');
  assert.equal(t.store.db.prepare("SELECT COUNT(*) AS n FROM beleg_assignment_file WHERE capture_id = ? AND active = 1").get(r.captureId).n, 0);
});

test('L3 (held): ignore releases, the matching door (book with attach of ANOTHER receipt) releases, never consumes', () => {
  const t = world('l3');
  const [a, b] = debits(t, [1730, 1740], { from: '2026-07-19' });
  confirmedReceipt(t, { amount: 1730, vendor: TELCO, date: dateOf(t, a) });
  confirmedReceipt(t, { amount: 1740, vendor: TELCO, date: dateOf(t, b) });
  reconcileEngineAssignments(t.ctx, STATEMENT_COVERS_SQL);
  must(getAction('ignore_bank_line').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, bankTxnId: a, reason: 'booked_elsewhere', note: 'probe', idempotencyKey: 'l3-i' }));
  assert.deepEqual(states(t, a), [['engine_unique', 'released', 'line_ignored', false]]);
  const other = receipt(t, { amount: 1740, vendor: 'Anderer Lieferant AG', date: '2026-01-01' });
  book(t, b, { attach: [{ fileId: other.fileId }] }, 'l3-b');
  assert.deepEqual(states(t, b), [['engine_unique', 'released', 'line_decided', false]], 'a booking carrying another receipt does not consume this one');
});

test('L4 (held): a person books a line holding a PERSON assignment without re-attaching: consumed, and its capture settled with it', () => {
  const t = world('l4');
  const [line] = debits(t, [1750], { from: '2026-07-19' });
  const r = receipt(t, { amount: 1750, vendor: TELCO, date: dateOf(t, line) });
  // "Anhängen": the person files the receipt on the open line, the capture kept in review (r1 P4).
  must(assignBeleg(t, line, [r.fileId]));
  book(t, line, {}, 'l4-b');
  assert.equal(decisionOf(t, line)?.state, 'booked');
  assert.deepEqual(states(t, line), [['person', 'consumed', null, true]], 'consumed: the booking carries the receipt');
  // I-C: a booking that consumes the assignment settles the capture in the same transaction.
  const status = captureStatus(t, r.captureId);
  const commit = getAction('capture_commit').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, captureId: r.captureId, target: { kind: 'expense_line' }, idempotencyKey: 'l4-c' });
  assert.equal(status, 'committed', `the consumed receipt's capture is left ${status}; committing it now answers ${commit.ok ? 'ok' : commit.error}`);
});

