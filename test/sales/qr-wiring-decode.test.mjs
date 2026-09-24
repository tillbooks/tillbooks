// A11: the WIRING guard. Is the scannable Swiss QR Code actually on the artifact a customer gets,
// and does the number inside it match the BOOKS?
//
// The encoder and both renderers were built, tested and then called by nothing, so every issued
// invoice printed "Swiss QR-bill: payment part enclosed" over a page with no code on it. A unit test
// of a renderer nobody calls stays green through exactly that defect, which is why this suite starts
// from `issueInvoice` and ends at a decoder, with no shortcut in between:
//
//   issue -> renderInvoicePdf -> pull the content stream OUT of the PDF bytes -> rasterize the
//   operators -> decode with `jsqr` (Apache-2.0, a decoder TILL did not write) -> compare the
//   decoded `Amt` and `Ccy` against the POSTED JOURNAL ROWS read back out of SQLite.
//
// The comparison target is the point. Checking a QR against the variable that produced it proves
// only that a variable was copied; this repo has shipped six money-path defects that would have
// survived that test. The books are the independent witness: `journal_line.debit_minor` on the
// Debitoren 1100 row is what the ledger says the customer owes, and the scanned `Amt` is what the
// customer's bank will actually move. Those two numbers agreeing is the whole invariant.
//
// The FX case is here because getting it backwards is a live risk, not a hypothetical: a EUR invoice
// posts a CHF base amount on the very same row as the EUR transaction amount, and a QR that carried
// the base amount would scan cleanly, look right in every review, and collect the wrong sum in the
// wrong currency. So the EUR case asserts the decoded values are the TRANSACTION pair and asserts
// they differ from the base pair, which is what makes the assertion capable of failing.
//
// Nothing here is a claim of SIX certification. Structural conformance against the cited guideline
// plus a proven decoder round trip is the claim; scanning against the SIX reference validator is a
// process with SIX and stays open.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace, setCreditorProfile } from '../../dist/core/setup/index.js';
import { seedTaxCodes } from '../../dist/core/vat/index.js';
import {
  createDocument,
  issueInvoice,
  buildQrBill,
  renderInvoicePdf,
  renderSwissQrCodeSvg,
  buildSwissQrCodeGraphic,
  PT_PER_MM,
  SWISS_QR_CODE_SIZE_MM,
  SWISS_QR_QUIET_ZONE_MM,
} from '../../dist/core/sales/index.js';
import { recordExchangeRate } from '../../dist/core/fx/index.js';
import { rasterizeSvgRects, rasterizePdfOps, decode } from '../fixtures/qr-decode.mjs';

const AT = '2026-07-16T00:00:00.000Z';
/** The ESTV daily selling rate used throughout: 1 EUR = 0.9412 CHF (MWSTV Art. 45 Abs. 3). */
const EUR_CHF = '0.9412';

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Nomadik GmbH' }).workspaceId;
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
  return { ctx, store, workspaceId };
}

/** Issue an invoice in `currency` and hand back its id. The rate is recorded only when one is needed. */
function issuedInvoice(ctx, { currency = 'CHF', unitPriceMinor = 100000, key = 'k1' } = {}) {
  if (currency !== 'CHF') {
    const rate = recordExchangeRate(ctx, {
      baseCurrency: currency,
      rate: EUR_CHF,
      asOf: AT.slice(0, 10),
      source: 'manual',
      method: 'daily',
      provenance: 'ESTV Tageskurs Verkauf (MWSTV Art. 45 Abs. 3)',
      idempotencyKey: `fx-${currency}-${key}`,
    });
    assert.ok(rate.ok, JSON.stringify(rate));
  }
  const doc = createDocument(ctx, {
    type: 'invoice',
    contactId: 'ct_1',
    currency,
    lines: [{ description: 'Beratung', unitPriceMinor, taxCode: 'UST81' }],
  });
  assert.ok(doc.ok, JSON.stringify(doc));
  const issue = issueInvoice(ctx, { invoiceId: doc.document.id, idempotencyKey: key });
  assert.ok(issue.ok, JSON.stringify(issue));
  return doc.document.id;
}

/**
 * What the BOOKS say the customer owes, read straight out of SQLite.
 *
 * The Debitoren 1100 debit is the receivable, and §H-FX puts both sides of it on the same row:
 * `debit_minor` + `currency` are the TRANSACTION pair (what the customer is billed and will pay),
 * `base_debit_minor` is the same money converted into the workspace's base currency. The QR must
 * carry the first pair. Nothing here reads `document.total_minor` or any engine return value: this
 * is deliberately the independent witness, so the assertion can actually fail.
 */
function postedReceivable(store, invoiceId) {
  const entryId = store.db.prepare('SELECT posted_entry_id FROM document WHERE id = ?').get(invoiceId)
    .posted_entry_id;
  assert.notEqual(entryId, null, 'an issued invoice must have posted');
  const rows = store.db
    .prepare(
      `SELECT l.debit_minor, l.base_debit_minor, l.currency, l.fx_rate
         FROM journal_line l JOIN account a ON a.id = l.account_id
        WHERE l.entry_id = ? AND a.number = '1100' AND l.debit_minor > 0`,
    )
    .all(entryId);
  assert.equal(rows.length, 1, 'exactly one receivable line per issued invoice');
  return { entryId, ...rows[0] };
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
 * Decode the QR out of the PDF's own content stream.
 *
 * The fragment's origin and edge are read back from its FIRST rectangle, which is the white
 * background covering the whole graphic. That keeps the test from needing the engine's private
 * placement constants, and it means a fragment that failed to describe itself would fail here rather
 * than be papered over by a hardcoded position.
 */
function decodeFromPdf(pdfBase64, moduleSizeMm) {
  const content = contentStreamOf(pdfBase64);
  const background = /1 1 1 rg (-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+) re f/.exec(content);
  assert.notEqual(background, null, 'the PDF content stream must carry the QR graphic operators');
  const [, x, y, w, h] = background;
  assert.equal(w, h, 'the graphic is square');
  assert.equal(
    Math.round(Number(w) * 1000),
    Math.round((SWISS_QR_CODE_SIZE_MM + SWISS_QR_QUIET_ZONE_MM * 2) * PT_PER_MM * 1000),
    'IG 6.4 / 6.4.1: 46 mm of code inside a 5 mm border, whatever the version',
  );
  return decode(
    rasterizePdfOps(content, {
      xPt: Number(x),
      yPt: Number(y),
      sizePt: Number(w),
      moduleSizePt: moduleSizeMm * PT_PER_MM,
    }),
  );
}

/** Decode the QR out of the SVG the Studio panel renders, by painting the SVG's own rectangles. */
function decodeFromSvg(payload, ariaLabel) {
  const svg = renderSwissQrCodeSvg(payload, { ariaLabel });
  const { moduleSizeMm } = buildSwissQrCodeGraphic(payload);
  return { svg, read: decode(rasterizeSvgRects(svg, { moduleSizeMm })) };
}

/** IG section 4.2.2: the payload is CRLF-separated, `Amt` is element 18 and `Ccy` element 19. */
function amountAndCurrencyOf(payload) {
  const elements = payload.split('\r\n');
  assert.equal(elements[0], 'SPC', 'the decoded text must be a Swiss Payments Code');
  assert.equal(elements[30], 'EPD', 'the trailer anchors the element indices');
  return { amt: elements[18], ccy: elements[19] };
}

/**
 * The whole chain for one currency: issue, render, decode the RENDERED graphic in both forms, and
 * hold every decoded number against the posted journal rows.
 */
function assertScannedAgainstTheBooks(t, { currency, expectedAmt }) {
  const { ctx, store } = setup();
  const invoiceId = issuedInvoice(ctx, { currency, key: `wire-${currency}` });
  const booked = postedReceivable(store, invoiceId);

  const pdf = renderInvoicePdf(ctx, invoiceId);
  assert.ok(pdf.ok, JSON.stringify(pdf));
  assert.equal(pdf.pdf.hasQrBill, true);
  assert.equal(pdf.pdf.qrUnavailable, null);
  assert.notEqual(pdf.pdf.qrGraphic, null, 'a drawn symbol reports its measurements');

  const scannedPdf = decodeFromPdf(pdf.pdf.base64, pdf.pdf.qrGraphic.moduleSizeMm);
  assert.notEqual(scannedPdf, null, 'the QR on the PDF must be readable by an independent decoder');

  // The payment panel and the PDF must show the customer the same code, byte for byte.
  const panel = buildQrBill(ctx, invoiceId);
  assert.ok(panel.ok, JSON.stringify(panel));
  assert.equal(scannedPdf.text, panel.qr.swissQrPayload, 'the scanned PDF payload IS the panel payload');
  assert.deepEqual(
    Array.from(scannedPdf.bytes),
    Array.from(new TextEncoder().encode(panel.qr.swissQrPayload)),
    'byte-identical, not merely equal as strings',
  );

  const { svg, read: scannedSvg } = decodeFromSvg(panel.qr.swissQrPayload, 'Swiss QR-bill payment code');
  assert.notEqual(scannedSvg, null, 'the QR the Studio renders must be readable too');
  assert.equal(scannedSvg.text, scannedPdf.text, 'the two rendered forms carry the same code');
  assert.match(svg, /aria-label="Swiss QR-bill payment code"/, 'a payment instrument needs an accessible name');

  // THE assertion: the scanned number against the posted number.
  for (const [form, scanned] of [
    ['pdf', scannedPdf],
    ['svg', scannedSvg],
  ]) {
    const { amt, ccy } = amountAndCurrencyOf(scanned.text);
    assert.equal(amt, expectedAmt, `${form}: the scanned amount`);
    assert.equal(
      Math.round(Number(amt) * 100),
      booked.debit_minor,
      `${form}: the scanned Amt must equal the posted Debitoren 1100 debit, to the Rappen`,
    );
    assert.equal(ccy, booked.currency, `${form}: the scanned Ccy must equal the currency the row posted in`);
  }

  t.diagnostic(
    `${currency}: scanned Amt=${amountAndCurrencyOf(scannedPdf.text).amt} against journal_line ` +
      `debit_minor=${booked.debit_minor} base_debit_minor=${booked.base_debit_minor} fx_rate=${booked.fx_rate}`,
  );
  return { booked, scannedPdf, panel };
}

test('CHF: the QR scanned off the rendered PDF and SVG carries what the books posted', (t) => {
  // CHF 1'000.00 net + 8.1% VAT = CHF 1'081.00 gross, which is the 1100 debit and the QR Amt.
  const { booked } = assertScannedAgainstTheBooks(t, { currency: 'CHF', expectedAmt: '1081.00' });
  assert.equal(booked.currency, 'CHF');
  assert.equal(booked.debit_minor, booked.base_debit_minor, 'no conversion happens in base currency');
});

test('EUR: the QR carries the TRANSACTION amount and currency, never the base CHF pair', (t) => {
  // EUR 1'081.00 billed, CHF 1'017.44 booked (1081.00 * 0.9412). Both live on the same journal row,
  // which is exactly why a renderer can pick the wrong one and still look completely plausible.
  const { booked, scannedPdf } = assertScannedAgainstTheBooks(t, { currency: 'EUR', expectedAmt: '1081.00' });
  assert.equal(booked.currency, 'EUR');
  assert.equal(booked.fx_rate, EUR_CHF, 'the row carries the rate that priced it');
  assert.equal(booked.base_debit_minor, 101744, "CHF 1'017.44 booked in base");
  assert.notEqual(
    booked.base_debit_minor,
    booked.debit_minor,
    'the case only tests anything if the two amounts genuinely differ',
  );

  const { amt, ccy } = amountAndCurrencyOf(scannedPdf.text);
  assert.notEqual(Math.round(Number(amt) * 100), booked.base_debit_minor, 'the base amount is NOT what is billed');
  assert.notEqual(ccy, 'CHF', 'the base currency is NOT what is billed');
});

test('the graphic is genuinely ON the artifact: unwiring it fails here, not at a bank counter', () => {
  const { ctx } = setup();
  const invoiceId = issuedInvoice(ctx, { key: 'onpage' });
  const pdf = renderInvoicePdf(ctx, invoiceId);
  assert.ok(pdf.ok, JSON.stringify(pdf));

  const content = contentStreamOf(pdf.pdf.base64);

  // What is counted is MODULE RECTANGLES, not `re f` pairs. The grid is emitted as one path: a run
  // of `re` operators in whole-module coordinates under the module-unit `cm` transform, closed by a
  // single `f`, which is what keeps a thousand pointless ` f` suffixes off every emailed invoice.
  // The count is still the wiring guard it always was, and it still collapses the moment the
  // graphic is not drawn: no fragment means no match at all, and the assertion fails on the null.
  const grid = /^-?[\d.]+ 0 0 -?[\d.]+ -?[\d.]+ -?[\d.]+ cm\n0 0 0 rg\n((?:\d+ \d+ \d+ \d+ re\n)+)f$/m.exec(content);
  assert.notEqual(
    grid,
    null,
    'no Swiss QR Code module grid on the artifact. The PDF used to say "payment part enclosed" ' +
      'over a page with no code on it.',
  );
  const rects = grid[1].trimEnd().split('\n');
  assert.ok(
    rects.length > 100,
    `a rendered Swiss QR Code is hundreds of module rectangles; found ${rects.length}. ` +
      'The PDF used to say "payment part enclosed" over a page with no code on it.',
  );
  assert.match(content, /^q$/m, 'the graphic is isolated in its own q/Q pair');
  assert.match(content, /^Q$/m);
  assert.match(content, /Swiss QR-bill: payment part enclosed/, 'and the page still says so');
});

test('IG 6.3 / 6.4: the reported module size is the 46 mm symbol scaled, and the floor is reported not enforced', () => {
  const { ctx } = setup();
  const invoiceId = issuedInvoice(ctx, { key: 'modules' });
  const { qrGraphic } = renderInvoicePdf(ctx, invoiceId).pdf;

  assert.equal(qrGraphic.moduleCount, 17 + 4 * qrGraphic.version, 'ISO/IEC 18004 side length');
  assert.equal(qrGraphic.moduleSizeMm, SWISS_QR_CODE_SIZE_MM / qrGraphic.moduleCount);
  // The guideline contradicts itself only at version 25 (46/117 = 0.393 mm, under the 0.4 mm floor
  // of section 6.3), and an ordinary invoice lands far below that. The flag reports the fact; it is
  // never a refusal, because IG 6.4's 46 mm is unconditional.
  assert.equal(qrGraphic.meetsMinimumModuleSize, true);
  assert.ok(qrGraphic.version < 25, `an ordinary invoice sits well inside the version range: ${qrGraphic.version}`);
});
