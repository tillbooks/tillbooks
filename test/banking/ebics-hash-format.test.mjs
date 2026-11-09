// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatBankHash,
  formatBankHashLines,
  BANK_HASH_BYTES_PER_LINE,
} from '../../dist/core/banking/ebics/index.js';

// A synthetic SHA-256 style value: 32 bytes 00 01 02 ... 1f, written as 64 lowercase hex characters.
const HASH_64 = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join('');

test('BANK_HASH_BYTES_PER_LINE is 8', () => {
  assert.equal(BANK_HASH_BYTES_PER_LINE, 8);
});

test('a 64-character SHA-256 hex string becomes 4 lines of 8 uppercase pairs each', () => {
  assert.equal(HASH_64.length, 64);
  const lines = formatBankHashLines(HASH_64);
  assert.deepEqual(lines, [
    '00 01 02 03 04 05 06 07',
    '08 09 0A 0B 0C 0D 0E 0F',
    '10 11 12 13 14 15 16 17',
    '18 19 1A 1B 1C 1D 1E 1F',
  ]);
  for (const line of lines) {
    assert.match(line, /^([0-9A-F]{2} ){7}[0-9A-F]{2}$/);
  }
});

test('output is uppercase even for lowercase input', () => {
  assert.deepEqual(formatBankHashLines('deadbeef'), ['DE AD BE EF']);
});

test('mixed case, colons and whitespace are tolerated', () => {
  assert.deepEqual(formatBankHashLines('AB:cd ef'), ['AB CD EF']);
  assert.deepEqual(formatBankHashLines('ab:cd:ef:01'), ['AB CD EF 01']);
  assert.deepEqual(formatBankHashLines('  ab\tcd\nef  '), ['AB CD EF']);
  assert.deepEqual(formatBankHashLines('Ab Cd\r\nEf'), ['AB CD EF']);
});

test('a colon- or space-separated hash formats the same as the compact one', () => {
  const colons = HASH_64.match(/.{2}/g)?.join(':') ?? '';
  const spaced = HASH_64.match(/.{2}/g)?.join(' ') ?? '';
  assert.deepEqual(formatBankHashLines(colons), formatBankHashLines(HASH_64));
  assert.deepEqual(formatBankHashLines(spaced), formatBankHashLines(HASH_64));
  assert.deepEqual(formatBankHashLines(HASH_64.toUpperCase()), formatBankHashLines(HASH_64));
});

test('malformed input comes back as one line, unchanged: odd length', () => {
  assert.deepEqual(formatBankHashLines('abc'), ['abc']);
  assert.deepEqual(formatBankHashLines('a'), ['a']);
});

test('malformed input comes back as one line, unchanged: non-hex', () => {
  assert.deepEqual(formatBankHashLines('zz'), ['zz']);
  assert.deepEqual(formatBankHashLines('abcg'), ['abcg']);
  assert.deepEqual(formatBankHashLines('0x12'), ['0x12']);
});

test('malformed input comes back as one line, unchanged: the empty string', () => {
  assert.deepEqual(formatBankHashLines(''), ['']);
});

test('a malformed value is returned verbatim, with its original case and separators', () => {
  assert.deepEqual(formatBankHashLines('Ab:Cd:e'), ['Ab:Cd:e']); // odd after stripping colons
  assert.deepEqual(formatBankHashLines('  zz  '), ['  zz  ']);
  // separators only: nothing left after stripping, so it stays visible as given
  assert.deepEqual(formatBankHashLines('   '), ['   ']);
  assert.deepEqual(formatBankHashLines(':'), [':']);
});

test('a custom bytesPerLine is honoured', () => {
  assert.deepEqual(formatBankHashLines('abcd', 1), ['AB', 'CD']);
  assert.deepEqual(formatBankHashLines('abcdef01', 2), ['AB CD', 'EF 01']);
  assert.deepEqual(formatBankHashLines('abcdef01', 4), ['AB CD EF 01']);
  assert.deepEqual(formatBankHashLines('abcdef01', 100), ['AB CD EF 01']);
  assert.equal(formatBankHashLines(HASH_64, 16).length, 2);
  assert.equal(formatBankHashLines(HASH_64, 32).length, 1);
});

test('an invalid bytesPerLine falls back to 8', () => {
  const expected = formatBankHashLines(HASH_64, 8);
  assert.equal(expected.length, 4);
  for (const bad of [0, 1.5, -1, -8, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(formatBankHashLines(HASH_64, bad), expected, `bytesPerLine ${bad}`);
  }
});

test('omitting bytesPerLine uses the default of 8', () => {
  assert.deepEqual(formatBankHashLines(HASH_64), formatBankHashLines(HASH_64, BANK_HASH_BYTES_PER_LINE));
  assert.deepEqual(formatBankHashLines(HASH_64, undefined), formatBankHashLines(HASH_64, 8));
});

test('formatBankHash joins the lines with a newline', () => {
  assert.equal(
    formatBankHash(HASH_64),
    '00 01 02 03 04 05 06 07\n08 09 0A 0B 0C 0D 0E 0F\n10 11 12 13 14 15 16 17\n18 19 1A 1B 1C 1D 1E 1F',
  );
  assert.equal(formatBankHash('abcd', 1), 'AB\nCD');
});

test('formatBankHash: a hash that is not a multiple of 8 bytes ends with a shorter last line', () => {
  // 10 bytes: one full line of 8, then a last line of 2
  const hex = '00112233445566778899';
  assert.equal(formatBankHash(hex), '00 11 22 33 44 55 66 77\n88 99');
  assert.deepEqual(formatBankHashLines(hex), ['00 11 22 33 44 55 66 77', '88 99']);
  // 9 bytes: a last line of exactly one pair
  assert.equal(formatBankHash('001122334455667788'), '00 11 22 33 44 55 66 77\n88');
});

test('formatBankHash: malformed input is returned unchanged, with no newline added', () => {
  assert.equal(formatBankHash('abc'), 'abc');
  assert.equal(formatBankHash('zz'), 'zz');
  assert.equal(formatBankHash(''), '');
});

test('exactly one full line has no trailing newline or space', () => {
  const out = formatBankHash('0011223344556677');
  assert.equal(out, '00 11 22 33 44 55 66 77');
  assert.ok(!out.endsWith(' ') && !out.endsWith('\n'));
});
