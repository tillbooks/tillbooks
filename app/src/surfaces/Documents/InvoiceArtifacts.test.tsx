/**
 * S3's QR payment-part panel and S8's PDF viewer overlay, all five states each, driven through the
 * real DocumentDetail so the wiring is under test and not just the components.
 *
 * The QR and PDF bodies come from `invoice-artifacts.fixture.json`, which was generated FROM the live
 * engine and is pinned to it by `test/sales/invoice-gui-fixture.test.mjs`. The reference asserted
 * below is therefore the engine's real QRR, not a hand-written one.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider, useI18n } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import DocumentsSurface from './index';
import artifacts from './invoice-artifacts.fixture.json';
import { formatQrReference, readQr, readPdf, renderPaymentQr, type QrState } from './invoice';
import { QrPanel, type QrPanelProps } from './InvoiceArtifacts';
import type { DocumentDto } from './model';

/**
 * The QR encoder is counted, not stubbed. Every call still runs the real `renderPaymentQr`, so the
 * assertions about WHAT is drawn stay assertions about the engine's own renderer; the wrapper only
 * records how often the panel asked for it. A stub would make the staleness tests below vacuous.
 */
const qrRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock('./invoice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./invoice')>();
  return {
    ...actual,
    renderPaymentQr: (payload: string, ariaLabel: string) => {
      qrRenders.count += 1;
      return actual.renderPaymentQr(payload, ariaLabel);
    },
  };
});

type Canned = Record<string, RestResponse | ((input: Record<string, unknown>) => RestResponse)>;

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

const VAT_PREVIEW = ok({
  ok: true,
  kind: 'output',
  netMinor: 150000,
  taxMinor: 12150,
  grossMinor: 162150,
  rateBp: 810,
  deductible: false,
  formLine: '303',
  trace: { taxCode: 'UST81', taxBaseMinor: 150000, taxAmountMinor: 12150 },
});

const contact = ok({ contact: { id: 'ct_1', name: 'Muster AG' } });

/** The issued invoice the fixture depicts, optionally overridden. */
function doc(overrides: Record<string, unknown> = {}) {
  return { ...artifacts.document, ...overrides };
}

/**
 * `get_document` behaves like the engine: the base read on its own, and the artifacts only when the
 * caller asks for them by `include`. That distinction is the whole point of the S8 lazy load.
 */
function getDocument(options: { document?: Record<string, unknown>; qr?: unknown; pdf?: unknown } = {}) {
  return (input: Record<string, unknown>): RestResponse => {
    const include = (input.include as string[] | undefined) ?? [];
    const body: Record<string, unknown> = {
      document: options.document ?? doc(),
      lines: artifacts.lines,
      history: artifacts.history,
    };
    if (include.includes('qr')) body.qr = options.qr === undefined ? artifacts.qr : options.qr;
    if (include.includes('pdf')) body.pdf = options.pdf === undefined ? artifacts.pdf : options.pdf;
    return ok(body);
  };
}

function renderDetail(canned: Canned, initial = '/documents/doc_1') {
  const client = new TillClient(fakeTransport(canned));
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter initialEntries={[initial]}>
            <Routes>
              <Route path="/documents/*" element={<DocumentsSurface />} />
            </Routes>
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('readQr / readPdf, the two-envelope normaliser', () => {
  // The trap this normaliser exists for: issue_invoice wraps the QR in an availability flag,
  // get_document returns the bare bill or the RAW rejection. Both must land in one shape.
  it('reads the get_document arm (a bare bill, no availability flag)', () => {
    const state = readQr(artifacts.qr);
    expect(state.kind).toBe('available');
    expect(state.kind === 'available' && state.bill.referenceType).toBe('QRR');
  });

  it('reads the issue_invoice arm, both available and unavailable', () => {
    expect(readQr({ available: true, ...artifacts.qr }).kind).toBe('available');
    const missing = readQr({ available: false, reason: 'needs_qr_iban' });
    expect(missing).toEqual({ kind: 'unavailable', reason: 'needs_qr_iban' });
  });

  it('reads the raw rejection arm a draft produces', () => {
    expect(readQr({ ok: false, error: 'not_available', reason: 'draft_has_no_qr_bill' })).toEqual({
      kind: 'unavailable',
      reason: 'not_available',
    });
    expect(readPdf({ ok: false, error: 'not_available' })).toEqual({ kind: 'unavailable', reason: 'not_available' });
  });

  it('never invents a bill from an absent or malformed key', () => {
    expect(readQr(undefined).kind).toBe('unavailable');
    expect(readQr({ referenceType: 'QRR' }).kind).toBe('unavailable');
  });
});

describe('formatQrReference, the statutory display form (SIX IG v2.3)', () => {
  it('blocks a 27-digit QRR in fives FROM THE RIGHT, so the short block leads', () => {
    expect(formatQrReference('210000000003139471430009017', 'QRR')).toBe('21 00000 00003 13947 14300 09017');
  });

  it('blocks a SCOR reference in fours FROM THE LEFT', () => {
    expect(formatQrReference('RF18539007547034', 'SCOR')).toBe('RF18 5390 0754 7034');
  });

  it('leaves anything else alone rather than guessing a grouping', () => {
    expect(formatQrReference('ABC', 'NON')).toBe('ABC');
    expect(formatQrReference('', 'QRR')).toBe('');
  });
});

describe('QrPanel (S3), the five states', () => {
  it('LOADING: a skeleton in the panel while the QR read is in flight, never a bare spinner', async () => {
    let resolveQr: (r: RestResponse) => void = () => {};
    let qrRequests = 0;
    renderDetail({
      get_document: (input) => {
        const include = (input.include as string[] | undefined) ?? [];
        if (include.includes('qr')) {
          qrRequests += 1;
          return new Promise<RestResponse>((resolve) => {
            resolveQr = resolve;
          }) as unknown as RestResponse;
        }
        return ok({ document: doc(), lines: artifacts.lines, history: artifacts.history });
      },
      get_contact: contact,
      vat_preview: VAT_PREVIEW,
    });
    const panel = await screen.findByLabelText('QR-Zahlteil');
    // The panel can reach the screen a beat before the artifact effect has fired, and a skeleton
    // over a read that never started is a different defect from the one this test is named after.
    // Confirming the read is in flight is therefore the test's own claim, and it is also what makes
    // `resolveQr` below the live resolver rather than the no-op it is initialised to.
    await waitFor(() => expect(qrRequests).toBe(1));
    expect(within(panel).getByRole('status')).toBeInTheDocument();

    // The skeleton is a state the panel passes THROUGH, not one it can rest in, so the test has to
    // watch it end. Resolving the read and returning would prove only that the panel can start
    // loading: the arrival is the half that matters to someone waiting on a payment part, and it is
    // also the half React was completing after teardown while nothing asserted on it.
    resolveQr(ok({ document: doc(), lines: artifacts.lines, history: artifacts.history, qr: artifacts.qr }));
    const expected = formatQrReference(artifacts.qr.reference, artifacts.qr.referenceType);
    await within(panel).findByText(new RegExp(expected.replace(/\s/g, '\\s')));
    expect(within(panel).queryByRole('status')).toBeNull();
  });

  it('POPULATED: the reference in its blocked form, the amount, and the IG version', async () => {
    renderDetail({ get_document: getDocument(), get_contact: contact, vat_preview: VAT_PREVIEW });
    const panel = await screen.findByLabelText('QR-Zahlteil');
    // The engine's real QRR reference, blocked in fives from the right.
    const expected = formatQrReference(artifacts.qr.reference, artifacts.qr.referenceType);
    await within(panel).findByText(new RegExp(expected.replace(/\s/g, '\\s')));
    // The amount is the engine's posted gross (B-1: QR amount == PDF total == the 1100 receivable).
    expect(within(panel).getByText("CHF 1'621.50")).toBeInTheDocument();
    expect(within(panel).getByText(/2\.3/)).toBeInTheDocument();
  });

  // This test used to assert the opposite: that the panel drew NO code and said so. That was the
  // right behaviour while no verified encoder existed, and it is the wrong behaviour now that one
  // does, so the assertion is inverted rather than deleted. What it still refuses is a decoration:
  // the thing on screen has to be a real symbol built from the engine's payload, and it has to have
  // an accessible name, because a payment instrument a screen-reader user cannot perceive is not a
  // payment instrument. Whether the symbol SCANS is proven where it can be proven, by decoding it
  // with an independent reader in test/sales/qr-wiring-decode.test.mjs.
  it('POPULATED: the scannable code is drawn, named, and built from the engine payload', async () => {
    renderDetail({ get_document: getDocument(), get_contact: contact, vat_preview: VAT_PREVIEW });
    const panel = await screen.findByLabelText('QR-Zahlteil');

    const code = await within(panel).findByRole('img', { name: 'Swiss QR-Code für die Zahlung' });
    expect(code.tagName.toLowerCase()).toBe('svg');
    // IG 6.4 / 6.4.1: 46 mm of code inside a 5 mm unprinted border, at every version.
    expect(code.getAttribute('viewBox')).toBe('0 0 56 56');

    // A real symbol is hundreds of module runs plus the recognition symbol, not a placeholder box.
    expect(code.querySelectorAll('rect').length).toBeGreaterThan(100);

    // And it is the ENGINE's payload that was encoded, not something the panel assembled. Encoding
    // that payload again has to reproduce the panel's symbol module for module: a different payload
    // (or a placeholder) would not. Compared as geometry rather than as markup, because the DOM
    // rewrites attribute order and quoting on its way through.
    const again = renderPaymentQr(artifacts.qr.swissQrPayload, 'Swiss QR-Code für die Zahlung');
    expect(again.kind).toBe('drawn');
    const geometry = (svg: Element) =>
      [...svg.querySelectorAll('rect')].map((r) =>
        ['x', 'y', 'width', 'height', 'fill'].map((a) => r.getAttribute(a)).join(' '),
      );
    const reference = new DOMParser().parseFromString((again as { svg: string }).svg, 'image/svg+xml')
      .documentElement;
    expect(geometry(code)).toEqual(geometry(reference));
  });

  it('POPULATED: a payload past the IG 6.2 ceiling gets a named reason, never an empty box', () => {
    // IG 6.2 caps the code at 997 characters. `validateQrBill` caps every FIELD and nothing caps
    // their sum, so this is reachable from real master data, and the panel must say which.
    const state = renderPaymentQr('X'.repeat(1200), 'Swiss QR-Code für die Zahlung');
    expect(state).toEqual({ kind: 'undrawable', reason: 'payload_too_long' });
  });

  it('POPULATED: the raw payload is behind a disclosure and is the engine payload verbatim', async () => {
    renderDetail({ get_document: getDocument(), get_contact: contact, vat_preview: VAT_PREVIEW });
    const panel = await screen.findByLabelText('QR-Zahlteil');
    const toggle = await within(panel).findByRole('button', { name: 'Rohdaten anzeigen' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    const payload = await within(panel).findByLabelText('Swiss Payments Code');
    // Byte for byte: the panel never reassembles a payload of its own (spec §8).
    expect(payload.textContent).toBe(artifacts.qr.swissQrPayload);

    /*
     * A11-G12: and the control now describes what it DOES, not the state it is already in. It read
     * "Rohdaten anzeigen" with the raw data on screen, which is a control that cannot be understood
     * without first trying it.
     */
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent('Rohdaten ausblenden');
    await userEvent.click(toggle);
    expect(toggle).toHaveTextContent('Rohdaten anzeigen');
    expect(within(panel).queryByLabelText('Swiss Payments Code')).not.toBeInTheDocument();
  });

  /*
   * A11-G16. Three separate things the payment panel asked a human to already know: the guideline
   * version stood in the LABEL column over an empty value; `QRR`/`SCOR` were printed bare; and the
   * one string on the page a person retypes into e-banking had to be retyped by hand.
   */
  it('POPULATED: the guideline is a fact with a label, not a dangling jargon row', async () => {
    renderDetail({ get_document: getDocument(), get_contact: contact, vat_preview: VAT_PREVIEW });
    const panel = await screen.findByLabelText('QR-Zahlteil');
    const label = await within(panel).findByText('Richtlinie');
    expect(label.tagName).toBe('DT');
    // The version now sits in the value column, where a value belongs.
    const version = within(panel).getByText(/SIX Implementation Guidelines/);
    expect(version.tagName).toBe('DD');
  });

  it('POPULATED: the reference explains its own type and can be copied without retyping', async () => {
    renderDetail({ get_document: getDocument(), get_contact: contact, vat_preview: VAT_PREVIEW });
    const panel = await screen.findByLabelText('QR-Zahlteil');

    await userEvent.click(await within(panel).findByRole('button', { name: 'Was diese Referenz ist' }));
    const help = await within(panel).findByRole('dialog');
    expect(help).toHaveTextContent(/27-stellige Referenz/);

    // The clipboard gets the UNFORMATTED reference: the grouping on screen is for reading, and a
    // bank field wants the digits.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const copy = within(panel).getByRole('button', { name: 'Kopieren' });
    await userEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith(artifacts.qr.reference);
    expect(await within(panel).findByRole('button', { name: 'Kopiert' })).toBeInTheDocument();
  });

  it('ERROR: a missing IBAN names the consequence and links into Setup, never a dead end (M9)', async () => {
    renderDetail({
      get_document: getDocument({ qr: { ok: false, error: 'needs_qr_iban' } }),
      get_contact: contact,
      vat_preview: VAT_PREVIEW,
    });
    const panel = await screen.findByLabelText('QR-Zahlteil');
    await within(panel).findByText(/Die Rechnung selbst bleibt gültig/);
    expect(within(panel).getByRole('link', { name: 'IBAN hinterlegen' })).toHaveAttribute('href', '/setup');
  });

  it('ERROR: an incomplete customer address points at Contacts, where it is fixed (M10)', async () => {
    renderDetail({
      get_document: getDocument({ qr: { ok: false, error: 'needs_customer_address', field: 'debtor.postalCode' } }),
      get_contact: contact,
      vat_preview: VAT_PREVIEW,
    });
    const panel = await screen.findByLabelText('QR-Zahlteil');
    const fix = await within(panel).findByRole('link', { name: 'Adresse vervollständigen' });
    expect(fix).toHaveAttribute('href', '/contacts');
  });

  it('EMPTY / not applicable: a DRAFT invoice and a quote get no QR panel and no PDF control at all', async () => {
    const { unmount } = renderDetail({
      get_document: getDocument({ document: doc({ status: 'draft', number: null }) }),
      get_contact: contact,
      vat_preview: VAT_PREVIEW,
    });
    // A draft renders the editor, which shows readiness instead; no payment part anywhere.
    await screen.findByLabelText('QR-Bereitschaft');
    expect(screen.queryByLabelText('QR-Zahlteil')).not.toBeInTheDocument();
    unmount();

    renderDetail({
      get_document: getDocument({ document: doc({ type: 'quote', number: 'O-2026-0001' }) }),
      get_contact: contact,
      vat_preview: VAT_PREVIEW,
    });
    await screen.findByRole('heading', { name: /O-2026-0001/ });
    expect(screen.queryByLabelText('QR-Zahlteil')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'PDF' })).not.toBeInTheDocument();
  });

  it('PERMISSION-DENIED: a denied read renders the reason, never a half-built payment part', async () => {
    renderDetail({
      get_document: getDocument({ qr: { ok: false, error: 'permission_denied' } }),
      get_contact: contact,
      vat_preview: VAT_PREVIEW,
    });
    const panel = await screen.findByLabelText('QR-Zahlteil');
    await within(panel).findByText('Kein QR-Zahlteil');
    expect(within(panel).queryByText(/QRR/)).not.toBeInTheDocument();
  });
});

/**
 * The symbol is the most expensive thing this panel draws: `renderPaymentQr` runs the QR encoder and
 * then builds roughly 45 KB of SVG text. It used to run in the component body, so every re-render
 * the bill had nothing to do with (the raw-payload disclosure, any parent state change) paid for it
 * again.
 *
 * Memoising a PAYMENT INSTRUMENT is only allowed if it can be shown never to serve an older bill, so
 * the staleness tests here matter more than the count. `renderPaymentQr(payload, ariaLabel)` takes
 * exactly two arguments and is otherwise pure, so those two values ARE the whole staleness surface:
 * one test per argument covers it exhaustively, and no third input can go stale unobserved.
 *
 * Note what is deliberately NOT a dependency. `bill` is an object and `t` is a function, and both
 * can be fresh on a render that changed no payment data: keying the memo on either would either
 * rebuild for nothing or, worse, tie correctness to the i18n provider happening to memoise `t`.
 * The memo is keyed on the two strings that are actually encoded, so it is right by value.
 */
describe('QrPanel: the symbol is rebuilt when the bill changes, and never otherwise', () => {
  beforeEach(() => {
    qrRenders.count = 0;
  });

  /** A parent owning state the panel knows nothing about, so an unrelated re-render can be provoked. */
  function MemoHarness({ doc: d, qr }: QrPanelProps) {
    const [noise, setNoise] = useState(0);
    const { setLocale } = useI18n();
    return (
      <>
        <button type="button" onClick={() => setNoise((v) => v + 1)}>
          noise
        </button>
        <span data-testid="noise">{noise}</span>
        <button type="button" onClick={() => setLocale('en')}>
          to-en
        </button>
        <QrPanel doc={d} qr={qr} />
      </>
    );
  }

  function tree(props: QrPanelProps) {
    return (
      <I18nProvider>
        <MemoryRouter>
          <MemoHarness {...props} />
        </MemoryRouter>
      </I18nProvider>
    );
  }

  /** The drawn symbol as geometry, which survives the DOM's attribute reordering. Markup does not. */
  function qrGeometry(svg: Element): string[] {
    return [...svg.querySelectorAll('rect')].map((r) =>
      ['x', 'y', 'width', 'height', 'fill'].map((a) => r.getAttribute(a)).join(' '),
    );
  }

  /**
   * The same engine payload with a different amount on line 19 (IG v2.3 field `Amount`). This is the
   * exact shape of the defect a bad memo would ship: a symbol that still bills the previous total.
   */
  function payloadWithAmount(amount: string): string {
    const lines = artifacts.qr.swissQrPayload.split('\r\n');
    expect(lines[18]).toBe('1621.50');
    lines[18] = amount;
    return lines.join('\r\n');
  }

  /** The engine's own bill, with the payload swapped. A FRESH object every call, on purpose. */
  const billed = (payload: string): QrState => ({
    kind: 'available',
    bill: {
      swissQrPayload: payload,
      referenceType: artifacts.qr.referenceType as 'QRR',
      reference: artifacts.qr.reference,
      igVersion: artifacts.qr.igVersion,
    },
  });

  const issued = () => doc() as unknown as DocumentDto;

  it('encodes ONCE across re-renders that changed no payment data', async () => {
    const { rerender } = render(tree({ doc: issued(), qr: billed(artifacts.qr.swissQrPayload) }));
    await screen.findByRole('img', { name: 'Swiss QR-Code für die Zahlung' });
    expect(qrRenders.count).toBe(1);

    // A parent re-render the bill had nothing to do with.
    await userEvent.click(screen.getByRole('button', { name: 'noise' }));
    await userEvent.click(screen.getByRole('button', { name: 'noise' }));
    await userEvent.click(screen.getByRole('button', { name: 'noise' }));
    expect(screen.getByTestId('noise')).toHaveTextContent('3');

    // The panel's OWN state: opening and closing the raw-payload disclosure.
    const toggle = screen.getByRole('button', { name: 'Rohdaten anzeigen' });
    await userEvent.click(toggle);
    await screen.findByLabelText('Swiss Payments Code');
    await userEvent.click(toggle);

    // Fresh prop OBJECTS carrying identical payment data, which is what a re-read produces.
    rerender(tree({ doc: issued(), qr: billed(artifacts.qr.swissQrPayload) }));

    expect(qrRenders.count).toBe(1);
  });

  it('STALENESS, argument 1: a changed payload draws the new symbol, not the old one', async () => {
    const { rerender } = render(tree({ doc: issued(), qr: billed(artifacts.qr.swissQrPayload) }));
    const before = qrGeometry(await screen.findByRole('img', { name: 'Swiss QR-Code für die Zahlung' }));

    const corrected = payloadWithAmount('9999.00');
    rerender(tree({ doc: issued(), qr: billed(corrected) }));
    const after = qrGeometry(await screen.findByRole('img', { name: 'Swiss QR-Code für die Zahlung' }));

    // The symbol on screen moved, and it moved to exactly the symbol the new payload encodes to.
    expect(after).not.toEqual(before);
    const expected = renderPaymentQr(corrected, 'Swiss QR-Code für die Zahlung');
    expect(expected.kind).toBe('drawn');
    const reference = new DOMParser().parseFromString((expected as { svg: string }).svg, 'image/svg+xml')
      .documentElement;
    expect(after).toEqual(qrGeometry(reference));
  });

  it('STALENESS, argument 2: a changed locale draws the new accessible name, not the old one', async () => {
    render(tree({ doc: issued(), qr: billed(artifacts.qr.swissQrPayload) }));
    const code = await screen.findByRole('img', { name: 'Swiss QR-Code für die Zahlung' });
    expect(code.getAttribute('role')).toBe('img');

    await userEvent.click(screen.getByRole('button', { name: 'to-en' }));

    // The name is baked INTO the SVG string, so a memo that ignored it would keep announcing German
    // to a screen-reader user who switched to English, and nothing visual would reveal it.
    const renamed = await screen.findByRole('img', { name: 'Swiss QR-bill payment code' });
    expect(renamed.getAttribute('role')).toBe('img');
    expect(renamed.querySelector('title')?.textContent).toBe('Swiss QR-bill payment code');
  });

  it('encodes ONCE through the real detail, disclosure toggling included', async () => {
    renderDetail({ get_document: getDocument(), get_contact: contact, vat_preview: VAT_PREVIEW });
    const panel = await screen.findByLabelText('QR-Zahlteil');
    await within(panel).findByRole('img', { name: 'Swiss QR-Code für die Zahlung' });
    const onArrival = qrRenders.count;

    const toggle = within(panel).getByRole('button', { name: 'Rohdaten anzeigen' });
    await userEvent.click(toggle);
    await within(panel).findByLabelText('Swiss Payments Code');
    await userEvent.click(toggle);
    await waitFor(() => expect(within(panel).queryByLabelText('Swiss Payments Code')).toBeNull());

    expect({ onArrival, afterToggling: qrRenders.count }).toEqual({ onArrival: 1, afterToggling: 1 });
  });
});

describe('PdfViewer (S8), the five states', () => {
  async function openViewer(canned: Canned) {
    renderDetail(canned);
    await userEvent.click(await screen.findByRole('button', { name: 'PDF' }));
    return screen.findByRole('dialog');
  }

  it('LOADING: the PDF is fetched only when the viewer OPENS, with a skeleton while it renders', async () => {
    let resolvePdf: (r: RestResponse) => void = () => {};
    let pdfRequested = 0;
    renderDetail({
      get_document: (input) => {
        const include = (input.include as string[] | undefined) ?? [];
        if (include.includes('pdf')) {
          pdfRequested += 1;
          return new Promise<RestResponse>((resolve) => {
            resolvePdf = resolve;
          }) as unknown as RestResponse;
        }
        if (include.includes('qr')) return ok({ document: doc(), lines: artifacts.lines, history: artifacts.history, qr: artifacts.qr });
        return ok({ document: doc(), lines: artifacts.lines, history: artifacts.history });
      },
      get_contact: contact,
      vat_preview: VAT_PREVIEW,
    });

    await screen.findByLabelText('QR-Zahlteil');
    // Nothing has rendered a PDF for a document nobody asked to see.
    expect(pdfRequested).toBe(0);

    await userEvent.click(screen.getByRole('button', { name: 'PDF' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(pdfRequested).toBe(1);
    resolvePdf(ok({ document: doc(), lines: artifacts.lines, history: artifacts.history, pdf: artifacts.pdf }));
    await within(dialog).findByTitle('Vorschau der Rechnung');
  });

  it('POPULATED: the artifact renders, states its size and QR status, and downloads under its number', async () => {
    const dialog = await openViewer({ get_document: getDocument(), get_contact: contact, vat_preview: VAT_PREVIEW });
    const frame = await within(dialog).findByTitle('Vorschau der Rechnung');
    // The viewer shows the engine's own bytes: no client-side re-render of the invoice.
    expect(frame).toHaveAttribute('src', `data:application/pdf;base64,${artifacts.pdf.base64}`);
    expect(within(dialog).getByText(/Mit QR-Zahlteil/)).toBeInTheDocument();

    const download = within(dialog).getByRole('link', { name: 'Herunterladen' });
    expect(download).toHaveAttribute('download', 'Rechnung-R-2026-0001.pdf');

    /*
     * A11-G6: the frame is a browser's decision, not the app's. Nothing on this side can tell a
     * rendered page from a blank rectangle (the iframe fires `load` either way), so the overlay
     * states the limit and names the certain path instead of claiming a preview or spinning
     * forever. This is the last look at the artifact before it goes to a client, and "I see
     * nothing" must not read as "the invoice is empty".
     */
    expect(within(dialog).getByText(/Bleibt die Vorschau leer, lade die Datei herunter/)).toBeInTheDocument();
  });

  it('ERROR: a failed render says what happened and offers a retry that re-asks the engine', async () => {
    let attempts = 0;
    const dialog = await openViewer({
      get_document: (input) => {
        const include = (input.include as string[] | undefined) ?? [];
        if (include.includes('pdf')) {
          attempts += 1;
          return attempts === 1
            ? ok({ document: doc(), lines: artifacts.lines, history: artifacts.history, pdf: { ok: false, error: 'not_available' } })
            : ok({ document: doc(), lines: artifacts.lines, history: artifacts.history, pdf: artifacts.pdf });
        }
        if (include.includes('qr')) return ok({ document: doc(), lines: artifacts.lines, history: artifacts.history, qr: artifacts.qr });
        return ok({ document: doc(), lines: artifacts.lines, history: artifacts.history });
      },
      get_contact: contact,
      vat_preview: VAT_PREVIEW,
    });

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Das PDF konnte nicht erstellt werden.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Erneut versuchen' }));
    await within(dialog).findByTitle('Vorschau der Rechnung');
    expect(attempts).toBe(2);
  });

  it('EMPTY / denied: a rejected document read leaves the viewer honest, with no frame and no download', async () => {
    const dialog = await openViewer({
      get_document: (input) => {
        const include = (input.include as string[] | undefined) ?? [];
        if (include.includes('pdf')) return { status: 403, body: { ok: false, error: 'permission_denied' } };
        if (include.includes('qr')) return ok({ document: doc(), lines: artifacts.lines, history: artifacts.history, qr: artifacts.qr });
        return ok({ document: doc(), lines: artifacts.lines, history: artifacts.history });
      },
      get_contact: contact,
      vat_preview: VAT_PREVIEW,
    });
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(within(dialog).queryByTitle('Vorschau der Rechnung')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: 'Herunterladen' })).not.toBeInTheDocument();
  });

  it('closes on Escape and on the close control, leaving the detail intact', async () => {
    const dialog = await openViewer({ get_document: getDocument(), get_contact: contact, vat_preview: VAT_PREVIEW });
    await within(dialog).findByTitle('Vorschau der Rechnung');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: /R-2026-0001/ })).toBeInTheDocument();
  });
});
