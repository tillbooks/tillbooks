// A38, Abgrenzungen (OR 958b): the money-path evidence for the accrual pair and its Storno pair.
//
// Everything here is asserted on ROWS, never on the verb's own report: the pair is all-or-nothing
// (one transaction, a thrown abort), a double post with the same key moves the ledger once, a
// second key is `already_posted`, the Storno pair negates the original line for line, a locked
// reversal date rolls the whole pair back with nothing memoised, a second workspace sees nothing,
// the posted-immutability triggers abort, and `source='accrual'` is unreachable through the raw
// `post_entry` door. A non-author critic reviews this file before the capability lands (CLAUDE.md).

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, workspaceId, name, input) => getAction(name).run(deps, { workspaceId, ...input });

/** A world with one workspace on a calendar fiscal year (the default) and the KMU chart seeded. */
function world(over = {}) {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, over.name ?? 'Nomadik GmbH', over.key ?? 'ws');
  return { deps, ws: workspaceId, accId };
}

const DRAFT = {
  kind: 'accrued_expense',
  periodEnd: '2026-12-31',
  amountMinor: 180000,
  contraAccount: '6500',
  description: 'Strom Dezember, Rechnung im Januar',
};

function createDraft(deps, ws, over = {}, key = 'c-1') {
  const res = call(deps, ws, 'accrual_create', { ...DRAFT, ...over, idempotencyKey: key });
  assert.equal(res.ok, true, `draft created: ${JSON.stringify(res)}`);
  return res;
}

function entryCount(deps, ws) {
  return deps.store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'").get(ws).n;
}

function lineCount(deps, ws) {
  return deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id WHERE e.workspace_id = ?')
    .get(ws).n;
}

function entryRow(deps, id) {
  return deps.store.db.prepare('SELECT * FROM journal_entry WHERE id = ?').get(id);
}

/** The lines of an entry as `[account_id, debit, credit]` triples, sorted, so two entries compare line for line. */
function lineTriples(deps, entryId) {
  return deps.store.db
    .prepare('SELECT account_id, base_debit_minor AS d, base_credit_minor AS c FROM journal_line WHERE entry_id = ? ORDER BY account_id, d, c')
    .all(entryId)
    .map((l) => [l.account_id, l.d, l.c]);
}

/** Net base balance (debit - credit) on an account over the posted entries dated exactly `date`. */
function netOn(deps, accountId, date) {
  return deps.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE l.account_id = ? AND e.status = 'posted' AND e.date = ?`,
    )
    .get(accountId, date).net;
}

function accrualRow(deps, id) {
  return deps.store.db.prepare('SELECT * FROM accrual WHERE id = ?').get(id);
}

// --- The draft: lines from the ONE function, nothing posted --------------------------------------

test('a draft carries the exact lines the post will write, dated period end, and the reversal lines the day after; nothing is posted', () => {
  const { deps, ws, accId } = world();
  const res = createDraft(deps, ws);
  assert.equal(res.accrual.status, 'draft');
  assert.equal(res.accrual.reversalDate, '2027-01-01');
  assert.equal(res.accrual.balanceAccountNumber, '2300');
  assert.equal(res.accrual.contraAccountNumber, '6500');

  // Dr 6500 1'800.00 / Cr 2300 1'800.00 on 31.12.2026.
  assert.deepEqual(
    res.lines.map((l) => [l.accountNumber, l.debitMinor, l.creditMinor, l.date]),
    [
      ['6500', 180000, 0, '2026-12-31'],
      ['2300', 0, 180000, '2026-12-31'],
    ],
  );
  // The reversal: the mirror, on 01.01.2027.
  assert.deepEqual(
    res.reversalLines.map((l) => [l.accountNumber, l.debitMinor, l.creditMinor, l.date]),
    [
      ['6500', 0, 180000, '2027-01-01'],
      ['2300', 180000, 0, '2027-01-01'],
    ],
  );
  assert.equal(entryCount(deps, ws), 0, 'a draft writes nothing to the journal');
  assert.equal(accId('2300').length > 0, true);

  // The two active kinds land on 1300 with the balance account debited.
  const prepaid = createDraft(deps, ws, { kind: 'prepaid_expense', contraAccount: '6300' }, 'c-prepaid');
  assert.deepEqual(
    prepaid.lines.map((l) => [l.accountNumber, l.debitMinor, l.creditMinor]),
    [
      ['1300', 180000, 0],
      ['6300', 0, 180000],
    ],
  );
  const income = createDraft(deps, ws, { kind: 'accrued_income', contraAccount: '3400' }, 'c-income');
  assert.deepEqual(
    income.lines.map((l) => [l.accountNumber, l.debitMinor, l.creditMinor]),
    [
      ['1300', 180000, 0],
      ['3400', 0, 180000],
    ],
  );
  const deferred = createDraft(deps, ws, { kind: 'deferred_income', contraAccount: '3400' }, 'c-deferred');
  assert.deepEqual(
    deferred.lines.map((l) => [l.accountNumber, l.debitMinor, l.creditMinor]),
    [
      ['3400', 180000, 0],
      ['2300', 0, 180000],
    ],
  );
});

test('the create refuses a wrong kind, a balance-sheet contra, a kind/type mismatch, a bad amount and a foreign currency, writing nothing', () => {
  const { deps, ws } = world();
  const kind = call(deps, ws, 'accrual_create', { ...DRAFT, kind: 'transitorisch', idempotencyKey: 'k' });
  assert.equal(kind.error, 'invalid_kind');
  assert.deepEqual(kind.allowed, ['prepaid_expense', 'accrued_income', 'accrued_expense', 'deferred_income']);

  const asset = call(deps, ws, 'accrual_create', { ...DRAFT, contraAccount: '1020', idempotencyKey: 'a' });
  assert.equal(asset.error, 'invalid_account');
  assert.equal(asset.reason, 'contra_must_be_income_or_expense');

  const mismatch = call(deps, ws, 'accrual_create', { ...DRAFT, contraAccount: '3400', idempotencyKey: 'm' });
  assert.equal(mismatch.error, 'invalid_account');
  assert.equal(mismatch.reason, 'kind_account_type_mismatch');
  assert.equal(mismatch.expected, 'expense');

  for (const amountMinor of [0, -5, 1.5, '180000']) {
    const bad = call(deps, ws, 'accrual_create', { ...DRAFT, amountMinor, idempotencyKey: `amt-${String(amountMinor)}` });
    assert.equal(bad.ok, false, `amount ${String(amountMinor)} refused`);
    assert.ok(bad.error === 'invalid_amount' || bad.error === 'invalid_input', `amount ${String(amountMinor)}: ${bad.error}`);
  }

  const fc = call(deps, ws, 'accrual_create', { ...DRAFT, currency: 'EUR', idempotencyKey: 'fc' });
  assert.equal(fc.error, 'invalid_currency');

  const unknown = call(deps, ws, 'accrual_create', { ...DRAFT, contraAccount: '9999', idempotencyKey: 'u' });
  assert.equal(unknown.error, 'invalid_account');
  assert.equal(unknown.reason, 'contra_not_found');

  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM accrual').get().n, 0, 'no refused create left a row');
});

test('the reversal date is the day after ANY period end, on a 04-01 fiscal year too (30.06. reverses on 01.07.)', () => {
  const deps = freshDeps();
  const made = getAction('create_workspace').run(deps, { name: 'Bergbahn AG', fiscalYearStart: '04-01', idempotencyKey: 'ws-fy' });
  assert.equal(made.ok, true);
  const ws = made.workspaceId;
  const june = createDraft(deps, ws, { periodEnd: '2026-06-30' }, 'fy-june');
  assert.equal(june.accrual.reversalDate, '2026-07-01');
  const feb = createDraft(deps, ws, { periodEnd: '2028-02-29' }, 'fy-leap');
  assert.equal(feb.accrual.reversalDate, '2028-03-01');
});

// --- The pair: all or nothing, once ---------------------------------------------------------------

test('posting writes the PAIR: A (source accrual, period end) and B = its reversal (source reversal, the day after), netting to zero on every account', () => {
  const { deps, ws, accId } = world();
  const draft = createDraft(deps, ws);
  const posted = call(deps, ws, 'accrual_post', { accrualId: draft.accrual.id, idempotencyKey: 'p-1' });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  assert.equal(posted.reversalDate, '2027-01-01');

  const a = entryRow(deps, posted.entryId);
  const b = entryRow(deps, posted.reversalEntryId);
  assert.equal(a.source, 'accrual');
  assert.equal(a.date, '2026-12-31');
  assert.equal(a.status, 'posted');
  assert.equal(b.source, 'reversal');
  assert.equal(b.date, '2027-01-01');
  assert.equal(b.reverses_entry_id, a.id, 'B is the real linked reversal of A');

  // A: Dr 6500 / Cr 2300; B: the mirror, line for line.
  assert.deepEqual(lineTriples(deps, a.id).sort(), [
    [accId('2300'), 0, 180000],
    [accId('6500'), 180000, 0],
  ].sort());
  assert.deepEqual(lineTriples(deps, b.id).sort(), [
    [accId('2300'), 180000, 0],
    [accId('6500'), 0, 180000],
  ].sort());

  // Period end carries the accrual, the next day backs it out.
  assert.equal(netOn(deps, accId('2300'), '2026-12-31'), -180000);
  assert.equal(netOn(deps, accId('6500'), '2026-12-31'), 180000);
  assert.equal(netOn(deps, accId('2300'), '2027-01-01'), 180000);
  assert.equal(netOn(deps, accId('6500'), '2027-01-01'), -180000);

  const row = accrualRow(deps, draft.accrual.id);
  assert.equal(row.status, 'posted');
  assert.equal(row.entry_id, a.id);
  assert.equal(row.reversal_entry_id, b.id);
  assert.equal(row.post_idempotency_key, 'p-1');
  assert.equal(entryCount(deps, ws), 2);
  assert.equal(lineCount(deps, ws), 4);
});

test('§H-IDEMPOTENT on ROWS: the same key replays byte-identically and writes nothing; a second key is already_posted and writes nothing', () => {
  const { deps, ws } = world();
  const draft = createDraft(deps, ws);
  const first = call(deps, ws, 'accrual_post', { accrualId: draft.accrual.id, idempotencyKey: 'p-1' });
  assert.equal(first.ok, true);
  const entriesAfterFirst = entryCount(deps, ws);
  const linesAfterFirst = lineCount(deps, ws);
  assert.equal(entriesAfterFirst, 2);

  const replay = call(deps, ws, 'accrual_post', { accrualId: draft.accrual.id, idempotencyKey: 'p-1' });
  assert.deepEqual(replay, first, 'the replay is the original result');
  assert.equal(entryCount(deps, ws), entriesAfterFirst, 'the replay wrote no entry');
  assert.equal(lineCount(deps, ws), linesAfterFirst, 'the replay wrote no line');

  const again = call(deps, ws, 'accrual_post', { accrualId: draft.accrual.id, idempotencyKey: 'p-2' });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'already_posted');
  assert.equal(again.entryId, first.entryId, 'the refusal names the entry that already stands');
  assert.equal(entryCount(deps, ws), entriesAfterFirst, 'a second key never double-counts');
  assert.equal(lineCount(deps, ws), linesAfterFirst);
  assert.equal(deps.store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE source = 'accrual'").get().n, 1, 'exactly ONE accrual entry exists');
});

test('§H-ATOMIC: a locked REVERSAL date rolls the whole pair back: zero entries, the row still a draft, and no memo, so an unlock lets it post', () => {
  const { deps, ws } = world();
  const draft = createDraft(deps, ws);
  const lock = call(deps, ws, 'lock_period', { period: '2027-01', kind: 'hard', idempotencyKey: 'lk-jan' });
  assert.equal(lock.ok, true, JSON.stringify(lock));

  const refused = call(deps, ws, 'accrual_post', { accrualId: draft.accrual.id, idempotencyKey: 'p-locked' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'period_locked');
  assert.equal(refused.date, '2027-01-01', 'the refusal names the REVERSAL date, not the period end');
  assert.equal(refused.leg, 'reversal');

  assert.equal(entryCount(deps, ws), 0, 'ZERO entries persisted: the accrual entry rolled back with its failed reversal');
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_line').get().n, 0, 'and zero lines');
  const row = accrualRow(deps, draft.accrual.id);
  assert.equal(row.status, 'draft', 'the row never left draft');
  assert.equal(row.entry_id, null);
  assert.equal(row.reversal_entry_id, null);
  assert.equal(row.post_idempotency_key, null);
  assert.equal(
    deps.store.db.prepare('SELECT COUNT(*) AS n FROM idempotency WHERE key LIKE ?').get(`accrual%${draft.accrual.id}`).n,
    0,
    'nothing was memoised under the entry keys: the retry is not poisoned',
  );

  const unlock = call(deps, ws, 'unlock_period', { period: '2027-01', idempotencyKey: 'ul-jan' });
  assert.equal(unlock.ok, true, JSON.stringify(unlock));
  const retry = call(deps, ws, 'accrual_post', { accrualId: draft.accrual.id, idempotencyKey: 'p-locked' });
  assert.equal(retry.ok, true, `after the unlock the same draft posts: ${JSON.stringify(retry)}`);
  assert.equal(entryCount(deps, ws), 2);
});

test('§H-PERIOD: a locked PERIOD END refuses before anything is written', () => {
  const { deps, ws } = world();
  const draft = createDraft(deps, ws);
  assert.equal(call(deps, ws, 'lock_period', { period: '2026-12', kind: 'hard', idempotencyKey: 'lk-dec' }).ok, true);
  const refused = call(deps, ws, 'accrual_post', { accrualId: draft.accrual.id, idempotencyKey: 'p-x' });
  assert.equal(refused.error, 'period_locked');
  assert.equal(refused.leg, 'accrual');
  assert.equal(entryCount(deps, ws), 0);
  assert.equal(accrualRow(deps, draft.accrual.id).status, 'draft');
});

// --- The Storno pair ------------------------------------------------------------------------------

test('the Storno posts the MIRROR pair C + D: C negates A line for line, D negates C, four entries net to zero on every account on both dates', () => {
  const { deps, ws, accId } = world();
  const draft = createDraft(deps, ws);
  const posted = call(deps, ws, 'accrual_post', { accrualId: draft.accrual.id, idempotencyKey: 'p-1' });
  assert.equal(posted.ok, true);

  const reversed = call(deps, ws, 'accrual_reverse', { accrualId: draft.accrual.id, reason: 'Rechnung kam doch im Dezember', idempotencyKey: 'r-1' });
  assert.equal(reversed.ok, true, JSON.stringify(reversed));

  const c = entryRow(deps, reversed.stornoEntryId);
  const d = entryRow(deps, reversed.stornoReversalEntryId);
  assert.equal(c.source, 'accrual');
  assert.equal(c.date, '2026-12-31');
  assert.equal(c.ref, posted.entryId, 'C names A in its ref (the journal has no storno column)');
  assert.equal(c.reverses_entry_id, null, 'C is a NEW entry, never a second reversal of A');
  assert.equal(d.source, 'reversal');
  assert.equal(d.reverses_entry_id, c.id);
  assert.equal(d.date, '2027-01-01');
  assert.ok(c.description.includes('Rechnung kam doch im Dezember'), 'the reason is on C');

  // C is the exact mirror of A, line for line; D the exact mirror of C, which makes D equal to A.
  const mirror = (triples) => triples.map(([acc, dr, cr]) => [acc, cr, dr]).sort();
  const aLines = lineTriples(deps, posted.entryId).sort();
  assert.deepEqual(lineTriples(deps, c.id).sort(), mirror(aLines), 'C negates A line for line');
  assert.deepEqual(lineTriples(deps, d.id).sort(), aLines, 'D negates C, so it equals A');

  for (const number of ['2300', '6500']) {
    assert.equal(netOn(deps, accId(number), '2026-12-31'), 0, `${number} nets to zero on period end`);
    assert.equal(netOn(deps, accId(number), '2027-01-01'), 0, `${number} nets to zero on the reversal date`);
  }
  assert.equal(entryCount(deps, ws), 4);
  // Every entry has exactly one reversal (A by B, C by D) and no entry has two.
  const reversalsOfA = deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE reverses_entry_id = ?').get(posted.entryId).n;
  assert.equal(reversalsOfA, 1, 'A is reversed exactly once (by B), never again');

  const row = accrualRow(deps, draft.accrual.id);
  assert.equal(row.status, 'reversed');
  assert.equal(row.storno_entry_id, c.id);
  assert.equal(row.storno_reversal_entry_id, d.id);
  assert.equal(row.reverse_reason, 'Rechnung kam doch im Dezember');
});

test('a Storno replays under its key, refuses already_reversed under a second key, and refuses not_posted on a draft, moving nothing', () => {
  const { deps, ws } = world();
  const draft = createDraft(deps, ws);
  const notPosted = call(deps, ws, 'accrual_reverse', { accrualId: draft.accrual.id, idempotencyKey: 'r-0' });
  assert.equal(notPosted.error, 'not_posted');

  call(deps, ws, 'accrual_post', { accrualId: draft.accrual.id, idempotencyKey: 'p-1' });
  const first = call(deps, ws, 'accrual_reverse', { accrualId: draft.accrual.id, idempotencyKey: 'r-1' });
  assert.equal(first.ok, true);
  const after = entryCount(deps, ws);
  assert.equal(after, 4);

  const replay = call(deps, ws, 'accrual_reverse', { accrualId: draft.accrual.id, idempotencyKey: 'r-1' });
  assert.deepEqual(replay, first);
  assert.equal(entryCount(deps, ws), after);

  const second = call(deps, ws, 'accrual_reverse', { accrualId: draft.accrual.id, idempotencyKey: 'r-2' });
  assert.equal(second.error, 'already_reversed');
  assert.equal(second.stornoEntryId, first.stornoEntryId);
  assert.equal(entryCount(deps, ws), after, 'a second key never posts a second Storno pair');
});

test('a Storno whose reversal date is locked rolls C back too: still four-or-two, never three', () => {
  const { deps, ws } = world();
  const draft = createDraft(deps, ws);
  call(deps, ws, 'accrual_post', { accrualId: draft.accrual.id, idempotencyKey: 'p-1' });
  assert.equal(call(deps, ws, 'lock_period', { period: '2027-01', kind: 'hard', idempotencyKey: 'lk' }).ok, true);
  const refused = call(deps, ws, 'accrual_reverse', { accrualId: draft.accrual.id, idempotencyKey: 'r-1' });
  assert.equal(refused.error, 'period_locked');
  assert.equal(refused.leg, 'storno_reversal');
  assert.equal(entryCount(deps, ws), 2, 'the pair stands; no orphan Storno was committed');
  assert.equal(accrualRow(deps, draft.accrual.id).status, 'posted');
});

// --- Discard, the reads, and the list -------------------------------------------------------------

test('a draft can be discarded (never deleted); a discarded draft refuses to post; a posted accrual refuses to be discarded', () => {
  const { deps, ws } = world();
  const draft = createDraft(deps, ws);
  const gone = call(deps, ws, 'accrual_discard', { accrualId: draft.accrual.id, reason: 'doppelt erfasst', idempotencyKey: 'd-1' });
  assert.equal(gone.ok, true);
  assert.equal(gone.accrual.status, 'discarded');
  assert.equal(gone.accrual.discardReason, 'doppelt erfasst');
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM accrual').get().n, 1, 'the row is a status, not a missing row');

  const replay = call(deps, ws, 'accrual_discard', { accrualId: draft.accrual.id, idempotencyKey: 'd-1' });
  assert.deepEqual(replay, gone);
  const again = call(deps, ws, 'accrual_discard', { accrualId: draft.accrual.id, idempotencyKey: 'd-2' });
  assert.equal(again.error, 'draft_discarded');

  const post = call(deps, ws, 'accrual_post', { accrualId: draft.accrual.id, idempotencyKey: 'p-1' });
  assert.equal(post.error, 'draft_discarded');
  assert.equal(entryCount(deps, ws), 0);

  const live = createDraft(deps, ws, {}, 'c-2');
  call(deps, ws, 'accrual_post', { accrualId: live.accrual.id, idempotencyKey: 'p-2' });
  const refused = call(deps, ws, 'accrual_discard', { accrualId: live.accrual.id, idempotencyKey: 'd-3' });
  assert.equal(refused.error, 'already_posted');
});

test('accrual_get names every entry with its role; accrual_list filters and sums the live ones only', () => {
  const { deps, ws } = world();
  const a = createDraft(deps, ws, {}, 'c-a');
  const b = createDraft(deps, ws, { periodEnd: '2026-06-30', amountMinor: 50000 }, 'c-b');
  const c = createDraft(deps, ws, { amountMinor: 70000 }, 'c-c');
  call(deps, ws, 'accrual_post', { accrualId: a.accrual.id, idempotencyKey: 'p-a' });
  call(deps, ws, 'accrual_reverse', { accrualId: a.accrual.id, idempotencyKey: 'r-a' });
  call(deps, ws, 'accrual_discard', { accrualId: c.accrual.id, idempotencyKey: 'd-c' });

  const got = call(deps, ws, 'accrual_get', { accrualId: a.accrual.id });
  assert.equal(got.ok, true);
  assert.deepEqual(
    got.entries.map((e) => [e.role, e.date]),
    [
      ['accrual', '2026-12-31'],
      ['reversal', '2027-01-01'],
      ['storno', '2026-12-31'],
      ['storno_reversal', '2027-01-01'],
    ],
  );

  const all = call(deps, ws, 'accrual_list', {});
  assert.equal(all.ok, true);
  assert.equal(all.accruals.length, 3);
  assert.equal(all.totalMinor, 50000, 'only the draft counts: the reversed and the discarded do not');

  const june = call(deps, ws, 'accrual_list', { periodEnd: '2026-06-30' });
  assert.deepEqual(june.accruals.map((r) => r.id), [b.accrual.id]);
  const reversed = call(deps, ws, 'accrual_list', { status: 'reversed' });
  assert.deepEqual(reversed.accruals.map((r) => r.id), [a.accrual.id]);
  assert.equal(call(deps, ws, 'accrual_list', { status: 'open' }).error, 'invalid_input');
  assert.equal(call(deps, ws, 'accrual_list', { savedViewId: 'view_none' }).error, 'not_found', 'the G00 seam answers for an unknown view');
  assert.equal(call(deps, ws, 'accrual_get', { accrualId: 'accrual_none' }).error, 'not_found');
});

// --- §H-TENANT, §H-AUDIT, and the door that stays shut --------------------------------------------

test('§H-TENANT: a second workspace lists nothing, gets not_found on a foreign id, and cannot post or reverse a foreign accrual', () => {
  const { deps, ws } = world();
  const draft = createDraft(deps, ws);
  const other = mintWorkspace(deps, 'Fremde GmbH', 'ws-b').workspaceId;

  assert.deepEqual(call(deps, other, 'accrual_list', {}).accruals, []);
  assert.equal(call(deps, other, 'accrual_get', { accrualId: draft.accrual.id }).error, 'not_found');
  assert.equal(call(deps, other, 'accrual_post', { accrualId: draft.accrual.id, idempotencyKey: 'b-p' }).error, 'not_found');
  assert.equal(call(deps, other, 'accrual_discard', { accrualId: draft.accrual.id, idempotencyKey: 'b-d' }).error, 'not_found');
  assert.equal(accrualRow(deps, draft.accrual.id).status, 'draft', "A's draft is untouched");

  call(deps, ws, 'accrual_post', { accrualId: draft.accrual.id, idempotencyKey: 'p-1' });
  assert.equal(call(deps, other, 'accrual_reverse', { accrualId: draft.accrual.id, idempotencyKey: 'b-r' }).error, 'not_found');
  assert.equal(entryCount(deps, other), 0, 'B carries none of A entries');
  assert.equal(entryCount(deps, ws), 2, 'A pair stands');
  assert.equal(accrualRow(deps, draft.accrual.id).status, 'posted');
});

test('§H-AUDIT: the immutability triggers abort a raw UPDATE of a posted accrual, a DELETE of any accrual, and a touch of its entries', () => {
  const { deps, ws } = world();
  const draft = createDraft(deps, ws);
  const posted = call(deps, ws, 'accrual_post', { accrualId: draft.accrual.id, idempotencyKey: 'p-1' });
  assert.equal(posted.ok, true);
  const db = deps.store.db;

  assert.throws(() => db.prepare('UPDATE accrual SET amount_minor = 1 WHERE id = ?').run(draft.accrual.id), /accrual_immutable/);
  assert.throws(() => db.prepare("UPDATE accrual SET status = 'draft' WHERE id = ?").run(draft.accrual.id), /accrual_immutable/);
  assert.throws(() => db.prepare('UPDATE accrual SET entry_id = NULL WHERE id = ?').run(draft.accrual.id), /accrual_immutable/);
  assert.throws(() => db.prepare('DELETE FROM accrual WHERE id = ?').run(draft.accrual.id), /accrual_append_only/);
  assert.throws(() => db.prepare('UPDATE journal_entry SET date = ? WHERE id = ?').run('2026-11-30', posted.entryId), /posted_immutable/);
  assert.throws(() => db.prepare('DELETE FROM journal_line WHERE entry_id = ?').run(posted.reversalEntryId), /posted_immutable/);

  // A draft is deletable by nobody either: discard is the only exit.
  const other = createDraft(deps, ws, {}, 'c-2');
  assert.throws(() => db.prepare('DELETE FROM accrual WHERE id = ?').run(other.accrual.id), /accrual_append_only/);

  assert.equal(accrualRow(deps, draft.accrual.id).amount_minor, 180000, 'nothing moved');
  assert.equal(entryCount(deps, ws), 2);
});

test("source='accrual' is unreachable through the raw post_entry door: only the pair writes it", () => {
  const { deps, ws, accId } = world();
  const forged = call(deps, ws, 'post_entry', {
    date: '2026-12-31',
    source: 'accrual',
    description: 'forged',
    idempotencyKey: 'forge',
    lines: [
      { account: accId('6500'), debit: 1000 },
      { account: accId('2300'), credit: 1000 },
    ],
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.error, 'invalid_source');
  assert.equal(entryCount(deps, ws), 0);
});
