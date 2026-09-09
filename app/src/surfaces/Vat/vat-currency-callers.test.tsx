/**
 * A11-G2, the caller half: the three surfaces that mount the VAT controls hand them a real currency.
 *
 * `VatSummary` and `LineVatReadout` now take `currency` as a REQUIRED prop, which is the structural
 * half of the fix: the defect existed because `formatMoney(minor, currency = 'CHF')` has a default,
 * so a missing argument was a silently wrong label rather than an error. A required prop turns the
 * next call site that forgets into a compile failure. But a required prop can still be fed a
 * hardcoded 'CHF', so these tests hold each caller to the currency it genuinely has:
 *
 *   DocumentDetail (S3)  the issued document's own `currency`, off `get_document`
 *   DocumentEditor (S2)  the draft's currency, the one the picker set
 *   EntryDrawer   (S11)  the WORKSPACE base currency, off `get_company_profile`
 *
 * The drawer is the interesting one. It composes an entry with no currency of its own, so `postEntry`
 * resolves `baseCurrencyOf(ctx)`, and the figures it previews are base-currency figures. That is not
 * a synonym for CHF: a workspace's base currency is a setting, and the drawer had no way to know it,
 * so it now reads the same profile `DocumentEditor` already reads. The EUR-base test below fails
 * against any implementation that assumes francs.
 *
 * Every document body comes from `document-fx.fixture.json`, pinned to the live engine by
 * `test/sales/studio-fx-document-fixture.test.mjs`, and the VAT figures come from
 * `vat-currency-eur.fixture.json`, pinned by `test/vat/vat-currency-fixture.test.mjs`. Nothing here
 * types a response shape by hand: four Studio defects in this repo shipped from an assumed key.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { neverSettles, watchReads } from '../../test-transport';
import { recordedOk } from '../../lib/test-support';
import DocumentsSurface from '../Documents/index';
import Journal from '../Journal/index';
import getFixture from '../Documents/get-document.fixture.json';
import fx from '../Documents/document-fx.fixture.json';
import eur from './vat-currency-eur.fixture.json';

/**
 * The chart the drawer's per-line account picker is filled from is a RECORDING of the live
 * `list_accounts` answer (`test/accounts/capture-studio-list-accounts.mjs`), shared with Journal,
 * Items and Accounts and pinned by `test/studio/vat-callers-list-accounts-fixture.test.mjs`.
 *
 * It used to be two hand-typed rows, and BOTH names were wrong: `Kasse` for `Kassenbestand`,
 * `Büromaterial` for `Verwaltungs- und Bürokosten`. The drawer renders `{a.number} {a.name}` into
 * every option, so those names really did reach this suite's DOM. A fixture merely different from
 * the engine is the mechanism behind the defect family that shipped `1000 undefined` to a browser.
 */
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';

/** An account row from the recording, by its number. Throws rather than rendering `undefined`. */
function account(number: string) {
  const row = listAccountsFixture.accounts.find((a) => a.number === number);
  if (row === undefined) throw new Error(`the recorded chart has no account ${number}`);
  return row;
}

/** The expense account the drawer cases below tag with a tax code, picked by its number. */
const BUERO = account('6500');

type Canned = Record<string, RestResponse | ((input: Record<string, unknown>) => RestResponse)>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, status = 422): RestResponse => ({ status, body: { ok: false, error } });

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

/** `vat_preview` answering for the pinned EUR invoice's single line, in EUR because the line is. */
const VAT_PREVIEW = ok({
  ok: true,
  kind: 'output',
  netMinor: eur.netMinor,
  taxMinor: eur.transactionTaxMinor,
  grossMinor: eur.transactionTotalMinor,
  rateBp: 810,
  deductible: false,
  formLine: '303',
  trace: { taxCode: 'UST81', taxBaseMinor: eur.netMinor, taxAmountMinor: eur.transactionTaxMinor },
});

const TAX_CODES = [
  { code: 'UST81', kind: 'output', rateBp: 810, formLine: '303', label: 'Normalsatz 8.1%', active: true },
];

// --- S3, the issued document ----------------------------------------------------------------------

function renderDetail(canned: Canned, initial = '/documents/doc_fx_1') {
  return render(
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
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

const detailCanned = (document: Record<string, unknown>): Canned => ({
  get_document: ok({ document, lines: getFixture.lines, history: getFixture.history }),
  get_contact: ok({ contact: { id: 'ct_1', name: 'Muster AG' } }),
  vat_preview: VAT_PREVIEW,
  get_invoice_qr: reject('needs_qr_iban'),
});

describe('DocumentDetail hands the VAT panel the document currency (A11-G2)', () => {
  it('shows the booked francs and the EUR tax on one screen, each labelled truthfully', async () => {
    renderDetail(detailCanned(fx.issuedForeign));
    const panel = await screen.findByLabelText('MWST-Übersicht');

    // The bug in one screenshot: `Gebucht CHF 1'526.16` sat directly above `Total MWST CHF 121.50`,
    // and the second figure was the EUR tax. Both panels are on screen here, so a regression that
    // relabels one of them cannot hide behind the other.
    const fxPanel = screen.getByLabelText('Umrechnung der Buchung');
    expect(within(fxPanel).getByText("CHF 1'526.16")).toBeInTheDocument();
    // Twice: the 8.1% row's tax and the panel total, which on a one-line document coincide. Both
    // are separate `formatMoney` calls and the defect hit each of them, so both are asserted.
    expect(within(panel).getAllByText('EUR 121.50')).toHaveLength(2);
    expect(within(panel).queryByText('CHF 121.50')).not.toBeInTheDocument();
    expect(panel.textContent).not.toMatch(/CHF/);

    // Read back off the pinned fixtures, so a stale literal cannot keep this green.
    expect(fx.issuedForeign.currency).toBe(eur.currency);
    expect(fx.issuedForeign.totalBaseMinor).toBe(eur.baseTotalMinor);
  });

  it('never prints the francs the ledger holds for the tax, because vat_preview does not send them', async () => {
    renderDetail(detailCanned(fx.issuedForeign));
    const panel = await screen.findByLabelText('MWST-Übersicht');
    // CHF 114.36 is real, it is what an MWST return needs, and it now reaches the Studio as
    // `baseTaxMinor` on `get_document`. It does NOT reach `vat_preview`, which is the only source
    // this panel reads, so a franc figure appearing HERE was computed from the rate rather than read
    // off the books. S3 shows the real one in the M11 panel above, and the assertion below is what
    // keeps the two from being confused for one another.
    expect(eur.baseTaxMinor).toBe(11436);
    expect(panel.textContent).not.toMatch(/114\.36/);
    // And the figure is genuinely on screen, one panel up, off the wire.
    expect(within(screen.getByLabelText('Umrechnung der Buchung')).getByText('CHF 114.36')).toBeInTheDocument();
    expect(fx.issuedForeign.baseTaxMinor).toBe(eur.baseTaxMinor);
  });

  it('still labels a franc document CHF, which is why the defect went unnoticed', async () => {
    renderDetail(detailCanned(fx.issuedBase), '/documents/doc_fx_2');
    const panel = await screen.findByLabelText('MWST-Übersicht');
    expect(fx.issuedBase.currency).toBe('CHF');
    expect(within(panel).getAllByText('CHF 121.50')).toHaveLength(2);
  });

  it('LOADING: no VAT figure is on screen until the document read has really gone in flight', async () => {
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter initialEntries={['/documents/doc_fx_1']}>
              <Routes>
                <Route path="/documents/*" element={<DocumentsSurface />} />
              </Routes>
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    // The surface initialises `loading` to true, so the skeleton predates every effect. Waiting for
    // the read is what makes the absence below a statement about the load rather than the default.
    await transport.started('get_document');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    // The currency is unknown until the document arrives, so no money may appear under any label.
    expect(screen.queryByText(/CHF|EUR/)).not.toBeInTheDocument();
  });
});

// --- S2, the draft --------------------------------------------------------------------------------

function renderEditor(canned: Canned) {
  return render(
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter initialEntries={['/documents/new']}>
            <Routes>
              <Route path="/documents/*" element={<DocumentsSurface />} />
            </Routes>
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('DocumentEditor hands the VAT controls the draft currency (A11-G2)', () => {
  it('labels the line readout and the summary in the currency the picker chose', async () => {
    renderEditor({
      list_contacts: ok({ contacts: [{ id: 'ct_1', name: 'Muster AG' }] }),
      vat_codes: ok({ taxCodes: TAX_CODES }),
      get_company_profile: ok({ profile: { creditorIban: null, baseCurrency: 'CHF' } }),
      resolve_exchange_rate: ok({ rate: eur.fxRate, asOf: '2026-07-15' }),
      vat_preview: VAT_PREVIEW,
    });

    await userEvent.selectOptions(await screen.findByLabelText('Kunde'), 'ct_1');
    await userEvent.selectOptions(screen.getByLabelText('Währung'), eur.currency);
    await userEvent.type(screen.getByLabelText('Bezeichnung 1'), 'Beratung');
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '1500');
    await userEvent.selectOptions(screen.getByLabelText('MWST 1'), 'UST81');

    // A draft has posted nothing, so there is no rate and no franc figure to show even in principle.
    // The transaction currency is the only truth on this screen, and the labels say so.
    expect(await screen.findByText(/MWST EUR 121\.50/)).toBeInTheDocument();
    const panel = screen.getByLabelText('MWST-Übersicht');
    expect(within(panel).getAllByText('EUR 121.50')).toHaveLength(2);
    expect(panel.textContent).not.toMatch(/CHF/);
  });
});

// --- S11, the journal entry drawer ----------------------------------------------------------------

function renderJournal(canned: Canned) {
  const transport = watchReads(fakeTransport(canned));
  const utils = render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider initialLocale="en">
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter>
            <Journal />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
  return { ...utils, transport };
}

const drawerCanned = (baseCurrency: string): Canned => ({
  list_journal: ok({ entries: [] }),
  list_accounts: { status: 200, body: recordedOk(listAccountsFixture) },
  vat_codes: ok({ taxCodes: TAX_CODES }),
  list_cost_centers: ok({ costCenters: [] }),
  get_company_profile: ok({ profile: { creditorIban: null, baseCurrency } }),
  vat_preview: VAT_PREVIEW,
});

describe('EntryDrawer hands the VAT controls the WORKSPACE base currency (A11-G2)', () => {
  async function openDrawerWithATaxedLine(baseCurrency: string) {
    const rendered = renderJournal(drawerCanned(baseCurrency));
    await userEvent.click(await screen.findByRole('button', { name: 'New entry' }));
    const dialog = await screen.findByRole('dialog');
    // F-03 (J3.7): the account field is a typeable combobox; pick by typing the number, then Enter.
    const accountField = await within(dialog).findByLabelText('Account 1');
    await userEvent.clear(accountField);
    await userEvent.type(accountField, BUERO.number);
    await userEvent.keyboard('{Enter}');
    await userEvent.type(within(dialog).getByLabelText('Credit 1'), '1500.00');
    await userEvent.selectOptions(within(dialog).getByLabelText('Tax code 1'), 'UST81');
    return { ...rendered, dialog };
  }

  it('labels the drawer VAT in CHF when the books are kept in francs', async () => {
    const { dialog } = await openDrawerWithATaxedLine('CHF');
    expect(await within(dialog).findByText(/VAT CHF 121\.50/)).toBeInTheDocument();
    expect(within(dialog).getAllByText('CHF 121.50')).toHaveLength(2);
  });

  it('labels it EUR when the books are kept in EUR, which no hardcoded CHF can satisfy', async () => {
    // The drawer sends `post_entry` with no currency, so the engine books in `baseCurrencyOf(ctx)`.
    // That is a workspace SETTING. This is the assertion that a `currency="CHF"` at the call site
    // (a required prop fed a constant) cannot pass, which is the point of asserting it at all.
    const { dialog } = await openDrawerWithATaxedLine('EUR');
    expect(await within(dialog).findByText(/VAT EUR 121\.50/)).toBeInTheDocument();
    expect(within(dialog).getAllByText('EUR 121.50')).toHaveLength(2);
    expect(within(dialog).queryByText('CHF 121.50')).not.toBeInTheDocument();
  });

  it('reads the base currency in flight rather than assuming one, before any figure appears', async () => {
    const { transport } = renderJournal(drawerCanned('EUR'));
    await userEvent.click(await screen.findByRole('button', { name: 'New entry' }));
    // The drawer must ASK. Without this the EUR test above would still pass over an implementation
    // that happened to default correctly for one fixture, and the currency would be a coincidence.
    await transport.started('get_company_profile');
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
  });
});
