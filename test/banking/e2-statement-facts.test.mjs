// D178 points 3 and 4 (spec A20 §11.1, A39 §19): the facts of a bank line. A camt card payment carries
// its instructed USD amount, the bank's rate, the charges and the bank code; a card text without
// structured FX is read by the text fallback; the facts are stored once, beside the line, out of the
// identity key and the statement hash, and the inbox shows them (null for a line imported before them).
//
// SYNTHETIC DATA ONLY: fixtures/e2-camt053-card-fx.xml (invented merchants, amounts and references) and
// values spelled in this file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseCamt, importCamt, listBankInbox } from '../../dist/core/banking/index.js';
import { hashCamtStatement } from '../../dist/core/banking/camt.js';
import {
  SIX_BTC_LABELS,
  btcLabel,
  deriveFacts,
  effectiveRateOf,
  emptyFacts,
  parseFxText,
  principalAtRate,
  readLineFactsMap,
  swissAmountToMinor,
} from '../../dist/core/banking/statementFacts.js';
import { world, must, camt, secondWorkspace } from './bank-inbox-support.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FX_XML = readFileSync(join(HERE, 'fixtures', 'e2-camt053-card-fx.xml'), 'utf8');
const SIX_EN = JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'btc-codes-sps-ch.json'), 'utf8'));

test('the SIX labels: every en text is the extracted SIX workbook text (validity note dropped)', () => {
  const rows = [...SIX_EN.chSpecificMandatory, ...SIX_EN.chGeneral];
  assert.equal(SIX_BTC_LABELS.length, rows.length, 'one label per SIX row');
  for (const row of rows) {
    const label = SIX_BTC_LABELS.find((l) => l.d === row.domain && l.f === row.family && l.s === row.subFamily && l.en === row.swissMarketIndividualization.replace(/\s*\(valid from 20\.8\.2024\)$/, ''));
    assert.ok(label !== undefined, `the SIX row ${row.domain}/${row.family}/${row.subFamily} has its label`);
    assert.ok(label.de.trim().length > 0 && !/­/.test(label.de), 'a de text, soft hyphens removed');
  }
  assert.deepEqual(btcLabel({ domain: 'PMNT', family: 'CCRD', subFamily: 'POSD' }), { en: 'Payment with card at POS', 'de-CH': 'Zahlung mit Karte am POS' });
  assert.equal(btcLabel({ domain: 'PMNT', family: 'IRCT', subFamily: 'DMCT' })?.['de-CH'], 'Belastung aus Domestic Instant-Zahlung', 'the instant family row');
  assert.equal(btcLabel({ domain: 'PMNT', family: 'IRCT', subFamily: 'RRTN' })?.en.startsWith('Reversal of a credit'), true, 'the exact row wins');
  assert.equal(btcLabel({ domain: 'XTND', family: 'NTAV', subFamily: 'NTAV' }), null, 'a code SIX does not list has no label');
});

test('Swiss amounts read exactly into hundredths; more than two decimals is unreadable, never rounded', () => {
  const cases = [
    ["1'234.50", 123450],
    ['1’234.50', 123450],
    ['1 234,50', 123450],
    ['1234,50', 123450],
    ['60.78', 6078],
    ['100,', 10000],
    ['1,234', 123400],
    ['1.234,56', 123456],
    ['1,234.56', 123456],
    ['0.125', null],
    ['12.345.6', null],
    ['abc', null],
  ];
  for (const [raw, want] of cases) assert.equal(swissAmountToMinor(raw), want, raw);
  assert.equal(swissAmountToMinor('1.234', ','), 123400, 'a known decimal comma makes the dot a thousands separator');
  assert.equal(swissAmountToMinor('1.234', '.'), null, 'a known decimal dot: three decimals are unreadable');
});

test('the FX text fallback reads the card text, and the numbers relate (60.78 x 0.810464 + 0.62 = 49.88)', () => {
  const text = 'Antiquariat Westbrook Ltd Boston, USD 60.78, abgerechnet in CHF, Kurs 0.810464, 01.09.2026, Kommission CHF 0.62';
  const fx = parseFxText([text], 'CHF');
  assert.deepEqual(fx, { instructed: { amountMinor: 6078, currency: 'USD' }, rate: '0.810464', fee: { amountMinor: 62, currency: 'CHF' } });
  assert.equal(principalAtRate(fx.instructed, { sourceCurrency: 'USD', targetCurrency: 'CHF', unitCurrency: 'USD', rate: '0.810464', effectiveRate: null, origin: 'text' }, 'CHF'), 4926);
  assert.equal(effectiveRateOf(4988, 6078), '0.820665', '49.88 / 60.78, six decimals, half up');
  const facts = deriveFacts({ ...emptyFacts('camt053'), bankText: text }, { amountMinor: 4988, currency: 'CHF', creditDebit: 'DBIT' });
  assert.equal(facts.exchange?.origin, 'text');
  assert.equal(facts.exchange?.rate, '0.810464');
  assert.equal(facts.exchange?.effectiveRate, '0.820665');
  assert.deepEqual(facts.fee, { amountMinor: 62, currency: 'CHF', included: true, origin: 'text' });
  // Numbers that do not add up: the fee is a fact, but nothing proves it is inside the amount.
  const off = deriveFacts({ ...emptyFacts('camt053'), bankText: text }, { amountMinor: 5100, currency: 'CHF', creditDebit: 'DBIT' });
  assert.equal(off.fee?.included, null);
  // An ordinary text with a three-letter word before a number is no exchange text.
  assert.deepEqual(parseFxText(['Miete Gewerberaum ZUG 6300 September'], 'CHF'), { instructed: null, rate: null, fee: null });
  // Critic M4, all or nothing: the whole exchange pattern, or no fact at all (a fact is written once).
  const none = { instructed: null, rate: null, fee: null };
  for (const partial of [
    'Yoga Kurs 12 Lektionen, Studio Lindenhof ZUG 6300', // a course, a place: no settlement clause
    'Leasing Rate 3 von 36, Vertrag LSG 445566', // an instalment, a contract code
    'Antiquariat Westbrook, USD 60.78, abgerechnet in CHF, Kommission CHF 0.62', // no rate
    'Antiquariat Westbrook, USD 60.78, abgerechnet in CHF, Kurs 1, Kommission CHF 0.62', // a rate without decimals
    'Antiquariat Westbrook, USD 60.78, abgerechnet in EUR, Kurs 0.810464', // settled in another currency than the line's
    'Kursaal Bern, ZUG 6300, abgerechnet in CHF, Kurs 0.81', // no ISO 4217 amount before the clause
    'Parkhaus Lindenhof, Gebühr CHF 12.00', // a fee word alone is no exchange text
  ]) {
    assert.deepEqual(parseFxText([partial], 'CHF'), none, partial);
  }
  // A domestic line: no fallback.
  assert.equal(deriveFacts({ ...emptyFacts('camt053'), bankText: 'Rechnung 2026-118' }, { amountMinor: 12000, currency: 'CHF', creditDebit: 'DBIT' }).exchange, null);
});

test('camt facts: the structured card payment, the text-only one and a domestic transfer', () => {
  const parsed = must(parseCamt(FX_XML)).statement;
  const [card, text, plain] = parsed.entries;
  assert.equal(card.facts.source, 'camt053');
  assert.deepEqual(card.facts.bankCode, { domain: 'PMNT', family: 'CCRD', subFamily: 'POSD', proprietary: 'KARTE-POS', issuer: 'BANK' });
  assert.equal(card.facts.bankText, 'Kartenzahlung Buchladen Seefeld Corp Portland');
  assert.equal(card.facts.additionalInfo, 'Debitkarte xxxx 4417');
  assert.equal(card.facts.entryInfo, 'Kartenbezug Ausland');
  assert.deepEqual(card.facts.refs, { endToEndId: null, accountServicerRef: 'E2FX-TX-001', instructionId: 'E2FX-INSTR-1', transactionId: 'E2FX-TXID-1' });
  assert.deepEqual(card.facts.instructed, { amountMinor: 6078, currency: 'USD' });
  assert.deepEqual(card.facts.transactionAmount, { amountMinor: 4926, currency: 'CHF' });
  assert.deepEqual(card.facts.exchange, { sourceCurrency: 'USD', targetCurrency: 'CHF', unitCurrency: 'USD', rate: '0.810464', effectiveRate: '0.820665', origin: 'structured' });
  assert.equal(card.facts.charges.totalMinor, 62);
  assert.deepEqual(card.facts.charges.records, [{ amountMinor: 62, currency: 'CHF', creditDebit: 'DBIT', included: true, type: 'FX-KOMM' }]);
  assert.deepEqual(card.facts.fee, { amountMinor: 62, currency: 'CHF', included: true, origin: 'charges' });
  // The text card: 41.50 EUR at 0.951234 is 39.48, plus 0.75 is the 40.23 debited.
  assert.equal(text.facts.exchange.origin, 'text');
  assert.deepEqual(text.facts.instructed, { amountMinor: 4150, currency: 'EUR' });
  assert.equal(text.facts.exchange.effectiveRate, '0.969398');
  assert.deepEqual(text.facts.fee, { amountMinor: 75, currency: 'CHF', included: true, origin: 'text' });
  // The domestic transfer: a code and texts, no exchange, no fee.
  assert.equal(plain.facts.exchange, null);
  assert.equal(plain.facts.fee, null);
  assert.equal(plain.facts.refs.endToEndId, 'E2FX-E2E-3');
  // The facts stay out of the statement hash: the same statement without them hashes the same.
  const bare = FX_XML.replace(/<AmtDtls>[\s\S]*?<\/AmtDtls>/g, '').replace(/<Chrgs>[\s\S]*?<\/Chrgs>/g, '').replace(/<AddtlTxInf>[\s\S]*?<\/AddtlTxInf>/g, '');
  assert.equal(hashCamtStatement(must(parseCamt(bare)).statement), hashCamtStatement(parsed));
});

test('import stores the facts once; the inbox projects them with the SIX label; an older line reads null', () => {
  const t = world();
  // A line imported "before facts": a plain statement, its fact row removed as an old book would lack it.
  const old = must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camt({ statementId: 'E2-OLD', from: '2026-08-31', to: '2026-08-31', entries: [{ ref: 'OLD-1', amountMinor: 1500, cd: 'DBIT', date: '2026-08-31' }] }), idempotencyKey: 'old' }));
  t.store.db.prepare('DELETE FROM bank_txn_fact WHERE workspace_id = ?').run(t.workspaceId);
  const res = must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: FX_XML, idempotencyKey: 'fx' }));
  assert.equal(res.txnCount, 3);
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn_fact WHERE workspace_id = ?').get(t.workspaceId).n, 3);
  const inbox = must(listBankInbox(t.ctx, { status: 'all' }));
  const byText = (s) => inbox.lines.find((l) => l.facts?.bankText?.includes(s));
  const card = byText('Buchladen');
  assert.deepEqual(card.facts.bankCode.label, { en: 'Payment with card at POS', 'de-CH': 'Zahlung mit Karte am POS' });
  assert.equal(card.facts.exchange.rate, '0.810464');
  assert.equal(card.facts.exchange.effectiveRate, '0.820665');
  assert.deepEqual(card.facts.fee, { amountMinor: 62, currency: 'CHF', included: true, origin: 'charges' });
  assert.equal(card.bookingDate, '2026-09-02');
  assert.equal(card.valueDate, '2026-09-01', 'both dates shown');
  const oldLine = inbox.lines.find((l) => l.statementId === old.statementId);
  assert.equal(oldLine.facts, null, 'no facts recorded, said as null');
  // A re-import is still a duplicate (the facts are outside the hash and the key).
  const again = must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: FX_XML, idempotencyKey: 'fx-again' }));
  assert.equal(again.duplicate, true);
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn_fact WHERE workspace_id = ?').get(t.workspaceId).n, 3, 'no second fact row');
});

test('§H-TENANT: another workspace reads none of these facts', () => {
  const t = world();
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: FX_XML, idempotencyKey: 'fx' }));
  const ids = t.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ?').all(t.workspaceId).map((r) => r.id);
  assert.equal(readLineFactsMap(t.ctx, ids).size, 3);
  const other = secondWorkspace(t);
  assert.equal(readLineFactsMap(other.ctx, ids).size, 0, 'the other workspace sees no fact of this one');
});
