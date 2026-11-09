// A41 critic round 1 (non-author), probe group 4: assertions that BITE where the author's tests stay green
// under a mutation (each mutation was applied locally, never committed). Every test here PASSES on the
// author's code and goes red under the named mutation.
//
// B1 (mutation: drop `beleg.drop` after a booking) one receipt, two lines, one tick: the second line must not
//    even TRY to book with the receipt the first took (the stale pool). The author's I1 two-line test stays
//    green without the drop because the receipt guard refuses the second attempt (beleg_in_use) and the
//    digest recomputes.
// B2 (mutation: the pool ignores liveReceiptHolders) bytes that already evidence a POSTED entry through a
//    second filing row are never a candidate. The author's guard test stays green: its receipt leaves the
//    pool through its own link and status, never through the holder check.
// B3 (mutation: legsSignature without amounts) the same accounts with the amounts SWAPPED between them are
//    another booking. The author's S3 split uses a different leg count, which differs without amounts too.
//
// SYNTHETIC BY CONSTRUCTION: invented counterparties, IBANs, amounts and dates.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { makeContext } from '../../dist/core/context.js';
import { grantRuleAutobook, runAutobookStep } from '../../dist/core/banking/autobook.js';
import { listBankInbox } from '../../dist/core/banking/index.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { getFileContent, uploadFile, linkFile } from '../../dist/core/files/index.js';
import { setBankStandard } from '../../dist/core/banking/bankStandards.js';
import { readBankTxn, readBankTxnDetail } from '../../dist/core/banking/bankLines.js';
import { evidenceContext, evidenceForBooking } from '../../dist/core/banking/belegEvidence.js';
import { must, world, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, at, TELCO } from '../banking/n04-autobook-support.mjs';
import { receipt, lines, confirmedReceipt } from '../banking/a41-beleg-support.mjs';

// A41.3 re-cut v2 (D184, built 07.11.2026): the findings below run live against the assignment design. A probe
// whose premise the re-cut changed says so in its body (the verdict reads only the line's assignment).

afterEach(assertClaimInvariantHolds);

test('B1 (amended for LOW 8): one receipt, two lines, one tick: neither line tries to book with it', () => {
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  const grantId = must(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: 'grant-b1' })).grant.grantId;
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'critic', idempotencyKey: 'rb-b1' }));
  at(t, '2026-07-20T08:00:00.000Z');
  const [a, b] = debits(t, [1700, 1700]);
  const d = t.store.db.prepare('SELECT booking_date FROM bank_txn WHERE id = ?').get(a).booking_date;
  const mid = new Date(Date.parse(`${d}T00:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10);
  // Re-cut: a person confirmed the figures, so only the ambiguity keeps the engine from pairing it.
  confirmedReceipt(t, { amount: 1700, vendor: TELCO, date: mid });
  const base = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'system', clock: t.clock, ids: t.ids });
  const calls = [];
  const book = (actor, input) => {
    calls.push(input.bankTxnId);
    return getAction('book_bank_line').run({ ...t.deps, actor }, input);
  };
  const report = runAutobookStep(base, { holdsPost: () => true, book });
  // Amended by the author for the round-1 LOW 8 fix ("exactly one" in both directions): a receipt that fits
  // two lines is booked with neither, so not even one call reaches book_bank_line.
  assert.equal(report.booked.length, 0);
  assert.deepEqual(calls.length, 0, `book_bank_line was called for ${JSON.stringify(calls)}: an ambiguous receipt was booked`);
  // Re-cut premise: the verdict reads only the assignment, so an unpaired line waits no_beleg (the reason
  // beleg_ambiguous is gone); the engine assigned the receipt to neither line.
  assert.deepEqual(report.waiting.map((w) => [w.grantId, w.reason]), [[grantId, 'no_beleg'], [grantId, 'no_beleg']]);
  assert.deepEqual(report.assignments.created, []);
  void b;
});

test('B2: bytes a posted entry already holds through another filing row are never a candidate', () => {
  const t = world();
  const r = receipt(t, { amount: 7300, date: '2026-07-23' });
  const [line] = lines(t, [{ amount: 7300, date: '2026-07-23' }]);
  const cands = () => must(listBankInbox(t.ctx, { bankTxnId: line, status: 'all' })).lines[0].belegCandidates;
  assert.equal(cands().length, 1, 'before: the receipt fits');
  const content = must(getFileContent(t.ctx, { fileId: r.fileId }));
  const twin = must(uploadFile(t.ctx, { contentBase64: content.contentBase64, mime: 'image/png', filename: 'zwilling.png', title: 'Zwilling' })).file.id;
  const entry = must(postEntry(t.ctx, { date: '2026-02-02', source: 'manual', description: 'Zwilling', idempotencyKey: 'b2-entry', lines: [{ account: t.acc('6570'), debit: 7300 }, { account: t.acc('1020'), credit: 7300 }] })).entryId;
  must(linkFile(t.ctx, { fileId: twin, entityKind: 'journal_entry', entityId: entry }));
  assert.deepEqual(cands(), [], 'the same bytes evidence a posted entry: never offered (R1)');
});

test('B3: the same accounts with the amounts swapped between them never inherit the engine certainty', () => {
  const t = world();
  must(settingsSet(t.ctx, { key: 'bank.buchungsregel_computed_mode', value: 'bulk', reason: 'critic', idempotencyKey: 'cm-b3' }));
  const cp = { name: 'Tausch Beispiel AG', iban: 'CH4431999123000889012' };
  const [first] = lines(t, [{ amount: 1000, date: '2026-05-02', ...cp }]);
  const ruleId = must(
    setBankStandard(t.ctx, {
      bankTxnId: first,
      legs: [
        { accountId: t.acc('6600'), amount: { kind: 'factor', label: 'Drittel', num: 1, den: 3 } },
        { accountId: t.acc('6500'), amount: { kind: 'rest' } },
      ],
      idempotencyKey: 'r-b3',
    }),
  ).standard.id;
  const [line] = lines(t, [{ amount: 9000, date: '2026-05-10', ...cp }]);
  const row = readBankTxn(t.ctx, line);
  const ev = (target) => evidenceForBooking(t.ctx, evidenceContext(t.ctx), row, readBankTxnDetail(t.ctx, line), null, target, undefined);
  const same = ev({ kind: 'rule', standardId: ruleId, asks: {} });
  assert.equal(same.engine.reasonCode, 'rule_computed');
  assert.equal(same.engine.certainty, 'sure', 'the engine is sure of its own computed split');
  assert.equal(same.agrees, true);
  const swapped = ev({ kind: 'accounts', legs: [{ accountId: t.acc('6600'), amountMinor: 6000 }, { accountId: t.acc('6500'), amountMinor: 3000 }] });
  assert.equal(swapped.agrees, false, 'amounts swapped between the same two accounts');
  assert.equal(swapped.certainty, 'check');
});
