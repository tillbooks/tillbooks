/**
 * One `renderPaymentQr` call must run the QR ENCODER exactly once.
 *
 * The panel used to encode the same payload twice per call: once as `buildSwissQrCodeGraphic` purely
 * to read `moduleSizeMm` for the density flag, and once more inside `renderSwissQrCodeSvg`, whose
 * first statement was the very same build. The memo in `InvoiceArtifacts` cut how OFTEN the call
 * happens (seven encodes per interaction down to one); it could not touch the fact that each
 * remaining call did the work twice, because the duplication lives below it.
 *
 * The count is taken at the ENCODER (`encodeQrByteMode`), not at `buildSwissQrCodeGraphic`, because
 * the encoder is where the cost is: everything else in the build is a division and an object
 * literal. Counting the real thing also means a future "cheap second call" (a cache, a memo) would
 * still be visible here as a shape change rather than pass silently.
 *
 * The encoder is COUNTED, never stubbed: the wrapper delegates to the real implementation, so the
 * output assertions below are assertions about the real symbol.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import artifacts from './invoice-artifacts.fixture.json';

const encodes = vi.hoisted(() => ({ count: 0 }));

vi.mock('../../../../src/core/sales/qrcode.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/core/sales/qrcode')>();
  return {
    ...actual,
    encodeQrByteMode: (data: Uint8Array) => {
      encodes.count += 1;
      return actual.encodeQrByteMode(data);
    },
  };
});

const { renderPaymentQr } = await import('./invoice');
const { renderSwissQrCodeSvg, renderSwissQrCodePdfOps, buildSwissQrCodeGraphic } = await import(
  '../../../../src/core/sales/swiss-qr-graphic.js'
);

const PAYLOAD = artifacts.qr.swissQrPayload;
const LABEL = 'Swiss QR-Code für die Zahlung';

describe('renderPaymentQr encodes once', () => {
  beforeEach(() => {
    encodes.count = 0;
  });

  it('runs the encoder exactly once per call', () => {
    const state = renderPaymentQr(PAYLOAD, LABEL);

    expect(state.kind).toBe('drawn');
    expect(encodes.count).toBe(1);
  });

  it('draws the same symbol the engine renderer draws, byte for byte', () => {
    // The panel is not allowed to become its own renderer. Whatever `renderSwissQrCodeSvg` emits for
    // this payload and this label is exactly what the panel shows, which is what keeps the code on
    // screen and the code on the PDF one symbol described once.
    const state = renderPaymentQr(PAYLOAD, LABEL);

    expect(state.kind === 'drawn' && state.svg).toBe(renderSwissQrCodeSvg(PAYLOAD, { ariaLabel: LABEL }));
  });

  it('keeps the accessible name and the guideline dimensions', () => {
    const state = renderPaymentQr(PAYLOAD, LABEL);
    const svg = state.kind === 'drawn' ? state.svg : '';

    // A payment instrument that no screen reader can name is not accessible, and IG 6.4 / 6.4.1 fix
    // the printed geometry at 46 mm of code inside a 5 mm border, whatever the symbol version.
    expect(svg).toContain(`role="img" aria-label="${LABEL}"`);
    expect(svg).toContain('width="56mm" height="56mm"');
  });

  it('reports the density flag without a second encode', () => {
    // `tooDense` is the IG 6.3 vs 6.4 conflict reported, never enforced (46 mm is unconditional), so
    // an ordinary invoice reads false. Reading it must not cost another symbol.
    const state = renderPaymentQr(PAYLOAD, LABEL);

    expect(state.kind === 'drawn' && state.tooDense).toBe(false);
    expect(encodes.count).toBe(1);
  });

  it('still refuses a payload past the IG 6.2 ceiling, and encodes nothing at all', () => {
    const state = renderPaymentQr('X'.repeat(1200), LABEL);

    expect(state).toEqual({ kind: 'undrawable', reason: 'payload_too_long' });
    expect(encodes.count).toBe(0);
  });
});

/**
 * Both renderers take either form of source. The point of the graphic arm is that it draws the SAME
 * bytes as the payload arm: a caller that already holds the symbol must not get a different picture
 * for having saved an encode. The PDF arm is asserted here rather than left to its own caller,
 * because `renderInvoicePdf` still passes a payload and would not exercise it.
 */
describe('either renderer draws from a payload or from an already-built symbol', () => {
  beforeEach(() => {
    encodes.count = 0;
  });

  it('the SVG is identical either way, and the symbol arm adds no encode', () => {
    const graphic = buildSwissQrCodeGraphic(PAYLOAD);
    expect(encodes.count).toBe(1);

    expect(renderSwissQrCodeSvg(graphic, { ariaLabel: LABEL })).toBe(
      renderSwissQrCodeSvg(PAYLOAD, { ariaLabel: LABEL }),
    );
    // Two renders, one of each arm: the payload arm encoded, the symbol arm did not.
    expect(encodes.count).toBe(2);
  });

  it('the PDF content-stream fragment is identical either way', () => {
    const graphic = buildSwissQrCodeGraphic(PAYLOAD);
    const placement = { xPt: 62, yPt: 62 };

    expect(renderSwissQrCodePdfOps(graphic, placement)).toBe(renderSwissQrCodePdfOps(PAYLOAD, placement));
    expect(encodes.count).toBe(2);
  });
});
