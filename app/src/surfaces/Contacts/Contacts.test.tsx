import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { neverSettles, watchReads } from '../../test-transport';
import Contacts from './index';

/**
 * A canned-response transport: each action maps to a fixed RestResponse or a function of its input.
 * Anything unmapped answers 404, mirroring the real bridge for an unknown action.
 */
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

const ok = (data: Record<string, unknown> = {}): RestResponse => ({
  status: 200,
  body: { ok: true, ...data },
});

const reject = (error: string, status = 422): RestResponse => ({
  status,
  body: { ok: false, error },
});

const SAMPLE_CONTACTS = [
  {
    id: 'k1',
    partyRole: 'customer',
    name: 'Muster AG',
    address: { street: 'Bahnhofstrasse', houseNo: '1', zip: '8001', city: 'Zürich', country: 'CH' },
    vatNumber: 'CHE-123.456.789 MWST',
    email: 'kontakt@muster.ch',
    defaultCurrency: 'CHF',
    paymentTermsDays: 30,
  },
  {
    id: 'k2',
    partyRole: 'vendor',
    name: 'Lieferant GmbH',
    address: { street: 'Industrieweg', houseNo: '4', zip: '3000', city: 'Bern', country: 'CH' },
    defaultCurrency: 'CHF',
  },
  {
    id: 'k3',
    partyRole: 'customer',
    name: 'Namensfirma',
    address: null,
    defaultCurrency: 'CHF',
  },
];

function renderContacts(canned: Canned, workspaceId: string | null = 'ws_test') {
  const client = new TillClient(fakeTransport(canned));
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <MemoryRouter>
            <Contacts />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

const happyCanned = (): Canned => ({
  list_contacts: ok({ contacts: SAMPLE_CONTACTS }),
});

/**
 * Real content on screen AND nothing still announcing itself busy.
 *
 * AXE MUST RUN ON A SETTLED SURFACE. Auditing the first frame audits the skeleton, and a skeleton
 * has no drawer, no form controls and no roles to get wrong: it passes whatever the finished render
 * would have failed. The browser harness's `waitForPaintToSettle`
 * (`.claude/ui-tests/lib/audit-tools.cjs`) drives `document.getAnimations()` through Playwright and
 * cannot run in jsdom, so this is the jsdom-shaped equivalent of the same claim.
 *
 * `findAllByText` rather than `findByText`, unlike the twin in `BankAccounts.test.tsx`: a drawer
 * anchor is a field label, and a label may legitimately repeat elsewhere on the surface. Requiring
 * uniqueness there would fail the probe rather than the code.
 */
async function settled(container: HTMLElement, anchor: string): Promise<void> {
  await screen.findAllByText(anchor);
  await waitFor(() => {
    expect(container.querySelectorAll('[aria-busy="true"]')).toHaveLength(0);
  });
}

describe('Contacts, five states', () => {
  it('shows a loading skeleton while the list resolves', async () => {
    const transport = watchReads(neverSettles);
    const client = new TillClient(transport);
    render(
      <TillClientProvider client={client}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Contacts />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    // The skeleton is the surface's first commit, so it proves nothing on its own: wait for the read
    // to be genuinely in flight before calling this a loading state.
    await transport.started('list_contacts');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('renders a no-workspace empty state without calling any ctx verb', async () => {
    const listSpy = vi.fn<CannedHandler>(() => ok({ contacts: [] }));
    renderContacts({ list_contacts: listSpy }, null);
    expect(await screen.findByText('Kein Arbeitsbereich vorhanden')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Arbeitsbereich einrichten' })).toHaveAttribute(
      'href',
      '/setup',
    );
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('renders an empty state when there are no contacts', async () => {
    renderContacts({ list_contacts: ok({ contacts: [] }) });
    expect(await screen.findByText('Noch keine Kontakte')).toBeInTheDocument();
  });

  it('renders a no-match empty state when a search matches nothing', async () => {
    renderContacts(happyCanned());
    await screen.findByText('Muster AG');
    await userEvent.type(screen.getByPlaceholderText('Kontakte suchen'), 'zzznomatch');
    expect(await screen.findByText('Kein Kontakt passt zur Suche')).toBeInTheDocument();
  });

  it('renders an error banner when list_contacts rejects', async () => {
    renderContacts({ list_contacts: reject('invalid_input') });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('renders a permission-denied state on permission_denied', async () => {
    renderContacts({ list_contacts: reject('permission_denied', 403) });
    expect(await screen.findByRole('heading', { name: 'Kein Zugriff' })).toBeInTheDocument();
  });

  it('renders the contact list on success with role and QR-readiness signals', async () => {
    renderContacts(happyCanned());
    expect(await screen.findByText('Muster AG')).toBeInTheDocument();
    expect(screen.getByText('Lieferant GmbH')).toBeInTheDocument();
    // A complete structured address lights the QR-ready sign; a name-only contact shows needs-address.
    expect(screen.getAllByText('QR-bereit').length).toBeGreaterThan(0);
    expect(screen.getByText('Adresse nötig')).toBeInTheDocument();
  });

  it('has no axe violations on the success render', async () => {
    const { container } = renderContacts(happyCanned());
    await screen.findByText('Muster AG');
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

describe('Contacts, archive', () => {
  it('archives a contact via archive_contact', async () => {
    const archiveSpy = vi.fn<CannedHandler>(() => ok());
    renderContacts({ ...happyCanned(), archive_contact: archiveSpy });
    // The list is the shared DataTable now, so a row is a `<tr>` rather than the old `<li>`.
    const row = (await screen.findByText('Muster AG')).closest('tr') as HTMLElement;
    // D15/C2: Archive now lives one level down, behind the per-row overflow menu.
    await userEvent.click(
      within(row).getByRole('button', { name: 'Weitere Aktionen für Kontakt Muster AG' }),
    );
    await userEvent.click(within(row).getByRole('menuitem', { name: 'Archivieren' }));
    await waitFor(() => expect(archiveSpy).toHaveBeenCalledOnce());
    expect(archiveSpy.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws_test', contactId: 'k1' });
  });
});

describe('ContactEditor', () => {
  it('creates a contact and calls create_contact with structured fields', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ contactId: 'new1' }));
    renderContacts({ ...happyCanned(), create_contact: createSpy });
    await screen.findByText('Muster AG');

    await userEvent.click(screen.getByRole('button', { name: 'Neuer Kontakt' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('Rolle'), 'customer');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Neue AG');
    await userEvent.type(within(dialog).getByLabelText('Strasse'), 'Seestrasse');
    await userEvent.type(within(dialog).getByLabelText('Haus-Nr.'), '7');
    await userEvent.type(within(dialog).getByLabelText('PLZ'), '8002');
    await userEvent.type(within(dialog).getByLabelText('Ort'), 'Zürich');
    await userEvent.type(within(dialog).getByLabelText('Land'), 'CH');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    expect(createSpy.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws_test',
      partyRole: 'customer',
      name: 'Neue AG',
      address: { street: 'Seestrasse', houseNo: '7', zip: '8002', city: 'Zürich', country: 'CH' },
    });
  });

  it('surfaces invalid_vat_number inline on the VAT field', async () => {
    renderContacts({ ...happyCanned(), create_contact: reject('invalid_vat_number') });
    await screen.findByText('Muster AG');

    await userEvent.click(screen.getByRole('button', { name: 'Neuer Kontakt' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Falsch AG');
    await userEvent.type(within(dialog).getByLabelText('MWST-Nummer'), 'CHE-000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    expect(
      await within(dialog).findByText('Ungültige MWST-Nummer. Erwartet: CHE-123.456.789 MWST.'),
    ).toBeInTheDocument();
  });

  it('edits a contact and calls update_contact with a patch', async () => {
    const updateSpy = vi.fn<CannedHandler>(() => ok());
    renderContacts({ ...happyCanned(), update_contact: updateSpy });
    const row = (await screen.findByText('Muster AG')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Bearbeiten' }));

    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Muster Holding AG');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledOnce());
    expect(updateSpy.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws_test',
      contactId: 'k1',
      patch: { name: 'Muster Holding AG' },
    });
  });

  /**
   * THE SURFACE'S ONLY OTHER axe BLOCK RUNS WITH THIS DRAWER CLOSED, so the drawer element has
   * never once entered the accessibility tree an audit reads. That is why the defect below survived
   * a green suite: not because the audit was wrong, because it was never pointed at the markup.
   */
  it('has no axe violations on a SETTLED open drawer', async () => {
    const { container } = renderContacts(happyCanned());
    await settled(container, 'Muster AG');

    await userEvent.click(screen.getByRole('button', { name: 'Neuer Kontakt' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await settled(container, 'Strasse');

    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});
