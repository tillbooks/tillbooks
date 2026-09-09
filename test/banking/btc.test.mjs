// Drift guard for the Swiss Bank Transaction Codes. The fixture is a verbatim extract of the SIX
// workbook; these tests assert that every code the engine relies on genuinely appears there, so a
// fabricated or mistyped code cannot survive a test run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BTC_QR_BILL_INCOMING,
  BTC_DIRECT_DEBIT_COLLECTED,
  BTC_DIRECT_DEBIT_PAID,
  BTC_REVERSALS,
  formatBtc,
  btcEquals,
  isReversalBtc,
} from '../../dist/core/banking/index.js';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/btc-codes-sps-ch.json', import.meta.url), 'utf8'),
);

// The ISO registry of record. SIX says what Swiss banks send; ISO says what may exist at all.
const iso = JSON.parse(
  readFileSync(new URL('../fixtures/btc-codes-iso-20022.json', import.meta.url), 'utf8'),
);

const allRows = [...fixture.chSpecificMandatory, ...fixture.chGeneral];

function rowFor(code) {
  return allRows.find(
    (r) => r.domain === code.domain && r.family === code.family && r.subFamily === code.subFamily,
  );
}

test('the fixture holds the full SIX extract: 12 mandatory and 36 general rows', () => {
  assert.equal(fixture.chSpecificMandatory.length, 12);
  assert.equal(fixture.chGeneral.length, 36);
});

test('every code the module exports exists verbatim in the SIX extract', () => {
  const exported = [
    BTC_QR_BILL_INCOMING,
    BTC_DIRECT_DEBIT_COLLECTED,
    BTC_DIRECT_DEBIT_PAID,
    ...BTC_REVERSALS,
  ];
  for (const c of exported) {
    assert.ok(rowFor(c.code), `${formatBtc(c.code)} is not in the SIX list`);
  }
});

test('no fabricated sub-family: every code value is a four-letter uppercase ISO code', () => {
  for (const row of allRows) {
    assert.match(row.domain, /^[A-Z]{4}$/);
    assert.match(row.family, /^[A-Z]{4}$/);
    // Two Real-Time rows carry prose instead of a code; those are recorded as null, not invented.
    if (row.subFamily !== null) assert.match(row.subFamily, /^[A-Z]{4}$/);
    else assert.equal(typeof row.subFamilyNote, 'string');
  }
});

test('exactly the two known Real-Time rows lack a sub-family code', () => {
  const missing = allRows.filter((r) => r.subFamily === null).map((r) => r.family);
  assert.deepEqual(missing.sort(), ['IRCT', 'RRCT']);
});

test('QR-bill incoming is PMNT/RCDT/VCOM and is verified', () => {
  assert.equal(formatBtc(BTC_QR_BILL_INCOMING.code), 'PMNT/RCDT/VCOM');
  assert.equal(BTC_QR_BILL_INCOMING.confidence, 'verified');
  assert.match(rowFor(BTC_QR_BILL_INCOMING.code).swissMarketIndividualization, /QR-IBAN incoming payment/);
});

test('a collected direct debit is PMNT/IDDT/PMDD, credits us, and is flagged inferred with a caveat', () => {
  assert.equal(formatBtc(BTC_DIRECT_DEBIT_COLLECTED.code), 'PMNT/IDDT/PMDD');
  assert.equal(BTC_DIRECT_DEBIT_COLLECTED.effect, 'credit');
  // The scheme mapping is not evidenced by SIX, so it must never claim to be.
  assert.equal(BTC_DIRECT_DEBIT_COLLECTED.confidence, 'inferred');
  assert.ok(BTC_DIRECT_DEBIT_COLLECTED.caveat);
});

test('Issued/Received orientation matches the SIX gloss and is not inverted', () => {
  assert.match(rowFor(BTC_DIRECT_DEBIT_COLLECTED.code).swissMarketIndividualization, /^Credit from/);
  assert.match(rowFor(BTC_DIRECT_DEBIT_PAID.code).swissMarketIndividualization, /^Debit from/);
  assert.equal(BTC_DIRECT_DEBIT_COLLECTED.effect, 'credit');
  assert.equal(BTC_DIRECT_DEBIT_PAID.effect, 'debit');
});

test('eBill Direct Debit and a paid QR-bill never share a BTC', () => {
  assert.ok(!btcEquals(BTC_DIRECT_DEBIT_COLLECTED.code, BTC_QR_BILL_INCOMING.code));
});

// --- Cross-check against the ISO 20022 registry of record -------------------------------------
//
// SIX is authoritative for what Swiss banks actually send. ISO is authoritative for whether a
// Domain/Family/SubFamily code exists at all. These assertions pin the second question, so a code
// that ISO later withdraws cannot sit unnoticed in the Swiss fixture.

test('every SIX domain and family is a registered ISO code', () => {
  for (const row of allRows) {
    assert.ok(iso.domains[row.domain], `domain ${row.domain} is not an ISO BTC domain`);
    const family = `${row.domain}/${row.family}`;
    assert.ok(iso.families[family], `family ${family} is not an ISO BTC family`);
  }
});

test('every SIX sub-family is a registered ISO sub-family', () => {
  for (const row of allRows) {
    if (row.subFamily === null) continue; // the two Real-Time rows carry prose, checked elsewhere
    assert.ok(
      iso.subFamilies[row.subFamily],
      `sub-family ${row.subFamily} is not an ISO BTC sub-family`,
    );
  }
});

test('every SIX triple is a combination ISO actually permits', () => {
  // A triple can be built from three individually valid codes and still be illegal: ISO publishes
  // an explicit allow-list of permitted combinations, and that list is the real constraint.
  const permitted = new Set(iso.validCombinations);
  for (const row of allRows) {
    if (row.subFamily === null) continue;
    const triple = `${row.domain}/${row.family}/${row.subFamily}`;
    assert.ok(permitted.has(triple), `${triple} is not an ISO-permitted BTC combination`);
  }
});

test('the two sub-family-less rows still name an ISO family', () => {
  for (const row of allRows.filter((r) => r.subFamily === null)) {
    assert.ok(iso.families[`${row.domain}/${row.family}`]);
  }
});

test('no code TILL relies on has been deprecated by ISO', () => {
  // The BTC list has no Obsolete status and no Replaced By column: New, Corrected and Updated are
  // the only values it uses. If ISO ever introduces a withdrawal marker this assertion fails loudly
  // rather than letting a dead code through.
  assert.deepEqual(Object.keys(iso.statusCounts).sort(), ['Corrected', 'New', 'Updated']);
});

test('the ISO fixture records the version it was extracted from', () => {
  assert.equal(iso.source.version, 'v7.0');
  assert.equal(iso.source.versionDate, '2023-10-30');
  assert.equal(iso.source.confirmedAgainst.version, '7.1');
  assert.equal(iso.source.codeSetsRelease.release, '1Q2026');
});

test('isReversalBtc recognises the reversal codes and rejects the ordinary ones', () => {
  for (const r of BTC_REVERSALS) assert.ok(isReversalBtc(r.code));
  assert.ok(!isReversalBtc(BTC_QR_BILL_INCOMING.code));
  assert.ok(!isReversalBtc(BTC_DIRECT_DEBIT_COLLECTED.code));
  assert.ok(!isReversalBtc(BTC_DIRECT_DEBIT_PAID.code));
});
