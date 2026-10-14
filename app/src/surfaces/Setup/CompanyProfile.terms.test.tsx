/**
 * D163 (owner pick, 04.10.2026): the Firmenprofil's Standard-Zahlungsfrist.
 *
 * One field in "Weitere Angaben", explained behind an (i), written by the page's ONE Speichern as its
 * own part (`update_company_profile` with `defaultPaymentTermsDays` and nothing else), so a refused
 * value never holds back the company name and the name never holds back the value. Blank clears the
 * default (null); anything but a whole number of days is refused at the field and never sent, so a
 * NaN can never reach the wire as null and clear the stored default behind a "Gespeichert".
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { recordedOk } from '../../lib/test-support';
import { CompanyProfile } from './CompanyProfile';
import workspacesFixture from './workspaces.fixture.json';
import fixture from './company-profile.fixture.json';

type Route = RestResponse | ((input: Record<string, unknown>) => RestResponse);

function renderSurface(routes: Record<string, Route>) {
  const transport: Transport = async (action, input) => {
    const route =
      routes[action] ?? (action === 'list_workspaces' ? ({ status: 200, body: recordedOk(workspacesFixture) } as RestResponse) : undefined);
    if (route === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof route === 'function' ? route(input) : route;
  };
  return render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter initialEntries={['/setup']}>
            <CompanyProfile />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

/** The fixture with the issuer equal to the Firmenname (the block stays closed) and a chosen default. */
function profileWith(defaultPaymentTermsDays: number | null): RestResponse {
  return {
    status: 200,
    body: recordedOk({ ...fixture, profile: { ...fixture.profile, creditorName: fixture.profile.name, defaultPaymentTermsDays } }),
  };
}

function spiedWrites() {
  const ok = (_input: Record<string, unknown>) => ({ status: 200, body: { ok: true } }) as RestResponse;
  return {
    update_company_profile: vi.fn(ok),
    set_fiscal_config: vi.fn(ok),
    vat_configure: vi.fn(ok),
    vat_seed_defaults: vi.fn(ok),
    set_creditor_profile: vi.fn(ok),
    set_ebill_config: vi.fn(ok),
    get_ebill_config: vi.fn((_input: Record<string, unknown>): RestResponse => ({ status: 200, body: recordedOk({ ok: true, config: null }) })),
  };
}

async function loaded(): Promise<HTMLElement> {
  const panel = (await screen.findByRole('region', { name: 'Firmenangaben' })) as HTMLElement;
  await waitFor(() => expect(screen.getByLabelText('eBill-Biller-ID')).toBeEnabled());
  return panel;
}

async function termsField(panel: HTMLElement): Promise<HTMLElement> {
  const toggle = within(panel).getByRole('button', { name: 'Weitere Angaben' });
  if (toggle.getAttribute('aria-expanded') !== 'true') await userEvent.click(toggle);
  return within(panel).getByLabelText('Standard-Zahlungsfrist (Tage)');
}

const save = () => userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
const header = () => document.querySelector('.surface-header-actions') as HTMLElement;

describe('D163: the Standard-Zahlungsfrist on the Firmenprofil', () => {
  it('sits in Weitere Angaben, closed on load, with its rule behind an (i)', async () => {
    renderSurface({ get_company_profile: profileWith(30), ...spiedWrites() });
    const panel = await loaded();
    expect(within(panel).queryByLabelText('Standard-Zahlungsfrist (Tage)')).not.toBeInTheDocument();
    const field = await termsField(panel);
    expect(field).toHaveValue('30');
    expect(within(panel).getByRole('button', { name: 'Mehr zu Standard-Zahlungsfrist (Tage)' })).toHaveAccessibleDescription(
      'Gilt für Kunden und Lieferanten ohne eigene Zahlungsfrist: ihre Rechnungen sind so viele Tage nach dem Rechnungsdatum fällig. 0 heisst sofort. Leer lassen: fällig am Rechnungsdatum.',
    );
  });

  it('a changed value is its own part: one update_company_profile carrying only the terms', async () => {
    const writes = spiedWrites();
    renderSurface({ get_company_profile: profileWith(null), ...writes });
    const panel = await loaded();
    const field = await termsField(panel);
    expect(field).toHaveValue('');
    await userEvent.type(field, '30');
    await save();
    expect(await within(header()).findByText('Gespeichert')).toBeInTheDocument();
    expect(writes.update_company_profile).toHaveBeenCalledOnce();
    expect(writes.update_company_profile.mock.calls[0]?.[0]).toEqual({ workspaceId: 'ws_test', defaultPaymentTermsDays: 30 });
    // Clean afterwards: a second Speichern writes nothing.
    await save();
    await waitFor(() => expect(writes.update_company_profile).toHaveBeenCalledOnce());
  });

  it('blank clears the stored default with null; a clean field writes nothing', async () => {
    const writes = spiedWrites();
    renderSurface({ get_company_profile: profileWith(30), ...writes });
    const panel = await loaded();
    await save();
    expect(await within(header()).findByText('Gespeichert')).toBeInTheDocument();
    expect(writes.update_company_profile).not.toHaveBeenCalled();
    await userEvent.clear(await termsField(panel));
    await save();
    await waitFor(() => expect(writes.update_company_profile).toHaveBeenCalledOnce());
    expect(writes.update_company_profile.mock.calls[0]?.[0]).toEqual({ workspaceId: 'ws_test', defaultPaymentTermsDays: null });
  });

  it('not a whole number of days: refused at the field, never sent, named as the part that failed', async () => {
    const writes = spiedWrites();
    renderSurface({ get_company_profile: profileWith(30), ...writes });
    const panel = await loaded();
    const field = await termsField(panel);
    await userEvent.clear(field);
    await userEvent.type(field, 'dreissig');
    await save();
    expect(await within(header()).findByText('Nicht gespeichert: Standard-Zahlungsfrist')).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(within(panel).getByRole('alert')).toHaveTextContent('Die Standard-Zahlungsfrist ist eine ganze Zahl von Tagen, von 0 bis 365.');
    expect(writes.update_company_profile).not.toHaveBeenCalled();
  });

  it('an engine refusal (out of range) lands on the field, keeps it dirty, and holds back nothing else', async () => {
    const writes = spiedWrites();
    writes.update_company_profile.mockImplementation((input: Record<string, unknown>) =>
      ('defaultPaymentTermsDays' in input
        ? { status: 422, body: { ok: false, error: 'invalid_payment_terms_days', field: 'defaultPaymentTermsDays', min: 0, max: 365 } }
        : { status: 200, body: { ok: true } }) as RestResponse,
    );
    renderSurface({ get_company_profile: profileWith(30), ...writes });
    const panel = await loaded();
    const name = within(panel).getByLabelText('Firmenname');
    await userEvent.clear(name);
    await userEvent.type(name, 'Muster Grafik Studio');
    const field = await termsField(panel);
    await userEvent.clear(field);
    await userEvent.type(field, '400');
    await save();
    expect(await within(header()).findByText('Nicht gespeichert: Standard-Zahlungsfrist')).toBeInTheDocument();
    expect(within(panel).getByRole('alert')).toHaveTextContent('von 0 bis 365');
    // The name landed in its own call; the refused terms never said "Gespeichert".
    const calls = writes.update_company_profile.mock.calls.map((c) => c[0]);
    expect(calls).toContainEqual(expect.objectContaining({ name: 'Muster Grafik Studio' }));
    expect(calls.find((c) => 'name' in c)).not.toHaveProperty('defaultPaymentTermsDays');
    // Still dirty: the next Speichern sends the terms again, and the name, now clean, is not re-sent.
    writes.update_company_profile.mockImplementation(() => ({ status: 200, body: { ok: true } }) as RestResponse);
    await userEvent.clear(field);
    await userEvent.type(field, '60');
    await save();
    expect(await within(header()).findByText('Gespeichert')).toBeInTheDocument();
    const last = writes.update_company_profile.mock.calls.at(-1)?.[0];
    expect(last).toEqual({ workspaceId: 'ws_test', defaultPaymentTermsDays: 60 });
  });
});
