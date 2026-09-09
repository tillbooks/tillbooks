/**
 * G04 §8 component tests for the Data & Backup panel. The assertions a green screenshot cannot make:
 * the empty state names the CTA rather than a bare "no data"; a backup row renders its kind, status
 * and actor; delete calls the verb and refreshes; a restore is CONFIRMED before it fires (the P8
 * human gate) and passes confirmed:true; and permission-denied replaces the actions with the padlock.
 *
 * Default locale is de-CH (spec §6), so the copy asserted is the German half at layout length.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { DataBackup } from './DataBackup';

type Route = RestResponse | ((input: Record<string, unknown>) => RestResponse);

function makeClient(routes: Record<string, Route>) {
  const calls: [string, unknown][] = [];
  const inner: Transport = async (action, input) => {
    calls.push([action, input]);
    const route = routes[action];
    if (route === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof route === 'function' ? route(input) : route;
  };
  return { client: new TillClient(inner), calls };
}

function renderPanel(client: TillClient) {
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <DataBackup />
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

const OK = (body: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, ...body } });

describe('DataBackup', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('shows the empty state with the back-up CTA when there are no backups', async () => {
    const { client } = makeClient({ list_backups: OK({ backups: [] }) });
    renderPanel(client);
    expect(await screen.findByText(/Noch keine Sicherungen/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Jetzt sichern' })).toBeInTheDocument();
  });

  it('renders a backup row with kind, status and actor', async () => {
    const { client } = makeClient({
      list_backups: OK({
        backups: [{ backupId: 'bkr-1', kind: 'backup', artifactRef: '/x', byteSize: 2048, status: 'complete', createdBy: 'agent', createdAt: '2026-08-06T10:00:00.000Z' }],
      }),
    });
    renderPanel(client);
    expect(await screen.findByText('Sicherung')).toBeInTheDocument();
    expect(screen.getByText('Abgeschlossen')).toBeInTheDocument();
    expect(screen.getByText('agent')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
  });

  it('M03 (V4, S2.2): each history row carries the restore-path disclosure naming its generation', async () => {
    const { client } = makeClient({
      list_backups: OK({
        backups: [{ backupId: 'bkr-1', kind: 'backup', artifactRef: '/x', byteSize: 2048, status: 'complete', createdBy: 'agent', createdAt: '2026-08-06T10:00:00.000Z', schemaVersion: 6 }],
      }),
    });
    renderPanel(client);
    await screen.findByText('Sicherung');
    // The row face carries the disclosure trigger; the sentence with the generation sits behind it.
    const hint = screen.getByRole('button', { name: 'Wiederherstellungspfad anzeigen' });
    await userEvent.click(hint);
    expect(
      await screen.findByText(
        'Wiederherstellbar auf jeder TILL-Installation über den Wiederherstellen-Dialog beim ersten Start. Schema-Generation 6.',
      ),
    ).toBeInTheDocument();
  });

  it('backs up and refreshes the list', async () => {
    let listed = 0;
    const { client, calls } = makeClient({
      list_backups: () => {
        listed += 1;
        return OK({ backups: [] });
      },
      create_backup: OK({ backupId: 'bkr-1', status: 'complete' }),
    });
    renderPanel(client);
    await screen.findByText(/Noch keine Sicherungen/);
    await userEvent.click(screen.getByRole('button', { name: 'Jetzt sichern' }));
    await waitFor(() => expect(calls.some(([a]) => a === 'create_backup')).toBe(true));
    await waitFor(() => expect(listed).toBeGreaterThan(1));
  });

  it('CONFIRMS before restoring and passes confirmed:true (the P8 human gate)', async () => {
    const { client, calls } = makeClient({
      list_backups: OK({ backups: [] }),
      restore_backup: OK({ workspaceId: 'ws_new', entryCount: 3 }),
    });
    renderPanel(client);
    await screen.findByText(/Noch keine Sicherungen/);
    await userEvent.type(screen.getByPlaceholderText(/backups/), '/some/backup.tillbackup');
    // Opening the restore action only stages the human gate: the engine is not called yet.
    await userEvent.click(screen.getByRole('button', { name: 'In neuen Arbeitsbereich wiederherstellen' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(calls.some(([a]) => a === 'restore_backup')).toBe(false);
    // Confirming inside the dialog fires the restore with confirmed:true.
    await userEvent.click(within(dialog).getByRole('button', { name: 'In neuen Arbeitsbereich wiederherstellen' }));
    await waitFor(() => {
      const restore = calls.find(([a]) => a === 'restore_backup');
      expect(restore).toBeDefined();
      expect((restore![1] as { confirmed: boolean }).confirmed).toBe(true);
    });
  });

  it('does NOT restore when the confirmation is declined', async () => {
    const { client, calls } = makeClient({ list_backups: OK({ backups: [] }), restore_backup: OK({ workspaceId: 'x' }) });
    renderPanel(client);
    await screen.findByText(/Noch keine Sicherungen/);
    await userEvent.type(screen.getByPlaceholderText(/backups/), '/some/backup.tillbackup');
    await userEvent.click(screen.getByRole('button', { name: 'In neuen Arbeitsbereich wiederherstellen' }));
    const dialog = await screen.findByRole('alertdialog');
    // Cancelling dismisses the gate and never calls the engine.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(calls.some(([a]) => a === 'restore_backup')).toBe(false);
  });

  it('shows the padlock when the caller lacks manage_data_export', async () => {
    const { client } = makeClient({ list_backups: { status: 422, body: { ok: false, error: 'permission_denied' } } });
    renderPanel(client);
    expect(await screen.findByText(/Dafür brauchst du das Recht/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Jetzt sichern' })).not.toBeInTheDocument();
  });
});

/**
 * F-06 (J7.1, J7.5, J8.10): the history row verifies itself with one click and names the schema
 * generation; a .tillexport verified in either place gets the honesty sentence, never "Gültig"; and
 * the padlock names the right in words.
 */
describe('DataBackup, the row verify and the honesty sentence (F-06)', () => {
  const ROW = { backupId: 'bkr-1', kind: 'backup', artifactRef: '/support/backups/bkr-1.tillbackup', byteSize: 2048, status: 'complete', createdBy: 'studio', createdAt: '2026-09-05T10:00:00.000Z', schemaVersion: 6 };
  const EXPORT_ROW = { ...ROW, backupId: 'exp-1', kind: 'export', artifactRef: '/support/backups/exp-1.tillexport' };

  it('J7.1: "Prüfen" on the row verifies its own artefact, no path typed, and names the generation', async () => {
    const { client, calls } = makeClient({
      list_backups: OK({ backups: [ROW] }),
      verify_backup: OK({ schemaVersion: 6, tillVersion: '0.1.0', entryCount: 193, balanceOk: true, format: 'sqlite_snapshot' }),
    });
    renderPanel(client);
    await screen.findByText('Sicherung');
    await userEvent.click(screen.getByRole('button', { name: 'Sicherung vom 05.09.2026 prüfen' }));
    expect(await screen.findByText('Gültig: 193 Buchungen, ausgeglichen. Schema-Generation 6.')).toBeInTheDocument();
    const verify = calls.find(([a]) => a === 'verify_backup');
    expect((verify![1] as { source: string }).source).toBe('/support/backups/bkr-1.tillbackup');
    // The restore field stayed empty: the act cost zero keystrokes.
    expect(screen.getByPlaceholderText(/backups/)).toHaveValue('');
  });

  it('J7.5: verifying an export on its row says it is not a restore source', async () => {
    const { client } = makeClient({
      list_backups: OK({ backups: [EXPORT_ROW] }),
      verify_backup: OK({ schemaVersion: 6, tillVersion: '0.1.0', entryCount: 193, balanceOk: true, format: 'jsonl_bundle' }),
    });
    renderPanel(client);
    await screen.findByText('Export');
    await userEvent.click(screen.getByRole('button', { name: 'Export vom 05.09.2026 prüfen' }));
    expect(await screen.findByText('Ein Export (.tillexport) ist keine Wiederherstellungsquelle. Verwende eine .tillbackup-Datei.')).toBeInTheDocument();
    expect(screen.queryByText(/^Gültig/)).not.toBeInTheDocument();
  });

  it('J7.5: the restore field says the same over a typed export path', async () => {
    const { client } = makeClient({
      list_backups: OK({ backups: [] }),
      verify_backup: OK({ schemaVersion: 6, tillVersion: '0.1.0', entryCount: 193, balanceOk: true, format: 'jsonl_bundle' }),
    });
    renderPanel(client);
    await screen.findByText(/Noch keine Sicherungen/);
    await userEvent.type(screen.getByPlaceholderText(/backups/), '/some/export.tillexport');
    await userEvent.click(screen.getByRole('button', { name: 'Prüfen' }));
    expect(await screen.findByText(/keine Wiederherstellungsquelle/)).toBeInTheDocument();
  });

  it('J8.10: the padlock names the right in words, never the capability id', async () => {
    const { client } = makeClient({ list_backups: { status: 422, body: { ok: false, error: 'permission_denied' } } });
    renderPanel(client);
    expect(await screen.findByText(/Den ganzen Arbeitsbereich exportieren und sichern/)).toBeInTheDocument();
    expect(screen.queryByText(/manage_data_export/)).not.toBeInTheDocument();
  });
});
