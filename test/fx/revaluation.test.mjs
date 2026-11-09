// A22, FX revaluation: the money-path evidence.
//
// This capability POSTS real journal entries at period end, so the assertions here are the
// unforgiving ones: the FX math is exact to the Rappen, every revaluation carries a linked
// next-period reversal that nets to zero, a re-run of a period end is idempotent ON ROWS (never a
// double-post), the invariants refuse rather than guess (needs_rate, already_posted, period_locked),
// §H-TENANT holds on every query, and post_fx_revaluation is the ONLY writer of a source='fx' entry.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, workspaceId, name, input) => getAction(name).run(deps, { workspaceId, ...input });

/**
 * Seed one foreign-currency monetary position: post a balanced entry in `currency` at `bookRate` so
 * `account` carries a live FC balance, and (unless suppressed) record the closing rate for `periodEnd`.
 * `debitAccount` true books `account` on the debit side (an asset position), false on the credit side
 * (a liability position).
 */
function seedPosition(deps, ws, accId, over = {}) {
  const {
    account = '1000',
    contra = '3200',
    currency = 'EUR',
    fcMinor = 1000000,
    bookRate = '0.9600',
    closingRate = '0.9520',
    postDate = '2026-06-15',
    periodEnd = '2026-06-30',
    debitAccount = true,
    recordClosing = true,
    key = 'seed',
  } = over;

  const lines = debitAccount
    ? [
        { account: accId(account), debit: fcMinor },
        { account: accId(contra), credit: fcMinor },
      ]
    : [
        { account: accId(contra), debit: fcMinor },
        { account: accId(account), credit: fcMinor },
      ];

  const posted = call(deps, ws, 'post_entry', {
    date: postDate,
    source: 'manual',
    currency,
    fxRate: bookRate,
    description: `${currency} position`,
    idempotencyKey: `${key}-pos`,
    lines,
  });
  assert.equal(posted.ok, true, `seed posting ok: ${JSON.stringify(posted)}`);

  if (recordClosing) {
    const rate = call(deps, ws, 'record_exchange_rate', {
      baseCurrency: currency,
      rate: closingRate,
      asOf: periodEnd,
      source: 'manual',
      method: 'daily',
      idempotencyKey: `${key}-rate`,
    });
    assert.equal(rate.ok, true, `closing rate recorded: ${JSON.stringify(rate)}`);
  }
  return { periodEnd };
}

/** Net (debit - credit) in base Rappen booked to `accountId` across every posted line. */
function baseBalance(deps, accountId) {
  const row = deps.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE l.account_id = ? AND e.status = 'posted'`,
    )
    .get(accountId);
  return row.net;
}

test('the OR 960a worked example: a EUR asset at a lower closing rate is an exact Rappen loss', () => {
  const deps = freshDeps();
  const { workspaceId: ws, accId } = mintWorkspace(deps);
  seedPosition(deps, ws, accId); // EUR 10'000 booked at 0.9600 (CHF 9'600), closing 0.9520

  const view = call(deps, ws, 'fx_revaluation', { periodEnd: '2026-06-30' });
  assert.equal(view.ok, true);
  assert.equal(view.positions.length, 1);
  const p = view.positions[0];
  assert.equal(p.kind, 'debtor');
  assert.equal(p.currency, 'EUR');
  assert.equal(p.fcAmountMinor, 1000000);
  assert.equal(p.bookChfMinor, 960000);
  assert.equal(p.revaluedChfMinor, 952000); // 10'000 * 0.9520
  assert.equal(p.diffChfMinor, -8000); // CHF -80.00 unrealised loss
  assert.equal(view.totalUnrealisedMinor, -8000);
  assert.deepEqual(view.needsRate, []);
});

test('posting the loss books a BALANCED source=fx entry to 6949 and reverses next period, netting to zero', () => {
  const deps = freshDeps();
  const { workspaceId: ws, accId } = mintWorkspace(deps);
  seedPosition(deps, ws, accId);

  const res = call(deps, ws, 'post_fx_revaluation', { periodEnd: '2026-06-30', idempotencyKey: 'r1' });
  assert.equal(res.ok, true);
  assert.equal(res.posted, true);
  assert.equal(res.totalUnrealisedMinor, -8000);
  assert.equal(res.reversalDate, '2026-07-01');

  // The revaluation entry: source 'fx', dated period end, balanced, 6949 debited and 1000 credited.
  const entry = deps.store.db.prepare('SELECT * FROM journal_entry WHERE id = ?').get(res.entryId);
  assert.equal(entry.source, 'fx');
  assert.equal(entry.date, '2026-06-30');
  const lines = deps.store.db.prepare('SELECT * FROM journal_line WHERE entry_id = ?').all(res.entryId);
  const debit = lines.reduce((s, l) => s + l.base_debit_minor, 0);
  const credit = lines.reduce((s, l) => s + l.base_credit_minor, 0);
  assert.equal(debit, credit, 'the revaluation entry balances in base Rappen');
  const lossAcc = accId('6949');
  const posAcc = accId('1000');
  const lossLine = lines.find((l) => l.account_id === lossAcc);
  const posLine = lines.find((l) => l.account_id === posAcc);
  assert.equal(lossLine.base_debit_minor, 8000, 'the unrealised loss debits 6949');
  assert.equal(posLine.base_credit_minor, 8000, 'the position account is written down by 8000');

  // The reversal: a real linked entry dated the next period start, reverses_entry_id set.
  const reversal = deps.store.db.prepare('SELECT * FROM journal_entry WHERE id = ?').get(res.reversalId);
  assert.equal(reversal.reverses_entry_id, res.entryId);
  assert.equal(reversal.date, '2026-07-01');
  assert.equal(reversal.source, 'reversal');

  // Entry + reversal net to zero on EVERY account: the unrealised adjustment is fully backed out.
  assert.equal(baseBalance(deps, lossAcc), 0, '6949 nets to zero across entry + reversal');
  // 1000 returns to its original booking basis (the seed posting only, CHF 9'600).
  assert.equal(baseBalance(deps, posAcc), 960000, 'the position returns to its original booking basis');
});

test('a higher closing rate is an unrealised GAIN, credited to 6949', () => {
  const deps = freshDeps();
  const { workspaceId: ws, accId } = mintWorkspace(deps);
  seedPosition(deps, ws, accId, { closingRate: '0.9800' }); // 10'000 * 0.98 = 9'800, +200 gain

  const res = call(deps, ws, 'post_fx_revaluation', { periodEnd: '2026-06-30', idempotencyKey: 'g1' });
  assert.equal(res.ok, true);
  assert.equal(res.totalUnrealisedMinor, 20000);
  const lines = deps.store.db.prepare('SELECT * FROM journal_line WHERE entry_id = ?').all(res.entryId);
  const lossLine = lines.find((l) => l.account_id === accId('6949'));
  const posLine = lines.find((l) => l.account_id === accId('1000'));
  assert.equal(lossLine.base_credit_minor, 20000, 'an unrealised gain credits 6949');
  assert.equal(posLine.base_debit_minor, 20000, 'the position is written UP by 20000');
});

test('a EUR LIABILITY revalues in the opposite direction (a weaker EUR is a gain on what you owe)', () => {
  const deps = freshDeps();
  const { workspaceId: ws, accId } = mintWorkspace(deps);
  // A EUR 10'000 payable booked at 0.9600 (credit balance CHF 9'600), closing 0.9520.
  seedPosition(deps, ws, accId, { account: '2000', contra: '6500', debitAccount: false });

  const view = call(deps, ws, 'fx_revaluation', { periodEnd: '2026-06-30' });
  const p = view.positions.find((x) => x.accountNumber === '2000');
  assert.equal(p.kind, 'creditor');
  assert.equal(p.fcAmountMinor, -1000000, 'a liability carries a negative FC balance');
  assert.equal(p.bookChfMinor, -960000);
  assert.equal(p.revaluedChfMinor, -952000);
  assert.equal(p.diffChfMinor, 8000, 'owing a weaker currency is an unrealised gain');

  const res = call(deps, ws, 'post_fx_revaluation', { periodEnd: '2026-06-30', idempotencyKey: 'l1' });
  assert.equal(res.ok, true);
  const lines = deps.store.db.prepare('SELECT * FROM journal_line WHERE entry_id = ?').all(res.entryId);
  const posLine = lines.find((l) => l.account_id === accId('2000'));
  assert.equal(posLine.base_debit_minor, 8000, 'the payable is written DOWN by debiting it');
});

test('an unchanged rate posts NOTHING and records no run (still re-runnable)', () => {
  const deps = freshDeps();
  const { workspaceId: ws, accId } = mintWorkspace(deps);
  seedPosition(deps, ws, accId, { closingRate: '0.9600' }); // equals the booking rate

  const res = call(deps, ws, 'post_fx_revaluation', { periodEnd: '2026-06-30', idempotencyKey: 'z1' });
  assert.equal(res.ok, true);
  assert.equal(res.posted, false);
  assert.equal(res.entryId, null);
  const fxEntries = deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'fx'")
    .get(ws);
  assert.equal(fxEntries.n, 0, 'nothing posted');
  const runs = deps.store.db.prepare('SELECT COUNT(*) AS n FROM fx_revaluation WHERE workspace_id = ?').get(ws);
  assert.equal(runs.n, 0, 'no run recorded, so a later revaluation is still possible');
});

test('§H-IDEMPOTENT on ROWS: re-posting a period end with the same key never double-posts', () => {
  const deps = freshDeps();
  const { workspaceId: ws, accId } = mintWorkspace(deps);
  seedPosition(deps, ws, accId);

  const first = call(deps, ws, 'post_fx_revaluation', { periodEnd: '2026-06-30', idempotencyKey: 'r1' });
  const second = call(deps, ws, 'post_fx_revaluation', { periodEnd: '2026-06-30', idempotencyKey: 'r1' });
  assert.deepEqual(second, first, 'the replay returns the identical Result');

  const fxEntries = deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'fx'")
    .get(ws);
  const reversals = deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'reversal'")
    .get(ws);
  const runs = deps.store.db.prepare('SELECT COUNT(*) AS n FROM fx_revaluation WHERE workspace_id = ?').get(ws);
  assert.equal(fxEntries.n, 1, 'exactly ONE revaluation entry');
  assert.equal(reversals.n, 1, 'exactly ONE reversal');
  assert.equal(runs.n, 1, 'exactly ONE run row');
});

test('a re-post under a DIFFERENT key is refused already_posted, and writes nothing', () => {
  const deps = freshDeps();
  const { workspaceId: ws, accId } = mintWorkspace(deps);
  seedPosition(deps, ws, accId);

  call(deps, ws, 'post_fx_revaluation', { periodEnd: '2026-06-30', idempotencyKey: 'r1' });
  const again = call(deps, ws, 'post_fx_revaluation', { periodEnd: '2026-06-30', idempotencyKey: 'DIFFERENT' });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'already_posted');

  const fxEntries = deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'fx'")
    .get(ws);
  assert.equal(fxEntries.n, 1, 'no second entry from the refused re-post');
});

test('a missing closing rate is needs_rate on both compute and post, and post writes nothing', () => {
  const deps = freshDeps();
  const { workspaceId: ws, accId } = mintWorkspace(deps);
  seedPosition(deps, ws, accId, { recordClosing: false }); // position but no closing rate

  const view = call(deps, ws, 'fx_revaluation', { periodEnd: '2026-06-30' });
  assert.equal(view.ok, true);
  assert.equal(view.positions.length, 0, 'a position with no rate is not valued');
  assert.equal(view.needsRate.length, 1);
  assert.equal(view.needsRate[0].currency, 'EUR');

  const res = call(deps, ws, 'post_fx_revaluation', { periodEnd: '2026-06-30', idempotencyKey: 'n1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'needs_rate');
  const fxEntries = deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'fx'")
    .get(ws);
  assert.equal(fxEntries.n, 0, 'nothing written when a rate is missing');
});

test('§H-PERIOD: posting a revaluation into a locked period is refused, atomically', () => {
  const deps = freshDeps();
  const { workspaceId: ws, accId } = mintWorkspace(deps);
  seedPosition(deps, ws, accId);
  const lock = call(deps, ws, 'lock_period', { period: '2026-06', kind: 'hard', idempotencyKey: 'lk' });
  assert.equal(lock.ok, true, `lock ok: ${JSON.stringify(lock)}`);

  const res = call(deps, ws, 'post_fx_revaluation', { periodEnd: '2026-06-30', idempotencyKey: 'p1' });
  assert.equal(res.ok, false, 'a locked target period refuses the revaluation');
  const fxEntries = deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'fx'")
    .get(ws);
  assert.equal(fxEntries.n, 0, 'the whole trio rolled back: no orphan revaluation entry');
  const runs = deps.store.db.prepare('SELECT COUNT(*) AS n FROM fx_revaluation WHERE workspace_id = ?').get(ws);
  assert.equal(runs.n, 0, 'no run row for a refused post');
});

test('§H-ATOMIC: a reversal blocked by a locked NEXT period rolls the revaluation entry back too (no orphan, no memo)', () => {
  const deps = freshDeps();
  const { workspaceId: ws, accId } = mintWorkspace(deps);
  seedPosition(deps, ws, accId); // June position, closing rate 0.9520 -> a real movement

  // Period end 2026-06-30 posts into June (open); the next-period reversal dates 2026-07-01. Lock
  // JULY hard, so the revaluation entry posts but its reversal is refused. The whole trio must roll
  // back: the books never carry a revaluation without the reversal that backs it out.
  const lock = call(deps, ws, 'lock_period', { period: '2026-07', kind: 'hard', idempotencyKey: 'lkJul' });
  assert.equal(lock.ok, true, `July lock ok: ${JSON.stringify(lock)}`);

  const res = call(deps, ws, 'post_fx_revaluation', { periodEnd: '2026-06-30', idempotencyKey: 'atom1' });
  assert.equal(res.ok, false, 'a locked next period refuses the revaluation as a whole');

  const fxEntries = deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'fx'")
    .get(ws);
  assert.equal(fxEntries.n, 0, 'ZERO revaluation entries persisted: the posted entry rolled back with the failed reversal');
  const runs = deps.store.db.prepare('SELECT COUNT(*) AS n FROM fx_revaluation WHERE workspace_id = ?').get(ws);
  assert.equal(runs.n, 0, 'no run row for the refused post');
  const memo = deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM idempotency WHERE workspace_id = ? AND key = ?')
    .get(ws, 'fxreval:2026-06-30');
  assert.equal(memo.n, 0, 'NO idempotency memo leaked for the rolled-back post: a retry must recompute, not replay a phantom');

  // Retry after unlocking July: the revaluation now succeeds and is NOT blocked by a memoized failure.
  const unlock = call(deps, ws, 'unlock_period', { period: '2026-07', idempotencyKey: 'ulJul' });
  assert.equal(unlock.ok, true, `July unlock ok: ${JSON.stringify(unlock)}`);
  const retry = call(deps, ws, 'post_fx_revaluation', { periodEnd: '2026-06-30', idempotencyKey: 'atom2' });
  assert.equal(retry.ok, true, `the retry succeeds once July is open: ${JSON.stringify(retry)}`);
  assert.equal(retry.posted, true);
  assert.equal(retry.reversalDate, '2026-07-01');
  const fxAfter = deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'fx'")
    .get(ws);
  assert.equal(fxAfter.n, 1, 'exactly one revaluation entry after the successful retry');
  assert.equal(baseBalance(deps, accId('6949')), 0, '6949 nets to zero across the retry entry + its reversal');
});

test('multiple currencies are each revalued independently at their own closing rate', () => {
  const deps = freshDeps();
  const { workspaceId: ws, accId } = mintWorkspace(deps);
  seedPosition(deps, ws, accId, { currency: 'EUR', closingRate: '0.9520', key: 'eur' });
  seedPosition(deps, ws, accId, {
    account: '1020',
    contra: '3400',
    currency: 'USD',
    bookRate: '0.9000',
    closingRate: '0.8000',
    key: 'usd',
  });

  const view = call(deps, ws, 'fx_revaluation', { periodEnd: '2026-06-30' });
  assert.equal(view.positions.length, 2);
  const eur = view.positions.find((p) => p.currency === 'EUR');
  const usd = view.positions.find((p) => p.currency === 'USD');
  assert.equal(eur.diffChfMinor, -8000); // 10'000 * (0.9520 - 0.9600)
  assert.equal(usd.diffChfMinor, -100000); // 10'000 * (0.8000 - 0.9000)
  assert.equal(view.totalUnrealisedMinor, -108000);

  const res = call(deps, ws, 'post_fx_revaluation', { periodEnd: '2026-06-30', idempotencyKey: 'm1' });
  assert.equal(res.ok, true);
  const lines = deps.store.db.prepare('SELECT * FROM journal_line WHERE entry_id = ?').all(res.entryId);
  const debit = lines.reduce((s, l) => s + l.base_debit_minor, 0);
  const credit = lines.reduce((s, l) => s + l.base_credit_minor, 0);
  assert.equal(debit, credit, 'a multi-currency revaluation is still balanced in base Rappen');
});

test('§H-TENANT: one workspace revalues only its OWN positions and never touches another', () => {
  const deps = freshDeps();
  const a = mintWorkspace(deps, 'A GmbH', 'wsA');
  const b = mintWorkspace(deps, 'B GmbH', 'wsB');
  // Seed both workspaces with an identical EUR position.
  seedPosition(deps, a.workspaceId, a.accId, { key: 'a' });
  seedPosition(deps, b.workspaceId, b.accId, { key: 'b' });

  const viewA = call(deps, a.workspaceId, 'fx_revaluation', { periodEnd: '2026-06-30' });
  assert.equal(viewA.positions.length, 1, 'A sees exactly its own one position');
  assert.equal(viewA.positions[0].accountId, a.accId('1000'));

  const bLossBefore = baseBalance(deps, b.accId('6949'));
  call(deps, a.workspaceId, 'post_fx_revaluation', { periodEnd: '2026-06-30', idempotencyKey: 'tA' });
  assert.equal(baseBalance(deps, b.accId('6949')), bLossBefore, "A's revaluation did not post into B");
  const bRuns = deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM fx_revaluation WHERE workspace_id = ?')
    .get(b.workspaceId);
  assert.equal(bRuns.n, 0, 'B has no revaluation run from A posting');
});

test('TRIPWIRE 3: post_fx_revaluation is the ONLY writer of a source=fx entry (post_entry refuses it)', () => {
  const deps = freshDeps();
  const { workspaceId: ws, accId } = mintWorkspace(deps);
  const forged = call(deps, ws, 'post_entry', {
    date: '2026-06-30',
    source: 'fx',
    idempotencyKey: 'forge',
    lines: [
      { account: accId('6949'), debit: 8000 },
      { account: accId('1000'), credit: 8000 },
    ],
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.error, 'invalid_source', 'the agent post boundary rejects source=fx');
});
