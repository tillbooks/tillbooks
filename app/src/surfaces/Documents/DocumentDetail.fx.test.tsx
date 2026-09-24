/**
 * S3's M11 panel: the transaction total and the base total side by side, with the rate between them.
 *
 * Every document body here comes from `document-fx.fixture.json`, which
 * `test/sales/studio-fx-document-fixture.test.mjs` pins to the live engine, keys and kinds. The
 * figures asserted are read back OUT of that fixture rather than typed as literals, so a test cannot
 * keep passing against a number the engine stopped producing.
 *
 * The load-bearing property is the one the whole feature exists to protect: every figure on screen
 * came off the wire. The client is given a transaction total and a rate, so it could produce a base
 * total in one multiplication, and that multiplication is precisely the defect: the ledger converts
 * and rounds PER POSTED ROW and sums the results, so a total-times-rate answer is a different number
 * on some invoice nobody was watching. `rendersTheEngineFigureNotTheProduct` below proves the UI
 * prints what it was handed even when the two disagree.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { neverSettles, watchReads } from '../../test-transport';
import DocumentsSurface from './index';
import getFixture from './get-document.fixture.json';
import fx from './document-fx.fixture.json';

type Canned = Record<string, RestResponse | ((input: Record<string, unknown>) => RestResponse)>;

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, status = 422): RestResponse => ({ status, body: { ok: false, error } });

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
const CONTACT = ok({ contact: { id: 'ct_1', name: 'Muster AG' } });

const PANEL = 'Umrechnung der Buchung';
/** The VAT summary panel. It exists only once every per-line `vat_preview` read has answered. */
const VAT_SUMMARY = 'MWST-Übersicht';
/** The QR panel's settled heading: the artifact read answered, and this fake serves no payment part. */
const QR_SETTLED = 'Kein QR-Zahlteil';

function tree(client: TillClient, initial: string) {
  return (
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
    </TillClientProvider>
  );
}

function renderDetail(canned: Canned, initial = '/documents/doc_fx_1') {
  return render(tree(new TillClient(fakeTransport(canned)), initial));
}

/**
 * Wait out the two reads that OUTLIVE the document read on an issued invoice.
 *
 * This is the fix for an intermittent failure that only ever appeared under a full-suite run, and
 * it is worth writing down because the symptom named the wrong file twice.
 *
 * S3 issues three reads, not one. `get_document` fills the header and the FX panel; the per-line
 * `vat_preview` calls fill the VAT summary; a second `get_document` fills the QR payment panel. The
 * last two are started by effects that only run once the first has answered, so the FX PANEL IS ON
 * SCREEN WHILE THEY ARE STILL OUT. `findByLabelText(PANEL)` therefore hands back a surface that is
 * still moving. Testing Library turns React's act environment off for the duration of a `findBy`
 * and back on one `setTimeout(0)` later, so whether those two updates count as "inside the test"
 * comes down to whether that timer or React's own scheduler task runs first: a coin toss, and one
 * that a machine running the whole suite flips differently. Landing on the wrong side is a
 * `console.error` that the guard in `src/test-console.ts` fails the test on.
 *
 * The two axe tests are where it bit, because they hold the tree mounted for the length of the
 * accessibility pass, which is a few hundred milliseconds of open window rather than a few
 * microtasks. And a failure there did not stay there: the guard's `afterEach` THROWS, Vitest runs
 * `afterEach` hooks in reverse registration order, so Testing Library's cleanup hook never ran and
 * the failed test's DOM stayed in `document.body`. The next test then found this file's FX panel on
 * a draft that never renders one. One cause, up to two failures, in two different describes.
 *
 * Both anchors below are states the surface CANNOT be in until its read answered: the VAT summary
 * renders a bare "Keine MWST auf diesem Beleg" paragraph with no accessible name until
 * `vat_preview` lands, and the QR panel shows a skeleton under the "QR-Zahlteil" heading until the
 * artifact read lands. Waiting for them is a statement about those reads, not a sleep, and it
 * leaves nothing in flight for the rest of the test to race.
 */
async function settleInvoiceReads(): Promise<void> {
  await screen.findByLabelText(VAT_SUMMARY);
  await screen.findByRole('heading', { name: QR_SETTLED });
}

/** The FX panel, on a surface that has finished loading and is no longer updating. */
async function findSettledPanel(): Promise<HTMLElement> {
  const panel = await screen.findByLabelText(PANEL);
  await settleInvoiceReads();
  return panel;
}

/** A `get_document` response wrapping one arm of the pinned FX fixture. */
function docFrom(document: Record<string, unknown>, overrides: Record<string, unknown> = {}): RestResponse {
  return ok({ document: { ...document, ...overrides }, lines: getFixture.lines, history: getFixture.history });
}

const cannedFor = (document: Record<string, unknown>): Canned => ({
  get_document: docFrom(document),
  get_contact: CONTACT,
  vat_preview: VAT_PREVIEW,
  // The QR read rides its own request; a missing IBAN must not fail the document read.
  get_invoice_qr: reject('needs_qr_iban'),
});

describe('DocumentDetail FX panel, the five states', () => {
  it('LOADING: shows the skeleton only once the document read is genuinely in flight', async () => {
    const transport = watchReads(neverSettles);
    render(tree(new TillClient(transport), '/documents/doc_fx_1'));
    // The surface initialises `loading` to true, so the skeleton is on screen before any effect
    // fires. Waiting for the read makes this a statement about the LOAD rather than about the
    // default render: without it the same assertion passes over a surface that never asked at all.
    await transport.started('get_document');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    // And nothing FX-shaped is on screen while the figures are unknown.
    expect(screen.queryByLabelText(PANEL)).not.toBeInTheDocument();
  });

  it('EMPTY: a base-currency invoice states no basis, so the panel is absent entirely', async () => {
    renderDetail(cannedFor(fx.issuedBase), '/documents/doc_fx_2');
    await screen.findByRole('heading', { name: /R-2026-0002/ });
    // Settled, not merely arrived: the absence below is a claim about the finished surface, and the
    // panel would have to be missing from a half-loaded one anyway.
    await settleInvoiceReads();
    // The engine sends none of the three keys here. Restating CHF 1'621.50 as a CHF "base total"
    // beside itself would be noise on the overwhelming majority of documents.
    expect(screen.queryByLabelText(PANEL)).not.toBeInTheDocument();
    expect(screen.queryByText('Gebucht')).not.toBeInTheDocument();
  });

  it('ERROR: a failed document read shows the banner and no half-built FX panel', async () => {
    renderDetail({ get_document: reject('invalid_input'), get_contact: CONTACT });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByLabelText(PANEL)).not.toBeInTheDocument();
  });

  it('DENIED: a refused read shows no figures at all, not a panel with blanks', async () => {
    renderDetail({ get_document: reject('permission_denied', 403), get_contact: CONTACT });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByLabelText(PANEL)).not.toBeInTheDocument();
    expect(screen.queryByText(/1'526\.16/)).not.toBeInTheDocument();
  });

  it('SUCCESS: an issued EUR invoice shows both totals and the rate that connects them', async () => {
    renderDetail(cannedFor(fx.issuedForeign));
    const panel = await findSettledPanel();

    // Both figures, each denominated. A bare number under a "Total" header is what the Journal list
    // still has to live with; this surface has the currency and uses it.
    expect(within(panel).getByText("EUR 1'621.50")).toBeInTheDocument();
    expect(within(panel).getByText("CHF 1'526.16")).toBeInTheDocument();
    // Read back off the pinned fixture, so a change in what the engine converts fails this here
    // rather than shipping a stale literal.
    expect(fx.issuedForeign.totalMinor).toBe(162150);
    expect(fx.issuedForeign.totalBaseMinor).toBe(152616);
    // The rate, as the engine's own canonical string, in the direction the ledger quotes it.
    expect(within(panel).getByText(`1 EUR = ${fx.issuedForeign.fxRate} CHF`)).toBeInTheDocument();
  });

  it('renders the ENGINE base total, not the transaction total multiplied by the rate', async () => {
    // The ledger converts and rounds per posted row and sums the results, so its base total is not
    // always what `round(totalMinor * fxRate)` produces. This body forces the two apart: the naive
    // product is 152616, the figure handed over is 152600. A client that computed instead of
    // printing would show the product and this assertion would catch it.
    renderDetail(cannedFor({ ...fx.issuedForeign, totalBaseMinor: 152600 }));
    const panel = await findSettledPanel();
    expect(within(panel).getByText("CHF 1'526.00")).toBeInTheDocument();
    expect(within(panel).queryByText("CHF 1'526.16")).not.toBeInTheDocument();
  });

  it('states the rate even at parity, where the two totals coincide', async () => {
    renderDetail(cannedFor(fx.issuedPegged), '/documents/doc_fx_3');
    const panel = await findSettledPanel();
    // At a rate of 1 the numbers alone cannot tell a reader that a conversion happened, which is
    // exactly why the rate is stated separately and why the panel must not go quiet here.
    expect(fx.issuedPegged.totalBaseMinor).toBe(fx.issuedPegged.totalMinor);
    expect(within(panel).getByText(`1 USD = ${fx.issuedPegged.fxRate} CHF`)).toBeInTheDocument();
    expect(within(panel).getAllByText("USD 1'621.50").length).toBe(1);
    expect(within(panel).getAllByText("CHF 1'621.50").length).toBe(1);
  });

  it('shows no rate validity date, because the ledger holds none to show', async () => {
    renderDetail(cannedFor(fx.issuedForeign));
    const panel = await findSettledPanel();
    // `fxRateAsOf` is not on the read model: reporting one would mean re-resolving it from the
    // mutable rate store and naming a date that may never have priced this invoice.
    expect(within(panel).queryByText('Kurs vom')).not.toBeInTheDocument();
    expect(within(panel).queryByText(/\d{2}\.\d{2}\.\d{4}/)).not.toBeInTheDocument();
  });

  it('says the rate is the one the posting used, so a later rate cannot be read into it', async () => {
    renderDetail(cannedFor(fx.issuedForeign));
    const panel = await findSettledPanel();
    expect(within(panel).getByText(/ein später erfasster Kurs ändert daran nichts/)).toBeInTheDocument();
  });

  it('has no axe violations with the panel on screen', async () => {
    const { container } = renderDetail(cannedFor(fx.issuedForeign));
    // The SETTLED surface, for two reasons. An axe pass over a half-loaded page audits a skeleton
    // and a missing summary rather than the screen a person reads, and holding the tree mounted for
    // the length of the pass is exactly the window a still-pending read updates into.
    await findSettledPanel();
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

/**
 * The franc VAT, beside the transaction VAT, in the same panel and under the same law.
 *
 * A Swiss MWST-Abrechnung is filed in francs (MWSTV Art. 45: the conversion happens when the tax
 * claim arises, and the books hold the result). Until `baseTaxMinor` reached a read model the franc
 * figure existed only in `journal_line.base_credit_minor`, so a person preparing a return either
 * opened SQLite or multiplied and hoped. The panel now states both, each denominated, and the
 * multiplication remains the one thing it must not do.
 */
describe('DocumentDetail FX panel, the two VAT figures', () => {
  it('SUCCESS: an issued EUR invoice shows the EUR VAT and the FRANC VAT, each labelled', async () => {
    renderDetail(cannedFor(fx.issuedForeign));
    const panel = await findSettledPanel();

    // EUR 121.50 was charged to the customer; CHF 114.36 is what the books hold and what the return
    // is filed on. Both true, different numbers, and neither is allowed to wear the other's label.
    expect(within(panel).getByText('EUR 121.50')).toBeInTheDocument();
    expect(within(panel).getByText('CHF 114.36')).toBeInTheDocument();
    expect(fx.issuedForeign.taxMinor).toBe(12150);
    expect(fx.issuedForeign.baseTaxMinor).toBe(11436);
    // The labels are what stop the reader having to infer which is which from the currency prefix.
    expect(within(panel).getByText('MWST fakturiert')).toBeInTheDocument();
    expect(within(panel).getByText('MWST gebucht')).toBeInTheDocument();
  });

  it('renders the ENGINE franc VAT, not the transaction VAT multiplied by the rate', async () => {
    // The witness, and the reason it is a TWO-RATE document. `applyFx` rounds once on the side total
    // and allocates back by largest remainder, so the ledger holds CHF 19.91 while
    // `round(taxMinor * fxRate)` produces CHF 19.92. On a single-rate invoice the two agree by luck
    // and a client that computed would pass unnoticed, which is how this class of defect hides.
    renderDetail(cannedFor(fx.issuedTwoRate), '/documents/doc_fx_6');
    const panel = await findSettledPanel();
    expect(within(panel).getByText('CHF 19.91')).toBeInTheDocument();
    expect(within(panel).queryByText('CHF 19.92')).not.toBeInTheDocument();
    expect(within(panel).getByText('EUR 21.16')).toBeInTheDocument();
  });

  it('shows a PURE EXPORT as zero francs of VAT, which is an answer and not a gap', async () => {
    // MWSTG Art. 23, echt befreit: the posting books debtor and revenue and writes no output-VAT row
    // at all. Zero francs is what a filer needs to see. The draft arm below renders no panel, and
    // that difference is the whole distinction: nothing charged is not the same as nothing posted.
    renderDetail(cannedFor(fx.issuedExport), '/documents/doc_fx_5');
    const panel = await findSettledPanel();
    expect(fx.issuedExport.postedEntryId).not.toBeNull();
    expect(within(panel).getByText('CHF 0.00')).toBeInTheDocument();
    expect(within(panel).getByText('EUR 0.00')).toBeInTheDocument();
    // And the conversion itself is still disclosed: the export converted CHF 1'411.80 of turnover.
    expect(within(panel).getByText("CHF 1'411.80")).toBeInTheDocument();
  });

  it('states both VAT figures at parity, where they coincide and the numbers cannot say so', async () => {
    renderDetail(cannedFor(fx.issuedPegged), '/documents/doc_fx_3');
    const panel = await findSettledPanel();
    expect(fx.issuedPegged.baseTaxMinor).toBe(fx.issuedPegged.taxMinor);
    // Going quiet here would make a pegged foreign invoice indistinguishable from a franc one, and
    // the franc one is the arm on which this panel is absent entirely.
    expect(within(panel).getAllByText('USD 121.50').length).toBe(1);
    expect(within(panel).getAllByText('CHF 121.50').length).toBe(1);
  });

  it('says the franc VAT is the figure the MWST return is filed on', async () => {
    renderDetail(cannedFor(fx.issuedForeign));
    const panel = await findSettledPanel();
    expect(within(panel).getByText(/MWST-Abrechnung/)).toBeInTheDocument();
  });

  it('EMPTY: a base-currency invoice states no basis, so neither VAT figure is restated', async () => {
    renderDetail(cannedFor(fx.issuedBase), '/documents/doc_fx_2');
    await screen.findByRole('heading', { name: /R-2026-0002/ });
    await settleInvoiceReads();
    // The engine sends no FX group here, so there is no second VAT figure to show. Printing the
    // franc VAT beside an identical franc VAT would be noise on the overwhelming majority of
    // documents, and inventing one would be worse.
    expect(screen.queryByText('MWST gebucht')).not.toBeInTheDocument();
  });

  it('has no axe violations with both VAT figures on screen', async () => {
    const { container } = renderDetail(cannedFor(fx.issuedTwoRate), '/documents/doc_fx_6');
    // Settled before the pass, for the same two reasons as the sibling axe test above. This is the
    // test the intermittent failure landed on, and the draft test below is the one it took with it.
    await findSettledPanel();
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

describe('DocumentDetail FX panel, documents with nothing posted', () => {
  it('shows nothing for a foreign DRAFT, which reaches the editor rather than this surface', async () => {
    renderDetail(cannedFor(fx.draftForeign), '/documents/doc_fx_4');
    // The draft arm carries `baseCurrency: "CHF"` with both figures null, so a guard keyed on the
    // currency alone would render a base total of null here. It is also routed to S2, where the
    // currency picker already states the rate and what will happen at issue.
    expect(fx.draftForeign.baseCurrency).toBe('CHF');
    expect(fx.draftForeign.totalBaseMinor).toBeNull();
    // And no franc VAT either. This is the arm the export above must never be confused with: there
    // the figure is a real zero on a posted invoice, here it is genuinely unknown because nothing
    // has posted. A draft has no base figures, and the editor is right to show none.
    expect(fx.draftForeign.baseTaxMinor).toBeNull();
    // The draft routes to S2, so the anchor is one of the editor's own always-present controls.
    await screen.findByLabelText('Datum');
    expect(screen.queryByLabelText(PANEL)).not.toBeInTheDocument();
    expect(screen.queryByText('MWST gebucht')).not.toBeInTheDocument();
  });

  it('shows nothing for a foreign QUOTE, which is issued but posts no ledger entry', async () => {
    // A quote in EUR gets a number and no posting, so the engine leaves both figures null. There is
    // no rate to disclose, and inventing today's would be the client promising a price nothing fixed.
    renderDetail(
      cannedFor({ ...fx.draftForeign, type: 'quote', status: 'issued', number: 'O-2026-0009', issueDate: '2026-07-16' }),
    );
    await screen.findByRole('heading', { name: /O-2026-0009/ });
    // A quote carries no payment part, so the QR read never starts and the VAT summary is the whole
    // of what outlives the document read here.
    await screen.findByLabelText(VAT_SUMMARY);
    expect(screen.queryByLabelText(PANEL)).not.toBeInTheDocument();
  });
});
