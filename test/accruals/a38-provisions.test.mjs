// A38, Rückstellungen (OR 960e) and the ZStB 27/1 tax helper: the money-path evidence.
//
// Asserted on ROWS: a provision posts ONE entry and never auto-reverses (Abs. 4), a release posts
// its own entry and the open balance derives from the live releases, a release above the balance is
// refused, a reversal is blocked while a release stands and admitted once that release's entry is
// undone through `provision_release_reverse` (the raw `reverse_entry` is refused `owned_by`), every write is idempotent on rows, a second workspace sees
// nothing, the immutability triggers abort, and `source='provision'` is unreachable through
// `post_entry`. The tax helper reproduces the Steuerbuch's example 2 to the Rappen.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, workspaceId, name, input) => getAction(name).run(deps, { workspaceId, ...input });

function world() {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Nomadik GmbH', 'ws');
  return { deps, ws: workspaceId, accId };
}

const DRAFT = {
  reason: 'garantie',
  periodEnd: '2026-12-31',
  amountMinor: 500000,
  provisionAccount: '2330',
  expenseAccount: '6800',
  description: 'Garantiefälle Geschäftsjahr 2026',
};

function createDraft(deps, ws, over = {}, key = 'pc-1') {
  const res = call(deps, ws, 'provision_create', { ...DRAFT, ...over, idempotencyKey: key });
  assert.equal(res.ok, true, `draft created: ${JSON.stringify(res)}`);
  return res;
}

function postDraft(deps, ws, over = {}, key = 'pc-1') {
  const draft = createDraft(deps, ws, over, key);
  const posted = call(deps, ws, 'provision_post', { provisionId: draft.provision.id, idempotencyKey: `${key}-post` });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  return { id: draft.provision.id, posted };
}

function entryCount(deps, ws) {
  return deps.store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'").get(ws).n;
}

function entryRow(deps, id) {
  return deps.store.db.prepare('SELECT * FROM journal_entry WHERE id = ?').get(id);
}

function lineTriples(deps, entryId) {
  return deps.store.db
    .prepare('SELECT account_id, base_debit_minor AS d, base_credit_minor AS c FROM journal_line WHERE entry_id = ? ORDER BY account_id, d, c')
    .all(entryId)
    .map((l) => [l.account_id, l.d, l.c]);
}

function balance(deps, accountId) {
  return deps.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE l.account_id = ? AND e.status = 'posted'`,
    )
    .get(accountId).net;
}

function provisionRow(deps, id) {
  return deps.store.db.prepare('SELECT * FROM provision WHERE id = ?').get(id);
}

// --- The draft and its refusals --------------------------------------------------------------------

test('a draft carries Dr 6800 / Cr 2330 dated period end and posts nothing; the reason list is the statute', () => {
  const { deps, ws } = world();
  const res = createDraft(deps, ws);
  assert.equal(res.provision.status, 'draft');
  assert.equal(res.provision.openBalanceMinor, 0, 'a draft provides for nothing yet');
  assert.deepEqual(
    res.lines.map((l) => [l.accountNumber, l.debitMinor, l.creditMinor, l.date]),
    [
      ['6800', 500000, 0, '2026-12-31'],
      ['2330', 0, 500000, '2026-12-31'],
    ],
  );
  assert.equal(entryCount(deps, ws), 0);

  const reason = call(deps, ws, 'provision_create', { ...DRAFT, reason: 'goodwill', idempotencyKey: 'x' });
  assert.equal(reason.error, 'invalid_reason');
  assert.deepEqual(reason.allowed, ['garantie', 'ferien_ueberzeit', 'prozess', 'grossreparatur', 'sanierung', 'restrukturierung', 'steuern', 'sonstige']);

  const thin = call(deps, ws, 'provision_create', { ...DRAFT, reason: 'sonstige', description: 'kurz', idempotencyKey: 'thin' });
  assert.equal(thin.error, 'invalid_input');
  assert.equal(thin.reason, 'sonstige_needs_description');
  const ok = call(deps, ws, 'provision_create', { ...DRAFT, reason: 'sonstige', description: 'Rückbau Mietausbau Bahnhofstrasse', idempotencyKey: 'thick' });
  assert.equal(ok.ok, true, 'sonstige with a real description is admitted');

  const bank = call(deps, ws, 'provision_create', { ...DRAFT, provisionAccount: '1020', idempotencyKey: 'bank' });
  assert.equal(bank.error, 'invalid_account');
  assert.equal(bank.reason, 'provision_account');
  const payable = call(deps, ws, 'provision_create', { ...DRAFT, provisionAccount: '2000', idempotencyKey: 'payable' });
  assert.equal(payable.error, 'invalid_account', 'a 20xx liability is not a provision account');
  const longTerm = call(deps, ws, 'provision_create', { ...DRAFT, provisionAccount: '2600', idempotencyKey: 'lt' });
  assert.equal(longTerm.ok, true, '2600 is admitted');

  const assetExpense = call(deps, ws, 'provision_create', { ...DRAFT, expenseAccount: '1500', idempotencyKey: 'ae' });
  assert.equal(assetExpense.error, 'invalid_account');
  assert.equal(assetExpense.reason, 'expense_must_be_income_or_expense');

  const amount = call(deps, ws, 'provision_create', { ...DRAFT, amountMinor: 0, idempotencyKey: 'amt' });
  assert.equal(amount.error, 'invalid_amount');
});

test('a missing seeded provision account refuses missing_account, never a silent fallback', () => {
  const { deps, ws } = world();
  // Take 2330 out of the chart the way a workspace might: archive it, then rename the number away
  // is not possible (numbers are unique and frozen), so a fresh world without the seed row is
  // simulated by pointing at a number the chart does not carry under the seeded name.
  deps.store.db.prepare("UPDATE account SET number = '2331' WHERE workspace_id = ? AND number = '2330'").run(ws);
  const res = call(deps, ws, 'provision_create', { ...DRAFT, idempotencyKey: 'ma' });
  assert.equal(res.error, 'missing_account');
  assert.equal(res.number, '2330');
});

// --- Post, release, reverse -----------------------------------------------------------------------

test('posting writes ONE entry (source provision) with no reversal; the same key replays and a second key is already_posted, moving nothing', () => {
  const { deps, ws, accId } = world();
  const { id, posted } = postDraft(deps, ws);
  const e = entryRow(deps, posted.entryId);
  assert.equal(e.source, 'provision');
  assert.equal(e.date, '2026-12-31');
  assert.deepEqual(lineTriples(deps, e.id).sort(), [
    [accId('2330'), 0, 500000],
    [accId('6800'), 500000, 0],
  ].sort());
  assert.equal(entryCount(deps, ws), 1, 'one entry, no automatic reversal (OR 960e Abs. 4)');
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE reverses_entry_id = ?').get(e.id).n, 0);
  assert.equal(posted.provision.openBalanceMinor, 500000);

  const replay = call(deps, ws, 'provision_post', { provisionId: id, idempotencyKey: 'pc-1-post' });
  assert.deepEqual(replay, posted);
  const again = call(deps, ws, 'provision_post', { provisionId: id, idempotencyKey: 'other' });
  assert.equal(again.error, 'already_posted');
  assert.equal(again.entryId, posted.entryId);
  assert.equal(entryCount(deps, ws), 1);
  assert.equal(provisionRow(deps, id).status, 'posted');
});

test('a release posts Dr 2330 / Cr target for a partial amount, the open balance derives from the rows, and the provision reads released at zero', () => {
  const { deps, ws, accId } = world();
  const { id } = postDraft(deps, ws);

  const first = call(deps, ws, 'provision_release', { provisionId: id, date: '2027-03-15', amountMinor: 200000, targetAccount: '6800', idempotencyKey: 'rel-1' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.openBalanceMinor, 300000);
  const e1 = entryRow(deps, first.entryId);
  assert.equal(e1.source, 'provision');
  assert.equal(e1.date, '2027-03-15');
  assert.deepEqual(lineTriples(deps, e1.id).sort(), [
    [accId('2330'), 200000, 0],
    [accId('6800'), 0, 200000],
  ].sort());
  assert.equal(provisionRow(deps, id).status, 'posted', 'a partial release keeps the provision posted');
  assert.equal(balance(deps, accId('2330')), -300000, 'the liability carries the open balance');

  // Replay: the same key answers the same release and writes nothing.
  const replay = call(deps, ws, 'provision_release', { provisionId: id, date: '2027-03-15', amountMinor: 200000, targetAccount: '6800', idempotencyKey: 'rel-1' });
  assert.deepEqual(replay, first);
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM provision_release').get().n, 1);
  assert.equal(entryCount(deps, ws), 2);

  // Above the open balance: refused, nothing written.
  const tooMuch = call(deps, ws, 'provision_release', { provisionId: id, date: '2027-03-16', amountMinor: 300001, targetAccount: '6800', idempotencyKey: 'rel-x' });
  assert.equal(tooMuch.error, 'release_exceeds_balance');
  assert.equal(tooMuch.openBalanceMinor, 300000);
  assert.equal(entryCount(deps, ws), 2);

  // The rest, to an income account: released at zero.
  const rest = call(deps, ws, 'provision_release', { provisionId: id, date: '2027-06-30', amountMinor: 300000, targetAccount: '3600', idempotencyKey: 'rel-2' });
  assert.equal(rest.ok, true, JSON.stringify(rest));
  assert.equal(rest.openBalanceMinor, 0);
  assert.equal(rest.provision.status, 'released');
  assert.equal(balance(deps, accId('2330')), 0, '2330 is clear');
  assert.equal(entryCount(deps, ws), 3);

  const got = call(deps, ws, 'provision_get', { provisionId: id });
  assert.equal(got.releases.length, 2);
  assert.equal(got.openBalanceMinor, 0);

  // A released provision takes no further release.
  const none = call(deps, ws, 'provision_release', { provisionId: id, date: '2027-07-01', amountMinor: 1, targetAccount: '6800', idempotencyKey: 'rel-3' });
  assert.equal(none.error, 'release_exceeds_balance');

  // Releasing a draft, or a bad target, is refused.
  const draft = createDraft(deps, ws, {}, 'pc-2');
  assert.equal(call(deps, ws, 'provision_release', { provisionId: draft.provision.id, date: '2027-01-01', amountMinor: 1, targetAccount: '6800', idempotencyKey: 'rel-d' }).error, 'not_posted');
  const { id: other } = postDraft(deps, ws, {}, 'pc-3');
  const badTarget = call(deps, ws, 'provision_release', { provisionId: other, date: '2027-01-01', amountMinor: 1, targetAccount: '1020', idempotencyKey: 'rel-t' });
  assert.equal(badTarget.error, 'invalid_account');
  assert.equal(badTarget.reason, 'target_must_be_income_or_expense');
});

test('a reversal is blocked while a release stands, and admitted once that release is undone through provision_release_reverse (the balance reads it live)', () => {
  const { deps, ws, accId } = world();
  const { id, posted } = postDraft(deps, ws);
  const rel = call(deps, ws, 'provision_release', { provisionId: id, date: '2027-03-15', amountMinor: 200000, targetAccount: '6800', idempotencyKey: 'rel-1' });
  assert.equal(rel.ok, true);

  const blocked = call(deps, ws, 'provision_reverse', { provisionId: id, idempotencyKey: 'rev-1' });
  assert.equal(blocked.error, 'release_blocked');
  assert.deepEqual(blocked.releases.map((r) => r.entryId), [rel.entryId]);
  assert.equal(entryCount(deps, ws), 2, 'nothing was posted');

  // Undo the release through its owning verb: a real reversal of its entry (the raw tool is owned_by).
  const raw = call(deps, ws, 'reverse_entry', { entryId: rel.entryId, date: '2027-03-15', idempotencyKey: 'undo-raw' });
  assert.equal(raw.error, 'owned_by', JSON.stringify(raw));
  const undo = call(deps, ws, 'provision_release_reverse', { releaseId: rel.releaseId, date: '2027-03-15', idempotencyKey: 'undo-rel' });
  assert.equal(undo.ok, true, JSON.stringify(undo));
  const got = call(deps, ws, 'provision_get', { provisionId: id });
  assert.equal(got.releases[0].reversedByEntryId, undo.reversalEntryId, 'the read names the reversal');
  assert.equal(got.openBalanceMinor, 500000, 'the open balance is back to the formation amount, derived not stored');

  const reversed = call(deps, ws, 'provision_reverse', { provisionId: id, reason: 'Fall erledigt, keine Kosten', idempotencyKey: 'rev-2' });
  assert.equal(reversed.ok, true, JSON.stringify(reversed));
  const r = entryRow(deps, reversed.reversalEntryId);
  assert.equal(r.reverses_entry_id, posted.entryId, 'the formation entry is what is reversed');
  assert.equal(r.date, '2026-12-31', 'dated the formation date by default');
  assert.equal(r.source, 'reversal');
  assert.equal(provisionRow(deps, id).status, 'reversed');
  assert.equal(provisionRow(deps, id).reverse_reason, 'Fall erledigt, keine Kosten');
  assert.equal(balance(deps, accId('2330')), 0);
  assert.equal(balance(deps, accId('6800')), 0);
  assert.equal(entryCount(deps, ws), 4);

  const replay = call(deps, ws, 'provision_reverse', { provisionId: id, reason: 'Fall erledigt, keine Kosten', idempotencyKey: 'rev-2' });
  assert.deepEqual(replay, reversed);
  const again = call(deps, ws, 'provision_reverse', { provisionId: id, idempotencyKey: 'rev-3' });
  assert.equal(again.error, 'already_reversed');
  assert.equal(entryCount(deps, ws), 4);
  assert.equal(call(deps, ws, 'provision_release', { provisionId: id, date: '2027-01-01', amountMinor: 1, targetAccount: '6800', idempotencyKey: 'rel-z' }).error, 'already_reversed');
});

test('a full release undone through provision_release_reverse reads posted with the full balance again: released is derived, never stored', () => {
  const { deps, ws, accId } = world();
  const { id } = postDraft(deps, ws);
  const full = call(deps, ws, 'provision_release', { provisionId: id, date: '2027-03-15', amountMinor: 500000, targetAccount: '6800', idempotencyKey: 'rel-full' });
  assert.equal(full.ok, true, JSON.stringify(full));
  assert.equal(full.provision.status, 'released');
  assert.equal(full.openBalanceMinor, 0);
  assert.deepEqual(call(deps, ws, 'provision_list', { status: 'released' }).provisions.map((p) => p.id), [id]);
  assert.deepEqual(call(deps, ws, 'provision_list', { status: 'posted' }).provisions, []);

  // Undo the release through its owning verb: the balance and the status both come back from the rows.
  const undo = call(deps, ws, 'provision_release_reverse', { releaseId: full.releaseId, date: '2027-03-15', idempotencyKey: 'undo-full' });
  assert.equal(undo.ok, true, JSON.stringify(undo));
  const got = call(deps, ws, 'provision_get', { provisionId: id });
  assert.equal(got.provision.status, 'posted', 'a provision that provides again reads posted, whatever the column says');
  assert.equal(got.openBalanceMinor, 500000);
  assert.equal(balance(deps, accId('2330')), -500000, 'the liability carries the full amount again');
  assert.deepEqual(call(deps, ws, 'provision_list', { status: 'released' }).provisions, [], 'the released filter no longer lists a provision that still provides');
  assert.deepEqual(call(deps, ws, 'provision_list', { status: 'posted' }).provisions.map((p) => p.id), [id]);
  assert.equal(call(deps, ws, 'provision_list', {}).openTotalMinor, 500000);

  // And it can be released again, in full, to the Rappen.
  const again = call(deps, ws, 'provision_release', { provisionId: id, date: '2027-06-30', amountMinor: 500000, targetAccount: '3600', idempotencyKey: 'rel-full-2' });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.provision.status, 'released');
  assert.equal(call(deps, ws, 'provision_get', { provisionId: id }).provision.status, 'released');
});

test('a release key already bound to ANOTHER provision is refused by name before anything posts', () => {
  const { deps, ws } = world();
  const { id: a } = postDraft(deps, ws, {}, 'pa');
  const { id: b } = postDraft(deps, ws, { reason: 'prozess', amountMinor: 120000 }, 'pb');
  const first = call(deps, ws, 'provision_release', { provisionId: a, date: '2027-03-15', amountMinor: 100000, targetAccount: '6800', idempotencyKey: 'rel-shared' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const entries = entryCount(deps, ws);

  const clash = call(deps, ws, 'provision_release', { provisionId: b, date: '2027-03-15', amountMinor: 50000, targetAccount: '6800', idempotencyKey: 'rel-shared' });
  assert.equal(clash.ok, false);
  assert.equal(clash.error, 'invalid_input', JSON.stringify(clash));
  assert.equal(clash.field, 'idempotencyKey');
  assert.equal(clash.reason, 'key_bound_to_another_provision');
  assert.equal(entryCount(deps, ws), entries, 'the ledger is untouched');
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM provision_release').get().n, 1);
  assert.equal(call(deps, ws, 'provision_get', { provisionId: b }).openBalanceMinor, 120000);
});

test('a reversal honours a caller date and refuses not_posted on a draft', () => {
  const { deps, ws } = world();
  const { id } = postDraft(deps, ws);
  const reversed = call(deps, ws, 'provision_reverse', { provisionId: id, date: '2027-01-15', idempotencyKey: 'rev-d' });
  assert.equal(reversed.ok, true, JSON.stringify(reversed));
  assert.equal(entryRow(deps, reversed.reversalEntryId).date, '2027-01-15');
  const draft = createDraft(deps, ws, {}, 'pc-2');
  assert.equal(call(deps, ws, 'provision_reverse', { provisionId: draft.provision.id, idempotencyKey: 'rev-x' }).error, 'not_posted');
});

test('discard is a status: a discarded draft neither posts nor is deleted, and a posted provision cannot be discarded', () => {
  const { deps, ws } = world();
  const draft = createDraft(deps, ws);
  const gone = call(deps, ws, 'provision_discard', { provisionId: draft.provision.id, reason: 'doppelt', idempotencyKey: 'd-1' });
  assert.equal(gone.ok, true);
  assert.equal(gone.provision.status, 'discarded');
  assert.deepEqual(call(deps, ws, 'provision_discard', { provisionId: draft.provision.id, idempotencyKey: 'd-1' }), gone);
  assert.equal(call(deps, ws, 'provision_discard', { provisionId: draft.provision.id, idempotencyKey: 'd-2' }).error, 'draft_discarded');
  assert.equal(call(deps, ws, 'provision_post', { provisionId: draft.provision.id, idempotencyKey: 'p' }).error, 'draft_discarded');
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM provision').get().n, 1);
  const { id } = postDraft(deps, ws, {}, 'pc-2');
  assert.equal(call(deps, ws, 'provision_discard', { provisionId: id, idempotencyKey: 'd-3' }).error, 'already_posted');
});

test('provision_list filters by status and reason and sums the open balances', () => {
  const { deps, ws } = world();
  const { id: a } = postDraft(deps, ws, {}, 'pa');
  postDraft(deps, ws, { reason: 'prozess', amountMinor: 120000, periodEnd: '2026-06-30' }, 'pb');
  createDraft(deps, ws, { reason: 'steuern', expenseAccount: '8900', amountMinor: 30000 }, 'pc');
  call(deps, ws, 'provision_release', { provisionId: a, date: '2027-01-10', amountMinor: 100000, targetAccount: '6800', idempotencyKey: 'rel' });

  const all = call(deps, ws, 'provision_list', {});
  assert.equal(all.provisions.length, 3);
  assert.equal(all.openTotalMinor, 400000 + 120000, 'the draft provides for nothing; the released part is gone');
  assert.deepEqual(call(deps, ws, 'provision_list', { reason: 'prozess' }).provisions.map((p) => p.periodEnd), ['2026-06-30']);
  assert.equal(call(deps, ws, 'provision_list', { status: 'draft' }).provisions.length, 1);
  assert.equal(call(deps, ws, 'provision_list', { status: 'wrong' }).error, 'invalid_input');
  assert.equal(call(deps, ws, 'provision_list', { savedViewId: 'view_none' }).error, 'not_found');
});

// --- The tax helper -------------------------------------------------------------------------------

test('ZStB 27/1 example 2 to the Rappen: profit 900, 20 % gives 150, minus 100 provisorisch already charged, 50 to provide; the draft posts Dr 8900 / Cr 2330', () => {
  const { deps, ws, accId } = world();
  // Revenue CHF 900.00 and a provisional tax instalment of CHF 100.00 on 8900, both inside FY 2026.
  assert.equal(
    call(deps, ws, 'post_entry', {
      date: '2026-03-15',
      source: 'manual',
      description: 'Beratungshonorar',
      idempotencyKey: 'rev',
      lines: [
        { account: accId('1020'), debit: 90000 },
        { account: accId('3400'), credit: 90000 },
      ],
    }).ok,
    true,
  );
  assert.equal(
    call(deps, ws, 'post_entry', {
      date: '2026-05-02',
      source: 'manual',
      description: 'Provisorische Steuerrechnung',
      idempotencyKey: 'inst',
      lines: [
        { account: accId('8900'), debit: 10000 },
        { account: accId('1020'), credit: 10000 },
      ],
    }).ok,
    true,
  );

  const preview = call(deps, ws, 'tax_provision_preview', { periodEnd: '2026-12-31' });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.applicable, true);
  assert.equal(preview.rateBp, 2000, 'the default is the Steuerbuch illustration');
  assert.equal(preview.fiscalYearStart, '2026-01-01');
  assert.equal(preview.profitBeforeTaxMinor, 90000, 'the 8900 instalment is not deducted from the profit before tax');
  assert.equal(preview.grossProvisionMinor, 15000);
  assert.equal(preview.instalmentsMinor, 10000);
  assert.equal(preview.proposedMinor, 5000);
  assert.deepEqual(preview.missingAccounts, []);
  assert.equal(preview.proposedDraft.reason, 'steuern');
  assert.equal(preview.proposedDraft.amountMinor, 5000);
  assert.equal(preview.proposedDraft.provisionAccount, '2330');
  assert.equal(preview.proposedDraft.expenseAccount, '8900');
  assert.equal(entryCount(deps, ws), 2, 'the helper posted nothing');

  // The hand-off: the draft the helper proposes is a valid provision_create input as it stands.
  const draft = call(deps, ws, 'provision_create', { ...preview.proposedDraft, idempotencyKey: 'tax-1' });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  assert.deepEqual(
    draft.lines.map((l) => [l.accountNumber, l.debitMinor, l.creditMinor]),
    [
      ['8900', 5000, 0],
      ['2330', 0, 5000],
    ],
  );

  // A different rate is an input, never a constant: 15 % gives 900 × 15/115 = 117.39, minus 100.
  const fifteen = call(deps, ws, 'tax_provision_preview', { periodEnd: '2026-12-31', rateBp: 1500 });
  assert.equal(fifteen.grossProvisionMinor, 11739);
  assert.equal(fifteen.proposedMinor, 1739);
  assert.equal(call(deps, ws, 'tax_provision_preview', { periodEnd: '2026-12-31', rateBp: 20000 }).error, 'invalid_rate');
});

test('a non-positive profit proposes zero with no draft; an Einzelfirma is not applicable; the fiscal year bounds the read', () => {
  const { deps, ws, accId } = world();
  assert.equal(
    call(deps, ws, 'post_entry', {
      date: '2026-02-01',
      source: 'manual',
      description: 'Miete',
      idempotencyKey: 'loss',
      lines: [
        { account: accId('6000'), debit: 40000 },
        { account: accId('1020'), credit: 40000 },
      ],
    }).ok,
    true,
  );
  const loss = call(deps, ws, 'tax_provision_preview', { periodEnd: '2026-12-31' });
  assert.equal(loss.profitBeforeTaxMinor, -40000);
  assert.equal(loss.grossProvisionMinor, 0);
  assert.equal(loss.proposedMinor, 0);
  assert.equal(loss.proposedDraft, null);

  // The read is bounded by the fiscal year: revenue in 2025 does not count for FY 2026.
  assert.equal(
    call(deps, ws, 'post_entry', {
      date: '2025-12-20',
      source: 'manual',
      description: 'Vorjahr',
      idempotencyKey: 'prior',
      lines: [
        { account: accId('1020'), debit: 999900 },
        { account: accId('3400'), credit: 999900 },
      ],
    }).ok,
    true,
  );
  assert.equal(call(deps, ws, 'tax_provision_preview', { periodEnd: '2026-12-31' }).profitBeforeTaxMinor, -40000);
  assert.equal(call(deps, ws, 'tax_provision_preview', { periodEnd: '2025-12-31' }).profitBeforeTaxMinor, 999900);

  const einzel = freshDeps();
  const made = getAction('create_workspace').run(einzel, { name: 'Muster Einzelfirma', legalForm: 'einzelfirma', idempotencyKey: 'ws-e' });
  assert.equal(made.ok, true);
  const res = call(einzel, made.workspaceId, 'tax_provision_preview', { periodEnd: '2026-12-31' });
  assert.equal(res.ok, true);
  assert.equal(res.applicable, false);
  assert.equal(res.reason, 'einzelfirma');
});

// --- §H-TENANT, §H-AUDIT, the shut door -----------------------------------------------------------

test('§H-TENANT: a second workspace lists nothing and gets not_found on every foreign id; A rows never move', () => {
  const { deps, ws } = world();
  const { id } = postDraft(deps, ws);
  const other = mintWorkspace(deps, 'Fremde GmbH', 'ws-b').workspaceId;
  assert.deepEqual(call(deps, other, 'provision_list', {}).provisions, []);
  assert.equal(call(deps, other, 'provision_get', { provisionId: id }).error, 'not_found');
  assert.equal(call(deps, other, 'provision_release', { provisionId: id, date: '2027-01-01', amountMinor: 1, targetAccount: '6800', idempotencyKey: 'b' }).error, 'not_found');
  assert.equal(call(deps, other, 'provision_reverse', { provisionId: id, idempotencyKey: 'b2' }).error, 'not_found');
  assert.equal(call(deps, other, 'provision_discard', { provisionId: id, idempotencyKey: 'b3' }).error, 'not_found');
  assert.equal(entryCount(deps, other), 0);
  assert.equal(entryCount(deps, ws), 1);
  assert.equal(provisionRow(deps, id).status, 'posted');
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM provision_release').get().n, 0);
});

test('§H-AUDIT: the triggers abort a raw UPDATE of a posted provision, any DELETE, and any touch of a release row', () => {
  const { deps, ws } = world();
  const { id } = postDraft(deps, ws);
  const rel = call(deps, ws, 'provision_release', { provisionId: id, date: '2027-01-10', amountMinor: 100000, targetAccount: '6800', idempotencyKey: 'rel' });
  assert.equal(rel.ok, true);
  const db = deps.store.db;
  assert.throws(() => db.prepare('UPDATE provision SET amount_minor = 1 WHERE id = ?').run(id), /provision_immutable/);
  assert.throws(() => db.prepare("UPDATE provision SET status = 'draft' WHERE id = ?").run(id), /provision_immutable/);
  assert.throws(() => db.prepare('DELETE FROM provision WHERE id = ?').run(id), /provision_append_only/);
  assert.throws(() => db.prepare('UPDATE provision_release SET amount_minor = 1 WHERE id = ?').run(rel.releaseId), /provision_release_immutable/);
  assert.throws(() => db.prepare('DELETE FROM provision_release WHERE id = ?').run(rel.releaseId), /provision_release_append_only/);
  assert.throws(() => db.prepare('DELETE FROM journal_entry WHERE id = ?').run(rel.entryId), /posted_immutable/);
  assert.equal(provisionRow(deps, id).amount_minor, 500000);
});

test("source='provision' is unreachable through the raw post_entry door", () => {
  const { deps, ws, accId } = world();
  const forged = call(deps, ws, 'post_entry', {
    date: '2026-12-31',
    source: 'provision',
    description: 'forged',
    idempotencyKey: 'forge',
    lines: [
      { account: accId('6800'), debit: 1000 },
      { account: accId('2330'), credit: 1000 },
    ],
  });
  assert.equal(forged.error, 'invalid_source');
  assert.equal(entryCount(deps, ws), 0);
});

test('a spent release key: release with K, undo through provision_release_reverse, release with K again is already_reversed_key (never a silent ok), and a NEW key releases again', () => {
  // Critic LOW, 2026-09-10: the replay branch answered ok with the OLD entry id and wrote nothing,
  // although the release it named had been undone. Failed on the pre-fix dist.
  const { deps, ws, accId } = world();
  const { id } = postDraft(deps, ws);
  const first = call(deps, ws, 'provision_release', { provisionId: id, date: '2027-03-15', amountMinor: 200000, targetAccount: '6800', idempotencyKey: 'spent-K' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const undo = call(deps, ws, 'provision_release_reverse', { releaseId: first.releaseId, date: '2027-03-15', idempotencyKey: 'spent-undo' });
  assert.equal(undo.ok, true, JSON.stringify(undo));
  const entriesBefore = entryCount(deps, ws);
  assert.equal(call(deps, ws, 'provision_get', { provisionId: id }).openBalanceMinor, 500000);

  const replay = call(deps, ws, 'provision_release', { provisionId: id, date: '2027-03-15', amountMinor: 200000, targetAccount: '6800', idempotencyKey: 'spent-K' });
  assert.equal(replay.ok, false, JSON.stringify(replay));
  assert.equal(replay.error, 'already_reversed_key');
  assert.equal(replay.provisionId, id);
  assert.equal(replay.releaseId, first.releaseId, 'the refusal names the release the key made');
  assert.equal(replay.reversalEntryId, undo.reversalEntryId, 'and the entry that undid it');
  assert.equal(replay.idempotencyKey, 'spent-K');
  assert.match(replay.remedy, /NEW idempotencyKey/);
  assert.equal(entryCount(deps, ws), entriesBefore, 'nothing was posted');
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM provision_release').get().n, 1, 'no second release row');
  assert.equal(call(deps, ws, 'provision_get', { provisionId: id }).openBalanceMinor, 500000, 'the balance did not move');

  const fresh = call(deps, ws, 'provision_release', { provisionId: id, date: '2027-03-16', amountMinor: 200000, targetAccount: '6800', idempotencyKey: 'spent-K2' });
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
  assert.notEqual(fresh.releaseId, first.releaseId);
  assert.notEqual(fresh.entryId, first.entryId);
  assert.equal(fresh.openBalanceMinor, 300000);
  assert.equal(entryCount(deps, ws), entriesBefore + 1);
  assert.equal(balance(deps, accId('2330')), -300000);
});
