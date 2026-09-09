/**
 * A11, the QR Code symbol encoder (ISO/IEC 18004), byte mode, error correction level "M".
 *
 * This is the SYMBOL layer under the Swiss QR Code: it turns a byte string into the module matrix a
 * scanner reads. It knows nothing about payment parts, IBANs or the SPC payload; `swiss-qr-graphic.ts`
 * sits on top and applies the SIX-specific size, quiet zone and recognition symbol.
 *
 * WHY HAND-WRITTEN, AND WHY ONLY LEVEL "M". TILL ships as an MIT library, so a runtime dependency is a
 * licence and supply-chain liability on the money path; the ISO/IEC 18004 encoding is a closed,
 * fully-specified algorithm, so implementing it costs less than carrying a dependency forever. Level
 * "M" is not a parameter because the guideline does not offer one: "The code generation must take
 * place with error correction level 'M', which means a redundancy or assurance of around 15%" (SIX
 * Swiss Implementation Guidelines for the QR-bill, v2.3 of 20.11.2023, section 6.1). An encoder with
 * an `ecLevel` argument is an encoder that can silently emit a QR-bill Swiss banks reject, so there
 * is no argument.
 *
 * STRUCTURAL CONFORMANCE ONLY. Nothing here is SIX-certified or legally cleared, and this module must
 * never be presented as either. What it claims, and what the tests actually prove, is that the symbol
 * it emits round-trips byte-for-byte through an INDEPENDENT decoder (jsQR, a devDependency, never a
 * runtime one) and that its parameters match the cited guideline values.
 *
 * Primary sources (fetched 2026-07-25):
 *  - SIX, "Swiss Implementation Guidelines for the QR-bill", v2.3 (20.11.2023), chapter 6
 *    "Parameters for generating the Swiss QR Codes":
 *      6.1 error correction level "M"
 *      6.2 "The maximum Swiss QR Code data content permitted is 997 characters (including the element
 *          separators). The version of the QR Code resulting with error correction level 'M' and
 *          binary coding is version 25 with 117 x 117 modules."
 *      6.4 "All QR codes must be generated in the smallest version and only then scaled to the
 *          dimensions 46 x 46 mm."
 *    https://www.six-group.com/dam/download/banking-services/standardization/qr-bill/ig-qr-bill-v2.3-en.pdf
 *  - ISO/IEC 18004 (QR Code bar code symbology specification), as referenced by IG section 2.3
 *    ("The QR Code is a two-dimensional barcode, in accordance with ISO 18004"). The standard itself
 *    is paywalled at iso.org; the parameters it fixes (the GF(256) primitive polynomial 0x11D, the
 *    BCH format/version codes, the eight data-mask patterns and the four penalty rules) are the same
 *    values the IG's own worked numbers confirm, and `qrcode.test.mjs` re-derives the version table
 *    from first principles and checks it lands exactly on the IG's "version 25 / 997" statement.
 */

/** The only error correction level the QR-bill permits (IG v2.3 section 6.1). Not a parameter. */
export const QR_ERROR_CORRECTION_LEVEL = 'M' as const;

/** ISO/IEC 18004 defines versions 1 to 40; a version's side is `17 + 4 * version` modules. */
export const QR_MIN_VERSION = 1;
export const QR_MAX_VERSION = 40;

/** The encoded symbol: a square matrix of modules, plus the parameters a conformance test asserts. */
export interface QrSymbol {
  /** ISO/IEC 18004 symbol version, 1 to 40. The SMALLEST version the data fits (IG section 6.4). */
  readonly version: number;
  /** Side length in modules, `17 + 4 * version`. */
  readonly size: number;
  /** `modules[row][column]`, true = dark. Row 0 / column 0 is the top-left corner. */
  readonly modules: readonly (readonly boolean[])[];
  /** Always `'M'`: the guideline fixes it (IG section 6.1). */
  readonly errorCorrectionLevel: typeof QR_ERROR_CORRECTION_LEVEL;
  /** The data mask pattern (0 to 7) chosen by the ISO/IEC 18004 penalty score. */
  readonly mask: number;
}

/** Raised when the data exceeds what a version-40 level-M byte-mode symbol can hold. */
export class QrDataTooLongError extends Error {
  constructor(
    readonly byteLength: number,
    readonly capacityBytes: number,
  ) {
    super(
      `qr_data_too_long: ${byteLength} bytes exceeds the ${capacityBytes}-byte capacity of a version-40 level-M byte-mode QR Code`,
    );
    this.name = 'QrDataTooLongError';
  }
}

// --- The version tables ------------------------------------------------------------------------
//
// ISO/IEC 18004 fixes, per (version, error correction level), how many error correction codewords
// each block carries and how many blocks the message is split into. EVERYTHING ELSE is derived here
// rather than tabulated, because a second hand-copied table is a second place to make a typo:
// the total codeword count comes from the module geometry, and the block sizes come from dividing
// the data codewords across the blocks. `qrcode.test.mjs` checks the derivation against the
// independently published per-version data-codeword counts for all 40 versions.

/** ECC codewords per block, level M, indexed by version (index 0 unused). ISO/IEC 18004 Table 13-22. */
const ECC_CODEWORDS_PER_BLOCK_M: readonly number[] = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
  26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];

/** Number of error correction blocks, level M, indexed by version. ISO/IEC 18004 Table 13-22. */
const NUM_BLOCKS_M: readonly number[] = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
  17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];

/**
 * The number of data + error correction modules a version carries, before codeword packing: the full
 * square minus the function patterns (finders + separators + timing + format/version reservations +
 * alignment patterns). ISO/IEC 18004 Annex; this is the standard closed form.
 */
export function rawDataModuleCount(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Total codewords (data + ECC) a version holds. The leftover bits are the remainder bits. */
export function totalCodewords(version: number): number {
  return Math.floor(rawDataModuleCount(version) / 8);
}

/** Data codewords available at level M for a version. */
export function dataCodewordsM(version: number): number {
  return totalCodewords(version) - NUM_BLOCKS_M[version]! * ECC_CODEWORDS_PER_BLOCK_M[version]!;
}

/**
 * The byte-mode payload capacity of a version at level M: the data codewords minus the 4-bit mode
 * indicator and the character count indicator (8 bits up to version 9, 16 bits from version 10).
 */
export function byteModeCapacityM(version: number): number {
  const countBits = version <= 9 ? 8 : 16;
  return Math.floor((dataCodewordsM(version) * 8 - 4 - countBits) / 8);
}

/** The smallest version whose level-M byte-mode capacity holds `byteLength`, or null if none does. */
export function smallestVersionForBytes(byteLength: number): number | null {
  for (let version = QR_MIN_VERSION; version <= QR_MAX_VERSION; version += 1) {
    if (byteModeCapacityM(version) >= byteLength) return version;
  }
  return null;
}

/**
 * Alignment pattern centre coordinates for a version (empty for version 1). ISO/IEC 18004 Table E.1;
 * this is the standard closed form that reproduces that table row for row, including the version-32
 * special case the spacing rule does not otherwise produce.
 */
export function alignmentPatternPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let pos = version * 4 + 10; positions.length < count; pos -= step) {
    positions.splice(1, 0, pos);
  }
  return positions;
}

// --- GF(256) Reed-Solomon ----------------------------------------------------------------------
//
// ISO/IEC 18004 section 6.5.1: the field is GF(256) with primitive polynomial
// x^8 + x^4 + x^3 + x^2 + 1 (0x11D), the same field QR Code has always used.

const GF_PRIMITIVE = 0x11d;

/** Multiply two GF(256) elements (russian-peasant, so no log/antilog tables to get out of step). */
function gfMultiply(a: number, b: number): number {
  let result = 0;
  for (let i = 7; i >= 0; i -= 1) {
    result = (result << 1) ^ ((result >>> 7) * GF_PRIMITIVE);
    result ^= ((b >>> i) & 1) * a;
  }
  return result & 0xff;
}

/** The Reed-Solomon generator polynomial of `degree`, as coefficients from the highest term down. */
function reedSolomonGenerator(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < degree) result[j] = result[j]! ^ result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** The Reed-Solomon remainder (the ECC codewords) of a data block under a generator polynomial. */
function reedSolomonRemainder(data: Uint8Array, generator: Uint8Array): Uint8Array {
  const result = new Uint8Array(generator.length);
  for (const byte of data) {
    const factor = byte ^ result[0]!;
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i += 1) {
      result[i] = result[i]! ^ gfMultiply(generator[i]!, factor);
    }
  }
  return result;
}

// --- Bit buffer --------------------------------------------------------------------------------

/** An append-only bit stream, MSB first, which is the order ISO/IEC 18004 packs codewords in. */
class BitBuffer {
  private readonly bits: number[] = [];

  append(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) {
      this.bits.push((value >>> i) & 1);
    }
  }

  get length(): number {
    return this.bits.length;
  }

  /** Pack to codewords, zero-padding the final partial byte. */
  toCodewords(): Uint8Array {
    const bytes = new Uint8Array(Math.ceil(this.bits.length / 8));
    for (let i = 0; i < this.bits.length; i += 1) {
      bytes[i >>> 3]! |= this.bits[i]! << (7 - (i & 7));
    }
    return bytes;
  }
}

// --- Data encoding -----------------------------------------------------------------------------

/**
 * Build the data codeword stream for byte mode: mode indicator `0100`, the character count, the
 * bytes, a terminator of up to four zero bits, zero-padding to a codeword boundary, then the
 * alternating pad codewords 0xEC / 0x11 (ISO/IEC 18004 section 6.4.10).
 */
function buildDataCodewords(data: Uint8Array, version: number): Uint8Array {
  const capacityBits = dataCodewordsM(version) * 8;
  const buffer = new BitBuffer();
  buffer.append(0b0100, 4);
  buffer.append(data.length, version <= 9 ? 8 : 16);
  for (const byte of data) buffer.append(byte, 8);

  buffer.append(0, Math.min(4, capacityBits - buffer.length));
  buffer.append(0, (8 - (buffer.length % 8)) % 8);

  const codewords = Array.from(buffer.toCodewords());
  for (let pad = 0xec; codewords.length < capacityBits / 8; pad ^= 0xec ^ 0x11) {
    codewords.push(pad);
  }
  return Uint8Array.from(codewords);
}

/**
 * Split the data into blocks, compute each block's ECC, and interleave both (ISO/IEC 18004
 * section 6.6). The short blocks come first; the extra byte of each long block is appended after
 * every short block's last byte, which is what the interleave step expects.
 */
function addEccAndInterleave(dataCodewords: Uint8Array, version: number): Uint8Array {
  const numBlocks = NUM_BLOCKS_M[version]!;
  const eccPerBlock = ECC_CODEWORDS_PER_BLOCK_M[version]!;
  const total = totalCodewords(version);
  const numShortBlocks = numBlocks - (total % numBlocks);
  const shortBlockDataLen = Math.floor(total / numBlocks) - eccPerBlock;

  const generator = reedSolomonGenerator(eccPerBlock);
  const blocks: { data: Uint8Array; ecc: Uint8Array }[] = [];
  let offset = 0;
  for (let i = 0; i < numBlocks; i += 1) {
    const len = shortBlockDataLen + (i < numShortBlocks ? 0 : 1);
    const blockData = dataCodewords.subarray(offset, offset + len);
    offset += len;
    blocks.push({ data: blockData, ecc: reedSolomonRemainder(blockData, generator) });
  }

  const result = new Uint8Array(total);
  let out = 0;
  const maxDataLen = shortBlockDataLen + 1;
  for (let i = 0; i < maxDataLen; i += 1) {
    for (const block of blocks) {
      if (i < block.data.length) result[out++] = block.data[i]!;
    }
  }
  for (let i = 0; i < eccPerBlock; i += 1) {
    for (const block of blocks) result[out++] = block.ecc[i]!;
  }
  return result;
}

// --- Matrix construction -------------------------------------------------------------------------

/** A mutable matrix under construction: module colours plus which cells are function patterns. */
class Matrix {
  readonly size: number;
  readonly modules: boolean[][];
  /** True where a function pattern (or a format/version reservation) lives, so data skips it. */
  readonly reserved: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  set(row: number, col: number, dark: boolean, isFunction: boolean): void {
    this.modules[row]![col] = dark;
    if (isFunction) this.reserved[row]![col] = true;
  }
}

/** The 7x7 finder pattern plus its separator, anchored at a corner. ISO/IEC 18004 section 6.3.3. */
function drawFinder(matrix: Matrix, centerRow: number, centerCol: number): void {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const row = centerRow + dy;
      const col = centerCol + dx;
      if (row < 0 || row >= matrix.size || col < 0 || col >= matrix.size) continue;
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      matrix.set(row, col, distance !== 2 && distance !== 4, true);
    }
  }
}

/** The 5x5 alignment pattern centred on a coordinate pair. ISO/IEC 18004 section 6.3.6. */
function drawAlignment(matrix: Matrix, centerRow: number, centerCol: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      matrix.set(centerRow + dy, centerCol + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1, true);
    }
  }
}

/** Reserve the format information areas (they are filled once the mask is known). */
function reserveFormatAreas(matrix: Matrix): void {
  for (let i = 0; i <= 8; i += 1) {
    // Row 8 / column 8 cross the timing patterns at index 6, and those two modules belong to the
    // timing pattern, not to the format information. Reserving them here without skipping would
    // blank two timing modules and hand every scanner a broken grid reference.
    if (i === 6) continue;
    matrix.set(8, i, false, true);
    matrix.set(i, 8, false, true);
  }
  for (let i = 0; i < 8; i += 1) {
    matrix.set(8, matrix.size - 1 - i, false, true);
    matrix.set(matrix.size - 1 - i, 8, false, true);
  }
  // The dark module: always dark, at (4 * version + 9, 8). ISO/IEC 18004 section 6.9.
  matrix.set(matrix.size - 8, 8, true, true);
}

/** BCH(18,6) version information, drawn twice for versions 7 and up. ISO/IEC 18004 section 6.10. */
function drawVersionInfo(matrix: Matrix): void {
  if (matrix.version < 7) return;
  let remainder = matrix.version;
  for (let i = 0; i < 12; i += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  }
  const bits = (matrix.version << 12) | remainder;
  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >>> i) & 1) !== 0;
    const a = matrix.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    matrix.set(a, b, dark, true);
    matrix.set(b, a, dark, true);
  }
}

/** BCH(15,5) format information for level M and a mask. ISO/IEC 18004 section 6.9 / Table 25. */
function drawFormatInfo(matrix: Matrix, mask: number): void {
  // Level M's two-bit indicator is 00 (ISO/IEC 18004 Table 12), so `data` is just the mask number.
  const data = mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  }
  const bits = ((data << 10) | remainder) ^ 0x5412;
  const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;

  // First copy, wrapped around the top-left finder: bits 0 to 8 run DOWN column 8, then bits 9 to 14
  // run LEFT along row 8. Both skip index 6, the timing crossing.
  for (let i = 0; i <= 5; i += 1) matrix.set(i, 8, bit(i), true);
  matrix.set(7, 8, bit(6), true);
  matrix.set(8, 8, bit(7), true);
  matrix.set(8, 7, bit(8), true);
  for (let i = 9; i < 15; i += 1) matrix.set(8, 14 - i, bit(i), true);

  // Second copy, split between the top-right and bottom-left finders: bits 0 to 7 along row 8 from
  // the right edge inward, bits 8 to 14 down column 8 to the bottom edge.
  for (let i = 0; i < 8; i += 1) matrix.set(8, matrix.size - 1 - i, bit(i), true);
  for (let i = 8; i < 15; i += 1) matrix.set(matrix.size - 15 + i, 8, bit(i), true);
  matrix.set(matrix.size - 8, 8, true, true);
}

/** All function patterns except the format bits (which need the mask). ISO/IEC 18004 section 6.3. */
function drawFunctionPatterns(matrix: Matrix): void {
  // Timing patterns: alternating modules on row 6 and column 6.
  for (let i = 0; i < matrix.size; i += 1) {
    matrix.set(6, i, i % 2 === 0, true);
    matrix.set(i, 6, i % 2 === 0, true);
  }
  drawFinder(matrix, 3, 3);
  drawFinder(matrix, 3, matrix.size - 4);
  drawFinder(matrix, matrix.size - 4, 3);

  const positions = alignmentPatternPositions(matrix.version);
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = 0; j < positions.length; j += 1) {
      // The three finder corners have no alignment pattern.
      const isFinderCorner =
        (i === 0 && j === 0) ||
        (i === 0 && j === positions.length - 1) ||
        (i === positions.length - 1 && j === 0);
      if (!isFinderCorner) drawAlignment(matrix, positions[i]!, positions[j]!);
    }
  }

  reserveFormatAreas(matrix);
  drawVersionInfo(matrix);
}

/**
 * Place the interleaved codewords in the two-module-wide upward/downward zigzag columns, right to
 * left, skipping the vertical timing column and every reserved module (ISO/IEC 18004 section 6.7.3).
 */
function drawCodewords(matrix: Matrix, codewords: Uint8Array): void {
  let bitIndex = 0;
  for (let right = matrix.size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern: the pair of columns steps over it.
    const rightCol = right <= 6 ? right - 1 : right;
    const upward = ((matrix.size - 1 - right) & 2) === 0;
    for (let vert = 0; vert < matrix.size; vert += 1) {
      const row = upward ? matrix.size - 1 - vert : vert;
      for (let j = 0; j < 2; j += 1) {
        const col = rightCol - j;
        if (matrix.reserved[row]![col]) continue;
        let dark = false;
        if (bitIndex < codewords.length * 8) {
          dark = ((codewords[bitIndex >>> 3]! >>> (7 - (bitIndex & 7))) & 1) !== 0;
        }
        bitIndex += 1;
        matrix.modules[row]![col] = dark;
      }
    }
  }
}

/** The eight data mask conditions. ISO/IEC 18004 Table 10. `row` is y, `col` is x. */
function maskCondition(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7: return ((((row + col) % 2) + ((row * col) % 3)) % 2) === 0;
    default: throw new Error(`unknown_mask_${mask}`);
  }
}

/** XOR the mask over every non-function module. Applying it twice restores the matrix. */
function applyMask(matrix: Matrix, mask: number): void {
  for (let row = 0; row < matrix.size; row += 1) {
    for (let col = 0; col < matrix.size; col += 1) {
      if (matrix.reserved[row]![col]) continue;
      if (maskCondition(mask, row, col)) matrix.modules[row]![col] = !matrix.modules[row]![col];
    }
  }
}

/** The 1:1:3:1:1 finder-like sequence, with its four-module light margin. ISO/IEC 18004 section 8.8.2. */
const FINDER_LIKE = [true, false, true, true, true, false, true, false, false, false, false];

/** Count occurrences of the finder-like sequence (and its mirror) in a line of modules. */
function countFinderLike(line: boolean[]): number {
  let count = 0;
  for (let i = 0; i + FINDER_LIKE.length <= line.length; i += 1) {
    let forward = true;
    let backward = true;
    for (let j = 0; j < FINDER_LIKE.length; j += 1) {
      if (line[i + j] !== FINDER_LIKE[j]) forward = false;
      if (line[i + j] !== FINDER_LIKE[FINDER_LIKE.length - 1 - j]) backward = false;
      if (!forward && !backward) break;
    }
    if (forward) count += 1;
    if (backward) count += 1;
  }
  return count;
}

/**
 * The four penalty rules (ISO/IEC 18004 section 8.8.2, N1=3, N2=3, N3=40, N4=10). The mask with the
 * lowest total wins. Any mask decodes correctly, so this is a legibility choice, not a correctness
 * one: a scanner reads the mask number out of the format information either way.
 */
function penaltyScore(matrix: Matrix): number {
  const size = matrix.size;
  let score = 0;

  // Rule 1: runs of five or more same-coloured modules in a row or column.
  const scoreRuns = (line: boolean[]): void => {
    let runLength = 1;
    for (let i = 1; i <= line.length; i += 1) {
      if (i < line.length && line[i] === line[i - 1]) {
        runLength += 1;
        continue;
      }
      if (runLength >= 5) score += 3 + (runLength - 5);
      runLength = 1;
    }
  };
  for (let row = 0; row < size; row += 1) scoreRuns(matrix.modules[row]!);
  for (let col = 0; col < size; col += 1) {
    scoreRuns(matrix.modules.map((r) => r[col]!));
  }

  // Rule 2: every 2x2 block of one colour.
  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const value = matrix.modules[row]![col];
      if (
        value === matrix.modules[row]![col + 1] &&
        value === matrix.modules[row + 1]![col] &&
        value === matrix.modules[row + 1]![col + 1]
      ) {
        score += 3;
      }
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns with a four-module light margin.
  for (let row = 0; row < size; row += 1) score += 40 * countFinderLike(matrix.modules[row]!);
  for (let col = 0; col < size; col += 1) {
    score += 40 * countFinderLike(matrix.modules.map((r) => r[col]!));
  }

  // Rule 4: deviation of the dark-module proportion from 50%, in 5% steps.
  let dark = 0;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) if (matrix.modules[row]![col]) dark += 1;
  }
  const total = size * size;
  const deviation = Math.abs(dark * 20 - total * 10); // |dark/total - 0.5| * total * 20
  score += Math.floor(deviation / total) * 10;

  return score;
}

// --- The public encoder --------------------------------------------------------------------------

/**
 * Encode bytes as a QR Code symbol in BYTE mode at error correction level "M", in the smallest
 * version that holds them (IG v2.3 section 6.4: "All QR codes must be generated in the smallest
 * version and only then scaled").
 *
 * Byte mode is the right (and only correct) mode here: the Swiss QR Code payload is UTF-8 text
 * (IG section 4.1.1, "The message and the data in the Swiss QR Code must be UTF-8 encoded"), and its
 * coding-type element is the fixed value `1`, "UTF-8 restricted to the Latin character set". Numeric
 * or alphanumeric mode would be denser but cannot express a UTF-8 byte stream.
 */
export function encodeQrByteMode(data: Uint8Array): QrSymbol {
  const version = smallestVersionForBytes(data.length);
  if (version === null) {
    throw new QrDataTooLongError(data.length, byteModeCapacityM(QR_MAX_VERSION));
  }

  const codewords = addEccAndInterleave(buildDataCodewords(data, version), version);

  const matrix = new Matrix(version);
  drawFunctionPatterns(matrix);
  drawCodewords(matrix, codewords);

  // The mask is chosen by penalty score over the FULL symbol, format bits included, so each
  // candidate is scored as the scanner will see it.
  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    applyMask(matrix, mask);
    drawFormatInfo(matrix, mask);
    const score = penaltyScore(matrix);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
    }
    applyMask(matrix, mask); // XOR is its own inverse: restore before trying the next mask.
  }
  applyMask(matrix, bestMask);
  drawFormatInfo(matrix, bestMask);

  return {
    version,
    size: matrix.size,
    modules: matrix.modules.map((row) => row.slice()),
    errorCorrectionLevel: QR_ERROR_CORRECTION_LEVEL,
    mask: bestMask,
  };
}

/** Encode a UTF-8 string as a byte-mode level-M QR Code symbol. */
export function encodeQrText(text: string): QrSymbol {
  return encodeQrByteMode(new TextEncoder().encode(text));
}
