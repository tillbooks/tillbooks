// A34 money path: `wage_journal_reverse` (D171, the D141.3 follow-up, owner decision 14.10.2026,
// family 4 of 4).
//
// Before D171 a posted wage journal had no undo verb. The raw `reverse_entry` reversed its `import`
// entry and nothing else knew: `list_payroll_handoffs` still listed the posting as standing. Each
// assertion here fails if the owning verb, the row-backed ownership in `OWNED_REVERSAL_SOURCES`, the
// chain walk, the bank-line refusal, the tenant scope or the row idempotency is removed.
//
// SYNTHETIC BY CONSTRUCTION: no employee, no name, no AHV number appears here; the journal is an
// invented aggregate (CHF 5'000 gross, CHF 500 employer social cost) on the shipped KMU chart, and the
// bank statement is spelled by hand on the published sample IBAN the A39 suite uses.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lockPeriod, reverseEntry, setOpeningBalances, postEntry } from '../../dist/core/ledger/index.js';
import { reverseOwnedEntry, OWNED_REVERSAL_SOURCES } from '../../dist/core/ledger/reverseEntry.js';
import { wageJournalPost, wageJournalReverse, listPayrollHandoffs } from '../../dist/core/payroll/index.js';
import { bookBankLine, reopenBankLine } from '../../dist/core/banking/index.js';
import { CAPABILITY_FOR_ACTION } from '../../dist/core/access/actionCapabilities.js';
import { setup, capCtx, counts, wageLines, secondWorkspace } from './support.mjs';
import { world as bankWorld, importLines, excuseClaimInvariant } from '../banking/bank-inbox-support.mjs';

const DATE = '2026-07-05';
const TODAY = '2026-07-19'; // the payments fixture's pinned clock

function must(res, what = 'call') {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

function posted(t, key = 'wjp') {
  return must(wageJournalPost(t.ctx, { lines: wageLines(), entryDate: DATE, confirm: true, idempotencyKey: key }), 'wage_journal_post');
}

const reverse = (t, wageJournalPostId, key, reason = 'Falsche Lohnperiode', ctx = t.ctx) =>
  wageJournalReverse(ctx, { wageJournalPostId, reason, idempotencyKey: key });

/** The posted net (debit minus credit) on an account number across every posted entry. */
function net(t, number) {
  return t.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS n
         FROM journal_line l JOIN account a ON a.id = l.account_id JOIN journal_entry e ON e.id = l.entry_id
        WHERE a.workspace_id = ? AND a.number = ? AND e.status = 'posted'`,
    )
    .get(t.workspaceId, number).n;
}

function postingRow(t, id) {
  const res = must(listPayrollHandoffs(t.ctx, {}), 'list');
  return res.handoffs.find((r) => r.id === id);
}

/** The raw Storno a book written before D171 could carry, simulated under the owner token. */
function legacyRawReverse(t, entryId, key) {
  return must(reverseOwnedEntry(t.ctx, { entryId, idempotencyKey: key }, 'wage_journal_reverse'), 'legacy raw reverse').reversalId;
}

test('D171: a posted wage journal is mirrored by ONE owned A02 entry dated today; the row stays and the list names the mirror', () => {
  const t = setup();
  const p = posted(t);
  const before = counts(t.store, t.workspaceId);

  const res = must(reverse(t, p.wageJournalPostId, 'r-1'), 'reverse');
  assert.equal(res.postedEntryId, p.postedEntryId);
  assert.equal(res.reversalDate, TODAY, 'OR 957a: the correction is dated in the open period, today');

  const after = counts(t.store, t.workspaceId);
  assert.equal(after.entries, before.entries + 1, 'exactly ONE mirror entry');
  assert.equal(after.postings, before.postings, 'the append-only wage_journal_posts row is untouched');

  const mirror = t.store.db.prepare('SELECT source, status, date, reverses_entry_id, description FROM journal_entry WHERE id = ?').get(res.reversalEntryId);
  assert.equal(mirror.source, 'reversal');
  assert.equal(mirror.reverses_entry_id, p.postedEntryId);
  assert.equal(mirror.date, TODAY);
  assert.match(mirror.description, /Falsche Lohnperiode/, 'the reason rides the mirror text');

  for (const n of ['5000', '5700', '2260']) assert.equal(net(t, n), 0, `${n} nets to zero after the reverse`);
  assert.equal(postingRow(t, p.wageJournalPostId).reversalEntryId, res.reversalEntryId, 'the history names the mirror');
});

test('D171: idempotent on ROWS: the same key replays, a new key refuses already_reversed naming the mirror, nothing is written twice', () => {
  const t = setup();
  const p = posted(t);
  const first = must(reverse(t, p.wageJournalPostId, 'r-dup'));
  const mid = counts(t.store, t.workspaceId);
  const again = must(reverse(t, p.wageJournalPostId, 'r-dup'), 'replay');
  assert.equal(again.reversalEntryId, first.reversalEntryId, 'the replay answers the stored result');
  const fresh = reverse(t, p.wageJournalPostId, 'r-other');
  assert.equal(fresh.ok, false);
  assert.equal(fresh.error, 'already_reversed');
  assert.equal(fresh.reversalEntryId, first.reversalEntryId);
  assert.deepEqual(counts(t.store, t.workspaceId), mid, 'neither the replay nor the second key wrote a row');
});

test('D171: the corrected journal is re-imported under a new key; the reversed one stays reversed', () => {
  const t = setup();
  const p = posted(t, 'wjp-a');
  must(reverse(t, p.wageJournalPostId, 'r-a'));
  const again = posted(t, 'wjp-b');
  assert.notEqual(again.postedEntryId, p.postedEntryId);
  assert.equal(net(t, '5000'), 500000, 'only the corrected journal stands');
  assert.equal(postingRow(t, again.wageJournalPostId).reversalEntryId, null);
  assert.notEqual(postingRow(t, p.wageJournalPostId).reversalEntryId, null);
});

test('D171: a locked period refuses period_locked before any write', () => {
  const t = setup();
  const p = posted(t);
  must(lockPeriod(t.ctx, { period: '2026-07', kind: 'hard', idempotencyKey: 'lk' }), 'lock');
  const before = counts(t.store, t.workspaceId);
  const res = reverse(t, p.wageJournalPostId, 'r-lk');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'period_locked');
  assert.deepEqual(counts(t.store, t.workspaceId), before);
});

test('D171: a reason is required, post is required, an unknown id and another tenant see not_found', () => {
  const t = setup();
  const p = posted(t);
  const before = counts(t.store, t.workspaceId);
  assert.equal(reverse(t, p.wageJournalPostId, 'g-1', '   ').error, 'reason_required');
  const noPost = reverse(t, p.wageJournalPostId, 'g-2', 'x', capCtx(t, 'clerk', ['hr.read', 'hr.manage']));
  assert.equal(noPost.ok, false);
  assert.equal(noPost.capability, 'post');
  assert.equal(reverse(t, 'wjp_nope', 'g-3').error, 'not_found');
  const other = secondWorkspace(t);
  const foreign = wageJournalReverse(other.ctx, { wageJournalPostId: p.wageJournalPostId, reason: 'x', idempotencyKey: 'g-4' });
  assert.equal(foreign.error, 'not_found', 'another workspace cannot reach this posting');
  // The refusal comes from the §H-TENANT row read itself, before anything reaches the ledger: it names
  // the posting, not an entry (A02's own not_found, one layer down, names `entryId`).
  assert.equal(foreign.wageJournalPostId, p.wageJournalPostId);
  assert.equal(foreign.entryId, undefined, 'the foreign call never got as far as the ledger');
  assert.deepEqual(counts(t.store, t.workspaceId), before);
  assert.equal(CAPABILITY_FOR_ACTION.wage_journal_reverse, 'post');
});

test('D171 ownership: raw reverse_entry on a wage journal entry refuses owned_by wage_journal_reverse, and so does its mirror', () => {
  const t = setup();
  const p = posted(t);
  const raw = reverseEntry(t.ctx, { entryId: p.postedEntryId, idempotencyKey: 'raw' });
  assert.equal(raw.ok, false, `the raw Storno must not bypass the wage journal: ${JSON.stringify(raw)}`);
  assert.equal(raw.error, 'owned_by');
  assert.equal(raw.verb, 'wage_journal_reverse');
  const res = must(reverse(t, p.wageJournalPostId, 'r-own'));
  const rawMirror = reverseEntry(t.ctx, { entryId: res.reversalEntryId, idempotencyKey: 'raw-mirror' });
  assert.equal(rawMirror.ok, false);
  assert.equal(rawMirror.verb, 'wage_journal_reverse');
  assert.equal(typeof OWNED_REVERSAL_SOURCES.import, 'function', '`import` resolves BY ROW, never by source alone');
});

test('D171 ownership is BY ROW: an import-sourced opening balance and a post_entry import stay reversible raw', () => {
  const t = setup();
  posted(t);
  const opening = must(
    setOpeningBalances(t.ctx, {
      asOf: '2026-01-01',
      lines: [
        { account: t.acc('1020'), debitMinor: 100000 },
        { account: t.acc('2800'), creditMinor: 100000 },
      ],
      idempotencyKey: 'ob',
    }),
    'opening',
  );
  const openingEntryId = opening.entryId;
  assert.equal(t.store.db.prepare('SELECT source FROM journal_entry WHERE id = ?').get(openingEntryId).source, 'import');
  must(reverseEntry(t.ctx, { entryId: openingEntryId, idempotencyKey: 'ob-rev' }), 'the opening is not a wage journal');

  const manual = must(
    postEntry(t.ctx, {
      date: DATE,
      source: 'import',
      description: 'Importierte Buchung',
      lines: [
        { account: t.acc('6500'), debit: 1000 },
        { account: t.acc('1020'), credit: 1000 },
      ],
      idempotencyKey: 'pe-imp',
    }),
    'post_entry import',
  );
  must(reverseEntry(t.ctx, { entryId: manual.entryId, idempotencyKey: 'pe-rev' }), 'an import entry no wage row names stays raw');
});

test('critic lesson (D168/D169): a legacy raw-reversed wage journal answers already_reversed naming that mirror, nothing posted', () => {
  const t = setup();
  const p = posted(t);
  const mirror = legacyRawReverse(t, p.postedEntryId, 'legacy');
  const before = counts(t.store, t.workspaceId);
  const res = reverse(t, p.wageJournalPostId, 'r-legacy');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'already_reversed');
  assert.equal(res.reversalEntryId, mirror);
  assert.deepEqual(counts(t.store, t.workspaceId), before);
  assert.equal(postingRow(t, p.wageJournalPostId).reversalEntryId, mirror, 'the history reads the legacy mirror too');
});

test('critic lesson (D168/D169): a double-reversed chain (the journal stands again) posts a fresh mirror of the LAST link', () => {
  const t = setup();
  const p = posted(t);
  const r1 = legacyRawReverse(t, p.postedEntryId, 'l1');
  const r2 = legacyRawReverse(t, r1, 'l2');
  assert.equal(postingRow(t, p.wageJournalPostId).reversalEntryId, null, 'an even chain: the journal stands');
  assert.equal(net(t, '5000'), 500000);
  const res = must(reverse(t, p.wageJournalPostId, 'r-even'));
  const mirror = t.store.db.prepare('SELECT reverses_entry_id FROM journal_entry WHERE id = ?').get(res.reversalEntryId);
  assert.equal(mirror.reverses_entry_id, r2, 'A02 reverses an entry once: the mirror aims at the last link');
  assert.equal(net(t, '5000'), 0);
  assert.equal(postingRow(t, p.wageJournalPostId).reversalEntryId, res.reversalEntryId);
});

test('D171: a bank line that booked the wage journal refuses owned_by reopen_bank_line naming the line; after the reopen it reverses', () => {
  const w = bankWorld();
  // A synthetic journal that pays the net wage straight from the bank: 5000 / 1020.
  const p = must(
    wageJournalPost(w.ctx, {
      lines: [
        { accountNumber: '5000', debitMinor: 420000, description: 'Lohnaufwand' },
        { accountId: w.bankId, creditMinor: 420000, description: 'Nettolohn ab Bank' },
      ],
      entryDate: '2026-07-20',
      confirm: true,
      idempotencyKey: 'wjp-bank',
    }),
    'wage journal through the bank',
  );
  const { lines } = importLines(w, { statementId: 'WJ-1', entries: [{ ref: 'LOHN', amountMinor: 420000, cd: 'DBIT' }] });
  must(bookBankLine(w.ctx, { bankTxnId: lines.LOHN, target: { kind: 'existing_entry', entryId: p.postedEntryId }, idempotencyKey: 'bk' }), 'match');

  const before = counts(w.store, w.workspaceId);
  const res = wageJournalReverse(w.ctx, { wageJournalPostId: p.wageJournalPostId, reason: 'Falsch', idempotencyKey: 'r-bank' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'owned_by');
  assert.equal(res.verb, 'reopen_bank_line');
  assert.equal(res.bankTxnId, lines.LOHN, 'the refusal names the line to reopen first');
  assert.deepEqual(counts(w.store, w.workspaceId), before, 'the refusal wrote nothing');

  must(reopenBankLine(w.ctx, { bankTxnId: lines.LOHN, reason: 'Lohnjournal falsch', idempotencyKey: 'reopen' }), 'reopen');
  must(wageJournalReverse(w.ctx, { wageJournalPostId: p.wageJournalPostId, reason: 'Falsch', idempotencyKey: 'r-bank-2' }), 'reverse after reopen');
  excuseClaimInvariant();
});
