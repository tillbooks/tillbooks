// A11, the ISO/IEC 18004 QR Code symbol encoder (byte mode, error correction level "M").
//
// The bar for this unit is PROOF, not assertion: a QR encoder that looks right and does not scan is
// worse than no QR at all, because it ships unpayable invoices that look fine on paper. So every
// symbol here is rasterized and read back by `jsqr`, a decoder TILL did not write, and the decoded
// BYTES are compared with the input bytes. A case the decoder cannot read is a real failure to fix,
// never a test to relax.
//
// The cited values come from the SIX "Swiss Implementation Guidelines for the QR-bill", v2.3 of
// 20.11.2023, chapter 6 (fetched 2026-07-25 from
// six-group.com/dam/download/banking-services/standardization/qr-bill/ig-qr-bill-v2.3-en.pdf), and
// from ISO/IEC 18004, which IG section 2.3 names as the symbology standard.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeQrText,
  encodeQrByteMode,
  byteModeCapacityM,
  dataCodewordsM,
  totalCodewords,
  alignmentPatternPositions,
  smallestVersionForBytes,
  QrDataTooLongError,
  QR_ERROR_CORRECTION_LEVEL,
  QR_MAX_VERSION,
} from '../../dist/core/sales/qrcode.js';
import { rasterizeMatrix, decode } from '../fixtures/qr-decode.mjs';

/** Independently published data-codeword counts per version at level M (ISO/IEC 18004 Table 13-22). */
const PUBLISHED_DATA_CODEWORDS_M = [
  16, 28, 44, 64, 86, 108, 124, 154, 182, 216, 254, 290, 334, 365, 415, 453, 507, 563, 627, 669,
  714, 782, 860, 914, 1000, 1062, 1128, 1193, 1267, 1373, 1455, 1541, 1631, 1725, 1812, 1914, 1992,
  2102, 2216, 2334,
];

test('the version table derives to the published level-M data-codeword counts for all 40 versions', () => {
  // Only two numbers per version are tabulated in the module (ECC codewords per block, block count);
  // everything else is derived from the module geometry. If the derivation were off by one anywhere,
  // this comparison against the independently published counts would catch it before a scanner does.
  for (let version = 1; version <= QR_MAX_VERSION; version += 1) {
    assert.equal(
      dataCodewordsM(version),
      PUBLISHED_DATA_CODEWORDS_M[version - 1],
      `version ${version} data codewords`,
    );
    assert.ok(totalCodewords(version) > dataCodewordsM(version));
  }
});

test('the derivation lands exactly on the guideline\'s own "version 25 / 117 x 117 / 997" statement', () => {
  // IG v2.3 section 6.2: "The maximum Swiss QR Code data content permitted is 997 characters
  // (including the element separators). The version of the QR Code resulting with error correction
  // level 'M' and binary coding is version 25 with 117 x 117 modules."
  //
  // This is the strongest cross-check available without buying ISO/IEC 18004: SIX states a figure
  // that is a pure consequence of the version table, and the table reproduces it to the byte.
  assert.equal(byteModeCapacityM(25), 997);
  assert.equal(25 * 4 + 17, 117);
  assert.equal(smallestVersionForBytes(997), 25);
  assert.equal(smallestVersionForBytes(998), 26, '998 bytes no longer fits version 25');
});

test('the error correction level is "M" and is not a parameter (IG v2.3 section 6.1)', () => {
  // IG v2.3 section 6.1: "The code generation must take place with error correction level 'M', which
  // means a redundancy or assurance of around 15%." An encoder with a level argument is an encoder
  // that can silently emit a QR-bill the banks reject, so `encodeQrByteMode` takes only data.
  assert.equal(QR_ERROR_CORRECTION_LEVEL, 'M');
  assert.equal(encodeQrByteMode.length, 1, 'the encoder takes data and nothing else');
  const symbol = encodeQrText('SPC\r\n0200\r\n1');
  assert.equal(symbol.errorCorrectionLevel, 'M');
});

test('the symbol uses the SMALLEST version that holds the data (IG v2.3 section 6.4)', () => {
  // IG v2.3 section 6.4: "All QR codes must be generated in the smallest version and only then
  // scaled to the dimensions 46 x 46 mm."
  for (const version of [1, 2, 9, 10, 15, 25, 26, 40]) {
    const capacity = byteModeCapacityM(version);
    const symbol = encodeQrByteMode(new Uint8Array(capacity).fill(0x41));
    assert.equal(symbol.version, version, `${capacity} bytes must land on version ${version}`);
    assert.equal(symbol.size, version * 4 + 17);
    if (version > 1) {
      const smaller = encodeQrByteMode(new Uint8Array(byteModeCapacityM(version - 1)).fill(0x41));
      assert.equal(smaller.version, version - 1, 'one byte fewer drops a version');
    }
  }
});

test('alignment pattern positions reproduce the ISO/IEC 18004 Table E.1 rows', () => {
  assert.deepEqual(alignmentPatternPositions(1), []);
  assert.deepEqual(alignmentPatternPositions(2), [6, 18]);
  assert.deepEqual(alignmentPatternPositions(7), [6, 22, 38]);
  assert.deepEqual(alignmentPatternPositions(25), [6, 32, 58, 84, 110]);
  // Version 32 is the row the general spacing rule does not produce; it is why the special case exists.
  assert.deepEqual(alignmentPatternPositions(32), [6, 34, 60, 86, 112, 138]);
  assert.deepEqual(alignmentPatternPositions(40), [6, 30, 58, 86, 114, 142, 170]);
});

test('finder patterns, timing patterns and the dark module sit where ISO/IEC 18004 puts them', () => {
  const symbol = encodeQrText('SPC test');
  const { modules, size } = symbol;
  // Finder pattern: dark ring, light ring, dark 3x3 core, at all three corners.
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    assert.equal(modules[r0][c0], true);
    assert.equal(modules[r0 + 1][c0 + 1], false);
    assert.equal(modules[r0 + 3][c0 + 3], true);
  }
  // Timing patterns alternate along row 6 and column 6.
  for (let i = 8; i < size - 8; i += 1) {
    assert.equal(modules[6][i], i % 2 === 0, `row 6 timing at ${i}`);
    assert.equal(modules[i][6], i % 2 === 0, `column 6 timing at ${i}`);
  }
  // The dark module is always dark (ISO/IEC 18004 section 6.9).
  assert.equal(modules[size - 8][8], true);
});

test('every version from 1 to 40 round-trips byte-identically through an independent decoder', () => {
  // This is the table's real proof: a wrong block split, a wrong Reed-Solomon remainder, a wrong
  // alignment coordinate or a wrong interleave would all survive a self-consistency check and die
  // here, at the version where the mistake bites.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz .-/';
  for (let version = 1; version <= QR_MAX_VERSION; version += 1) {
    const capacity = byteModeCapacityM(version);
    let text = '';
    for (let i = 0; i < capacity; i += 1) text += alphabet[(i * 7 + version) % alphabet.length];

    const symbol = encodeQrText(text);
    assert.equal(symbol.version, version);

    const decoded = decode(rasterizeMatrix(symbol));
    assert.notEqual(decoded, null, `version ${version} (${capacity} bytes) failed to decode`);
    assert.equal(decoded.text, text, `version ${version} decoded to different text`);
    assert.deepEqual(
      decoded.bytes,
      new TextEncoder().encode(text),
      `version ${version} decoded to different bytes`,
    );
  }
});

test('a UTF-8 payload survives as BYTES, not as a decoder-guessed string', () => {
  // The Swiss QR Code payload is UTF-8 (IG v2.3 section 4.1.1) and carries real umlauts. Byte mode
  // is the only mode that can express that; comparing the decoder's raw bytes rather than its string
  // is what makes "byte-identical" mean something.
  const text = 'Max Muster & Söhne\r\nZürich\r\nGenève\r\nRomanșă Țară €';
  const decoded = decode(rasterizeMatrix(encodeQrText(text)));
  assert.notEqual(decoded, null);
  assert.deepEqual(decoded.bytes, new TextEncoder().encode(text));
  assert.equal(decoded.text, text);
});

test('every mask pattern the encoder can pick produces a decodable symbol', () => {
  // The mask is chosen by the ISO/IEC 18004 penalty score, so which one wins depends on the data.
  // Sweeping many payloads exercises the format-information encoding for whichever masks come up,
  // and asserts that the encoder never has a mask it cannot round-trip.
  const seen = new Set();
  for (let i = 0; i < 120; i += 1) {
    const text = `SPC\r\n0200\r\n1\r\nCH${String(i).padStart(19, '0')}\r\npayload ${i}`;
    const symbol = encodeQrText(text);
    seen.add(symbol.mask);
    const decoded = decode(rasterizeMatrix(symbol));
    assert.notEqual(decoded, null, `mask ${symbol.mask} failed to decode`);
    assert.equal(decoded.text, text);
  }
  assert.ok(seen.size >= 5, `expected several masks to be exercised, saw ${[...seen].sort().join(',')}`);
});

test('data beyond version 40 is refused, never silently truncated', () => {
  const capacity = byteModeCapacityM(QR_MAX_VERSION);
  assert.doesNotThrow(() => encodeQrByteMode(new Uint8Array(capacity).fill(0x41)));
  assert.throws(
    () => encodeQrByteMode(new Uint8Array(capacity + 1).fill(0x41)),
    (error) => error instanceof QrDataTooLongError && error.capacityBytes === capacity,
  );
});

test('an empty payload still produces a valid, decodable symbol', () => {
  const symbol = encodeQrText('');
  assert.equal(symbol.version, 1);
  assert.equal(symbol.size, 21);
  const decoded = decode(rasterizeMatrix(symbol));
  assert.notEqual(decoded, null);
  assert.equal(decoded.text, '');
});
