// A04, opening balances: the engine half.
//
// The invariants under test, and why each one is here rather than assumed:
//
//  - §H-LEDGER, the opening entry balances. An unbalanced set is REFUSED, never plugged, because
//    OR 958c Abs. 1 Ziff. 2 requires the Rechnungslegung to be `vollständig` and a silently absorbed
//    delta is the one shape that hides incompleteness behind a green tick.
//  - §H-AUDIT, the posted opening entry is immutable. OR 957a Abs. 2 Ziff. 5 puts `Nachprüfbarkeit`
//    on the books, so there is no edit path and a correction is a reversing entry.
//  - §H-IDEMPOTENT, asserted on ROWS. A retried import that returns the right entry id while posting
//    a second entry is exactly the defect worth catching, and a return value cannot see it.
//  - §H-PERIOD and A24, both DELEGATED to `postEntry`. A04 mints no capability check and no lock
//    check of its own, so what the tests pin is that the delegation actually happens.
//  - §H-TENANT, with the neighbour minted FIRST. See `support.mjs` for why the order is the test.
//
// BOTH SIGNS ARE TESTED EVERYWHERE A SIGN EXISTS. A total-level check cannot see a sign inversion
// that preserves totals, which is how an allocation bug shipped past a thorough review in A07.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  setOpeningBalances,
  getOpeningBalances,
  OPENING_CONTRA_ACCOUNT_NUMBER,
} from '../../dist/core/ledger/index.js';
import { postEntry, reverseEntry, hardCloseYear, lockPeriod } from '../../dist/core/ledger/index.js';
// A19, reached as a real caller would: the double-seed defect only shows up when both capabilities
// actually run, and a hand-rolled stand-in for `setBankOpeningBalance` would prove nothing about it.
import { createBankAccount, setBankOpeningBalance } from '../../dist/core/banking/index.js';
import {
  setup,
  neighbourWorkspace,
  seedOpeningContraAccount,
  numbersOf,
  legsOf,
  balanceOf,
  rowCounts,
  denying,
} from './support.mjs';

/**
 * The worked example from A04 §2 US-A04.1, in Rappen: 1020 Bank 12'500.00 debit, 1100 Debitoren
 * 3'400.00 debit, 2000 Kreditoren 1'900.00 credit, 2800 Eigenkapital 14'000.00 credit. It
 * self-balances at 15'900.00 a side, so no clearing residue may remain.
 */
function balancedSet(byNumber) {
  return [
    { account: byNumber['1020'], debitMinor: 1250000 },
    { account: byNumber['1100'], debitMinor: 340000 },
    { account: byNumber['2000'], creditMinor: 190000 },
    { account: byNumber['2800'], creditMinor: 1400000 },
  ];
}

// --- the happy path -----------------------------------------------------------------------------

test('a balanced set posts ONE opening entry carrying exactly the given lines, no clearing residue', () => {
  const { ctx, store, workspaceId, byNumber } = setup();

  const res = setOpeningBalances(ctx, { lines: balancedSet(byNumber), idempotencyKey: 'ob-1' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.differenceMinor, 0);

  const counts = rowCounts(store, workspaceId);
  assert.equal(counts.entries, 1, 'exactly ONE opening entry');
  assert.equal(counts.lines, 4, 'four lines, and no 9100 residue line');

  assert.deepEqual(legsOf(store, workspaceId, res.entryId), [
    { number: '1020', debit: 1250000, credit: 0 },
    { number: '1100', debit: 340000, credit: 0 },
    { number: '2000', debit: 0, credit: 190000 },
    { number: '2800', debit: 0, credit: 1400000 },
  ]);
  assert.equal(balanceOf(store, workspaceId, OPENING_CONTRA_ACCOUNT_NUMBER), 0, '9100 nets to 0.00');

  const row = store.db
    .prepare('SELECT date, source, status FROM journal_entry WHERE id = ?')
    .get(res.entryId);
  assert.deepEqual(row, { date: '2026-01-01', source: 'import', status: 'posted' });
});

test('asOf defaults to the fiscal-year start, and a non-January fiscal year moves it', () => {
  const july = setup({ fiscalYearStart: '07-01' });
  const res = setOpeningBalances(july.ctx, { lines: balancedSet(july.byNumber), idempotencyKey: 'ob-fy' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.asOf, '2026-07-01', 'the fiscal year containing the clock date starts here');

  const mid = setup();
  const explicit = setOpeningBalances(mid.ctx, {
    asOf: '2026-04-01',
    lines: balancedSet(mid.byNumber),
    idempotencyKey: 'ob-mid',
  });
  assert.equal(explicit.ok, true, JSON.stringify(explicit));
  assert.equal(explicit.asOf, '2026-04-01', 'a mid-year adoption keeps the date it was given');
  assert.equal(
    mid.store.db.prepare('SELECT date FROM journal_entry WHERE id = ?').get(explicit.entryId).date,
    '2026-04-01',
  );
});

test('a zero line is skipped rather than refused: an account with no opening position is not a position', () => {
  const { ctx, store, workspaceId, byNumber } = setup();
  const lines = [...balancedSet(byNumber), { account: byNumber['1000'], debitMinor: 0, creditMinor: 0 }];

  const res = setOpeningBalances(ctx, { lines, idempotencyKey: 'ob-zero' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(rowCounts(store, workspaceId).lines, 4, 'the 0.00 row contributed no line');
  assert.equal(legsOf(store, workspaceId, res.entryId).some((l) => l.number === '1000'), false);
});

// --- §H-AUDIT -----------------------------------------------------------------------------------

test('§H-AUDIT: the posted opening entry has no edit path, in either direction', () => {
  const { ctx, store, byNumber } = setup();
  const res = setOpeningBalances(ctx, { lines: balancedSet(byNumber), idempotencyKey: 'ob-imm' });

  assert.throws(
    () => store.db.prepare('UPDATE journal_entry SET date = ? WHERE id = ?').run('2026-02-02', res.entryId),
    /immutable|posted/i,
  );
  assert.throws(
    () => store.db.prepare('DELETE FROM journal_entry WHERE id = ?').run(res.entryId),
    /immutable|posted/i,
  );
  const lineId = store.db.prepare('SELECT id FROM journal_line WHERE entry_id = ? LIMIT 1').get(res.entryId).id;
  assert.throws(
    () => store.db.prepare('UPDATE journal_line SET debit_minor = 1 WHERE id = ?').run(lineId),
    /immutable|posted/i,
  );
});

// --- §H-LEDGER: the difference is never silently plugged ----------------------------------------

test('an unbalanced set with no differenceAccount writes NOTHING, both signs, exact Rappen', () => {
  const { ctx, store, workspaceId, byNumber } = setup();

  // Debit-heavy by 1 Rappen: 12'500.01 debit against 12'500.00 credit.
  const debitHeavy = setOpeningBalances(ctx, {
    lines: [
      { account: byNumber['1020'], debitMinor: 1250001 },
      { account: byNumber['2800'], creditMinor: 1250000 },
    ],
    idempotencyKey: 'ob-dh',
  });
  assert.equal(debitHeavy.ok, false);
  assert.equal(debitHeavy.error, 'unbalanced');
  assert.equal(debitHeavy.differenceMinor, 1, 'Sigma debit - Sigma credit, signed');
  assert.equal(debitHeavy.debitMinor, 1250001);
  assert.equal(debitHeavy.creditMinor, 1250000);
  assert.equal(
    debitHeavy.differenceAccountHint,
    OPENING_CONTRA_ACCOUNT_NUMBER,
    'the rejection names the way out instead of leaving the caller to guess',
  );

  // Credit-heavy by 1 Rappen: the SAME magnitude with the opposite sign. A check that reads
  // Math.abs, or one that only compares totals, cannot tell these two apart.
  const creditHeavy = setOpeningBalances(ctx, {
    lines: [
      { account: byNumber['1020'], debitMinor: 1250000 },
      { account: byNumber['2800'], creditMinor: 1250001 },
    ],
    idempotencyKey: 'ob-ch',
  });
  assert.equal(creditHeavy.error, 'unbalanced');
  assert.equal(creditHeavy.differenceMinor, -1, 'the opposite sign, not the same magnitude');

  assert.deepEqual(rowCounts(store, workspaceId), { entries: 0, lines: 0 }, 'neither rejection wrote');
});

test('an explicit differenceAccount books the delta on the CORRECT side, both signs', () => {
  // Debit-heavy: Sigma debit exceeds Sigma credit, so the clarification line must CREDIT.
  const a = setup();
  seedOpeningContraAccount(a.ctx);
  const aNums = numbersOf(a.store, a.workspaceId);
  const debitHeavy = setOpeningBalances(a.ctx, {
    lines: [
      { account: aNums['1020'], debitMinor: 1250000 },
      { account: aNums['2800'], creditMinor: 1200000 },
    ],
    differenceAccount: OPENING_CONTRA_ACCOUNT_NUMBER,
    idempotencyKey: 'ob-diff-d',
  });
  assert.equal(debitHeavy.ok, true, JSON.stringify(debitHeavy));
  assert.equal(debitHeavy.differenceMinor, 50000);
  assert.deepEqual(legsOf(a.store, a.workspaceId, debitHeavy.entryId), [
    { number: '1020', debit: 1250000, credit: 0 },
    { number: '2800', debit: 0, credit: 1200000 },
    { number: '9100', debit: 0, credit: 50000 },
  ]);
  // Sign, stated as a balance rather than as a side: 9100 carries a CREDIT balance of 500.00.
  assert.equal(balanceOf(a.store, a.workspaceId, '9100'), -50000);

  // Credit-heavy: the mirror. The clarification line must DEBIT, and a `Math.abs` on the delta
  // would put it on the same side as above while every total still tied out.
  const b = setup();
  seedOpeningContraAccount(b.ctx);
  const bNums = numbersOf(b.store, b.workspaceId);
  const creditHeavy = setOpeningBalances(b.ctx, {
    lines: [
      { account: bNums['1020'], debitMinor: 1200000 },
      { account: bNums['2800'], creditMinor: 1250000 },
    ],
    differenceAccount: OPENING_CONTRA_ACCOUNT_NUMBER,
    idempotencyKey: 'ob-diff-c',
  });
  assert.equal(creditHeavy.ok, true, JSON.stringify(creditHeavy));
  assert.equal(creditHeavy.differenceMinor, -50000);
  assert.deepEqual(legsOf(b.store, b.workspaceId, creditHeavy.entryId), [
    { number: '1020', debit: 1200000, credit: 0 },
    { number: '2800', debit: 0, credit: 1250000 },
    { number: '9100', debit: 50000, credit: 0 },
  ]);
  assert.equal(balanceOf(b.store, b.workspaceId, '9100'), 50000);
});

test('a differenceAccount on an ALREADY balanced set adds no line at all', () => {
  const { ctx, store, workspaceId, byNumber } = setup();
  seedOpeningContraAccount(ctx);
  const res = setOpeningBalances(ctx, {
    lines: balancedSet(byNumber),
    differenceAccount: OPENING_CONTRA_ACCOUNT_NUMBER,
    idempotencyKey: 'ob-nodiff',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(rowCounts(store, workspaceId).lines, 4, 'a 0.00 clearing line is not a line');
});

test('a differenceAccount that is not in the chart is refused, and nothing is written', () => {
  const { ctx, store, workspaceId, byNumber } = setup(); // 9100 deliberately NOT created
  const res = setOpeningBalances(ctx, {
    lines: [
      { account: byNumber['1020'], debitMinor: 1250000 },
      { account: byNumber['2800'], creditMinor: 1200000 },
    ],
    differenceAccount: OPENING_CONTRA_ACCOUNT_NUMBER,
    idempotencyKey: 'ob-nodiffacc',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unknown_account');
  assert.equal(res.account, '9100', 'the rejection names the account to restore, it does not invent it');
  assert.deepEqual(rowCounts(store, workspaceId), { entries: 0, lines: 0 });
});

// --- input discipline ---------------------------------------------------------------------------

test('a line with both sides, neither side, a negative, or a fraction is refused unwritten', () => {
  const { ctx, store, workspaceId, byNumber } = setup();
  const bad = (line, key) =>
    setOpeningBalances(ctx, {
      lines: [line, { account: byNumber['2800'], creditMinor: 100 }],
      idempotencyKey: key,
    });

  assert.equal(bad({ account: byNumber['1020'], debitMinor: 100, creditMinor: 100 }, 'b1').error, 'invalid_line');
  assert.equal(bad({ account: byNumber['1020'], debitMinor: -100 }, 'b2').error, 'invalid_line');
  assert.equal(bad({ account: byNumber['1020'], debitMinor: 100.5 }, 'b3').error, 'invalid_line');
  assert.equal(bad({ account: byNumber['1020'], creditMinor: -1 }, 'b4').error, 'invalid_line');
  assert.deepEqual(rowCounts(store, workspaceId), { entries: 0, lines: 0 });
});

test('an unknown account number is refused by NAME, never guessed at', () => {
  const { ctx, store, workspaceId, byNumber } = setup();
  const res = setOpeningBalances(ctx, {
    lines: [
      { account: '4711', debitMinor: 100 },
      { account: byNumber['2800'], creditMinor: 100 },
    ],
    idempotencyKey: 'ob-unknown',
  });
  assert.equal(res.error, 'unknown_account');
  assert.equal(res.account, '4711');
  assert.deepEqual(rowCounts(store, workspaceId), { entries: 0, lines: 0 });
});

test('an account named twice is refused: OR 958c Abs. 1 Ziff. 7 forbids pre-netting a position', () => {
  const { ctx, store, workspaceId, byNumber } = setup();
  // The Verrechnungsverbot in practice: two rows for 1020 mean the caller either double-counted or
  // netted an Aktivum against a Passivum before handing it over. Either way the position is not the
  // one the Beleg shows, and summing them would make it look like it was.
  const res = setOpeningBalances(ctx, {
    lines: [
      { account: byNumber['1020'], debitMinor: 1250000 },
      { account: byNumber['1020'], creditMinor: 250000 },
      { account: byNumber['2800'], creditMinor: 1000000 },
    ],
    idempotencyKey: 'ob-dup',
  });
  assert.equal(res.error, 'duplicate_account');
  assert.equal(res.number, '1020', 'the rejection names the account, not the row index');
  assert.deepEqual(rowCounts(store, workspaceId), { entries: 0, lines: 0 });
});

test('a resolved account is refused when it is the SAME account reached by id and by number', () => {
  const { ctx, byNumber } = setup();
  const res = setOpeningBalances(ctx, {
    lines: [
      { account: byNumber['1020'], debitMinor: 1250000 },
      { account: '1020', creditMinor: 250000 },
      { account: byNumber['2800'], creditMinor: 1000000 },
    ],
    idempotencyKey: 'ob-dup2',
  });
  assert.equal(res.error, 'duplicate_account', 'the check is on the RESOLVED account, not on the spelling');
});

test('an empty set, and a workspace with no chart, are told apart', () => {
  const { ctx } = setup();
  assert.equal(setOpeningBalances(ctx, { lines: [], idempotencyKey: 'ob-empty' }).error, 'invalid_input');

  const bare = setup();
  bare.store.db.prepare('DELETE FROM account WHERE workspace_id = ?').run(bare.workspaceId);
  const res = setOpeningBalances(bare.ctx, {
    lines: [{ account: '1020', debitMinor: 1 }, { account: '2800', creditMinor: 1 }],
    idempotencyKey: 'ob-nochart',
  });
  assert.equal(res.error, 'needs_chart', 'P9 scope degradation: the CTA is A01, not a per-account complaint');
});

// --- §H-IDEMPOTENT, on rows ---------------------------------------------------------------------

test('§H-IDEMPOTENT: the same key replays the same entry and the ledger moves exactly once', () => {
  const { ctx, store, workspaceId, byNumber } = setup();
  const first = setOpeningBalances(ctx, { lines: balancedSet(byNumber), idempotencyKey: 'ob-idem' });
  const afterFirst = rowCounts(store, workspaceId);

  const again = setOpeningBalances(ctx, { lines: balancedSet(byNumber), idempotencyKey: 'ob-idem' });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.entryId, first.entryId);
  // The rows, not the return value: a verb can hand back the right id and still post twice.
  assert.deepEqual(rowCounts(store, workspaceId), afterFirst);
  assert.equal(afterFirst.entries, 1);
  assert.equal(balanceOf(store, workspaceId, '1020'), 1250000, 'not double-counted');
});

test('a SECOND opening position under a DIFFERENT key is refused, not stacked', () => {
  const { ctx, store, workspaceId, byNumber } = setup();
  const first = setOpeningBalances(ctx, { lines: balancedSet(byNumber), idempotencyKey: 'ob-a' });

  const second = setOpeningBalances(ctx, { lines: balancedSet(byNumber), idempotencyKey: 'ob-b' });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'opening_balance_already_set');
  assert.equal(second.entryId, first.entryId, 'it names the entry that already holds the position');
  assert.equal(rowCounts(store, workspaceId).entries, 1);
  assert.equal(balanceOf(store, workspaceId, '1020'), 1250000);
});

// --- the storno correction path, which the refusal itself prescribes ----------------------------

test('the documented correction path WORKS: storno, then a fresh set under a new key', () => {
  // `opening_balance_already_set` names a reversing entry plus a fresh import as the way out. Until
  // the liveness walk landed, that refusal blocked the very remedy it prescribed, because a reversed
  // entry stayed `posted` (append-only, correctly) and so kept matching forever.
  const { ctx, store, workspaceId, byNumber } = setup();
  const first = setOpeningBalances(ctx, { lines: balancedSet(byNumber), idempotencyKey: 'ob-wrong' });
  assert.equal(first.ok, true, JSON.stringify(first));

  const storno = reverseEntry(ctx, { entryId: first.entryId, idempotencyKey: 'storno-1' });
  assert.equal(storno.ok, true, `the storno itself must take, else this test proves nothing: ${JSON.stringify(storno)}`);
  assert.equal(balanceOf(store, workspaceId, '1020'), 0, 'the storno really did unwind the position');

  const corrected = setOpeningBalances(ctx, {
    lines: [
      { account: byNumber['1020'], debitMinor: 900000 },
      { account: byNumber['2800'], creditMinor: 900000 },
    ],
    idempotencyKey: 'ob-corrected',
  });
  assert.equal(corrected.ok, true, `the prescribed remedy must be reachable: ${JSON.stringify(corrected)}`);
  assert.notEqual(corrected.entryId, first.entryId, 'a fresh entry, not the reversed one handed back');

  // On the LEDGER, not just in the return value: the old position is gone and only the new one stands.
  assert.equal(balanceOf(store, workspaceId, '1020'), 900000);
  assert.equal(balanceOf(store, workspaceId, '1100'), 0, 'a line only the WRONG set carried is not left behind');

  const read = getOpeningBalances(ctx, { year: '2026' });
  assert.equal(read.source, 'entry');
  assert.equal(read.entryId, corrected.entryId, 'the read follows the live entry, not the oldest one');
  assert.equal(read.totalDebitMinor, 900000);
});

test('a reversed position is NOT reported as live: the read model follows the ledger', () => {
  // The A08 shape: the answer sitting in the read model rather than in the ledger. After a storno the
  // ledger holds nothing, so `get_opening_balances` must say so instead of rendering a dead entry.
  const { ctx, store, workspaceId, byNumber } = setup();
  const first = setOpeningBalances(ctx, { lines: balancedSet(byNumber), idempotencyKey: 'ob-dead' });
  reverseEntry(ctx, { entryId: first.entryId, idempotencyKey: 'storno-dead' });

  const read = getOpeningBalances(ctx, { year: '2026' });
  assert.equal(read.source, 'none', `a reversed position is not a position: ${JSON.stringify(read)}`);
  assert.equal(read.entryId, null);
  assert.deepEqual(read.lines, []);
  assert.equal(read.totalDebitMinor, 0);
  assert.equal(read.totalCreditMinor, 0);
  // And it agrees with the ledger, which is the whole claim.
  assert.equal(balanceOf(store, workspaceId, '1020'), 0);
  // `editable` follows too: there IS no position, so seeding one is exactly the next move.
  assert.equal(read.editable, true);
});

test('a storno that is itself reversed REVIVES the position, and both surfaces follow', () => {
  // A02 lets a reversal be reversed, and entry_2 + entry_3 net to zero, so entry_1's amounts are back
  // on the accounts. A liveness test that merely asked "does a reversal row exist" would call the
  // position dead here and let a SECOND opening entry stack on a live one, double-counting every
  // account. Reversal DEPTH is the question, not reversal existence.
  const { ctx, store, workspaceId, byNumber } = setup();
  const first = setOpeningBalances(ctx, { lines: balancedSet(byNumber), idempotencyKey: 'ob-revive' });
  const storno = reverseEntry(ctx, { entryId: first.entryId, idempotencyKey: 'storno-a' });
  const unStorno = reverseEntry(ctx, { entryId: storno.reversalId, idempotencyKey: 'storno-b' });
  assert.equal(unStorno.ok, true, `the second storno must take: ${JSON.stringify(unStorno)}`);

  // The ledger is the arbiter: the original amounts are standing again.
  assert.equal(balanceOf(store, workspaceId, '1020'), 1250000, 'the double storno put the position back');

  const read = getOpeningBalances(ctx, { year: '2026' });
  assert.equal(read.source, 'entry', `the revived position is live again: ${JSON.stringify(read)}`);
  assert.equal(read.entryId, first.entryId);
  assert.equal(read.totalDebitMinor, 1590000);

  // And the guard follows the same liveness, so nothing stacks on a live position.
  const second = setOpeningBalances(ctx, { lines: balancedSet(byNumber), idempotencyKey: 'ob-revive-2' });
  assert.equal(second.ok, false, `a live position still blocks a second one: ${JSON.stringify(second)}`);
  assert.equal(second.error, 'opening_balance_already_set');
  assert.equal(balanceOf(store, workspaceId, '1020'), 1250000, 'nothing was double-counted');
});

test('two live positions under the marker: the read takes the NEWEST, the current one', () => {
  // Reachable only by BYPASSING A04, which is the cost `OPENING_KEY_PREFIX` states out loud: the
  // marker is a string convention on the idempotency key, not a database constraint, so a caller with
  // direct `post_entry` can mint an entry under the prefix by hand. A04's own guard makes a second
  // live position impossible through its own verbs, so this pins the tie-break rather than a flow.
  //
  // NOTE the honest limit, which is F3's territory and not fixed here: the read renders the newest
  // ENTRY's own lines, so it still does not report the ledger's SUM across both.
  const { ctx, store, workspaceId, byNumber } = setup();
  const seeded = setOpeningBalances(ctx, { lines: balancedSet(byNumber), idempotencyKey: 'ob-first' });
  assert.equal(seeded.ok, true, JSON.stringify(seeded));

  const contra = seedOpeningContraAccount(ctx);
  const handMinted = postEntry(ctx, {
    date: '2026-03-01',
    source: 'import',
    idempotencyKey: `opening-balances:2026:by-hand`,
    lines: [
      { account: byNumber['1020'], debit: 700000 },
      { account: contra, credit: 700000 },
    ],
  });
  assert.equal(handMinted.ok, true, `the hand-minted entry must post: ${JSON.stringify(handMinted)}`);

  const read = getOpeningBalances(ctx, { year: '2026' });
  assert.equal(read.source, 'entry');
  assert.equal(read.entryId, handMinted.entryId, 'the LATER position is the current one, not the first ever seeded');
  assert.equal(read.asOf, '2026-03-01');
  assert.equal(balanceOf(store, workspaceId, '1020'), 1950000, 'the ledger holds BOTH, which the read does not claim to');
});

test('A19 bank opening balances share source=import but are not mistaken for the A04 position', () => {
  // Both capabilities post `source='import'`, so an A04 marker that keyed on the source alone would
  // read A19's bank opening entry as the workspace's opening position and then refuse the real one.
  //
  // A19 books against a DIFFERENT ledger account here (1000 Kasse) than the set A04 seeds, so this
  // test pins the KEY-PREFIX claim on its own. The overlapping case is a double-count and has its own
  // test below; before that refusal existed this one used 1020 for both and asserted nothing but
  // `ok === true` and a row count, so it stayed green while the book was CHF 5'000.00 wrong.
  const { ctx, store, workspaceId, byNumber } = setup();
  const contra = seedOpeningContraAccount(ctx);
  postEntry(ctx, {
    date: '2026-01-01',
    source: 'import',
    idempotencyKey: 'bank-opening:acct:1',
    lines: [
      { account: byNumber['1000'], debit: 500000 },
      { account: contra, credit: 500000 },
    ],
  });

  const res = setOpeningBalances(ctx, { lines: balancedSet(byNumber), idempotencyKey: 'ob-after-bank' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(rowCounts(store, workspaceId).entries, 2);
  // On the LEDGER, per account. A row count cannot tell a correct book from a double-counted one.
  assert.equal(balanceOf(store, workspaceId, '1000'), 500000, "A19's position, untouched");
  assert.equal(balanceOf(store, workspaceId, '1020'), 1250000, "A04's position, not inflated by A19's");
  assert.equal(balanceOf(store, workspaceId, '2800'), -1400000);
  assert.equal(balanceOf(store, workspaceId, '9100'), -500000, 'the clearing account carries A19 alone');

  // And the read model still reports the A04 entry, not A19's.
  const read = getOpeningBalances(ctx, { year: '2026' });
  assert.equal(read.entryId, res.entryId);
  assert.equal('1000' in Object.fromEntries(read.lines.map((l) => [l.number, l])), false);
});

test('the `:<year>:` segment is the discriminator, not the prefix string', () => {
  // The namespace test used to assert the wrong property. Renaming OPENING_KEY_PREFIX to collide
  // with A19's `bank-opening` outright left the whole suite green, because a bank account id is
  // never a four-digit year: the SEGMENT keeps the two apart, and the prefix is legibility.
  //
  // So this pins the segment. An entry whose key shares A04's prefix EXACTLY but carries a bank
  // account id where the year belongs must not be read as the opening position.
  const { ctx, byNumber } = setup();
  const contra = seedOpeningContraAccount(ctx);
  const lookalike = postEntry(ctx, {
    date: '2026-01-01',
    source: 'import',
    idempotencyKey: 'opening-balances:bank_1:x', // A04's prefix, a bank id where the year goes
    lines: [
      { account: byNumber['1000'], debit: 500000 },
      { account: contra, credit: 500000 },
    ],
  });
  assert.equal(lookalike.ok, true, JSON.stringify(lookalike));

  const read = getOpeningBalances(ctx, { year: '2026' });
  assert.equal(read.source, 'none', `a non-year segment is not this year's position: ${JSON.stringify(read)}`);

  // And the real position still seeds, rather than being blocked by the lookalike.
  const res = setOpeningBalances(ctx, { lines: balancedSet(byNumber), idempotencyKey: 'ob-after-lookalike' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(getOpeningBalances(ctx, { year: '2026' }).entryId, res.entryId);

  // The mirror: the SAME key under this year's segment IS the position, which is what proves the
  // assertion above turns on the segment and not on something incidental about the row.
  const other = setup();
  const otherContra = seedOpeningContraAccount(other.ctx);
  const real = postEntry(other.ctx, {
    date: '2026-01-01',
    source: 'import',
    idempotencyKey: 'opening-balances:2026:x',
    lines: [
      { account: other.byNumber['1000'], debit: 500000 },
      { account: otherContra, credit: 500000 },
    ],
  });
  assert.equal(getOpeningBalances(other.ctx, { year: '2026' }).entryId, real.entryId);
});

test('A04 refuses to seed an account A19 already opened, instead of double-counting it', () => {
  // Both capabilities book an Eröffnungsbilanz, both post `source='import'`, and neither knew the
  // other had run. Measured before the refusal: A19 5'000.00 plus A04 12'500.00 left 1020 holding
  // 17'500.00 while `get_opening_balances` reported 12'500.00, with a phantom 9100 line. Both are
  // documented onboarding happy paths, so the collision is ordinary rather than exotic.
  const { ctx, store, workspaceId, byNumber } = setup();
  seedOpeningContraAccount(ctx);
  const bank = createBankAccount(ctx, {
    name: 'Postfinance',
    iban: 'CH9300762011623852957',
    currency: 'CHF',
    ledgerAccountId: byNumber['1020'],
    idempotencyKey: 'bank-1',
  });
  assert.equal(bank.ok, true, JSON.stringify(bank));
  const opened = setBankOpeningBalance(ctx, {
    bankAccountId: bank.bankAccountId,
    amountMinor: 500000,
    date: '2026-01-01',
    idempotencyKey: 'bank-open-1',
  });
  assert.equal(opened.ok, true, `A19 must post, else this test proves nothing: ${JSON.stringify(opened)}`);

  const before = rowCounts(store, workspaceId);
  const res = setOpeningBalances(ctx, { lines: balancedSet(byNumber), idempotencyKey: 'ob-clash' });
  assert.equal(res.ok, false, `1020 already holds a position: ${JSON.stringify(res)}`);
  assert.equal(res.error, 'account_already_has_balance');
  // It names the account and what it already holds, so the caller can act without guessing.
  assert.deepEqual(res.accounts, [{ number: '1020', balanceMinor: 500000 }]);
  assert.equal(res.asOf, '2026-01-01');

  // NOTHING was written, and the book is exactly what A19 left.
  assert.deepEqual(rowCounts(store, workspaceId), before);
  assert.equal(balanceOf(store, workspaceId, '1020'), 500000, 'not 1_750_000: the double-count never happened');
  assert.equal(balanceOf(store, workspaceId, '2800'), 0);
});

test('the clarification account is exempt: a clearing account is meant to accumulate', () => {
  // 9100 already carries A19's contra leg. Refusing on it too would break the documented
  // `differenceAccount` way out for every workspace where A19 happened to run first, and a clearing
  // account asserts no opening position of its own, unlike a line in the caller's set.
  const { ctx, store, workspaceId, byNumber } = setup();
  const contra = seedOpeningContraAccount(ctx);
  postEntry(ctx, {
    date: '2026-01-01',
    source: 'import',
    idempotencyKey: 'bank-opening:acct:1',
    lines: [
      { account: byNumber['1000'], debit: 500000 },
      { account: contra, credit: 500000 },
    ],
  });

  const res = setOpeningBalances(ctx, {
    lines: [{ account: byNumber['1020'], debitMinor: 900000 }],
    differenceAccount: OPENING_CONTRA_ACCOUNT_NUMBER,
    idempotencyKey: 'ob-diff-onto-used-9100',
  });
  assert.equal(res.ok, true, `9100 already holding a balance must not block the way out: ${JSON.stringify(res)}`);
  assert.equal(balanceOf(store, workspaceId, '9100'), -1400000, 'the clearing account simply accumulates');
});

// --- delegation: A24 and §H-PERIOD are postEntry's, not A04's -----------------------------------

test('A24: a caller without the `post` capability is denied through postEntry, nothing written', () => {
  const { ctx, store, workspaceId, byNumber } = setup({ ctxOverrides: { capabilities: denying('post') } });
  const res = setOpeningBalances(ctx, { lines: balancedSet(byNumber), idempotencyKey: 'ob-denied' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'permission_denied');
  assert.equal(res.capability, 'post', 'the underlying check names the capability, A04 mints none of its own');
  assert.deepEqual(rowCounts(store, workspaceId), { entries: 0, lines: 0 });
});

test('§H-PERIOD: a locked opening period is surfaced, not forced', () => {
  const { ctx, store, workspaceId, byNumber } = setup();
  const locked = lockPeriod(ctx, {
    period: '2026-01',
    kind: 'hard',
    reason: 'Treuhänder prüft',
    idempotencyKey: 'lock-jan',
  });
  assert.equal(locked.ok, true, `the lock itself must take, else this test proves nothing: ${JSON.stringify(locked)}`);

  const res = setOpeningBalances(ctx, { lines: balancedSet(byNumber), idempotencyKey: 'ob-locked' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'period_locked');
  assert.equal(res.period, '2026-01');
  assert.deepEqual(rowCounts(store, workspaceId), { entries: 0, lines: 0 });

  // And the key did not burn: the same key works once the period reopens, which is what makes
  // `period_locked` an operator's way out rather than a dead end.
  ctx.store.db.prepare('DELETE FROM period_lock WHERE workspace_id = ? AND period = ?').run(workspaceId, '2026-01');
  const retried = setOpeningBalances(ctx, { lines: balancedSet(byNumber), idempotencyKey: 'ob-locked' });
  assert.equal(retried.ok, true, JSON.stringify(retried));
});

// --- get_opening_balances -----------------------------------------------------------------------

test('get_opening_balances reads back the entry position with real seed names, ordered by number', () => {
  const { ctx, byNumber, store, workspaceId } = setup();
  const empty = getOpeningBalances(ctx, {});
  assert.equal(empty.ok, true, JSON.stringify(empty));
  assert.equal(empty.source, 'none');
  assert.deepEqual(empty.lines, []);
  assert.equal(empty.editable, true, 'nothing is set yet, so the grid is the way in');

  const set = setOpeningBalances(ctx, { lines: balancedSet(byNumber), idempotencyKey: 'ob-read' });
  const read = getOpeningBalances(ctx, {});
  assert.equal(read.source, 'entry');
  assert.equal(read.entryId, set.entryId);
  assert.equal(read.asOf, '2026-01-01');
  assert.equal(read.year, '2026');
  assert.equal(read.editable, false, 'a posted position is not re-keyable, it is reversed');
  assert.equal(read.totalDebitMinor, 1590000);
  assert.equal(read.totalCreditMinor, 1590000);

  // The NAMES are read against the shipped seed rather than restated here: eight hand-written
  // fixture names were wrong in this repo recently while every `type` still matched, so a test that
  // asserts its own guess proves only that the guess is stable.
  const nameOf = (number) =>
    store.db.prepare('SELECT name FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number).name;
  assert.deepEqual(
    read.lines.map((l) => ({ number: l.number, name: l.name, debitMinor: l.debitMinor, creditMinor: l.creditMinor })),
    [
      { number: '1020', name: nameOf('1020'), debitMinor: 1250000, creditMinor: 0 },
      { number: '1100', name: nameOf('1100'), debitMinor: 340000, creditMinor: 0 },
      { number: '2000', name: nameOf('2000'), debitMinor: 0, creditMinor: 190000 },
      { number: '2800', name: nameOf('2800'), debitMinor: 0, creditMinor: 1400000 },
    ],
  );
  assert.equal(read.lines[0].type, 'asset', 'the type rides along for the grid grouping');
});

test('the Belegnachweis rides onto the entry as `ref` AND reads back', () => {
  // OR 957a Abs. 2 Ziff. 2 requires "der Belegnachweis für die einzelnen Buchungsvorgänge", and
  // OR 958c Abs. 2 requires the Bestand of each Bilanz position to be evidenced "durch ein Inventar
  // oder auf andere Art" (both verified verbatim against the consolidated SR 220, 20260101, de).
  // This module cites Abs. 2 to justify REFUSING an unbalanced set, so a write-only Inventar pointer
  // used the argument in one direction only. It had NO test at all: deleting the spread that puts it
  // on the entry left every suite green, and no verb ever handed it back.
  const { ctx, store, workspaceId, byNumber } = setup();
  const res = setOpeningBalances(ctx, {
    lines: balancedSet(byNumber),
    reference: 'Inventar 2026-01-01, Treuhand Meier',
    idempotencyKey: 'ob-ref',
  });
  assert.equal(res.ok, true, JSON.stringify(res));

  // 1. It is ON the entry, in the column a Beleg belongs in.
  const row = store.db.prepare('SELECT ref FROM journal_entry WHERE id = ?').get(res.entryId);
  assert.equal(row.ref, 'Inventar 2026-01-01, Treuhand Meier');

  // 2. And it READS BACK, which is what makes it a Nachweis rather than a write-only field.
  const read = getOpeningBalances(ctx, { year: '2026' });
  assert.equal(read.reference, 'Inventar 2026-01-01, Treuhand Meier');
  assert.equal(balanceOf(store, workspaceId, '1020'), 1250000);
});

test('an opening position with no Beleg reads back a null reference, never a missing key', () => {
  // The pointer is optional (the entry's source and key already trace provenance), so the shape has
  // to be stable in both directions or a caller has to tell `undefined` from "not supported".
  const { ctx, byNumber } = setup();
  setOpeningBalances(ctx, { lines: balancedSet(byNumber), idempotencyKey: 'ob-noref' });
  const read = getOpeningBalances(ctx, { year: '2026' });
  assert.equal('reference' in read, true, 'the key is always present');
  assert.equal(read.reference, null);

  // The other two sources carry it too, so one read model answers one shape.
  const none = getOpeningBalances(setup().ctx, { year: '2030' });
  assert.equal(none.source, 'none');
  assert.equal(none.reference, null);
});

// --- US-A04.4, the carry-forward after A03's close ----------------------------------------------

/** Book a profit in 2026: income 3000 credited 100.00, expense 6500 debited 40.00, result +60.00. */
function bookProfit2026(ctx, byNumber) {
  postEntry(ctx, {
    date: '2026-05-01',
    source: 'manual',
    idempotencyKey: 'inc-1',
    lines: [{ account: byNumber['1020'], debit: 10000 }, { account: byNumber['3000'], credit: 10000 }],
  });
  postEntry(ctx, {
    date: '2026-06-01',
    source: 'manual',
    idempotencyKey: 'exp-1',
    lines: [{ account: byNumber['6500'], debit: 4000 }, { account: byNumber['1020'], credit: 4000 }],
  });
}

test('after the A03 close, year N+1 opens on the carried balance sheet with the P&L gone', () => {
  const { ctx, byNumber } = setup();
  bookProfit2026(ctx, byNumber);
  const closed = hardCloseYear(ctx, { year: 2026, idempotencyKey: 'close-2026' });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(closed.result, 6000);

  const carried = getOpeningBalances(ctx, { year: 2027 });
  assert.equal(carried.ok, true, JSON.stringify(carried));
  assert.equal(carried.source, 'carried_forward');
  assert.equal(carried.carriedFromYear, '2026');
  assert.equal(carried.editable, false, 'US-A04.4: carried, not something to re-key');
  assert.equal(carried.entryId, null, 'a carried position is derived, it is not a second posting');
  assert.equal(carried.asOf, '2027-01-01');

  const byNo = Object.fromEntries(carried.lines.map((l) => [l.number, l]));
  // The close moved the result 2979 -> 2970. A carry-forward that filtered `source != 'close'`, the
  // way A08's Erfolgsrechnung did, would show 2979 still holding 60.00 and 2970 empty: the year
  // would open with its result booked twice over, in the wrong equity line.
  assert.deepEqual(byNo['2970'], {
    ...byNo['2970'],
    number: '2970',
    debitMinor: 0,
    creditMinor: 6000,
  });
  assert.equal('2979' in byNo, false, '2979 nets to zero after the carry and carries no position');
  // 1020 holds 100.00 - 40.00 = 60.00.
  assert.equal(byNo['1020'].debitMinor, 6000);
  assert.equal(byNo['1020'].creditMinor, 0);

  // The Erfolgsrechnung accounts do NOT open a new year: the close zeroed them, and a balance sheet
  // is what carries.
  assert.equal('3000' in byNo, false);
  assert.equal('6500' in byNo, false);
  assert.equal(carried.totalDebitMinor, carried.totalCreditMinor, '§H-LEDGER: a carried position balances');
  assert.equal(carried.totalDebitMinor, 6000);
});

test('a loss carries the other way, so the sign survives the close', () => {
  const { ctx, byNumber } = setup();
  postEntry(ctx, {
    date: '2026-05-01',
    source: 'manual',
    idempotencyKey: 'inc-1',
    lines: [{ account: byNumber['1020'], debit: 2000 }, { account: byNumber['3000'], credit: 2000 }],
  });
  postEntry(ctx, {
    date: '2026-06-01',
    source: 'manual',
    idempotencyKey: 'exp-1',
    lines: [{ account: byNumber['6500'], debit: 5000 }, { account: byNumber['1020'], credit: 5000 }],
  });
  hardCloseYear(ctx, { year: 2026, idempotencyKey: 'close-2026' });

  const byNo = Object.fromEntries(getOpeningBalances(ctx, { year: 2027 }).lines.map((l) => [l.number, l]));
  assert.equal(byNo['2970'].debitMinor, 3000, 'a loss opens 2970 on the DEBIT side');
  assert.equal(byNo['2970'].creditMinor, 0);
  assert.equal(byNo['1020'].creditMinor, 3000, 'the bank is overdrawn by 30.00');
});

test('an UNBALANCED carried position is refused, never handed on as ok', () => {
  // The carry restricts to balance-sheet types, and its docblock justified that by "the close already
  // zeroed the P&L". NOTHING enforces that: `hardCloseYear` does not require year N-1 to be closed
  // before year N. Close 2026 while 2025 is still open and 3000 keeps 2025's revenue, which the type
  // filter then drops, so the carried position is short by exactly that residue.
  //
  // A08's Bilanz built on this would not foot either, so A04 refuses rather than handing it onward.
  // The root cause sits in A03's contract and is deliberately NOT patched here: whether a close should
  // refuse while a prior year is open is A03's decision to make.
  const { ctx, byNumber } = setup();
  const book = (date, amount, key) =>
    postEntry(ctx, {
      date,
      source: 'manual',
      idempotencyKey: key,
      lines: [{ account: byNumber['1020'], debit: amount }, { account: byNumber['3000'], credit: amount }],
    });
  book('2025-05-01', 500000, 'rev-2025'); // never closed
  book('2026-05-01', 100000, 'rev-2026');
  const closed = hardCloseYear(ctx, { year: 2026, idempotencyKey: 'close-2026' });
  assert.equal(closed.ok, true, `the close must take, else this test proves nothing: ${JSON.stringify(closed)}`);

  const carried = getOpeningBalances(ctx, { year: 2027 });
  assert.equal(carried.ok, false, `an out-of-balance position is not a position: ${JSON.stringify(carried)}`);
  assert.equal(carried.error, 'carried_position_unbalanced');
  assert.equal(carried.differenceMinor, 500000, 'the signed Rappen difference, exactly as the write side reports it');
  assert.equal(carried.totalDebitMinor, 600000);
  assert.equal(carried.totalCreditMinor, 100000);
  // Actionable, not just a complaint: it names the year whose open books left the residue.
  assert.deepEqual(carried.unclosedYears, ['2025']);
});

test('a carried position that DOES balance is unaffected by the balance gate', () => {
  // The gate must not fire on the ordinary path, or it would break every properly closed book.
  const { ctx, byNumber } = setup();
  bookProfit2026(ctx, byNumber);
  hardCloseYear(ctx, { year: 2026, idempotencyKey: 'close-2026' });

  const carried = getOpeningBalances(ctx, { year: 2027 });
  assert.equal(carried.ok, true, JSON.stringify(carried));
  assert.equal(carried.totalDebitMinor, carried.totalCreditMinor);
  assert.equal('unclosedYears' in carried, false, 'a balanced carry carries no complaint');
});

test('the carry-forward boundary: the day before, the day itself, and the day after', () => {
  // An opening position sits exactly ON a boundary by definition, so a `<=` mutated to `<` (or a
  // `>=` to `>`) has to be visible. Three postings, one per side of 31.12.2026.
  const { ctx, byNumber } = setup();
  const book = (date, amount, key) =>
    postEntry(ctx, {
      date,
      source: 'manual',
      idempotencyKey: key,
      lines: [{ account: byNumber['1020'], debit: amount }, { account: byNumber['2800'], credit: amount }],
    });
  book('2026-12-30', 100, 'd-before');
  book('2026-12-31', 20, 'd-on');
  // THE BOUNDARY DAY ITSELF. The test carried this name without ever booking on it: 30.12, 31.12 and
  // 02.01 were covered and 01.01, the opening date, was not. `dayBefore` could be neutralised to a
  // no-op and every suite stayed green while every 1 January posting was pulled into the prior year.
  book('2027-01-01', 7, 'd-boundary');
  book('2027-01-02', 3, 'd-after');

  assert.equal(hardCloseYear(ctx, { year: 2026, idempotencyKey: 'c26' }).ok, true);
  const byNo = Object.fromEntries(getOpeningBalances(ctx, { year: 2027 }).lines.map((l) => [l.number, l]));
  assert.equal(
    byNo['1020'].debitMinor,
    120,
    'the last day of the closing year is INSIDE the carried position and the first of the new one is outside',
  );

  // And the year after carries all four, which is what tells "the boundary moved by a day" apart
  // from "the boundary is missing entirely": a `<` in place of `<=` gives 100 here, not 130.
  assert.equal(hardCloseYear(ctx, { year: 2027, idempotencyKey: 'c27' }).ok, true);
  const later = Object.fromEntries(getOpeningBalances(ctx, { year: 2028 }).lines.map((l) => [l.number, l]));
  assert.equal(later['1020'].debitMinor, 130);
});

test('setting opening balances into a carried year is refused: A03 owns that position', () => {
  const { ctx, store, workspaceId, byNumber } = setup();
  bookProfit2026(ctx, byNumber);
  hardCloseYear(ctx, { year: 2026, idempotencyKey: 'close-2026' });
  const before = rowCounts(store, workspaceId);

  const res = setOpeningBalances(ctx, {
    asOf: '2027-01-01',
    lines: balancedSet(byNumber),
    idempotencyKey: 'ob-carried',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'carried_forward', 'A04 surfaces the carried position, it never re-books it');
  assert.equal(res.carriedFromYear, '2026');
  assert.deepEqual(rowCounts(store, workspaceId), before, 'the result is not booked a second time');
});

// --- §H-TENANT ----------------------------------------------------------------------------------

test('§H-TENANT: a neighbouring workspace reaches neither the accounts nor the position', () => {
  // The neighbour is minted FIRST and deliberately so. A neutralised `workspace_id` filter on a
  // `.get()` degenerates to "the first matching row", so with the neighbour minted SECOND a broken
  // query would resolve the caller's OWN 1020 and the test would pass while enforcing nothing.
  const seed = setup();
  const victim = neighbourWorkspace(seed.deps, { name: 'Erster Mandant' });
  const mine = neighbourWorkspace(seed.deps, { name: 'Zweiter Mandant' });

  const posted = setOpeningBalances(victim.ctx, {
    lines: balancedSet(victim.byNumber),
    idempotencyKey: 'ob-victim',
  });
  assert.equal(posted.ok, true, JSON.stringify(posted));

  // 1. The neighbour's account ID is not reachable by id.
  const byId = setOpeningBalances(mine.ctx, {
    lines: [
      { account: victim.byNumber['1020'], debitMinor: 100 },
      { account: mine.byNumber['2800'], creditMinor: 100 },
    ],
    idempotencyKey: 'ob-cross-id',
  });
  assert.equal(byId.error, 'unknown_account');
  assert.equal(byId.account, victim.byNumber['1020']);

  // 2. Resolving by NUMBER lands on the CALLER's own account, never on the first workspace's.
  const byNumberRes = setOpeningBalances(mine.ctx, {
    lines: [
      { account: '1020', debitMinor: 100 },
      { account: '2800', creditMinor: 100 },
    ],
    idempotencyKey: 'ob-own-number',
  });
  assert.equal(byNumberRes.ok, true, JSON.stringify(byNumberRes));
  const line = seed.store.db
    .prepare('SELECT account_id FROM journal_line WHERE entry_id = ? AND debit_minor > 0')
    .get(byNumberRes.entryId);
  assert.equal(line.account_id, mine.byNumber['1020']);
  assert.notEqual(line.account_id, victim.byNumber['1020']);

  // 3. The read model does not cross the boundary either: `mine` sees its own two-line position,
  // never the neighbour's four-line one.
  const read = getOpeningBalances(mine.ctx, {});
  assert.equal(read.entryId, byNumberRes.entryId);
  assert.equal(read.lines.length, 2);
  assert.equal(getOpeningBalances(victim.ctx, {}).entryId, posted.entryId);
});

// The §H-TENANT fences below were each confirmed CORRECT in the shipped code but had no test that
// could turn them red. Every one mints the neighbour FIRST, for the reason `support.mjs` gives: a
// neutralised `workspace_id` filter degenerates to "the first matching row", so a neighbour minted
// second lets a broken query pass by accident.

test('§H-TENANT: a neighbour\'s chart does not satisfy `hasChart` for a chartless workspace', () => {
  // Without the fence, `hasChart` finds the NEIGHBOUR's 1020 and the caller sails past P9's
  // `needs_chart` into a per-account complaint about a chart it does not have.
  const seed = setup();
  const victim = neighbourWorkspace(seed.deps, { name: 'Erster Mandant' });
  const mine = neighbourWorkspace(seed.deps, { name: 'Zweiter Mandant' });
  assert.notEqual(victim.byNumber['1020'], undefined, 'the neighbour really does have a chart');
  seed.store.db.prepare('DELETE FROM account WHERE workspace_id = ?').run(mine.workspaceId);

  const res = setOpeningBalances(mine.ctx, {
    lines: [{ account: '1020', debitMinor: 100 }, { account: '2800', creditMinor: 100 }],
    idempotencyKey: 'ob-nochart-tenant',
  });
  assert.equal(res.error, 'needs_chart', `the neighbour's chart is not this workspace's: ${JSON.stringify(res)}`);
});

test('§H-TENANT: a neighbour\'s year-close does not seal THIS workspace\'s year', () => {
  // `isYearSealed` reads `period_lock`. Unfenced, the neighbour's close would make this workspace
  // report a carried position it never closed, and refuse a legitimate opening seed as
  // `carried_forward`.
  const seed = setup();
  const victim = neighbourWorkspace(seed.deps, { name: 'Erster Mandant' });
  const mine = neighbourWorkspace(seed.deps, { name: 'Zweiter Mandant' });
  postEntry(victim.ctx, {
    date: '2026-05-01',
    source: 'manual',
    idempotencyKey: 'v-inc',
    lines: [{ account: victim.byNumber['1020'], debit: 10000 }, { account: victim.byNumber['3000'], credit: 10000 }],
  });
  const closed = hardCloseYear(victim.ctx, { year: 2026, idempotencyKey: 'v-close' });
  assert.equal(closed.ok, true, `the neighbour's close must take: ${JSON.stringify(closed)}`);

  // The read: mine never closed 2026, so 2027 opens on nothing, not on a carried position.
  const read = getOpeningBalances(mine.ctx, { year: 2027 });
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(read.source, 'none', `the neighbour's seal is not mine: ${JSON.stringify(read)}`);

  // And the write: a seed into 2027 is allowed, not refused as someone else's carried year.
  const res = setOpeningBalances(mine.ctx, {
    asOf: '2027-01-01',
    lines: [{ account: '1020', debitMinor: 100 }, { account: '2800', creditMinor: 100 }],
    idempotencyKey: 'ob-2027',
  });
  assert.equal(res.ok, true, `a year this workspace never closed stays seedable: ${JSON.stringify(res)}`);
});

test('§H-TENANT: the carry-forward sums THIS workspace\'s lines only', () => {
  // The load-bearing one, the fence the docblock calls "the only one that can bite", and until now
  // no test could turn it red. The neighbour's balances must not appear in, or inflate, the carry.
  const seed = setup();
  const victim = neighbourWorkspace(seed.deps, { name: 'Erster Mandant' });
  const mine = neighbourWorkspace(seed.deps, { name: 'Zweiter Mandant' });

  // Distinct magnitudes, so a leak changes the FIGURES and not merely the row count.
  postEntry(victim.ctx, {
    date: '2026-03-01',
    source: 'manual',
    idempotencyKey: 'v-open',
    lines: [{ account: victim.byNumber['1020'], debit: 777700 }, { account: victim.byNumber['2800'], credit: 777700 }],
  });
  postEntry(mine.ctx, {
    date: '2026-05-01',
    source: 'manual',
    idempotencyKey: 'm-inc',
    lines: [{ account: mine.byNumber['1020'], debit: 10000 }, { account: mine.byNumber['3000'], credit: 10000 }],
  });
  hardCloseYear(mine.ctx, { year: 2026, idempotencyKey: 'm-close' });

  const carried = getOpeningBalances(mine.ctx, { year: 2027 });
  assert.equal(carried.ok, true, JSON.stringify(carried));
  assert.equal(carried.source, 'carried_forward');
  const byNo = Object.fromEntries(carried.lines.map((l) => [l.number, l]));
  assert.equal(byNo['1020'].debitMinor, 10000, "not 7'877'00: the neighbour's bank balance is not in this carry");
  assert.equal(byNo['2970'].creditMinor, 10000);
  assert.equal(carried.totalDebitMinor, 10000);
  assert.equal(carried.totalCreditMinor, 10000);
  assert.equal(carried.lines.length, 2, 'exactly this workspace\'s two carried positions');
});

test('§H-TENANT: `unclosedYears` counts only THIS workspace\'s open years', () => {
  // The diagnosis walks back from the first posted entry. Unfenced, it would walk back from the
  // NEIGHBOUR's oldest entry and name years this workspace never traded in.
  const seed = setup();
  const victim = neighbourWorkspace(seed.deps, { name: 'Erster Mandant' });
  const mine = neighbourWorkspace(seed.deps, { name: 'Zweiter Mandant' });
  postEntry(victim.ctx, {
    date: '2020-06-01',
    source: 'manual',
    idempotencyKey: 'v-ancient',
    lines: [{ account: victim.byNumber['1020'], debit: 100 }, { account: victim.byNumber['2800'], credit: 100 }],
  });

  const book = (date, amount, key) =>
    postEntry(mine.ctx, {
      date,
      source: 'manual',
      idempotencyKey: key,
      lines: [{ account: mine.byNumber['1020'], debit: amount }, { account: mine.byNumber['3000'], credit: amount }],
    });
  book('2025-05-01', 500000, 'm-2025'); // left open, so the carry cannot tie out
  book('2026-05-01', 100000, 'm-2026');
  hardCloseYear(mine.ctx, { year: 2026, idempotencyKey: 'm-close' });

  const carried = getOpeningBalances(mine.ctx, { year: 2027 });
  assert.equal(carried.ok, false);
  assert.equal(carried.error, 'carried_position_unbalanced');
  assert.deepEqual(carried.unclosedYears, ['2025'], 'not 2020 onwards: the neighbour\'s history is not mine');
});
