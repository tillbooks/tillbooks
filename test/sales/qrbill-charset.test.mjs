// A11 BLOCKER: the Swiss QR Code permitted character set (SIX IG v2.3 §4.1.1) and control-character
// injection into the SPC payload.
//
// The defect these tests were written against: `encodeSwissQrPayload` joined raw field values with
// CR+LF, and `validateQrBill` checked lengths, IBAN, reference and currency but never the permitted
// character set. A CR+LF anywhere in master data therefore INJECTED an element: the 31-element
// payload became 32+, every element below the injection shifted by one, and `Amt` came out EMPTY on
// a real receivable. An empty `Amt` is the IG's OPEN form, payable with any amount the payer types.
//
// Primary source, fetched 2026-07-25 from
// https://www.six-group.com/dam/download/banking-services/standardization/qr-bill/ig-qr-bill-v2.3-en.pdf
// §4.1.1 "Character set": "The following subset of characters from the Unicode UTF-8 character set is
// allowed in the Swiss QR Code in accordance with the Swiss standard: Basic Latin (Unicode codepoints
// U+0020-U+007E), Latin1 Supplement (Unicode codepoints U+00A0-U+00FF), Latin Extended A (Unicode
// codepoints U+0100-U+017F). As well as the following additional characters: U+0218, U+0219, U+021A,
// U+021B, U+20AC (EURO SIGN)."
//
// Every control character is outside that set by construction: Basic Latin starts at U+0020, so
// U+0000-U+001F (CR, LF, TAB, NUL) and U+007F (DEL) are excluded, and Latin-1 Supplement starts at
// U+00A0, so the C1 block U+0080-U+009F (including U+0085 NEL) is excluded too.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace, setCreditorProfile } from '../../dist/core/setup/index.js';
import { seedTaxCodes } from '../../dist/core/vat/index.js';
import {
  createDocument,
  createContact,
  updateContact,
  issueInvoice,
  buildQrBill,
  validateQrBill,
  encodeSwissQrPayload,
  buildQrrReference,
  isQrPermittedCodePoint,
  firstDisallowedQrChar,
} from '../../dist/core/sales/index.js';

const AT = '2026-07-16T00:00:00.000Z';

const CREDITOR = {
  creditorName: 'Nomadik GmbH',
  address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
  qrIban: 'CH4431999123000889012',
};

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Nomadik GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  seedTaxCodes(ctx);
  store.db
    .prepare("UPDATE workspace SET vat_method = 'effektiv', vat_accounting = 'soll', mwst_no = 'CHE-102.673.386 MWST' WHERE id = ?")
    .run(workspaceId);
  setCreditorProfile(ctx, CREDITOR);
  const contactId = store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, address_street, address_house_no, address_zip, address_city, address_country, email, default_currency, payment_terms_days, created_at)
       VALUES ('ct_1', ?, 'customer', 'Muster AG', 'Musterstrasse', '5', '3000', 'Bern', 'CH', 'billing@muster.example', 'CHF', 30, ?) RETURNING id`,
    )
    .get(workspaceId, AT).id;
  return { ctx, store, workspaceId, contactId };
}

const VALID_QR_INPUT = {
  iban: 'CH4431999123000889012',
  creditor: { name: 'Nomadik GmbH', street: 'Bahnhofstrasse', buildingNo: '1', postalCode: '8000', town: 'Zürich', country: 'CH' },
  amountMinor: 108100,
  currency: 'CHF',
  debtor: { name: 'Muster AG', street: 'Musterstrasse', buildingNo: '5', postalCode: '3000', town: 'Bern', country: 'CH' },
  referenceType: 'QRR',
  reference: buildQrrReference('R-2026-0001'),
  unstructuredMessage: 'Rechnung R-2026-0001',
  billingInfo: null,
  ebillIdentifier: null,
};

// --- The predicate, straight against §4.1.1 -----------------------------------------------------

test('§4.1.1: the permitted set is exactly Basic Latin + Latin-1 Supplement + Latin Extended A + the five named extras', () => {
  for (const cp of [0x0020, 0x007e, 0x00a0, 0x00ff, 0x0100, 0x017f]) {
    assert.equal(isQrPermittedCodePoint(cp), true, `U+${cp.toString(16)} is inside a permitted range`);
  }
  for (const cp of [0x0218, 0x0219, 0x021a, 0x021b, 0x20ac]) {
    assert.equal(isQrPermittedCodePoint(cp), true, `U+${cp.toString(16)} is a named extra`);
  }
  for (const cp of [0x0000, 0x001f, 0x007f, 0x0080, 0x009f, 0x0180, 0x0217, 0x021c, 0x20ab, 0x20ad, 0x1f680]) {
    assert.equal(isQrPermittedCodePoint(cp), false, `U+${cp.toString(16)} is outside the permitted set`);
  }
});

test('§4.1.1: EVERY control character is rejected, not just CR and LF', () => {
  const controls = ['\r', '\n', '\t', '\u0000', '\u0001', '\u001f', '\u007f', '\u0085', '\u009f'];
  for (const ch of controls) {
    const found = firstDisallowedQrChar(`Acme${ch}AG`);
    assert.notEqual(found, null, `U+${ch.codePointAt(0).toString(16)} must be flagged`);
    assert.equal(found.char, ch);
    assert.equal(found.index, 4);
  }
});

test('§4.1.1: legitimate Swiss and European master data passes untouched', () => {
  const clean = ['Zürich', 'Genève', "Rue de l'Eglise 4", 'Küsnacht (ZH)', 'Łódź', 'Ōtsu', 'Șerban Țăndărei', '€ 10.00'];
  for (const value of clean) {
    assert.equal(firstDisallowedQrChar(value), null, `${value} is inside §4.1.1`);
  }
});

// --- validateQrBill now enforces it -------------------------------------------------------------

test('BLOCKER: validateQrBill REJECTS a CR+LF hidden in the creditor town', () => {
  const injected = {
    ...VALID_QR_INPUT,
    creditor: { ...VALID_QR_INPUT.creditor, town: 'Zürich\r\nCH' },
  };
  const issues = validateQrBill(injected);
  const hit = issues.find((i) => i.field === 'creditor.town');
  assert.ok(hit, `creditor.town must be flagged, got ${JSON.stringify(issues)}`);
  assert.equal(hit.reason, 'illegal_character');
});

test('BLOCKER: validateQrBill rejects out-of-charset characters in EVERY payload-bound field', () => {
  const cases = [
    ['creditor.name', { creditor: { ...VALID_QR_INPUT.creditor, name: 'Ноmе Инк \u{1F680}' } }],
    ['creditor.street', { creditor: { ...VALID_QR_INPUT.creditor, street: 'Bahnhof\u0000strasse' } }],
    ['creditor.buildingNo', { creditor: { ...VALID_QR_INPUT.creditor, buildingNo: '1\r' } }],
    ['creditor.postalCode', { creditor: { ...VALID_QR_INPUT.creditor, postalCode: '80\n00' } }],
    ['creditor.country', { creditor: { ...VALID_QR_INPUT.creditor, country: 'C\u0085H' } }],
    ['debtor.name', { debtor: { ...VALID_QR_INPUT.debtor, name: 'Muster \u{1F680} AG' } }],
    ['debtor.town', { debtor: { ...VALID_QR_INPUT.debtor, town: 'Bern\r\nCH' } }],
    // The IBAN is checked AFTER whitespace normalisation, because that is what the encoder emits.
    ['iban', { iban: 'CH4431999123000889012' }],
    ['unstructuredMessage', { unstructuredMessage: 'Rechnung\r\nR-2026-0001' }],
    ['billingInfo', { billingInfo: '//S1/10/R\r\n-2026-0001' }],
    ['ebillIdentifier', { ebillIdentifier: 'billing@muster.example\r\nEPD' }],
  ];
  for (const [field, patch] of cases) {
    const issues = validateQrBill({ ...VALID_QR_INPUT, ...patch });
    const hit = issues.find((i) => i.field === field && i.reason === 'illegal_character');
    assert.ok(hit, `${field} must be flagged illegal_character, got ${JSON.stringify(issues)}`);
  }
});

test('BLOCKER: a clean input still validates clean (the charset check adds no false positive)', () => {
  assert.deepEqual(validateQrBill(VALID_QR_INPUT), []);
});

// --- The encoder itself cannot emit an injected element -----------------------------------------

test('BLOCKER: encodeSwissQrPayload THROWS rather than emitting an injected element', () => {
  const injected = {
    ...VALID_QR_INPUT,
    creditor: { ...VALID_QR_INPUT.creditor, town: 'Zürich\r\nCH' },
  };
  assert.throws(
    () => encodeSwissQrPayload(injected),
    (e) => {
      assert.match(e.message, /illegal_character/);
      return true;
    },
    'the encoder is the last line of defence: an injected element must be impossible to emit',
  );
});

test('BLOCKER: a clean payload still encodes to exactly 31 elements with a non-empty Amt', () => {
  const elements = encodeSwissQrPayload(VALID_QR_INPUT).split('\r\n');
  assert.equal(elements.length, 31, 'the IG Table 8 element count, no trailing status-A elements');
  assert.equal(elements[18], '1081.00', 'Amt carries the real gross, never an empty (open) amount');
  assert.equal(elements[19], 'CHF');
  assert.equal(elements[27], 'QRR');
});

// --- End to end: bad data already in the store can never produce a payable open QR ---------------

test('BLOCKER: a CR+LF in the STORED creditor town makes buildQrBill refuse, not emit an open Amt', () => {
  const { ctx, store, workspaceId, contactId } = setup();
  // Master data that landed before the ingress guard existed (the exact critic scenario).
  const address = JSON.parse(
    store.db.prepare('SELECT creditor_address AS a FROM workspace WHERE id = ?').get(workspaceId).a,
  );
  store.db
    .prepare('UPDATE workspace SET creditor_address = ? WHERE id = ?')
    .run(JSON.stringify({ ...address, town: 'Zürich\r\nCH' }), workspaceId);

  const doc = createDocument(ctx, {
    type: 'invoice',
    contactId,
    currency: 'CHF',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
  });
  const issued = issueInvoice(ctx, { invoiceId: doc.document.id });
  assert.ok(issued.ok, JSON.stringify(issued));

  const qr = buildQrBill(ctx, doc.document.id);
  assert.equal(qr.ok, false, 'an injected creditor town must NEVER yield a payload');
  assert.equal(qr.error, 'needs_creditor_address');
  assert.equal(qr.reason, 'illegal_character');
});

// --- Ingress: the bad data never lands in the store in the first place ---------------------------

test('BLOCKER ingress: createContact rejects a CR+LF in the name', () => {
  const { ctx, store } = setup();
  const res = createContact(ctx, { partyRole: 'customer', name: 'Muster\r\nAG' });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, 'illegal_character');
  assert.equal(res.field, 'name');
  const count = store.db.prepare("SELECT COUNT(*) AS n FROM contact WHERE name LIKE 'Muster%AG'").get().n;
  assert.equal(count, 1, 'only the clean fixture contact exists: the injected row never landed');
});

test('BLOCKER ingress: createContact rejects out-of-charset characters in every QR-bound field', () => {
  const { ctx } = setup();
  const cases = [
    ['name', { name: 'Ноmе Инк \u{1F680}' }],
    ['address.street', { name: 'Ok AG', address: { street: 'Haupt\r\nstrasse' } }],
    ['address.houseNo', { name: 'Ok AG', address: { houseNo: '1\u007f' } }],
    ['address.zip', { name: 'Ok AG', address: { zip: '80\t00' } }],
    ['address.city', { name: 'Ok AG', address: { city: 'Zürich\r\nCH' } }],
    ['address.country', { name: 'Ok AG', address: { country: 'C\rH' } }],
    ['email', { name: 'Ok AG', email: 'a@b.example\r\nEPD' }],
  ];
  for (const [field, patch] of cases) {
    const res = createContact(ctx, { partyRole: 'customer', ...patch });
    assert.equal(res.ok, false, `${field}: ${JSON.stringify(res)}`);
    assert.equal(res.error, 'illegal_character');
    assert.equal(res.field, field);
  }
});

test('BLOCKER ingress: updateContact cannot smuggle a control character in after the fact', () => {
  const { ctx, store } = setup();
  const res = updateContact(ctx, { contactId: 'ct_1', patch: { address: { city: 'Bern\r\nCH' } } });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, 'illegal_character');
  assert.equal(res.field, 'address.city');
  assert.equal(store.db.prepare('SELECT address_city AS c FROM contact WHERE id = ?').get('ct_1').c, 'Bern');
});

test('BLOCKER ingress: legitimate umlaut master data still creates cleanly', () => {
  const { ctx } = setup();
  const res = createContact(ctx, {
    partyRole: 'customer',
    name: 'Müller & Söhne AG',
    address: { street: "Rue de l'Eglise", houseNo: '12b', zip: '1200', city: 'Genève', country: 'CH' },
    email: 'buchhaltung@mueller.example',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.contact.name, 'Müller & Söhne AG');
});
