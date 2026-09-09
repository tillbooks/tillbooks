/**
 * C00's CRM extension of the Kontakte surface: the kind axis, the segment chips, the OP5 timeline,
 * the merge modal, the import review and the revDSG anonymise confirm.
 *
 * The A09 half is covered by `Contacts.test.tsx` and is deliberately not re-tested here. What this
 * file holds is the properties C00 added, and in particular the three that are easy to ship broken:
 * a disabled primary action must state its reason inline (D15), a kind must never be signalled by
 * glyph or colour alone, and axe must run on a SETTLED surface with the drawer and the modal OPEN,
 * because a closed overlay never enters the accessibility tree an audit reads.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import Contacts from './index';
import { parseCsv } from './ImportModal';

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

/** A company, a person employed by it, and a duplicate of the company to merge away. */
const CRM_CONTACTS = [
  {
    id: 'k1',
    partyRole: 'customer',
    kind: 'company',
    name: 'Muster AG',
    address: { street: 'Bahnhofstrasse', houseNo: '1', zip: '8001', city: 'Zürich', country: 'CH' },
    vatNumber: 'CHE-123.456.789 MWST',
    email: 'kontakt@muster.ch',
    segments: ['newsletter'],
    roles: [],
  },
  {
    id: 'k2',
    partyRole: 'customer',
    kind: 'person',
    name: 'Anna Muster',
    companyContactId: 'k1',
    address: null,
    segments: [],
    roles: [],
  },
  {
    id: 'k3',
    partyRole: 'customer',
    kind: 'company',
    name: 'Muster Aktiengesellschaft',
    address: null,
    segments: [],
    roles: [],
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

const happy = (): Canned => ({
  list_contacts: ok({ contacts: CRM_CONTACTS }),
  contacts_timeline: ok({ activities: [] }),
  // E03: the Verlauf tab now leads with the per-contact task list, which reads on tab open. An empty
  // list keeps these C00 tests focused on C00 while the section renders its (empty) five-state shell.
  tasks_list: ok({ tasks: [] }),
});

/**
 * Real content on screen AND nothing still announcing itself busy. Auditing the first frame audits
 * the skeleton, which has no drawer, no tabs and no form controls to get wrong: it passes whatever
 * the finished render would have failed.
 */
async function settled(container: HTMLElement, anchor: string): Promise<void> {
  await screen.findAllByText(anchor);
  await waitFor(() => {
    expect(container.querySelectorAll('[aria-busy="true"]')).toHaveLength(0);
  });
}

/** Open the detail drawer for one contact by clicking its name. */
async function openDrawer(name: string): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole('button', { name }));
  return screen.findByRole('dialog');
}

describe('Contacts, the C00 kind axis', () => {
  it('labels every kind in words, not by glyph or colour alone', async () => {
    renderContacts(happy());
    await screen.findByRole('button', { name: 'Muster AG' });
    // The row glyph is decorative; the accessible name is the word. Two companies, one person.
    expect(screen.getAllByTitle('Firma')).toHaveLength(2);
    expect(screen.getAllByTitle('Person')).toHaveLength(1);
  });

  it('filters by kind through the engine rather than in the browser', async () => {
    const listSpy = vi.fn<CannedHandler>(() => ok({ contacts: CRM_CONTACTS }));
    renderContacts({ ...happy(), list_contacts: listSpy });
    await screen.findByRole('button', { name: 'Muster AG' });

    await userEvent.selectOptions(screen.getByLabelText('Art'), 'person');
    // A segment is a read model over the whole tenant, so the filter must reach the verb.
    await waitFor(() => {
      expect(listSpy.mock.calls.some((c) => c[0].kind === 'person')).toBe(true);
    });
  });
});

describe('Contacts, segment chips', () => {
  it('offers only the segments the loaded rows actually carry, and filters through the verb', async () => {
    const listSpy = vi.fn<CannedHandler>(() => ok({ contacts: CRM_CONTACTS }));
    renderContacts({ ...happy(), list_contacts: listSpy });
    const chip = await screen.findByRole('button', { name: 'newsletter', pressed: false });

    await userEvent.click(chip);
    await waitFor(() => {
      expect(listSpy.mock.calls.some((c) => c[0].segment === 'newsletter')).toBe(true);
    });
    // The pressed state carries the filter, so it is never signalled by colour alone.
    expect(await screen.findByRole('button', { name: 'newsletter', pressed: true })).toBeInTheDocument();
  });

  it('toggles E06 ledger-grounding consent through update_contact, C00\'s own write path', async () => {
    const updateSpy = vi.fn<CannedHandler>(() => ok());
    renderContacts({ ...happy(), update_contact: updateSpy });
    const drawer = await openDrawer('Muster AG');

    // Off by default (US-E06.2), the honest note in place, and ONE write path: a patch on
    // update_contact, never an E06 verb.
    const toggle = within(drawer).getByRole('checkbox', {
      name: 'Entwürfe dürfen die Buchhaltung dieses Kunden verwenden',
    });
    expect(toggle).not.toBeChecked();
    expect(
      within(drawer).getByText('Standardmässig aus. In beiden Fällen wird nichts irgendwohin gesendet.'),
    ).toBeInTheDocument();

    await userEvent.click(toggle);
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledTimes(1);
    });
    expect(updateSpy.mock.calls[0]?.[0]).toMatchObject({
      contactId: 'k1',
      patch: { ledgerGroundingEnabled: true },
    });
  });

  it('adds a segment through contacts_tag from the drawer', async () => {
    const tagSpy = vi.fn<CannedHandler>(() => ok());
    renderContacts({ ...happy(), contacts_tag: tagSpy });
    const drawer = await openDrawer('Muster AG');

    await userEvent.type(within(drawer).getByLabelText('Segment hinzufügen'), 'vip');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Hinzufügen' }));

    await waitFor(() => expect(tagSpy).toHaveBeenCalledOnce());
    expect(tagSpy.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws_test',
      contactId: 'k1',
      segments: ['vip'],
    });
    // §H-IDEMPOTENT reaches the wire: the surface never sends a keyless write.
    expect(tagSpy.mock.calls[0][0].idempotencyKey).toBeTruthy();
  });

  it('states inline why Hinzufügen is disabled rather than offering a dead control (D15)', async () => {
    renderContacts(happy());
    const drawer = await openDrawer('Muster AG');
    expect(within(drawer).getByRole('button', { name: 'Hinzufügen' })).toBeDisabled();
    expect(
      within(drawer).getByText('Gib zuerst ein Segment ein, dann kannst du es hinzufügen.'),
    ).toBeInTheDocument();
  });
});

describe('ContactDrawer, the Verlauf tab (OP5)', () => {
  it('shows an empty timeline with a way out, then logs an activity', async () => {
    const logSpy = vi.fn<CannedHandler>(() => ok());
    renderContacts({ ...happy(), contacts_log_activity: logSpy });
    const drawer = await openDrawer('Muster AG');

    await userEvent.click(within(drawer).getByRole('tab', { name: 'Verlauf' }));
    expect(await within(drawer).findByText('Noch keine Aktivität.')).toBeInTheDocument();

    await userEvent.selectOptions(within(drawer).getByLabelText('Art'), 'call');
    await userEvent.type(within(drawer).getByLabelText('Text'), 'Erstgespräch geführt.');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Erfassen' }));

    await waitFor(() => expect(logSpy).toHaveBeenCalledOnce());
    expect(logSpy.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws_test',
      contactId: 'k1',
      kind: 'call',
      body: 'Erstgespräch geführt.',
    });
  });

  it('renders the timeline newest-first with a kind label beside each glyph', async () => {
    renderContacts({
      ...happy(),
      contacts_timeline: ok({
        activities: [
          { id: 'a2', contactId: 'k1', kind: 'call', body: 'neuer', occurredAt: '2026-05-01' },
          { id: 'a1', contactId: 'k1', kind: 'note', body: 'älter', occurredAt: '2026-01-01' },
        ],
      }),
    });
    const drawer = await openDrawer('Muster AG');
    await userEvent.click(within(drawer).getByRole('tab', { name: 'Verlauf' }));

    const rows = await within(drawer).findAllByRole('listitem');
    // The engine sends newest-first and the surface must not re-sort it into a different story.
    expect(rows[0]).toHaveTextContent('neuer');
    expect(rows[1]).toHaveTextContent('älter');
    // Glyph AND label: the kind is legible without colour or icon recognition.
    expect(rows[0]).toHaveTextContent('Anruf');
    // P11: a de-CH day, not an ISO string.
    expect(rows[0]).toHaveTextContent('01.05.2026');
  });

  it('states inline why Erfassen is disabled on an empty body (D15)', async () => {
    renderContacts(happy());
    const drawer = await openDrawer('Muster AG');
    await userEvent.click(within(drawer).getByRole('tab', { name: 'Verlauf' }));

    expect(within(drawer).getByRole('button', { name: 'Erfassen' })).toBeDisabled();
    expect(
      await within(drawer).findByText('Schreib zuerst einen Text, dann kannst du die Aktivität erfassen.'),
    ).toBeInTheDocument();
  });

  it('surfaces a timeline read failure as a retryable error, not an empty timeline', async () => {
    renderContacts({ ...happy(), contacts_timeline: reject('permission_denied', 403) });
    const drawer = await openDrawer('Muster AG');
    await userEvent.click(within(drawer).getByRole('tab', { name: 'Verlauf' }));
    expect(await within(drawer).findByRole('alert')).toBeInTheDocument();
  });

  it('shows the employer link on a person and the Personen section on its company', async () => {
    renderContacts(happy());
    const companyDrawer = await openDrawer('Muster AG');
    // The company lists its people rather than flattening the org structure: the employee shows up
    // under the company, named.
    expect(within(companyDrawer).getByText('Personen')).toBeInTheDocument();
    expect(within(companyDrawer).getByText('Anna Muster')).toBeInTheDocument();
    await userEvent.click(within(companyDrawer).getByRole('button', { name: 'Schliessen' }));

    const personDrawer = await openDrawer('Anna Muster');
    expect(within(personDrawer).getByText('Arbeitgeber')).toBeInTheDocument();
    expect(within(personDrawer).getByText('Muster AG')).toBeInTheDocument();
  });

  it('moves between tabs with the arrow keys, so the tablist is really a tablist', async () => {
    renderContacts(happy());
    const drawer = await openDrawer('Muster AG');
    const master = within(drawer).getByRole('tab', { name: 'Stammdaten' });
    master.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(within(drawer).getByRole('tab', { name: 'Verlauf' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});

describe('Contacts, merge (US-C00.4)', () => {
  it('needs exactly two rows and says so inline while it does not have them (D15)', async () => {
    renderContacts(happy());
    await screen.findByRole('button', { name: 'Muster AG' });

    await userEvent.click(screen.getByRole('checkbox', { name: 'Muster AG für das Zusammenführen auswählen' }));
    expect(screen.getByRole('button', { name: 'Zusammenführen' })).toBeDisabled();
    expect(
      screen.getByText('Wähle genau zwei Kontakte aus, dann kannst du sie zusammenführen.'),
    ).toBeInTheDocument();
  });

  it('merges the source into the picked survivor', async () => {
    const mergeSpy = vi.fn<CannedHandler>(() => ok());
    renderContacts({ ...happy(), contacts_merge: mergeSpy });
    await screen.findByRole('button', { name: 'Muster AG' });

    await userEvent.click(screen.getByRole('checkbox', { name: 'Muster AG für das Zusammenführen auswählen' }));
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Muster Aktiengesellschaft für das Zusammenführen auswählen' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Zusammenführen' }));

    const modal = await screen.findByRole('dialog');
    // The first selected row is the default survivor; picking the other one flips the direction, so
    // the write must follow the RADIO and not the selection order.
    await userEvent.click(within(modal).getByRole('radio', { name: 'Muster Aktiengesellschaft' }));
    await userEvent.click(within(modal).getByRole('button', { name: 'Zusammenführen' }));

    await waitFor(() => expect(mergeSpy).toHaveBeenCalledOnce());
    expect(mergeSpy.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws_test',
      sourceId: 'k1',
      targetId: 'k3',
    });
  });

  it('surfaces a merge rejection in the modal instead of closing on a failure', async () => {
    renderContacts({ ...happy(), contacts_merge: reject('target_merged') });
    await screen.findByRole('button', { name: 'Muster AG' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Muster AG für das Zusammenführen auswählen' }));
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Muster Aktiengesellschaft für das Zusammenführen auswählen' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Zusammenführen' }));

    const modal = await screen.findByRole('dialog');
    await userEvent.click(within(modal).getByRole('button', { name: 'Zusammenführen' }));
    expect(await within(modal).findByRole('alert')).toBeInTheDocument();
    expect(within(modal).getByRole('button', { name: 'Zusammenführen' })).toBeInTheDocument();
  });
});

describe('Contacts, anonymise (US-C00.6)', () => {
  it('requires the typed confirm word before the erasure can be triggered', async () => {
    const anonSpy = vi.fn<CannedHandler>(() => ok());
    renderContacts({ ...happy(), contacts_anonymise: anonSpy });
    const drawer = await openDrawer('Muster AG');

    await userEvent.click(within(drawer).getByRole('button', { name: 'Anonymisieren' }));
    const confirm = within(drawer).getByRole('button', { name: 'Anonymisieren' });
    expect(confirm).toBeDisabled();
    // D15: it says what is missing rather than merely refusing to work.
    expect(within(drawer).getByText(/Tippe ANONYMISIEREN genau so/)).toBeInTheDocument();
    expect(anonSpy).not.toHaveBeenCalled();

    await userEvent.type(within(drawer).getByLabelText(/Tippe ANONYMISIEREN/), 'ANONYMISIEREN');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Anonymisieren' }));

    await waitFor(() => expect(anonSpy).toHaveBeenCalledOnce());
    expect(anonSpy.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws_test', contactId: 'k1' });
  });

  it('reports open_documents in place, rather than pretending the erasure happened', async () => {
    renderContacts({ ...happy(), contacts_anonymise: reject('open_documents') });
    const drawer = await openDrawer('Muster AG');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Anonymisieren' }));
    await userEvent.type(within(drawer).getByLabelText(/Tippe ANONYMISIEREN/), 'ANONYMISIEREN');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Anonymisieren' }));
    expect(await within(drawer).findByRole('alert')).toBeInTheDocument();
  });
});

describe('Contacts, import (US-C00.5)', () => {
  it('parses a CSV header into rows, quoted commas included', () => {
    const rows = parseCsv('name,email\n"Muster, AG",a@b.ch\nZweite GmbH,c@d.ch');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: 'Muster, AG', email: 'a@b.ch' });
    expect(rows[1]).toMatchObject({ name: 'Zweite GmbH' });
  });

  it('sends parsed rows and shows the duplicate review rather than a silent success', async () => {
    const importSpy = vi.fn<CannedHandler>(() =>
      ok({ created: 1, skipped: 1, duplicates: [{ row: 1, candidateIds: ['k1'] }] }),
    );
    renderContacts({ ...happy(), contacts_import: importSpy });
    await screen.findByRole('button', { name: 'Muster AG' });

    await userEvent.click(screen.getByRole('button', { name: 'Importieren' }));
    const modal = await screen.findByRole('dialog');
    await userEvent.type(
      within(modal).getByLabelText('CSV-Inhalt einfügen'),
      'name,email\nNeu GmbH,neu@example.ch\nMuster AG,kontakt@muster.ch',
    );
    await userEvent.click(within(modal).getByRole('button', { name: 'Importieren' }));

    await waitFor(() => expect(importSpy).toHaveBeenCalledOnce());
    expect(importSpy.mock.calls[0][0].rows).toHaveLength(2);
    // The review names what was held back: a matched row is never auto-merged.
    expect(await within(modal).findByText('1 mögliche Duplikate gefunden')).toBeInTheDocument();
    expect(within(modal).getByText('1 Kontakte angelegt.')).toBeInTheDocument();
  });

  it('states inline why Importieren is disabled on an empty paste (D15)', async () => {
    renderContacts(happy());
    await screen.findByRole('button', { name: 'Muster AG' });
    await userEvent.click(screen.getByRole('button', { name: 'Importieren' }));
    const modal = await screen.findByRole('dialog');

    expect(within(modal).getByRole('button', { name: 'Importieren' })).toBeDisabled();
    expect(within(modal).getByText('Füge zuerst CSV-Inhalt mit einer Kopfzeile ein.')).toBeInTheDocument();
  });
});

describe('Contacts, the employer picker (US-C00.1)', () => {
  it('offers companies only, so the form cannot create the rejection it would then show', async () => {
    renderContacts(happy());
    await screen.findByRole('button', { name: 'Muster AG' });
    await userEvent.click(screen.getByRole('button', { name: 'Neuer Kontakt' }));
    const dialog = await screen.findByRole('dialog');

    await userEvent.selectOptions(within(dialog).getByLabelText('Art'), 'person');
    const employer = within(dialog).getByLabelText('Arbeitgeber');
    const options = within(employer as HTMLSelectElement).getAllByRole('option');
    const labels = options.map((o) => o.textContent);
    expect(labels).toContain('Muster AG');
    expect(labels).toContain('Muster Aktiengesellschaft');
    // The person in the fixture must NOT be offered as an employer.
    expect(labels).not.toContain('Anna Muster');
  });

  it('sends the kind and the employer link on create', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ contact: { id: 'new1' } }));
    renderContacts({ ...happy(), create_contact: createSpy });
    await screen.findByRole('button', { name: 'Muster AG' });
    await userEvent.click(screen.getByRole('button', { name: 'Neuer Kontakt' }));
    const dialog = await screen.findByRole('dialog');

    await userEvent.selectOptions(within(dialog).getByLabelText('Art'), 'person');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Bea Muster');
    await userEvent.selectOptions(within(dialog).getByLabelText('Arbeitgeber'), 'k1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    expect(createSpy.mock.calls[0][0]).toMatchObject({
      kind: 'person',
      name: 'Bea Muster',
      companyContactId: 'k1',
    });
  });

  it('surfaces employer_must_be_company inline on the employer field', async () => {
    renderContacts({ ...happy(), create_contact: reject('employer_must_be_company') });
    await screen.findByRole('button', { name: 'Muster AG' });
    await userEvent.click(screen.getByRole('button', { name: 'Neuer Kontakt' }));
    const dialog = await screen.findByRole('dialog');

    await userEvent.selectOptions(within(dialog).getByLabelText('Art'), 'person');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Chris');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    expect(
      await within(dialog).findByText('Der Arbeitgeber muss eine Firma sein.'),
    ).toBeInTheDocument();
  });
});

describe('Contacts, C00 accessibility', () => {
  it('has no axe violations with the detail drawer OPEN and settled', async () => {
    const { container } = renderContacts(happy());
    await settled(container, 'Muster AG');
    await openDrawer('Muster AG');
    await settled(container, 'Segmente');

    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });

  it('has no axe violations on the Verlauf tab with a rendered timeline', async () => {
    const { container } = renderContacts({
      ...happy(),
      contacts_timeline: ok({
        activities: [{ id: 'a1', contactId: 'k1', kind: 'meeting', body: 'Termin', occurredAt: '2026-04-02' }],
      }),
    });
    await settled(container, 'Muster AG');
    const drawer = await openDrawer('Muster AG');
    await userEvent.click(within(drawer).getByRole('tab', { name: 'Verlauf' }));
    await settled(container, 'Termin');

    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });

  it('has no axe violations with the merge modal OPEN and settled', async () => {
    const { container } = renderContacts(happy());
    await settled(container, 'Muster AG');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Muster AG für das Zusammenführen auswählen' }));
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Muster Aktiengesellschaft für das Zusammenführen auswählen' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Zusammenführen' }));
    await screen.findByRole('dialog');
    await settled(container, 'Welcher Kontakt bleibt?');

    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});
