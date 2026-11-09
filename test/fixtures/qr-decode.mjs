// Test-only QR decoding helpers for the A11 scannable-graphic unit.
//
// The whole point of the QR unit is that the symbol is PROVEN scannable, not asserted scannable, so
// every assertion about it goes through a decoder TILL did not write: `jsqr` (Apache-2.0), a
// DEV dependency only. It is never imported by anything under `src/`, so the shipped MIT engine
// keeps its zero-runtime-dependency posture for the QR path.
//
// Three rasterizers live here:
//   - `rasterizeMatrix`, which paints the module matrix directly (proves the ENCODER).
//   - `rasterizeSvgRects`, which paints the emitted SVG's own rectangles (proves the RENDERED
//     ARTIFACT, Swiss cross included, which is what the Studio panel shows).
//   - `rasterizePdfOps`, which interprets the PDF content-stream operators (proves the artifact that
//     actually lands on an invoice and in a customer's inbox).
// All three feed the same independent decoder.

import jsQRModule from 'jsqr';

const jsQR = jsQRModule.default ?? jsQRModule;

/**
 * Device pixels per QR module the harness rasterizes at.
 *
 * Calibrated, not guessed. A Swiss QR Code is scaled to a fixed 46 mm whatever its version, so
 * "pixels per millimetre" means a different module density for every symbol, and the decoder cares
 * about the density. jsQR binarizes over 8x8 pixel blocks: too few pixels per module and several
 * modules share a block, too many and a whole block falls inside one module with no local contrast
 * for the adaptive threshold. Both ends produce failures that are the HARNESS's, not the encoder's.
 * A sweep over 41 payloads spanning versions 1 to 25 put the reliable band at roughly 4 to 10 pixels
 * per module, so the harness sits in the middle of it, which is also about what a 300 dpi scan of a
 * printed payment part delivers.
 */
export const PIXELS_PER_MODULE = 8;

/**
 * White RGBA canvas. `paint` composites an axis-aligned rectangle with AREA COVERAGE, the way a real
 * renderer (a browser, a PDF rasterizer, a camera sensor) does, rather than snapping every edge to a
 * whole pixel.
 *
 * This matters and it is not cosmetic. A Swiss QR Code is scaled to a fixed 46 mm whatever its module
 * count, so its module pitch is almost never a whole number of device pixels. Hard-edged sampling
 * then quantises some modules wider than others, and that artificial jitter, which no real rendering
 * path produces, is enough to defeat a decoder's grid detection at some resolutions and not at
 * others. Compositing by coverage removes the artifact from the HARNESS so that a decode failure
 * means what it is supposed to mean: a defect in the code being tested.
 */
function createCanvas(width, height) {
  const grey = new Float64Array(width * height).fill(1);
  return {
    width,
    height,
    paint(x0, y0, w, h, dark) {
      const target = dark ? 0 : 1;
      const xStart = Math.max(0, Math.floor(x0));
      const yStart = Math.max(0, Math.floor(y0));
      const xEnd = Math.min(width, Math.ceil(x0 + w));
      const yEnd = Math.min(height, Math.ceil(y0 + h));
      for (let y = yStart; y < yEnd; y += 1) {
        const yCover = Math.max(0, Math.min(y + 1, y0 + h) - Math.max(y, y0));
        if (yCover <= 0) continue;
        for (let x = xStart; x < xEnd; x += 1) {
          const xCover = Math.max(0, Math.min(x + 1, x0 + w) - Math.max(x, x0));
          if (xCover <= 0) continue;
          const coverage = xCover * yCover;
          const i = y * width + x;
          grey[i] = grey[i] * (1 - coverage) + target * coverage;
        }
      }
    },
    /** The RGBA buffer the decoder consumes, materialised once every rectangle has been composited. */
    get data() {
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < grey.length; i += 1) {
        const value = Math.round(grey[i] * 255);
        rgba[i * 4] = value;
        rgba[i * 4 + 1] = value;
        rgba[i * 4 + 2] = value;
        rgba[i * 4 + 3] = 255;
      }
      return rgba;
    },
  };
}

/** Paint a `QrSymbol` matrix at `scale` device pixels per module, with a `quiet`-module margin. */
export function rasterizeMatrix(symbol, { scale = 4, quiet = 4 } = {}) {
  const side = (symbol.size + quiet * 2) * scale;
  const canvas = createCanvas(side, side);
  for (let row = 0; row < symbol.size; row += 1) {
    for (let col = 0; col < symbol.size; col += 1) {
      if (!symbol.modules[row][col]) continue;
      canvas.paint((col + quiet) * scale, (row + quiet) * scale, scale, scale, true);
    }
  }
  return canvas;
}

/** SVG's initial value for `fill`, which applies to any element that neither sets nor inherits one. */
const SVG_INITIAL_FILL = '#000000';

/** Every open/close tag of a well-formed SVG, in document order. Attribute values never contain `>`. */
const SVG_TAG = /<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g;

/** An element's OWN `fill` presentation attribute, or `null` when it does not set one. */
function ownFill(attrs) {
  const found = /(?:^|\s)fill="([^"]*)"/.exec(attrs);
  return found === null ? null : found[1];
}

/** The identity transform, in the axis-aligned form this graphic never needs to exceed. */
const IDENTITY = { tx: 0, ty: 0, sx: 1, sy: 1 };

/** `outer` applied to whatever `inner` produced, i.e. `outer(inner(p))`. */
function composeTransform(outer, inner) {
  return {
    tx: outer.tx + outer.sx * inner.tx,
    ty: outer.ty + outer.sy * inner.ty,
    sx: outer.sx * inner.sx,
    sy: outer.sy * inner.sy,
  };
}

/**
 * Parse a `transform` attribute into the axis-aligned form above.
 *
 * `translate` and `scale` are the entire vocabulary the graphic uses, and anything else THROWS on
 * purpose. A harness that quietly ignored a transform it did not recognise would paint the symbol
 * somewhere other than where the artifact puts it, and then report whatever the decoder made of the
 * result: most likely a clean-looking failure, at worst a pass on a picture of nothing.
 */
function parseTransform(value) {
  let combined = IDENTITY;
  let operations = 0;
  const operation = /([a-zA-Z]+)\(([^)]*)\)/g;
  let match;
  while ((match = operation.exec(value)) !== null) {
    operations += 1;
    const args = match[2].trim().split(/[\s,]+/).map(Number);
    if (args.some(Number.isNaN)) throw new Error(`svg_unreadable_transform:${value}`);
    if (match[1] === 'translate') {
      combined = composeTransform(combined, { ...IDENTITY, tx: args[0], ty: args[1] ?? 0 });
    } else if (match[1] === 'scale') {
      combined = composeTransform(combined, { ...IDENTITY, sx: args[0], sy: args[1] ?? args[0] });
    } else {
      throw new Error(`svg_unsupported_transform:${match[1]}`);
    }
  }
  if (operations === 0) throw new Error(`svg_unreadable_transform:${value}`);
  return combined;
}

/**
 * Paint the `<rect>` elements of an SVG, in document order, at `pixelsPerUnit` device pixels per
 * user unit. The graphic module emits nothing but rectangles on purpose (module runs, then the
 * recognition symbol's three layers), so this covers the artifact completely without pulling a
 * rendering engine into the test suite.
 *
 * `fill` IS INHERITED, and this walks the tree accordingly rather than reading the attribute off
 * each rectangle and stopping there. The renderer hoists the module grid's colour onto the enclosing
 * `<g>`, which is what keeps a four-figure rectangle count from carrying a four-figure count of
 * identical colour attributes. A rasterizer that only looked at the rectangle would find no `fill`
 * on any grid rectangle, paint the entire symbol in one flat colour, and then hand the decoder a
 * blank image: every assertion downstream would be decoding nothing and still be green. So the rule
 * here is the consumer's rule, in full: an element's own `fill` wins, otherwise it inherits from its
 * nearest ancestor, and with no ancestor setting one the initial value is black.
 *
 * `transform` is handled for the same reason. The grid is drawn under a transform whose unit is one
 * module, which is what keeps the string a browser re-fetches on every panel view from being three
 * times the size it needs to be. That transform is state living OUTSIDE the rectangle it applies to,
 * so a rasterizer that read only the rectangle's own coordinates would paint the symbol at module
 * scale in the top-left corner of the graphic and decode a canvas that has nothing to do with the
 * artifact. Both stacks are therefore kept, and pushed and popped together with the elements.
 */
export function rasterizeSvgRects(svg, { moduleSizeMm, pixelsPerModule = PIXELS_PER_MODULE } = {}) {
  if (typeof moduleSizeMm !== 'number') throw new Error('moduleSizeMm_required');
  // The SVG's user unit IS a millimetre, so the module density fixes the pixel density.
  const pixelsPerUnit = pixelsPerModule / moduleSizeMm;
  const viewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (viewBox === null) throw new Error('svg_has_no_viewbox');
  const canvas = createCanvas(
    Math.round(Number(viewBox[1]) * pixelsPerUnit),
    Math.round(Number(viewBox[2]) * pixelsPerUnit),
  );

  // The inherited graphics state. Only container elements push, and the bottom entry is the initial
  // state, so a rectangle outside every group still resolves to something.
  const stack = [{ fill: SVG_INITIAL_FILL, transform: IDENTITY }];
  const current = () => stack[stack.length - 1];

  SVG_TAG.lastIndex = 0;
  let match;
  let painted = 0;
  while ((match = SVG_TAG.exec(svg)) !== null) {
    const [, closing, rawName, attrs, selfClosing] = match;
    const name = rawName.toLowerCase();
    const own = () => {
      const transform = /(?:^|\s)transform="([^"]*)"/.exec(attrs);
      return {
        fill: ownFill(attrs) ?? current().fill,
        // A transform on an element composes with the one it inherits; it does not replace it.
        transform:
          transform === null
            ? current().transform
            : composeTransform(current().transform, parseTransform(transform[1])),
      };
    };

    if (name === 'g' || name === 'svg') {
      if (closing === '/') {
        if (stack.length > 1) stack.pop();
      } else {
        stack.push(own());
        if (selfClosing === '/') stack.pop();
      }
      continue;
    }
    if (closing === '/' || name !== 'rect') continue;

    const read = (attribute) => {
      const found = new RegExp(`(?:^|\\s)${attribute}="(-?[\\d.]+)"`).exec(attrs);
      return found === null ? 0 : Number(found[1]);
    };
    const { fill, transform } = own();
    canvas.paint(
      (transform.tx + transform.sx * read('x')) * pixelsPerUnit,
      (transform.ty + transform.sy * read('y')) * pixelsPerUnit,
      transform.sx * read('width') * pixelsPerUnit,
      transform.sy * read('height') * pixelsPerUnit,
      fill === '#000000',
    );
    painted += 1;
  }
  if (painted === 0) throw new Error('svg_has_no_rects');
  return canvas;
}

/**
 * Concatenate a `cm` matrix onto the current transform, in PDF's own order: the new matrix applies
 * FIRST, then whatever was already in effect. Both are `[a b c d e f]`, mapping `(x, y)` to
 * `(a*x + c*y + e, b*x + d*y + f)`.
 */
function concatMatrix(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

const applyMatrix = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** A PDF numeric object: an optional sign, digits, an optional fraction. No exponents in PDF. */
const PDF_NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)$/;

/**
 * Paint a PDF content-stream fragment, flipping PDF's bottom-left origin back to a top-left raster.
 * `xPt`/`yPt` are the fragment's own bottom-left corner and `sizePt` its edge, i.e. exactly what was
 * handed to the renderer.
 *
 * This is a real (if tiny) content-stream interpreter rather than one regular expression, and it has
 * to be. The renderer draws the module grid under a `cm` transform whose unit is one module, which
 * is what keeps an invoice from carrying 56 kB of coordinates, and it sets the fill colour once per
 * run instead of once per rectangle. So the state that decides where a rectangle lands and what
 * colour it is now lives in operators BEFORE the rectangle, and a decoder that ignored them would
 * paint the symbol in the wrong place at the wrong scale.
 *
 * The interpreter is deliberately narrow: `q`/`Q`, `cm`, `rg`, `re` and `f` are the entire graphic's
 * vocabulary. Anything else resets the operand stack, and text objects are skipped whole, so page
 * text with parentheses in it cannot be mistaken for geometry.
 */
export function rasterizePdfOps(ops, { xPt, yPt, sizePt, moduleSizePt, pixelsPerModule = PIXELS_PER_MODULE } = {}) {
  if (typeof moduleSizePt !== 'number') throw new Error('moduleSizePt_required');
  const pixelsPerPt = pixelsPerModule / moduleSizePt;
  const side = Math.round(sizePt * pixelsPerPt);
  const canvas = createCanvas(side, side);

  let ctm = [1, 0, 0, 1, 0, 0];
  let dark = false;
  const stack = [];
  let operands = [];
  let path = [];
  let inText = false;
  let painted = 0;

  /** One rectangle, from user space through the transform into the raster. */
  const paintRect = (x, y, w, h) => {
    const [ax, ay] = applyMatrix(ctm, x, y);
    const [bx, by] = applyMatrix(ctm, x + w, y + h);
    // The transform in use is axis-aligned (the graphic never rotates or skews), so the two mapped
    // corners bound the rectangle whichever way the axes were flipped.
    const left = Math.min(ax, bx);
    const bottom = Math.min(ay, by);
    const width = Math.abs(bx - ax);
    const height = Math.abs(by - ay);
    // PDF y grows upward: the rectangle's TOP in raster space is sizePt - (bottom + height).
    canvas.paint(
      (left - xPt) * pixelsPerPt,
      (sizePt - (bottom - yPt + height)) * pixelsPerPt,
      width * pixelsPerPt,
      height * pixelsPerPt,
      dark,
    );
    painted += 1;
  };

  for (const token of ops.split(/\s+/)) {
    if (token === '') continue;
    if (token === 'BT') {
      inText = true;
      operands = [];
      continue;
    }
    if (token === 'ET') {
      inText = false;
      operands = [];
      continue;
    }
    if (inText) continue;
    if (PDF_NUMBER.test(token)) {
      operands.push(Number(token));
      continue;
    }
    switch (token) {
      case 'q':
        stack.push({ ctm, dark });
        break;
      case 'Q': {
        const saved = stack.pop();
        if (saved !== undefined) ({ ctm, dark } = saved);
        break;
      }
      case 'cm':
        if (operands.length >= 6) ctm = concatMatrix(operands.slice(-6), ctm);
        break;
      case 'rg':
        // The graphic is monochrome, so "dark" is simply "not white".
        if (operands.length >= 3) dark = operands.slice(-3).some((component) => component !== 1);
        break;
      case 're':
        if (operands.length >= 4) path.push(operands.slice(-4));
        break;
      case 'f':
      case 'F':
      case 'f*':
        for (const [x, y, w, h] of path) paintRect(x, y, w, h);
        path = [];
        break;
      case 'n':
        path = [];
        break;
      default:
        break;
    }
    operands = [];
  }

  if (painted === 0) throw new Error('pdf_ops_have_no_rectangles');
  return canvas;
}

/**
 * Decode a rasterized canvas with the independent decoder. Returns `{ text, bytes }`, where `bytes`
 * is what the decoder actually pulled out of the symbol: comparing BYTES, not the decoder's string
 * reconstruction, is what makes "byte-identical" a real claim for a UTF-8 payload.
 */
export function decode(canvas) {
  const result = jsQR(canvas.data, canvas.width, canvas.height);
  if (result === null) return null;
  return { text: result.data, bytes: Uint8Array.from(result.binaryData ?? []) };
}
