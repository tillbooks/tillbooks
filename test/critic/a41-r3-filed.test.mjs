// A41 critic round 3 (non-author): the r2 R1 fix (the autobook verdict reads receipts FILED on the line first,
// with no ambiguity check, "a person chose them") and the r2 R2 fix (a reopen takes the capture back).
//
// Q1 an AGENT, not a person, files the ambiguous receipt on one of two lines (files_link under its own dial);
//    the next tick autobooks that line: the "a person picks" rule is bypassed by a non-person.
// Q2 ANY file on the line (no capture behind it, so no amount to judge) satisfies the receipt gate.
// Q3 bytes a posted entry already holds, filed on the open line: autobook books it (one receipt, two bookings?).
// Q4 (sound) a currency-less receipt filed on a line that it does not fit waits beleg_amount_differs, also on
//    a EUR line.
// Q5 a receipt filed on open line A, then attached by a person to line B: A then autobooks with the same bytes.
// Q6 (sound) reopen / re-book / reopen is idempotent on capture rows, and the retention floor never goes down.
//
// SYNTHETIC BY CONSTRUCTION: invented counterparties, IBANs, amounts and dates.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { grantRuleAutobook, autobookDigest } from '../../dist/core/banking/autobook.js';
import { bookBankLine, reopenBankLine } from '../../dist/core/banking/bankBooking.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { getFileContent, uploadFile, linkFile } from '../../dist/core/files/index.js';
import { must, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, autopilot, decisionOf, at, TELCO } from '../banking/n04-autobook-support.mjs';
import { receipt, confirmedReceipt, assignBeleg } from '../banking/a41-beleg-support.mjs';

// A41.3 re-cut v2 (D184, built 07.11.2026): the findings below run live against the assignment design. A probe
// whose premise the re-cut changed says so in its body (the verdict reads only the line's assignment).

afterEach(assertClaimInvariantHolds);

const dateOf = (t, line) => t.store.db.prepare('SELECT booking_date FROM bank_txn WHERE id = ?').get(line).booking_date;
const captureStatus = (t, id) => t.store.db.prepare('SELECT status FROM captures WHERE id = ?').get(id).status;
const reasonsOf = (t, line) => must(autobookDigest(t.ctx, {})).waitingForBeleg.filter((w) => w.bankTxnId === line).map((w) => w.reason);

function gated() {
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: 'grant-q' }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'critic', idempotencyKey: 'rb-q' }));
  at(t, '2026-07-20T08:00:00.000Z');
  return { t, ap: autopilot(t) };
}

/** Two lines 5 days apart and one receipt between them: ambiguous, a person must pick. */
function ambiguous() {
  const { t, ap } = gated();
  const [a, b] = debits(t, [1700, 1700]);
  const mid = new Date(Date.parse(`${dateOf(t, a)}T00:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10);
  const r = confirmedReceipt(t, { amount: 1700, vendor: TELCO, date: mid });
  ap.tick();
  // Re-cut premise: the engine paired it with neither line, so both wait no_beleg (beleg_ambiguous is gone).
  assert.deepEqual([reasonsOf(t, a), reasonsOf(t, b)], [['no_beleg'], ['no_beleg']], 'precondition: a person must pick');
  return { t, ap, a, b, r };
}

test('Q1 DEFECT: an agent files the ambiguous receipt on one line and autobook books it with no person', () => {
  const { t, ap, a, r } = ambiguous();
  // A person opens the close-period dial (the family files_link drafts under), for the agent's filing work.
  must(getAction('set_agent_dial').run({ ...t.deps, actor: 'studio' }, { workspaceId: t.workspaceId, capability: 'close-period', level: 'auto', idempotencyKey: 'dial-cp' }));
  const res = handleRest('files_link', { workspaceId: t.workspaceId, fileId: r.fileId, entityKind: 'bank_txn', entityId: a, idempotencyKey: 'ag-link' }, { ...t.deps, actor: 'agent' }).body;
  // And the person's own verb is no door for the agent either.
  assert.equal(handleRest('assign_beleg', { workspaceId: t.workspaceId, bankTxnId: a, fileIds: [r.fileId], idempotencyKey: 'ag-assign' }, { ...t.deps, actor: 'agent' }).body.error, 'human_only');
  ap.tick();
  const state = decisionOf(t, a)?.state ?? null;
  assert.notEqual(state, 'booked', `the agent's files_link answered ${JSON.stringify(res).slice(0, 120)}; line A was then autobooked (channel ${decisionOf(t, a)?.channel}) although the receipt fits two lines and no person picked`);
});

test('Q1 control: under the default dial the agent only drafts, nothing books', () => {
  const { t, ap, a, r } = ambiguous();
  handleRest('files_link', { workspaceId: t.workspaceId, fileId: r.fileId, entityKind: 'bank_txn', entityId: a, idempotencyKey: 'ag-link-d' }, { ...t.deps, actor: 'agent' });
  ap.tick();
  assert.equal(decisionOf(t, a), undefined);
});

test('Q2 DEFECT: any file on the line, with no capture and no amount behind it, satisfies the receipt gate', () => {
  const { t, ap } = gated();
  const [line] = debits(t, [1500]);
  const doc = must(uploadFile(t.ctx, { contentBase64: Buffer.from('irgendein Dokument, kein Beleg').toString('base64'), mime: 'text/plain', filename: 'notiz.txt', title: 'Notiz' })).file.id;
  must(linkFile(t.ctx, { fileId: doc, entityKind: 'bank_txn', entityId: line }));
  ap.tick();
  assert.notEqual(decisionOf(t, line)?.state, 'booked', 'an uncaptured note on the line let autobook book under "needs its receipt", with no amount compared');
});

test('Q3: bytes a posted entry already holds, filed on the open line, never make a second booking evidenced by them', () => {
  const { t, ap } = gated();
  const [line] = debits(t, [1600]);
  const r = receipt(t, { amount: 1600, vendor: TELCO, date: dateOf(t, line) });
  const content = must(getFileContent(t.ctx, { fileId: r.fileId }));
  const twin = must(uploadFile(t.ctx, { contentBase64: content.contentBase64, mime: 'image/png', filename: 'zwilling.png', title: 'Zwilling' })).file.id;
  const entry = must(postEntry(t.ctx, { date: '2026-02-02', source: 'manual', description: 'Zwilling', idempotencyKey: 'q3-entry', lines: [{ account: t.acc('6570'), debit: 1600 }, { account: t.acc('1020'), credit: 1600 }] })).entryId;
  must(linkFile(t.ctx, { fileId: twin, entityKind: 'journal_entry', entityId: entry }));
  // The original is filed on the open line (no guard judges an open line; it is judged when booked).
  must(linkFile(t.ctx, { fileId: r.fileId, entityKind: 'bank_txn', entityId: line }));
  // Re-cut: nor can a person ASSIGN bytes a live booking holds.
  assert.equal(assignBeleg(t, line, [r.fileId]).error, 'receipt_already_booked');
  ap.tick();
  assert.notEqual(decisionOf(t, line)?.state, 'booked', `autobook booked a line whose only receipt already evidences entry ${entry}; reasons ${JSON.stringify(reasonsOf(t, line))}`);
});

test('Q4 sound: a currency-less receipt filed on a line it does not fit waits beleg_amount_differs', () => {
  const { t, ap } = gated();
  const [line] = debits(t, [1800]);
  const r = receipt(t, { amount: 9900, vendor: TELCO, date: dateOf(t, line) });
  // Restate the amount without its currency (capture_extract accepts it).
  must(getAction('capture_extract').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, captureId: r.captureId, source: 'agent', fields: [{ key: 'amount', value: { minor: 9900 }, confidence: 'high' }], idempotencyKey: 'q4-ex' }));
  // Re-cut: a person assigns it (files_link creates no assignment at all).
  must(assignBeleg(t, line, [r.fileId]));
  ap.tick();
  assert.equal(decisionOf(t, line), undefined);
  assert.deepEqual(reasonsOf(t, line), ['beleg_amount_differs']);
});

test('Q5: a receipt filed on line A and attached by a person to line B never also evidences A\'s autobooking', () => {
  const { t, ap } = gated();
  const [a, b] = debits(t, [1650, 1650]);
  const r = receipt(t, { amount: 1650, vendor: TELCO, date: dateOf(t, a) });
  must(linkFile(t.ctx, { fileId: r.fileId, entityKind: 'bank_txn', entityId: a }));
  const bookB = getAction('book_bank_line').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, bankTxnId: b, target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 1650 }] }, attach: [{ fileId: r.fileId }], idempotencyKey: 'q5-b' });
  ap.tick();
  const sha = t.store.db.prepare('SELECT sha256 FROM stored_file WHERE id = ?').get(r.fileId).sha256;
  const booked = t.store.db
    .prepare(
      `SELECT DISTINCT f.entity_id FROM stored_file f JOIN bank_line_decision d ON d.workspace_id = f.workspace_id AND d.bank_txn_id = f.entity_id AND d.superseded_at IS NULL
        WHERE f.workspace_id = ? AND f.sha256 = ? AND f.entity_kind = 'bank_txn' AND d.state = 'booked'`,
    )
    .all(t.workspaceId, sha)
    .map((x) => x.entity_id);
  assert.ok(booked.length <= 1, `one receipt evidences two booked lines ${JSON.stringify(booked)} (B booked ok=${bookB.ok})`);
});

test('Q6 sound: reopen, re-book, reopen is idempotent on capture rows and never lowers the retention floor', () => {
  // Author, the A41.3 split: the capture hold is kept, the receipt gate is not; the world no longer switches it.
  const t = ruleWorld();
  const [line] = debits(t, [1750]);
  const r = receipt(t, { amount: 1750, vendor: TELCO, date: dateOf(t, line) });
  const book = (k) => must(getAction('book_bank_line').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, bankTxnId: line, target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 1750 }] }, attach: [{ fileId: r.fileId }], idempotencyKey: k }));
  const floors = () => t.store.db.prepare('SELECT id, retention_statutory_until AS s, retention_until AS u FROM stored_file WHERE workspace_id = ? AND sha256 = (SELECT sha256 FROM stored_file WHERE id = ?) ORDER BY rowid').all(t.workspaceId, r.fileId);
  book('q6-1');
  assert.equal(captureStatus(t, r.captureId), 'committed');
  const floor1 = floors();
  assert.ok(floor1.some((f) => f.s !== null), 'the posted booking derived a floor');
  must(reopenBankLine(t.ctx, { bankTxnId: line, reason: 'falsch', idempotencyKey: 'q6-r1' }));
  assert.equal(captureStatus(t, r.captureId), 'needs_review');
  must(reopenBankLine(t.ctx, { bankTxnId: line, reason: 'falsch', idempotencyKey: 'q6-r1' }));
  for (const f of floors()) {
    const before = floor1.find((x) => x.id === f.id);
    if (before?.s) assert.ok(f.s >= before.s && f.u >= before.s, `floor lowered on ${f.id}`);
  }
  must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 1750 }] }, idempotencyKey: 'q6-2' }));
  assert.equal(captureStatus(t, r.captureId), 'committed', 'the re-booking closes it again (the filing row stayed on the line)');
  const settled = t.store.db.prepare('SELECT COUNT(*) AS n FROM capture_settlement WHERE capture_id = ?').get(r.captureId).n;
  assert.equal(settled, 2, 'one settlement row per booking that held it');
  must(reopenBankLine(t.ctx, { bankTxnId: line, reason: 'nochmals', idempotencyKey: 'q6-r2' }));
  assert.equal(captureStatus(t, r.captureId), 'needs_review');
});
