/**
 * A11, the SCANNABLE Swiss QR Code graphic: the SPC payload rendered as a real QR symbol at the
 * printed size, quiet zone and recognition symbol the guideline mandates.
 *
 * `qrbill.ts` produces the payload string; `qrcode.ts` turns bytes into an ISO/IEC 18004 symbol; this
 * module is the SIX-specific layer between them and a page. It is the piece whose absence made every
 * TILL invoice unpayable by scan: a QR-bill without a code is not a QR-bill.
 *
 * NOT SIX-CERTIFIED, NOT LEGALLY CLEARED, and it must never be described as either. The honest claim,
 * and the one the tests actually establish, is STRUCTURAL CONFORMANCE against the cited guideline
 * values plus a byte-identical round trip through an independent decoder. Certification is a process
 * with SIX, not a property of this file.
 *
 * Every measurement below is fetched, not recalled. Primary sources (fetched 2026-07-25):
 *
 *  - SIX, "Swiss Implementation Guidelines for the QR-bill", v2.3 (20.11.2023), chapter 6:
 *      6.1 "The code generation must take place with error correction level 'M', which means a
 *          redundancy or assurance of around 15%."
 *      6.2 "The maximum Swiss QR Code data content permitted is 997 characters (including the
 *          element separators). The version of the QR Code resulting with error correction level 'M'
 *          and binary coding is version 25 with 117 x 117 modules."
 *      6.3 "To ensure that the Swiss QR Code is read securely, a minimum module size of 0.4 mm is
 *          required when printing."
 *      6.4 "The measurements of the Swiss QR Code for printing must always be 46 x 46 mm (without
 *          surrounding quiet space) regardless of the Swiss QR Code version. [...] All QR codes must
 *          be generated in the smallest version and only then scaled to the dimensions 46 x 46 mm."
 *      6.4.1 "an unprinted border must be provided around the Swiss QR Code corresponding to the
 *          width of four modules (corresponds to >= 1.6 mm). In the design recommendations, this
 *          border was expanded to 5 mm to improve user-friendliness (see chapter 3.5.2)."
 *      6.4.2 "the Swiss QR Code created for printout is overlaid with a cross logo in black and
 *          white, measuring 7 x 7 mm."
 *      4.1.1 "The message and the data in the Swiss QR Code must be UTF-8 encoded."
 *    https://www.six-group.com/dam/download/banking-services/standardization/qr-bill/ig-qr-bill-v2.3-en.pdf
 *  - SIX, "Style Guide QR-bill", which repeats the same figures ("46 x 46 mm", "Swiss cross 7 x 7 mm",
 *    the 5 mm border).
 *  - SIX Download Centre, `swiss-cross-graphic-en.zip` (`CH-Kreuz_7mm.svg`), the published recognition
 *    symbol, from which the SUB-geometry below is MEASURED (see `SWISS_CROSS` for the arithmetic).
 *    That file is SIC Ltd's protected image and is NOT redistributed here: this module draws the
 *    symbol from its published measurements, which is exactly what IG chapter 6.4.2 requires of any
 *    implementation, and reproduces no artwork file.
 */

import { encodeQrByteMode, type QrSymbol } from './qrcode.js';

/** Printed size of the Swiss QR Code, without the quiet space (IG v2.3 section 6.4). Never variable. */
export const SWISS_QR_CODE_SIZE_MM = 46 as const;

/**
 * The unprinted border. The ISO/IEC 18004 minimum the IG restates is four modules (">= 1.6 mm",
 * section 6.4.1); the SIX design recommendation widens it to 5 mm, which is what section 3.5.2 makes
 * binding for the payment part ("the 5 mm wide border must be adhered to, so that the Swiss QR Code
 * can be read"). TILL renders the 5 mm form, since that is what lands on a payment part.
 */
export const SWISS_QR_QUIET_ZONE_MM = 5 as const;

/** The ISO/IEC 18004 floor the IG restates, in modules (IG v2.3 section 6.4.1). */
export const SWISS_QR_MIN_QUIET_ZONE_MODULES = 4 as const;

/** Edge length of the recognition symbol (IG v2.3 section 6.4.2). */
export const SWISS_QR_CROSS_SIZE_MM = 7 as const;

/** Minimum printed module size (IG v2.3 section 6.3). See `meetsMinimumModuleSize` for the caveat. */
export const SWISS_QR_MIN_MODULE_SIZE_MM = 0.4 as const;

/** Maximum data content, including the element separators (IG v2.3 section 6.2). */
export const SWISS_QR_MAX_PAYLOAD_CHARS = 997 as const;

/**
 * The recognition symbol's internal geometry, in millimetres, measured from the officially published
 * `CH-Kreuz_7mm.svg` (SIX Download Centre, `swiss-cross-graphic-en.zip`, fetched 2026-07-25). That
 * file is drawn on a `viewBox="0 0 19.8 19.8"` grid standing for 7 mm, so one grid unit is 7/19.8 mm:
 *
 *   - black square from 0.7 to 19.1, overlaid by a white outline stroke 1.4357 wide centred on that
 *     boundary, so the VISIBLE black runs from 1.41785 to 18.38215 = 16.9643 units = 5.998 mm, and
 *     the white border around it is 1.41785 units = 0.501 mm. The design intent is plainly
 *     0.5 + 6.0 + 0.5 = 7.0, and that is what is encoded here.
 *   - cross bars: `width="3.3"` by `height="11"` units = 7/6 mm by 35/9 mm. The 11:3.3 ratio is
 *     10:3, which is the Swiss flag proportion (arms one sixth longer than wide: 7+6+7 to 6), so the
 *     bars are expressed as exact fractions rather than as the file's one-decimal rounding.
 *
 * The published file rounds its coordinates to one decimal, which leaves its cross a hundredth of a
 * unit off centre. This draws it exactly centred, which is the evident intent.
 */
export const SWISS_CROSS = {
  sizeMm: SWISS_QR_CROSS_SIZE_MM,
  /** The white frame between the black square and the edge of the 7 mm symbol, per side. */
  whiteBorderMm: 0.5,
  /** The black square the white cross sits in. */
  blackSquareMm: 6,
  /** Thickness of each cross bar (7 * 3.3 / 19.8). */
  barThicknessMm: 7 / 6,
  /** Length of each cross bar (7 * 11 / 19.8). */
  barLengthMm: 35 / 9,
} as const;

/** Points per millimetre, for the PDF content-stream form (72 pt per inch, 25.4 mm per inch). */
export const PT_PER_MM = 72 / 25.4;

/** Raised when a payload exceeds the guideline's data ceiling (IG v2.3 section 6.2). */
export class SwissQrPayloadTooLongError extends Error {
  constructor(
    readonly charLength: number,
    readonly byteLength: number,
  ) {
    super(
      `swiss_qr_payload_too_long: ${charLength} characters / ${byteLength} UTF-8 bytes exceeds the ${SWISS_QR_MAX_PAYLOAD_CHARS}-character Swiss QR Code ceiling (IG v2.3 section 6.2)`,
    );
    this.name = 'SwissQrPayloadTooLongError';
  }
}

/** The encoded Swiss QR Code plus every measurement a conformance check or a renderer needs. */
export interface SwissQrCodeGraphic {
  /** The exact SPC payload that was encoded, byte-for-byte. */
  readonly payload: string;
  /** ISO/IEC 18004 symbol version, the smallest that holds the payload (IG section 6.4). */
  readonly version: number;
  /** Side length in modules (`17 + 4 * version`). */
  readonly moduleCount: number;
  /** `modules[row][column]`, true = dark. */
  readonly modules: readonly (readonly boolean[])[];
  /** Always `'M'` (IG section 6.1). */
  readonly errorCorrectionLevel: 'M';
  /** The chosen ISO/IEC 18004 data mask (0 to 7). */
  readonly mask: number;
  /** Always 46 (IG section 6.4). */
  readonly codeSizeMm: typeof SWISS_QR_CODE_SIZE_MM;
  /** 46 / moduleCount: what one module measures once the symbol is scaled to its fixed size. */
  readonly moduleSizeMm: number;
  /** Always 7 (IG section 6.4.2). */
  readonly crossSizeMm: typeof SWISS_QR_CROSS_SIZE_MM;
  /**
   * Whether the scaled module still clears the 0.4 mm print floor of section 6.3.
   *
   * The guideline is internally in tension here and this flag reports that rather than hiding it:
   * section 6.4 fixes the printed size at 46 mm for EVERY version, and section 6.2 blesses version 25
   * (117 modules) as the maximum, but 46 / 117 = 0.393 mm, just under the 0.4 mm floor. Every version
   * up to 24 (113 modules, 0.407 mm) clears it. The 46 mm rule is unconditional, so this module never
   * refuses on that basis; it exposes the fact so a caller can shorten an over-long AddInf rather
   * than discover the problem at a bank counter.
   */
  readonly meetsMinimumModuleSize: boolean;
}

/**
 * Encode an SPC payload into a Swiss QR Code, refusing anything past the guideline's ceiling.
 *
 * Both limits are checked because they are not the same limit. Section 6.2 states 997 CHARACTERS;
 * what actually makes version 25 the maximum is 997 BYTES, since byte mode encodes the UTF-8 form
 * (section 4.1.1). For a payload of plain Basic Latin the two coincide, and they diverge the moment
 * a real umlaut appears (a two-byte code point), so a "997 characters" payload with umlauts would
 * silently push the symbol past version 25.
 */
export function buildSwissQrCodeGraphic(payload: string): SwissQrCodeGraphic {
  const bytes = new TextEncoder().encode(payload);
  const charLength = [...payload].length;
  if (charLength > SWISS_QR_MAX_PAYLOAD_CHARS || bytes.length > SWISS_QR_MAX_PAYLOAD_CHARS) {
    throw new SwissQrPayloadTooLongError(charLength, bytes.length);
  }

  const symbol: QrSymbol = encodeQrByteMode(bytes);
  const moduleSizeMm = SWISS_QR_CODE_SIZE_MM / symbol.size;

  return {
    payload,
    version: symbol.version,
    moduleCount: symbol.size,
    modules: symbol.modules,
    errorCorrectionLevel: symbol.errorCorrectionLevel,
    mask: symbol.mask,
    codeSizeMm: SWISS_QR_CODE_SIZE_MM,
    moduleSizeMm,
    crossSizeMm: SWISS_QR_CROSS_SIZE_MM,
    meetsMinimumModuleSize: moduleSizeMm >= SWISS_QR_MIN_MODULE_SIZE_MM,
  };
}

/**
 * What either renderer draws from: the SPC payload, or a symbol already built from one.
 *
 * The second arm exists because encoding is by far the most expensive thing on this path, and a
 * caller that needs a measurement BEFORE it renders (the Studio panel reads `moduleSizeMm` for its
 * density notice; the PDF path reports the whole `qrGraphic` block) otherwise has to build the
 * symbol, then hand the renderer a payload the renderer builds all over again. Passing the symbol
 * removes the second encode outright rather than making it cheap, which is the difference between a
 * fix and a cache: there is no key to get wrong, nothing to invalidate, and no memory held after the
 * call returns. Passing a payload still works and still encodes once, so no existing caller changes.
 *
 * A graphic carries the exact payload it was built from (`graphic.payload`), so the two arms cannot
 * describe different codes.
 */
export type SwissQrSource = string | SwissQrCodeGraphic;

/** Encode a payload, or take the symbol a caller already encoded. Never encodes twice. */
function asGraphic(source: SwissQrSource): SwissQrCodeGraphic {
  return typeof source === 'string' ? buildSwissQrCodeGraphic(source) : source;
}

// --- Geometry shared by both renderers ----------------------------------------------------------

/** One axis-aligned rectangle in millimetres, relative to the top-left of the rendered graphic. */
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  dark: boolean;
}

/**
 * One dark rectangle in MODULE units, with its origin at the top-left of the 46 mm code itself (not
 * of the rendered graphic, so the quiet zone is not part of this coordinate system). Every value is
 * a whole number of modules, which is what lets the PDF form draw under a scaling transform and
 * spend two or three characters on a coordinate instead of eight.
 */
interface ModuleRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Decompose the dark modules into as few rectangles as a simple pass can manage, because on this
 * path rectangle count IS file size: every invoice carries the symbol and invoices get emailed.
 *
 * Two merges, in order:
 *
 *  1. Along each row, adjacent dark modules become one wide rectangle. A 69-module symbol has 4761
 *     module cells; this alone gets an ordinary invoice down to roughly 1240 rectangles.
 *  2. Down the column, a run that repeats identically (same start, same width) in the row below is
 *     absorbed into a taller rectangle. The finder patterns, the timing lines and the alignment
 *     patterns are all vertically coherent, so this takes off another 12% or so.
 *
 * The result is a cover of exactly the dark modules and nothing else, which is asserted by
 * reconstructing the matrix from the emitted rectangles rather than argued for here. Neither merge
 * can move a module edge: every coordinate stays a whole module throughout.
 */
function darkRects(graphic: SwissQrCodeGraphic): ModuleRect[] {
  const n = graphic.moduleCount;

  // Pass 1: maximal horizontal runs, kept per row so the vertical pass can look one row ahead.
  const runsByRow: { start: number; width: number; taken: boolean }[][] = [];
  for (let row = 0; row < n; row += 1) {
    const runs: { start: number; width: number; taken: boolean }[] = [];
    let runStart = -1;
    for (let col = 0; col <= n; col += 1) {
      const dark = col < n && graphic.modules[row]![col] === true;
      if (dark && runStart < 0) runStart = col;
      if (!dark && runStart >= 0) {
        runs.push({ start: runStart, width: col - runStart, taken: false });
        runStart = -1;
      }
    }
    runsByRow.push(runs);
  }

  // Pass 2: stack identical runs. Rows are visited top down, so a run absorbed from below is always
  // marked before it is reached in its own row, and every run is emitted exactly once.
  const rects: ModuleRect[] = [];
  for (let row = 0; row < n; row += 1) {
    for (const run of runsByRow[row]!) {
      if (run.taken) continue;
      let height = 1;
      for (;;) {
        const below = runsByRow[row + height]?.find(
          (candidate) => candidate.start === run.start && candidate.width === run.width && !candidate.taken,
        );
        if (below === undefined) break;
        below.taken = true;
        height += 1;
      }
      rects.push({ x: run.start, y: row, width: run.width, height });
    }
  }
  return rects;
}

/**
 * The recognition symbol, centred on the code (IG v2.3 section 6.4.2), as its three drawn layers:
 * the white frame, the black square, and the two white bars that form the cross.
 */
function crossRects(centreMm: number): Rect[] {
  const { sizeMm, whiteBorderMm, blackSquareMm, barThicknessMm, barLengthMm } = SWISS_CROSS;
  const centred = (edge: number): number => centreMm - edge / 2;
  return [
    { x: centred(sizeMm), y: centred(sizeMm), width: sizeMm, height: sizeMm, dark: false },
    {
      x: centred(sizeMm) + whiteBorderMm,
      y: centred(sizeMm) + whiteBorderMm,
      width: blackSquareMm,
      height: blackSquareMm,
      dark: true,
    },
    {
      x: centred(barThicknessMm),
      y: centred(barLengthMm),
      width: barThicknessMm,
      height: barLengthMm,
      dark: false,
    },
    {
      x: centred(barLengthMm),
      y: centred(barThicknessMm),
      width: barLengthMm,
      height: barThicknessMm,
      dark: false,
    },
  ];
}

export interface SwissQrRenderOptions {
  /**
   * Draw the 5 mm unprinted border around the code (IG sections 3.5.2 / 6.4.1). On by default: a
   * payment part that omits it produces a code readers can fail on, and the caller most likely to
   * omit it is the one who did not know it existed.
   */
  quietZone?: boolean;
  /** Draw the mandated 7 x 7 mm recognition symbol (IG section 6.4.2). On by default. */
  cross?: boolean;
}

/** The rendered graphic's outer edge in millimetres (46, or 56 with the quiet zone). */
export function swissQrGraphicSizeMm(options: SwissQrRenderOptions = {}): number {
  const quiet = options.quietZone === false ? 0 : SWISS_QR_QUIET_ZONE_MM;
  return SWISS_QR_CODE_SIZE_MM + quiet * 2;
}

/**
 * Trim a measurement to `places` decimals without trailing zeroes, so the output is stable and no
 * coordinate costs more characters than it carries meaning.
 *
 * Four decimals is the default because a millimetre measured to 1/10000 is already an order of
 * magnitude finer than any printer resolves. `Number.prototype.toString` only reaches for exponent
 * notation below 1e-6, which is beneath every value here, so this never emits something a PDF
 * number cannot be.
 */
function num(value: number, places = 4): string {
  return Number(value.toFixed(places)).toString();
}

/** Millimetres, at the default precision. */
function mm(value: number): string {
  return num(value);
}

// --- SVG ------------------------------------------------------------------------------------------

export interface SwissQrSvgOptions extends SwissQrRenderOptions {
  /**
   * The accessible name. The engine has no locale, so the caller passes its own translated string;
   * the default is a neutral English fallback, never a Studio-visible hardcoded label.
   */
  ariaLabel?: string;
}

/** Escape the five XML metacharacters in the accessible name. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** One `<rect>`, with its own `fill` only when it does not inherit the right one from its parent. */
function svgRect(r: Rect, fill?: string): string {
  const colour = fill === undefined ? '' : ` fill="${fill}"`;
  return `<rect x="${mm(r.x)}" y="${mm(r.y)}" width="${mm(r.width)}" height="${mm(r.height)}"${colour}/>`;
}

/**
 * Decimals kept in the module-unit scale factor, for the same reason the PDF's `cm` keeps six: the
 * factor is a SCALE, so its error is multiplied by the module index, and the far edge of a
 * 117-module symbol amplifies it 117 times. Eight decimals of a millimetre puts the worst-case drift
 * across the whole symbol under 1e-6 mm, which is three orders of magnitude below the 1e-3 mm a
 * printer resolves and four below one module. It costs about six bytes, once.
 */
const SVG_SCALE_DECIMALS = 8;

/**
 * Render the Swiss QR Code as a self-contained SVG whose user units ARE millimetres, so the same
 * string embeds in a browser at the right physical size and drops into a print layout unscaled.
 *
 * The output is nothing but rectangles on purpose: a vector form scales without the quality loss
 * IG section 6.4 warns about ("This must occur on the basis of a vector graphic in order to maintain
 * the quality of the Swiss QR Code"), and a shape vocabulary of one keeps the artifact verifiable,
 * which is how the round-trip test decodes the rendered SVG rather than only the matrix behind it.
 *
 * SIZE ON DISK IS A FEATURE HERE, the way it is on the PDF path. This string is re-sent on every
 * view of the Studio's invoice panel, and the module grid is over a thousand rectangles on an
 * ordinary invoice. Two things keep it small without moving a single printed edge:
 *
 *  1. The grid's colour is set ONCE, on the `<g>` that holds it, instead of on every rectangle
 *     inside it. `fill` is an inherited presentation attribute, so the group paints exactly what the
 *     per-rectangle form painted.
 *  2. That same group carries a transform whose unit IS one module, so a coordinate is a small whole
 *     number (`x="34" width="5"`) rather than a four-decimal millimetre measurement
 *     (`x="34.6667" width="3.3333"`). This is the larger saving of the two, and it is the SVG
 *     counterpart of the `cm` matrix on the PDF path.
 *
 * Module coordinates are also more exact than the millimetres they replace, not less. Rounding a
 * millimetre to four decimals let two rectangles that share an edge disagree about where it is by up
 * to 1e-4 mm; a whole module cannot, and the one rounded number left is the scale factor, held to
 * eight decimals.
 *
 * The ground and the recognition symbol stay in MILLIMETRES with their own `fill`, outside the
 * transform. They are a handful of rectangles in two colours, so neither saving would amount to
 * anything, and the ground is the rectangle a reader looks at first to see where the graphic sits:
 * it should not need a matrix interpreted before it can be read.
 */
export function renderSwissQrCodeSvg(source: SwissQrSource, options: SwissQrSvgOptions = {}): string {
  const graphic = asGraphic(source);
  const quiet = options.quietZone === false ? 0 : SWISS_QR_QUIET_ZONE_MM;
  const outer = swissQrGraphicSizeMm(options);
  const label = escapeXml(options.ariaLabel ?? 'Swiss QR Code');

  // The ground covers the whole graphic, unprinted border included, so the quiet zone is white by
  // construction rather than by whatever happens to sit behind the element.
  const ground = svgRect({ x: 0, y: 0, width: outer, height: outer, dark: false }, '#FFFFFF');

  // Module space: the origin is the CODE's top-left corner (so the quiet zone is not in this
  // coordinate system) and one unit is one module. Unlike the PDF's `cm`, no axis flip is needed:
  // SVG's y already runs downward, which is how the module matrix is indexed.
  const scale = num(graphic.moduleSizeMm, SVG_SCALE_DECIMALS);
  const grid =
    `<g fill="#000000" transform="translate(${mm(quiet)} ${mm(quiet)}) scale(${scale})">` +
    darkRects(graphic)
      .map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}"/>`)
      .join('') +
    `</g>`;

  const cross =
    options.cross === false
      ? ''
      : crossRects(outer / 2)
          .map((r) => svgRect(r, r.dark ? '#000000' : '#FFFFFF'))
          .join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outer}mm" height="${outer}mm" ` +
    `viewBox="0 0 ${outer} ${outer}" shape-rendering="crispEdges" role="img" aria-label="${label}">` +
    `<title>${label}</title>${ground}${grid}${cross}</svg>`
  );
}

// --- PDF ------------------------------------------------------------------------------------------

export interface SwissQrPdfOptions extends SwissQrRenderOptions {
  /** Left edge of the graphic, in PDF points from the page's left edge. */
  xPt: number;
  /** BOTTOM edge of the graphic, in PDF points from the page's bottom edge (PDF's y axis points up). */
  yPt: number;
}

/**
 * Decimals kept in the `cm` matrix. Six, not four, because the matrix is a SCALE: its error is
 * multiplied by the module index, so the far edge of a 117-module symbol amplifies it 117 times.
 * At six decimals the worst-case drift across the whole symbol is under 1/10000 of a point, which
 * is four orders of magnitude below one module. It costs a handful of bytes, once.
 */
const CTM_DECIMALS = 6;

/**
 * Render the Swiss QR Code as a PDF content-stream fragment (`re`/`f` operators inside a `q`/`Q`
 * pair), positioned in points. No PDF library and no rasterization: the whole graphic is filled
 * rectangles, which is both the smallest and the sharpest way into a hand-assembled PDF.
 *
 * The caller places it; the SIZE is not a parameter, because IG section 6.4 does not offer one
 * ("must always be 46 x 46 mm [...] regardless of the Swiss QR Code version"). 46 mm is 130.394 pt.
 *
 * SIZE ON DISK IS A FEATURE HERE, not housekeeping. Every invoice a workspace ever issues carries
 * this fragment and invoices get emailed, so four things keep it small without changing a single
 * printed edge:
 *
 *  1. The fill colour is set ONCE per run of same-coloured rectangles rather than once per
 *     rectangle. Roughly 1200 copies of `0 0 0 rg ` become one.
 *  2. The module grid is drawn under a `cm` transform whose unit IS one module, so a coordinate is
 *     a small whole number (`34 22 5 1 re`) instead of a four-decimal point measurement
 *     (`134.3268 202.6772 9.4488 1.8898 re f`). This is the largest saving by a wide margin.
 *  3. `darkRects` merges the modules along rows and then down columns.
 *  4. The whole module grid is ONE path closed by a single `f`, rather than a fill per rectangle.
 *
 * The white ground stays in PAGE points, outside the transform, on purpose: it is the one rectangle
 * that describes where the fragment sits, and a reader should be able to find the graphic without
 * first having to interpret a matrix.
 */
export function renderSwissQrCodePdfOps(source: SwissQrSource, options: SwissQrPdfOptions): string {
  const graphic = asGraphic(source);
  const quietMm = options.quietZone === false ? 0 : SWISS_QR_QUIET_ZONE_MM;
  const outerMm = swissQrGraphicSizeMm(options);
  const outerPt = outerMm * PT_PER_MM;
  const quietPt = quietMm * PT_PER_MM;
  const modulePt = graphic.moduleSizeMm * PT_PER_MM;

  // The ground, in page points: the whole graphic including the unprinted border. It carries its
  // own colour operator inline because it is also the fragment's self-description.
  const lines: string[] = [
    'q',
    `1 1 1 rg ${mm(options.xPt)} ${mm(options.yPt)} ${mm(outerPt)} ${mm(outerPt)} re f`,
  ];
  let colour: 'dark' | 'light' = 'light';
  const fill = (dark: boolean): void => {
    const wanted = dark ? 'dark' : 'light';
    if (colour === wanted) return;
    lines.push(dark ? '0 0 0 rg' : '1 1 1 rg');
    colour = wanted;
  };

  // Module space: one unit is one module, the origin is the CODE's top-left corner, and y runs
  // DOWNWARD (the negative d term), which is the matrix orientation the module matrix is indexed
  // in. PDF's own y axis points up, so this flip is what turns row 0 into the top row.
  const originXPt = options.xPt + quietPt;
  const originYPt = options.yPt + outerPt - quietPt;
  const s = num(modulePt, CTM_DECIMALS);
  lines.push(`${s} 0 0 -${s} ${num(originXPt, CTM_DECIMALS)} ${num(originYPt, CTM_DECIMALS)} cm`);

  // The grid is a SINGLE path: every rectangle is appended with `re`, and one `f` at the end fills
  // all of them. `re` appends a complete closed subpath, so this paints exactly what a fill per
  // rectangle painted, and the winding rule never even comes into play: `darkRects` covers each dark
  // module exactly once, so no two of these rectangles overlap. (That is not asserted here but
  // rebuilt and checked cell by cell against the encoder in the graphic suite.) Dropping the ` f`
  // from roughly a thousand lines is about 2 kB off every invoice ever emailed.
  fill(true);
  for (const r of darkRects(graphic)) lines.push(`${r.x} ${r.y} ${r.width} ${r.height} re`);
  lines.push('f');

  if (options.cross !== false) {
    // The recognition symbol is laid out in millimetres from the graphic's top-left, so it is
    // converted into the same module space: a handful of rectangles, precision unchanged.
    const toModule = (valueMm: number): number => (valueMm - quietMm) / graphic.moduleSizeMm;
    const perModule = (valueMm: number): number => valueMm / graphic.moduleSizeMm;
    for (const r of crossRects(outerMm / 2)) {
      fill(r.dark);
      lines.push(
        `${mm(toModule(r.x))} ${mm(toModule(r.y))} ${mm(perModule(r.width))} ${mm(perModule(r.height))} re f`,
      );
    }
  }

  lines.push('Q');
  return lines.join('\n');
}

/** The printed edge of the graphic in PDF points, for a caller laying out a payment part. */
export function swissQrGraphicSizePt(options: SwissQrRenderOptions = {}): number {
  return swissQrGraphicSizeMm(options) * PT_PER_MM;
}
