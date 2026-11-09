// A41 critic round 2 (non-author): variants of the round-1 findings the round-1 probes did not cover, and the
// new paths the fixes introduced. Tests named DEFECT are expected red on the author's tip; `sound` green.
//
// R1 a person clicks the Studio's "Anhängen" on an OPEN line (files_link, the capture stays pending, the r1 P4
//    fix): the receipt is now ON the line, but the autobook verdict only reads the pool, which excludes it, so
//    the line waits `no_beleg` forever although it carries exactly its receipt. The same click is how a person
//    resolves `beleg_ambiguous` ("a person picks").
// R2 P4 across reopen: a capture settled by booking its line stays committed after reopen_bank_line, and an
//    ignore then leaves it committed with no posting holding it (the fix's claim: a closed capture always has
//    a posting holding it).
// R3 (sound) receiptExpected: a split with one Kontoauszug leg and one ordinary leg expects a receipt.
// R4 (sound) V2 with mixed VAT codes and a leg against the line: computed equals booked.
// R5 (sound) E1 on an FX line: a receipt with no currency is never `sure` on a EUR line.
// R6 (sound) an ignored line's receipt, re-attached elsewhere, is never booked twice when the ignored line is
//    reopened and booked.
//
// SYNTHETIC BY CONSTRUCTION: invented counterparties, IBANs, amounts and dates.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { grantRuleAutobook, autobookDigest } from '../../dist/core/banking/autobook.js';
import { bookBankLine, ignoreBankLine, reopenBankLine } from '../../dist/core/banking/bankBooking.js';
import { readBankTxn } from '../../dist/core/banking/bankLines.js';
import * as belegEvidence from '../../dist/core/banking/belegEvidence.js';
// receiptExpected left with A41.3 (re-cut pending): the namespace import keeps this file loading.
const { computedVatOf } = belegEvidence;
const receiptExpected = (...args) => belegEvidence.receiptExpected(...args);
import { settingsSet } from '../../dist/core/settings/settings.js';
import { createBankAccount } from '../../dist/core/banking/index.js';
import { must, world, secondWorkspace, importLines, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, autopilot, decisionOf, at, TELCO } from '../banking/n04-autobook-support.mjs';
import { receipt, lines, confirmedReceipt, assignBeleg } from '../banking/a41-beleg-support.mjs';

// A41.3 re-cut v2 (D184, built 07.11.2026): the findings below run live against the assignment design. A probe
// whose premise the re-cut changed says so in its body (the verdict reads only the line's assignment).

afterEach(assertClaimInvariantHolds);

const captureStatus = (t, captureId) => t.store.db.prepare('SELECT status FROM captures WHERE id = ?').get(captureId).status;
const dateOf = (t, line) => t.store.db.prepare('SELECT booking_date FROM bank_txn WHERE id = ?').get(line).booking_date;
const link = (t, fileId, line, key) =>
  must(getAction('files_link').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, fileId, entityKind: 'bank_txn', entityId: line, idempotencyKey: key }));

test('R1 fixed: a receipt a person attached to the open line is that line\'s receipt, and the next tick books it', () => {
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: 'grant-r1' }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'critic', idempotencyKey: 'rb-r1' }));
  at(t, '2026-07-20T08:00:00.000Z');
  const ap = autopilot(t);
  const [line] = debits(t, [1400]);
  const r = receipt(t, { amount: 1400, vendor: TELCO, date: dateOf(t, line) });
  // The person is quicker than the tick: "Anhängen" on the open line. Re-cut premise: Anhängen is
  // assign_beleg (files_link never creates an assignment, so a bare filing would leave the line waiting).
  must(assignBeleg(t, line, [r.fileId]));
  for (let i = 0; i < 3; i++) ap.tick();
  const waiting = must(autobookDigest(t.ctx, {})).waitingForBeleg.filter((w) => w.bankTxnId === line).map((w) => w.reason);
  assert.equal(decisionOf(t, line)?.state, 'booked', `the line carries exactly its receipt, yet waits ${JSON.stringify(waiting)}`);
});

test('R2 fixed: settled by its booking, then reopened and ignored, the capture is back in the queue (no posting holds it)', () => {
  const t = world();
  const r = receipt(t, { amount: 4400, date: '2026-07-23' });
  const [line] = lines(t, [{ amount: 4400, date: '2026-07-23' }]);
  link(t, r.fileId, line, 'r2-link');
  must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 4400 }] }, idempotencyKey: 'r2-book' }));
  assert.equal(captureStatus(t, r.captureId), 'committed', 'the booking closed it (the r1 P4 fix)');
  must(reopenBankLine(t.ctx, { bankTxnId: line, reason: 'falsch gebucht', idempotencyKey: 'r2-reopen' }));
  must(ignoreBankLine(t.ctx, { bankTxnId: line, reason: 'booked_elsewhere', note: 'critic', idempotencyKey: 'r2-ign' }));
  const status = captureStatus(t, r.captureId);
  assert.equal(status, 'needs_review', `capture ${status} although no posting holds its receipt (line ignored, booking reversed)`);
});

test('R3 sound: a Kontoauszug leg beside an ordinary leg expects a receipt; Kontoauszug alone does not', () => {
  const t = world();
  const [line] = lines(t, [{ amount: 3000, date: '2026-07-10' }]);
  const row = readBankTxn(t.ctx, line);
  assert.equal(receiptExpected(t.ctx, row, { kind: 'accounts', legs: [{ accountId: t.acc('6900'), amountMinor: 3000 }] }), false);
  assert.equal(receiptExpected(t.ctx, row, { kind: 'accounts', legs: [{ accountId: t.acc('6900'), amountMinor: 1000 }, { accountId: t.acc('6570'), amountMinor: 2000 }] }), true);
});

test('R4 sound: mixed VAT codes and a leg against the line: the computed VAT is the booked VAT', () => {
  const t = world();
  const [line] = lines(t, [{ amount: 14000, date: '2026-07-14' }]);
  const target = {
    kind: 'accounts',
    legs: [
      { accountId: t.acc('6570'), amountMinor: 10000, taxCode: 'VST-M' },
      { accountId: t.acc('6500'), amountMinor: 5000, taxCode: 'VST-M26' },
      { accountId: t.acc('6570'), amountMinor: -1000, taxCode: 'VST-M' },
    ],
  };
  const shown = computedVatOf(t.ctx, readBankTxn(t.ctx, line), target);
  const booked = must(bookBankLine(t.ctx, { bankTxnId: line, target, idempotencyKey: 'r4' }));
  const s = t.store.db.prepare('SELECT COALESCE(SUM(tax_amount_minor), 0) AS s FROM journal_line WHERE entry_id = ? AND tax_code IS NOT NULL').get(booked.entryId).s;
  assert.equal(shown, Math.abs(s));
});

test('R6 sound: an ignored line\'s receipt booked elsewhere is never booked again on the reopened line', () => {
  const t = world();
  const r = receipt(t, { amount: 4500, date: '2026-07-24' });
  const [a, b] = lines(t, [
    { amount: 4500, date: '2026-07-24' },
    { amount: 4500, date: '2026-07-25' },
  ]);
  link(t, r.fileId, a, 'r6-link');
  must(ignoreBankLine(t.ctx, { bankTxnId: a, reason: 'booked_elsewhere', note: 'critic', idempotencyKey: 'r6-ign' }));
  const legs = [{ accountId: t.acc('6570'), amountMinor: 4500 }];
  must(bookBankLine(t.ctx, { bankTxnId: b, target: { kind: 'accounts', legs }, attach: [{ fileId: r.fileId }], idempotencyKey: 'r6-b' }));
  must(reopenBankLine(t.ctx, { bankTxnId: a, reason: 'doch buchen', idempotencyKey: 'r6-reopen' }));
  const again = bookBankLine(t.ctx, { bankTxnId: a, target: { kind: 'accounts', legs }, idempotencyKey: 'r6-a' });
  const sha = t.store.db.prepare('SELECT sha256 FROM stored_file WHERE id = ?').get(r.fileId).sha256;
  const holders = t.store.db
    .prepare(
      `SELECT f.entity_id FROM stored_file f JOIN bank_line_decision d ON d.workspace_id = f.workspace_id AND d.bank_txn_id = f.entity_id AND d.superseded_at IS NULL
        WHERE f.workspace_id = ? AND f.sha256 = ? AND f.entity_kind = 'bank_txn' AND d.state = 'booked'`,
    )
    .all(t.workspaceId, sha)
    .map((x) => x.entity_id);
  assert.ok(holders.length <= 1, `the same receipt evidences two booked lines ${JSON.stringify(holders)} (second booking ok=${again.ok})`);
});

test('R2 context fixed: the same reopen-then-ignore through the attach seam (N02) returns the capture to the queue too', () => {
  const t = world();
  const r = receipt(t, { amount: 4600, date: '2026-07-26' });
  const [line] = lines(t, [{ amount: 4600, date: '2026-07-26' }]);
  // The attach seam lives in the verb (the action layer), not in the core bookBankLine.
  must(getAction('book_bank_line').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, bankTxnId: line, target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 4600 }] }, attach: [{ fileId: r.fileId }], idempotencyKey: 'r2c-book' }));
  assert.equal(captureStatus(t, r.captureId), 'committed', 'the attach seam closed it');
  must(reopenBankLine(t.ctx, { bankTxnId: line, reason: 'falsch gebucht', idempotencyKey: 'r2c-reopen' }));
  must(ignoreBankLine(t.ctx, { bankTxnId: line, reason: 'booked_elsewhere', note: 'critic', idempotencyKey: 'r2c-ign' }));
  // Amended by the author (r2 R2, one invariant for both seams): the reopen took back the booking that held it.
  assert.equal(captureStatus(t, r.captureId), 'needs_review');
});

test('R8 §H-TENANT (bites the reverse read): another workspace\'s fitting line never makes this receipt ambiguous', () => {
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: 'grant-r8' }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'critic', idempotencyKey: 'rb-r8' }));
  at(t, '2026-07-20T08:00:00.000Z');
  const ap = autopilot(t);
  const [line] = debits(t, [1900]);
  const day = dateOf(t, line);
  confirmedReceipt(t, { amount: 1900, vendor: TELCO, date: day });
  // A second workspace with its own Bankkonto and a debit line of the same vendor, amount and day.
  const b = secondWorkspace(t);
  const bank = must(createBankAccount(b.ctx, { name: 'Nachbarkonto', iban: 'CH9300762011623852957', currency: 'CHF', ledgerAccountId: b.bankId, idempotencyKey: 'ib-b' }));
  importLines(t, { statementId: 'R8-B', seqNb: '1', from: day, to: day, entries: [{ ref: 'R8B1', cd: 'DBIT', name: TELCO, amountMinor: 1900, date: day }] }, { ctx: b.ctx, bankAccountId: bank.bankAccountId });
  ap.tick();
  assert.equal(decisionOf(t, line)?.state, 'booked', JSON.stringify(must(autobookDigest(t.ctx, {})).waitingForBeleg));
  const caps = getAction('list_captures').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId });
  for (const c of caps.captures ?? []) for (const l of c.bankLineCandidates ?? []) assert.notEqual(t.store.db.prepare('SELECT workspace_id FROM bank_txn WHERE id = ?').get(l.bankTxnId).workspace_id, b.workspaceId);
});

test('R7 recorded: an older receipt-less booking of the same vendor and amount makes the new line ambiguous', () => {
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  // A line booked by a person WITHOUT its receipt, before the gate was on (an "Ohne Beleg" line).
  const [old] = debits(t, [1800]);
  bookAsProposed(t, old);
  must(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: 'grant-r7' }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'critic', idempotencyKey: 'rb-r7' }));
  at(t, '2026-07-20T08:00:00.000Z');
  const ap = autopilot(t);
  // The next line, 5 days later (the support's stride), same amount; ITS receipt dated on its own day.
  const [line] = debits(t, [1800]);
  const r = confirmedReceipt(t, { amount: 1800, vendor: TELCO, date: dateOf(t, line) });
  for (let i = 0; i < 3; i++) ap.tick();
  const reasons = must(autobookDigest(t.ctx, {})).waitingForBeleg.filter((w) => w.bankTxnId === line).map((w) => w.reason);
  // Re-cut premise: the old line is a claimant, so the engine pairs the receipt with neither (no_beleg, the
  // reason beleg_ambiguous is gone). The known limit (r2 R7) is answered by one person's assign_beleg.
  assert.deepEqual({ booked: decisionOf(t, line)?.state ?? null, reasons }, { booked: null, reasons: ['no_beleg'] });
  must(assignBeleg(t, line, [r.fileId]));
  ap.tick();
  assert.equal(decisionOf(t, line)?.state, 'booked', 'one Anhängen settles the known limit');
});
