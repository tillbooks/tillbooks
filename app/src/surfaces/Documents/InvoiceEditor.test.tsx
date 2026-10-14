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

/** Pick Muster AG and give line 1 an amount: the state in which the figures speak (D152 rule 2). */
async function customerAndAmount() {
  await userEvent.click(await screen.findByLabelText('Kunde'));
  await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
  await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
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

  it('EMPTY: a new invoice offers the terms row; that the reference does not exist yet is behind the (i)', async () => {
    renderEditor(base());
    // The reference is generated at issue from the invoice number, so a draft says so instead of
    // showing a number that would change (the design cut a draft-time QR for exactly this reason).
    // D152 rule 4: an explanation, so it is the (i)'s card, not a sentence in the row.
    const info = await screen.findByRole('button', { name: 'Mehr zu den Konditionen' });
    expect(info).toHaveAccessibleDescription('Die Zahlungsreferenz entsteht beim Ausstellen aus der Rechnungsnummer.');
    expect(screen.queryByText(/^Zahlungsreferenz/)).not.toBeInTheDocument();
    // No customer, no terms: nothing to infer yet.
    expect(screen.getByLabelText('Zahlbar bis')).toHaveValue('');
  });

  it('POPULATED (D152 rule 1, critic F3): the customer terms are STATED as what the issue sets, never stored as a guess', async () => {
    renderEditor(base());
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));

    // The field stays the person's: empty, and described by what the issue will derive.
    const due = screen.getByLabelText('Zahlbar bis');
    expect(due).toHaveValue('');
    expect(due).toHaveAccessibleDescription('Ergibt sich beim Ausstellen: 30 Tage ab Rechnungsdatum.');
    expect(screen.queryByRole('button', { name: /Frist übernehmen/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mehr zu den Konditionen' })).toHaveAccessibleDescription(
      /Ausstellungsdatum plus die Zahlungsfrist von Muster AG \(30 Tage\)/,
    );
  });

  it('POPULATED: a date the person typed replaces the hint, and survives a customer re-pick', async () => {
    renderEditor(base());
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    const due = screen.getByLabelText('Zahlbar bis');
    await userEvent.type(due, '2026-12-24');
    expect(due).toHaveValue('2026-12-24');
    expect(screen.queryByText(/Ergibt sich beim Ausstellen/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mehr zu den Konditionen' })).not.toHaveAccessibleDescription(/Zahlungsfrist/);
    await userEvent.click(screen.getByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    expect(due).toHaveValue('2026-12-24');
  });

  // D163, the one rule (src/core/setup/paymentTerms.ts): the customer's own terms (null: none of its
  // own), else the Firmenprofil default, else 0 days. 0 on the customer is "due immediately" and wins
  // over the default. The hint states what the issue will derive; the field stays empty.
  const pickMuster = async () => {
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
  };

  it('POPULATED (D163): a customer without terms of their own (null) gets the Firmenprofil default at issue, and the row says so', async () => {
    renderEditor(base([{ ...COMPLETE_CONTACT, paymentTermsDays: null }]));
    await pickMuster();
    expect(profileFixture.profile.defaultPaymentTermsDays).toBe(30);
    expect(screen.getByLabelText('Zahlbar bis')).toHaveValue('');
    expect(screen.getByLabelText('Zahlbar bis')).toHaveAccessibleDescription('Ergibt sich beim Ausstellen: 30 Tage ab Rechnungsdatum.');
    expect(screen.getByRole('button', { name: 'Mehr zu den Konditionen' })).toHaveAccessibleDescription(
      /Muster AG hat keine eigene Zahlungsfrist, also gilt die Standardfrist von 30 Tagen/,
    );
  });

  it('POPULATED (D163): a customer whose terms are 0 is due on the invoice date, even with a default set', async () => {
    renderEditor(base([{ ...COMPLETE_CONTACT, paymentTermsDays: 0 }]));
    await pickMuster();
    expect(screen.getByLabelText('Zahlbar bis')).toHaveValue('');
    expect(screen.getByLabelText('Zahlbar bis')).toHaveAccessibleDescription('Ergibt sich beim Ausstellen: fällig am Rechnungsdatum.');
    expect(screen.getByRole('button', { name: 'Mehr zu den Konditionen' })).toHaveAccessibleDescription(/Muster AG zahlt sofort/);
  });

  it('POPULATED (D163): with no terms on the customer and no default, the invoice is due on its date', async () => {
    renderEditor({
      ...base([{ ...COMPLETE_CONTACT, paymentTermsDays: null }]),
      get_company_profile: ok({ profile: { ...profileFixture.profile, defaultPaymentTermsDays: null } }),
    });
    await pickMuster();
    expect(screen.getByLabelText('Zahlbar bis')).toHaveAccessibleDescription('Ergibt sich beim Ausstellen: fällig am Rechnungsdatum.');
    expect(screen.getByRole('button', { name: 'Mehr zu den Konditionen' })).toHaveAccessibleDescription(
      /Weder Muster AG noch der Arbeitsbereich hat eine Zahlungsfrist/,
    );
  });

  it('POPULATED (D163): a stored term outside 0 to 365 counts as none and falls through to the default, as in the engine', async () => {
    renderEditor(base([{ ...COMPLETE_CONTACT, paymentTermsDays: 400 }]));
    await pickMuster();
    expect(screen.getByLabelText('Zahlbar bis')).toHaveAccessibleDescription('Ergibt sich beim Ausstellen: 30 Tage ab Rechnungsdatum.');
  });

  it('ERROR (D163): a failed Firmenprofil read states no default; a customer with terms of its own still shows them', async () => {
    const failed: RestResponse = { status: 500, body: { ok: false, error: 'internal' } };
    renderEditor({ ...base([{ ...COMPLETE_CONTACT, paymentTermsDays: null }]), get_company_profile: failed });
    await pickMuster();
    expect(screen.getByLabelText('Zahlbar bis')).toHaveValue('');
    expect(screen.queryByText(/Ergibt sich beim Ausstellen/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Zahlbar bis')).not.toHaveAccessibleDescription(/Rechnungsdatum/);
  });

  it('ERROR (D163): with the Firmenprofil unread, a customer with its own 30 days still reads as 30 days', async () => {
    const failed: RestResponse = { status: 500, body: { ok: false, error: 'internal' } };
    renderEditor({ ...base(), get_company_profile: failed });
    await pickMuster();
    expect(screen.getByLabelText('Zahlbar bis')).toHaveAccessibleDescription('Ergibt sich beim Ausstellen: 30 Tage ab Rechnungsdatum.');
  });

  it('POPULATED: a complete address, an IBAN and CHF read as QR-ready, with no fabricated QR', async () => {
    renderEditor(base());
    await customerAndAmount();
    const panel = screen.getByLabelText('QR-Bereitschaft');
    expect(within(panel).getByText(/Alles bereit/)).toBeInTheDocument();
    // D152 rule 4: why the QR is not drawn yet is behind the (i), not a second sentence in the panel.
    expect(within(panel).getByRole('button', { name: 'Mehr zum QR-Zahlteil' })).toHaveAccessibleDescription(
      /Den QR-Zahlteil gibt es ab dem Ausstellen/,
    );
    expect(panel.querySelector('.invoice-qr-note')).toBeNull();
    // No QR, no reference, no payload anywhere on a draft.
    expect(screen.queryByText(/Swiss Payments Code/)).not.toBeInTheDocument();
  });

  it('ERROR: an incomplete customer address names the missing fields and links to the fix (M10)', async () => {
    renderEditor(base([INCOMPLETE_CONTACT]));
    await customerAndAmount();
    const panel = screen.getByLabelText('QR-Bereitschaft');
    expect(within(panel).getByText(/PLZ, Ort/)).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Adresse vervollständigen' })).toHaveAttribute('href', '/contacts');
  });

  it('ERROR: no IBAN of any kind names it and links to Setup, and does NOT block issuing (M9)', async () => {
    renderEditor({ ...base(), get_company_profile: ok({ profile: { ...profileFixture.profile, creditorIban: null } }) });
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    const panel = screen.getByLabelText('QR-Bereitschaft');
    expect(within(panel).getByText(/keine IBAN hinterlegt/)).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'IBAN hinterlegen' })).toHaveAttribute('href', '/setup');
    // Issue stays available: a missing IBAN costs the payment part, not the invoice (M9).
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ausstellen' })).toBeEnabled());
  });

  it('ERROR: a currency outside CHF/EUR warns at the control, not at issue (M13/ST3)', async () => {
    renderEditor(base());
    await customerAndAmount();
    // The picker offers CHF and EUR plus whatever has a rate on file; anything else goes through the
    // explicit "other" arm, which keeps every ISO code reachable without pretending USD is on a menu.
    await userEvent.click(screen.getByRole('combobox', { name: 'Währung' }));
    await userEvent.click(screen.getByRole('option', { name: 'Andere Währung' }));
    await userEvent.type(screen.getByLabelText('Währungscode'), 'USD');

    // The consequence sits at the control (M13: prevent at the control), its detail behind the (i) ...
    expect(await screen.findByText(/nur in CHF und EUR/)).toBeInTheDocument();
    // ... and the readiness checklist carries the one-line consequence, from the same helper, so the
    // two can never disagree about whether a payment part is possible.
    expect(within(screen.getByLabelText('QR-Bereitschaft')).getByText(/In USD gibt es keinen QR-Zahlteil/)).toBeInTheDocument();
  });

  it('ERROR: a rejected profile read degrades to the needs-IBAN gap rather than claiming readiness', async () => {
    renderEditor({ ...base(), get_company_profile: reject('workspace_not_found', 404) });
    await customerAndAmount();
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
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ausstellen' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Ausstellen' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Rechnung ausstellen' });
    // P0.4e: BOTH gaps are ASKED FOR in place (the IBAN and the customer's address), instead of being
    // listed as a consequence the person could only fix by leaving the dialog.
    expect(dialog).toHaveTextContent('Für den QR-Zahlteil fehlt noch etwas');
    expect(within(dialog).getByRole('group', { name: 'Dein Konto' })).toBeInTheDocument();
    expect(within(dialog).getByRole('group', { name: 'Adresse von Muster AG' })).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'IBAN oder QR-IBAN' })).toBeInTheDocument();
    // No link out: the draft is unsaved, so a route change here would destroy it. The fix is in place.
    expect(within(dialog).queryByRole('link')).not.toBeInTheDocument();
  });

  it('P0.4e: the first invoice asks for the customer address and issues WITH it: update_contact runs before issue_invoice', async () => {
    const order: string[] = [];
    const updateContact = vi.fn<CannedHandler>(() => {
      order.push('update_contact');
      return ok({});
    });
    const issueInvoice = vi.fn<CannedHandler>(() => {
      order.push('issue_invoice');
      return ok({ document: { id: 'doc_new', type: 'invoice', status: 'issued', number: 'R-2026-0001' } });
    });
    renderEditor({
      ...base([INCOMPLETE_CONTACT]),
      create_document: ok({ document: { id: 'doc_new', type: 'invoice', status: 'draft' } }),
      update_contact: updateContact,
      issue_invoice: issueInvoice,
    });
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ausstellen' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Ausstellen' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Rechnung ausstellen' });
    const block = within(dialog).getByRole('group', { name: 'Adresse von Muster AG' });
    const street = within(block).getByRole('textbox', { name: 'Strasse' });
    await userEvent.clear(street);
    await userEvent.type(street, 'Musterweg');
    await userEvent.type(within(block).getByRole('textbox', { name: 'PLZ' }), '3000');
    await userEvent.type(within(block).getByRole('textbox', { name: 'Ort' }), 'Bern');
    await userEvent.click(within(dialog).getByRole('button', { name: /Speichern und ausstellen|Speichern, ausstellen und senden/ }));

    await waitFor(() => expect(issueInvoice).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['update_contact', 'issue_invoice']);
    const sent = updateContact.mock.calls[0]![0];
    expect(sent).toMatchObject({ contactId: INCOMPLETE_CONTACT.id, patch: { address: { street: 'Musterweg', zip: '3000', city: 'Bern', country: 'CH' } } });
  });

  it('POPULATED: a QR-ready invoice says nothing about a payment part it is not missing', async () => {
    renderEditor({
      ...base(),
      create_document: ok({ document: { id: 'doc_new', type: 'invoice', status: 'draft' } }),
    });
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ausstellen' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Ausstellen' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Rechnung ausstellen' });
    expect(dialog).not.toHaveTextContent('bekommt keinen QR-Zahlteil');
  });

  it('PERMISSION-DENIED: the terms field is disabled and the reason names the capability inline', async () => {
    renderEditor({ ...base(), create_document: reject('permission_denied', 403) });
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await userEvent.type(screen.getByLabelText('Bezeichnung 1'), 'Beratung');
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Dir fehlt die Berechtigung, Belege zu erstellen oder zu bearbeiten.');
    // D15/C3: the control is disabled, with the reason beside it, never shown then rejected. A missing
    // right is not an unlocker beside the button, so here a disabled Ausstellen is the honest state.
    await waitFor(() => expect(screen.getByLabelText('Zahlbar bis')).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Ausstellen' })).toBeDisabled();
  });
});

describe('InvoiceEditor pins its type', () => {
  it('stays an invoice even when the url says quote, and offers no type control', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_new', type: 'invoice', status: 'draft' } }));
    renderEditor({ ...base(), create_document: createSpy }, '/documents/new-invoice?type=quote');

    // The invoice-only rows are present, and the type control that could change them is not.
    expect(await screen.findByLabelText('Konditionen')).toBeInTheDocument();
    expect(screen.queryByLabelText('Typ')).not.toBeInTheDocument();

    await customerAndAmount();
    expect(screen.getByLabelText('QR-Bereitschaft')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    expect(createSpy.mock.calls[0][0]).toMatchObject({ type: 'invoice' });
  });
});

describe('InvoiceEditor, the due date reaches the engine', () => {
  it('an untouched field sends NO dueDate (the issue derives it); a typed one is sent, a cleared one patched to null', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_new', type: 'invoice', status: 'draft' } }));
    const updateSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_new', type: 'invoice', status: 'draft' } }));
    renderEditor({ ...base(), create_document: createSpy, update_document: updateSpy });

    await customerAndAmount();
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    expect(createSpy.mock.calls[0][0]).not.toHaveProperty('dueDate');

    await userEvent.type(screen.getByLabelText('Zahlbar bis'), '2026-12-24');
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(updateSpy).toHaveBeenCalledOnce());
    expect((updateSpy.mock.calls[0][0] as { patch: { dueDate: unknown } }).patch.dueDate).toBe('2026-12-24');

    // Clearing it patches an explicit null: absence must be storable, not just unsendable.
    await userEvent.clear(screen.getByLabelText('Zahlbar bis'));
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(2));
    expect((updateSpy.mock.calls[1][0] as { patch: { dueDate: unknown } }).patch.dueDate).toBeNull();
  });

  it('a typed due date reaches the engine exactly as typed', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_new', type: 'invoice', status: 'draft' } }));
    renderEditor({ ...base(), create_document: createSpy });
    await customerAndAmount();
    await userEvent.type(screen.getByLabelText('Zahlbar bis'), '2026-12-24');
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    expect(createSpy.mock.calls[0][0]).toMatchObject({ dueDate: '2026-12-24' });
  });

  it('MONEY PATH: Ausstellen with an untouched due date sends none, then issue_invoice goes out with the unchanged payload', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_new', type: 'invoice', status: 'draft' } }));
    const issueSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_new', type: 'invoice', status: 'issued', number: 'R-2026-0001' } }));
    renderEditor({ ...base(), create_document: createSpy, issue_invoice: issueSpy, send_invoice: ok({}) });
    await customerAndAmount();
    await waitFor(() => expect(screen.getByLabelText('MWST-Übersicht')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Ausstellen' }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    expect(createSpy.mock.calls[0][0]).toMatchObject({ type: 'invoice', contactId: 'ct_1' });
    expect(createSpy.mock.calls[0][0]).not.toHaveProperty('dueDate');

    const dialog = await screen.findByRole('alertdialog', { name: 'Rechnung ausstellen' });
    expect(within(dialog).queryByText(/sofort überfällig/)).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /^Ausstellen/ }));
    await waitFor(() => expect(issueSpy).toHaveBeenCalledOnce());
    const sent = issueSpy.mock.calls[0][0];
    expect(Object.keys(sent).sort()).toEqual(['idempotencyKey', 'invoiceId', 'workspaceId']);
    expect(sent).toMatchObject({ workspaceId: 'ws_test', invoiceId: 'doc_new' });
    expect(String(sent.idempotencyKey)).toMatch(/^invoice-issue-/);
  });

  it('a saved draft keeps its stored due date; one saved without a date stays empty and states the derivation', async () => {
    const draft = (dueDate: string | null) =>
      ok({
        document: { id: 'doc_1', type: 'invoice', status: 'draft', contactId: 'ct_1', currency: 'CHF', notes: '', dueDate, totalMinor: 15000 },
        lines: [{ description: 'Beratung', quantityMilli: 1000, unitPriceMinor: 15000, taxCode: 'UST81' }],
        history: [],
      });
    const first = renderEditor({ ...base(), get_document: draft('2027-01-15') }, '/documents/doc_1');
    expect(await screen.findByLabelText('Zahlbar bis')).toHaveValue('2027-01-15');
    first.unmount();

    renderEditor({ ...base(), get_document: draft(null) }, '/documents/doc_1');
    const due = await screen.findByLabelText('Zahlbar bis');
    expect(due).toHaveValue('');
    await waitFor(() => expect(due).toHaveAccessibleDescription('Ergibt sich beim Ausstellen: 30 Tage ab Rechnungsdatum.'));
  });
});
