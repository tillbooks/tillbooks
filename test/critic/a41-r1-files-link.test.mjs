// A41 critic round 1 (non-author), probe group 2: the declared deviation "files_link of a captured receipt
// closes the capture".
//
// P4 The Studio's one-click "Anhängen" (Bank.tsx attachCandidate, InboxRow clip) runs files_link onto the bank
//    line for an OPEN line too (the spec says book_bank_line attach for an open line). linkFile then closes the
//    capture "as booked by" a line that is NOT booked. When that line is then decided without a booking
//    (ignore_bank_line), the receipt has left Belege ohne Buchung as committed, with a settlement pointing at
//    an ignored line, and no booking evidences it: the capture can no longer be committed to its vendor bill.
//
// SYNTHETIC BY CONSTRUCTION: invented vendor, IBAN, amount and dates (a41-beleg-support.mjs).

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { listBankInbox } from '../../dist/core/banking/index.js';
import { ignoreBankLine } from '../../dist/core/banking/bankBooking.js';
import { must, world, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { receipt, lines } from '../banking/a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

const lineOf = (t, id) => must(listBankInbox(t.ctx, { bankTxnId: id, status: 'all' })).lines[0];
const captureStatus = (t, captureId) => t.store.db.prepare('SELECT status FROM captures WHERE id = ?').get(captureId).status;

test('P4 fixed: files_link onto an OPEN line keeps the capture under review until a booking holds it', () => {
  const t = world();
  const r = receipt(t, { amount: 4200, date: '2026-07-21' });
  const [line] = lines(t, [{ amount: 4200, date: '2026-07-21' }]);
  const before = lineOf(t, line);
  assert.equal(before.state, 'open');
  assert.equal(before.belegCandidates.length, 1, 'the Studio shows the one-click clip on this OPEN line');
  // What the Studio's attachCandidate sends for this line.
  const linked = getAction('files_link').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, fileId: r.fileId, entityKind: 'bank_txn', entityId: line, idempotencyKey: `a41-${line}-${r.fileId}` });
  assert.equal(linked.ok, true, JSON.stringify(linked));
  assert.equal(lineOf(t, line).state, 'open', 'the line is still open: nothing is booked');
  assert.equal(captureStatus(t, r.captureId), 'needs_review', `the capture closed as booked (settledCaptureId ${linked.settledCaptureId}) by a line that is not booked`);
});

test('P4 fixed (consequence): the line is then ignored, and the receipt stays in the queue', () => {
  const t = world();
  const r = receipt(t, { amount: 4300, date: '2026-07-22' });
  const [line] = lines(t, [{ amount: 4300, date: '2026-07-22' }]);
  must(getAction('files_link').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, fileId: r.fileId, entityKind: 'bank_txn', entityId: line, idempotencyKey: 'lk-open' }));
  must(ignoreBankLine(t.ctx, { bankTxnId: line, reason: 'booked_elsewhere', note: 'critic probe', idempotencyKey: 'ign-1' }));
  const settled = t.store.db.prepare('SELECT entity_kind, entity_id FROM capture_settlement WHERE capture_id = ?').all(r.captureId);
  const status = captureStatus(t, r.captureId);
  assert.equal(lineOf(t, line).state, 'ignored');
  assert.notEqual(status === 'committed' && settled.length === 1 ? 'orphaned' : 'fine', 'orphaned', `capture ${status}, settled on the IGNORED line ${JSON.stringify(settled)}: no booking evidences the receipt`);
});
