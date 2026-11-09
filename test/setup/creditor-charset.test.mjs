// The CREDITOR ingress half of the QR injection guard (the blocker's last open edge).
//
// The creditor name and structured address ARE the Swiss QR Code's Creditor block. The payload is
// elements joined with CR+LF, so a CR or an LF stored in any of those fields injects an element,
// shifts everything below it by one, and leaves `Amt` empty: the guideline's OPEN form, payable with
// any amount the payer types. The far end is already closed (`validateQrBill` refuses, and
// `encodeSwissQrPayload` throws rather than join an illegal value) and so is the contact ingress
// (`createContact` / `updateContact` reject with `illegal_character`). `setCreditorProfile` was the
// remaining door: bad data could still LAND in the store and only surface later as a refused bill,
// which tells the operator at billing time about a mistake they made at setup time.
//
// One character set, defined once: SIX IG v2.3 §4.1.1, implemented by `firstDisallowedQrChar` in
// `core/sales/qrbill.ts` and imported here, never re-implemented. One error contract too: the same
// `illegal_character` shape the contact verbs already use, so the Studio has one thing to map.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorkspace, setCreditorProfile, getCompanyProfile } from '../../dist/core/setup/index.js';
import { setup } from './support.mjs';

const QR_IBAN = 'CH4431999123000889012';
const ADDRESS = { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' };

function freshCtx() {
  const { deps, ctxFor } = setup();
  return ctxFor(createWorkspace(deps, { name: 'Nomadik GmbH' }).workspaceId);
}

const profileOf = (ctx) => getCompanyProfile(ctx).profile;

test('the injection itself: a CR+LF in the creditor name is refused at the ingress', () => {
  const ctx = freshCtx();
  // The payload separator, smuggled in as data. Everything after it would become its own SPC element.
  const injected = 'Nomadik GmbH\r\nCH4431999123000889012\r\nS';
  const res = setCreditorProfile(ctx, { creditorName: injected, address: ADDRESS, qrIban: QR_IBAN });

  assert.equal(res.ok, false, `a CR+LF must never reach the store: ${JSON.stringify(res)}`);
  assert.equal(res.error, 'illegal_character');
  assert.equal(res.field, 'creditorName');
  assert.equal(res.codePoint, 'U+000D', 'the refusal names the offending code point, not just "invalid"');
  assert.match(res.reason, /4\.1\.1/, 'the refusal cites the rule it enforces');
  // The row never landed: that is the whole difference between an ingress guard and a far-end one.
  assert.equal(profileOf(ctx).creditorName, null);
  assert.equal(profileOf(ctx).creditorAddress, null);
});

test('EVERY creditor field that reaches the QR payload is checked, and named when it fails', () => {
  for (const field of ['street', 'buildingNo', 'zip', 'town', 'country']) {
    const ctx = freshCtx();
    const res = setCreditorProfile(ctx, {
      creditorName: 'Nomadik GmbH',
      address: { ...ADDRESS, [field]: `${ADDRESS[field]}\n` },
      qrIban: QR_IBAN,
    });
    assert.equal(res.ok, false, `address.${field} accepted a line feed: ${JSON.stringify(res)}`);
    assert.equal(res.error, 'illegal_character');
    assert.equal(res.field, `address.${field}`, 'the operator must be told WHICH box to fix');
    assert.equal(profileOf(ctx).creditorAddress, null, 'nothing may be stored on a refusal');
  }
});

test('control characters outside the separator are refused too, CR and LF are not special-cased', () => {
  // The control characters are written as ESCAPES, never as raw bytes. A raw NUL in this file made
  // git classify the whole thing as binary ("Bin 0 -> 5109 bytes"), so it was invisible in every
  // diff and every review, and a text-scanning check like `check:style` may skip it outright. A test
  // nobody can read in a diff is a test nobody reviews.
  for (const [label, char] of [['NUL', '\u0000'], ['DEL', '\u007F'], ['TAB', '\t'], ['C1 NEL', '\u0085']]) {
    const ctx = freshCtx();
    const res = setCreditorProfile(ctx, {
      creditorName: `Nomadik${char}GmbH`,
      address: ADDRESS,
      qrIban: QR_IBAN,
    });
    assert.equal(res.ok, false, `${label} must be refused: it is outside IG v2.3 §4.1.1`);
    assert.equal(res.error, 'illegal_character');
  }
});

test('real Swiss master data still goes in: the guard is a character SET, not an ASCII filter', () => {
  // The set is deliberately wide (Latin-1 Supplement, Latin Extended-A, plus the IG's named extras).
  // A guard that refused these would be worse than no guard: it would make the app unusable in
  // Switzerland, where umlauts and accents are ordinary, and push people to transliterate.
  const legitimate = [
    { creditorName: 'Müller & Söhne AG', town: 'Zürich' },
    { creditorName: 'Café Frères Sàrl', town: 'Neuchâtel' },
    { creditorName: 'Bäckerei Wüthrich', town: 'Grächen' },
    { creditorName: 'Łukasz Dvořák GmbH', town: 'Genève' },
    { creditorName: 'Preise in € GmbH', town: 'Delémont' },
  ];
  for (const { creditorName, town } of legitimate) {
    const ctx = freshCtx();
    const res = setCreditorProfile(ctx, { creditorName, address: { ...ADDRESS, town }, qrIban: QR_IBAN });
    assert.ok(res.ok, `${creditorName} / ${town} is legitimate Swiss master data: ${JSON.stringify(res)}`);
    assert.equal(profileOf(ctx).creditorName, creditorName);
    assert.equal(profileOf(ctx).creditorAddress.town, town);
  }
});
