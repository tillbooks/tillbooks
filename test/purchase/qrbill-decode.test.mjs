/**
 * A31 §0a, the strict Swiss QR Code decoder for SUPPLIED payloads (`decodeSwissQrBill`).
 *
 * Two published SIX samples (IG v2.3 Annex A, examples 1 and 2) must decode clean, and every rule
 * the decoder enforces is provoked by a synthetic payload built from scratch, one rule broken at a
 * time, so each assertion names the one code that rule owns. No fixture here is derived from a real
 * bill: the addresses are SIX's own "Max Muster & Söhne / Seldwyla" sample or invented.
 *
 * The coverage test at the end fails when an issue code exists that no case provokes, so a code
 * added without a test is caught by construction.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeSwissQrBill, QR_DECODE_ISSUE_CODES } from '../../dist/core/purchase/qrbill/decode.js';
import { buildQrrReference, buildScorReference } from '../../dist/core/sales/qrbill.js';

// --- the published SIX samples (IG v2.3 Annex A, Tables 17 and 18) ------------------------------

const SIX_EXAMPLE_1 = [
  'SPC', '0200', '1', 'CH6431961000004421557',
  'S', 'Max Muster & Söhne', 'Musterstrasse', '123', '8000', 'Seldwyla', 'CH',
  '', '', '', '', '', '', '',
  '50.00', 'CHF',
  'S', 'Simon Muster', 'Musterstrasse', '1', '8000', 'Seldwyla', 'CH',
  'QRR', '000008207791225857421286694', 'Payment of travel', 'EPD',
].join('\r\n');

const SIX_EXAMPLE_2 = [
  'SPC', '0200', '1', 'CH4431999123000889012',
  'S', 'Max Muster & Söhne', 'Musterstrasse', '123', '8000', 'Seldwyla', 'CH',
  '', '', '', '', '', '', '',
  '1949.75', 'CHF',
  'S', 'Simon Muster', 'Musterstrasse', '1', '8000', 'Seldwyla', 'CH',
  'QRR', '210000000003139471430009017', 'Order from 15.10.2020', 'EPD',
  '//S1/10/1234/11/201021/30/102673386/32/7.7/40/0:30',
  'eBill/B/simon.muster@example.com',
].join('\n');

// --- a synthetic base, built from scratch, that each case below breaks in one place -------------

/** An ordinary (non-QR) CH IBAN with valid check digits: IID 00762, so SCOR/NON, never QRR. */
const PLAIN_IBAN = 'CH9300762011623852957';
const QR_IBAN = 'CH4431999123000889012'; // SIX's own sample QR-IBAN (QR-IID 31999)

function lines(overrides = {}) {
  const base = [
    'SPC', '0200', '1', QR_IBAN,
    'S', 'Beispiel Werkstatt AG', 'Talweg', '7', '3000', 'Bern', 'CH',
    '', '', '', '', '', '', '',
    '215.40', 'CHF',
    '', '', '', '', '', '', '',
    'QRR', buildQrrReference('4711'), 'Rechnung 4711', 'EPD',
  ];
  for (const [i, value] of Object.entries(overrides)) base[Number(i)] = value;
  return base;
}
const payload = (overrides, sep = '\n') => lines(overrides).join(sep);

function codes(result, kind = 'errors') {
  return (result[kind] ?? []).map((i) => i.code);
}

test('SIX IG v2.3 Annex A example 1 decodes clean (QR-IBAN + QRR, CR+LF)', () => {
  const r = decodeSwissQrBill(SIX_EXAMPLE_1);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.warnings, []);
  assert.equal(r.bill.iban, 'CH6431961000004421557');
  assert.equal(r.bill.qrIban, true);
  assert.equal(r.bill.amountMinor, 5000);
  assert.equal(r.bill.currency, 'CHF');
  assert.deepEqual(r.bill.creditor, { name: 'Max Muster & Söhne', street: 'Musterstrasse', buildingNumber: '123', postalCode: '8000', town: 'Seldwyla', country: 'CH' });
  assert.equal(r.bill.ultimateDebtor.name, 'Simon Muster');
  assert.equal(r.bill.referenceType, 'QRR');
  assert.equal(r.bill.reference, '000008207791225857421286694');
  assert.equal(r.bill.unstructuredMessage, 'Payment of travel');
  assert.equal(r.bill.swico, null);
});

test('SIX IG v2.3 Annex A example 2 decodes clean, with Swico S1 and an eBill alternative procedure', () => {
  const r = decodeSwissQrBill(SIX_EXAMPLE_2);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.bill.amountMinor, 194975);
  assert.equal(r.bill.reference, '210000000003139471430009017');
  assert.deepEqual(r.bill.alternativeProcedures, ['eBill/B/simon.muster@example.com']);
  const swico = Object.fromEntries(r.bill.swico.fields.map((f) => [f.key, f.value]));
  assert.equal(swico.invoice_no, '1234');
  assert.equal(swico.invoice_date, '2020-10-21');
  assert.equal(swico.vendor_uid, '102673386');
  assert.equal(swico.vat_rate, '7.7');
  assert.equal(swico.due_date, '2020-11-20');
  assert.equal(r.bill.swico.uid, '102673386');
});

test('the synthetic base decodes clean, so every case below breaks exactly the rule it names', () => {
  const r = decodeSwissQrBill(payload());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.warnings, []);
  assert.equal(r.bill.amountMinor, 21540);
  assert.equal(r.bill.ultimateDebtor, null);
});

test('a plain IBAN with SCOR decodes, SCOR upper-cased (banks do not distinguish case)', () => {
  const scor = buildScorReference('INV4711');
  const r = decodeSwissQrBill(payload({ 3: PLAIN_IBAN, 27: 'SCOR', 28: scor.toLowerCase() }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.bill.qrIban, false);
  assert.equal(r.bill.reference, scor);
});

test('a plain IBAN with NON and an empty reference decodes', () => {
  const r = decodeSwissQrBill(payload({ 3: PLAIN_IBAN, 27: 'NON', 28: '' }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.bill.reference, null);
});

// --- structural errors: positions cannot be trusted after them, so the decode stops ------------

const STRUCTURE = [
  ['empty_payload', ''],
  ['not_spc', payload({ 0: 'SPX' })],
  ['unsupported_version', payload({ 1: '0100' })],
  ['separator', lines().join('\r')],
  ['separator', `${lines().slice(0, 10).join('\r\n')}\n${lines().slice(10).join('\n')}`],
  ['element_count', lines().slice(0, 30).join('\n')],
  ['element_count', [...lines(), '', '', '', 'x'].join('\n')],
];
for (const [code, text] of STRUCTURE) {
  test(`structure: ${code} refuses the payload and nothing is decoded`, () => {
    const r = decodeSwissQrBill(text);
    assert.equal(r.ok, false);
    assert.deepEqual(codes(r), [code]);
    assert.equal(r.bill, undefined);
  });
}

test('element_count names where the trailer actually sits', () => {
  const short = lines();
  short.splice(12, 1); // one ultimate-creditor line lost
  const r = decodeSwissQrBill(short.join('\n'));
  assert.deepEqual(codes(r), ['element_count']);
  assert.match(r.errors[0].message, /line 30 instead of line 31/);
});

// --- element errors: each case breaks one rule; the code and the line are asserted --------------

const ELEMENT = [
  ['unsupported_coding', { 2: '2' }, 3],
  ['disallowed_character', { 5: 'Werkstatt \u{1F600} AG' }, 6],
  ['disallowed_character', { 29: 'Tab\there' }, 30],
  ['field_too_long', { 5: 'N'.repeat(71) }, 6],
  ['field_too_long', { 7: '1'.repeat(17) }, 8],
  ['field_too_long', { 9: 'T'.repeat(36) }, 10],
  ['field_too_long', { 29: 'm'.repeat(141) }, 30],
  ['trailer', { 30: 'END' }, 31],
  ['blank_only', { 18: '      ' }, 19], // a blank Amt must not become an open amount (critic L2)
  ['blank_only', { 12: '   ' }, 13],
  ['iban_format', { 3: 'CH44 3199 9123 0008 8901 2' }, 4],
  ['iban_format', { 3: 'CH44319991230008890' }, 4],
  ['iban_format', { 3: 'DE89370400440532013000' }, 4], // a 22-character German IBAN fails the 21-character shape first
  ['iban_check_digits', { 3: 'CH4531999123000889012' }, 4],
  ['address_type_combined', { 4: 'K' }, 5],
  ['address_type', { 4: 'X' }, 5],
  ['address_incomplete', { 8: '' }, 9],
  ['address_incomplete', { 5: '' }, 6],
  ['country_code', { 10: 'Schweiz' }, 11],
  ['country_code', { 10: 'ch' }, 11],
  ['country_code', { 10: 'XX' }, 11], // well shaped, never assigned (critic L3)
  ['country_code', { 10: 'ZZ' }, 11], // user-assigned too, and not the one owner-approved exception
  ['ultimate_creditor_filled', { 12: 'Someone' }, 13],
  ['amount_format', { 18: '215.4' }, 19],
  ['amount_format', { 18: '0215.40' }, 19],
  ['amount_format', { 18: '215,40' }, 19],
  ['amount_range', { 18: '0.00' }, 19],
  ['amount_range', { 18: '1000000000.00' }, 19],
  ['currency', { 19: 'USD' }, 20],
  ['address_type_combined', { 20: 'K', 21: 'Muster Hans', 22: 'Weg 1', 23: '8000 Zürich' }, 21],
  ['address_incomplete', { 20: 'S', 21: 'Muster Hans' }, 25],
  ['reference_type', { 27: 'ESR' }, 28],
  ['qrr_format', { 28: '12345' }, 29],
  ['qrr_check_digit', { 28: `${buildQrrReference('4711').slice(0, 26)}${(Number(buildQrrReference('4711').slice(26)) + 1) % 10}` }, 29],
  ['reference_missing', { 28: '' }, 29],
  ['qr_iban_requires_qrr', { 27: 'SCOR', 28: buildScorReference('A1') }, 28],
  ['qr_iban_requires_qrr', { 27: 'NON', 28: '' }, 28],
  ['qrr_requires_qr_iban', { 3: PLAIN_IBAN }, 28],
  ['scor_format', { 3: PLAIN_IBAN, 27: 'SCOR', 28: 'RF1' }, 29],
  ['scor_check_digit', { 3: PLAIN_IBAN, 27: 'SCOR', 28: 'RF00INV4711' }, 29],
  ['non_reference_present', { 3: PLAIN_IBAN, 27: 'NON', 28: 'ABC' }, 29],
];
for (const [code, overrides, line] of ELEMENT) {
  test(`element: ${code} on line ${line} (${JSON.stringify(overrides).slice(0, 60)})`, () => {
    const r = decodeSwissQrBill(payload(overrides));
    assert.equal(r.ok, false, `expected refusal for ${code}`);
    const hit = r.errors.find((e) => e.code === code);
    assert.ok(hit, `expected ${code}, got ${codes(r).join(', ')}`);
    assert.equal(hit.line, line);
    assert.equal(typeof hit.message, 'string');
    assert.ok(hit.message.length > 10);
  });
}

test('iban_country: a 21-character IBAN from outside CH/LI', () => {
  // AD (Andorra) IBANs are 24 long; build a 21-char shape with a foreign prefix to reach the country rule.
  const r = decodeSwissQrBill(payload({ 3: 'AT483200000012345864X' }));
  assert.ok(codes(r).includes('iban_country'), codes(r).join(', '));
});

test('additional_info_too_long: Ustrd + StrdBkgInf over 140 together, each within 140', () => {
  const r = decodeSwissQrBill([...lines({ 29: 'm'.repeat(80) }), `//S1/10/${'1'.repeat(60)}`].join('\n'));
  assert.deepEqual(codes(r), ['additional_info_too_long']);
});

test('field_too_long: an alternative procedure over 100 characters', () => {
  const r = decodeSwissQrBill([...lines(), '', 'x'.repeat(101)].join('\n'));
  assert.deepEqual(codes(r), ['field_too_long']);
  assert.equal(r.errors[0].line, 33);
});

test('payload_too_long: more than 997 characters, separators included', () => {
  // Every element at its own limit sums to about 870 characters, so 997 is only crossed by a payload
  // that also breaks a field limit: both are reported.
  const r = decodeSwissQrBill(payload({ 5: 'N'.repeat(900) }));
  assert.deepEqual(codes(r).sort(), ['field_too_long', 'payload_too_long']);
});

test('payload_too_long: absurdly long supplied text is refused unread', () => {
  const r = decodeSwissQrBill('SPC\n'.repeat(5000));
  assert.deepEqual(codes(r), ['payload_too_long']);
});

test('every error is collected, not only the first', () => {
  const r = decodeSwissQrBill(payload({ 2: '2', 4: 'K', 18: '1,00', 19: 'USD', 30: 'END' }));
  assert.deepEqual(codes(r).sort(), ['address_type_combined', 'amount_format', 'currency', 'trailer', 'unsupported_coding'].sort());
});

// --- warnings: reported, the decode still succeeds ---------------------------------------------

const WARNINGS = [
  ['trailing_separator', `${payload()}\n`],
  ['trailing_separator', `${payload({}, '\r\n')}\r\n`],
  ['blank_padding', payload({ 5: 'Beispiel Werkstatt AG  ' })],
  ['amount_open', payload({ 18: '' })],
  ['billing_info_unrecognised', [...lines(), '//XY/some other syntax'].join('\n')],
  ['swico_value', [...lines(), '//S1/10/4711/11/991399'].join('\n')],
  ['eur_qrr_ig_v24', payload({ 19: 'EUR' })],
  ['notification', payload({ 18: '0.00', 29: 'NICHT ZUR ZAHLUNG VERWENDEN' })],
  ['country_user_assigned', payload({ 10: 'XK' })],
];
for (const [code, text] of WARNINGS) {
  test(`warning: ${code} is reported and the payload still decodes`, () => {
    const r = decodeSwissQrBill(text);
    assert.equal(r.ok, true, JSON.stringify(r.errors ?? []));
    assert.ok(codes(r, 'warnings').includes(code), codes(r, 'warnings').join(', '));
  });
}

test('IG §4.4: a "do not use for payment" notification decodes in all four languages, proposing no amount', () => {
  for (const notice of ['NICHT ZUR ZAHLUNG VERWENDEN', 'NE PAS UTILISER POUR LE PAIEMENT', 'NON UTILIZZARE PER IL PAGAMENTO', 'DO NOT USE FOR PAYMENT']) {
    const r = decodeSwissQrBill(payload({ 18: '0.00', 29: notice }));
    assert.equal(r.ok, true, `${notice}: ${JSON.stringify(r.errors)}`);
    assert.equal(r.bill.amountMinor, null);
    assert.equal(r.bill.notification, true);
    assert.deepEqual(codes(r, 'warnings'), ['notification']);
  }
  // Table 10 prescribes the capitals and the exact wording: anything else keeps 0.00 out of range.
  for (const ustrd of ['Nicht zur Zahlung verwenden', 'NICHT ZUR ZAHLUNG VERWENDEN BITTE', 'Rechnung 4711']) {
    assert.deepEqual(codes(decodeSwissQrBill(payload({ 18: '0.00', 29: ustrd }))), ['amount_range'], ustrd);
  }
  // The notice on a real amount is not a notification: the amount is the bill's.
  const paid = decodeSwissQrBill(payload({ 29: 'DO NOT USE FOR PAYMENT' }));
  assert.equal(paid.bill.amountMinor, 21540);
  assert.equal(paid.bill.notification, false);
});

test('an open amount decodes to amountMinor null, never 0', () => {
  const r = decodeSwissQrBill(payload({ 18: '' }));
  assert.equal(r.bill.amountMinor, null);
});

test('ISO 3166-1: assigned codes near the edges of the list decode (LI, AX, ZW, BQ)', () => {
  for (const ctry of ['LI', 'AX', 'ZW', 'BQ', 'DE']) {
    const r = decodeSwissQrBill(payload({ 10: ctry }));
    assert.equal(r.ok, true, `${ctry}: ${JSON.stringify(r.errors)}`);
  }
});

test('owner decision 30.09.2026: XK (Kosovo) decodes with the country_user_assigned warning, on creditor and ultimate debtor; XX stays refused', () => {
  const creditor = decodeSwissQrBill(payload({ 10: 'XK' }));
  assert.equal(creditor.ok, true, JSON.stringify(creditor.errors));
  assert.equal(creditor.bill.creditor.country, 'XK');
  assert.deepEqual(creditor.warnings.map((w) => [w.code, w.element, w.line]), [['country_user_assigned', 'Cdtr.Ctry', 11]]);

  const debtor = decodeSwissQrBill(payload({ 20: 'S', 21: 'Kunde Muster', 24: '10000', 25: 'Prishtina', 26: 'XK' }));
  assert.equal(debtor.ok, true, JSON.stringify(debtor.errors));
  assert.equal(debtor.bill.ultimateDebtor.country, 'XK');
  assert.deepEqual(debtor.warnings.map((w) => [w.code, w.element, w.line]), [['country_user_assigned', 'UltmtDbtr.Ctry', 27]]);

  for (const ctry of ['XX', 'ZZ', 'xk', 'QM']) {
    assert.deepEqual(codes(decodeSwissQrBill(payload({ 10: ctry }))), ['country_code'], ctry);
  }
});

test('a UTF-8 byte order mark from the reader is not payload content', () => {
  const r = decodeSwissQrBill(`\uFEFF${payload()}`);
  assert.equal(r.ok, true);
});

test('coverage: every issue code is provoked by at least one case above', () => {
  const provoked = new Set(['empty_payload', 'payload_too_long', 'additional_info_too_long', 'iban_country']);
  for (const [c] of STRUCTURE) provoked.add(c);
  for (const [c] of ELEMENT) provoked.add(c);
  for (const [c] of WARNINGS) provoked.add(c);
  const missing = QR_DECODE_ISSUE_CODES.filter((c) => !provoked.has(c));
  assert.deepEqual(missing, []);
});

test('the Studio localises every issue code, in both locales, and no code the engine lacks', async () => {
  const { readFileSync } = await import('node:fs');
  for (const locale of ['en', 'de-CH']) {
    const url = new URL(`../../app/src/surfaces/Capture/messages.${locale}.json`, import.meta.url);
    const issues = JSON.parse(readFileSync(url, 'utf8')).capture.qr.issue;
    assert.deepEqual(Object.keys(issues).sort(), [...QR_DECODE_ISSUE_CODES].sort(), locale);
    for (const [code, text] of Object.entries(issues)) assert.ok(typeof text === 'string' && text.length > 5, `${locale} ${code}`);
  }
});
