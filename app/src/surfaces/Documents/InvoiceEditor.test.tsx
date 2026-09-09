/**
 * S2's invoice extension: all five GUI states (loading, empty, populated, error, permission-denied),
 * driven through the REAL shared editor rather than the pieces in isolation, so the test proves the
 * composition and not just the components.
 *
 * The fixtures are the live-engine ones pinned by `test/sales/invoice-gui-fixture.test.mjs`.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { hang, watchReads } from '../../test-transport';
import DocumentsSurface from './index';
import profileFixture from '../Setup/company-profile.fixture.json';

/**
 * A canned handler exactly as the transport calls it: the request input in, a RestResponse out.
 *
 * Spies are declared `vi.fn<CannedHandler>(...)` rather than bare `vi.fn(...)`, so that
 * `spy.mock.calls[0][0]` is the request the surface actually sent. Inferred from a zero-argument
 * implementation the calls tuple is empty, and every assertion about what the surface asked for is
 * a compile error the moment anyone type-checks this file.
 */
type CannedHandler = (input: Record<string, unknown>) => RestResponse;

type Canned = Record<string, RestResponse | CannedHandler>;

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, status = 422): RestResponse => ({ status, body: { ok: false, error } });

const TAX_CODES = [
  { code: 'UST81', kind: 'output', rateBp: 810, formLine: '303', label: 'Normalsatz 8.1%', active: true },
];

/** A customer with the complete structured address the QR-bill needs since IG v2.3 (ST1). */
const COMPLETE_CONTACT = {
  id: 'ct_1',
  name: 'Muster AG',
  email: 'kunde@example.ch',
  paymentTermsDays: 30,
  address: { street: 'Musterweg', houseNo: '7', zip: '3000', city: 'Bern', country: 'CH' },
};

/** The same customer with the address half-filled: M10's flagged, fixable error. */
const INCOMPLETE_CONTACT = {
  ...COMPLETE_CONTACT,
  address: { street: 'Musterweg', houseNo: '7', zip: null, city: null, country: 'CH' },
};

function renderEditor(canned: Canned, initial = '/documents/new?type=invoice') {
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

const base = (contacts: unknown[] = [COMPLETE_CONTACT]): Canned => ({
  list_contacts: ok({ contacts }),
  vat_codes: ok({ taxCodes: TAX_CODES }),
  get_company_profile: ok({ profile: profileFixture.profile }),
  vat_preview: ok({
    ok: true,
    kind: 'output',
    netMinor: 15000,
    taxMinor: 1215,
    grossMinor: 16215,
    rateBp: 810,
    deductible: false,
    formLine: '303',
    trace: { taxCode: 'UST81', taxBaseMinor: 15000, taxAmountMinor: 1215 },
  }),
});

describe('InvoiceEditor, the five states', () => {
  it('LOADING: a skeleton, not a spinner, while the pickers and profile resolve', async () => {
    const transport = watchReads(hang('list_contacts', async () => ok()));
    const client = new TillClient(transport);
    render(
      <TillClientProvider client={client}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter initialEntries={['/documents/new?type=invoice']}>
              <Routes>
                <Route path="/documents/*" element={<DocumentsSurface />} />
              </Routes>
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    // The editor paints its skeleton on the first commit, so the two assertions below would hold
    // just as well over an editor that never asked for a contact. The wait is what makes this a
    // LOADING test rather than a first-commit test.
    await transport.started('list_contacts');
    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(screen.queryByLabelText('Zahlbar bis')).not.toBeInTheDocument();
  });

  it('EMPTY: a new invoice offers the terms row and states the reference does not exist yet', async () => {
    renderEditor(base());
    // The reference is generated at issue from the invoice number, so a draft says so instead of
    // showing a number that would change (the design cut a draft-time QR for exactly this reason).
    expect(await screen.findByText(/Die Referenz wird beim Ausstellen/)).toBeInTheDocument();
    expect(screen.getByLabelText('Zahlbar bis')).toHaveValue('');
  });

  it('POPULATED: the customer terms are offered as a one-click due date, never applied silently', async () => {
    renderEditor(base());
    await userEvent.selectOptions(await screen.findByLabelText('Kunde'), 'ct_1');

    // The stored terms are shown, and the derived date sits behind an explicit control.
    expect(screen.getByText(/30 Tage/)).toBeInTheDocument();
    const due = screen.getByLabelText('Zahlbar bis');
    expect(due).toHaveValue('');

    const apply = screen.getByRole('button', { name: /Frist übernehmen/ });
    await userEvent.click(apply);
    // today + 30 days, in ISO on the wire.
    const expected = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    expect(due).toHaveValue(expected);
  });

  it('POPULATED: a complete address, an IBAN and CHF read as QR-ready, with no fabricated QR', async () => {
    renderEditor(base());
    await userEvent.selectOptions(await screen.findByLabelText('Kunde'), 'ct_1');
    const panel = screen.getByLabelText('QR-Bereitschaft');
    expect(within(panel).getByText(/Alles bereit/)).toBeInTheDocument();
    expect(within(panel).getByText(/Den QR-Zahlteil gibt es ab dem Ausstellen/)).toBeInTheDocument();
    // No QR, no reference, no payload anywhere on a draft.
    expect(screen.queryByText(/Swiss Payments Code/)).not.toBeInTheDocument();
  });

  it('ERROR: an incomplete customer address names the missing fields and links to the fix (M10)', async () => {
    renderEditor(base([INCOMPLETE_CONTACT]));
    await userEvent.selectOptions(await screen.findByLabelText('Kunde'), 'ct_1');
    const panel = screen.getByLabelText('QR-Bereitschaft');
    expect(within(panel).getByText(/PLZ, Ort/)).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Adresse vervollständigen' })).toHaveAttribute('href', '/contacts');
  });

  it('ERROR: no IBAN of any kind names it and links to Setup, and does NOT block issuing (M9)', async () => {
    renderEditor({ ...base(), get_company_profile: ok({ profile: { ...profileFixture.profile, creditorIban: null } }) });
    await userEvent.selectOptions(await screen.findByLabelText('Kunde'), 'ct_1');
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    const panel = screen.getByLabelText('QR-Bereitschaft');
    expect(within(panel).getByText(/keine IBAN hinterlegt/)).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'IBAN hinterlegen' })).toHaveAttribute('href', '/setup');
    // Issue stays available: a missing IBAN costs the payment part, not the invoice (M9).
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ausstellen' })).toBeEnabled());
  });

  it('ERROR: a currency outside CHF/EUR warns at the control, not at issue (M13/ST3)', async () => {
    renderEditor(base());
    await userEvent.selectOptions(await screen.findByLabelText('Kunde'), 'ct_1');
    // The picker offers CHF and EUR plus whatever has a rate on file; anything else goes through the
    // explicit "other" arm, which keeps every ISO code reachable without pretending USD is on a menu.
    await userEvent.selectOptions(screen.getByLabelText('Währung'), '__other__');
    await userEvent.type(screen.getByLabelText('Währungscode'), 'USD');

    // The full explanation sits at the control (M13: prevent at the control) ...
    expect(await screen.findByText(/nur in CHF und EUR/)).toBeInTheDocument();
    // ... and the readiness checklist carries the one-line consequence, from the same helper, so the
    // two can never disagree about whether a payment part is possible.
    expect(within(screen.getByLabelText('QR-Bereitschaft')).getByText(/In USD gibt es keinen QR-Zahlteil/)).toBeInTheDocument();
  });

  it('ERROR: a rejected profile read degrades to the needs-IBAN gap rather than claiming readiness', async () => {
    renderEditor({ ...base(), get_company_profile: reject('workspace_not_found', 404) });
    await userEvent.selectOptions(await screen.findByLabelText('Kunde'), 'ct_1');
    expect(within(screen.getByLabelText('QR-Bereitschaft')).getByText(/keine IBAN hinterlegt/)).toBeInTheDocument();
  });

  /*
   * A11-G11. The readiness panel is honest and unmissable in a test, and roughly 900 px below
   * Ausstellen and off the bottom of the screen in a browser (measured: issue at y=62, the gap at
   * y=936, viewport 900). So the gap now also rides into the S4 dialog, which is the last thing
   * between a person and an irreversible act, and is derived from the same `qrReadiness`.
   */
  it('POPULATED: the issue dialog names the missing payment part before the irreversible step', async () => {
    renderEditor({
      ...base([INCOMPLETE_CONTACT]),
      get_company_profile: ok({ profile: { ...profileFixture.profile, creditorIban: null } }),
      create_document: ok({ document: { id: 'doc_new', type: 'invoice', status: 'draft' } }),
    });
    await userEvent.selectOptions(await screen.findByLabelText('Kunde'), 'ct_1');
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ausstellen' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Ausstellen' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Rechnung ausstellen' });
    expect(dialog).toHaveTextContent('Diese Rechnung bekommt keinen QR-Zahlteil:');
    // BOTH gaps, in the panel's own words: the missing IBAN and the named address fields.
    expect(within(dialog).getByText(/keine IBAN hinterlegt/)).toBeInTheDocument();
    expect(within(dialog).getByText(/PLZ, Ort/)).toBeInTheDocument();
    // No link out: the draft is unsaved, so a route change here would destroy it. Cancel, fix, return.
    expect(within(dialog).queryByRole('link')).not.toBeInTheDocument();
  });

  it('POPULATED: a QR-ready invoice says nothing about a payment part it is not missing', async () => {
    renderEditor({
      ...base(),
      create_document: ok({ document: { id: 'doc_new', type: 'invoice', status: 'draft' } }),
    });
    await userEvent.selectOptions(await screen.findByLabelText('Kunde'), 'ct_1');
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ausstellen' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Ausstellen' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Rechnung ausstellen' });
    expect(dialog).not.toHaveTextContent('bekommt keinen QR-Zahlteil');
  });

  it('PERMISSION-DENIED: the terms field is disabled and the reason names the capability inline', async () => {
    renderEditor({ ...base(), create_document: reject('permission_denied', 403) });
    await userEvent.selectOptions(await screen.findByLabelText('Kunde'), 'ct_1');
    await userEvent.type(screen.getByLabelText('Bezeichnung 1'), 'Beratung');
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Dir fehlt die Berechtigung, Belege zu erstellen oder zu bearbeiten.');
    // D15/C3: the control is disabled, with the reason beside it, never shown then rejected.
    await waitFor(() => expect(screen.getByLabelText('Zahlbar bis')).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Ausstellen' })).toBeDisabled();
  });
});

describe('InvoiceEditor pins its type', () => {
  it('stays an invoice even when the url says quote, and offers no type control', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_new', type: 'invoice', status: 'draft' } }));
    renderEditor({ ...base(), create_document: createSpy }, '/documents/new-invoice?type=quote');

    // The invoice-only rows are present, and the type control that could change them is not.
    expect(await screen.findByLabelText('QR-Bereitschaft')).toBeInTheDocument();
    expect(screen.queryByLabelText('Typ')).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Kunde'), 'ct_1');
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    expect(createSpy.mock.calls[0][0]).toMatchObject({ type: 'invoice' });
  });
});

describe('InvoiceEditor, the due date reaches the engine', () => {
  it('sends dueDate as ISO on create and as null when cleared on update', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_new', type: 'invoice', status: 'draft' } }));
    const updateSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_new', type: 'invoice', status: 'draft' } }));
    renderEditor({ ...base(), create_document: createSpy, update_document: updateSpy });

    await userEvent.selectOptions(await screen.findByLabelText('Kunde'), 'ct_1');
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    await userEvent.click(screen.getByRole('button', { name: /Frist übernehmen/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    const expected = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    expect(createSpy.mock.calls[0][0]).toMatchObject({ dueDate: expected });

    // Clearing it patches an explicit null: absence must be storable, not just unsendable.
    await userEvent.clear(screen.getByLabelText('Zahlbar bis'));
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(updateSpy).toHaveBeenCalledOnce());
    expect((updateSpy.mock.calls[0][0] as { patch: { dueDate: unknown } }).patch.dueDate).toBeNull();
  });
});
