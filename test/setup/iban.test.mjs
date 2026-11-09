import test from 'node:test';
import assert from 'node:assert/strict';

import { isValidIban, isQrIban, normalizeIban } from '../../dist/core/setup/iban.js';

// Compute a valid IBAN's check digits so the QR-IBAN fixture is provably correct, not guessed.
function computeIban(country, bban) {
  const rearranged = `${bban}${country}00`;
  let rem = 0;
  for (const ch of rearranged) {
    const code = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of code) rem = (rem * 10 + Number(d)) % 97;
  }
  return `${country}${String(98 - rem).padStart(2, '0')}${bban}`;
}

const CANONICAL_CH = 'CH9300762011623852957'; // the standard Swiss IBAN example, QR-IID 00762 (plain)

test('normalizeIban strips spaces and upper-cases', () => {
  assert.equal(normalizeIban('ch93 0076 2011 6238 5295 7'), CANONICAL_CH);
});

test('accepts a valid IBAN via mod-97, spaced or not', () => {
  assert.equal(isValidIban(CANONICAL_CH), true);
  assert.equal(isValidIban('CH93 0076 2011 6238 5295 7'), true);
});

test('rejects a corrupted or malformed IBAN', () => {
  assert.equal(isValidIban('CH9300762011623852958'), false); // last digit changed
  assert.equal(isValidIban('not-an-iban'), false);
  assert.equal(isValidIban(''), false);
});

test('detects a QR-IBAN by its QR-IID in 30000-31999, and only then', () => {
  const qr = computeIban('CH', '31999123000889012'); // QR-IID 31999
  const alsoQr = computeIban('CH', '30000123000889012'); // QR-IID 30000 (lower bound)
  const plain = computeIban('CH', '29999123000889012'); // QR-IID 29999 (just below)
  assert.equal(isQrIban(qr), true);
  assert.equal(isQrIban(alsoQr), true);
  assert.equal(isQrIban(plain), false);
  assert.equal(isQrIban(CANONICAL_CH), false); // valid IBAN, but QR-IID 00762
});
