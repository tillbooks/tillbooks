/**
 * M00 first-run flow component test (spec §8): the three doors render; create and restore drive their
 * verbs; a restore rejection renders its remedy (not_a_till_database); the adopt door shows the
 * config command and calls NO verb. Rendered in de-CH (the I18nProvider default).
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { FirstRun } from './FirstRun';

type Handler = (input: Record<string, unknown>) => RestResponse;
const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, status = 422): RestResponse => ({ status, body: { ok: false, error } });
/** F-06: the restore act verifies first; a clean snapshot answer for the tests that drive the restore itself. */
const VERIFIED: RestResponse = ok({ schemaVersion: 6, tillVersion: '0.1.0', entryCount: 3, balanceOk: true, format: 'sqlite_snapshot' });

function setup(canned: Record<string, RestResponse | Handler>) {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const transport: Transport = async (action, input) => {
    calls.push({ action, input: input ?? {} });
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input ?? {}) : entry;
  };
  const client = new TillClient(transport);
  render(
    <MemoryRouter>
      <I18nProvider>
        <TillClientProvider client={client}>
          <WorkspaceProvider initialId={null}>
            <FirstRun />
          </WorkspaceProvider>
        </TillClientProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
  return { calls };
}

describe('FirstRun', () => {
  it('renders the three doors', async () => {
    setup({ delivery_status: ok({ mode: 'up', scheduler: { enabled: false, lastTickAt: null, nextTickAt: null } }) });
    expect(screen.getByRole('heading', { name: /Neues Hauptbuch anlegen/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Backup wiederherstellen/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Bestehende Datenbank übernehmen/ })).toBeInTheDocument();
    // Let the footer runtime line settle so its async read does not update state after the test.
    await screen.findByText(/Läuft als:/);
  });

  it('M03 (V1, S1.2): the residency lead renders above the doors, and the doors are unchanged', async () => {
    setup({ delivery_status: ok({ mode: 'up', scheduler: { enabled: false, lastTickAt: null, nextTickAt: null } }) });
    // The exact specced sentence: one file, nothing sent, FileVault named.
    const lead = screen.getByText(
      'Deine Bücher sind eine einzelne Datei auf diesem Gerät. Nichts wird gesendet. Verschlüsselung übernimmt das Betriebssystem (FileVault).',
    );
    // Above the doors: the lead precedes the first door heading in the document.
    const firstDoor = screen.getByRole('heading', { name: /Neues Hauptbuch anlegen/ });
    expect(lead.compareDocumentPosition(firstDoor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The residency lead adds no action: still exactly the three door headings.
    await screen.findByText(/Läuft als:/);
  });

  it('M03: in a cloud agent session the local-first lead is suppressed and the caveat carries residency', async () => {
    setup({
      delivery_status: ok({ mode: 'agent_session', scheduler: { enabled: false, lastTickAt: null, nextTickAt: null } }),
    });
    // The RuntimeLine caveat proves the cloud mode has resolved; the false local lead must be gone.
    expect(await screen.findByText(/Cloud-Umgebung/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Nichts wird gesendet/)).toBeNull());
    // The doors are unchanged: still exactly the three headings.
    expect(screen.getByRole('heading', { name: /Neues Hauptbuch anlegen/ })).toBeInTheDocument();
  });

  it('creates a ledger through create_workspace', async () => {
    const user = userEvent.setup();
    const { calls } = setup({ create_workspace: ok({ workspaceId: 'ws_new' }), delivery_status: ok({ mode: 'up', scheduler: { enabled: true, lastTickAt: null, nextTickAt: null } }) });
    await user.type(screen.getByLabelText(/Firmenname/), 'Acme GmbH');
    await user.click(screen.getByRole('button', { name: /Hauptbuch anlegen/ }));
    await waitFor(() => expect(calls.some((c) => c.action === 'create_workspace')).toBe(true));
    const call = calls.find((c) => c.action === 'create_workspace');
    expect(call?.input.name).toBe('Acme GmbH');
    expect(typeof call?.input.idempotencyKey).toBe('string');
  });

  it('restores a backup through restore_backup with confirmed:true', async () => {
    const user = userEvent.setup();
    const { calls } = setup({ verify_backup: VERIFIED, restore_backup: ok({ workspaceId: 'ws_r' }), delivery_status: ok({ mode: 'up', scheduler: { enabled: false, lastTickAt: null, nextTickAt: null } }) });
    await user.type(screen.getByLabelText(/Backup-Datei/), '/tmp/books.tillbackup');
    await user.click(screen.getByRole('button', { name: /Backup wiederherstellen/ }));
    await waitFor(() => expect(calls.some((c) => c.action === 'restore_backup')).toBe(true));
    const call = calls.find((c) => c.action === 'restore_backup');
    expect(call?.input.source).toBe('/tmp/books.tillbackup');
    expect(call?.input.confirmed).toBe(true);
  });

  it('renders the remedy when the restored file is not a TILL database', async () => {
    const user = userEvent.setup();
    setup({ verify_backup: VERIFIED, restore_backup: reject('not_a_till_database'), delivery_status: reject('transport_error', 500) });
    await user.type(screen.getByLabelText(/Backup-Datei/), '/tmp/nope.bin');
    await user.click(screen.getByRole('button', { name: /Backup wiederherstellen/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/keine TILL-Datenbank/);
  });

  it('S7.3: a schema-mismatched backup renders BOTH generations and the install-current-release remedy, never the raw code', async () => {
    const user = userEvent.setup();
    // F-06: the mismatch is named by the pre-flight verify_backup (the engine emits it there), so the
    // restore is never attempted on a bundle this runtime cannot take.
    const { calls } = setup({
      verify_backup: {
        status: 422,
        body: { ok: false, error: 'incompatible_schema_version', artifactSchemaVersion: 12, currentSchemaVersion: 5 },
      },
      restore_backup: ok({ workspaceId: 'ws_r' }),
      delivery_status: reject('transport_error', 500),
    });
    await user.type(screen.getByLabelText(/Backup-Datei/), '/tmp/newer.tillbackup');
    await user.click(screen.getByRole('button', { name: /Backup wiederherstellen/ }));
    const alert = await screen.findByRole('alert');
    expect(calls.some((c) => c.action === 'restore_backup')).toBe(false);
    expect(alert).toHaveTextContent(/Schema-Generation 12/);
    expect(alert).toHaveTextContent(/Generation 5/);
    expect(alert).toHaveTextContent(/aktuelle Release/);
    expect(alert).not.toHaveTextContent(/incompatible_schema_version/);
  });

  it('supplies the localised default workspace name when the optional name field is left empty', async () => {
    // The engine REQUIRES newWorkspaceName; "(optional)" stays honest because an empty field
    // restores under the default name instead of surfacing a raw invalid_input.
    const user = userEvent.setup();
    const { calls } = setup({ verify_backup: VERIFIED, restore_backup: ok({ workspaceId: 'ws_r' }), delivery_status: ok({ mode: 'up', scheduler: { enabled: false, lastTickAt: null, nextTickAt: null } }) });
    await user.type(screen.getByLabelText(/Backup-Datei/), '/tmp/books.tillbackup');
    await user.click(screen.getByRole('button', { name: /Backup wiederherstellen/ }));
    await waitFor(() => expect(calls.some((c) => c.action === 'restore_backup')).toBe(true));
    const call = calls.find((c) => c.action === 'restore_backup');
    expect(call?.input.newWorkspaceName).toBe('Wiederhergestelltes Hauptbuch');
  });

  it('K-14: with zero workspaces the no-ledger lead and the bare create door render', async () => {
    setup({
      list_workspaces: ok({ workspaces: [] }),
      delivery_status: ok({ mode: 'up', scheduler: { enabled: false, lastTickAt: null, nextTickAt: null } }),
    });
    await screen.findByText(/Läuft als:/); // let the async reads settle
    expect(screen.getByText(/TILL hat auf diesem Gerät kein Hauptbuch gefunden/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Neues Hauptbuch anlegen$/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Zur Übersicht/ })).not.toBeInTheDocument();
  });

  it('F-05: with zero workspaces the demo door is offered under the doors and mints the demo', async () => {
    const user = userEvent.setup();
    const { calls } = setup({
      list_workspaces: ok({ workspaces: [] }),
      create_demo_workspace: ok({ workspaceId: 'ws_demo' }),
      delivery_status: ok({ mode: 'up', scheduler: { enabled: false, lastTickAt: null, nextTickAt: null } }),
    });
    await screen.findByText(/Läuft als:/);
    expect(screen.getByText(/Lieber erst mit Beispieldaten anschauen/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Demo ausprobieren' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'create_demo_workspace')).toBe(true));
    expect(typeof calls.find((c) => c.action === 'create_demo_workspace')?.input.idempotencyKey).toBe('string');
    expect(window.localStorage.getItem('till-workspace')).toBe('ws_demo');
  });

  it('F-05: with a workspace already on the device the demo line is not offered', async () => {
    setup({
      list_workspaces: ok({
        workspaces: [
          { workspaceId: 'ws_1', name: 'Acme GmbH', legalForm: null, baseCurrency: 'CHF', fiscalYearStart: '01-01', createdAt: '2026-01-01' },
        ],
      }),
      delivery_status: ok({ mode: 'up', scheduler: { enabled: false, lastTickAt: null, nextTickAt: null } }),
    });
    await screen.findByText(/bereits ein Hauptbuch/);
    expect(screen.queryByRole('button', { name: 'Demo ausprobieren' })).not.toBeInTheDocument();
    await screen.findByText(/Läuft als:/);
  });

  it('K-14: with one workspace the no-ledger claim is gone and the honest variant renders', async () => {
    setup({
      list_workspaces: ok({
        workspaces: [
          { workspaceId: 'ws_1', name: 'Acme GmbH', legalForm: null, baseCurrency: 'CHF', fiscalYearStart: '01-01', createdAt: '2026-01-01' },
        ],
      }),
      delivery_status: ok({ mode: 'up', scheduler: { enabled: false, lastTickAt: null, nextTickAt: null } }),
    });
    // The honest lead replaces the no-ledger sentence once the list read lands.
    expect(await screen.findByText(/bereits ein Hauptbuch/)).toBeInTheDocument();
    expect(screen.queryByText(/kein Hauptbuch gefunden/)).not.toBeInTheDocument();
    // The create door is reframed as ANOTHER ledger, and the way back to the books is a primary link.
    expect(screen.getByRole('heading', { name: /Ein weiteres Hauptbuch anlegen/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Zur Übersicht/ })).toBeInTheDocument();
    await screen.findByText(/Läuft als:/); // let the footer runtime line settle
  });

  it('the adopt door shows the config command and calls no verb', async () => {
    const user = userEvent.setup();
    const { calls } = setup({ delivery_status: ok({ mode: 'up', scheduler: { enabled: false, lastTickAt: null, nextTickAt: null } }) });
    await screen.findByText(/Läuft als:/); // let the footer runtime line settle
    await user.type(screen.getByLabelText(/Datenbankpfad/), '/data/till.db');
    expect(screen.getByText(/TILL_DB_PATH=\/data\/till.db till up/)).toBeInTheDocument();
    expect(calls.some((c) => c.action === 'create_workspace' || c.action === 'restore_backup')).toBe(false);
  });
});

/**
 * F-06 (J7.2): the restore door lists the bundles this machine can see, names the generation it
 * expects before the act, verifies the pick first, and keeps the typed path as the fallback.
 */
describe('FirstRun, the restore door lists what it can restore (F-06, J7.2)', () => {
  const LISTED = ok({
    directory: '/support/backups',
    currentSchemaVersion: 6,
    backups: [
      { source: '/support/backups/a.tillbackup', createdAt: '2026-09-05T10:00:00.000Z', schemaVersion: 6, tillVersion: '0.1.0', entryCount: 193, workspaceId: 'ws_1', compatible: true },
      { source: '/support/backups/old.tillbackup', createdAt: '2026-01-05T10:00:00.000Z', schemaVersion: 5, tillVersion: '0.0.9', entryCount: 12, workspaceId: 'ws_1', compatible: false },
    ],
  });
  const RUNTIME = ok({ mode: 'up', scheduler: { enabled: false, lastTickAt: null, nextTickAt: null } });

  it('names the expected generation and each bundle with its date, generation and entry count; an incompatible one is named, not hidden', async () => {
    setup({ list_restorable_backups: LISTED, delivery_status: RUNTIME });
    expect(await screen.findByText('Diese Installation erwartet Schema-Generation 6.')).toBeInTheDocument();
    const good = screen.getByRole('radio', { name: /05\.09\.2026: Generation 6, 193 Buchungen/ });
    expect(good).toBeEnabled();
    const old = screen.getByRole('radio', { name: /05\.01\.2026: Generation 5, 12 Buchungen/ });
    expect(old).toBeDisabled();
    expect(screen.getByText(/Generation 5 passt nicht zu dieser Installation/)).toBeInTheDocument();
    // The typed path is behind "Anderer Pfad" while the list has entries.
    expect(screen.queryByLabelText(/Backup-Datei/)).not.toBeInTheDocument();
    await screen.findByText(/Läuft als:/);
  });

  it('picking a bundle verifies it first, names what it found, then restores that source', async () => {
    const user = userEvent.setup();
    const { calls } = setup({
      list_restorable_backups: LISTED,
      verify_backup: VERIFIED,
      restore_backup: ok({ workspaceId: 'ws_r' }),
      delivery_status: RUNTIME,
    });
    await user.click(await screen.findByRole('radio', { name: /Generation 6, 193 Buchungen/ }));
    await user.click(screen.getByRole('button', { name: /Backup wiederherstellen/ }));
    await waitFor(() => expect(calls.some((c) => c.action === 'restore_backup')).toBe(true));
    const verify = calls.find((c) => c.action === 'verify_backup');
    const restore = calls.find((c) => c.action === 'restore_backup');
    expect(verify?.input.source).toBe('/support/backups/a.tillbackup');
    expect(restore?.input.source).toBe('/support/backups/a.tillbackup');
    expect(calls.findIndex((c) => c.action === 'verify_backup')).toBeLessThan(calls.findIndex((c) => c.action === 'restore_backup'));
  });

  it('"Anderer Pfad" brings the typed field back as the fallback', async () => {
    const user = userEvent.setup();
    const { calls } = setup({ list_restorable_backups: LISTED, verify_backup: VERIFIED, restore_backup: ok({ workspaceId: 'ws_r' }), delivery_status: RUNTIME });
    await user.click(await screen.findByRole('radio', { name: 'Anderer Pfad' }));
    await user.type(screen.getByLabelText(/Backup-Datei/), '/elsewhere/books.tillbackup');
    await user.click(screen.getByRole('button', { name: /Backup wiederherstellen/ }));
    await waitFor(() => expect(calls.find((c) => c.action === 'restore_backup')?.input.source).toBe('/elsewhere/books.tillbackup'));
  });

  it('an export picked by path is refused before the act with the honesty sentence', async () => {
    const user = userEvent.setup();
    const { calls } = setup({
      verify_backup: ok({ schemaVersion: 6, tillVersion: '0.1.0', entryCount: 193, balanceOk: true, format: 'jsonl_bundle' }),
      restore_backup: ok({ workspaceId: 'ws_r' }),
      delivery_status: RUNTIME,
    });
    await user.type(screen.getByLabelText(/Backup-Datei/), '/tmp/export.tillexport');
    await user.click(screen.getByRole('button', { name: /Backup wiederherstellen/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/keine Wiederherstellungsquelle/);
    expect(calls.some((c) => c.action === 'restore_backup')).toBe(false);
  });

  /**
   * Critic F4 (2026-09-05): `verifyBackup` answers `ok` with `balanceOk: false` on an unbalanced
   * snapshot, and the door used to say "ausgeglichen. Wird wiederhergestellt." for any ok verify of a
   * snapshot. The claim is only made once the engine has made it; an unbalanced bundle stops before
   * the act with the honest sentence and `restore_backup` is never called.
   */
  it('an unbalanced snapshot is refused before the act, and the door never claims "ausgeglichen"', async () => {
    const user = userEvent.setup();
    const { calls } = setup({
      list_restorable_backups: LISTED,
      verify_backup: ok({ schemaVersion: 6, tillVersion: '0.1.0', entryCount: 193, balanceOk: false, format: 'sqlite_snapshot' }),
      restore_backup: ok({ workspaceId: 'ws_r' }),
      delivery_status: RUNTIME,
    });
    await user.click(await screen.findByRole('radio', { name: /Generation 6, 193 Buchungen/ }));
    await user.click(screen.getByRole('button', { name: /Backup wiederherstellen/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Geprüft, aber nicht ausgeglichen: Generation 6, 193 Buchungen.');
    expect(screen.queryByText(/ausgeglichen\. Wird wiederhergestellt/)).not.toBeInTheDocument();
    expect(calls.some((c) => c.action === 'verify_backup')).toBe(true);
    expect(calls.some((c) => c.action === 'restore_backup')).toBe(false);
  });
});
