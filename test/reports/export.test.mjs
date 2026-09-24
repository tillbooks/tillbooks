// A08 US-A08.6, `exportStatement`: the local CSV and PDF artifacts.
//
// The claim under test is "no recomputation divergence": the artifact must carry the figures the
// read model produced, not a second opinion about them. So every case decodes the artifact and
// compares it against the model computed separately, rather than against another literal.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  exportStatement,
  computeTrialBalance,
  computeBalanceSheet,
  computeIncomeStatement,
  computeGeneralLedger,
} from '../../dist/core/reports/index.js';
import { setup, seedBooks, post, importUnbalancedEntry, PERIOD, EXPECTED } from './support.mjs';

/** The artifact's bytes as text. `latin1` for a PDF, whose byte stream is WinAnsi, not UTF-8. */
function decode(artifact) {
  return Buffer.from(artifact.base64, 'base64').toString(artifact.format === 'pdf' ? 'latin1' : 'utf8');
}

function csvRows(text) {
  return text.trimEnd().split('\n').map((line) => line.split(','));
}

test('CSV: the Saldenbilanz carries every row and the totals, in raw Rappen', () => {
  const t = setup();
  seedBooks(t);
  const res = exportStatement(t.ctx, { kind: 'trial', format: 'csv', ...PERIOD });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.artifact.filename, 'saldenbilanz-2026-01-01-bis-2026-03-31.csv');
  assert.equal(res.artifact.mediaType, 'text/csv; charset=utf-8');
  assert.equal(res.artifact.reconciles, true);

  const rows = csvRows(decode(res.artifact));
  assert.deepEqual(rows[0], [
    'record_type',
    'account_number',
    'account_name',
    'account_type',
    'kmu_class',
    'opening_minor',
    'debit_minor',
    'credit_minor',
    'closing_minor',
  ]);

  const model = computeTrialBalance(t.ctx, PERIOD);
  const dataRows = rows.filter((r) => r[0] === 'row');
  assert.equal(dataRows.length, model.rows.length, 'the artifact must carry every row the screen shows');
  const bank = dataRows.find((r) => r[1] === '1020');
  assert.deepEqual(bank.slice(5), ['2000000', '540500', '745000', '1795500']);

  const total = rows.find((r) => r[0] === 'total');
  assert.deepEqual(total.slice(5), [
    String(EXPECTED.trial.opening),
    String(EXPECTED.trial.debit),
    String(EXPECTED.trial.credit),
    String(EXPECTED.trial.closing),
  ]);
});

test('CSV: no locale leaks in: no apostrophe separator, no CHF, no de-CH date', () => {
  const t = setup();
  seedBooks(t);
  const text = decode(exportStatement(t.ctx, { kind: 'ledger', format: 'csv', accountId: t.acc('1020'), ...PERIOD }).artifact);
  // DELIBERATELY RELAXED from `!text.includes("'")`. That assertion banned the apostrophe outright,
  // and the standard CSV-injection mitigation is a leading apostrophe, so the blanket ban and the
  // fix cannot both stand. What the case actually meant to catch is the de-CH THOUSANDS separator
  // (`1'234.55`), which really would have to be parsed back on re-import. That is what it now tests,
  // and it stays red for the leak it was written for: an apostrophe between two digits.
  assert.ok(!/\d'\d/.test(text), "a thousands apostrophe (1'234) would have to be parsed back on re-import");
  assert.ok(!text.includes('CHF'), 'the currency belongs in the response, not glued to every figure');
  assert.ok(!/\d{2}\.\d{2}\.\d{4}/.test(text), 'dates must stay ISO on the wire');
  assert.ok(text.endsWith('\n'), 'a trailing newline, so two files concatenate cleanly');
  assert.ok(!text.includes('\r'), 'LF only, so the bytes are stable across platforms');
});

test('CSV: byte-stable, the same call twice yields the identical artifact', () => {
  const t = setup();
  seedBooks(t);
  const call = () => exportStatement(t.ctx, { kind: 'income', format: 'csv', ...PERIOD }).artifact;
  const first = call();
  const second = call();
  assert.equal(first.base64, second.base64);
  assert.equal(first.byteLength, second.byteLength);
});

test('CSV: the Bilanz artifact foots the same way the model does', () => {
  const t = setup();
  seedBooks(t);
  const model = computeBalanceSheet(t.ctx, { asOf: '2026-03-31' });
  const rows = csvRows(decode(exportStatement(t.ctx, { kind: 'balance', format: 'csv', asOf: '2026-03-31' }).artifact));
  const totals = rows.filter((r) => r[0] === 'total');
  assert.deepEqual(totals.map((r) => r[6]), [String(model.aktivenMinor), String(model.passivenMinor)]);
  // Every section subtotal, in the statutory order, exactly as the model has it.
  assert.deepEqual(
    rows.filter((r) => r[0] === 'subtotal').map((r) => [r[1], r[6]]),
    model.sections.map((s) => [s.key, String(s.subtotalMinor)]),
  );
});

test('CSV: the Erfolgsrechnung artifact carries the Reingewinn, sign and all', () => {
  const t = setup();
  seedBooks(t, { loss: true });
  const model = computeIncomeStatement(t.ctx, PERIOD);
  const rows = csvRows(decode(exportStatement(t.ctx, { kind: 'income', format: 'csv', ...PERIOD }).artifact));
  const result = rows.find((r) => r[0] === 'result');
  assert.equal(result[6], '-460000');
  assert.equal(result[6], String(model.reingewinnMinor));
});

test('CSV: the Kontoblatt artifact carries opening, every line and closing', () => {
  const t = setup();
  seedBooks(t);
  const model = computeGeneralLedger(t.ctx, { accountId: t.acc('1020'), ...PERIOD });
  const rows = csvRows(decode(exportStatement(t.ctx, { kind: 'ledger', format: 'csv', accountId: t.acc('1020'), ...PERIOD }).artifact));
  assert.equal(rows.find((r) => r[0] === 'opening')[8], String(model.openingMinor));
  assert.equal(rows.find((r) => r[0] === 'closing')[8], String(model.closingMinor));
  assert.equal(rows.filter((r) => r[0] === 'line').length, model.lines.length);
  assert.equal(rows.find((r) => r[0] === 'account')[1], '1020');
});

test('CSV: a field carrying a comma is quoted, so the columns cannot shift', () => {
  const t = setup();
  seedBooks(t);
  // A description with a comma AND a quote in it: both have to survive the round trip. Posted as a
  // real entry, because a posted row is immutable (the schema trigger refuses an UPDATE, which is
  // how the first version of this case found out it was probing the wrong thing).
  post(t, {
    date: '2026-03-12',
    key: 'komma',
    description: 'Miete, "Büro" Q1',
    lines: [
      { n: '6000', debit: 90000 },
      { n: '1020', credit: 90000 },
    ],
  });
  const text = decode(exportStatement(t.ctx, { kind: 'ledger', format: 'csv', accountId: t.acc('6000'), ...PERIOD }).artifact);
  assert.ok(text.includes('"Miete, ""Büro"" Q1"'), text);
  // And the row still has exactly the nine columns the header declares.
  const line = csvRows(text).find((r) => r[0] === 'line');
  assert.equal(csvRows(text)[0].length, 9);
  assert.ok(line.length > 9, 'the naive split proves the quoting is what holds the columns together');
});

test('CSV: a description a spreadsheet would EXECUTE is defused (CWE-1236)', () => {
  const t = setup();
  seedBooks(t);
  // Four formula leads, all reachable: a description is free text that A02 accepts verbatim, and
  // this file is mailed to a Treuhänder who opens it in Excel.
  const payloads = [
    ["=cmd|' /C calc'!A0", 'equals'],
    ['+1+1', 'plus'],
    ['-1+1', 'minus'],
    ['@SUM(A1:A2)', 'at'],
  ];
  payloads.forEach(([payload, key], i) => {
    post(t, {
      date: '2026-03-14',
      key: `inject-${key}`,
      description: payload,
      lines: [{ n: '6000', debit: 100 + i }, { n: '1020', credit: 100 + i }],
    });
  });

  const text = decode(exportStatement(t.ctx, { kind: 'ledger', format: 'csv', accountId: t.acc('6000'), ...PERIOD }).artifact);
  for (const [payload] of payloads) {
    assert.ok(!text.includes(`,${payload},`), `the raw payload ${payload} reached the file unescaped`);
    assert.ok(text.includes(`"'${payload}"`), `${payload} must be quoted and prefixed, so a sheet reads it as text`);
  }
});

test('CSV: the money columns are NOT defused, so a negative figure re-imports as a number', () => {
  const t = setup();
  seedBooks(t, { loss: true });
  const text = decode(exportStatement(t.ctx, { kind: 'income', format: 'csv', ...PERIOD }).artifact);
  // `-` leads a formula AND every negative Rappen figure in the file. The naive injection fix would
  // rewrite `-460000` as `'-460000` and turn the single most common value in the export into a
  // string. A plain integer is left exactly as it is.
  const result = csvRows(text).find((r) => r[0] === 'result');
  assert.equal(result[6], '-460000');
  assert.ok(!text.includes("'-"), 'a negative amount must not be quoted into a string');
  const personal = csvRows(text).find((r) => r[0] === 'subtotal' && r[1] === 'personalaufwand');
  assert.equal(personal[6], '-600000');
});

/**
 * The Erfolgsrechnung's closing row, proven to be ON the paper rather than merely in the bytes.
 *
 * Returns the row itself (x, y and text), and asserts its geometry against the MediaBox the same
 * file declares before returning it. A caller that only reads `.text` still gets the position check,
 * which is the whole point: `pdf.includes('Jahresgewinn')` would pass for a row drawn 161 units
 * above the top edge, which is exactly the defect `pages()` exists to catch.
 */
function resultRow(pdf) {
  const parsed = pages(pdf);
  const rows = allRows(parsed).filter((r) => /^Jahres(gewinn|verlust)/.test(r.text));
  assert.equal(rows.length, 1, `expected exactly one closing row, got ${JSON.stringify(rows.map((r) => r.text))}`);
  const row = rows[0];
  assert.ok(row.y >= 0 && row.y <= parsed.height, `the closing row is at y=${row.y}, off a page ${parsed.height} high`);
  assert.ok(row.x >= 0 && row.x < parsed.width, `the closing row is at x=${row.x}, off a page ${parsed.width} wide`);
  return row;
}

test('PDF: the closing row carries the ENACTED wording, and commits to a word by sign', () => {
  // OR Art. 959b Abs. 2 Ziff. 11 enacts "Jahresgewinn oder Jahresverlust" (SR 220, the 2026-01-01
  // consolidation, fetched from the Fedlex filestore). "Reingewinn oder Reinverlust" was the
  // conventional wording and it was neither the statute's nor a word: a signed statement that has
  // already resolved to one outcome must not print both joined by "oder", which is UX finding F14.
  // The "oder" form is correct in exactly one case, and it is asserted below.
  const profit = setup();
  seedBooks(profit);
  const profitModel = computeIncomeStatement(profit.ctx, PERIOD);
  assert.ok(profitModel.reingewinnMinor > 0, 'the fixture must really be a profit');
  const profitRow = resultRow(decode(exportStatement(profit.ctx, { kind: 'income', format: 'pdf', ...PERIOD }).artifact));
  assert.ok(profitRow.text.startsWith('Jahresgewinn '), `a profit must be headed Jahresgewinn: ${JSON.stringify(profitRow.text)}`);
  assert.ok(!profitRow.text.includes('oder'), 'a resolved outcome must not print both words');
  assert.ok(!profitRow.text.includes('Reingewinn'), 'the conventional wording must be gone');

  const loss = setup();
  seedBooks(loss, { loss: true });
  const lossRow = resultRow(decode(exportStatement(loss.ctx, { kind: 'income', format: 'pdf', ...PERIOD }).artifact));
  assert.ok(lossRow.text.startsWith('Jahresverlust '), `a loss must be headed Jahresverlust: ${JSON.stringify(lossRow.text)}`);
  assert.ok(!lossRow.text.includes('oder'), 'a resolved outcome must not print both words');

  // Exactly zero is the one case the enacted "oder" form states correctly: a book that broke even
  // made neither a Gewinn nor a Verlust, and naming one of them would be the label asserting
  // something the figure does not. A pure balance-sheet entry, so every position really is 0.
  const flat = setup();
  post(flat, { date: '2026-02-01', key: 'flat', lines: [{ n: '1000', debit: 100 }, { n: '1020', credit: 100 }] });
  assert.equal(computeIncomeStatement(flat.ctx, PERIOD).reingewinnMinor, 0, 'the fixture must really break even');
  const flatRow = resultRow(decode(exportStatement(flat.ctx, { kind: 'income', format: 'pdf', ...PERIOD }).artifact));
  assert.ok(
    flatRow.text.startsWith('Jahresgewinn oder Jahresverlust '),
    `a break-even book keeps the enacted wording verbatim: ${JSON.stringify(flatRow.text)}`,
  );
});

test('PDF: a loss keeps its minus sign, on the page', () => {
  const t = setup();
  seedBooks(t, { loss: true });
  const model = computeIncomeStatement(t.ctx, PERIOD);
  assert.equal(model.reingewinnMinor, -460000, 'the fixture must really be a loss');
  const drawn = allRows(pages(decode(exportStatement(t.ctx, { kind: 'income', format: 'pdf', ...PERIOD }).artifact)))
    .map((r) => r.text);
  const line = drawn.find((text) => text.startsWith('Jahresverlust'));
  assert.ok(line !== undefined, 'the result line is missing from the page');
  // A07's worst defect was a sign inversion, and the export layer had no guard at all: `money()`
  // could drop its sign and every test stayed green. A loss printed as a profit is the one number on
  // this page an owner would sign without reading twice.
  assert.ok(line.includes('-4600.00'), `the loss lost its sign: ${JSON.stringify(line)}`);
  assert.ok(!line.includes(' 4600.00'), 'a loss must never render as a positive figure');
  // And the individual expense positions, which are negative too.
  assert.ok(drawn.some((text) => text.includes('-6000.00')), 'Personalaufwand must print negative');
});

test('PDF: a name too wide for its column is TRUNCATED, not allowed to shift the figures', () => {
  const t = setup();
  seedBooks(t);
  const drawn = allRows(pages(decode(exportStatement(t.ctx, { kind: 'trial', format: 'pdf', ...PERIOD }).artifact)))
    .map((r) => r.text);
  // 6800 "Abschreibungen und Wertberichtigungen auf Positionen des Anlagevermögens" is 71 characters
  // in a 34-wide column. `cell()` clips to 33 and marks the cut with a period. Without the clip the
  // row grows and every figure after it slides right, in a fixed-pitch layout where column position
  // IS the column.
  const row = drawn.find((text) => text.startsWith('6800'));
  assert.ok(row !== undefined, 'account 6800 is missing from the page');
  assert.ok(row.includes('Abschreibungen und Wertberichtigu.'), `not truncated: ${JSON.stringify(row)}`);
  assert.ok(!row.includes('Anlagevermögens'), 'the full name must not survive the clip');
  // Every Saldenbilanz row is exactly as wide as the header, which is what the padding buys.
  const header = drawn.find((text) => text.startsWith('Konto   '));
  assert.equal(row.length, header.length, 'a clipped row must still be the header width');
});

test('the artifact carries the model verdict, and says NICHT erfüllt when the books are broken', () => {
  const t = setup();
  seedBooks(t);
  importUnbalancedEntry(t, { date: '2026-02-20', number: '1000', debit: 123400 });

  // `artifact.reconciles` survived being hardcoded `true` because no fixture ever produced a model
  // that said otherwise. This one does.
  const model = computeBalanceSheet(t.ctx, { asOf: '2026-03-31' });
  assert.equal(model.reconciles, false, 'the fixture must really be broken or this case is vacuous');

  const csv = exportStatement(t.ctx, { kind: 'balance', format: 'csv', asOf: '2026-03-31' });
  assert.equal(csv.artifact.reconciles, false, 'the file must not claim a verdict the screen refused');

  // And the PDF says it in words. A Bilanz whose two sides disagree must never leave this module
  // stamped "Abstimmung: erfüllt", which is exactly what the shipped export did while its heading
  // and its Aktiven were drawn off the top of the page.
  const pdf = decode(exportStatement(t.ctx, { kind: 'balance', format: 'pdf', asOf: '2026-03-31' }).artifact);
  const drawn = allRows(pages(pdf)).map((r) => r.text);
  assert.ok(drawn.includes('Abstimmung: NICHT erfüllt'), 'the PDF must print the refusal');
  assert.ok(!drawn.includes('Abstimmung: erfüllt'));

  // The Kontoblatt on an untouched account still reconciles: the verdict is per statement, not a
  // workspace-wide flag that goes red everywhere at once.
  const sheet = exportStatement(t.ctx, { kind: 'ledger', format: 'csv', accountId: t.acc('1020'), ...PERIOD });
  assert.equal(sheet.artifact.reconciles, true);
});

test('PDF: a structurally valid single-page artifact carrying the statement figures', () => {
  const t = setup();
  seedBooks(t);
  const res = exportStatement(t.ctx, { kind: 'balance', format: 'pdf', asOf: '2026-03-31' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.artifact.mediaType, 'application/pdf');
  assert.equal(res.artifact.filename, 'bilanz-per-2026-03-31.pdf');
  // Never claimed, because nothing here verifies it.
  assert.equal(res.artifact.pdfaProfile, null);

  const pdf = decode(res.artifact);
  assert.ok(pdf.startsWith('%PDF-1.4'));
  assert.ok(pdf.endsWith('%%EOF'));
  assert.ok(pdf.includes('/Type /Catalog'));
  assert.ok(pdf.includes('startxref'));
  // The umlaut has to survive: WinAnsiEncoding plus a latin1 byte stream, not a dropped glyph.
  assert.ok(pdf.includes('Umlaufvermögen'), 'the statutory heading must print with its umlaut');
  assert.ok(pdf.includes('/WinAnsiEncoding'));
  // The figures, as plain decimals.
  assert.ok(pdf.includes('43465.00'), 'Total Aktiven must appear on the page');
  assert.ok(pdf.includes('Abstimmung: erfüllt'));
});

/**
 * Every text placement in a PDF, page by page, read back out of the rendered bytes.
 *
 * This exists because the assertion above it (`pdf.includes('Umlaufvermögen')`) was the ONLY thing
 * guarding the page and it proved the wrong property. The heading really was in the content stream,
 * at y=756 on a MediaBox 595 units high, which is 161 units above the paper. It was in the FILE and
 * it was not on the PAGE, and no `includes` check can tell those apart. So this parses the geometry
 * the renderer actually emitted, and the cases below assert POSITION.
 */
function pages(pdf) {
  const box = /\/MediaBox \[0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)\]/.exec(pdf);
  assert.ok(box !== null, 'no MediaBox: the page has no declared geometry at all');
  const [width, height] = [Number(box[1]), Number(box[2])];
  const streams = [...pdf.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => m[1]);
  return {
    width,
    height,
    pages: streams.map((stream) => ({
      rows: [...stream.matchAll(/1 0 0 1 (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) Tm \((.*?)\) Tj/g)].map((m) => ({
        x: Number(m[1]),
        y: Number(m[2]),
        text: m[3],
      })),
    })),
  };
}

/** Every row of every page, flattened, in emission order. */
function allRows(parsed) {
  return parsed.pages.flatMap((page) => page.rows);
}

test('PDF: EVERY row is inside the MediaBox, on all four statements', () => {
  const t = setup();
  seedBooks(t);
  const cases = [
    ['trial', { kind: 'trial', format: 'pdf', ...PERIOD }],
    ['balance', { kind: 'balance', format: 'pdf', asOf: '2026-03-31' }],
    ['income', { kind: 'income', format: 'pdf', ...PERIOD }],
    ['ledger', { kind: 'ledger', format: 'pdf', accountId: t.acc('1020'), ...PERIOD }],
  ];
  for (const [label, input] of cases) {
    const parsed = pages(decode(exportStatement(t.ctx, input).artifact));
    const rows = allRows(parsed);
    assert.ok(rows.length > 0, `${label}: nothing was placed at all`);
    const above = rows.filter((r) => r.y > parsed.height);
    const below = rows.filter((r) => r.y < 0);
    // The exact shape of the shipped defect: 19 rows, the title among them, drawn above the paper.
    assert.deepEqual(
      above.map((r) => r.text.trim()),
      [],
      `${label}: ${above.length} row(s) placed ABOVE the top edge (MediaBox height ${parsed.height}) and rendered nowhere`,
    );
    assert.deepEqual(below.map((r) => r.text.trim()), [], `${label}: row(s) placed below the bottom edge`);
    for (const row of rows) {
      assert.ok(row.x >= 0 && row.x < parsed.width, `${label}: x=${row.x} is outside the page width`);
    }
  }
});

test('PDF: the title is the first thing drawn, and it is ON the page', () => {
  const t = setup();
  seedBooks(t);
  const parsed = pages(decode(exportStatement(t.ctx, { kind: 'balance', format: 'pdf', asOf: '2026-03-31' }).artifact));
  const first = parsed.pages[0].rows[0];
  assert.equal(first.text, 'Bilanz', 'the first row drawn must be the document title');
  // Inside the top edge, and not more than one line of leading below the top margin: a title placed
  // "on the page" but 300 units down would satisfy a bare `y <= height` and still look broken.
  assert.ok(first.y <= parsed.height, `the title is at y=${first.y}, above a page ${parsed.height} high`);
  assert.ok(first.y >= parsed.height - 60, `the title is at y=${first.y}, far below the top margin`);
  // And the heading the old assertion tested for is not merely present, it is BELOW the title and
  // above the bottom edge.
  const heading = allRows(parsed).find((r) => r.text.includes('Umlaufvermögen'));
  assert.ok(heading !== undefined, 'the statutory heading is missing entirely');
  assert.ok(heading.y < first.y && heading.y > 0, `Umlaufvermögen is at y=${heading.y} on a ${parsed.height}-high page`);
});

test('PDF: a statement longer than one page PAGINATES, and loses no row', () => {
  const t = setup();
  seedBooks(t);
  // Enough distinct accounts to overflow a single page. Every one is from the shipped seed, so the
  // fixture chart stays exactly the seed (see support.mjs).
  const extra = ['1060', '1109', '1170', '1171', '1176', '1200', '1300', '1510', '1520', '1530', '2100',
    '2201', '2300', '2450', '2600', '2850', '3000', '3600', '3805', '3806', '4000', '4200', '4400', '4906',
    '5700', '5800', '6000', '6100', '6200', '6300', '6400', '6570', '6600', '6700', '6949'];
  extra.forEach((n, i) => {
    post(t, {
      date: '2026-03-01',
      key: `spread-${i}`,
      description: `Bewegung ${n}`,
      lines: [{ n, debit: 1000 + i }, { n: '1020', credit: 1000 + i }],
    });
  });

  const pdf = decode(exportStatement(t.ctx, { kind: 'trial', format: 'pdf', ...PERIOD }).artifact);
  const parsed = pages(pdf);
  assert.ok(parsed.pages.length > 1, `expected more than one page, got ${parsed.pages.length}`);
  // The /Pages node must agree with the page objects, or a reader shows a different document.
  assert.ok(pdf.includes(`/Count ${parsed.pages.length}`), 'the /Pages /Count disagrees with the page objects');
  assert.equal((pdf.match(/\/Type \/Page\b/g) ?? []).length, parsed.pages.length);

  // Still nothing off the paper, now that there is more than one page to fall off.
  for (const row of allRows(parsed)) {
    assert.ok(row.y >= 0 && row.y <= parsed.height, `row "${row.text.trim()}" at y=${row.y} is off the page`);
  }

  // NOT ONE ACCOUNT MAY BE LOST. The old renderer placed at most 54 rows inside the page and drew
  // the rest nowhere, so a real SME chart silently dropped its tail. Every model row must be found.
  const model = computeTrialBalance(t.ctx, PERIOD);
  const drawn = allRows(parsed).map((r) => r.text);
  for (const row of model.rows) {
    assert.ok(
      drawn.some((text) => text.startsWith(row.account.number)),
      `account ${row.account.number} is in the model and on no page`,
    );
  }
  // The masthead repeats, so a detached page 2 is still identifiable.
  for (const page of parsed.pages) {
    assert.equal(page.rows[0].text, 'Saldenbilanz', 'every page must repeat the document title');
  }
  // And every page says which page it is, so a missing one is visible.
  parsed.pages.forEach((page, i) => {
    assert.equal(page.rows[page.rows.length - 1].text, `Seite ${i + 1} von ${parsed.pages.length}`);
  });
  // The tail of the document survived the split.
  assert.ok(drawn.includes('Abstimmung: erfüllt'), 'the reconciliation verdict fell off the last page');
});

test('PDF: the computed equity positions print their STATUTORY names, not their internal keys', () => {
  const t = setup();
  seedBooks(t);
  const parsed = pages(decode(exportStatement(t.ctx, { kind: 'balance', format: 'pdf', asOf: '2026-03-31' }).artifact));
  const drawn = allRows(parsed).map((r) => r.text);
  // OR Art. 959a Abs. 2 Ziff. 3 lit. f and lit. g. The model carries these labels; the renderer used
  // to fall back to `line.key` for any line with `account: null` and printed the identifiers.
  assert.ok(
    drawn.some((text) => text.includes('Gewinnvortrag oder Verlustvortrag')),
    'lit. f must print under its statutory name',
  );
  assert.ok(
    drawn.some((text) => text.includes('Jahresgewinn oder Jahresverlust')),
    'lit. g must print under its statutory name',
  );
  for (const key of ['ergebnisvortrag', 'jahresergebnis']) {
    assert.ok(!drawn.some((text) => text.includes(key)), `the internal key ${key} must never reach the page`);
  }
});

test('PDF: the xref offsets really point at their objects', () => {
  const t = setup();
  seedBooks(t);
  const pdf = decode(exportStatement(t.ctx, { kind: 'trial', format: 'pdf', ...PERIOD }).artifact);
  const offsets = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(offsets.length, 5, 'five objects, five xref entries');
  offsets.forEach((offset, i) => {
    assert.ok(pdf.startsWith(`${i + 1} 0 obj`, offset), `xref entry ${i + 1} does not point at its object`);
  });
});

test('a rejected model is handed back unchanged, never rendered into a file', () => {
  const t = setup();
  seedBooks(t);
  const inverted = exportStatement(t.ctx, {
    kind: 'trial',
    format: 'csv',
    periodStart: '2026-03-31',
    periodEnd: '2026-01-01',
  });
  assert.equal(inverted.ok, false);
  assert.equal(inverted.error, 'invalid_period');
  assert.equal(inverted.artifact, undefined);
});

test('an unknown kind or format is a structured rejection', () => {
  const t = setup();
  seedBooks(t);
  const kind = exportStatement(t.ctx, { kind: 'cashflow', format: 'csv', ...PERIOD });
  assert.equal(kind.ok, false);
  assert.equal(kind.error, 'invalid_input');
  assert.equal(kind.field, 'kind');
  const format = exportStatement(t.ctx, { kind: 'trial', format: 'xlsx', ...PERIOD });
  assert.equal(format.ok, false);
  assert.equal(format.field, 'format');
});
