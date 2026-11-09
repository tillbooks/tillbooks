/**
 * D190, the export date range and the journal filters (A25 §4, US-A25.4).
 *
 * What this holds, each against the real registry and the real ledger:
 *
 *  - A whole month (or calendar year) given as from/to IS that period: the same bytes, the same name.
 *  - Any other range, and any filter, writes a `scope` record naming the dates and every active filter,
 *    labels the total as the total of the lines in this file, and names a filtered file `journal-auszug`.
 *  - The rows are never touched: every line record of a ranged or filtered file is, string for string,
 *    the record the unfiltered export of the same days writes for that line. The filter only chooses.
 *  - The account filter keeps WHOLE entries, so a filtered file still foots, and drafts never leak.
 *  - Every malformed combination is a NAMED refusal, never a silent default or an ignored field.
 *  - Same input, same bytes; §H-TENANT on the new query path (the account lookup and the filter).
 *  - `export_statements` over a range is byte-identical to A08's `export_statement` for those dates, and
 *    a range that is not whole months answers `range_not_whole_months`. `export_vat` refuses a range.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

function post(fx, key, date, source, debitAcc, creditAcc, amount) {
  const res = fx.call('post_entry', {
    date,
    source,
    description: `Synthetic ${key}`,
    idempotencyKey: key,
    lines: [
      { account: fx.accId(debitAcc), debit: amount },
      { account: fx.accId(creditAcc), credit: amount },
    ],
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.entryId;
}

/**
 * A synthetic book (invented, no real data): four posted entries over March and April 2026 on two
 * sources and four accounts, and a draft that must never reach a file.
 */
function fixture(seed, deps = freshDeps()) {
  const { workspaceId, accId } = mintWorkspace(deps, `Range ${seed} AG`, `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const fx = { deps, workspaceId, accId, call };
  fx.e1 = post(fx, `${seed}-1`, '2026-03-01', 'manual', '6500', '1000', 5000);
  fx.e2 = post(fx, `${seed}-2`, '2026-03-10', 'manual', '6500', '1020', 7300);
  fx.e3 = post(fx, `${seed}-3`, '2026-03-31', 'import', '1020', '3200', 12000);
  fx.e4 = post(fx, `${seed}-4`, '2026-04-05', 'import', '1020', '3400', 4100);
  const draft = call('save_draft', {
    date: '2026-03-12',
    lines: [
      { account: accId('6500'), debit: 900 },
      { account: accId('1020'), credit: 900 },
    ],
    idempotencyKey: `${seed}-d`,
  });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  return fx;
}

const text = (result) => Buffer.from(result.artifact.base64, 'base64').toString('utf8');
const records = (result) => text(result).trimEnd().split('\n');
const lineRecords = (result) => records(result).filter((r) => r.startsWith('line,'));
const entryIdsOf = (result) => [...new Set(lineRecords(result).map((r) => r.split(',')[1]))];

test('D190: a whole month as from/to IS the period, byte for byte, and a whole year too', () => {
  const fx = fixture('eq');
  const period = fx.call('export_journal', { period: '2026-03' });
  const range = fx.call('export_journal', { from: '2026-03-01', to: '2026-03-31' });
  assert.equal(range.ok, true, JSON.stringify(range));
  assert.equal(range.artifact.base64, period.artifact.base64);
  assert.equal(range.artifact.filename, period.artifact.filename);
  assert.equal(range.artifact.filename, 'journal-2026-03-01-bis-2026-03-31.csv');
  assert.equal(range.period, '2026-03');
  // The answer, not just the file, is the pre-D190 one: G22's checklist anchor hashes this payload, so
  // a key added to the plain answer would read as moved books on every earlier sign-off.
  const { artifact: _a, ...payload } = range;
  const { artifact: _b, ...periodPayload } = period;
  assert.deepEqual(payload, periodPayload);
  assert.deepEqual(Object.keys(periodPayload).sort(), [
    'baseCreditMinor',
    'baseDebitMinor',
    'empty',
    'entryCount',
    'lineCount',
    'ok',
    'period',
    'periodEnd',
    'periodStart',
  ]);
  const plainPair = fx.call('export_statements', { period: '2026-03', format: 'csv' });
  assert.deepEqual(Object.keys(plainPair).sort(), ['artifacts', 'ok', 'period', 'periodEnd', 'periodStart']);
  // The period file is unchanged from before D190: header, lines, total, no scope record.
  assert.equal(records(period).length, 1 + 6 + 1);
  assert.ok(!records(period).some((r) => r.startsWith('scope,')));

  const year = fx.call('export_journal', { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(year.artifact.base64, fx.call('export_journal', { period: '2026' }).artifact.base64);
  assert.equal(year.period, '2026');

  // February of a leap year and of a common year: the month end is the calendar's, not a constant.
  assert.equal(fx.call('export_journal', { from: '2028-02-01', to: '2028-02-29' }).period, '2028-02');
  assert.equal(fx.call('export_journal', { from: '2026-02-01', to: '2026-02-28' }).period, '2026-02');
  assert.equal(fx.call('export_journal', { from: '2026-02-01', to: '2026-02-27' }).period, null);
});

test('D190: a range that is not a period says so inside the file, and copies the rows verbatim', () => {
  const fx = fixture('rg');
  const ranged = fx.call('export_journal', { from: '2026-03-10', to: '2026-04-05' });
  assert.equal(ranged.ok, true, JSON.stringify(ranged));
  assert.equal(ranged.period, null);
  assert.equal(ranged.from, '2026-03-10');
  assert.equal(ranged.to, '2026-04-05');
  assert.equal(ranged.filtered, false);
  assert.equal(ranged.artifact.filename, 'journal-2026-03-10-bis-2026-04-05.csv');
  assert.deepEqual(entryIdsOf(ranged), [fx.e2, fx.e3, fx.e4]);

  const rows = records(ranged);
  assert.equal(
    rows[1],
    'scope,,,,"posted entries dated 2026-03-10 to 2026-04-05; all accounts, all sources",,,,,,,,,,,,,',
  );
  assert.equal(ranged.scope, 'posted entries dated 2026-03-10 to 2026-04-05; all accounts, all sources');
  const total = rows.at(-1).split(',');
  assert.equal(total[0], 'total');
  assert.equal(total[4], 'total of the lines in this file');
  assert.equal(Number(total[11]), 7300 + 12000 + 4100);
  assert.equal(Number(total[12]), 7300 + 12000 + 4100);
  assert.equal(ranged.artifact.reconciles, true);

  // OR Art. 958f: each line record is exactly the record the two period files write for that line.
  const fromPeriods = [
    ...lineRecords(fx.call('export_journal', { period: '2026-03' })),
    ...lineRecords(fx.call('export_journal', { period: '2026-04' })),
  ];
  // In the same order and without duplicates (D190 critic nit 4): the extract is the period files' records, filtered.
  const rangedLines = lineRecords(ranged);
  assert.deepEqual(rangedLines, fromPeriods.filter((record) => rangedLines.includes(record)), 'a record rewritten, reordered or duplicated');
});

test('D190: the account filter keeps whole entries, foots, and names itself in the file and the name', () => {
  const fx = fixture('ac');
  const byNumber = fx.call('export_journal', { period: '2026-03', account: '1020' });
  assert.equal(byNumber.ok, true, JSON.stringify(byNumber));
  assert.equal(byNumber.filtered, true);
  assert.deepEqual(byNumber.filters.account, { id: fx.accId('1020'), number: '1020', name: byNumber.filters.account.name });
  // e2 (6500/1020) and e3 (1020/3200) touch 1020; e1 (6500/1000) does not; e4 is in April.
  assert.deepEqual(entryIdsOf(byNumber), [fx.e2, fx.e3]);
  // Whole entries: both lines of each entry, so the extract still balances.
  assert.equal(byNumber.lineCount, 4);
  assert.equal(byNumber.baseDebitMinor, 7300 + 12000);
  assert.equal(byNumber.baseCreditMinor, 7300 + 12000);
  assert.equal(byNumber.artifact.reconciles, true);
  assert.equal(byNumber.artifact.filename, 'journal-auszug-2026-03-01-bis-2026-03-31-konto-1020.csv');

  const rows = records(byNumber);
  const scope = rows[1].split(',');
  assert.equal(scope[0], 'scope');
  assert.match(rows[1], /posted entries dated 2026-03-01 to 2026-03-31 \(period 2026-03\); filtered extract: account 1020; not the full journal/);
  assert.equal(scope.at(-12), '1020', 'the account number rides in its own column');
  assert.match(rows.at(-1), /^total,,,,total of the lines in this file \(a filtered extract\),/);

  // The id list_journal takes gives the very same file.
  const byId = fx.call('export_journal', { period: '2026-03', account: fx.accId('1020') });
  assert.equal(byId.artifact.base64, byNumber.artifact.base64);

  // Verbatim: the filtered records are a subset of the full file's records, string for string.
  const full = lineRecords(fx.call('export_journal', { period: '2026-03' }));
  const filteredLines = lineRecords(byNumber);
  assert.deepEqual(filteredLines, full.filter((record) => filteredLines.includes(record)), 'a record rewritten, reordered or duplicated');

  // The draft on 1020 dated 2026-03-12 never reaches the extract.
  assert.ok(!text(byNumber).includes('900,'), 'a draft leaked into a filtered export');
});

test('D190: the source filter, both filters together, and an empty extract', () => {
  const fx = fixture('sr');
  const imported = fx.call('export_journal', { from: '2026-03-01', to: '2026-04-30', source: 'import' });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.deepEqual(entryIdsOf(imported), [fx.e3, fx.e4]);
  assert.equal(imported.artifact.filename, 'journal-auszug-2026-03-01-bis-2026-04-30-quelle-import.csv');
  assert.match(records(imported)[1], /filtered extract: source import; not the full journal/);
  assert.ok(lineRecords(imported).every((r) => r.split(',')[5] === 'import'));

  const both = fx.call('export_journal', { period: '2026-03', account: '1020', source: 'manual' });
  assert.deepEqual(entryIdsOf(both), [fx.e2]);
  assert.equal(both.artifact.filename, 'journal-auszug-2026-03-01-bis-2026-03-31-konto-1020-quelle-manual.csv');
  assert.match(records(both)[1], /filtered extract: account 1020, source manual; not the full journal/);

  const none = fx.call('export_journal', { period: '2026-03', source: 'camt' });
  assert.equal(none.ok, true);
  // A source the engine cannot write is a typo, refused with the values it could have been (critic nit 1).
  const typo = fx.call('export_journal', { period: '2026-03', source: 'invoices' });
  assert.equal(typo.ok, false);
  assert.equal(typo.error, 'invalid_source');
  assert.ok(typo.allowed.includes('invoice'));
  assert.equal(none.empty, true);
  assert.equal(none.notice, 'empty_extract');
  // header + scope + total: the empty extract still says what it is.
  assert.equal(records(none).length, 3);
  assert.equal(fx.call('export_journal', { period: '2026-01' }).notice, 'empty_period');
});

test('D190: every malformed combination is a named refusal, never a silent default', () => {
  const fx = fixture('rf');
  const refused = (input) => fx.call('export_journal', input);
  assert.equal(refused({}).error, 'period_or_range_required');
  assert.equal(refused({ period: '2026-03', from: '2026-03-01', to: '2026-03-31' }).error, 'period_and_range_conflict');
  assert.equal(refused({ period: '2026-03', to: '2026-03-31' }).error, 'period_and_range_conflict');
  const half = refused({ from: '2026-03-01' });
  assert.equal(half.error, 'range_incomplete');
  assert.equal(half.missing, 'to');
  assert.equal(refused({ to: '2026-03-01' }).missing, 'from');
  const badDate = refused({ from: '2026-02-30', to: '2026-03-31' });
  assert.equal(badDate.error, 'invalid_input');
  assert.equal(badDate.field, 'from');
  assert.equal(refused({ from: '2026-03-01', to: '31.03.2026' }).field, 'to');
  const inverted = refused({ from: '2026-04-01', to: '2026-03-31' });
  assert.equal(inverted.error, 'range_inverted');
  assert.equal(refused({ period: '1. Quartal' }).error, 'invalid_period');

  // The list_journal filters a file does not offer are refused by name, never ignored.
  assert.equal(refused({ period: '2026-03', number: '7' }).error, 'unsupported_filter');
  assert.equal(refused({ period: '2026-03', number: '7' }).field, 'number');
  assert.equal(refused({ period: '2026-03', savedViewId: 'view_1' }).field, 'savedViewId');
  const draft = refused({ period: '2026-03', status: 'draft' });
  assert.equal(draft.error, 'unsupported_filter');
  assert.deepEqual(draft.supported, ['posted']);
  // `status: 'posted'` narrows nothing, so it is the plain file.
  assert.equal(
    refused({ period: '2026-03', status: 'posted' }).artifact.base64,
    fx.call('export_journal', { period: '2026-03' }).artifact.base64,
  );
  assert.equal(refused({ period: '2026-03', source: 'Invoice; DROP' }).field, 'source');
  assert.equal(refused({ period: '2026-03', account: '  ' }).field, 'account');
  const unknown = refused({ period: '2026-03', account: '9999' });
  assert.equal(unknown.error, 'unknown_account');

  // The statements take no filter; MWST takes no range.
  assert.equal(fx.call('export_statements', { period: '2026-03', account: '1020' }).error, 'unsupported_filter');
  assert.equal(fx.call('export_statements', { from: '2026-03-01' }).error, 'range_incomplete');
  assert.equal(fx.call('export_vat', { from: '2026-03-01', to: '2026-03-31' }).error, 'unsupported_range');
  assert.equal(fx.call('export_vat', { period: '2026-Q1', to: '2026-03-31' }).error, 'unsupported_range');
});

test('D190: same input, same bytes, for a range and for a filtered extract', () => {
  const fx = fixture('dt');
  for (const input of [
    { from: '2026-03-05', to: '2026-04-30' },
    { from: '2026-03-05', to: '2026-04-30', account: '1020', source: 'import' },
  ]) {
    const first = fx.call('export_journal', input);
    const second = fx.call('export_journal', input);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(second.artifact.base64, first.artifact.base64);
    assert.equal(second.artifact.filename, first.artifact.filename);
  }
});

test('D190 §H-TENANT: the account lookup and the filter never cross a workspace', () => {
  const deps = freshDeps();
  const a = fixture('ta', deps);
  const b = fixture('tb', deps);
  // B's account by id is unknown to A, exactly like an account that does not exist.
  const foreign = a.call('export_journal', { period: '2026-03', account: b.accId('1020') });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, 'unknown_account');
  // The number resolves to A's own 1020, and A's extract carries A's entries only, on the same dates
  // B booked the same amounts.
  const own = a.call('export_journal', { period: '2026-03', account: '1020' });
  assert.equal(own.filters.account.id, a.accId('1020'));
  assert.deepEqual(entryIdsOf(own), [a.e2, a.e3]);
  for (const id of [b.e1, b.e2, b.e3, b.e4]) assert.ok(!text(own).includes(id), `B's ${id} in A's export`);
  const ranged = a.call('export_journal', { from: '2026-03-02', to: '2026-04-30', source: 'import' });
  assert.deepEqual(entryIdsOf(ranged), [a.e3, a.e4]);
});

test('D190: export_statements over a range is A08 for those dates, with the not-whole-months notice', () => {
  const fx = fixture('st');
  for (const format of ['csv', 'pdf']) {
    const pair = fx.call('export_statements', { from: '2026-03-10', to: '2026-04-05', format });
    assert.equal(pair.ok, true, JSON.stringify(pair));
    assert.equal(pair.period, null);
    assert.equal(pair.notice, 'range_not_whole_months');
    const [balance, income] = pair.artifacts;
    const balanceDirect = fx.call('export_statement', { kind: 'balance', format, asOf: '2026-04-05' });
    const incomeDirect = fx.call('export_statement', {
      kind: 'income',
      format,
      periodStart: '2026-03-10',
      periodEnd: '2026-04-05',
    });
    assert.equal(balance.base64, balanceDirect.artifact.base64, `Bilanz ${format} diverged from A08`);
    assert.equal(income.base64, incomeDirect.artifact.base64, `Erfolgsrechnung ${format} diverged from A08`);
    assert.equal(income.filename, `erfolgsrechnung-2026-03-10-bis-2026-04-05.${format}`);
  }
  // Whole months, even across two, carry no notice; a whole month IS the period.
  const quarter = fx.call('export_statements', { from: '2026-01-01', to: '2026-03-31', format: 'csv' });
  assert.equal(quarter.notice, undefined);
  const month = fx.call('export_statements', { from: '2026-03-01', to: '2026-03-31', format: 'csv' });
  const period = fx.call('export_statements', { period: '2026-03', format: 'csv' });
  assert.equal(month.period, '2026-03');
  assert.deepEqual(
    month.artifacts.map((x) => x.base64),
    period.artifacts.map((x) => x.base64),
  );
});
