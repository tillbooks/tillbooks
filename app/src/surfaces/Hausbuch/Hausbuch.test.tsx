/**
 * N00, das Hausbuch: the five states, the read-only face without `manage_settings`, a note written through
 * the dialog, an archive with Rückgängig, and the brief preview. Synthetic data only.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { CapabilitiesContext, ALLOW_ALL, type Capabilities } from '../../lib/capabilities';
import { recordedOk } from '../../lib/test-support';
import { WorkspaceProvider } from '../../app/workspace';
import { HausbuchPage, groupNotes, briefFigures, type HausbuchNote } from './Hausbuch';

const note = (id: string, kind: HausbuchNote['scope']['kind'], text: string, label: string | null = null): HausbuchNote => ({
  id,
  scope: { kind, ref: kind === 'workspace' ? null : `${kind}-ref`, label },
  text,
  status: 'active',
  createdAt: '2026-11-02T08:00:00.000Z',
  createdBy: 'studio',
  updatedAt: '2026-11-02T08:00:00.000Z',
  updatedBy: 'agent',
});

const NOTES = [
  note('hbn_1', 'workspace', 'Spesen immer mit Beleg buchen.'),
  note('hbn_2', 'counterparty', 'Lastschrift monatlich, Konto 6500.', 'Papeterie Lindengrund AG'),
  note('hbn_3', 'topic', 'Bezugsteuer wird nicht deklariert.', 'MWST'),
];

type Route = RestResponse | ((input: Record<string, unknown>) => RestResponse);

function renderPage(routes: Record<string, Route>, caps: Capabilities = ALLOW_ALL) {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const transport: Transport = async (action, input) => {
    calls.push({ action, input });
    const route = routes[action];
    if (route === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof route === 'function' ? route(input) : route;
  };
  render(
    <MemoryRouter>
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <CapabilitiesContext.Provider value={caps}>
              <HausbuchPage workspaceId="ws_test" />
            </CapabilitiesContext.Provider>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>
    </MemoryRouter>,
  );
  return calls;
}

const listed = (notes: HausbuchNote[], withheld = 0): RestResponse => ({ status: 200, body: recordedOk({ ok: true, notes, withheld }) });

describe('Hausbuch (N00)', () => {
  it('groups the active notes by what they are about, with a count, the scope and who changed them', async () => {
    renderPage({ hausbuch_notes: listed(NOTES), list_members: listed([]) });
    expect(await screen.findByRole('rowheader', { name: 'Spesen immer mit Beleg buchen.' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: /Ganzer Arbeitsbereich/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: /Zahlungspartner/ })).toBeInTheDocument();
    const row = screen.getByRole('row', { name: /Lastschrift monatlich/ });
    expect(within(row).getByText('Papeterie Lindengrund AG')).toBeInTheDocument();
    expect(within(row).getByText('Agent, 02.11.2026')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notiz hinzufügen' })).toBeInTheDocument();
    expect(groupNotes(NOTES).map((g) => g.kind)).toEqual(['workspace', 'counterparty', 'topic']);
  });

  it('empty: says so and offers the first note', async () => {
    renderPage({ hausbuch_notes: listed([]) });
    expect(await screen.findByText('Noch keine Hausregeln.')).toBeInTheDocument();
    expect(screen.getByText('Agenten schlagen welche vor, oder du schreibst die erste.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notiz hinzufügen' })).toBeInTheDocument();
  });

  it('error: the read refusal with Erneut versuchen, which reads again', async () => {
    let n = 0;
    const calls = renderPage({
      hausbuch_notes: () => {
        n += 1;
        return n === 1 ? { status: 503, body: { ok: false, error: 'store_busy' } } : listed(NOTES);
      },
    });
    const retry = await screen.findByRole('button', { name: /Erneut versuchen/ });
    await userEvent.click(retry);
    expect(await screen.findByRole('rowheader', { name: 'Spesen immer mit Beleg buchen.' })).toBeInTheDocument();
    expect(calls.filter((c) => c.action === 'hausbuch_notes')).toHaveLength(2);
  });

  it('permission-denied: without read_master_data a padlock and no read', async () => {
    const calls = renderPage({ hausbuch_notes: listed(NOTES) }, { ...ALLOW_ALL, can: (c) => c !== 'read_master_data' });
    expect(await screen.findByText('Für das Hausbuch brauchst du das Recht, Stammdaten zu lesen.')).toBeInTheDocument();
    expect(calls.some((c) => c.action === 'hausbuch_notes')).toBe(false);
  });

  it('read-only without manage_settings: no add, no edit, one line naming the right; withheld notes are counted', async () => {
    renderPage({ hausbuch_notes: listed(NOTES, 2) }, { ...ALLOW_ALL, can: (c) => c !== 'manage_settings' });
    await screen.findByRole('rowheader', { name: 'Spesen immer mit Beleg buchen.' });
    expect(screen.queryByRole('button', { name: 'Notiz hinzufügen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Bearbeiten' })).toBeNull();
    expect(screen.getByText(/Ändern braucht das Recht, Einstellungen zu verwalten/)).toBeInTheDocument();
    expect(screen.getByText(/2 Hausregeln zu Zahlungspartnern siehst du nicht/)).toBeInTheDocument();
  });

  it('adds a note through the dialog: text, scope and its reference, one key, then reads the list again', async () => {
    let written: Record<string, unknown> | null = null;
    const calls = renderPage({
      hausbuch_notes: listed([]),
      hausbuch_note_set: (input) => {
        written = input;
        return { status: 200, body: recordedOk({ ok: true, note: note('hbn_9', 'topic', 'Spesen pauschal.', 'Spesen'), changed: true, changeId: 'hbc_1' }) };
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Notiz hinzufügen' }));
    const dialog = screen.getByRole('dialog');
    const save = within(dialog).getByRole('button', { name: 'Speichern' });
    expect(save).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Hausregel'), 'Spesen pauschal.');
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Gilt für' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Thema' }));
    expect(save).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Thema'), 'Spesen');
    await userEvent.click(save);
    await waitFor(() => expect(written).not.toBeNull());
    expect(written).toMatchObject({ workspaceId: 'ws_test', text: 'Spesen pauschal.', scope: { kind: 'topic', ref: 'Spesen' } });
    expect(typeof (written as unknown as { idempotencyKey: unknown }).idempotencyKey).toBe('string');
    await waitFor(() => expect(calls.filter((c) => c.action === 'hausbuch_notes')).toHaveLength(2));
  });

  it('a refused write says why in words and keeps the dialog open', async () => {
    renderPage({
      hausbuch_notes: listed([]),
      hausbuch_note_set: { status: 200, body: { ok: false, error: 'scope_not_found', scope: { kind: 'account', ref: '9999' } } },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Notiz hinzufügen' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Hausregel'), 'Porto auf 6510.');
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Gilt für' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Konto' }));
    await userEvent.type(within(dialog).getByLabelText('Konto'), '9999');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Dieses Konto gibt es nicht.');
  });

  it('archives under Mehr, says so with Rückgängig, and Rückgängig sets the note again on its id', async () => {
    let archivedOnce = false;
    const calls = renderPage({
      hausbuch_notes: () => listed(archivedOnce ? NOTES.slice(1) : NOTES),
      hausbuch_note_archive: () => {
        archivedOnce = true;
        return { status: 200, body: recordedOk({ ok: true, note: { ...NOTES[0], status: 'archived' }, changed: true, changeId: 'hbc_2' }) };
      },
      hausbuch_note_set: () => {
        archivedOnce = false;
        return { status: 200, body: recordedOk({ ok: true, note: NOTES[0], changed: true, changeId: 'hbc_3' }) };
      },
    });
    const row = await screen.findByRole('row', { name: /Spesen immer mit Beleg buchen/ });
    await userEvent.click(within(row).getByRole('button', { name: /Mehr/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Archivieren' }));
    expect(await screen.findByText(/Archiviert: «Spesen immer mit Beleg buchen.»/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Rückgängig' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'hausbuch_note_set')).toBe(true));
    const restore = calls.find((c) => c.action === 'hausbuch_note_set');
    expect(restore?.input).toMatchObject({ id: 'hbn_1', text: 'Spesen immer mit Beleg buchen.', scope: { kind: 'workspace' } });
  });

  it('Was Agenten sehen reads the brief only when opened and shows one figure per section', async () => {
    const calls = renderPage({
      hausbuch_notes: listed(NOTES),
      workspace_brief: {
        status: 200,
        body: recordedOk({
          ok: true,
          sections: ['accounts', 'notes', 'counts'],
          accounts: { columns: [], rows: [[], [], []] },
          notes: { items: [{}, {}] },
          counts: { total: 4, incomplete: false, queues: {} },
          omitted: [{ section: 'vatCodes', error: 'permission_denied', capability: 'read_vat' }],
        }),
      },
    });
    await screen.findByRole('rowheader', { name: 'Spesen immer mit Beleg buchen.' });
    expect(calls.some((c) => c.action === 'workspace_brief')).toBe(false);
    await userEvent.click(screen.getByText('Was Agenten sehen'));
    const figure = await screen.findByText('Konten');
    expect(figure.closest('[data-section]')).toHaveTextContent('3');
    expect(screen.getByText('Ohne Leserecht nicht im Briefing: MWST-Codes.')).toBeInTheDocument();
    expect(briefFigures({ sections: ['rules'], rules: [1, 2], omitted: [] })).toEqual([{ section: 'rules', count: 2 }]);
  });
});
