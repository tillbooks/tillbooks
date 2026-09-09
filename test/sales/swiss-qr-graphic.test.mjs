// A11, the SCANNABLE Swiss QR Code graphic.
//
// The bar here is not "the code looks right", it is "an independent decoder reads the RENDERED
// ARTIFACT back byte-for-byte". A QR-bill that looks correct and does not scan is worse than no
// QR-bill at all, because it ships an unpayable invoice that passes every visual review. So every
// payload below is encoded, RENDERED (to SVG rectangles and to PDF operators, the two forms that
// actually reach a customer), rasterized, and read back with `jsqr`, a decoder TILL did not write.
// A case the decoder cannot read is a real failure to fix, never a test to relax.
//
// The cited measurements are fetched, not recalled: SIX, "Swiss Implementation Guidelines for the
// QR-bill", v2.3 of 20.11.2023, chapter 6 (fetched 2026-07-25 from six-group.com/dam/download/
// banking-services/standardization/qr-bill/ig-qr-bill-v2.3-en.pdf), plus `CH-Kreuz_7mm.svg` from the
// SIX Download Centre for the recognition symbol's sub-geometry.
//
// Nothing here is a claim of SIX certification: structural conformance against cited references plus
// a proven round trip is the whole claim.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSwissQrCodeGraphic,
  renderSwissQrCodeSvg,
  renderSwissQrCodePdfOps,
  swissQrGraphicSizeMm,
  swissQrGraphicSizePt,
  SwissQrPayloadTooLongError,
  SWISS_QR_CODE_SIZE_MM,
  SWISS_QR_QUIET_ZONE_MM,
  SWISS_QR_MIN_QUIET_ZONE_MODULES,
  SWISS_QR_CROSS_SIZE_MM,
  SWISS_QR_MIN_MODULE_SIZE_MM,
  SWISS_QR_MAX_PAYLOAD_CHARS,
  SWISS_CROSS,
  PT_PER_MM,
} from '../../dist/core/sales/swiss-qr-graphic.js';
import { encodeSwissQrPayload } from '../../dist/core/sales/qrbill.js';
import { rasterizeSvgRects, rasterizePdfOps, decode } from '../fixtures/qr-decode.mjs';

/** Render, rasterize at the harness's module density, and decode. Returns the decoder's result. */
function renderAndDecodeSvg(payload, options = {}) {
  const { moduleSizeMm } = buildSwissQrCodeGraphic(payload);
  return decode(rasterizeSvgRects(renderSwissQrCodeSvg(payload, options), { moduleSizeMm }));
}

/** The `<g>` that holds the module grid: its `transform`, and the rectangles inside it. */
const GRID_GROUP = /<g fill="#000000" transform="translate\((-?[\d.]+) (-?[\d.]+)\) scale\(([\d.]+)\)">(.*?)<\/g>/s;

/**
 * The module grid's rectangles, IN MILLIMETRES, read out of the `<g>` that carries their colour and
 * their coordinate system.
 *
 * Both are hoisted onto that group: the `fill`, so the rectangles carry no colour of their own, and
 * a transform whose unit is one module, so they carry whole module numbers rather than millimetres.
 * An assertion that filtered on `fill="#000000"` would now match nothing, and one that read `x` as a
 * millimetre would be off by the module scale. So this does what a consumer does, applies the
 * transform, and every caller checks the count before trusting the list.
 */
function darkSvgRects(svg) {
  const group = GRID_GROUP.exec(svg);
  assert.notEqual(group, null, 'the module grid must be one group carrying the dark fill and the module transform');
  const [, tx, ty, scale] = group.slice(0, 4).map(Number);
  return [...group[4].matchAll(/<rect x="(-?\d+)" y="(-?\d+)" width="(\d+)" height="(\d+)"\/>/g)].map(
    ([, x, y, w, h]) => ({
      x: tx + Number(x) * scale,
      y: ty + Number(y) * scale,
      w: Number(w) * scale,
      h: Number(h) * scale,
      moduleX: Number(x),
      moduleY: Number(y),
      moduleW: Number(w),
      moduleH: Number(h),
    }),
  );
}

/** The rectangles that still carry their own `fill`: the white ground, then the cross's four layers. */
function selfColouredSvgRects(svg) {
  return [
    ...svg.matchAll(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="([^"]+)"\/>/g),
  ].map(([, x, y, w, h, fill]) => ({ x: Number(x), y: Number(y), w: Number(w), h: Number(h), dark: fill === '#000000' }));
}

// --- The payloads under test ---------------------------------------------------------------------

/** Repeat a filler string to exactly `length` characters, so a field sits exactly on its IG cap. */
function fill(length, seed = 'Mustergasse Seldwyla ') {
  let out = '';
  while (out.length < length) out += seed;
  return out.slice(0, length);
}

/** The smallest guideline-valid QR-bill: no amount, no debtor, no reference, no additions. */
const MINIMAL = encodeSwissQrPayload({
  iban: 'CH5800791123000889012',
  creditor: { name: 'A', postalCode: '8000', town: 'Zug', country: 'CH' },
  amountMinor: null,
  currency: 'CHF',
  referenceType: 'NON',
  reference: '',
});

/** The SIX Table 4 worked example's shape: a QRR reference against a QR-IBAN, in CHF. */
const QRR_CHF = encodeSwissQrPayload({
  iban: 'CH4431999123000889012',
  creditor: { name: 'Max Muster & Söhne', street: 'Musterstrasse', buildingNo: '123', postalCode: '8000', town: 'Seldwyla', country: 'CH' },
  amountMinor: 194975,
  currency: 'CHF',
  debtor: { name: 'Simon Muster', street: 'Musterstrasse', buildingNo: '1', postalCode: '8000', town: 'Seldwyla', country: 'CH' },
  referenceType: 'QRR',
  reference: '210000000003139471430009017',
  unstructuredMessage: 'Rechnung Nr. R-2026-0042',
});

/** A SCOR (ISO 11649) reference against a plain IBAN, in EUR: the other half of the exclusive pair. */
const SCOR_EUR = encodeSwissQrPayload({
  iban: 'CH5800791123000889012',
  creditor: { name: 'Robert Schneider AG', street: 'Rue du Lac', buildingNo: '1268/2/22', postalCode: '2501', town: 'Biel', country: 'CH' },
  amountMinor: 19999999,
  currency: 'EUR',
  debtor: { name: 'Pia-Maria Rutschmann-Schnyder', street: 'Grosse Marktgasse', buildingNo: '28', postalCode: '9400', town: 'Rorschach', country: 'CH' },
  referenceType: 'SCOR',
  reference: 'RF18539007547034',
  unstructuredMessage: 'Beachten Sie unsere Sonderaktion Gültig bis 31.12.2026',
});

/** No reference at all, the third permitted reference type. */
const NON_CHF = encodeSwissQrPayload({
  iban: 'CH5800791123000889012',
  creditor: { name: 'Nomadik GmbH', street: 'Bahnhofstrasse', buildingNo: '1', postalCode: '6300', town: 'Zug', country: 'CH' },
  amountMinor: 1,
  currency: 'CHF',
  referenceType: 'NON',
  reference: '',
});

/**
 * Every IG field cap used to the last character: 70/70/16/16/35 on both addresses (IG v2.3 Table 8),
 * a 140-character AddInf (the Ustrd + StrdBkgInf budget), and an AltPmt line. This is the payload
 * shape most likely to tip the symbol into a version an under-tested encoder gets wrong.
 */
const MAXIMAL = encodeSwissQrPayload({
  iban: 'CH4431999123000889012',
  creditor: {
    name: fill(70, 'Genossenschaft Bürgerhaus Zürichsee & Söhne '),
    street: fill(70, 'Obere Alte Landstrasse Hinterhof '),
    buildingNo: fill(16, '128/A-12 '),
    postalCode: fill(16, '8001-CH-A '),
    town: fill(35, 'Oberägeri bei Zug '),
    country: 'CH',
  },
  amountMinor: 99_999_999_999,
  currency: 'CHF',
  debtor: {
    name: fill(70, 'Pia-Maria Rutschmann-Schnyder Immobilien '),
    street: fill(70, 'Grosse Marktgasse Nebengebäude '),
    buildingNo: fill(16, '28b/2 '),
    postalCode: fill(16, '9400-CH-B '),
    town: fill(35, 'Rorschach am Bodensee '),
    country: 'CH',
  },
  referenceType: 'QRR',
  reference: '210000000003139471430009017',
  unstructuredMessage: fill(140, 'Rechnung R-2026-0042 Beratung Oktober, Zahlbar bis 30 Tage netto. '),
  ebillIdentifier: fill(88, 'ABCDEFGHIJ0123456789'),
});

/**
 * The full permitted character set of IG v2.3 section 4.1.1: Basic Latin, Latin-1 Supplement, Latin
 * Extended A, plus the five characters named individually (U+0218, U+0219, U+021A, U+021B, U+20AC).
 * Every one of these is at least two UTF-8 bytes above U+007F, which is precisely why the symbol has
 * to be encoded in BYTE mode over the UTF-8 form (section 4.1.1).
 */
const CHARSET = encodeSwissQrPayload({
  iban: 'CH5800791123000889012',
  creditor: {
    name: 'Müller & Söhne Zürich Gmbh',
    street: 'Rue de l\'Hôpital Genève',
    buildingNo: '12',
    postalCode: '1204',
    town: 'Genève',
    country: 'CH',
  },
  amountMinor: 12345,
  currency: 'EUR',
  debtor: {
    name: 'Ștefan Țăranu Łukasz Nováček',
    street: 'Grüningerstrasse',
    buildingNo: '3',
    postalCode: '8005',
    town: 'Zürich',
    country: 'CH',
  },
  referenceType: 'SCOR',
  reference: 'RF18539007547034',
  unstructuredMessage: 'Rechnung 42 € Ärzte Öl Übung àéîõü ÿ Æ Ø ß Ș ș Ț ț ŒœŠšŽžĀāĘęĲĳŊŋŦŧſ',
});

const CASES = [
  ['minimal (NON, no amount, no debtor)', MINIMAL],
  ['QRR reference, QR-IBAN, CHF', QRR_CHF],
  ['SCOR reference, plain IBAN, EUR', SCOR_EUR],
  ['NON reference, CHF, one Rappen', NON_CHF],
  ['maximal (every IG field cap used, 140-char AddInf, AltPmt)', MAXIMAL],
  ['full IG section 4.1.1 character set, real umlauts included', CHARSET],
];

// --- The scannability proof -----------------------------------------------------------------------

test('every payload shape round-trips byte-identically through the rendered SVG', () => {
  for (const [label, payload] of CASES) {
    const decoded = renderAndDecodeSvg(payload);
    assert.notEqual(decoded, null, `${label}: the rendered SVG did not decode`);
    assert.equal(decoded.text, payload, `${label}: decoded text differs`);
    assert.deepEqual(
      decoded.bytes,
      new TextEncoder().encode(payload),
      `${label}: decoded bytes differ from the payload's UTF-8 form`,
    );
  }
});

test('the mandated 7 x 7 mm cross does not stop the code scanning (IG v2.3 section 6.4.2)', () => {
  // The cross is drawn ON TOP of live modules, so this is the assertion that matters most: the
  // error correction level the guideline mandates has to absorb it. Level "M" restores about 15%
  // (IG section 2.5) and the symbol covers (7/46)^2 = 2.3% of the code's area.
  for (const [label, payload] of CASES) {
    assert.notEqual(
      renderSwissQrCodeSvg(payload, { cross: true }),
      renderSwissQrCodeSvg(payload, { cross: false }),
      `${label}: the cross was not drawn`,
    );

    const decoded = renderAndDecodeSvg(payload, { cross: true });
    assert.notEqual(decoded, null, `${label}: the code stopped scanning once the cross was applied`);
    assert.equal(decoded.text, payload, `${label}: the cross corrupted the payload`);
  }
});

test('the payload also survives the PDF content-stream form, cross and all', () => {
  // The PDF fragment is the form that reaches the customer on paper, so it gets the same proof as
  // the SVG rather than a "the operators look plausible" check.
  for (const [label, payload] of CASES) {
    const xPt = 60;
    const yPt = 120;
    const ops = renderSwissQrCodePdfOps(payload, { xPt, yPt });
    assert.ok(ops.startsWith('q\n') && ops.endsWith('\nQ'), `${label}: graphics state is not balanced`);

    const { moduleSizeMm } = buildSwissQrCodeGraphic(payload);
    const canvas = rasterizePdfOps(ops, {
      xPt,
      yPt,
      sizePt: swissQrGraphicSizePt(),
      moduleSizePt: moduleSizeMm * PT_PER_MM,
    });
    const decoded = decode(canvas);
    assert.notEqual(decoded, null, `${label}: the PDF fragment did not decode`);
    assert.equal(decoded.text, payload, `${label}: PDF fragment decoded to different text`);
  }
});

test('a payload at the guideline ceiling still scales, still carries the cross, and still scans', () => {
  // IG v2.3 section 6.2 puts the maximum at 997 characters and states the result is version 25 with
  // 117 x 117 modules. That is the hardest case in the whole range: the densest symbol, scaled down
  // to a fixed 46 mm, with a 7 mm cross punched through the middle of it.
  const filler = 'A'.repeat(SWISS_QR_MAX_PAYLOAD_CHARS - MINIMAL.length - 2);
  const payload = `${MINIMAL}\r\n${filler}`;
  assert.equal(payload.length, SWISS_QR_MAX_PAYLOAD_CHARS);

  const graphic = buildSwissQrCodeGraphic(payload);
  assert.equal(graphic.version, 25, 'IG section 6.2: 997 characters resolves to version 25');
  assert.equal(graphic.moduleCount, 117, 'IG section 6.2: version 25 is 117 x 117 modules');

  const decoded = renderAndDecodeSvg(payload);
  assert.notEqual(decoded, null, 'the densest permitted Swiss QR Code did not scan');
  assert.equal(decoded.text, payload);
});

test('a payload past the ceiling is refused, never silently truncated (IG v2.3 section 6.2)', () => {
  assert.throws(
    () => buildSwissQrCodeGraphic('A'.repeat(SWISS_QR_MAX_PAYLOAD_CHARS + 1)),
    (error) => error instanceof SwissQrPayloadTooLongError && error.charLength === 998,
  );
  // Section 6.2 says 997 CHARACTERS, but what actually keeps the symbol at version 25 is 997 BYTES,
  // and a real umlaut is two of them. A 997-character payload full of umlauts must be refused too,
  // or it would silently produce a version-26 symbol the guideline does not contemplate.
  const umlauts = 'ü'.repeat(600);
  assert.equal([...umlauts].length, 600);
  assert.equal(new TextEncoder().encode(umlauts).length, 1200);
  assert.throws(
    () => buildSwissQrCodeGraphic(umlauts),
    (error) => error instanceof SwissQrPayloadTooLongError && error.byteLength === 1200,
  );
});

// --- The mandated parameters ----------------------------------------------------------------------

test('the error correction level is "M" on every symbol (IG v2.3 section 6.1)', () => {
  // "The code generation must take place with error correction level 'M', which means a redundancy
  // or assurance of around 15%." (IG v2.3 section 6.1)
  for (const [label, payload] of CASES) {
    assert.equal(buildSwissQrCodeGraphic(payload).errorCorrectionLevel, 'M', label);
  }
});

test('the printed code is always 46 x 46 mm regardless of version (IG v2.3 section 6.4)', () => {
  // "The measurements of the Swiss QR Code for printing must always be 46 x 46 mm (without
  // surrounding quiet space) regardless of the Swiss QR Code version." (IG v2.3 section 6.4)
  assert.equal(SWISS_QR_CODE_SIZE_MM, 46);
  const versions = new Set();
  for (const [label, payload] of CASES) {
    const graphic = buildSwissQrCodeGraphic(payload);
    versions.add(graphic.version);
    assert.equal(graphic.codeSizeMm, 46, label);
    assert.equal(graphic.moduleSizeMm, 46 / graphic.moduleCount, label);
    assert.equal(graphic.moduleCount, graphic.version * 4 + 17, label);
  }
  assert.ok(versions.size > 1, 'the cases must span more than one symbol version to mean anything');

  // Without the quiet zone the graphic is exactly the code; the SVG's user units are millimetres.
  const svg = renderSwissQrCodeSvg(QRR_CHF, { quietZone: false });
  assert.match(svg, /width="46mm" height="46mm"/);
  assert.match(svg, /viewBox="0 0 46 46"/);
  assert.equal(swissQrGraphicSizeMm({ quietZone: false }), 46);
});

test('the quiet zone is the 5 mm border, and it clears the four-module ISO floor (IG sections 3.5.2 / 6.4.1)', () => {
  // "an unprinted border must be provided around the Swiss QR Code corresponding to the width of
  // four modules (corresponds to >= 1.6 mm). In the design recommendations, this border was expanded
  // to 5 mm" (IG v2.3 section 6.4.1); section 3.5.2 makes the 5 mm border binding on the payment
  // part: "the 5 mm wide border must be adhered to, so that the Swiss QR Code can be read".
  assert.equal(SWISS_QR_QUIET_ZONE_MM, 5);
  assert.equal(swissQrGraphicSizeMm(), 46 + 5 * 2);

  const svg = renderSwissQrCodeSvg(QRR_CHF);
  assert.match(svg, /width="56mm" height="56mm"/);
  assert.match(svg, /viewBox="0 0 56 56"/);

  // The first rectangle is the white ground covering the whole graphic: that IS the quiet zone, so
  // the border is unprinted by construction rather than by hope.
  const first = /<rect ([^/>]*)\/>/.exec(svg)[1];
  assert.match(first, /x="0" y="0" width="56" height="56" fill="#FFFFFF"/);

  // No dark rectangle may intrude into the 5 mm border on any side. The grid's colour AND its
  // coordinate system both live on the enclosing <g>: its rectangles carry no `fill` of their own,
  // so a scan for `fill="#000000"` would match none of them and this loop would run zero times while
  // still reporting green, and their coordinates are module numbers rather than millimetres. The
  // rectangles are therefore taken from the group and mapped through its transform, and the count is
  // asserted before any of them is used.
  //
  // The scale factor is written to eight decimals, so geometry through it carries that rounding: at
  // the far edge of the widest symbol it is under 1e-6 mm, a thousandth of what a printer resolves.
  // The tolerance is that rounding, not zero.
  const throughTheScale = 1e-6;
  const dark = darkSvgRects(svg);
  assert.ok(dark.length > 100, `a rendered symbol is hundreds of dark rectangles; found ${dark.length}`);
  for (const { x, y, w, h } of dark) {
    assert.ok(x >= 5 - throughTheScale, `dark rect at x=${x} intrudes into the quiet zone`);
    assert.ok(y >= 5 - throughTheScale, `dark rect at y=${y} intrudes into the quiet zone`);
    assert.ok(x + w <= 51 + throughTheScale, `dark rect ends at ${x + w}`);
    assert.ok(y + h <= 51 + throughTheScale, `dark rect ends at ${y + h}`);
  }

  // The 5 mm border is also always wider than the ISO/IEC 18004 four-module minimum, even at the
  // densest permitted version where a module is at its smallest.
  for (const [label, payload] of CASES) {
    const graphic = buildSwissQrCodeGraphic(payload);
    assert.ok(
      SWISS_QR_QUIET_ZONE_MM / graphic.moduleSizeMm >= SWISS_QR_MIN_QUIET_ZONE_MODULES,
      `${label}: 5 mm is under four modules`,
    );
  }
});

test('the recognition symbol is 7 x 7 mm, centred, in the published proportions (IG v2.3 section 6.4.2)', () => {
  // "the Swiss QR Code created for printout is overlaid with a cross logo in black and white,
  // measuring 7 x 7 mm." (IG v2.3 section 6.4.2). The internal proportions are measured from the
  // published CH-Kreuz_7mm.svg (SIX Download Centre, swiss-cross-graphic-en.zip): a 19.8-unit grid
  // standing for 7 mm, a black square inset by 1.41785 units (0.5 mm), and cross bars of 3.3 by 11
  // units. That artwork file is NOT redistributed; only its measurements are used.
  assert.equal(SWISS_QR_CROSS_SIZE_MM, 7);
  assert.equal(SWISS_CROSS.whiteBorderMm, 0.5);
  assert.equal(SWISS_CROSS.blackSquareMm, 6);
  assert.equal(SWISS_CROSS.whiteBorderMm * 2 + SWISS_CROSS.blackSquareMm, 7, 'the layers must total 7 mm');
  assert.ok(Math.abs(SWISS_CROSS.barThicknessMm - (7 * 3.3) / 19.8) < 1e-9);
  assert.ok(Math.abs(SWISS_CROSS.barLengthMm - (7 * 11) / 19.8) < 1e-9);
  // 11 : 3.3 is 10 : 3, which is the Swiss flag proportion (arms one sixth longer than wide).
  assert.ok(Math.abs(SWISS_CROSS.barLengthMm / SWISS_CROSS.barThicknessMm - 10 / 3) < 1e-9);
  assert.ok(SWISS_CROSS.barLengthMm < SWISS_CROSS.blackSquareMm, 'the cross must not touch the square');

  // Only the ground and the cross's four layers carry their own `fill` (the grid inherits its colour
  // from the group around it), so the self-coloured rectangles are exactly five, and the last four of
  // them are the symbol's layers. The count is asserted so the slice cannot silently take the wrong
  // rectangles if the emitted shape ever changes. Each layer must be centred on the 56 mm graphic.
  const svg = renderSwissQrCodeSvg(QRR_CHF);
  const selfColoured = selfColouredSvgRects(svg);
  assert.equal(selfColoured.length, 5, 'the white ground plus the four cross layers, and nothing else');
  const rects = selfColoured.slice(-4);

  // The SVG rounds coordinates to four decimals, so the centring tolerance is that rounding, not zero.
  const centred = (r) => Math.abs(r.x + r.w / 2 - 28) < 1e-3 && Math.abs(r.y + r.h / 2 - 28) < 1e-3;
  for (const r of rects) assert.ok(centred(r), `cross layer at ${r.x},${r.y} is not centred`);

  const [frame, square, bar1, bar2] = rects;
  assert.deepEqual([frame.w, frame.h, frame.dark], [7, 7, false], 'the white 7 x 7 frame');
  assert.deepEqual([square.w, square.h, square.dark], [6, 6, true], 'the black 6 x 6 square');
  assert.equal(bar1.dark, false);
  assert.equal(bar2.dark, false);
  assert.ok(Math.abs(bar1.w - SWISS_CROSS.barThicknessMm) < 1e-3 && Math.abs(bar1.h - SWISS_CROSS.barLengthMm) < 1e-3);
  assert.ok(Math.abs(bar2.w - SWISS_CROSS.barLengthMm) < 1e-3 && Math.abs(bar2.h - SWISS_CROSS.barThicknessMm) < 1e-3);
});

test('the 0.4 mm print floor is reported, not silently violated (IG v2.3 section 6.3)', () => {
  // "a minimum module size of 0.4 mm is required when printing" (IG v2.3 section 6.3), while section
  // 6.4 fixes the printed size at 46 mm for EVERY version and section 6.2 blesses version 25. Those
  // cannot both hold: 46 / 117 = 0.393 mm. The guideline's 46 mm rule is unconditional, so the
  // renderer obeys it and the tension is REPORTED rather than hidden behind a refusal or a silent
  // pass. Version 24 (113 modules) is the last one that clears the floor.
  assert.equal(SWISS_QR_MIN_MODULE_SIZE_MM, 0.4);
  assert.ok(46 / 113 >= 0.4, 'version 24 clears the floor');
  assert.ok(46 / 117 < 0.4, 'version 25 does not');

  assert.equal(buildSwissQrCodeGraphic(QRR_CHF).meetsMinimumModuleSize, true);

  const dense = `${MINIMAL}\r\n${'A'.repeat(SWISS_QR_MAX_PAYLOAD_CHARS - MINIMAL.length - 2)}`;
  const graphic = buildSwissQrCodeGraphic(dense);
  assert.equal(graphic.version, 25);
  assert.equal(graphic.meetsMinimumModuleSize, false, 'the flag must report the version-25 tension');
});

/**
 * Read a PDF fragment back into page points: the ground rectangle, the `cm` matrix, and every
 * rectangle drawn under it mapped through that matrix.
 *
 * The fragment draws its module grid under a transform whose unit is one module, which is what keeps
 * an invoice from carrying tens of kilobytes of four-decimal coordinates. That means a placement
 * check cannot read coordinates off the operators any more: it has to apply the matrix, which is
 * exactly what a PDF reader does.
 *
 * It also BATCHES: the module grid is one path of `re` operators closed by a single `f`, while the
 * ground and the recognition symbol still fill per rectangle. So this reads both forms, the way any
 * PDF consumer has to: `re` appends to the current path and `f` paints whatever has accumulated.
 */
function readPdfFragment(ops) {
  const ground = /1 1 1 rg (-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+) re f/.exec(ops);
  assert.notEqual(ground, null, 'the fragment must describe its own position with a ground rectangle');

  const cm = /^(-?[\d.]+) 0 0 (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm$/m.exec(ops);
  assert.notEqual(cm, null, 'the module grid must be drawn under an axis-aligned transform');
  const [a, d, e, f] = cm.slice(1).map(Number);

  const drawn = [];
  let dark = false;
  let underTransform = false;
  let path = [];
  const paint = () => {
    for (const [x, y, w, h] of path) {
      // Row `y` runs DOWNWARD from the origin (`d` is negative), so its lower edge in page points is
      // the far one.
      drawn.push({ dark, x: e + a * x, y: f + d * (y + h), w: a * w, h: Math.abs(d) * h, moduleX: x, moduleY: y, moduleW: w, moduleH: h });
    }
    path = [];
  };
  for (const line of ops.split('\n')) {
    if (line === '0 0 0 rg') dark = true;
    else if (line === '1 1 1 rg') dark = false;
    else if (line.endsWith(' cm')) underTransform = true;
    else if (line === 'f') {
      if (underTransform) paint();
      path = [];
    } else {
      const rect = /^(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+) re( f)?$/.exec(line);
      if (rect === null || !underTransform) continue;
      path.push(rect.slice(1, 5).map(Number));
      // A rectangle written `x y w h re f` paints on its own line; one written `x y w h re` waits
      // for the `f` that closes the batched path.
      if (rect[5] !== undefined) paint();
    }
  }
  assert.ok(drawn.length > 0, 'the fragment drew nothing under its transform');
  assert.equal(path.length, 0, 'every rectangle the fragment builds must actually be filled');

  return {
    ground: { x: Number(ground[1]), y: Number(ground[2]), w: Number(ground[3]), h: Number(ground[4]) },
    matrix: { a, d, e, f },
    drawn,
  };
}

test('the PDF fragment places the graphic exactly where the caller asked, at 46 mm', () => {
  const ops = renderSwissQrCodePdfOps(QRR_CHF, { xPt: 100, yPt: 200, quietZone: false });
  const sizePt = 46 * PT_PER_MM;
  assert.ok(Math.abs(sizePt - 130.3937) < 1e-3, '46 mm is 130.394 pt');
  assert.equal(swissQrGraphicSizePt({ quietZone: false }), sizePt);

  const { ground, matrix, drawn } = readPdfFragment(ops);
  assert.ok(Math.abs(ground.x - 100) < 1e-6 && Math.abs(ground.y - 200) < 1e-6, 'the ground sits at the origin given');
  assert.ok(Math.abs(ground.w - sizePt) < 1e-3 && Math.abs(ground.h - sizePt) < 1e-3);

  // The transform's unit IS one module, and it flips y so that row 0 is the TOP row.
  const { moduleCount, moduleSizeMm } = buildSwissQrCodeGraphic(QRR_CHF);
  assert.ok(Math.abs(matrix.a - moduleSizeMm * PT_PER_MM) < 1e-4, 'one user unit is one module');
  assert.ok(Math.abs(matrix.d + matrix.a) < 1e-9, 'y is flipped, not rescaled');
  assert.ok(Math.abs(matrix.e - 100) < 1e-4 && Math.abs(matrix.f - (200 + sizePt)) < 1e-4, 'the origin is the top-left');
  assert.ok(Math.abs(matrix.a * moduleCount - sizePt) < 1e-3, 'the module grid spans exactly 46 mm');

  // The `cm` matrix is written to six decimals, so geometry drawn through it carries that rounding:
  // under 1e-4 pt across the widest symbol, which is 4e-5 mm, or a ten-thousandth of one module.
  // The ground rectangle above is still held to exactness, because it is written in points directly.
  const throughTheMatrix = 1e-3;
  for (const r of drawn) {
    assert.ok(
      r.x >= 100 - throughTheMatrix && r.y >= 200 - throughTheMatrix,
      'nothing is drawn left of or below the origin',
    );
    assert.ok(
      r.x + r.w <= 100 + sizePt + throughTheMatrix && r.y + r.h <= 200 + sizePt + throughTheMatrix,
      'nothing overflows 46 mm',
    );
  }
});

test('the merged rectangles cover exactly the dark modules, and never a module more', () => {
  // The fragment is small because the dark modules are merged along each row and then down the
  // columns. That is a rewrite of the symbol's geometry, so it is checked the only way worth
  // checking: rebuild the module matrix from the emitted rectangles and hold it against the encoder
  // cell by cell. A merge that swallowed one light module, or dropped one dark one, dies here rather
  // than at a bank counter, and it dies with a coordinate rather than a decode failure.
  for (const [label, payload] of CASES) {
    const graphic = buildSwissQrCodeGraphic(payload);
    const n = graphic.moduleCount;
    // The cross is off: it is painted OVER the grid by design, so it would legitimately disagree.
    const { drawn } = readPdfFragment(renderSwissQrCodePdfOps(payload, { xPt: 0, yPt: 0, cross: false }));

    const rebuilt = Array.from({ length: n }, () => new Array(n).fill(false));
    for (const r of drawn) {
      assert.equal(r.dark, true, `${label}: only dark rectangles belong to the module grid`);
      assert.ok(Number.isInteger(r.moduleX) && Number.isInteger(r.moduleY), `${label}: module coordinates are whole`);
      assert.ok(Number.isInteger(r.moduleW) && Number.isInteger(r.moduleH), `${label}: module extents are whole`);
      for (let row = r.moduleY; row < r.moduleY + r.moduleH; row += 1) {
        for (let col = r.moduleX; col < r.moduleX + r.moduleW; col += 1) {
          assert.ok(row < n && col < n, `${label}: a rectangle ran off the symbol at ${col},${row}`);
          assert.equal(rebuilt[row][col], false, `${label}: module ${col},${row} was painted twice`);
          rebuilt[row][col] = true;
        }
      }
    }

    for (let row = 0; row < n; row += 1) {
      for (let col = 0; col < n; col += 1) {
        assert.equal(rebuilt[row][col], graphic.modules[row][col], `${label}: module ${col},${row} differs`);
      }
    }

    // And the merging has to actually merge, or the assertion above would pass on a naive renderer
    // while the file size regressed back to one rectangle per module.
    const cells = graphic.modules.flat().filter(Boolean).length;
    assert.ok(drawn.length < cells / 2, `${label}: ${drawn.length} rectangles for ${cells} dark modules is not merged`);
  }
});

// --- The harness that proves scannability has to be falsifiable itself ---------------------------

/** Rasterize and decode an SVG STRING, so a deliberately tampered one can be put to the decoder. */
function decodeSvgString(svg, payload) {
  const { moduleSizeMm } = buildSwissQrCodeGraphic(payload);
  return decode(rasterizeSvgRects(svg, { moduleSizeMm }));
}

/**
 * Rewrite the module grid group: a different colour on it, a colour on each rectangle inside it, or
 * the group's `transform` dropped. The transform stays put unless `dropTransform` asks for it, since
 * the rectangles inside are in module units and are unreadable without it.
 */
function recolourGrid(svg, { group, rect, dropFill = false, dropTransform = false } = {}) {
  assert.match(svg, GRID_GROUP, 'the module grid must be one group carrying the dark fill and the transform');
  return svg.replace(GRID_GROUP, (_whole, tx, ty, scale, inner) => {
    const rects = rect === undefined ? inner : inner.replaceAll('/>', ` fill="${rect}"/>`);
    const fill = dropFill ? '' : ` fill="${group ?? '#000000'}"`;
    const transform = dropTransform ? '' : ` transform="translate(${tx} ${ty}) scale(${scale})"`;
    return `<g${fill}${transform}>${rects}</g>`;
  });
}

test('the decode harness reads the hoisted fill, and says so by failing when the fill is wrong', () => {
  // This test exists because the size win has a trap under it. The grid's colour was moved onto the
  // enclosing <g>, and a rasterizer that read `fill` off each <rect> would now find none, paint the
  // whole symbol light, and hand the decoder a blank canvas. Every scannability assertion in this
  // file would keep passing while proving nothing at all. So the inheritance is tested in both
  // directions, and each case is a decode that MUST fail.
  const svg = renderSwissQrCodeSvg(QRR_CHF);

  // The control. Without this the three refusals below would be satisfied by a harness that simply
  // never decodes anything.
  const clean = decodeSvgString(svg, QRR_CHF);
  assert.notEqual(clean, null, 'the untampered SVG must decode, or nothing below means anything');
  assert.equal(clean.text, QRR_CHF);

  // 1. The colour is taken from the ancestor: recolour the GROUP and the symbol goes white. If the
  //    harness ignored the group, this would still decode.
  assert.equal(
    decodeSvgString(recolourGrid(svg, { group: '#FFFFFF' }), QRR_CHF),
    null,
    'a white module grid decoded, so the harness is not reading the group at all',
  );

  // 2. A rectangle's own `fill` overrides what it inherits: black group, white rectangles, no symbol.
  //    If the harness let the ancestor win, this would still decode.
  assert.equal(
    decodeSvgString(recolourGrid(svg, { rect: '#FFFFFF' }), QRR_CHF),
    null,
    'the parent group overrode a per-rectangle fill, which is backwards',
  );

  // 3. The override works in the other direction too: a white group whose rectangles each declare
  //    black still scans, so case 1 failed on the colour and not on the tampering itself.
  const overridden = decodeSvgString(recolourGrid(svg, { group: '#FFFFFF', rect: '#000000' }), QRR_CHF);
  assert.notEqual(overridden, null, 'a per-rectangle fill must beat the group it sits in');
  assert.equal(overridden.text, QRR_CHF);

  // 4. And with no `fill` anywhere on the path the rectangles inherit nothing, so SVG's initial
  //    value applies and it is black. That is what a browser does with the same markup, which is the
  //    point: the harness models the consumer, not a convention of its own.
  const noFill = decodeSvgString(recolourGrid(svg, { dropFill: true }), QRR_CHF);
  assert.notEqual(noFill, null, "SVG's initial fill is black, so a grid that sets none still paints dark");
  assert.equal(noFill.text, QRR_CHF);
});

test('the decode harness applies the module transform, and says so by failing without it', () => {
  // The other half of the same trap. The grid's coordinates are module numbers, meaningful only
  // under the transform on the group around them, and a harness that read them as millimetres would
  // paint the whole symbol at 1/46 scale in the corner of the graphic. That must be a decode
  // failure, not a quiet pass.
  const svg = renderSwissQrCodeSvg(QRR_CHF);
  assert.notEqual(decodeSvgString(svg, QRR_CHF), null, 'the control: the untampered SVG decodes');
  assert.equal(
    decodeSvgString(recolourGrid(svg, { dropTransform: true }), QRR_CHF),
    null,
    'the grid decoded without its transform, so the harness is reading module numbers as millimetres',
  );

  // A transform the harness cannot apply must be LOUD rather than ignored. Ignoring one would move
  // the symbol and then report whatever the decoder made of the wreckage.
  assert.throws(
    () => decodeSvgString(svg.replace('scale(', 'rotate(90) scale('), QRR_CHF),
    /svg_unsupported_transform:rotate/,
  );
});

test('the SVG module grid covers exactly the dark modules, in whole module units', () => {
  // The PDF fragment gets this check on its own operators; the SVG now draws in the same module
  // units, so it earns the same one. Rebuild the matrix from the emitted rectangles and hold it
  // against the encoder cell by cell: a transform or a merge that swallowed a light module, or
  // dropped a dark one, dies here with a coordinate rather than as a decode failure.
  for (const [label, payload] of CASES) {
    const graphic = buildSwissQrCodeGraphic(payload);
    const n = graphic.moduleCount;
    // The cross is off: it is painted OVER the grid by design, so it would legitimately disagree.
    const rects = darkSvgRects(renderSwissQrCodeSvg(payload, { cross: false }));
    assert.ok(rects.length > 0, `${label}: the grid drew nothing`);

    const rebuilt = Array.from({ length: n }, () => new Array(n).fill(false));
    for (const r of rects) {
      for (let row = r.moduleY; row < r.moduleY + r.moduleH; row += 1) {
        for (let col = r.moduleX; col < r.moduleX + r.moduleW; col += 1) {
          assert.ok(row < n && col < n, `${label}: a rectangle ran off the symbol at ${col},${row}`);
          assert.equal(rebuilt[row][col], false, `${label}: module ${col},${row} was painted twice`);
          rebuilt[row][col] = true;
        }
      }
    }
    for (let row = 0; row < n; row += 1) {
      for (let col = 0; col < n; col += 1) {
        assert.equal(rebuilt[row][col], graphic.modules[row][col], `${label}: module ${col},${row} differs`);
      }
    }

    // And the SVG must draw the SAME rectangles the PDF does, since both come off `darkRects`.
    const cells = graphic.modules.flat().filter(Boolean).length;
    assert.ok(rects.length < cells / 2, `${label}: ${rects.length} rectangles for ${cells} dark modules is not merged`);
  }
});

test('the SVG carries an accessible name the caller controls, escaped', () => {
  // The engine has no locale, so the Studio passes its own translated string; the default is a
  // neutral fallback rather than a hardcoded German or English label baked into the engine.
  assert.match(renderSwissQrCodeSvg(MINIMAL), /role="img" aria-label="Swiss QR Code"/);
  const custom = renderSwissQrCodeSvg(MINIMAL, { ariaLabel: 'QR-Rechnung "Zahlteil" & Code' });
  assert.match(custom, /aria-label="QR-Rechnung &quot;Zahlteil&quot; &amp; Code"/);
  assert.match(custom, /<title>QR-Rechnung &quot;Zahlteil&quot; &amp; Code<\/title>/);
});

test('the graphic is a pure function of the payload', () => {
  // Determinism is what lets a reissued PDF and a Studio preview show the same code, and what lets
  // a golden fixture mean anything at all.
  assert.equal(renderSwissQrCodeSvg(QRR_CHF), renderSwissQrCodeSvg(QRR_CHF));
  assert.equal(
    renderSwissQrCodePdfOps(QRR_CHF, { xPt: 1, yPt: 2 }),
    renderSwissQrCodePdfOps(QRR_CHF, { xPt: 1, yPt: 2 }),
  );
  assert.notEqual(renderSwissQrCodeSvg(QRR_CHF), renderSwissQrCodeSvg(SCOR_EUR));
});
