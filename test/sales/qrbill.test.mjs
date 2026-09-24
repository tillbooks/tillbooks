// A11, Swiss QR-bill payload (SIX IG QR-bill v2.3). The statutory core: element order, the fixed
// values, QRR (mod-10 recursive) and SCOR (ISO 11649) check digits, structured-address-only, CHF/EUR,
// and the D31 eBill AltPmt + Swico S1 StrdBkgInf.
//
// The GOLDEN fixture is the SIX worked example from "Using the Alternative Procedures" v1.0, Table 4
// (the eBill example): a full Swiss QR Code with a QRR reference 210000000003139471430009017 whose
// 27th digit is the mod-10 recursive check digit, plus the Swico S1 string and the eBill AltPmt line.
// Validating the emitter against SIX's OWN published example is the structural cross-check the spec
// asks for (§8); it is never a claim of SIX certification.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeSwissQrPayload,
  buildQrBillPayload,
  validateQrBill,
  buildQrrReference,
  isValidQrrReference,
  mod10RecursiveCheckDigit,
  buildScorReference,
  isValidScorReference,
  iso11649CheckDigits,
  buildSwicoS1,
  bpToPercentString,
  formatQrAmount,
  isQrCurrency,
  SWISS_QR_IG_VERSION,
} from '../../dist/core/sales/index.js';

// The SIX Table 4 worked example, field by field.
const SIX_EXAMPLE_INPUT = {
  iban: 'CH4431999123000889012',
  creditor: { name: 'Max Muster & Söhne', street: 'Musterstrasse', buildingNo: '123', postalCode: '8000', town: 'Seldwyla', country: 'CH' },
  amountMinor: 194975,
  currency: 'CHF',
  debtor: { name: 'Simon Muster', street: 'Musterstrasse', buildingNo: '1', postalCode: '8000', town: 'Seldwyla', country: 'CH' },
  referenceType: 'QRR',
  reference: '210000000003139471430009017',
  unstructuredMessage: 'Order dated 15 October 2020',
  billingInfo: '//S1/10/1234/11/201021/30/102673386/32/7.7/40/0:30',
  ebillIdentifier: 'simon.muster@example.com',
};

// The exact expected Swiss Payments Code, element for element (CR+LF separated, no trailing CR).
const SIX_EXAMPLE_PAYLOAD = [
  'SPC', '0200', '1',
  'CH4431999123000889012',
  'S', 'Max Muster & Söhne', 'Musterstrasse', '123', '8000', 'Seldwyla', 'CH',
  '', '', '', '', '', '', '',
  '1949.75', 'CHF',
  'S', 'Simon Muster', 'Musterstrasse', '1', '8000', 'Seldwyla', 'CH',
  'QRR', '210000000003139471430009017',
  'Order dated 15 October 2020',
  'EPD',
  '//S1/10/1234/11/201021/30/102673386/32/7.7/40/0:30',
  'eBill/B/simon.muster@example.com',
].join('\r\n');

test('qrbill: pinned to SIX IG QR-bill v2.3 (D28 v2.4 bump is a separate change)', () => {
  assert.equal(SWISS_QR_IG_VERSION, '2.3');
});

test('qrbill golden: encodeSwissQrPayload reproduces the SIX Table 4 example byte-for-byte', () => {
  const payload = encodeSwissQrPayload(SIX_EXAMPLE_INPUT);
  assert.equal(payload, SIX_EXAMPLE_PAYLOAD);
  // Header fixed values (IG §4.2.2): SPC / 0200 / 1, in that order.
  const lines = payload.split('\r\n');
  assert.equal(lines[0], 'SPC');
  assert.equal(lines[1], '0200');
  assert.equal(lines[2], '1');
});

test('qrbill: QRR mod-10 recursive check digit matches the SIX reference (27th digit = 7)', () => {
  assert.equal(mod10RecursiveCheckDigit('21000000000313947143000901'), 7);
  assert.ok(isValidQrrReference('210000000003139471430009017'));
  // A tampered check digit is rejected.
  assert.ok(!isValidQrrReference('210000000003139471430009010'));
  // buildQrrReference is deterministic and self-checking.
  const ref = buildQrrReference('1234');
  assert.equal(ref.length, 27);
  assert.ok(isValidQrrReference(ref));
});

test('qrbill: SCOR (ISO 11649) check digits match the standard reference RF18539007547034', () => {
  assert.equal(iso11649CheckDigits('539007547034'), '18');
  assert.ok(isValidScorReference('RF18539007547034'));
  assert.ok(!isValidScorReference('RF19539007547034'));
  const ref = buildScorReference('INV2026001');
  assert.ok(ref.startsWith('RF'));
  assert.ok(isValidScorReference(ref));
});

test('qrbill: a plain-IBAN SCOR payload emits SCOR + reference in the RmtInf slot', () => {
  const bill = buildQrBillPayload({
    ...SIX_EXAMPLE_INPUT,
    referenceType: 'SCOR',
    reference: 'RF18539007547034',
    billingInfo: null,
    ebillIdentifier: null,
  });
  assert.equal(bill.referenceType, 'SCOR');
  const lines = bill.swissQrPayload.split('\r\n');
  const tpIdx = lines.indexOf('SCOR');
  assert.equal(lines[tpIdx + 1], 'RF18539007547034');
  // With no StrdBkgInf and no AltPmt, the payload ends at EPD (status-A trailers dropped, IG §4.1.4).
  assert.equal(lines[lines.length - 1], 'EPD');
});

test('qrbill: NON reference type leaves the reference element empty', () => {
  const bill = buildQrBillPayload({ ...SIX_EXAMPLE_INPUT, referenceType: 'NON', reference: '', billingInfo: null, ebillIdentifier: null });
  const lines = bill.swissQrPayload.split('\r\n');
  const tpIdx = lines.indexOf('NON');
  assert.equal(lines[tpIdx + 1], '');
});

test('qrbill amount: no leading zeroes, dot separator, two decimals', () => {
  assert.equal(formatQrAmount(194975), '1949.75');
  assert.equal(formatQrAmount(100), '1.00');
  assert.equal(formatQrAmount(5), '0.05');
  assert.equal(formatQrAmount(100000000000 - 1), '999999999.99');
});

test('qrbill amount: the sign survives the sub-franc band, where Math.trunc yields -0', () => {
  // `Math.trunc(-50 / 100)` is `-0`, and `${-0}` is `"0"`, so every amount from -1 to -99 Rappen
  // rendered as POSITIVE. Unreachable from the QR-bill itself today (negative positions are refused
  // at ingress and `validateQrBill` floors `Amt` at 1), but `formatQrAmount` is also what renders the
  // Swico `/32/` VAT amounts, where nothing range-checks the value and a dropped sign produces
  // exactly the non-reconciling tag the reconciliation invariant exists to prevent. It becomes
  // reachable the moment discounts or credit notes land.
  assert.equal(formatQrAmount(-1), '-0.01');
  assert.equal(formatQrAmount(-50), '-0.50');
  assert.equal(formatQrAmount(-99), '-0.99');
  // The bands that already worked must keep working: the bug was confined to |amount| < 100.
  assert.equal(formatQrAmount(-100), '-1.00');
  assert.equal(formatQrAmount(-505), '-5.05');
  assert.equal(formatQrAmount(-194975), '-1949.75');
  assert.equal(formatQrAmount(0), '0.00', 'and zero stays unsigned');
});

test('qrbill currency: CHF and EUR only (M13)', () => {
  assert.ok(isQrCurrency('CHF'));
  assert.ok(isQrCurrency('EUR'));
  assert.ok(!isQrCurrency('USD'));
});

test('validateQrBill: clean input yields no issues; malformed IBAN / bad check digit / non-CHF flagged', () => {
  assert.deepEqual(validateQrBill(SIX_EXAMPLE_INPUT), []);
  const badIban = validateQrBill({ ...SIX_EXAMPLE_INPUT, iban: 'DE89370400440532013000' });
  assert.ok(badIban.some((i) => i.field === 'iban'));
  const badRef = validateQrBill({ ...SIX_EXAMPLE_INPUT, reference: '210000000003139471430009010' });
  assert.ok(badRef.some((i) => i.field === 'reference'));
  const badCcy = validateQrBill({ ...SIX_EXAMPLE_INPUT, currency: 'USD' });
  assert.ok(badCcy.some((i) => i.field === 'currency'));
});

test('validateQrBill: an incomplete structured customer address is a flagged, fixable error (M10)', () => {
  const issues = validateQrBill({
    ...SIX_EXAMPLE_INPUT,
    debtor: { name: 'Simon Muster', street: 'Musterstrasse', buildingNo: '1', postalCode: '', town: '', country: 'CH' },
  });
  assert.ok(issues.some((i) => i.field === 'debtor.postalCode'));
  assert.ok(issues.some((i) => i.field === 'debtor.town'));
});

test('Swico S1 (D31): builds the //S1/ billing-info string with the tags whose data exists', () => {
  const s1 = buildSwicoS1({
    invoiceNumber: '1234',
    invoiceDate: '2020-10-21',
    vatNumber: 'CHE-102.673.386 MWST',
    vatRatePercent: '7.7',
    paymentConditions: '0:30',
  });
  assert.equal(s1, '//S1/10/1234/11/201021/30/102673386/32/7.7/40/0:30');
  assert.equal(bpToPercentString(810), '8.1');
  assert.equal(bpToPercentString(770), '7.7');
});

test('D31: the eBill AltPmt element is emitted as eBill/B/<identifier>', () => {
  const bill = buildQrBillPayload({ ...SIX_EXAMPLE_INPUT, billingInfo: null });
  const lines = bill.swissQrPayload.split('\r\n');
  assert.equal(lines[lines.length - 1], 'eBill/B/simon.muster@example.com');
});
