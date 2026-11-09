/**
 * G18 US-G18.2 / US-G18.5: the new source adapters (xlsx, AbaConnect XML, Banana TSV, Crésus TSV) and
 * the honest "not yet readable" rows (Sage 50 CH, KLARA, Topal). Each readable adapter parses its
 * SYNTHETIC fixture to the exact expected rows; a not-yet-readable adapter refuses rather than guessing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSource,
  isParseFailure,
  SOURCE_ADAPTERS,
  sourceAdapterDef,
} from '../../dist/core/migration/index.js';
import { normalizeToken } from '../../dist/core/migration/locale/registry.js';
import {
  BEXIO_CONTACTS_CSV,
  BEXIO_CONTACTS_FULL_CSV,
  BEXIO_SALDENLISTE_CSV,
  BEXIO_JOURNAL_CSV,
  BEXIO_CHART_CSV,
  BANANA_TRANSACTIONS_TSV,
  CRESUS_JOURNAL_TSV,
  ABACUS_CONTACTS_XML,
  XLSX_PARTS,
  XLSX_HEADER_ONLY_PARTS,
} from '../../dist/core/migration/adapters/fixtures/index.js';
import { writeXlsx } from './zipWrite.mjs';

const enc = (s) => new TextEncoder().encode(s);

test('every registered adapter carries a non-empty cleanRoomSource (the clean-room gate)', () => {
  for (const a of SOURCE_ADAPTERS) {
    assert.ok(typeof a.cleanRoomSource === 'string' && a.cleanRoomSource.length > 0, `${a.id} has no cleanRoomSource`);
  }
});

test('bexio / generic CSV: semicolon contacts export parses to rows', () => {
  const r = parseSource('bexio_csv', enc(BEXIO_CONTACTS_CSV));
  assert.ok(!isParseFailure(r));
  assert.deepEqual(r.headers, ['Name', 'Ort', 'Konto']);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.rows[0], { Name: 'Muster AG', Ort: 'Zürich', Konto: '1100' });
  assert.equal(r.asAt, null);
});

test('Banana TSV: tab-separated, case-sensitive headers', () => {
  const r = parseSource('banana_tsv', enc(BANANA_TRANSACTIONS_TSV));
  assert.ok(!isParseFailure(r));
  assert.deepEqual(r.headers, ['Date', 'Description', 'AccountDebit', 'AccountCredit', 'Amount', 'VatCode']);
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[0].AccountDebit, '6500');
  assert.equal(r.rows[1].Amount, '5400.00');
});

test('Crésus TSV: tab-separated with CR+LF lines and Swiss number style', () => {
  const r = parseSource('cresus_csv', enc(CRESUS_JOURNAL_TSV));
  assert.ok(!isParseFailure(r));
  assert.deepEqual(r.headers, ['Date', 'N° pièce', 'Compte débit', 'Compte crédit', 'Libellé', 'Montant']);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[1].Montant, "5'400.00"); // the apostrophe thousands separator is preserved verbatim
});

test('Abacus AbaConnect XML: each Address record becomes a row of its leaf fields', () => {
  const r = parseSource('abacus_abaconnect', enc(ABACUS_CONTACTS_XML));
  assert.ok(!isParseFailure(r));
  assert.deepEqual(r.headers, ['AddressNumber', 'LastName', 'FirstName', 'Country', 'ZIP', 'City']);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows[0], { AddressNumber: '1001', LastName: 'Muster', FirstName: 'Hans', Country: 'CH', ZIP: '8000', City: 'Zürich' });
  assert.equal(r.rows[1].City, 'Bern');
  assert.equal(r.asAt, null); // the envelope carries an interface Version, not a generation date
});

test('Abacus AbaConnect: a non-AbaConnect payload is unparseable, not a silent empty', () => {
  const r = parseSource('abacus_abaconnect', enc('<xml>not abaconnect</xml>'));
  assert.ok(isParseFailure(r));
  assert.equal(r.reason, 'not_abaconnect');
});

test('xlsx: first worksheet by default, typed cells, worksheet catalog reported', () => {
  const bytes = writeXlsx(XLSX_PARTS);
  const r = parseSource('xlsx', bytes);
  assert.ok(!isParseFailure(r), JSON.stringify(r));
  assert.deepEqual(r.headers, ['Name', 'Ort', 'Konto']);
  assert.deepEqual(r.worksheets, ['Kontakte', 'Notizen']);
  assert.equal(r.worksheet, 'Kontakte');
  assert.equal(r.rows.length, 2);
  // Row 2: inline string name + shared string Ort was actually inline; numeric Konto.
  assert.deepEqual(r.rows[0], { Name: 'Beispiel GmbH', Ort: 'Bern', Konto: '1101' });
  // Row 3: shared-string name, inline Ort, and the CACHED formula value (never evaluated).
  assert.deepEqual(r.rows[1], { Name: 'Muster AG', Ort: 'Zürich', Konto: '1102' });
});

test('xlsx: a named worksheet can be chosen per file', () => {
  const bytes = writeXlsx(XLSX_PARTS);
  const r = parseSource('xlsx', bytes, undefined, { sheet: 'Notizen' });
  assert.ok(!isParseFailure(r));
  assert.equal(r.worksheet, 'Notizen');
  assert.equal(r.rows.length, 0); // an empty second sheet
});

test('xlsx: a header-only worksheet yields rowCount 0 (the empty contract)', () => {
  const bytes = writeXlsx(XLSX_HEADER_ONLY_PARTS);
  const r = parseSource('xlsx', bytes);
  assert.ok(!isParseFailure(r));
  assert.deepEqual(r.headers, ['Name', 'Ort']);
  assert.equal(r.rows.length, 0);
});

test('xlsx: a password-protected (OLE compound) workbook reports encrypted', () => {
  const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
  const r = parseSource('xlsx', ole);
  assert.ok(isParseFailure(r));
  assert.equal(r.reason, 'encrypted');
});

test('xlsx: a truncated / non-zip payload reports corrupt', () => {
  const r = parseSource('xlsx', enc('this is not a workbook'));
  assert.ok(isParseFailure(r));
  assert.equal(r.reason, 'corrupt');
});

test('not-yet-readable adapters refuse rather than guess a parse', () => {
  for (const id of ['sage50_ch', 'klara_csv', 'topal']) {
    const def = sourceAdapterDef(id);
    assert.equal(def.readable, false, `${id} should be marked not readable`);
    const r = parseSource(id, enc('a;b\n1;2\n'));
    assert.ok(isParseFailure(r), `${id} should refuse`);
    assert.equal(r.reason, 'not_yet_readable');
  }
});

test('every preset entry traces to a fixture header (an unbacked preset never ships)', () => {
  // The fixture rule (spec §2 US-G18.1): a column preset ships only when a real anonymised fixture
  // carries the header it claims. This walk parses each adapter's fixture text through the adapter's
  // OWN parser, normalises the headers exactly as suggestMap does, and asserts every preset.header is
  // among them. Because preset headers are stored normalised (`normalizeToken`), the comparison is on
  // normalised tokens, not raw strings: that is what suggestMap keys on, so this is the real contract.
  // It bites the moment a preset entry is added without a fixture header behind it.
  const FIXTURE_TEXT = {
    // A preset header may trace to ANY of an adapter's fixtures (bexio's presets span the Saldenliste
    // and the Journal; the chart and contacts fixtures prove the parse arm on the real column shapes).
    bexio_csv: [
      BEXIO_SALDENLISTE_CSV,
      BEXIO_JOURNAL_CSV,
      BEXIO_CHART_CSV,
      BEXIO_CONTACTS_FULL_CSV,
      BEXIO_CONTACTS_CSV,
    ],
    banana_tsv: [BANANA_TRANSACTIONS_TSV],
    cresus_csv: [CRESUS_JOURNAL_TSV],
  };
  for (const a of SOURCE_ADAPTERS) {
    if (a.columnPresets.length === 0) continue;
    const texts = FIXTURE_TEXT[a.id];
    assert.ok(texts && texts.length > 0, `${a.id} has presets but no fixture text registered in this test`);
    const normalizedHeaders = new Set();
    for (const t of texts) {
      const parsed = parseSource(a.id, enc(t));
      assert.ok(!isParseFailure(parsed), `${a.id} fixture failed to parse: ${JSON.stringify(parsed)}`);
      for (const h of parsed.headers) normalizedHeaders.add(normalizeToken(h));
    }
    for (const preset of a.columnPresets) {
      assert.ok(
        normalizedHeaders.has(preset.header),
        `preset ${a.id}.${preset.header} has no fixture header behind it`,
      );
    }
  }
});

test('the bexio column presets map every mappable Journal and Saldenliste column (turnkey import)', () => {
  // The whole point of the preset: a bexio export maps with no manual column work. This asserts the
  // exact header -> neutral-field contract for the two money-shaped classes, and that the columns with
  // no neutral field (the bexio booking Id, the FX-detail trio, the Saldenliste account name) stay
  // unmapped rather than being force-fitted onto a field they do not carry.
  const bexio = sourceAdapterDef('bexio_csv');
  const byHeader = new Map(bexio.columnPresets.map((p) => [p.header, p.field]));
  const maps = (rawHeader, field) =>
    assert.equal(byHeader.get(normalizeToken(rawHeader)), field, `${rawHeader} should map to ${field}`);
  // opening_balances (Saldenliste)
  maps('Kontonummer', 'account');
  maps('Saldo', 'balance');
  // gl_history (Buchungen/Journal)
  maps('Datum', 'date');
  maps('Referenz', 'reference');
  maps('Soll', 'debit');
  maps('Haben', 'credit');
  maps('Beschreibung', 'description');
  maps('Betrag', 'amount');
  maps('Buchungswährung', 'currency');
  maps('MWST', 'taxCode');
  for (const raw of ['Id', 'Umrechnungsfaktor', 'Betrag in Basiswährung', 'Währung in Basiswährung', 'Name']) {
    assert.equal(byHeader.has(normalizeToken(raw)), false, `${raw} has no neutral field and must stay unmapped`);
  }
});
