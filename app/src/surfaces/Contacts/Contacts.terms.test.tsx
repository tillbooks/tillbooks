/**
 * D163 (owner pick, 04.10.2026): the contact's Zahlungsfrist tells "Standard" from "sofort".
 *
 * The engine stores a contact's terms as null ("no terms of its own, the workspace default from the
 * Firmenprofil applies") or a number of days, where 0 is "due immediately". The editor's terms field
 * says which in words: empty reads "Standard (30 Tage)" with the workspace default from
 * `get_company_profile`, and 0 reads "sofort". An emptied field on an existing contact sends `null`;
 * a new contact with an empty field sends no terms at all. A workspace switch closes the editor and
 * forgets the old workspace's Standard, and an answer to the old workspace's read speaks nowhere.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider, useWorkspace } from '../../app/workspace';
import Contacts from './index';

type CannedHandler = (input: Record<string, unknown>) => RestResponse | Promise<RestResponse>;
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

const CONTACTS = [
  { id: 'k1', partyRole: 'customer', name: 'Muster AG', defaultCurrency: 'CHF', paymentTermsDays: 30, address: null },
  { id: 'k2', partyRole: 'customer', name: 'Sofort AG', defaultCurrency: 'CHF', paymentTermsDays: 0, address: null },
  { id: 'k3', partyRole: 'vendor', name: 'Standard GmbH', defaultCurrency: 'CHF', paymentTermsDays: null, address: null },
];

const profile = (defaultPaymentTermsDays: number | null) => ok({ profile: { baseCurrency: 'CHF', defaultPaymentTermsDays } });

/** A control inside the provider that switches the workspace, as the header switcher does. */
function Switcher() {
  const { setWorkspaceId } = useWorkspace();
  return (
    <button type="button" onClick={() => setWorkspaceId('ws_other')}>
      switch
    </button>
  );
}

function renderContacts(canned: Canned) {
  const client = new TillClient(fakeTransport(canned));
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter>
            <Switcher />
            <Contacts />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

const termsField = (dialog: HTMLElement) => within(dialog).getByLabelText('Zahlungsfrist (Tage)');
const describedText = (el: HTMLElement) => document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent ?? null;

async function openNew() {
  await screen.findByText('Muster AG');
  await userEvent.click(screen.getByRole('button', { name: 'Neuer Kontakt' }));
  return screen.findByRole('dialog');
}

async function openEdit(name: string) {
  const row = (await screen.findByText(name)).closest('tr') as HTMLElement;
  await userEvent.click(within(row).getByRole('button', { name: `Weitere Aktionen für Kontakt ${name}` }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Bearbeiten' }));
  return screen.findByRole('dialog');
}

describe('D163: the Zahlungsfrist field, Standard versus sofort', () => {
  it('an empty field says the Firmenprofil Standard with its days; 0 says sofort', async () => {
    renderContacts({ list_contacts: ok({ contacts: CONTACTS }), get_company_profile: profile(30) });
    const dialog = await openNew();
    const field = termsField(dialog);
    expect(field).toHaveValue('');
    await waitFor(() => expect(describedText(field)).toBe('Standard (30 Tage)'));
    expect(field).toHaveAttribute('placeholder', 'Standard (30 Tage)');
    await userEvent.type(field, '0');
    expect(describedText(field)).toBe('sofort');
    await userEvent.clear(field);
    await userEvent.type(field, '45');
    // A number of its own needs no words.
    expect(field).not.toHaveAttribute('aria-describedby');
    // The (i) holds the rule.
    const info = within(dialog).getByRole('button', { name: 'Woher die Zahlungsfrist kommt' });
    expect(describedText(info)).toContain('0 heisst sofort fällig');
  });

  it('with no Standard set the empty field says sofort; with an unreadable profile it says only Standard', async () => {
    const first = renderContacts({ list_contacts: ok({ contacts: CONTACTS }), get_company_profile: profile(null) });
    let dialog = await openNew();
    await waitFor(() => expect(describedText(termsField(dialog))).toBe('Standard (sofort)'));
    first.unmount();

    renderContacts({ list_contacts: ok({ contacts: CONTACTS }), get_company_profile: reject('internal_error', 500) });
    dialog = await openNew();
    expect(describedText(termsField(dialog))).toBe('Standard');
  });

  it('a new contact with an empty field sends no terms; with 0 it sends 0', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ contact: { id: 'n1' } }));
    renderContacts({ list_contacts: ok({ contacts: CONTACTS }), get_company_profile: profile(30), create_contact: createSpy });
    let dialog = await openNew();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Neu AG');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    // Undefined, which the wire (JSON) drops: the engine sees no terms and stores null.
    expect(createSpy.mock.calls[0][0].paymentTermsDays).toBeUndefined();
    expect(JSON.parse(JSON.stringify(createSpy.mock.calls[0][0]))).not.toHaveProperty('paymentTermsDays');

    dialog = await openNew();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Sofortzahler AG');
    await userEvent.type(termsField(dialog), '0');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(2));
    expect(createSpy.mock.calls[1][0].paymentTermsDays).toBe(0);
  });

  it('an existing contact: emptied sends null (back to Standard), 0 stays 0, a number stays a number', async () => {
    const updateSpy = vi.fn<CannedHandler>(() => ok());
    renderContacts({ list_contacts: ok({ contacts: CONTACTS }), get_company_profile: profile(30), update_contact: updateSpy });
    let dialog = await openEdit('Muster AG');
    expect(termsField(dialog)).toHaveValue('30');
    await userEvent.clear(termsField(dialog));
    expect(describedText(termsField(dialog))).toBe('Standard (30 Tage)');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(updateSpy).toHaveBeenCalledOnce());
    expect((updateSpy.mock.calls[0][0].patch as Record<string, unknown>).paymentTermsDays).toBeNull();

    dialog = await openEdit('Sofort AG');
    expect(termsField(dialog)).toHaveValue('0');
    expect(describedText(termsField(dialog))).toBe('sofort');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(2));
    expect((updateSpy.mock.calls[1][0].patch as Record<string, unknown>).paymentTermsDays).toBe(0);

    dialog = await openEdit('Standard GmbH');
    expect(termsField(dialog)).toHaveValue('');
    expect(describedText(termsField(dialog))).toBe('Standard (30 Tage)');
  });

  it('anything but a whole number of days is refused at the field, and nothing is written', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ contact: { id: 'n1' } }));
    renderContacts({ list_contacts: ok({ contacts: CONTACTS }), get_company_profile: profile(30), create_contact: createSpy });
    const dialog = await openNew();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Neu AG');
    await userEvent.type(termsField(dialog), '2.5');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));
    expect(termsField(dialog)).toHaveAttribute('aria-invalid', 'true');
    expect(describedText(termsField(dialog))).toBe('Die Zahlungsfrist ist eine ganze Zahl von Tagen, von 0 bis 365. 0 heisst sofort, leer heisst Standard.');
    await waitFor(() => expect(document.activeElement).toBe(termsField(dialog)));
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('critic M1: more than 365 days is refused at the field; 365 is sent', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ contact: { id: 'n1' } }));
    renderContacts({ list_contacts: ok({ contacts: CONTACTS }), get_company_profile: profile(30), create_contact: createSpy });
    const dialog = await openNew();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Lang AG');
    await userEvent.type(termsField(dialog), '366');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));
    expect(termsField(dialog)).toHaveAttribute('aria-invalid', 'true');
    expect(createSpy).not.toHaveBeenCalled();
    await userEvent.clear(termsField(dialog));
    await userEvent.type(termsField(dialog), '365');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    expect(createSpy.mock.calls[0][0].paymentTermsDays).toBe(365);
  });

  it('critic M1: the engine\'s invalid_payment_terms_days lands on the terms field, not in a banner', async () => {
    renderContacts({
      list_contacts: ok({ contacts: CONTACTS }),
      get_company_profile: profile(30),
      create_contact: reject('invalid_payment_terms_days'),
    });
    const dialog = await openNew();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Neu AG');
    await userEvent.type(termsField(dialog), '10');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(termsField(dialog)).toHaveAttribute('aria-invalid', 'true'));
    expect(dialog.querySelector('.error-banner')).toBeNull();
  });
});

describe('D163: a workspace switch', () => {
  it('closes an open editor and shows the NEW workspace its own Standard', async () => {
    renderContacts({
      list_contacts: ok({ contacts: CONTACTS }),
      get_company_profile: (input) => profile(input.workspaceId === 'ws_other' ? 10 : 30),
    });
    const dialog = await openNew();
    await waitFor(() => expect(describedText(termsField(dialog))).toBe('Standard (30 Tage)'));
    await userEvent.click(screen.getByRole('button', { name: 'switch' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const next = await openNew();
    await waitFor(() => expect(describedText(termsField(next))).toBe('Standard (10 Tage)'));
  });

  it('an answer to the old workspace\'s read that lands after the switch is dropped', async () => {
    let releaseOld: (() => void) | null = null;
    renderContacts({
      list_contacts: ok({ contacts: CONTACTS }),
      get_company_profile: (input) => {
        if (input.workspaceId === 'ws_other') return profile(10);
        // The first workspace's profile answers only when the test says so, after the switch.
        return new Promise<RestResponse>((resolve) => {
          releaseOld = () => resolve(profile(30));
        });
      },
    });
    await waitFor(() => expect(releaseOld).not.toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'switch' }));
    const dialog = await openNew();
    await waitFor(() => expect(describedText(termsField(dialog))).toBe('Standard (10 Tage)'));
    await act(async () => {
      releaseOld?.();
    });
    expect(describedText(termsField(dialog))).toBe('Standard (10 Tage)');
  });
});
