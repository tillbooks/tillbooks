/**
 * A14 §3.1, the three reference regimes.
 *
 * The single most dangerous failure mode on the matching surface is a mistyped reference silently
 * degrading into a confident amount-only match. So the classifier is tested before anything else:
 * a 27-digit string with a bad check digit is a TYPO and says so, it never becomes free text.
 *
 * Test vectors are PRIMARY-SOURCE, not invented:
 *  - QRR: SIX "Swiss Implementation Guidelines for the QR-bill" v2.3 (20.11.2023), Annex B,
 *    Figure 21 (the mod-10 recursive check-digit matrix, page 61) and Figure 22 (the worked
 *    example, page 62): input `21 00000 00003 13947 14300 0901` yields check digit 7.
 *  - SCOR: the same document, Annex A Table 22 (page 60), example 6: `RF18539007547034`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyReference,
  mod10RecursiveCheckDigit,
  isValidQrrReference,
  isValidScorReference,
  buildQrrReference,
  buildScorReference,
  formatReference,
} from '../../dist/core/payments/reference.js';

// --- QRR (mod-10 recursive), against the SIX worked example ------------------------------------

test('QRR: the SIX Annex B worked example produces check digit 7', () => {
  assert.equal(mod10RecursiveCheckDigit('21000000000313947143000901'), 7);
  assert.equal(isValidQrrReference('210000000003139471430009017'), true);
});

test('QRR: every neighbouring check digit is rejected, so a typo cannot pass', () => {
  for (let d = 0; d <= 9; d += 1) {
    const candidate = `21000000000313947143000901${d}`;
    assert.equal(isValidQrrReference(candidate), d === 7, `check digit ${d}`);
  }
});

test('QRR: a reference that is not exactly 27 digits is not a QRR at all', () => {
  assert.equal(isValidQrrReference('2100000000031394714300090'), false);
  assert.equal(isValidQrrReference('2100000000031394714300090177'), false);
  assert.equal(isValidQrrReference('21000000000313947143000901X'), false);
});

test('QRR: buildQrrReference right-justifies the numeric seed and self-validates', () => {
  const built = buildQrrReference('R-2026-0183');
  assert.equal(built.length, 27);
  assert.equal(built.slice(0, 26), '00000000000000000020260183');
  assert.equal(isValidQrrReference(built), true);
});

// --- SCOR (ISO 11649, mod-97-10) ----------------------------------------------------------------

test('SCOR: the SIX Annex A example 6 reference validates', () => {
  assert.equal(isValidScorReference('RF18539007547034'), true);
});

test('SCOR: validation is case-insensitive and rejects a broken check pair', () => {
  assert.equal(isValidScorReference('rf18539007547034'), true);
  assert.equal(isValidScorReference('RF19539007547034'), false);
  // ISO 11649 caps the whole reference at 25 characters.
  assert.equal(isValidScorReference(`RF00${'A'.repeat(22)}`), false);
});

test('SCOR: buildScorReference self-validates and round-trips through the classifier', () => {
  const built = buildScorReference('R-2026-0183');
  assert.equal(isValidScorReference(built), true);
  assert.equal(classifyReference(built).kind, 'scor');
});

// --- The classifier: three regimes, and a typo is never free text -------------------------------

test('classify: a valid 27-digit reference is QRR, normalised without its blocking spaces', () => {
  const c = classifyReference('21 00000 00003 13947 14300 09017');
  assert.equal(c.kind, 'qrr');
  assert.equal(c.value, '210000000003139471430009017');
  assert.equal(c.valid, true);
  assert.equal(c.error, null);
});

test('classify: 27 digits with a bad check digit is a TYPO, not free text (P29)', () => {
  const c = classifyReference('210000000003139471430009013');
  assert.equal(c.kind, 'qrr');
  assert.equal(c.valid, false);
  assert.equal(c.error, 'reference_check_digit');
  // The load-bearing assertion: it must NOT be reclassified as a usable free-text ranking hint.
  assert.notEqual(c.kind, 'free_text');
});

test('classify: an RF string with bad check digits is a TYPO, not free text (P29)', () => {
  const c = classifyReference('RF19539007547034');
  assert.equal(c.kind, 'scor');
  assert.equal(c.valid, false);
  assert.equal(c.error, 'reference_check_digit');
});

test('classify: anything else is free text, accepted quietly and never an error', () => {
  for (const input of ['R-2026-0183', 'Rechnung Juli', '12345', 'RF']) {
    const c = classifyReference(input);
    assert.equal(c.kind, 'free_text', input);
    assert.equal(c.valid, true, input);
    assert.equal(c.error, null, input);
  }
});

test('classify: an absent or blank reference is the NON regime, with nothing to rank on', () => {
  for (const input of [null, undefined, '', '   ']) {
    const c = classifyReference(input);
    assert.equal(c.kind, 'none');
    assert.equal(c.value, null);
    assert.equal(c.valid, true);
  }
});

test('classify: a 26-digit numeric string is free text, never a truncated QRR', () => {
  // Silently padding it into a QRR would invent a reference the payer never quoted.
  assert.equal(classifyReference('2100000000031394714300090').kind, 'free_text');
});

// --- Display grouping (PT3) ---------------------------------------------------------------------

test('format: a QRR redisplays in blocks of 5 and a SCOR in blocks of 4', () => {
  assert.equal(formatReference('qrr', '210000000003139471430009017'), '21 00000 00003 13947 14300 09017');
  assert.equal(formatReference('scor', 'RF18539007547034'), 'RF18 5390 0754 7034');
  assert.equal(formatReference('free_text', 'Rechnung Juli'), 'Rechnung Juli');
});
