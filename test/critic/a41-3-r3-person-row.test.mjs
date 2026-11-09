// Critic A41.3 r3 (non-author), probe group P: the two deliberate calls around a PERSON's assignment.
//  (ii) a machine may move a person-assigned file; can a machine then make that receipt the evidence of ANOTHER
//       booking, leaving the person's row active and pointing at a receipt that is no longer its line's?
//  and whether the `closeAssignment` chokepoint's ReceiptGuardAbort leaves partial writes behind on the doors
//  that reach it (capture_commit, ignore_bank_line).
//
// SYNTHETIC BY CONSTRUCTION: invented vendors, amounts and dates.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { must, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, at, proposalOf, decisionOf, entryCount, TELCO } from '../banking/n04-autobook-support.mjs';
import { receipt, assignBeleg, assignmentsOf } from '../banking/a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

function world(tag) {
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'critic', idempotencyKey: `rb-${tag}` }));
  at(t, '2026-07-20T08:00:00.000Z');
  const [held] = debits(t, [1470], { from: '2026-04-01' });
  const r = receipt(t, { amount: 1470, vendor: TELCO, date: '2026-03-01' });
  must(assignBeleg(t, held, [r.fileId]));
  for (const capability of ['close-period', 'post', 'customize']) {
    must(getAction('set_agent_dial').run({ ...t.deps, actor: 'studio' }, { workspaceId: t.workspaceId, capability, level: 'auto', idempotencyKey: `${tag}-dial-${capability}` }));
  }
  return { t, held, r };
}
const rowsOf = (t, line) => assignmentsOf(t, line).map((a) => [a.source, a.state, a.release_reason]);
const PERSON_ACTIVE = [['person', 'active', null]];
const agent = (t, verb, input) => handleRest(verb, { workspaceId: t.workspaceId, ...input }, { ...t.deps, actor: 'agent' }).body;
const outcome = (b) => (b.ok === true ? (b.actionId !== undefined && b.status !== 'executed' && b.entryId === undefined ? 'drafted' : 'executed') : b.error);
const fileHome = (t, fileId) => t.store.db.prepare('SELECT entity_kind, entity_id FROM stored_file WHERE id = ?').get(fileId);
const captureStatus = (t, id) => t.store.db.prepare('SELECT status FROM captures WHERE id = ?').get(id).status;

test('P1: an agent books ANOTHER line with the receipt a person assigned to an open line; the person row is left active on a receipt that now evidences the other booking', () => {
  const { t, held, r } = world('p1');
  const [other] = debits(t, [1470], { from: '2026-04-20' });
  const res = agent(t, 'book_bank_line', { bankTxnId: other, target: proposalOf(t, other).target, attach: [{ fileId: r.fileId }], idempotencyKey: 'p1-b' });
  const state = {
    inboxSays: null,
    agentBooking: outcome(res),
    otherLine: decisionOf(t, other)?.state ?? null,
    personRow: rowsOf(t, held),
    file: fileHome(t, r.fileId),
    capture: captureStatus(t, r.captureId),
    bytesOn: t.store.db
      .prepare('SELECT entity_kind, entity_id FROM stored_file WHERE workspace_id = ? AND sha256 = (SELECT sha256 FROM stored_file WHERE id = ?) AND id != ? ORDER BY rowid')
      .all(t.workspaceId, r.fileId, r.fileId),
  };
  // The inbox still tells the person the line's receipt is this file.
  state.inboxSays = must(getAction('list_bank_inbox').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, bankTxnId: held, status: 'all' })).lines[0].belegAssignment?.files.map((f) => f.fileId);
  assert.deepEqual(
    { agentBooking: state.agentBooking, otherLine: state.otherLine, personRow: state.personRow },
    { agentBooking: 'receipt_assigned', otherLine: null, personRow: PERSON_ACTIVE },
    `only a person moves a receipt a person assigned; observed ${JSON.stringify(state)}`,
  );
});

test('P2: an agent files a person-assigned receipt onto a BOOKED line; the person row stays active on a receipt that now evidences that booking', () => {
  const { t, held, r } = world('p2');
  const [booked] = debits(t, [1470], { from: '2026-04-20' });
  bookAsProposed(t, booked);
  const res = agent(t, 'files_link', { fileId: r.fileId, entityKind: 'bank_txn', entityId: booked, idempotencyKey: 'p2-l' });
  const state = { files_link: outcome(res), personRow: rowsOf(t, held), file: fileHome(t, r.fileId), heldLine: decisionOf(t, held)?.state ?? null };
  assert.deepEqual(
    { files_link: state.files_link, personRow: state.personRow },
    { files_link: 'receipt_assigned', personRow: PERSON_ACTIVE },
    `a machine may move it off its line, but making it another booking's Beleg leaves the person row pointing at someone else's evidence; observed ${JSON.stringify(state)}`,
  );
});

test('P3 (partial writes): an agent\'s capture_commit of a person-assigned receipt is refused whole: no bill, no entry, the capture under review', () => {
  const { t, held, r } = world('p3');
  const vendor = must(getAction('create_contact').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, partyRole: 'vendor', name: TELCO, idempotencyKey: 'p3-v' })).contact.id;
  // Author, v3 (spec point 4): call (ii) is withdrawn, the machine move itself is refused now.
  assert.equal(outcome(agent(t, 'files_link', { fileId: r.fileId, entityKind: 'contact', entityId: vendor, idempotencyKey: 'p3-mv' })), 'receipt_assigned');
  const bills = () => t.store.db.prepare('SELECT COUNT(*) AS n FROM vendor_bill WHERE workspace_id = ?').get(t.workspaceId).n;
  const before = { bills: bills(), entries: entryCount(t) };
  const res = agent(t, 'capture_commit', { captureId: r.captureId, target: { kind: 'vendor_bill', vendorId: vendor, billDate: '2026-04-01', expenseAccountId: t.acc('6570') }, idempotencyKey: 'p3-c' });
  assert.equal(res.error, 'receipt_assigned', JSON.stringify(res));
  assert.deepEqual({ bills: bills(), entries: entryCount(t) }, { bills: before.bills, entries: before.entries }, 'nothing of the refused commit survives');
  assert.equal(captureStatus(t, r.captureId), 'needs_review');
  assert.deepEqual(rowsOf(t, held), PERSON_ACTIVE);
  assert.deepEqual(fileHome(t, r.fileId), { entity_kind: 'bank_txn', entity_id: held }, 'the file stays on its line (the move was refused), not on a bill');
  // A retry under the same key is refused again, not replayed as a success.
  assert.equal(agent(t, 'capture_commit', { captureId: r.captureId, target: { kind: 'vendor_bill', vendorId: vendor, billDate: '2026-04-01', expenseAccountId: t.acc('6570') }, idempotencyKey: 'p3-c' }).error, 'receipt_assigned');
});

test('P4 (partial writes): an agent\'s ignore_bank_line on a person-assigned line is refused whole: no decision, the row active', () => {
  const { t, held } = world('p4');
  const res = agent(t, 'ignore_bank_line', { bankTxnId: held, reason: 'booked_elsewhere', note: 'x', idempotencyKey: 'p4-i' });
  assert.notEqual(outcome(res), 'executed', JSON.stringify(res));
  assert.equal(decisionOf(t, held), undefined);
  assert.deepEqual(rowsOf(t, held), PERSON_ACTIVE);
});
