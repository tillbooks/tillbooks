// A11: one issued invoice must run the QR ENCODER exactly once, and must draw the same symbol it
// drew when it ran it twice.
//
// The defect this pins is the engine-side twin of the one the Studio panel had. `resolveQrGraphic`
// built the symbol once with `buildSwissQrCodeGraphic` purely to REPORT its measurements (version,
// module count, module size, the IG 6.3 density flag) and then handed `renderSwissQrCodePdfOps` the
// PAYLOAD, whose first statement built the very same symbol all over again. Two full ISO/IEC 18004
// encodes per invoice: one whose modules were thrown away after a division, one that was drawn.
//
// This costs more than the panel's copy did. The panel encodes on a page view; this encodes on every
// issued invoice and on every PDF re-render, which is the path an emailed invoice goes through.
//
// WHY THE COUNT IS TAKEN AT `encodeQrByteMode`. That is where the cost is: the rest of the build is
// a division and an object literal. Counting the real encoder also means a future "cheap second
// call" (a memo, a cache) shows up here as a shape change rather than passing silently.
//
// THE ENCODER IS COUNTED, NEVER STUBBED. `test/fixtures/count-qr-encodes.mjs` renames the real
// implementation and puts a wrapper in its place that increments a counter and delegates to it, so
// every drawing assertion below is an assertion about the engine's own output. The alternative, a
// fake symbol, would have made the "the picture did not move" tests assertions about the fake.
//
// AND THE PICTURE IS PINNED INDEPENDENTLY of the count. Removing an encode is only a fix if the one
// that survives draws the same code, so the decoded payload and the module grid are held against
// hashes captured BEFORE the change: the QR is pulled back out of the PDF's own content stream,
// rasterized, and read by `jsqr` (Apache-2.0, a decoder TILL did not write).
//
// Nothing here is a claim of SIX certification. Structural conformance plus a decoder round trip is
// the claim; scanning against the SIX reference validator is a process with SIX and stays open.

import test from 'node:test';
import assert from 'node:assert/strict';
import module from 'node:module';
import { createHash } from 'node:crypto';

// The hook must be registered BEFORE anything under `dist/` is loaded, which is why every engine
// import in this file is dynamic: static imports are evaluated ahead of the module body.
module.register(new URL('../fixtures/count-qr-encodes.mjs', import.meta.url).href);

const { SqliteStore } = await import('../../dist/core/store/sqlite-store.js');
const { makeContext } = await import('../../dist/core/context.js');
const { fixedClock } = await import('../../dist/core/clock.js');
const { sequenceIdGen } = await import('../../dist/core/ids.js');
const { createWorkspace, setCreditorProfile } = await import('../../dist/core/setup/index.js');
const { seedTaxCodes } = await import('../../dist/core/vat/index.js');
const { createDocument, issueInvoice, renderInvoicePdf, buildSwissQrCodeGraphic, PT_PER_MM } =
  await import('../../dist/core/sales/index.js');
const { rasterizePdfOps, decode } = await import('../fixtures/qr-decode.mjs');

const AT = '2026-07-16T00:00:00.000Z';

/**
 * The symbol the CHF wiring invoice has always produced, captured from the DOUBLE-encoding code
 * before a line of it was touched.
 *
 * `payloadSha256` hashes the BYTES the decoder pulled out of the printed symbol, not a string the
 * engine handed over, so it is a fact about the picture rather than about a variable. `grid` hashes
 * the module matrix rebuilt from those decoded bytes, one row per line, `1` for a dark module: two
 * codes carrying the same text but a different mask or version would differ here.
 */
const BASELINE = {
  decodedByteLength: 297,
  payloadSha256: '59e73cfc5e2a146fc9c3aa4a21614be2c266b3a6eb1f01127d8cc2d025cacbed',
  grid: 'ad0e407f8ad5ac7adfaa1896613ce6158ea1671c7eb0d31d581c7099f6855bc9',
};

function readEncodeCount() {
  return globalThis.__tillQrEncodeCount ?? 0;
}

function resetEncodeCount() {
  globalThis.__tillQrEncodeCount = 0;
}

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const workspaceId = createWorkspace({ store, clock, ids }, { name: 'Nomadik GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  seedTaxCodes(ctx);
  store.db
    .prepare("UPDATE workspace SET vat_method = 'effektiv', vat_accounting = 'soll' WHERE id = ?")
    .run(workspaceId);
  setCreditorProfile(ctx, {
    creditorName: 'Nomadik GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
  store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, address_street, address_house_no, address_zip, address_city, address_country, email, default_currency, payment_terms_days, created_at)
       VALUES ('ct_1', ?, 'customer', 'Muster AG', 'Musterstrasse', '5', '3000', 'Bern', 'CH', 'billing@muster.example', 'CHF', 30, ?)`,
    )
    .run(workspaceId, AT);
  return { ctx, store };
}

function issuedInvoice(ctx, key = 'k1') {
  const doc = createDocument(ctx, {
    type: 'invoice',
    contactId: 'ct_1',
    currency: 'CHF',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
  });
  assert.ok(doc.ok, JSON.stringify(doc));
  const issue = issueInvoice(ctx, { invoiceId: doc.document.id, idempotencyKey: key });
  assert.ok(issue.ok, JSON.stringify(issue));
  return doc.document.id;
}

/** The single content stream of the minimal one-page PDF the engine assembles. */
function contentStreamOf(pdfBase64) {
  const bytes = Buffer.from(pdfBase64, 'base64').toString('latin1');
  const start = bytes.indexOf('stream\n');
  const end = bytes.indexOf('\nendstream');
  assert.ok(start > 0 && end > start, 'the PDF must carry a content stream');
  return bytes.slice(start + 'stream\n'.length, end);
}

/**
 * Read the QR back out of the PDF the way a scanner would: find the fragment by its own white
 * ground, paint its operators, and hand the pixels to an independent decoder.
 */
function decodeFromPdf(pdfBase64, moduleSizeMm) {
  const content = contentStreamOf(pdfBase64);
  const background = /1 1 1 rg (-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+) re f/.exec(content);
  assert.notEqual(background, null, 'the PDF content stream must carry the QR graphic operators');
  const [, x, y, w, h] = background;
  assert.equal(w, h, 'the graphic is square');
  const read = decode(
    rasterizePdfOps(content, {
      xPt: Number(x),
      yPt: Number(y),
      sizePt: Number(w),
      moduleSizePt: moduleSizeMm * PT_PER_MM,
    }),
  );
  assert.notEqual(read, null, 'the QR on the PDF must be readable by an independent decoder');
  return read;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** One row per line, `1` for a dark module. The serialization the baseline hash was taken with. */
function gridHash(graphic) {
  return sha256(graphic.modules.map((row) => row.map((cell) => (cell ? '1' : '0')).join('')).join('\n'));
}

test('renderInvoicePdf runs the QR encoder exactly once', () => {
  const { ctx } = setup();
  const invoiceId = issuedInvoice(ctx);

  resetEncodeCount();
  const pdf = renderInvoicePdf(ctx, invoiceId);

  assert.ok(pdf.ok, JSON.stringify(pdf));
  assert.equal(pdf.pdf.hasQrBill, true, 'this invoice has a drawn payment part, so the encoder ran');
  assert.equal(readEncodeCount(), 1, 'one issued invoice, one encode');
});

test('the measurements the PDF reports cost no second encode', () => {
  // `qrGraphic` is the whole reason a symbol was built ahead of the render. Reporting it must come
  // out of the SAME symbol that was drawn, not out of a second one, and it must still be the real
  // measurements rather than a placeholder: version 13 at 69 modules is 46/69 = 0.667 mm, which
  // clears the IG 6.3 print floor. The flag is reported, never enforced, because IG 6.4 fixes the
  // printed size at 46 mm unconditionally.
  const { ctx } = setup();
  const invoiceId = issuedInvoice(ctx);

  resetEncodeCount();
  const pdf = renderInvoicePdf(ctx, invoiceId);
  const drawn = decodeFromPdf(pdf.pdf.base64, pdf.pdf.qrGraphic.moduleSizeMm);

  assert.equal(readEncodeCount(), 1);
  assert.deepEqual(
    {
      version: pdf.pdf.qrGraphic.version,
      moduleCount: pdf.pdf.qrGraphic.moduleCount,
      meetsMinimumModuleSize: pdf.pdf.qrGraphic.meetsMinimumModuleSize,
    },
    { version: 13, moduleCount: 69, meetsMinimumModuleSize: true },
  );
  // The reported measurements describe the symbol that is actually ON the page: rebuilding from the
  // DECODED text has to land on the same version and module count.
  const rebuilt = buildSwissQrCodeGraphic(drawn.text);
  assert.equal(rebuilt.version, pdf.pdf.qrGraphic.version);
  assert.equal(rebuilt.moduleCount, pdf.pdf.qrGraphic.moduleCount);
  assert.equal(rebuilt.moduleSizeMm, pdf.pdf.qrGraphic.moduleSizeMm);
});

test('the drawn symbol is byte for byte the one the double encode produced', () => {
  // The point of removing an encode is that the surviving one draws exactly what was drawn before.
  // These three hashes were captured from the double-encoding code and are not allowed to move.
  const { ctx } = setup();
  const invoiceId = issuedInvoice(ctx);

  const pdf = renderInvoicePdf(ctx, invoiceId);
  const drawn = decodeFromPdf(pdf.pdf.base64, pdf.pdf.qrGraphic.moduleSizeMm);

  assert.equal(drawn.bytes.length, BASELINE.decodedByteLength);
  assert.equal(sha256(Buffer.from(drawn.bytes)), BASELINE.payloadSha256);
  assert.equal(gridHash(buildSwissQrCodeGraphic(drawn.text)), BASELINE.grid);
});

test('a re-render encodes once more, not twice more', () => {
  // Re-rendering is the common case (an invoice is fetched, mailed, fetched again), and it is where
  // the saving compounds. Counting across two renders also rules out the opposite defect: a cache
  // that made the second render skip the encode would return a stale symbol for a corrected invoice.
  const { ctx } = setup();
  const invoiceId = issuedInvoice(ctx);

  resetEncodeCount();
  const first = renderInvoicePdf(ctx, invoiceId);
  const second = renderInvoicePdf(ctx, invoiceId);

  assert.equal(readEncodeCount(), 2, 'two renders, two encodes');
  assert.equal(second.pdf.base64, first.pdf.base64, 'and the same PDF both times');
});
