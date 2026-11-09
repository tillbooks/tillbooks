// A04, the guided migration import: CSV / bexio account export into the opening position.
//
// The money risk here is PARSING, not posting: by the time a row reaches `setOpeningBalances` it is
// already integer Rappen and every ledger invariant is A02's. So the tests below spend their weight
// on the two places a franc can quietly change value:
//
//  1. **Decimal to Rappen.** `parseFloat('1234.56') * 100` is `123455.99999999999`, so an UNROUNDED
//     float path is wrong on ordinary money and the assertions below catch it (verified by mutation).
//     What they do NOT catch, and this is stated rather than glossed: a `Math.round(Number(s) * 100)`
//     path passes every one of them, because within the magnitudes `parseSwissAmount` admits the two
//     agree (see its docblock for the measurement). These are correctness assertions on the parser's
//     VALUES, not a guard that the implementation stays integer-only.
//  2. **The sign convention.** A single signed balance column has to become a debit or a credit, and
//     an inversion there survives every total-level check because the totals still tie out. Both
//     directions are tested, on both the two-column and the signed-balance shape.
//
// A row whose account is not in the chart is REPORTED as unmapped, never dropped and never invented.
// OR 958c Abs. 1 Ziff. 2 (`Sie muss vollständig sein`) is the reason a silently skipped row is worse
// than a refusal: the import would balance and the position would still be incomplete.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importMigration, getOpeningBalances, OPENING_CONTRA_ACCOUNT_NUMBER } from '../../dist/core/ledger/index.js';
import {
  setup,
  neighbourWorkspace,
  seedOpeningContraAccount,
  legsOf,
  rowCounts,
  numbersOf,
} from './support.mjs';

/** A two-column (debit / credit) CSV export, Swiss thousands separators and all. */
const TWO_COLUMN_ROWS = [
  { Konto: '1020', Bezeichnung: 'Bankkonto', Soll: "12'500.00", Haben: '' },
  { Konto: '1100', Bezeichnung: 'Debitoren', Soll: "3'400.00", Haben: '' },
  { Konto: '2000', Bezeichnung: 'Kreditoren', Soll: '', Haben: "1'900.00" },
  { Konto: '2800', Bezeichnung: 'Eigenkapital', Soll: '', Haben: "14'000.00" },
];

// --- the preview is a dry run and writes nothing -------------------------------------------------

test('preview normalises a two-column export, balances it, and writes absolutely nothing', () => {
  const { ctx, store, workspaceId } = setup();

  const preview = importMigration(ctx, {
    format: 'csv',
    mapping: { account: 'Konto', debit: 'Soll', credit: 'Haben' },
    rows: TWO_COLUMN_ROWS,
    dryRun: true,
  });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.dryRun, true);
  assert.equal(preview.entryId, undefined, 'a preview has no entry to name');
  assert.deepEqual(rowCounts(store, workspaceId), { entries: 0, lines: 0 }, 'nothing was written');

  assert.deepEqual(preview.preview.lines, [
    { account: '1020', debitMinor: 1250000, creditMinor: 0 },
    { account: '1100', debitMinor: 340000, creditMinor: 0 },
    { account: '2000', debitMinor: 0, creditMinor: 190000 },
    { account: '2800', debitMinor: 0, creditMinor: 1400000 },
  ]);
  assert.deepEqual(preview.preview.unmapped, []);
  assert.equal(preview.preview.differenceMinor, 0);
  assert.equal(preview.preview.totalDebitMinor, 1590000);
  assert.equal(preview.preview.totalCreditMinor, 1590000);
  assert.equal(preview.preview.balanced, true);
});

test('a signed single-balance column becomes debit or credit, in BOTH directions', () => {
  const { ctx } = setup();
  const preview = importMigration(ctx, {
    format: 'csv',
    mapping: { account: 'nr', balance: 'saldo' },
    rows: [
      { nr: '1020', saldo: "12'500.00" }, // positive: an asset the business holds -> DEBIT
      { nr: '2000', saldo: "-1'900.00" }, // negative -> CREDIT
      { nr: '2800', saldo: "-10'600.00" },
    ],
    dryRun: true,
  });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.deepEqual(preview.preview.lines, [
    { account: '1020', debitMinor: 1250000, creditMinor: 0 },
    { account: '2000', debitMinor: 0, creditMinor: 190000 },
    { account: '2800', debitMinor: 0, creditMinor: 1060000 },
  ]);
  assert.equal(preview.preview.balanced, true);
});

// --- the parser, where a franc can change value --------------------------------------------------

test('decimals become Rappen exactly, including the values an unrounded float gets wrong', () => {
  const { ctx } = setup();
  const parse = (raw) =>
    importMigration(ctx, {
      format: 'csv',
      mapping: { account: 'nr', balance: 'saldo' },
      rows: [{ nr: '1020', saldo: raw }],
      dryRun: true,
    }).preview.lines[0];

  // 1234.56 * 100 is 123455.99999999999 in IEEE 754 doubles, and 8.29 * 100 is 828.9999999999999.
  assert.equal(parse('1234.56').debitMinor, 123456);
  assert.equal(parse('8.29').debitMinor, 829);
  assert.equal(parse("1'234.56").debitMinor, 123456);
  assert.equal(parse('0.05').debitMinor, 5);
  assert.equal(parse('0.5').debitMinor, 50, 'one decimal is tenths of a franc, not Rappen');
  assert.equal(parse('100').debitMinor, 10000, 'a bare integer is francs');
  assert.equal(parse("1'000'000.00").debitMinor, 100000000);
  assert.equal(parse('-0.01').creditMinor, 1);
  assert.equal(parse('+7.50').debitMinor, 750);
});

test('the magnitude cap holds the boundary, so every admitted value is a SAFE integer', () => {
  // The cap had no test at all: deleting it left all three suites green. What it is actually for is
  // the POSTCONDITION, not the float argument its comment used to make. `parseSwissAmount` returns a
  // `number`, and Rappen are carried as `number` the whole way down, so a value above
  // MAX_SAFE_INTEGER would arrive as an integer that can no longer be incremented exactly.
  const { ctx } = setup();
  const parse = (raw) =>
    importMigration(ctx, {
      format: 'csv',
      mapping: { account: 'nr', balance: 'saldo' },
      rows: [{ nr: '1020', saldo: raw }],
      dryRun: true,
    });

  // Exactly at MAX_SAFE_INTEGER Rappen (90'071'992'547'409.91 francs) is admitted, and exactly.
  const atCap = '90071992547409.91';
  const okRes = parse(atCap);
  assert.equal(okRes.ok, true, `the boundary value itself is admitted: ${JSON.stringify(okRes)}`);
  assert.equal(okRes.preview.lines[0].debitMinor, Number.MAX_SAFE_INTEGER);
  assert.equal(Number.isSafeInteger(okRes.preview.lines[0].debitMinor), true);

  // One Rappen over is REFUSED by value, not silently rounded into an unsafe integer.
  const over = parse('90071992547409.92');
  assert.equal(over.ok, false, 'one Rappen above the cap is refused');
  assert.equal(over.error, 'invalid_amount');
  assert.equal(over.value, '90071992547409.92', 'the rejection quotes what it would not take');
});

test('an amount that is not a Swiss decimal is refused by VALUE, never coerced to zero', () => {
  const { ctx } = setup();
  const bad = (raw) =>
    importMigration(ctx, {
      format: 'csv',
      mapping: { account: 'nr', balance: 'saldo' },
      rows: [{ nr: '1020', saldo: raw }],
      dryRun: true,
    });

  for (const raw of ['abc', '12.345', '1,234.56', '12.5.6', '--1', '1 234.56']) {
    const res = bad(raw);
    assert.equal(res.ok, false, `"${raw}" must not parse`);
    assert.equal(res.error, 'invalid_amount');
    assert.equal(res.value, raw, 'the rejection quotes what it could not read');
  }
  // A blank cell is ABSENT, not invalid: a two-column export leaves one side empty on every row.
  assert.equal(bad('').ok, true);
  assert.equal(bad('   ').ok, true);
});

test('a row carrying BOTH a debit and a credit is refused, not netted', () => {
  const { ctx } = setup();
  const res = importMigration(ctx, {
    format: 'csv',
    mapping: { account: 'Konto', debit: 'Soll', credit: 'Haben' },
    rows: [{ Konto: '1020', Soll: '100.00', Haben: '40.00' }],
    dryRun: true,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_row');
  assert.equal(res.account, '1020');
});

// --- unmapped accounts are reported, never dropped and never invented ---------------------------

test('a row whose account is not in the chart is reported unmapped and blocks the import', () => {
  const { ctx, store, workspaceId } = setup();
  const rows = [...TWO_COLUMN_ROWS, { Konto: '4711', Bezeichnung: 'Fantasiekonto', Soll: '50.00', Haben: '' }];
  const mapping = { account: 'Konto', name: 'Bezeichnung', debit: 'Soll', credit: 'Haben' };

  const preview = importMigration(ctx, { format: 'csv', mapping, rows, dryRun: true });
  assert.equal(preview.ok, true, 'a preview REPORTS the problem rather than refusing to show it');
  assert.deepEqual(preview.preview.unmapped, [
    { account: '4711', name: 'Fantasiekonto', debitMinor: 5000, creditMinor: 0 },
  ]);
  assert.equal(preview.preview.balanced, false, 'the mapped rows alone no longer tie out');

  // The real import refuses: importing 4 of 5 rows would produce a position that balances only
  // because the missing row was dropped, which is the incompleteness OR 958c Ziff. 2 forbids.
  const imported = importMigration(ctx, { format: 'csv', mapping, rows, idempotencyKey: 'imp-unmapped' });
  assert.equal(imported.ok, false);
  assert.equal(imported.error, 'unmapped_account');
  assert.deepEqual(imported.unmapped, ['4711']);
  assert.deepEqual(rowCounts(store, workspaceId), { entries: 0, lines: 0 });
});

// --- the import posts exactly what the preview showed --------------------------------------------

test('import posts exactly the preview, as one opening entry, and is idempotent on ROWS', () => {
  const { ctx, store, workspaceId } = setup();
  const call = (key) =>
    importMigration(ctx, {
      format: 'csv',
      mapping: { account: 'Konto', debit: 'Soll', credit: 'Haben' },
      rows: TWO_COLUMN_ROWS,
      idempotencyKey: key,
    });

  const first = call('imp-1');
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.dryRun, false);
  assert.deepEqual(legsOf(store, workspaceId, first.entryId), [
    { number: '1020', debit: 1250000, credit: 0 },
    { number: '1100', debit: 340000, credit: 0 },
    { number: '2000', debit: 0, credit: 190000 },
    { number: '2800', debit: 0, credit: 1400000 },
  ]);
  const after = rowCounts(store, workspaceId);
  assert.deepEqual(after, { entries: 1, lines: 4 });

  const again = call('imp-1');
  assert.equal(again.entryId, first.entryId);
  assert.deepEqual(rowCounts(store, workspaceId), after, 'a retried import moves the ledger zero times');

  // And the position reads back through the A04 read model, tying the two verbs together.
  const read = getOpeningBalances(ctx, {});
  assert.equal(read.entryId, first.entryId);
  assert.equal(read.totalDebitMinor, 1590000);
});

test('an import that does not tie out is refused unless a clarification account is named', () => {
  const { ctx, store, workspaceId } = setup();
  seedOpeningContraAccount(ctx);
  const rows = [
    { Konto: '1020', Soll: "12'500.00", Haben: '' },
    { Konto: '2800', Soll: '', Haben: "12'000.00" },
  ];
  const mapping = { account: 'Konto', debit: 'Soll', credit: 'Haben' };

  const refused = importMigration(ctx, { format: 'csv', mapping, rows, idempotencyKey: 'imp-unb' });
  assert.equal(refused.error, 'unbalanced');
  assert.equal(refused.differenceMinor, 50000);
  assert.deepEqual(rowCounts(store, workspaceId), { entries: 0, lines: 0 });

  const booked = importMigration(ctx, {
    format: 'csv',
    mapping,
    rows,
    differenceAccount: OPENING_CONTRA_ACCOUNT_NUMBER,
    idempotencyKey: 'imp-unb2',
  });
  assert.equal(booked.ok, true, JSON.stringify(booked));
  assert.deepEqual(legsOf(store, workspaceId, booked.entryId).find((l) => l.number === '9100'), {
    number: '9100',
    debit: 0,
    credit: 50000,
  });
});

// --- the bexio preset ----------------------------------------------------------------------------

test('the bexio preset reads its own header names, and an explicit mapping always wins', () => {
  const { ctx } = setup();
  // The preset is a set of DEFAULT column names, applied only where the caller named none. It is
  // clean-room by construction: a column header is a name this repo chose to look for, and no bexio
  // code, asset, or layout is involved in reading a CSV someone exported themselves.
  const preset = importMigration(ctx, {
    format: 'bexio',
    rows: [
      { account_no: '1020', name: 'Bankkonto', debit: "12'500.00", credit: '' },
      { account_no: '2800', name: 'Eigenkapital', debit: '', credit: "12'500.00" },
    ],
    dryRun: true,
  });
  assert.equal(preset.ok, true, JSON.stringify(preset));
  assert.equal(preset.preview.balanced, true);
  assert.deepEqual(preset.preview.lines, [
    { account: '1020', debitMinor: 1250000, creditMinor: 0 },
    { account: '2800', debitMinor: 0, creditMinor: 1250000 },
  ]);
  assert.deepEqual(preset.mapping, { account: 'account_no', name: 'name', debit: 'debit', credit: 'credit' });

  // A caller whose export uses different headers overrides, field by field, without restating the rest.
  const overridden = importMigration(ctx, {
    format: 'bexio',
    mapping: { account: 'Kontonummer' },
    rows: [
      { Kontonummer: '1020', debit: '100.00', credit: '' },
      { Kontonummer: '2800', debit: '', credit: '100.00' },
    ],
    dryRun: true,
  });
  assert.equal(overridden.ok, true, JSON.stringify(overridden));
  assert.equal(overridden.mapping.account, 'Kontonummer');
  assert.equal(overridden.mapping.debit, 'debit', 'the unnamed fields keep the preset');
});

test('a mapping naming a column no row has is refused, rather than reading every row as blank', () => {
  const { ctx } = setup();
  const res = importMigration(ctx, {
    format: 'csv',
    mapping: { account: 'Kontonr', debit: 'Soll', credit: 'Haben' },
    rows: TWO_COLUMN_ROWS, // these carry `Konto`, not `Kontonr`
    dryRun: true,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unmapped_column', 'a silently empty account column would import nothing and say ok');
  assert.equal(res.column, 'Kontonr');
});

test('a Total row is diagnosed as a Total row, not as a broken mapping', () => {
  // A blank account cell with the amounts filled is what a subtotal or Total line looks like, and
  // real exports carry one at the bottom almost every time. The check is PER ROW, so it used to
  // answer `unmapped_column` and send the caller off to fix a mapping that was perfectly correct.
  // Both cases produced the identical Result, so the two could not be told apart at all.
  const { ctx } = setup();
  const run = (rows) =>
    importMigration(ctx, {
      format: 'csv',
      mapping: { account: 'Konto', debit: 'Soll', credit: 'Haben' },
      rows,
      dryRun: true,
    });

  const withTotal = run([
    { Konto: '1020', Soll: '100.00', Haben: '' },
    { Konto: '2800', Soll: '', Haben: '100.00' },
    { Konto: '', Soll: '100.00', Haben: '100.00' },
  ]);
  assert.equal(withTotal.ok, false, 'still loud, so no franc moves on a half-understood file');
  assert.equal(withTotal.error, 'invalid_row', JSON.stringify(withTotal));
  assert.equal(withTotal.row, 2, 'it names the offending row rather than blaming the column');
  assert.equal(withTotal.column, 'Konto');

  // And the case the comment actually described still reports the column: NO row carries it.
  const wrongMapping = run([
    { Nr: '1020', Soll: '100.00', Haben: '' },
    { Nr: '2800', Soll: '', Haben: '100.00' },
  ]);
  assert.equal(wrongMapping.error, 'unmapped_column');
  assert.equal(wrongMapping.column, 'Konto');
  assert.equal(wrongMapping.role, 'account');
});

test('rows must be a non-empty array, and each row an object', () => {
  const { ctx } = setup();
  const mapping = { account: 'Konto', debit: 'Soll', credit: 'Haben' };
  assert.equal(importMigration(ctx, { format: 'csv', mapping, rows: [], dryRun: true }).error, 'invalid_input');
  assert.equal(importMigration(ctx, { format: 'csv', mapping, rows: 'x', dryRun: true }).error, 'invalid_input');
  assert.equal(importMigration(ctx, { format: 'csv', mapping, rows: [1], dryRun: true }).error, 'invalid_row');
  assert.equal(importMigration(ctx, { format: 'zip', mapping, rows: TWO_COLUMN_ROWS, dryRun: true }).error, 'invalid_format');
});

test('a real import still needs a key, and a preview never does', () => {
  const { ctx } = setup();
  const mapping = { account: 'Konto', debit: 'Soll', credit: 'Haben' };
  assert.equal(importMigration(ctx, { format: 'csv', mapping, rows: TWO_COLUMN_ROWS }).error, 'invalid_input');
  assert.equal(importMigration(ctx, { format: 'csv', mapping, rows: TWO_COLUMN_ROWS, dryRun: true }).ok, true);
});

test('the same account twice in one file is refused: a file is a position, not a movement list', () => {
  const { ctx, byNumber } = setup();
  const DUP_ROWS = [
    { Konto: '1020', Soll: '100.00', Haben: '' },
    { Konto: '1020', Soll: '50.00', Haben: '' },
    { Konto: '2800', Soll: '', Haben: '150.00' },
  ];
  const res = importMigration(ctx, {
    format: 'csv',
    mapping: { account: 'Konto', debit: 'Soll', credit: 'Haben' },
    rows: DUP_ROWS,
    idempotencyKey: 'imp-dup',
  });
  assert.equal(res.error, 'duplicate_account');
  assert.equal(res.number, '1020');

  // AND THE PREVIEW AGREES. The dedupe used to live only in `setOpeningBalances`, which a preview
  // never reaches, so this same file previewed as `balanced: true` with 3 lines and then refused on
  // import. `import_opening_balances` promises to post exactly what the preview showed, and the
  // preview exists to catch this shape before anything is written.
  const preview = importMigration(ctx, {
    format: 'csv',
    mapping: { account: 'Konto', debit: 'Soll', credit: 'Haben' },
    rows: DUP_ROWS,
    dryRun: true,
  });
  assert.equal(preview.ok, false, `the preview must not green-light a file the import rejects: ${JSON.stringify(preview)}`);
  assert.equal(preview.error, 'duplicate_account');
  assert.equal(preview.number, '1020');

  // Compared on the RESOLVED account, so once by number and once by id is still one account twice.
  const mixed = importMigration(ctx, {
    format: 'csv',
    mapping: { account: 'Konto', debit: 'Soll', credit: 'Haben' },
    rows: [
      { Konto: '1020', Soll: '100.00', Haben: '' },
      { Konto: byNumber['1020'], Soll: '50.00', Haben: '' },
      { Konto: '2800', Soll: '', Haben: '150.00' },
    ],
    dryRun: true,
  });
  assert.equal(mixed.error, 'duplicate_account', JSON.stringify(mixed));
  assert.equal(mixed.firstSeenAs, '1020', 'it says which spelling it saw first');
});

test('§H-TENANT: an import resolves account numbers in the CALLER\'s chart', () => {
  // The neighbour is minted FIRST so a neutralised filter would resolve ITS 1020 rather than the
  // caller's, which a test with the order reversed could not see.
  const seed = setup();
  const victim = neighbourWorkspace(seed.deps, { name: 'Erster Mandant' });
  const mine = neighbourWorkspace(seed.deps, { name: 'Zweiter Mandant' });

  const res = importMigration(mine.ctx, {
    format: 'csv',
    mapping: { account: 'Konto', debit: 'Soll', credit: 'Haben' },
    rows: [
      { Konto: '1020', Soll: '100.00', Haben: '' },
      { Konto: '2800', Soll: '', Haben: '100.00' },
    ],
    idempotencyKey: 'imp-tenant',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const accountIds = seed.store.db
    .prepare('SELECT account_id FROM journal_line WHERE entry_id = ?')
    .all(res.entryId)
    .map((r) => r.account_id);
  assert.equal(accountIds.includes(mine.byNumber['1020']), true);
  assert.equal(accountIds.includes(victim.byNumber['1020']), false);
  assert.equal(numbersOf(seed.store, victim.workspaceId)['1020'], victim.byNumber['1020']);
});

test('§H-TENANT: `isMapped` does not count a NEIGHBOUR\'s account as mapped', () => {
  // The test above cannot see this fence: both workspaces carry 1020, so `isMapped` answers true
  // either way. Only an account that exists SOLELY in the neighbour can turn it red. 9100 is not in
  // A01's shipped seed, so creating it in the neighbour alone makes it exactly that account.
  const seed = setup();
  const victim = neighbourWorkspace(seed.deps, { name: 'Erster Mandant' });
  const mine = neighbourWorkspace(seed.deps, { name: 'Zweiter Mandant' });
  seedOpeningContraAccount(victim.ctx);
  assert.equal(numbersOf(seed.store, mine.workspaceId)['9100'], undefined, '9100 is the neighbour\'s alone');

  const rows = [
    { Konto: '1020', Soll: '100.00', Haben: '' },
    { Konto: '9100', Soll: '', Haben: '100.00' },
  ];

  // The preview must REPORT it as unmapped, which is what sends the caller to A01 rather than to
  // the file. Unfenced, `isMapped` calls the neighbour's 9100 mapped and the row is shown as fine.
  const preview = importMigration(mine.ctx, {
    format: 'csv',
    mapping: { account: 'Konto', debit: 'Soll', credit: 'Haben' },
    rows,
    dryRun: true,
  });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.deepEqual(preview.preview.unmapped.map((u) => u.account), ['9100']);
  assert.equal(preview.preview.balanced, false, 'an unmapped row means the preview does not claim balance');

  // And the real import refuses by the RIGHT name: `unmapped_account`, not `unknown_account` from
  // the later resolve, because the two send the caller to different places.
  const res = importMigration(mine.ctx, {
    format: 'csv',
    mapping: { account: 'Konto', debit: 'Soll', credit: 'Haben' },
    rows,
    idempotencyKey: 'imp-neighbour-9100',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unmapped_account', JSON.stringify(res));
  assert.deepEqual(res.unmapped, ['9100']);
});
